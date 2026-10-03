import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Connection } from '../../../../shared/types.js';

/**
 * 接続先（§6.6）。**`api_key` を持つ唯一のテーブル。**
 *
 * 行をそのまま返す関数（`getConnectionSecret`）と、キーを落として返す関数を分ける。
 * ルート側が誤ってキー入りの行を `res.json` へ流さないよう、型の時点で区別する
 * （不変条件43）。
 */

/** キーを含む行。**LLM呼び出し層だけが使う。** レスポンスへ載せないこと */
export interface ConnectionSecret extends Connection {
  api_key: string;
}

export function listConnections(): ConnectionSecret[] {
  return db
    .prepare('SELECT * FROM connections ORDER BY created_at ASC')
    .all() as ConnectionSecret[];
}

export function getConnectionSecret(id: string): ConnectionSecret | undefined {
  return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
    | ConnectionSecret
    | undefined;
}

/** ベースURLを正規化する。末尾の `/` は落とす（`${BASE}/models` が `//models` になるため） */
export function normalizeBaseUrl(v: unknown): string {
  return String(v ?? '').trim().replace(/\/+$/, '');
}

export function createConnection(input: Partial<ConnectionSecret>): ConnectionSecret {
  const t = now();
  const c: ConnectionSecret = {
    id: ulid(),
    name: String(input.name ?? '').trim(),
    base_url: normalizeBaseUrl(input.base_url),
    api_key: String(input.api_key ?? '').trim(),
    context_length: Math.max(0, Math.floor(Number(input.context_length) || 0)),
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO connections (id, name, base_url, api_key, context_length, created_at, updated_at)
     VALUES (@id, @name, @base_url, @api_key, @context_length, @created_at, @updated_at)`,
  ).run(c);
  return c;
}

export function updateConnection(
  id: string,
  patch: Partial<ConnectionSecret>,
): ConnectionSecret | undefined {
  const cur = getConnectionSecret(id);
  if (!cur) return undefined;
  const next: ConnectionSecret = {
    ...cur,
    name: patch.name === undefined ? cur.name : String(patch.name).trim(),
    base_url: patch.base_url === undefined ? cur.base_url : normalizeBaseUrl(patch.base_url),
    // **省略したら現状維持。** 画面の入力欄は常に空なので、触らなければ変わらない。
    // 空文字を明示したときだけ消す
    api_key: patch.api_key === undefined ? cur.api_key : String(patch.api_key).trim(),
    context_length:
      patch.context_length === undefined
        ? cur.context_length
        : Math.max(0, Math.floor(Number(patch.context_length) || 0)),
    id,
    created_at: cur.created_at,
    updated_at: now(),
  };
  db.prepare(
    `UPDATE connections SET name=@name, base_url=@base_url, api_key=@api_key,
       context_length=@context_length, updated_at=@updated_at WHERE id=@id`,
  ).run(next);
  return next;
}

export function deleteConnection(id: string): void {
  db.prepare('DELETE FROM connections WHERE id = ?').run(id);
}

/**
 * その接続先を使っている場所を探す。
 * **黙って消させない**ため（消すと参照していたチャットが壊れた形で残る）。
 */
export function connectionUsage(id: string): string[] {
  if (!id) return [];
  const like = `${id}::%`;
  const out: string[] = [];
  const chats = db
    .prepare('SELECT title FROM chats WHERE model LIKE ?')
    .all(like) as { title: string }[];
  for (const c of chats) out.push(`会話「${c.title || '(無題)'}」`);
  const keys = db
    .prepare("SELECT key, value FROM settings WHERE key IN ('default_model','utility_model','image_model')")
    .all() as { key: string; value: string }[];
  const label: Record<string, string> = {
    // 設定画面の名前に合わせる（「モデルと接続先」の小見出し・「スナップショット」）
    default_model: '「会話の本文」のモデル',
    utility_model: '「裏方の処理」のモデル',
    image_model: 'スナップショットの画像モデル',
  };
  for (const r of keys) {
    let v = r.value;
    try {
      v = JSON.parse(r.value) as string;
    } catch {
      /* 生文字列のまま */
    }
    if (typeof v === 'string' && v.startsWith(`${id}::`)) out.push(`設定の${label[r.key]}`);
  }
  return out;
}
