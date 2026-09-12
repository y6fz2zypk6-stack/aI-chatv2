// API境界の共有型定義。フロント・バック両方から参照する。
// characters.aliases / lorebook_entries.keys / 各種ID配列は API上では string[]、
// SQLite保存時のみJSON文字列へシリアライズする。

// ---- ステート（§4.11 唯一の正） ----

/** 進行フラグの値。ネスト・配列は持たない（v1.5.3 §2.1） */
export type VarValue = number | boolean | string;

/** chats.state / messages.state_after / message_variants.state_after の形式 */
export interface ChatState {
  /** 暦元期（1年1月1日 00:00）からの通算分（整数）。ISO文字列は使わない */
  time: number;
  /** 場所ID（locations.id）。未登録地は変更せず location_note に退避 */
  location: string;
  /** 未登録の場所のフリーテキスト退避先。空でなければ表示はこちらを優先 */
  location_note: string;
  weather: string;
  /** 在席する登録キャラ（準レギュラー含む）のIDのみ */
  present: string[];
  /** 進行フラグ。省略時は {}（既存データとの互換） */
  vars?: Record<string, VarValue>;
}

/** state.vars のキー上限（1チャットあたり。v1.5.3 §2.1） */
export const MAX_VARS = 64;
/** vars のキー名の形式 */
export const VAR_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** 表示用のゲーム内時刻構造体。サーバが time（通算分）から導出して返す */
export interface GameTime {
  year: number;
  month: number;
  day: number;
  /** 曜日名（calendars.weekdays の要素） */
  weekday: string;
  /** 月内の週 1〜4 */
  week: number;
  season: string;
  hh: number;
  mm: number;
}

/** モデルが返すステート差分（@@@STATEフェンスのパース結果） */
export interface StateDelta {
  elapsed_minutes: number;
  location?: string;
  present_add: string[];
  present_remove: string[];
  /** モデルが返した進行フラグの代入（v1.5.3 §3.2）。代入のみで加算記法は無い */
  set_var?: Record<string, VarValue>;
  /** フェンス欠落などでフォールバック値を適用した場合 true */
  fallback?: boolean;
  /**
   * `elapsed_minutes` に読み取れない値が書かれていた場合の生の値。
   * 既定値で進めたことを利用者へ伝えるために持つ（黙って別の分数に化けさせない）
   */
  elapsed_unparsed?: string;
}

// ---- 発話（§5.4） ----

export type Speaker = 'user' | 'char' | 'narrator' | 'npc';

export interface Utterance {
  speaker: Speaker;
  /** 表示名 */
  name: string;
  /** speaker === 'char' のとき */
  characterId?: string;
  /** 話者ラベルを除いた本文 */
  text: string;
}

// ---- エンティティ ----

// ---- 進行フラグのスキーマ（World単位のホワイトリスト。v1.5.3 §2.2） ----

export interface VarPhase {
  value: number;
  name: string;
  /** そのフェーズでモデルへ開示してよい情報。プロンプトに載る */
  public_state: string;
  /** 執筆者用メモ。プロンプトへ一切注入しない */
  private_note?: string;
}

export interface VarSchemaEntry {
  key: string;
  type: 'number' | 'boolean' | 'string';
  /** 省略時は flag */
  role?: 'phase' | 'flag';
  default?: VarValue;
  label?: string;
  min?: number;
  max?: number;
  /** true なら通常更新で値を後退させない */
  monotonic?: boolean;
  /** 省略時は system_and_llm */
  update_mode?: 'system_only' | 'system_and_llm';
  /** role = phase のときの各段階 */
  phases?: VarPhase[];
}

/**
 * 場所のエリア。
 * `id` は場所・イベント条件から参照されるので作成後は変えられない。
 * 表示に使うのは `name` だけなので、こちらは自由に変えてよい。
 */
export interface WorldArea {
  id: string;
  name: string;
}

