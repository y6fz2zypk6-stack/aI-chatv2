// 旧スキーマのDBを作り、サーバを起動してマイグレーションが通るかを見る。
//   node test/migrate.mjs
// 前提: あらかじめ `npm run build -w server` でビルドしておく。
//
// 検証したいのは「既存ユーザーのDBが壊れずに v1.5.3 へ上がること」なので、
// 一番古いスキーマ（seq 導入前・initial_state 導入前・イベント拡張前）から始める。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(path.join(tmpdir(), 'charchat-migrate-'));
const dbPath = path.join(workDir, 'legacy.sqlite');

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

const NOW = Date.now();

/** v1.4 期のスキーマの、マイグレーションが触る部分だけを再現する */
function buildLegacyDb() {
  const d = new Database(dbPath);
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE worlds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      indoor INTEGER NOT NULL DEFAULT 0,
      area TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE scenarios (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      scenario_id TEXT,
      state TEXT NOT NULL DEFAULT '{}',
      extracted_up_to TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      state_after TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE message_variants (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      "index" INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      state_after TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE summaries (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      up_to_message_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE world_events (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      condition TEXT NOT NULL DEFAULT '{}',
      trigger TEXT NOT NULL DEFAULT 'once',
      cooldown_days INTEGER NOT NULL DEFAULT 0,
      inject TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE calendars (
      world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
      config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE event_fires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES world_events(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      game_time INTEGER NOT NULL
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    -- ゲーム内日付を持たない旧メモリー表（マイグレーション5の ALTER 対象）
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      subject TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);

  const st = (t, s) => JSON.stringify({ time: t, location: 'loc_a', weather: '晴', present: [], ...s });
  d.exec(`
    INSERT INTO worlds VALUES ('w1', '旧世界', ${NOW}, ${NOW});
    INSERT INTO scenarios VALUES ('sc1', 'w1', '旧シナリオ', ${NOW}, ${NOW});
    INSERT INTO chats VALUES ('c1', 'w1', 'sc1', '${st(1000)}', '01CCCC', ${NOW}, ${NOW});
  `);
  // ULID は時刻順に並ぶ。旧実装はこの順序に依存していた
  const ids = ['01AAAA', '01BBBB', '01CCCC'];
  ids.forEach((id, i) => {
    d.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(
      id, 'c1', i % 2 === 0 ? 'user' : 'assistant', st(900 + i * 10), NOW + i,
    );
  });
  // 先頭メッセージの index 0 の候補（＝initial_state のバックフィル元）
  d.prepare('INSERT INTO message_variants VALUES (?,?,?,?,?,?)')
    .run('v0', '01AAAA', 0, 'こんにちは', st(880), NOW);
  // index が重複した壊れた候補。マイグレーションで採番し直される
  d.prepare('INSERT INTO message_variants VALUES (?,?,?,?,?,?)')
    .run('v1', '01BBBB', 0, '候補A', st(910), NOW);
  d.prepare('INSERT INTO message_variants VALUES (?,?,?,?,?,?)')
    .run('v2', '01BBBB', 0, '候補B', st(920), NOW + 1);
  d.prepare('INSERT INTO summaries VALUES (?,?,?,?,?)')
    .run('s1', 'c1', '01BBBB', 'あらすじ', NOW);
  // 既定リストに無いエリアも使っている
  d.prepare('INSERT INTO locations VALUES (?,?,?,?,?,?,?)')
    .run('loc_a', 'w1', '古い酒場', 1, 'backstreet', NOW, NOW);
  d.prepare('INSERT INTO locations VALUES (?,?,?,?,?,?,?)')
    .run('loc_b', 'w1', '灯台', 0, 'lighthouse_cape', NOW, NOW);
  d.prepare('INSERT INTO world_events VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('e1', 'w1', '旧イベント', '{"month":9,"weather":["雨"]}', 'once', 0, '雨が降っている。', 1, NOW, NOW);
  d.prepare('INSERT INTO event_fires (event_id, chat_id, game_time) VALUES (?,?,?)')
    .run('e1', 'c1', 900);
  d.prepare('INSERT INTO characters VALUES (?,?,?,?,?)').run('ch1', 'w1', '旧キャラ', NOW, NOW);
  d.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?)')
    .run('mem1', 'ch1', '', '古い記憶', 'auto', 0, NOW, NOW);
  // 終電のオンオフ・呼び方を持たない、旧い暦設定
  d.prepare('INSERT INTO calendars VALUES (?,?,?,?)').run(
    'w1',
    JSON.stringify({ last_train_min: 1320, after_last_train_text: '旧テキスト' }),
    NOW, NOW,
  );
  d.close();
}

console.log(`旧スキーマDB: ${dbPath}`);
buildLegacyDb();

let exitCode = 1;
try {
  // サーバを一度起動するとマイグレーションが走る。--check だけで終了させたいので
  // マイグレーションを含む db モジュールを直接読み込む
  execFileSync(
    process.execPath,
    ['-e', "await import('./dist/server/src/db/index.js'); process.exit(0);"],
    { cwd: path.join(here, '..'), env: { ...process.env, DB_PATH: dbPath }, stdio: 'inherit' },
  );

  const d = new Database(dbPath, { readonly: true });
  const cols = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

  console.log('\n── マイグレーション（旧スキーマ → v1.5.3）');
  check('schema_migrations に5件記録される',
    d.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n >= 5,
    String(d.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n));

  // #1 seq と一意制約
  const seqs = d.prepare('SELECT id, seq FROM messages ORDER BY seq').all();
  check('messages.seq が ULID 順に採番される',
    seqs.map((r) => r.id).join(',') === '01AAAA,01BBBB,01CCCC',
    seqs.map((r) => `${r.id}:${r.seq}`).join(' '));
  check('seq は 1 始まりの連番', seqs.map((r) => r.seq).join(',') === '1,2,3');
  const vidx = d.prepare(`SELECT id, "index" FROM message_variants WHERE message_id='01BBBB' ORDER BY "index"`).all();
  check('重複した候補は消さずに index を採番し直す',
    vidx.map((r) => `${r.id}:${r.index}`).join(',') === 'v1:0,v2:1', JSON.stringify(vidx));
  const uniq = (name) => {
    const info = d.prepare(`PRAGMA index_list(${name})`).all();
    return info;
  };
  const mIdx = uniq('messages').find((r) => r.name === 'idx_messages_chat_seq');
  check('messages(chat_id, seq) の一意索引がある', !!mIdx && mIdx.unique === 1,
    JSON.stringify(uniq('messages')));
  const vIdx = uniq('message_variants').find((r) => r.name === 'idx_variants_message_index');
  check('message_variants(message_id, index) の一意索引がある', !!vIdx && vIdx.unique === 1,
    JSON.stringify(uniq('message_variants')));
  check('summaries.up_to_seq が引き継がれる',
    d.prepare('SELECT up_to_seq FROM summaries').get().up_to_seq === 2);
  check('chats.extracted_up_to_seq が引き継がれる',
    d.prepare('SELECT extracted_up_to_seq FROM chats').get().extracted_up_to_seq === 3);

  // #2 initial_state
  const chat = d.prepare('SELECT * FROM chats').get();
  check('chats.initial_state が先頭候補から埋まる',
    JSON.parse(chat.initial_state).time === 880, chat.initial_state);

  // #3 v1.5.3
  check('worlds.vars_schema が追加される', cols('worlds').includes('vars_schema'));
  check('scenarios の継承フラグは NULL のまま',
    d.prepare('SELECT events_enabled e, vars_enabled v FROM scenarios').get().e === null);
  const ev = d.prepare('SELECT * FROM world_events').get();
  check('world_events に when / check が追加される',
    cols('world_events').includes('when') && cols('world_events').includes('check'),
    cols('world_events').join(' '));
  check('旧 condition が when へ包まれる',
    ev.when === '{"all":[{"month":9,"weather":["雨"]}]}', ev.when);
  check('移行後の check は every_turn（既存の挙動を変えない）', ev.check === 'every_turn', ev.check);
  check('chance の既定は 1.0', ev.chance === 1.0, String(ev.chance));
  const fire = d.prepare('SELECT * FROM event_fires').get();
  check('event_fires が作り直され、旧履歴が引き継がれる',
    !!fire && fire.event_id === 'e1' && fire.fired_at_time === 900, JSON.stringify(fire));
  check('引き継いだ履歴の id は文字列', typeof fire?.id === 'string', String(fire?.id));

  // #4 エリア
  const areas = JSON.parse(d.prepare('SELECT areas FROM worlds').get().areas);
  check('worlds.areas が追加される', Array.isArray(areas), JSON.stringify(areas));
  check('既定の5つは残る',
    ['hilltop', 'center', 'backstreet', 'harbor', 'outskirts'].every((id) =>
      areas.some((a) => a.id === id)),
    areas.map((a) => a.id).join(','));
  check('既定IDには日本語の表示名が付く',
    areas.find((a) => a.id === 'backstreet')?.name === '裏通り',
    JSON.stringify(areas.find((a) => a.id === 'backstreet')));
  check('場所が使っている独自エリアも拾う',
    areas.some((a) => a.id === 'lighthouse_cape' && a.name === 'lighthouse_cape'),
    areas.map((a) => a.id).join(','));

  // #5 メモリーのゲーム内日付
  check('memories.game_time が追加される', cols('memories').includes('game_time'),
    cols('memories').join(' '));
  const mem = d.prepare('SELECT * FROM memories').get();
  check('既存のメモリーは消えない', mem?.content === '古い記憶', JSON.stringify(mem));
  check('既存のメモリーの日付は NULL（推測で埋めない）', mem?.game_time === null,
    String(mem?.game_time));
  d.close();

  // 暦は列ではなくJSONなので、新しいキーは読み出し時に既定で補われる
  {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `const { getCalendar } = await import('./dist/server/src/db/repo/calendars.js');
         console.log(JSON.stringify(getCalendar('w1')));`,
      ],
      { cwd: path.join(here, '..'), env: { ...process.env, DB_PATH: dbPath } },
    ).toString();
    const cfg = JSON.parse(out.trim().split('\n').pop());
    check('旧い暦設定でも last_train_enabled が既定で補われる', cfg.last_train_enabled === 1,
      String(cfg.last_train_enabled));
    check('旧い暦設定でも last_train_label が既定で補われる', cfg.last_train_label === '終電',
      cfg.last_train_label);
    check('保存済みの値は上書きされない',
      cfg.last_train_min === 1320 && cfg.after_last_train_text === '旧テキスト',
      `${cfg.last_train_min} / ${cfg.after_last_train_text}`);
  }

  // 2回目の起動でも落ちないこと（冪等性）
  execFileSync(
    process.execPath,
    ['-e', "await import('./dist/server/src/db/index.js'); process.exit(0);"],
    { cwd: path.join(here, '..'), env: { ...process.env, DB_PATH: dbPath }, stdio: 'inherit' },
  );
  check('もう一度起動しても落ちない（冪等）', true);

  console.log(`\n${failed === 0 ? 'すべて通りました' : `${failed}件失敗`}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\nマイグレーションの検証に失敗しました:', err);
  exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(exitCode);
