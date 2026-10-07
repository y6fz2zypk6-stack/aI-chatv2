import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { DirectorNote } from '../../../../shared/types.js';

/** 最新1件のみ使用。履歴は残す（要約と同じ扱い） */
export function latestDirectorNote(chatId: string): DirectorNote | undefined {
  return db
    .prepare('SELECT * FROM director_notes WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(chatId) as DirectorNote | undefined;
}

export function insertDirectorNote(
  input: Omit<DirectorNote, 'id' | 'created_at'> & { created_at?: number },
): DirectorNote {
  const n: DirectorNote = { id: ulid(), created_at: input.created_at ?? now(), ...input } as DirectorNote;
  db.prepare(
    `INSERT INTO director_notes (id, chat_id, up_to_seq, ledger, cue, model, created_at)
     VALUES (@id, @chat_id, @up_to_seq, @ledger, @cue, @model, @created_at)`,
  ).run(n);
  return n;
}

export function deleteDirectorNotes(chatId: string): void {
  db.prepare('DELETE FROM director_notes WHERE chat_id = ?').run(chatId);
}

/**
 * 分岐（fork）で引き継ぐ。**分岐点より後を読んで書いた台本は持ち込まない。**
 * 分岐先ではその先の出来事が起きていないので、未来を前提にした指示になる。
 * 分岐先の seq は1から振り直される（削除で欠番があると元と一致しない）ので、
 * 境界は `mapSeq` で分岐先の番号に読み替える
 */
export function copyDirectorNotesForFork(
  fromChatId: string,
  toChatId: string,
  maxSeq: number,
  mapSeq: (oldSeq: number) => number,
): void {
  const rows = db
    .prepare('SELECT * FROM director_notes WHERE chat_id = ? AND up_to_seq <= ? ORDER BY created_at ASC, id ASC')
    .all(fromChatId, maxSeq) as DirectorNote[];
  for (const r of rows) {
    insertDirectorNote({
      chat_id: toChatId,
      up_to_seq: mapSeq(r.up_to_seq),
      ledger: r.ledger,
      cue: r.cue,
      model: r.model,
      created_at: r.created_at,
    });
  }
}
