import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Diary } from '../../../../shared/types.js';

export function listDiaries(chatId: string): Diary[] {
  return db
    .prepare('SELECT * FROM diaries WHERE chat_id = ? ORDER BY day DESC, character_id')
    .all(chatId) as Diary[];
}

export function getDiary(id: string): Diary | undefined {
  return db.prepare('SELECT * FROM diaries WHERE id = ?').get(id) as Diary | undefined;
}

/** 同じキャラ・同じ日は上書き（書き直し）。id と created_at は最初のものを保つ */
export function upsertDiary(input: {
  chat_id: string;
  character_id: string;
  day: number;
  date_label: string;
  content: string;
  model: string;
}): Diary {
  const t = now();
  db.prepare(
    `INSERT INTO diaries (id, chat_id, character_id, day, date_label, content, model, created_at, updated_at)
     VALUES (@id, @chat_id, @character_id, @day, @date_label, @content, @model, @t, @t)
     ON CONFLICT(chat_id, character_id, day) DO UPDATE SET
       date_label = excluded.date_label, content = excluded.content,
       model = excluded.model, updated_at = excluded.updated_at`,
  ).run({ ...input, id: ulid(), t });
  return db
    .prepare('SELECT * FROM diaries WHERE chat_id = ? AND character_id = ? AND day = ?')
    .get(input.chat_id, input.character_id, input.day) as Diary;
}

export function updateDiaryContent(id: string, content: string): Diary | undefined {
  db.prepare('UPDATE diaries SET content = ?, updated_at = ? WHERE id = ?').run(content, now(), id);
  return getDiary(id);
}

export function deleteDiary(id: string): void {
  db.prepare('DELETE FROM diaries WHERE id = ?').run(id);
}
