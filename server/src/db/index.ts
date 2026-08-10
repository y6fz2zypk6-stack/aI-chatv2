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

      // 一意インデックスを張る前に、万一 index が重複している候補を採番し直す。
      // 消してしまうとユーザーが作った候補が失われるので、古い順に 0,1,2… を振り直す
      const dup = d
        .prepare(
          `SELECT message_id FROM message_variants
             GROUP BY message_id, "index" HAVING COUNT(*) > 1`,
        )
        .all() as { message_id: string }[];
      const renumber = d.prepare('UPDATE message_variants SET "index" = ? WHERE id = ?');
      const pickVariants = d.prepare(
        'SELECT id FROM message_variants WHERE message_id = ? ORDER BY "index" ASC, rowid ASC',
      );
      for (const messageId of new Set(dup.map((r) => r.message_id))) {
        let i = 0;
        for (const row of pickVariants.all(messageId) as { id: string }[]) renumber.run(i++, row.id);
      }
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
  {
    // v1.5.3: 進行フラグと条件付きイベント
    version: 3,
    up: (d) => {
      const add = (table: string, col: string, def: string) => {
        // col は予約語対策で `"when"` のように引用符付きで来ることがある。
        // 存在確認は引用符を外した名前で行う
        const bare = col.replace(/"/g, '');
        if (!hasColumn(d, table, bare)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      };

      add('worlds', 'vars_schema', "TEXT NOT NULL DEFAULT '[]'");
      // NULL は「上位から継承」。既定値は付けない
      add('scenarios', 'events_enabled', 'INTEGER');
      add('scenarios', 'vars_enabled', 'INTEGER');
      add('chats', 'events_enabled', 'INTEGER');
      add('chats', 'vars_enabled', 'INTEGER');

      // world_events の拡張。旧 condition は when へ包んで移行する
      add('world_events', 'kind', "TEXT NOT NULL DEFAULT 'ambient'");
      add('world_events', '"when"', "TEXT NOT NULL DEFAULT '{}'");
      // 既存イベントの挙動を変えないため、移行後の check は every_turn とする
      add('world_events', '"check"', "TEXT NOT NULL DEFAULT 'every_turn'");
      add('world_events', 'chance', 'REAL NOT NULL DEFAULT 1.0');
      add('world_events', 'trigger_var', "TEXT NOT NULL DEFAULT ''");
      add('world_events', 'priority', 'INTEGER NOT NULL DEFAULT 0');
      add('world_events', 'inject_mode', "TEXT NOT NULL DEFAULT 'fact'");
      add('world_events', 'set_vars', "TEXT NOT NULL DEFAULT '[]'");
      if (hasColumn(d, 'world_events', 'condition')) {
        // {"month":9,...} → {"all":[{"month":9,...}]}
        d.exec(`UPDATE world_events
                   SET "when" = '{"all":[' || condition || ']}'
                 WHERE "when" IN ('', '{}')
                   AND condition NOT IN ('', '{}')`);
      }

      // event_fires を新しい形へ作り直す（PKの型が変わるため置き換える）
      if (!hasColumn(d, 'event_fires', 'fired_at_time')) {
        d.exec(`CREATE TABLE event_fires_new (
                  id TEXT PRIMARY KEY,
                  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                  event_id TEXT NOT NULL REFERENCES world_events(id) ON DELETE CASCADE,
                  message_id TEXT,
                  fired_at_time INTEGER NOT NULL,
                  scope_key TEXT NOT NULL DEFAULT '',
                  created_at INTEGER NOT NULL
                )`);
        if (hasColumn(d, 'event_fires', 'game_time')) {
          // 旧履歴は chat_id / event_id / 発火時刻だけ引き継ぐ。
          // 参照先のChatが消えている行はFKに引っかかるので除く
          d.exec(`INSERT INTO event_fires_new (id, chat_id, event_id, message_id, fired_at_time, scope_key, created_at)
                  SELECT 'legacy-' || f.rowid, f.chat_id, f.event_id, NULL, f.game_time, '', ${Date.now()}
                    FROM event_fires f
                   WHERE EXISTS (SELECT 1 FROM chats c WHERE c.id = f.chat_id)`);
        }
        d.exec('DROP TABLE event_fires');
        d.exec('ALTER TABLE event_fires_new RENAME TO event_fires');
      }
      d.exec('CREATE INDEX IF NOT EXISTS idx_event_fires_chat ON event_fires(chat_id, event_id)');
    },
  },
  {
    // エリアを世界ごとに持たせる。これまではクライアントに固定リストが直書きされていた。
    // id は locations.area と world_events.when.location_area から参照されるため不変で、
    // アプリから変えられるのは name だけ（リネームで参照が壊れないようにするため）。
    version: 4,
    up: (d) => {
      if (hasColumn(d, 'worlds', 'areas')) return;
      d.exec("ALTER TABLE worlds ADD COLUMN areas TEXT NOT NULL DEFAULT '[]'");
      // 既存の世界は、実際に使われているエリアを拾って作る（挙動が変わらないようにする）。
      // 既定IDには日本語の表示名を当て、見覚えのないIDはそのまま表示名にする
      const known: Record<string, string> = {
        hilltop: '丘の上',
        center: '中央',
        backstreet: '裏通り',
        harbor: '港',
        outskirts: '郊外',
      };
      const worlds = d.prepare('SELECT id FROM worlds').all() as { id: string }[];
      const pick = d.prepare(
        `SELECT DISTINCT area FROM locations WHERE world_id = ? AND area <> '' ORDER BY area`,
      );
      const save = d.prepare('UPDATE worlds SET areas = ? WHERE id = ?');
      for (const w of worlds) {
        const used = (pick.all(w.id) as { area: string }[]).map((r) => r.area);
        // 使われていないぶんも含め、既定の5つは常に選べるようにしておく
        const ids = [...new Set([...Object.keys(known), ...used])];
        save.run(JSON.stringify(ids.map((id) => ({ id, name: known[id] ?? id }))), w.id);
      }
    },
  },
  {
    // メモリーに「ゲーム内でいつの出来事か」を持たせる。
    // 既存行は NULL のまま（＝日付不明）にする。実時間の created_at から
    // ゲーム内時刻を逆算する方法は無く、推測で埋めると嘘の日付が入るため。
    version: 5,
    up: (d) => {
      if (hasColumn(d, 'memories', 'game_time')) return;
      d.exec('ALTER TABLE memories ADD COLUMN game_time INTEGER');
    },
  },
  {
    // 「場面を進める」で入れる場面転換マーカーの識別。
    // messages.role は CHECK で user/assistant に固定されており、SQLite では
    // 表を作り直さないと変えられないため、種別は別列で持つ
    version: 6,
    up: (d) => {
      if (hasColumn(d, 'messages', 'kind')) return;
      d.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'");
    },
  },
  {
    // メモリーの注入オンオフ。ロアブックと同じく、消さずに黙らせるための列。
    // 既存はすべて有効（＝これまでと同じ挙動）
    version: 7,
    up: (d) => {
      if (hasColumn(d, 'memories', 'enabled')) return;
      d.exec('ALTER TABLE memories ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
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
