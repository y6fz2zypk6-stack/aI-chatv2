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

function hasColumn(d: Database.Database, table: string, column: string): boolean {
  const rows = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

// ---- 番号管理マイグレーション ----
// 型変更・列削除にも対応できるよう、番号付きで migrations 配列に追記していく。
const migrations: { version: number; up: (d: Database.Database) => void }[] = [
  {
    // 会話の順序を ULID ではなくチャット内連番 seq で表す。
    // 併せて候補番号の一意性をDBで保証する。
    version: 1,
    up: (d) => {
      if (!hasColumn(d, 'messages', 'seq')) {
        d.exec('ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0');
        // 既存データはチャットごとに id 昇順（＝これまでの表示順）で採番する
        const chatIds = (
          d.prepare('SELECT DISTINCT chat_id FROM messages').all() as { chat_id: string }[]
        ).map((r) => r.chat_id);
        const pick = d.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY id ASC, rowid ASC');
        const setSeq = d.prepare('UPDATE messages SET seq = ? WHERE id = ?');
        for (const chatId of chatIds) {
          let n = 0;
          for (const row of pick.all(chatId) as { id: string }[]) setSeq.run(++n, row.id);
        }
      }
      d.exec('DROP INDEX IF EXISTS idx_messages_chat');
      d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, seq)');

      // 一意インデックスを張る前に、万一の重複候補を古い1件だけ残して掃除する
      d.exec(`DELETE FROM message_variants WHERE rowid NOT IN (
                SELECT MIN(rowid) FROM message_variants GROUP BY message_id, "index"
              )`);
      d.exec('DROP INDEX IF EXISTS idx_variants_message');
      d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_message_index
                ON message_variants(message_id, "index")`);

      // 要約・抽出の境界も seq で持つ（境界メッセージが削除されても範囲が壊れない）
      if (!hasColumn(d, 'summaries', 'up_to_seq')) {
        d.exec('ALTER TABLE summaries ADD COLUMN up_to_seq INTEGER NOT NULL DEFAULT 0');
        d.exec(`UPDATE summaries SET up_to_seq = COALESCE(
                  (SELECT m.seq FROM messages m WHERE m.id = summaries.up_to_message_id), 0)`);
      }
      if (!hasColumn(d, 'chats', 'extracted_up_to_seq')) {
        d.exec('ALTER TABLE chats ADD COLUMN extracted_up_to_seq INTEGER');
        d.exec(`UPDATE chats SET extracted_up_to_seq =
                  (SELECT m.seq FROM messages m WHERE m.id = chats.extracted_up_to)`);
      }
    },
  },
  {
    // Chat作成時の初期ステートを保持する（§4.6）。
    // これが無いと、直前メッセージが存在しない再生成（＝先頭メッセージ）の基準が
    // chats.state になり、再生成のたびにゲーム内時間が累積してしまう（§8.1違反）。
    version: 2,
    up: (d) => {
      if (hasColumn(d, 'chats', 'initial_state')) return;
      d.exec("ALTER TABLE chats ADD COLUMN initial_state TEXT NOT NULL DEFAULT '{}'");
      // 既存Chatは最善の推定で埋める:
      //   ① 先頭メッセージの index 0 の候補（先頭を再生成しても元の値が残っている）
      //   ② 先頭メッセージの state_after
      //   ③ 現在のステート
      d.exec(`UPDATE chats SET initial_state = COALESCE(
                (SELECT v.state_after FROM messages m
                   JOIN message_variants v ON v.message_id = m.id AND v."index" = 0
                  WHERE m.chat_id = chats.id
                  ORDER BY m.seq ASC LIMIT 1),
                (SELECT m.state_after FROM messages m
                  WHERE m.chat_id = chats.id ORDER BY m.seq ASC LIMIT 1),
                chats.state)`);
    },
  },
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