/** 新しい世界の初期エリア。表示名はアプリから自由に変えられる */
export const DEFAULT_AREAS: WorldArea[] = [
  { id: 'hilltop', name: '丘の上' },
  { id: 'center', name: '中央' },
  { id: 'backstreet', name: '裏通り' },
  { id: 'harbor', name: '港' },
  { id: 'outskirts', name: '郊外' },
  { id: 'market', name: '市場' },
  { id: 'residential', name: '住宅区' },
  { id: 'underground', name: '地下' },
];

export const AREA_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

export interface World {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  narrator_prompt: string;
  /** 場所のエリア一覧。並び順がそのまま選択肢の順になる */
  areas: WorldArea[];
  /** 進行フラグのホワイトリスト */
  vars_schema: VarSchemaEntry[];
  created_at: number;
  updated_at: number;
}

export interface Character {
  id: string;
  world_id: string;
  name: string;
  aliases: string[];
  avatar: string;
  persona: string;
  /**
   * 画像生成用の外見（§21）。**本文生成のプロンプトには載せない。**
   * persona（性格・背景の文章）とは用途が違うので分けて持つ
   */
  appearance: string;
  speech_style: string;
  example_dialogue: string;
  is_npc_pool: number;
  created_at: number;
  updated_at: number;
}

export interface Persona {
  id: string;
  name: string;
  avatar: string;
  description: string;
  /** 画像生成用の外見（§21）。本文生成のプロンプトには載せない */
  appearance: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}

