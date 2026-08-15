import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { AlbumItem, AlbumWorld, SnapshotMeta } from '../../../../shared/types.js';

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

// ---- アルバム（§21.8） ----

/**
 * 世界ごとの枚数と合計サイズ。アルバムの入口用。
 * `snapshots` は `chat_id` しか持たないので、世界は `chats` 経由で引く。
 * 1枚も無い世界は出さない（整理する対象が無いため）。
 */
export function listAlbumWorlds(): AlbumWorld[] {
  return db
    .prepare(
      `SELECT w.id AS world_id, w.name AS world_name,
              COUNT(s.id) AS count, COALESCE(SUM(s.bytes), 0) AS bytes
         FROM snapshots s
         JOIN chats c ON c.id = s.chat_id
         JOIN worlds w ON w.id = c.world_id
        GROUP BY w.id
        ORDER BY bytes DESC`,
    )
    .all() as AlbumWorld[];
}

/** その世界のスナップショット一覧。**画像は含めない**（一覧に載せると数十MBになる） */
export function listSnapshotsByWorld(worldId: string): AlbumItem[] {
  const cols = META_COLUMNS.split(', ')
    .map((c) => `s.${c}`)
    .join(', ');
  return db
    .prepare(
      `SELECT ${cols}, c.title AS chat_title, COALESCE(m.seq, 0) AS seq
         FROM snapshots s
         JOIN chats c ON c.id = s.chat_id
         LEFT JOIN messages m ON m.id = s.message_id
        WHERE c.world_id = ?
        ORDER BY c.created_at ASC, seq ASC, s.created_at ASC`,
    )
    .all(worldId) as AlbumItem[];
}

/**
 * まとめて削除する。**1トランザクション。**
 * 途中で失敗して半端に消えた状態を残さない。
 * 戻り値は実際に消えた件数（存在しないIDが混ざっても他は消える）。
 */
export function deleteSnapshots(ids: string[]): number {
  const stmt = db.prepare('DELETE FROM snapshots WHERE id = ?');
  const tx = db.transaction((list: string[]) => {
    let n = 0;
    for (const id of list) n += stmt.run(id).changes;
    return n;
  });
  return tx(ids) as number;
}
