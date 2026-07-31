-- スキーマ定義（初期化用）。変更は db/migrations の番号付きマイグレーションで行う。
-- JSON列（aliases / keys / participant_ids / state / state_after 等）はJSON文字列で保存し、
-- API境界では string[] / オブジェクトに展開する。
-- 注意: PRAGMA foreign_keys = ON は接続ごとにアプリ側で有効化する（§8.10）。

CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  narrator_prompt TEXT NOT NULL DEFAULT '',
  -- 進行フラグのホワイトリスト（JSON配列）。未定義キーの増殖を防ぐ
  vars_schema TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  avatar TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  speech_style TEXT NOT NULL DEFAULT '',
  example_dialogue TEXT NOT NULL DEFAULT '',
  is_npc_pool INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  participant_ids TEXT NOT NULL DEFAULT '[]',
  default_persona_id TEXT,
  opening TEXT NOT NULL DEFAULT '',
  initial_state TEXT NOT NULL DEFAULT '{}',
  narrator_enabled INTEGER NOT NULL DEFAULT 1,
  -- NULL は「上位（全体設定）から継承」を表す
  events_enabled INTEGER,
  vars_enabled INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
  participant_ids TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  narrator_enabled INTEGER NOT NULL DEFAULT 1,
  -- NULL は「上位（シナリオ → 全体設定）から継承」を表す
  events_enabled INTEGER,
  vars_enabled INTEGER,
  state TEXT NOT NULL DEFAULT '{}',
  -- Chat作成時にシナリオからコピーした初期ステート（§4.6）。以後変更しない。
  -- 先頭メッセージの再生成の基準、および全メッセージ削除時の復元に使う。
  initial_state TEXT NOT NULL DEFAULT '{}',
  extracted_up_to TEXT,
  extracted_up_to_seq INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- seq はチャット内の連番。会話の順序（履歴窓・未要約範囲・fork・前後取得）は
-- すべて seq を基準にする。ULIDの時系列性には依存しない。
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  utterances TEXT NOT NULL DEFAULT '[]',
  state_after TEXT NOT NULL DEFAULT '{}',
  active_variant INTEGER NOT NULL DEFAULT 0,
  generation_status TEXT CHECK (generation_status IN ('complete', 'stopped', 'failed')),
  created_at INTEGER NOT NULL
);
-- messages(chat_id, seq) / message_variants(message_id, index) の一意インデックスは
-- 既存DBへの列追加のあとに張る必要があるため、migrate 側で作成する。

CREATE TABLE IF NOT EXISTS message_variants (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  "index" INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  utterances TEXT NOT NULL DEFAULT '[]',
  state_delta TEXT NOT NULL DEFAULT '',
  state_after TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lorebook_entries (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  keys TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  always INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'その他',
  trigger_locations TEXT NOT NULL DEFAULT '[]',
  trigger_seasons TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  indoor INTEGER NOT NULL DEFAULT 0,
  area TEXT NOT NULL DEFAULT '',
  open_min INTEGER,
  close_min INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendars (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- "when" / "check" はSQLの予約語のため、参照時は必ず二重引用符で囲む
CREATE TABLE IF NOT EXISTS world_events (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'ambient',
  "when" TEXT NOT NULL DEFAULT '{}',
  "check" TEXT NOT NULL DEFAULT 'every_turn',
  chance REAL NOT NULL DEFAULT 1.0,
  trigger TEXT NOT NULL DEFAULT 'once',
  trigger_var TEXT NOT NULL DEFAULT '',
  cooldown_days INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  inject_mode TEXT NOT NULL DEFAULT 'fact',
  inject TEXT NOT NULL DEFAULT '',
  set_vars TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_fires (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES world_events(id) ON DELETE CASCADE,
  message_id TEXT,
  fired_at_time INTEGER NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_fires_chat ON event_fires(chat_id, event_id);

-- up_to_seq が範囲判定の正。up_to_message_id は参照・表示用に残す
-- （境界のメッセージが削除されても範囲が壊れないようにするため）
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  up_to_message_id TEXT NOT NULL,
  up_to_seq INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_chat ON summaries(chat_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