export interface Scenario {
  id: string;
  world_id: string;
  title: string;
  description: string;
  participant_ids: string[];
  default_persona_id: string | null;
  opening: string;
  initial_state: ChatState;
  narrator_enabled: number;
  /** 3段の解決順（チャット → シナリオ → 全体設定）。NULLで継承（v1.5.3 §1.1） */
  events_enabled: number | null;
  vars_enabled: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * APIが返すシナリオ。**開始時刻を年月日時分にほどいたものを添える**（§4.5）。
 * 暦は世界ごとに違うので、換算はサーバ（`calendar.ts`）だけが行う。
 * 保存する形（`Scenario`）には混ぜない — 派生値なので、DBへ焼き付けない
 */
export interface ScenarioView extends Scenario {
  initial_game_time: GameTime;
}

/**
 * 一時指示（OOC）の有効範囲。
 * `once` は次の生成が正常完了した時点で消え、`persistent` は手動で消すまで残る。
 */
export type TemporaryInstructionScope = 'once' | 'persistent';

export const TEMPORARY_INSTRUCTION_SCOPES: TemporaryInstructionScope[] = ['once', 'persistent'];

/** 一時指示の上限。演出の補正であって設定ではないので、短く抑える */
export const TEMPORARY_INSTRUCTION_MAX_CHARS = 500;

export function isTemporaryScope(v: unknown): v is TemporaryInstructionScope {
  return v === 'once' || v === 'persistent';
}

export interface Chat {
  id: string;
  world_id: string;
  scenario_id: string | null;
  title: string;
  persona_id: string | null;
  participant_ids: string[];
  model: string;
  narrator_enabled: number;
  /** 3段の解決順（チャット → シナリオ → 全体設定）。NULLで継承（v1.5.3 §1.1） */
  events_enabled: number | null;
  vars_enabled: number | null;
  state: ChatState;
  /** Chat作成時にシナリオからコピーした初期ステート。以後変更しない（§4.6） */
  initial_state: ChatState;
  extracted_up_to: string | null;
  /** 知識抽出済み範囲の境界。null なら未抽出 */
  extracted_up_to_seq: number | null;
  /**
   * OOCの一時指示。空文字なら未設定。
   * **メッセージとして保存しない。** 末尾systemへ専用ブロックで注入するだけで、
   * 会話履歴・要約・メモリー・ロア走査には入れない（不変条件41）
   */
  temporary_instruction: string;
  temporary_instruction_scope: TemporaryInstructionScope;
  archived: number;
  created_at: number;
  updated_at: number;
}

/** 一覧用。最新メッセージの抜粋を添えて返す */
export interface ChatListItem extends Chat {
  /** 最新メッセージの本文を話者ラベル・記号を落として短く切ったもの。無ければ空 */
  preview: string;
}

export type GenerationStatus = 'complete' | 'stopped' | 'failed';

export interface Message {
  id: string;
  chat_id: string;
  /** チャット内の連番。会話の順序はこれが正（idの時系列性には依存しない） */
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  utterances: Utterance[];
  state_after: ChatState;
  active_variant: number;
  generation_status: GenerationStatus | null;
  /**
   * 'scene_break' は「場面を進める」で入れた場面転換マーカー。
   * 生成された応答ではないので、再生成の対象にはしない。
   */
  kind: 'normal' | 'scene_break';
  created_at: number;
  /** assistantのとき候補数（一覧APIで付与） */
  variant_count?: number;
}

export interface MessageVariant {
  id: string;
  message_id: string;
  index: number;
  content: string;
  utterances: Utterance[];
  state_delta: string;
  state_after: ChatState;
  created_at: number;
}

export type LoreCategory = '世界観' | '用語' | '人物' | '場所' | 'イベント' | 'その他';

export interface LorebookEntry {
  id: string;
  world_id: string;
  character_id: string | null;
  title: string;
  keys: string[];
  content: string;
  enabled: number;
  always: number;
  priority: number;
  category: LoreCategory;
  trigger_locations: string[];
  trigger_seasons: string[];
  created_at: number;
  updated_at: number;
}

export interface Location {
  id: string;
  world_id: string;
  name: string;
  indoor: number;
  area: string;
  open_min: number | null;
  close_min: number | null;
  note: string;
  created_at: number;
  updated_at: number;
}

export interface SunTime {
  rise: string;
  set: string;
}

export interface CalendarConfig {
  months_per_year: number;
  days_per_month: number;
  weekdays: string[];
  /** 季節名 → 月番号の配列 */
  seasons: Record<string, number[]>;
  /** 月番号(文字列) → 日出・日没。未定義月は前後から線形補間（年跨ぎラップ） */
  sun: Record<string, SunTime>;
  /** 終電行を出すか。合わない世界観では 0 にする */
  last_train_enabled: number;
  /** 「終電」「最終バス」「最終転移」など、その世界での呼び方 */
  last_train_label: string;
  last_train_min: number;
  last_train_notice_min: number;
  after_last_train_text: string;
  /** 季節 → { 天候: 重み } */
  weather_table: Record<string, Record<string, number>>;
  /**
   * 天候を引き直す時刻（0時からの分）。既定 240 = 朝4時。
   * 日付の変わり目（0:00）とは別に持つ。深夜に会話していると
   * 日付が変わった瞬間に天気が切り替わって不自然なため（§12.3）。
   * 0 にすると 0:00 起点（日付の変わり目と同じ）になる。
   */
  weather_rollover_min: number;
}

// ---- 条件付きイベント（v1.5.3 §4・§5） ----

/** 述語。オブジェクトの複数キーはAND、配列で与えた値はOR */
export interface EventPredicate {
  season?: string[] | string;
  month?: number[] | number;
  week?: number[] | number;
  weekday?: string[] | string;
  time_after?: string;
  time_before?: string;
  location?: string[] | string;
  location_area?: string[] | string;
  weather?: string[] | string;
  present_has?: string[] | string;
  present_lacks?: string[] | string;
  /** 進行フラグの比較。var と比較子をセットで使う */
  var?: string;
  eq?: VarValue;
  ne?: VarValue;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: VarValue[];
}

export interface EventCondition extends EventPredicate {
  all?: EventCondition[];
  any?: EventCondition[];
  not?: EventCondition;
}

export type EventKind = 'ambient' | 'story' | 'critical';
export type EventCheck = 'every_turn' | 'on_enter' | 'on_day_change' | 'on_location_change';
export type EventTrigger =
  | 'once'
  | 'once_per_day'
  | 'once_per_visit'
  | 'once_per_phase'
  | 'once_per_year'
  | 'cooldown'
  | 'repeat';
export type InjectMode = 'fact' | 'instruction';

/** 発火時に自動適用する操作 */
export interface EventVarOp {
  key: string;
  op: 'set' | 'add';
  value: VarValue;
}

export interface WorldEvent {
  id: string;
  world_id: string;
  title: string;
  kind: EventKind;
  /** 条件式。空なら常に真 */
  when: EventCondition | null;
  check: EventCheck;
  /** 0.0〜1.0 */
  chance: number;
  trigger: EventTrigger;
  /** trigger = once_per_phase で参照する phase変数キー */
  trigger_var: string;
  cooldown_days: number;
  priority: number;
  inject_mode: InjectMode;
  inject: string;
  set_vars: EventVarOp[];
  enabled: number;
  created_at: number;
  updated_at: number;
  /** 一覧表示用に付与されることがある */
  last_fired_at?: number | null;
}

export interface EventFire {
  id: string;
  chat_id: string;
  event_id: string;
  message_id: string | null;
  /** 発火時点のゲーム内通算分 */
  fired_at_time: number;
  scope_key: string;
  created_at: number;
  /** 一覧表示用 */
  event_title?: string;
}

/** 判定パイプラインの結果（prompt-preview / 評価ボタン用） */
export interface EventEvalRow {
  id: string;
  title: string;
  kind: EventKind;
  inject_mode: InjectMode;
  /** adopted / condition（条件不一致）/ check / trigger / chance / capped */
  outcome: 'adopted' | 'condition' | 'check' | 'trigger' | 'chance' | 'capped';
  detail?: string;
}

export interface Summary {
  id: string;
  chat_id: string;
  up_to_message_id: string;
  /** 要約済み範囲の境界（この seq 以下が要約済み） */
  up_to_seq: number;
  content: string;
  created_at: number;
}

/**
 * 裏で走った処理（要約・知識抽出）の結果を画面へ知らせるための一言。
 * 「静かに失敗した」を作らないため、成功・失敗の両方を必ず返す。
 */
export interface Notice {
  kind: 'summary' | 'memory';
  ok: boolean;
  message: string;
}

export interface Memory {
  id: string;
  character_id: string;
  subject: string;
  content: string;
  source: 'manual' | 'auto';
  pinned: number;
  /**
   * その記憶が生まれたゲーム内時刻（暦元期からの通算分）。null は日付不明。
   * created_at（実時間）とは別物で、注入時の「3日前」表示に使う。
   * memories はチャットではなくキャラクターに紐づくため、相対表記が破綻しないよう
   * 絶対値で保存し、表示のときだけ現在時刻と突き合わせる。
   */
  game_time: number | null;
  /**
   * 0 なら注入しない。記録としては残す（削除とは別）。
   * 「もう出てこなくていいが、あった事実は残したい」ためのもの。
   */
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** 一覧APIの返り値。game_time の表示用の値をサーバ側で作って添える */
export interface MemoryListItem extends Memory {
  /** 「1年7月12日」など。game_time が null なら空文字 */
  game_time_label: string;
  /**
   * 編集欄の初期値に使う年月日。game_time が null なら null。
   * 通算分 ↔ 年月日の変換は暦に依存するので、クライアントでは行わない（§4.12）。
   */
  game_time_parts: { year: number; month: number; day: number } | null;
}

// ---- メモリーの棚卸し（§10.4） ----

/** 書き出しに載せる1件。判断に要る値をサーバ側で解決して添える */
export interface MemoryReviewItem extends Memory {
  character_name: string;
  /** subject を名前に直したもの。常時注入（空）なら空文字 */
  subject_name: string;
  /** 「3年8月10日(火)」など。日付不明なら空文字 */
  game_time_label: string;
  /**
   * **注入され得るか。** `enabled` が 0、または `subject` が実在しないIDだと false。
   * subject には外部キー制約が無いので、保存されているのに永久に注入されない記憶が
   * 生まれ得る（§10.2）。棚卸しで最初に見つけたいのがこれ
   */
  injectable: boolean;
}

export interface MemoryReviewStats {
  total: number;
  enabled: number;
  disabled: number;
  /** 注入される記憶の本文の合計文字数。棚卸しの効果はここに出る */
  chars: number;
  /** enabled なのに subject が解決できず、永久に注入されない件数 */
  orphan_subject: number;
}

/** 整理案。Claude に作らせて貼り付ける */
export interface MemoryPlan {
  format?: string;
  version?: number;
  memories?: {
    disable?: string[];
    enable?: string[];
    delete?: string[];
    update?: { id?: string; content?: string; subject?: string; pinned?: number }[];
    create?: { character_id?: string; subject?: string; content?: string; pinned?: number }[];
  };
  lorebook?: {
    create?: Partial<LorebookEntry>[];
    update?: (Partial<LorebookEntry> & { id?: string })[];
  };
}

export type PlanOp = 'disable' | 'enable' | 'delete' | 'update' | 'create';

/** プレビュー・適用の1行。**IDではなく中身を返す**（何が消えるか読めないと確認にならない） */
export interface PlanRow {
  op: PlanOp;
  kind: 'memory' | 'lore';
  /** create のときは空（まだIDが無い） */
  id: string;
  character_name: string;
  /** ロアのときだけ入る */
  title: string;
  content: string;
  /** 落とした値・注意点。無ければ空文字 */
  note: string;
}

export interface PlanResult {
  rows: PlanRow[];
  warnings: string[];
  stats: { before: MemoryReviewStats; after: MemoryReviewStats };
  /** apply のときだけ。適用した件数 */
  applied?: { memories: number; lorebook: number };
}

// ---- 設定（§12） ----

/**
 * スナップショットの一覧用（§21）。
 * **画像本体（BLOB）を含まない。** JSONに載せると会話の読み込みが一気に重くなる。
 * 実体は GET /api/snapshots/:id/image でバイナリ配信する
 */
export interface SnapshotMeta {
  id: string;
  chat_id: string;
  message_id: string;
  prompt: string;
  model: string;
  mime: string;
  bytes: number;
  /**
   * 一覧用の縮小版の大きさ（§21.9）。**0なら未作成**で、表示側は原寸に落ちる。
   * 実体は GET /api/snapshots/:id/thumb
   */
  thumb_bytes: number;
  created_at: number;
}

/**
 * 参照用の高画質画像（§21.4）。**画像本体（BLOB）を含まない。**
 * 実体は GET /api/references/:id/image でバイナリ配信する。
 * 差し替えるたびに `id` が変わるので、URLをそのままキャッシュキーにできる
 */
export interface ReferenceMeta {
  id: string;
  character_id: string | null;
  persona_id: string | null;
  mime: string;
  bytes: number;
  created_at: number;
}

/** アルバムの入口（§21.8）。1枚も無い世界は含まれない */
export interface AlbumWorld {
  world_id: string;
  world_name: string;
  count: number;
  bytes: number;
}

/** アルバムの1枚。会話ごとに見出しを付けるため、会話名とseqを添える */
export interface AlbumItem extends SnapshotMeta {
  chat_title: string;
  seq: number;
}

export interface Settings {
  system_prompt: string;
  max_tokens: number;
  context_safety_tokens: number;
  fallback_context_length: number;
  default_model: string;
  utility_model: string;
  /**
   * 要約・知識抽出の1回あたりの出力上限（トークン）。
   * 本文生成の max_tokens とは別枠。推論（thinking）を行うモデルは
   * 考えている分もここから引かれるため、切れるようなら増やす。
   */
  utility_max_tokens: number;
  /**
   * スナップショット（画像生成、§21）で使うモデル。
   * **空なら機能そのものを無効。** 知らないうちに課金させないため既定は空
   */
  image_model: string;
  /** 画風の共通プレフィックス。全スナップショットの先頭に付く */
  image_style_prompt: string;
  image_aspect_ratio: string;
  /** low / medium / high。対応しないモデルでは無視される */
  image_quality: string;
  /**
   * 画面に文字を描かせない指示を末尾に付けるか（既定ON）。
   * 地の文をそのまま渡すため、指示が無いと看板・書類・字幕といった形で
   * 文字を描き込むことがある。意図して描かせたい世界ではOFFにする
   */
  image_no_text: number;
  auto_summarize: number;
  summary_interval: number;
  summary_max_chars: number;
  /**
   * 要約の方針（何を残し・何を落とし・どう書くか）。
   * アプリ側の制約（統合・人物設定を含めない・日付・文字数）は別途固定で付くので、
   * ここには「取捨選択と文体」だけを書く。
   */
  summary_policy: string;
  auto_extract: number;
  lore_recursion: number;
  lore_scan_window: number;
  lore_budget_chars: number;
  autoplay_steps: number;
  autoplay_judge: number;
  state_enabled: number;
  state_extraction_mode: 'fenced' | 'separate_call';
  history_window: number;
  active_persona_id: string;
  /** 条件付きイベントの判定と注入（v1.5.3 §1.1） */
  events_enabled: number;
  /** 進行フラグの注入と更新 */
  vars_enabled: number;
  /** 1ターンに注入するイベントの上限件数 */
  event_max_per_turn: number;
}

// ---- API リクエスト/レスポンス ----

/** POST /api/chats/:id/messages のボディ（§5.6、4種は排他） */
export type GenerateRequest =
  | { content: string }
  | { regenerate: true }
  | { retry: true }
  | { autoContinue: true };

/** SSEイベント（§5.3） */
export interface SseDone {
  messageId: string;
  content: string;
  utterances: Utterance[];
  state: ChatState;
  gameTime: GameTime;
  needsSummary: boolean;
  firedEvents: string[];
}

export interface ChatDetail {
  chat: Chat;
  messages: Message[];
  gameTime: GameTime;
  /** 表示中メッセージの state_delta 生ログ等のデバッグ用に必要なら個別取得 */
}

export interface PromptPreview {
  system: string;
  historyMessages: { role: string; content: string }[];
  situationBlock: string;
  lore: {
    fired: { id: string; title: string }[];
    adopted: { id: string; title: string }[];
    dropped: { id: string; title: string }[];
  };
  estimatedTokens: number;
  inputBudget: number;
  trimmed: { history: number; lore: number; memories: number };
}

export interface ConfigResponse {
  appTitle: string;
  authRequired: boolean;
  defaultModel: string;
  utilityModel: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  context_length: number;
}

/** モデル選択に出す候補（チャットヘッダー・設定で共通利用） */
export interface CuratedModel {
  id: string;
  label: string;
}

/**
 * 「HH:MM」表記を0時からの分に直す。解釈できなければ null。
 *
 * 日本語キーボードでは全角の「：」が既定なので、半角コロンだけを受け付けると
 * 入力が黙って無効化される（時刻が消えて「保存できない」ように見える）。
 * 全角・時分表記・区切り無しも受け取る。
 *
 *   09:00 / 9:00 / ０９：００ / 09：00 / 900 / 9 / 9時 / 18時30分 → 可
 *
 * 時は24を超えてよい（閉店26:00 = 翌2時）。分は0〜59まで。
 */
export function parseHhmm(input: string): number | null {
  const s = String(input ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：．.]/g, ':')
    .replace(/時/g, ':')
    .replace(/分/g, '')
    .replace(/\s/g, '');
  if (!s) return null;
  const at = (h: number, m: number): number | null =>
    m > 59 || h > 47 ? null : h * 60 + m;

