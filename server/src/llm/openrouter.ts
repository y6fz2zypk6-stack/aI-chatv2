import type { ModelInfo } from '../../../shared/types.js';

// 既定はOpenRouter。OPENROUTER_BASE_URL で差し替えられる（テスト用のモックを挟むため）
const BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY が設定されていません');
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.APP_URL || 'http://localhost',
    'X-Title': process.env.APP_TITLE || 'Character Chat',
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---- モデル情報（context_length のキャッシュ、§6.5） ----

let modelCache: { at: number; models: ModelInfo[] } | null = null;
const MODEL_CACHE_TTL = 1000 * 60 * 60;

export async function listModels(): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_TTL) return modelCache.models;
  const res = await fetch(`${BASE}/models`, { headers: headers() });
  if (!res.ok) throw new Error(`OpenRouter /models failed: ${res.status}`);
  const json = (await res.json()) as { data: { id: string; name?: string; context_length?: number }[] };
  const models = json.data.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    context_length: m.context_length || 0,
  }));
  modelCache = { at: Date.now(), models };
  return models;
}

export async function contextLengthOf(modelId: string, fallback: number): Promise<number> {
  try {
    const models = await listModels();
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
  try {
    let res: Response;
    arm(CONNECT_TIMEOUT_MS, 'connect_timeout');
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        signal: ctl.signal,
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
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
      throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 300)}`);
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
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 300)}`);
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
