import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Summary } from '../../../../shared/types.js';

/** 最新1件のみ使用。履歴は残す（§4.14） */
export function latestSummary(chatId: string): Summary | undefined {
  return db
    .prepare('SELECT * FROM summaries WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(chatId) as Summary | undefined;
}

export function insertSummary(chatId: string, upToMessageId: string, content: string): Summary {
  const s: Summary = {
    id: ulid(),
    chat_id: chatId,
    up_to_message_id: upToMessageId,
    content,
    created_at: now(),
  };
  db.prepare(
    'INSERT INTO summaries (id, chat_id, up_to_message_id, content, created_at) VALUES (@id, @chat_id, @up_to_message_id, @content, @created_at)',
  ).run(s);
  return s;
}

export function updateSummaryContent(id: string, content: string): void {
  db.prepare('UPDATE summaries SET content = ? WHERE id = ?').run(content, id);
}

export function deleteSummaries(chatId: string): void {
  db.prepare('DELETE FROM summaries WHERE chat_id = ?').run(chatId);
}
