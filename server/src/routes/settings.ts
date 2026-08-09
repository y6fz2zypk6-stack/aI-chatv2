import { Router } from 'express';
import { CURATED_MODELS } from '../../../shared/types.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../db/repo/settings.js';
import { listModels } from '../llm/openrouter.js';

export const settingsRouter = Router();

settingsRouter.get('/settings', (_req, res) => {
  res.json(getSettings());
});

// 既定値。設定画面の「既定に戻す」で使う（副作用は無い）
settingsRouter.get('/settings/defaults', (_req, res) => {
  res.json(DEFAULT_SETTINGS);
});

settingsRouter.put('/settings', (req, res) => {
  res.json(updateSettings(req.body ?? {}));
});

settingsRouter.get('/config', (_req, res) => {
  const s = getSettings();
  res.json({
    appTitle: process.env.APP_TITLE || 'Character Chat',
    authRequired: !!process.env.APP_PASSWORD,
    defaultModel: s.default_model,
    utilityModel: s.utility_model,
  });
});

// 選択候補（モデルピル・設定のプルダウン用）。OpenRouterに繋がらなくても返せる
settingsRouter.get('/models/curated', (_req, res) => {
  res.json(CURATED_MODELS);
});

// OpenRouterの全モデル一覧（設定画面の自由入力の補完用）
settingsRouter.get('/models', async (_req, res) => {
  try {
    res.json(await listModels());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