  let m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m) return at(+m[1], +m[2]);
  m = /^(\d{1,2}):$/.exec(s); // 「9時」
  if (m) return at(+m[1], 0);
  m = /^(\d{1,2})$/.exec(s); // 「9」「18」
  if (m) return at(+m[1], 0);
  m = /^(\d{1,2})(\d{2})$/.exec(s); // 「900」「1830」
  if (m) return at(+m[1], +m[2]);
  return null;
}

/**
 * 会話の表示名（§3.5）。**付けた名前 → 先頭の参加キャラの名前 → 既定** の順。
 *
 * `chats.title` は**利用者が付けたときだけ**入る。最初の発言から自動で埋めるのを
 * やめたので、未設定はごく普通の状態になる。home・チャット画面・アルバムで
 * 呼び名がずれると同じ会話だと分からなくなるため、決め方はここに1つだけ置く。
 */
export function chatDisplayName(title: string, characterName?: string): string {
  return title.trim() || characterName?.trim() || '(無題の会話)';
}

/** 地の文の強調記号（* や _ で囲む書き方）を外す */
export function stripMarks(s: string): string {
  return s
    .replace(/\*+/g, '')
    .replace(/(^|[\s「（(])_(?=\S)|(?<=\S)_(?=[\s」）)、。,.!?！？]|$)/g, '$1');
}

