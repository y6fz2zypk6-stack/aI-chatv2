import { Router } from 'express';
import {
  createLorebookEntry,
  deleteLorebookEntry,
  getLorebookEntry,
  listLorebook,
  updateLorebookEntry,
} from '../db/repo/lorebook.js';
import { getWorld } from '../db/repo/worlds.js';
import { v2EntryToLore } from './characters.js';

export const lorebookRouter = Router();

lorebookRouter.get('/worlds/:id/lorebook', (req, res) => {
  res.json(listLorebook(req.params.id));
});

lorebookRouter.post('/worlds/:id/lorebook', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.status(201).json(createLorebookEntry(req.params.id, req.body ?? {}));
});

lorebookRouter.put('/lorebook/:id', (req, res) => {
  const e = updateLorebookEntry(req.params.id, req.body ?? {});
  if (!e) {
    res.status(404).json({ error: 'エントリが見つかりません' });
    return;
  }
  res.json(e);
});

lorebookRouter.delete('/lorebook/:id', (req, res) => {
  if (!getLorebookEntry(req.params.id)) {
    res.status(404).json({ error: 'エントリが見つかりません' });
    return;
  }
  deleteLorebookEntry(req.params.id);
  res.json({ ok: true });
});

// ---- V2 character_book 取り込み（§8.8）----
// { entries: [...] } 形式（V2 character_book）と、エントリ配列の両方を受け付ける
lorebookRouter.post('/worlds/:id/lorebook/import', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const body = req.body ?? {};
  const entries = Array.isArray(body) ? body : Array.isArray(body.entries) ? body.entries : null;
  if (!entries) {
    res.status(400).json({ error: 'entries 配列が見つかりません（V2 character_book 形式）' });
    return;
  }
  let count = 0;
  for (const e of entries) {
    createLorebookEntry(req.params.id, v2EntryToLore(e));
    count++;
  }
  res.status(201).json({ imported: count });
});

// ---- 書き出し（V2 character_book。拡張は extensions.character_chat）----
lorebookRouter.get('/worlds/:id/lorebook/export', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const entries = listLorebook(world.id).map((e, i) => ({
    keys: e.keys,
    content: e.content,
    enabled: e.enabled === 1,
    constant: e.always === 1,
    insertion_order: e.priority,
    name: e.title,
    id: i,
    extensions: { character_chat: { category: e.category } },
  }));
  const filename = `${world.name}_lorebook.json`;
  // RFC 5987 でエンコードし日本語を落とさない（§8.8）
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="lorebook.json"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.json({ entries });
});
