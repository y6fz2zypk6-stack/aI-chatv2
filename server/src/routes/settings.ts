import { Router } from 'express';
import { CURATED_MODELS, modelLabel, parseModelRef, type ResolvedModel } from '../../../shared/types.js';
import { listResolvedModels } from '../db/repo/resolvedModels.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../db/repo/settings.js';
import { listModels } from '../llm/openrouter.js';
import { listImageModels } from '../llm/image.js';

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
    // スナップショットの入口を出すかの判断だけに使う（§21）。
    // モデル名そのものは画面に要らないので配らない
    imageEnabled: Boolean(s.image_model.trim()),
  });
});

// 画像モデルの一覧（設定画面の補完用）。これが無いと image_model が完全な手打ちになる。
// ?connection= で接続先を指定できる（省略時は組み込み）
settingsRouter.get('/images/models', async (req, res) => {
  try {
    res.json(await listImageModels(String(req.query.connection ?? '')));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// 選択候補（モデルピル・設定のプルダウン用）。OpenRouterに繋がらなくても返せる
settingsRouter.get('/models/curated', (_req, res) => {
  res.json(CURATED_MODELS);
});

/**
 * 実際に答えた版の短い表示名。候補にあればその名前、無ければ接続先のモデル一覧の名前
 * （「Anthropic: Claude Opus 5.6」→「Opus 5.6」）、それも無ければIDの末尾
 */
async function servedLabel(ref: string, model: string): Promise<string> {
  if (CURATED_MODELS.some((m) => m.id === model)) return modelLabel(model);
  try {
    const info = (await listModels(parseModelRef(ref).connectionId)).find((m) => m.id === model);
    if (info?.name && info.name !== info.id) {
      return info.name.replace(/^[^:]+:\s*/, '').replace(/^Claude\s+/i, '');
    }
  } catch {
    // 一覧が引けなくてもIDから作れる
  }
  return model.split('/').pop() || model;
}

// 「最新」の名前（§6.6）ごとに、実際に答えた版。画面の「いまは Opus 5.5」に使う
settingsRouter.get('/models/resolved', async (_req, res) => {
  const out: Record<string, ResolvedModel> = {};
  for (const r of listResolvedModels()) {
    out[r.ref] = { model: r.model, label: await servedLabel(r.ref, r.model), updated_at: r.updated_at };
  }
  res.json(out);
});

// 全モデル一覧（設定画面の自由入力の補完用）。?connection= で接続先を指定できる
settingsRouter.get('/models', async (req, res) => {
  try {
    res.json(await listModels(String(req.query.connection ?? '')));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
