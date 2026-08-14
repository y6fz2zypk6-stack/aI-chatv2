import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { SnapshotMeta } from '../../../../shared/types.js';

/**
 * 場面のスナップショット（§21）。
 *
 * **他のリポジトリと違って `SELECT *` を使わない。** `image` は1枚あたり数百KB〜数MBの
 * BLOB で、`memories.ts` などと同じ書き方にすると一覧を引くたびに全画像がメモリへ載る。
 * 用途ごとに列を絞った関数を分けてある:
 *
 *   - `listSnapshotMeta` / `getSnapshotMeta` … 画像を含まない。APIのJSONへ出すのはこちら
 *   - `getSnapshotImage`                    … 画像だけ。バイナリ配信専用
 */

const META_COLUMNS = 'id, chat_id, message_id, prompt, model, mime, bytes, created_at';

/** チャット単位でまとめて引く。メッセージごとに引くとN+1になる */
export function listSnapshotMeta(chatId: string): SnapshotMeta[] {
  return db
    .prepare(`SELECT ${META_COLUMNS} FROM snapshots WHERE chat_id = ? ORDER BY created_at ASC`)
    .all(chatId) as SnapshotMeta[];
}

export function getSnapshotMeta(id: string): SnapshotMeta | undefined {
  return db.prepare(`SELECT ${META_COLUMNS} FROM snapshots WHERE id = ?`).get(id) as
    | SnapshotMeta
    | undefined;
}

/** バイナリ配信専用。better-sqlite3 は BLOB を Buffer で返す */
export function getSnapshotImage(id: string): { mime: string; image: Buffer } | undefined {
  return db.prepare('SELECT mime, image FROM snapshots WHERE id = ?').get(id) as
    | { mime: string; image: Buffer }
    | undefined;
}

export function createSnapshot(input: {
  chatId: string;
  messageId: string;
  prompt: string;
  model: string;
  mime: string;
  image: Buffer;
}): SnapshotMeta {
  const meta: SnapshotMeta = {
    id: ulid(),
    chat_id: input.chatId,
    message_id: input.messageId,
    prompt: input.prompt,
    model: input.model,
    mime: input.mime,
    bytes: input.image.length,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO snapshots (id, chat_id, message_id, prompt, model, mime, image, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    meta.id, meta.chat_id, meta.message_id, meta.prompt, meta.model, meta.mime,
    input.image, meta.bytes, meta.created_at,
  );
  return meta;
}

export function deleteSnapshot(id: string): void {
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
}
