import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { ReferenceMeta } from '../../../../shared/types.js';

/**
 * 参照用の高画質画像（§21.4）。
 *
 * **`repo/snapshots.ts` と同じで `SELECT *` を使わない。** `image` は数百KBの BLOB で、
 * `characters.ts` のような書き方にすると引くたびに画像がメモリへ載る。
 * 用途ごとに列を絞った関数を分けてある:
 *
 *   - `getReferenceMeta` … 画像を含まない。APIのJSONへ出すのはこちら
 *   - `getReferenceImage` … 画像だけ。バイナリ配信と上流への送信に使う
 */

const META_COLUMNS = 'id, character_id, persona_id, mime, bytes, created_at';

/** 持ち主。キャラかペルソナのどちらか一方 */
export interface RefOwner {
  kind: 'character' | 'persona';
  id: string;
}

const ownerColumn = (owner: RefOwner) =>
  owner.kind === 'character' ? 'character_id' : 'persona_id';

export function getReferenceMeta(owner: RefOwner): ReferenceMeta | undefined {
  return db
    .prepare(`SELECT ${META_COLUMNS} FROM reference_images WHERE ${ownerColumn(owner)} = ?`)
    .get(owner.id) as ReferenceMeta | undefined;
}

/** バイナリ配信と、上流へ送る data URL の組み立てに使う */
export function getReferenceImage(id: string): { mime: string; image: Buffer } | undefined {
  return db.prepare('SELECT mime, image FROM reference_images WHERE id = ?').get(id) as
    | { mime: string; image: Buffer }
    | undefined;
}

/** 持ち主から直接引く。生成のたびに2回引かなくて済むようにしておく */
export function getReferenceImageOf(owner: RefOwner): { mime: string; image: Buffer } | undefined {
  return db
    .prepare(`SELECT mime, image FROM reference_images WHERE ${ownerColumn(owner)} = ?`)
    .get(owner.id) as { mime: string; image: Buffer } | undefined;
}

/**
 * 1人につき1枚。既にあれば差し替える。
 *
 * **delete → insert を1トランザクションで行う。** 一意インデックスに当たって
 * 古い方だけが消えた状態を残さないため。IDは差し替えのたびに変わるので、
 * 配信URLを `immutable` にできる。
 */
export function putReference(owner: RefOwner, mime: string, image: Buffer): ReferenceMeta {
  const meta: ReferenceMeta = {
    id: ulid(),
    character_id: owner.kind === 'character' ? owner.id : null,
    persona_id: owner.kind === 'persona' ? owner.id : null,
    mime,
    bytes: image.length,
    created_at: now(),
  };
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM reference_images WHERE ${ownerColumn(owner)} = ?`).run(owner.id);
    db.prepare(
      `INSERT INTO reference_images (id, character_id, persona_id, mime, image, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      meta.id, meta.character_id, meta.persona_id, meta.mime, image, meta.bytes, meta.created_at,
    );
  });
  tx();
  return meta;
}

export function deleteReference(owner: RefOwner): boolean {
  return (
    db
      .prepare(`DELETE FROM reference_images WHERE ${ownerColumn(owner)} = ?`)
      .run(owner.id).changes > 0
  );
}

/** 世界の削除確認に出す枚数。ペルソナは世界に属さないので数えない */
export function countReferencesInWorld(worldId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) c FROM reference_images r
           JOIN characters ch ON ch.id = r.character_id
          WHERE ch.world_id = ?`,
      )
      .get(worldId) as { c: number }
  ).c;
}
