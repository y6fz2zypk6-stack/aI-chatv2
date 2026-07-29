import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || './data/app.sqlite';

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

export const db = new Database(DB_PATH);

// §8.10: SQLiteは既定OFFのため接続ごとに必ず有効化
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// スキーマ初期化（IF NOT EXISTS のみで構成）
const schemaPath = path.join(__dirname, 'schema.sql');
db.exec(fs.readFileSync(schemaPath, 'utf-8'));

// ---- 番号管理マイグレーション ----
// 型変更・列削除にも対応できるよう、番号付きで migrations 配列に追記していく。
const migrations: { version: number; up: (d: Database.Database) => void }[] = [
  // { version: 1, up: (d) => d.exec('ALTER TABLE ...') },
];

const applied = new Set(
  (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
    (r) => r.version,
  ),
);
for (const m of migrations.sort((a, b) => a.version - b.version)) {
  if (applied.has(m.version)) continue;
  const tx = db.transaction(() => {
    m.up(db);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      m.version,
      Date.now(),
    );
  });
  tx();
  console.log(`[db] migration ${m.version} applied`);
}

export function now(): number {
  return Date.now();
}

/** JSON列 → 値。壊れていたらフォールバック */
export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
