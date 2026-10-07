import type { ModelInfo } from '../../../shared/types.js';
import { headersOf, resolveConnection, resolveModelRef, type ResolvedConnection } from './provider.js';

/**
 * 上流の呼び出し。**接続先（§6.6）ごとにURLとキーを引き直す。**
 *
 * 引数のモデルは `<接続先ID>::<モデルID>` の参照。`::` が無ければ組み込み
 * （`.env` の OpenRouter）なので、呼び出し側は今までどおりモデル文字列を渡すだけでよい。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * プロンプトキャッシュの区切り。**このメッセージまでを前置きとしてキャッシュする。**
   * 組み立て側は「どこで切るか」だけを決め、送信形式（cache_control・TTL）はここで決める。
   * 対応しない接続先・モデルでは黙って外す（§6.7）
   */
  cache?: boolean;
}

// ---- プロンプトキャッシュ（§6.7） ----

type CacheTtl = '5m' | '1h';

/**
 * `PROMPT_CACHE_TTL`: `1h`（既定）/ `5m` / `off`。
 * 1シーンを読んで考えている間に5分は過ぎやすいので既定は1時間。
 * 書き込みは割高（5分=1.25倍・1時間=2倍）だが、読み出しは0.1倍なので続けて遊ぶほど得になる
 */
function cacheTtl(): CacheTtl | null {
  const v = (process.env.PROMPT_CACHE_TTL || '1h').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return null;
  return v === '5m' ? '5m' : '1h';
}

/**
 * 明示的な区切りが必要なのは Anthropic のモデルで、OpenRouter 経由なら
 * content パーツの `cache_control` がそのまま渡る。
 * それ以外の接続先（OpenAI互換の自前サービスなど）には未知のフィールドを送らない
 */
export function supportsPromptCache(conn: ResolvedConnection, modelId: string): boolean {
  const viaOpenRouter = conn.builtin || /openrouter\.ai/i.test(conn.baseUrl);
  return viaOpenRouter && /^~?anthropic\//i.test(modelId);
}

/** 上流へ送る形に直す。`cache` 印はここで `cache_control` に変換するか、捨てる */
export function toWireMessages(
  messages: ChatMessage[],
  conn: ResolvedConnection,
  modelId: string,
): unknown[] {
  const ttl = supportsPromptCache(conn, modelId) ? cacheTtl() : null;
  return messages.map(({ role, content, cache }) => {
    if (!cache || !ttl || !content) return { role, content };
    return {
      role,
      content: [
        {
          type: 'text',
          text: content,
          cache_control: ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' },
        },
      ],
    };
  });
}

// ---- モデル情報（context_length のキャッシュ、§6.5） ----

/** **接続先ごとに分ける。** 1本だと別のサービスの一覧を取り違える */
const modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
const MODEL_CACHE_TTL = 1000 * 60 * 60;

export async function listModels(connectionId = ''): Promise<ModelInfo[]> {
  const conn = resolveConnection(connectionId);
  const hit = modelCache.get(conn.id);
  if (hit && Date.now() - hit.at < MODEL_CACHE_TTL) return hit.models;
  const res = await fetch(`${conn.baseUrl}/models`, { headers: headersOf(conn) });
  if (!res.ok) throw new Error(`${conn.name} の /models に失敗しました: ${res.status}`);
  const json = (await res.json()) as { data: { id: string; name?: string; context_length?: number }[] };
  const models = (json.data ?? []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    context_length: m.context_length || 0,
  }));
  modelCache.set(conn.id, { at: Date.now(), models });
  return models;
}

/** 接続先を消したり付け替えたりしたときに、古い一覧を掴み続けないようにする */
export function clearModelCache(connectionId?: string): void {
  if (connectionId === undefined) modelCache.clear();
  else modelCache.delete(connectionId);
}

/**
 * 予算計算に使うコンテキスト長（§6.5）。
 *
 * **接続先の設定を最優先する。** `/models` を返さないサービス（ローカルのLM Studio など）では
 * 一覧から引けず、黙って `fallback`（既定32768）に落ちる。8kのモデルを繋いでいると
 * 過積載になるので、接続先側で長さを指定できるようにしてある。
 */
export async function contextLengthOf(ref: string, fallback: number): Promise<number> {
  let conn: ResolvedConnection;
  let modelId: string;
  try {
    ({ conn, modelId } = resolveModelRef(ref));
  } catch {
    // 接続先が見つからない場合でも予算計算は続ける（生成そのものは別途エラーになる）
    return fallback;
  }
  if (conn.contextLength > 0) return conn.contextLength;
  try {
    const models = await listModels(conn.id);
    const m = models.find((x) => x.id === modelId);
    return m?.context_length || fallback;
  } catch {
    return fallback;
  }
}

// ---- ストリーミング呼び出し ----

export interface StreamOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  stop?: string[];
  signal?: AbortSignal;
  onDelta: (text: string) => void;
}

/**
 * ストリームがどう終わったか。
 * **停止操作・上流の無応答・通信の失敗を混ぜないための区別。** 混ざると、利用者が自分で
 * 押した停止が「通信・API失敗」として表示されたり、上流が黙っただけなのに
 * 「停止しました」と表示されたりする（§5.7）。
 */
export type StreamOutcome = 'complete' | 'user_abort' | 'connect_timeout' | 'idle_timeout';

export interface StreamResult {
  text: string;
  outcome: StreamOutcome;
}

