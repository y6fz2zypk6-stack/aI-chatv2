import { db } from '../index.js';
import type { Settings } from '../../../../shared/types.js';

/**
 * 要約の方針の既定値。
 * 「何を残すか」だけでなく **「何を落とすか」** を必ず書くこと。
 * 落とす基準が無いと、モデルは文を詰めることでしか短くできず、
 * 接続詞で繋いだ列挙（＝冗漫なあらすじ）になる。
 */
export const DEFAULT_SUMMARY_POLICY = `# 何を残すか
- 関係の変化（距離感・呼び方・態度が変わった瞬間）
- 交わした約束と、その履行・破棄
- 進行中の仕事・研究・調査の進捗
- 感情の転機となった場面
- 未解決の事柄、開いたままの問い
- 今後の予定、約束された日時

# 何を落とすか
- 雑談。ただし関係や物語が動いたものは残す
- 移動・飲食などの日常動作。それ自体に意味がある場合を除く
- 感情の機微の描写。転機になっていないもの

# 書き方
- 美文を避け、情報密度を優先する。事実を淡々と書く
- 地の文の言い回しを再現しようとしない
- 次の見出しで区切る

## 経緯
[日付] 起きたこと（時系列）

## 約束・予定
## 未解決`;

/** §12 の既定値 */
export const DEFAULT_SETTINGS: Settings = {
  system_prompt:
    'あなたは登場人物を演じる熟練のロールプレイヤーであり、同時に情景を紡ぐ小説家である。\n' +
    '日本語の自然な小説形式で、キャラクターの人格・口調を一貫して保ちながら応答すること。\n' +
    '過度に話を先に進めず、ユーザーの行動の余地を残すこと。',
  max_tokens: 2048,
  context_safety_tokens: 1024,
  fallback_context_length: 32768,
  default_model: process.env.DEFAULT_MODEL || 'anthropic/claude-opus-5',
  utility_model: process.env.UTILITY_MODEL || 'anthropic/claude-sonnet-5',
  // 要約・抽出の出力上限。本文生成の max_tokens とは別枠。
  // 推論を行うモデルは考えている分もここから引かれるので、2048だと切れることがある
  utility_max_tokens: 8192,
  // スナップショット（§21）。**既定は空＝機能そのものが無効。**
  // 画像生成は本文より高くつくので、知らないうちに課金させない
  image_model: '',
  image_style_prompt: '',
  image_aspect_ratio: '16:9',
  image_quality: 'medium',
  image_no_text: 1,
  auto_summarize: 1,
  summary_interval: 32,
  summary_max_chars: 700,
  summary_policy: DEFAULT_SUMMARY_POLICY,
  auto_extract: 0,
  lore_recursion: 1,
  lore_scan_window: 8,
  lore_budget_chars: 12000,
  autoplay_steps: 3,
  autoplay_judge: 1,
  state_enabled: 1,
  state_extraction_mode: 'fenced',
  history_window: 48,
  active_persona_id: '',
  events_enabled: 1,
  vars_enabled: 0,
  event_max_per_turn: 2,
};

/**
 * 有効化スイッチの3段解決（v1.5.3 §1.1）。
 * チャットの値 → シナリオの値 → 全体設定 の順に、先に見つかった非NULLを採用する。
 */
export function resolveFlag(
  chatValue: number | null | undefined,
  scenarioValue: number | null | undefined,
  globalValue: number,
): boolean {
  if (chatValue !== null && chatValue !== undefined) return chatValue === 1;
  if (scenarioValue !== null && scenarioValue !== undefined) return scenarioValue === 1;
  return globalValue === 1;
}

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      stored[r.key] = r.value;
    }
  }
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      stmt.run(key, JSON.stringify(value));
    }
  });
  tx();
  return getSettings();
}
