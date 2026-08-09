import { db, now, fromJson, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type {
  ChatState,
  GenerationStatus,
  Message,
  MessageVariant,
  Utterance,
} from '../../../../shared/types.js';
import { EMPTY_STATE } from './scenarios.js';

interface Row extends Omit<Message, 'utterances' | 'state_after'> {
  utterances: string;
  state_after: string;
}

interface VariantRow extends Omit<MessageVariant, 'utterances' | 'state_after'> {
  utterances: string;
  state_after: string;
}

function toApi(row: Row): Message {
  return {
    ...row,
    utterances: fromJson<Utterance[]>(row.utterances, []),
    state_after: { ...EMPTY_STATE, ...fromJson<Partial<ChatState>>(row.state_after, {}) },
  };
}

function variantToApi(row: VariantRow): MessageVariant {
  return {
    ...row,
    utterances: fromJson<Utterance[]>(row.utterances, []),
    state_after: { ...EMPTY_STATE, ...fromJson<Partial<ChatState>>(row.state_after, {}) },
  };
}

/** 会話の順序は seq（チャット内連番）が正。id の時系列性には依存しない */
export function listMessages(chatId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM message_variants v WHERE v.message_id = m.id) AS variant_count
       FROM messages m WHERE m.chat_id = ? ORDER BY m.seq ASC`,
    )
    .all(chatId) as (Row & { variant_count: number })[];
  return rows.map((r) => ({ ...toApi(r), variant_count: r.variant_count }));
}

export function getMessage(id: string): Message | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

/** fork用: 指定 seq まで（含む）を昇順で返す */
export function listMessagesUpToSeq(chatId: string, seq: number): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND seq <= ? ORDER BY seq ASC')
    .all(chatId, seq) as Row[];
  return rows.map(toApi);
}

/** 指定メッセージの直前のメッセージ */
export function previousMessage(chatId: string, beforeSeq: number): Message | undefined {
  const row = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1')
    .get(chatId, beforeSeq) as Row | undefined;
  return row ? toApi(row) : undefined;
}

export function lastMessage(chatId: string): Message | undefined {
  const row = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1')
    .get(chatId) as Row | undefined;
  return row ? toApi(row) : undefined;
}

/** 履歴窓（§6.2）: 要約済み以降を新しい方から limit 件、昇順で返す */
export function historyWindow(chatId: string, afterSeq: number, limit: number): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?')
    .all(chatId, afterSeq, limit) as Row[];
  return rows.reverse().map(toApi);
}

/** 未要約メッセージ（要約対象の全件、昇順） */
export function messagesAfterSeq(chatId: string, afterSeq: number): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq ASC')
    .all(chatId, afterSeq) as Row[];
  return rows.map(toApi);
}

export function countMessages(chatId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = ?').get(chatId) as { c: number }).c;
}

/**
 * 追加。seq は「そのチャットの最大 seq + 1」を単一のINSERT文の中で決めるため、
 * 同時に呼ばれても採番が衝突しない（UNIQUE(chat_id, seq) でDB側も保証）。
 */
export function insertMessage(input: {
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  utterances: Utterance[];
  state_after: ChatState;
  generation_status?: GenerationStatus | null;
  kind?: Message['kind'];
}): Message {
  const id = ulid();
  const createdAt = now();
  db.prepare(
    `INSERT INTO messages (id, chat_id, seq, role, content, utterances, state_after, active_variant, generation_status, kind, created_at)
     SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, 0, ?, ?, ?
     FROM messages WHERE chat_id = ?`,
  ).run(
    id,
    input.chat_id,
    input.role,
    input.content,
    toJson(input.utterances),
    toJson(input.state_after),
    input.generation_status ?? null,
    input.kind ?? 'normal',
    createdAt,
    input.chat_id,
  );
  return getMessage(id)!;
}

/** 表示中候補のコピー（content / utterances / state_after）とステータスを更新 */
export function updateMessageActive(
  id: string,
  patch: {
    content?: string;
    utterances?: Utterance[];
    state_after?: ChatState;
    active_variant?: number;
    generation_status?: GenerationStatus | null;
  },
): void {
  const cur = getMessage(id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  db.prepare(
    `UPDATE messages SET content=?, utterances=?, state_after=?, active_variant=?, generation_status=? WHERE id=?`,
  ).run(
    next.content, toJson(next.utterances), toJson(next.state_after),
    next.active_variant, next.generation_status, id,
  );
}

export function deleteMessage(id: string): void {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}

// ---- variants ----

export function listVariants(messageId: string): MessageVariant[] {
  const rows = db
    .prepare('SELECT * FROM message_variants WHERE message_id = ? ORDER BY "index" ASC')
    .all(messageId) as VariantRow[];
  return rows.map(variantToApi);
}

/**
 * 候補を追加する。index は「そのメッセージの最大 index + 1」を単一のINSERT文で決める。
 * UNIQUE(message_id, index) と併せて番号の重複を防ぐ。
 */
export function insertVariant(input: {
  message_id: string;
  content: string;
  utterances: Utterance[];
  state_delta: string;
  state_after: ChatState;
}): MessageVariant {
  const id = ulid();
  db.prepare(
    `INSERT INTO message_variants (id, message_id, "index", content, utterances, state_delta, state_after, created_at)
     SELECT ?, ?, COALESCE(MAX("index") + 1, 0), ?, ?, ?, ?, ?
     FROM message_variants WHERE message_id = ?`,
  ).run(
    id,
    input.message_id,
    input.content,
    toJson(input.utterances),
    input.state_delta,
    toJson(input.state_after),
    now(),
    input.message_id,
  );
  const row = db.prepare('SELECT * FROM message_variants WHERE id = ?').get(id) as VariantRow;
  return variantToApi(row);
}

/** fork時など、index を明示して複製する場合に使う */
export function insertVariantAt(input: {
  message_id: string;
  index: number;
  content: string;
  utterances: Utterance[];
  state_delta: string;
  state_after: ChatState;
}): MessageVariant {
  const v: MessageVariant = {
    id: ulid(),
    message_id: input.message_id,
    index: input.index,
    content: input.content,
    utterances: input.utterances,
    state_delta: input.state_delta,
    state_after: input.state_after,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO message_variants (id, message_id, "index", content, utterances, state_delta, state_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    v.id, v.message_id, v.index, v.content, toJson(v.utterances), v.state_delta,
    toJson(v.state_after), v.created_at,
  );
  return v;
}
