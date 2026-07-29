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

export function listMessages(chatId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM message_variants v WHERE v.message_id = m.id) AS variant_count
       FROM messages m WHERE m.chat_id = ? ORDER BY m.id ASC`,
    )
    .all(chatId) as (Row & { variant_count: number })[];
  return rows.map((r) => ({ ...toApi(r), variant_count: r.variant_count }));
}

export function getMessage(id: string): Message | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

/** 指定メッセージの直前のメッセージ */
export function previousMessage(chatId: string, beforeId: string): Message | undefined {
  const row = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
    .get(chatId, beforeId) as Row | undefined;
  return row ? toApi(row) : undefined;
}

export function lastMessage(chatId: string): Message | undefined {
  const row = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1')
    .get(chatId) as Row | undefined;
  return row ? toApi(row) : undefined;
}

/** 履歴窓（§6.2）: 要約済み以降を新しい方から limit 件、昇順で返す */
export function historyWindow(chatId: string, afterMessageId: string | null, limit: number): Message[] {
  const rows = (
    afterMessageId
      ? db
          .prepare(
            'SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT ?',
          )
          .all(chatId, afterMessageId, limit)
      : db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit)
  ) as Row[];
  return rows.reverse().map(toApi);
}

/** 未要約メッセージ（要約対象の全件、昇順） */
export function unsummarizedMessages(chatId: string, afterMessageId: string | null): Message[] {
  const rows = (
    afterMessageId
      ? db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC').all(chatId, afterMessageId)
      : db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC').all(chatId)
  ) as Row[];
  return rows.map(toApi);
}

export function countMessages(chatId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = ?').get(chatId) as { c: number }).c;
}

export function insertMessage(input: {
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  utterances: Utterance[];
  state_after: ChatState;
  generation_status?: GenerationStatus | null;
}): Message {
  const m: Message = {
    id: ulid(),
    chat_id: input.chat_id,
    role: input.role,
    content: input.content,
    utterances: input.utterances,
    state_after: input.state_after,
    active_variant: 0,
    generation_status: input.generation_status ?? null,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, utterances, state_after, active_variant, generation_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id, m.chat_id, m.role, m.content, toJson(m.utterances), toJson(m.state_after),
    m.active_variant, m.generation_status, m.created_at,
  );
  return m;
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

export function insertVariant(input: {
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

export function nextVariantIndex(messageId: string): number {
  const row = db
    .prepare('SELECT MAX("index") mx FROM message_variants WHERE message_id = ?')
    .get(messageId) as { mx: number | null };
  return (row.mx ?? -1) + 1;
}
