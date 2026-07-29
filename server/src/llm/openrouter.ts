import type { ModelInfo } from '../../../shared/types.js';

const BASE = 'https://openrouter.ai/api/v1';

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

/** SSEストリーミングで生成し、全文を返す。abort時はそれまでの分を返す */
export async function streamChat(opts: StreamOptions): Promise<{ text: string; aborted: boolean }> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      stop: opts.stop,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter error ${res.status}: ${text.slice(0, 300)}`);
  }

  let full = '';
  let aborted = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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
    if ((err as Error).name === 'AbortError') aborted = true;
    else throw err;
  }
  return { text: full, aborted };
}

/** 要約・抽出など、非ストリーミングの1回コール */
export async function completeText(opts: {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  json?: boolean;
}): Promise<string> {
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
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? '';
}
