import { db } from '../index.js';
import type { Settings } from '../../../../shared/types.js';

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
  auto_summarize: 1,
  summary_interval: 32,
  summary_max_chars: 500,
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
};

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
