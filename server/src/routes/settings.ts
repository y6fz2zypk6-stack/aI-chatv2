import { Router } from 'express';
import { getSettings, updateSettings } from '../db/repo/settings.js';
import { listModels } from '../llm/openrouter.js';

export const settingsRouter = Router();

settingsRouter.get('/settings', (_req, res) => {
  res.json(getSettings());
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

settingsRouter.get('/models', async (_req, res) => {
  try {
    res.json(await listModels());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