/**
 * ストリームの待ち時間の上限（§5.7）。
 *
 * **上限が無いと、上流が接続を保ったまま黙った場合に `reader.read()` で永久に止まる。**
 * 生成ロックは `finally` で外す作りなので、そこへ到達できないとそのチャットは
 * 以後ずっと409になり、プロセスを再起動するしか戻せない。
 *
 * 2つに分ける理由: 接続確立はモデルのキュー待ちで長くなることがあり、
 * ストリーム開始後の沈黙とは意味が違う。環境変数で調整できるようにしてある。
 */
const CONNECT_TIMEOUT_MS = Number(process.env.STREAM_CONNECT_TIMEOUT_MS) || 60_000;
const IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS) || 60_000;

/** 画面に出す説明で使う（秒） */
export const streamTimeoutSeconds = {
  connect: Math.round(CONNECT_TIMEOUT_MS / 1000),
  idle: Math.round(IDLE_TIMEOUT_MS / 1000),
};

/**
 * 利用者の停止操作によるものか。
 * abort のタイミングによって投げ手が変わる（fetch 本体・リーダー・undici の内部）ので、
 * 例外の名前だけでなく signal の状態も見る。
 */
function isUserAbort(err: unknown, signal?: AbortSignal): boolean {
  const e = err as { name?: string; cause?: { name?: string } } | null;
  if (e?.name === 'AbortError' || e?.cause?.name === 'AbortError') return true;
  // ここまで来た例外は、停止済みなら停止が原因とみなす（/stop 以外では abort しない）
  return signal?.aborted === true;
}

/** SSEストリーミングで生成し、全文を返す。停止・タイムアウト時はそれまでの分を返す */
export async function streamChat(opts: StreamOptions): Promise<StreamResult> {
  // 停止（外側のsignal）とタイムアウト（内側のタイマー）の両方でabortできるようにする。
  // 内側で abort したときは timedOut に理由が入るので、停止と区別できる
  const ctl = new AbortController();
  let timedOut: 'connect_timeout' | 'idle_timeout' | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (ms: number, why: 'connect_timeout' | 'idle_timeout'): void => {
    clearTimer();
    if (ms <= 0) return;
    timer = setTimeout(() => {
      timedOut = why;
      ctl.abort();
    }, ms);
  };
  const relay = (): void => ctl.abort();
  opts.signal?.addEventListener('abort', relay, { once: true });
  if (opts.signal?.aborted) ctl.abort();

  /** 例外の原因を判定する。**timedOut を先に見ること**（内側のabortもAbortErrorになる） */
  const outcomeOf = (err: unknown): StreamOutcome | null => {
    if (timedOut) return timedOut;
    if (isUserAbort(err, opts.signal)) return 'user_abort';
    return null;
  };

  let full = '';
  // 接続先の解決は try の外で行う。キー未設定などはそのまま呼び出し側へ投げる
  const { conn, modelId } = resolveModelRef(opts.model);
  try {
    let res: Response;
    arm(CONNECT_TIMEOUT_MS, 'connect_timeout');
    try {
      res = await fetch(`${conn.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headersOf(conn),
        signal: ctl.signal,
        body: JSON.stringify({
          model: modelId,
          messages: toWireMessages(opts.messages, conn, modelId),
          max_tokens: opts.maxTokens,
          stop: opts.stop,
          stream: true,
        }),
      });
    } catch (err) {
      // **レスポンスヘッダが返る前に止まると fetch 自体が投げる。**
      // 読み取りループだけを try で囲んでいると、この窓の停止が通常のエラー経路に落ち、
      // 「This operation was aborted」がそのまま画面に出る
      const outcome = outcomeOf(err);
      if (outcome) return { text: '', outcome };
      throw err;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`${conn.name} からエラー ${res.status}: ${text.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // ここから先は「最後にデータが届いてからの沈黙」を計る
    arm(IDLE_TIMEOUT_MS, 'idle_timeout');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(IDLE_TIMEOUT_MS, 'idle_timeout'); // 届いたので待ち直す
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
            };
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              opts.onDelta(delta);
            }
          } catch {
            // 不完全なJSON断片は無視
          }
        }
      }
    } catch (err) {
      const outcome = outcomeOf(err);
      if (outcome) return { text: full, outcome };
      throw err;
    }
    return { text: full, outcome: 'complete' };
  } finally {
    clearTimer();
    opts.signal?.removeEventListener('abort', relay);
  }
}

/** 要約・抽出など、非ストリーミングの1回コール */
export interface CompleteResult {
  text: string;
  /** 'stop' / 'length' / 'content_filter' など。空応答の原因の切り分けに使う */
  finishReason: string;
  /** モデルが明示的に拒否した場合の理由 */
  refusal: string;
}

/**
 * 非ストリーミングの1回呼び出し。
 * **空文字だけを返して終わらせない。** 本文が空になる原因（上限到達・拒否・
 * JSONモード非対応）を呼び出し側が説明できるよう、finish_reason も返す。
 */
export async function complete(opts: {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  json?: boolean;
}): Promise<CompleteResult> {
  const { conn, modelId } = resolveModelRef(opts.model);
  const res = await fetch(`${conn.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headersOf(conn),
    body: JSON.stringify({
      model: modelId,
      messages: toWireMessages(opts.messages, conn, modelId),
      max_tokens: opts.maxTokens,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${conn.name} からエラー ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string; refusal?: string }; finish_reason?: string }[];
  };
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? '',
    refusal: choice?.message?.refusal ?? '',
  };
}

export async function completeText(opts: {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  json?: boolean;
}): Promise<string> {
  return (await complete(opts)).text;
}
