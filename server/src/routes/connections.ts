import { Router } from 'express';
import type { ConnectionView } from '../../../shared/types.js';
import {
  connectionUsage,
  createConnection,
  deleteConnection,
  getConnectionSecret,
  listConnections,
  normalizeBaseUrl,
  updateConnection,
  type ConnectionSecret,
} from '../db/repo/connections.js';
import { clearModelCache, listModels } from '../llm/openrouter.js';
import { BUILTIN_NAME, builtinConnection } from '../llm/provider.js';

export const connectionsRouter = Router();

/**
 * 接続先（§6.6）。
 *
 * **`api_key` をレスポンスに載せない**のがこのファイルの唯一かつ最重要の約束
 * （不変条件43）。キー入りの行は `ConnectionSecret` 型でしか触らず、
 * 外へ出す前に必ず `toView` を通す。
 */
function toView(c: ConnectionSecret): ConnectionView {
  const { api_key, ...rest } = c;
  return {
    ...rest,
    has_key: api_key.length > 0,
    // 取り違えを見分けられる最小限だけ。伏せ字は固定長にせず末尾4文字だけ見せる
    key_hint: api_key ? `••••${api_key.slice(-4)}` : '',
    builtin: false,
    in_use: connectionUsage(c.id).length > 0,
  };
}

/** 組み込み（.env）も同じ形で一覧に並べる。編集も削除もできない */
function builtinView(): ConnectionView {
  const b = builtinConnection();
  return {
    id: '',
    name: BUILTIN_NAME,
    base_url: b.baseUrl,
    context_length: 0,
    created_at: 0,
    updated_at: 0,
    has_key: b.apiKey.length > 0,
    key_hint: b.apiKey ? `••••${b.apiKey.slice(-4)}` : '',
    builtin: true,
    in_use: true,
  };
}

connectionsRouter.get('/connections', (_req, res) => {
  res.json([builtinView(), ...listConnections().map(toView)]);
});

/** `http(s)://` 以外は受けない。打ち間違いを生成のときまで持ち越さない */
function badUrl(url: string): string {
  if (!url) return 'ベースURLを入力してください';
  if (!/^https?:\/\//i.test(url)) return 'ベースURLは http:// か https:// で始めてください';
  return '';
}

connectionsRouter.post('/connections', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  const url = normalizeBaseUrl(body.base_url);
  if (!name) {
    res.status(400).json({ error: '名前を入力してください' });
    return;
  }
  const urlError = badUrl(url);
  if (urlError) {
    res.status(400).json({ error: urlError });
    return;
  }
  res.status(201).json(toView(createConnection({ ...body, name, base_url: url })));
});

connectionsRouter.put('/connections/:id', (req, res) => {
  const id = req.params.id;
  if (!id || !getConnectionSecret(id)) {
    res.status(404).json({ error: '接続先が見つかりません' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.base_url !== undefined) {
    const urlError = badUrl(normalizeBaseUrl(body.base_url));
    if (urlError) {
      res.status(400).json({ error: urlError });
      return;
    }
  }
  if (body.name !== undefined && !String(body.name).trim()) {
    res.status(400).json({ error: '名前を入力してください' });
    return;
  }
  const next = updateConnection(id, body as Partial<ConnectionSecret>);
  // URLやキーを変えたら、前の接続先で引いたモデル一覧は捨てる
  clearModelCache(id);
  res.json(toView(next!));
});

connectionsRouter.delete('/connections/:id', (req, res) => {
  const id = req.params.id;
  if (!id || !getConnectionSecret(id)) {
    res.status(404).json({ error: '接続先が見つかりません' });
    return;
  }
  // **使用中なら消させない。** 消すと参照していたチャットが壊れた状態で残り、
  // 生成しようとして初めて気づくことになる
  const usage = connectionUsage(id);
  if (usage.length > 0) {
    res.status(409).json({
      error: `使用中のため削除できません（${usage.slice(0, 5).join('、')}${usage.length > 5 ? ` ほか${usage.length - 5}件` : ''}）。先に別の接続先へ切り替えてください`,
      usage,
    });
    return;
  }
  deleteConnection(id);
  clearModelCache(id);
  res.json({ ok: true });
});

/**
 * 疎通確認。**ベースURLの打ち間違いが一番多い失敗**で、生成のときに初めて分かるのでは遅い。
 * 例外にせず、成否を本文で返す（画面がそのまま出せる形）。
 */
connectionsRouter.post('/connections/:id/test', async (req, res) => {
  const id = req.params.id ?? '';
  if (id && !getConnectionSecret(id)) {
    res.status(404).json({ error: '接続先が見つかりません' });
    return;
  }
  clearModelCache(id);
  try {
    const models = await listModels(id);
    res.json({ ok: true, count: models.length, message: `接続できました（モデル${models.length}件）` });
  } catch (err) {
    res.json({ ok: false, count: 0, message: (err as Error).message });
  }
});

connectionsRouter.get('/connections/:id/models', async (req, res) => {
  const id = req.params.id ?? '';
  if (id && !getConnectionSecret(id)) {
    res.status(404).json({ error: '接続先が見つかりません' });
    return;
  }
  try {
    res.json(await listModels(id));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
