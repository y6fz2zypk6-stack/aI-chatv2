import type { ChatState, GameTime, Notice, Utterance } from '@shared/types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...init,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* noop */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ---- SSE生成（§5.3）----

export interface DonePayload {
  messageId: string;
  content: string;
  utterances: Utterance[];
  state: ChatState;
  gameTime: GameTime;
  needsSummary: boolean;
  firedEvents: string[];
  warnings: string[];
  fenceMissingStreak: number;
  autoJoinSuggested: string[];
  generationStatus: 'complete' | 'stopped';
  /** オートプレイの継続判定で区切りと判断された（§8.7） */
  autoplayShouldStop: boolean;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: (payload: DonePayload) => void;
  onError: (message: string, status?: number) => void;
  /**
   * 裏で走った要約・抽出の結果。done のあとに届く。
   * 生成そのものは done で終わっているので、これを待たせてはいけない。
   */
  onNotice?: (notice: Notice) => void;
}

export async function streamGenerate(
  chatId: string,
  body: Record<string, unknown>,
  handlers: StreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch (err) {
    handlers.onError((err as Error).message);
    return;
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* noop */
    }
    handlers.onError(message, res.status);
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const handleBlock = (block: string) => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    try {
      const payload = JSON.parse(data);
      if (event === 'delta') handlers.onDelta(payload.text as string);
      else if (event === 'done') handlers.onDone(payload as DonePayload);
      else if (event === 'error') handlers.onError(payload.message as string);
      else if (event === 'notice') handlers.onNotice?.(payload as Notice);
    } catch {
      /* 不完全なブロックは無視 */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        handleBlock(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
  } catch (err) {
    handlers.onError((err as Error).message);
  }
}