/**
 * 本文を「」の中身（セリフ `dlg`）とそれ以外（地の文 `act`）に分ける。
 *
 * **表示（ChatPage の `BubbleText`）とスナップショットのプロンプト
 * （server/src/domain/snapshot.ts）が同じ規則を使うためにここへ置いている。**
 * このアプリのキャラ発話はセリフと地の文が同じ塊に入るので、
 * 話者では分けられない:
 *
 * ```
 * ノア: 「……補修図です。」ノアは腰を屈め、囲みの中を目で数えた。
 * ```
 *
 * 片方だけ直すと「画面には見えているのに絵の指示には入っていない」という
 * 追いにくい食い違いになる。規則を変えるときは必ずここを直すこと。
 *
 * 閉じていない `「` で終わる場合も、そこから末尾までをセリフとして扱う（`」?`）。
 * `「」` そのものは結果に含めない。
 */
export function splitDialogue(text: string): { dlg: boolean; text: string }[] {
  const t = stripMarks(text);
  const parts: { dlg: boolean; text: string }[] = [];
  const re = /「[^」]*」?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m.index > last) {
      const a = t.slice(last, m.index).trim();
      if (a) parts.push({ dlg: false, text: a });
    }
    const d = m[0].replace(/^「/, '').replace(/」$/, '').trim();
    if (d) parts.push({ dlg: true, text: d });
    last = re.lastIndex;
  }
  if (last < t.length) {
    const a = t.slice(last).trim();
    if (a) parts.push({ dlg: false, text: a });
  }
  return parts;
}

/** 分を「HH:MM」に戻す。null は空文字 */
export function formatHhmm(min: number | null | undefined): string {
  if (min == null) return '';
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * 直近これだけは要約せず生のまま残す件数。
 * summary_interval に比例させる。固定値にすると interval が小さいときに
 * retain が interval を食い尽くし、毎ターン要約になる。
 */
export function retainWindow(unsummarized: number, interval: number): number {
  const half = Math.min(24, Math.max(2, Math.floor(interval / 2)));
  return Math.max(1, Math.min(half, unsummarized - 2));
}

/** 設定値から、実際に何メッセージごとに要約が走るかを求める */
export function summarizeEveryMessages(interval: number): number {
  return Math.max(2, interval - retainWindow(interval, interval));
}

export const CURATED_MODELS: CuratedModel[] = [
  { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'anthropic/claude-fable-5', label: 'Claude Fable 5' },
  { id: 'openai/gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { id: 'x-ai/grok-4.6', label: 'Grok 4.6' },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
  { id: 'z-ai/glm-5.3', label: 'GLM-5.3' },
  { id: 'qwen/qwen3.7-plus', label: 'Qwen3.7 Plus' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B' },
];

/** モデルIDを短い表示名にする。未知のIDはスラッシュ以降をそのまま出す */
export function modelLabel(id: string): string {
  if (!id) return '既定';
  const found = CURATED_MODELS.find((m) => m.id === id);
  const label = found ? found.label : id.split('/').pop()!;
  return label.replace(/^Claude\s+/i, '');
}
