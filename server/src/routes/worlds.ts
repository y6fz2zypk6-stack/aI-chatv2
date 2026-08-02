import { Router } from 'express';
import {
  createWorld,
  deleteWorld,
  getWorld,
  listWorlds,
  updateWorld,
  worldUsage,
} from '../db/repo/worlds.js';
import { ensureCalendar } from '../db/repo/calendars.js';
import { listLocations } from '../db/repo/locations.js';
import { AREA_ID_RE, type WorldArea } from '../../../shared/types.js';

export const worldsRouter = Router();

worldsRouter.get('/worlds', (_req, res) => {
  res.json(listWorlds());
});

worldsRouter.post('/worlds', (req, res) => {
  const world = createWorld(req.body ?? {});
  ensureCalendar(world.id);
  res.status(201).json(world);
});

worldsRouter.get('/worlds/:id', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.json({ ...world, usage: worldUsage(world.id) });
});

worldsRouter.put('/worlds/:id', (req, res) => {
  // エリアは参照整合の確認が要るので、専用ルートからだけ変更できるようにする
  const { areas: _areas, ...patch } = (req.body ?? {}) as Record<string, unknown>;
  const world = updateWorld(req.params.id, patch);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.json(world);
});

/**
 * エリアの並び替え・表示名変更・追加・削除。
 * id は locations.area とイベント条件から参照されるので、既存の id は変更できない。
 * 使用中のエリアを消そうとした場合は、使っている場所を挙げて拒否する。
 */
worldsRouter.put('/worlds/:id/areas', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const input = req.body?.areas;
  if (!Array.isArray(input)) {
    res.status(400).json({ error: 'areas は配列で送ってください' });
    return;
  }
  const areas: WorldArea[] = [];
  const seen = new Set<string>();
  for (const raw of input as Partial<WorldArea>[]) {
    const id = String(raw?.id ?? '').trim();
    if (!AREA_ID_RE.test(id)) {
      res.status(400).json({ error: `エリアIDが不正です: ${id || '(空)'}（英小文字で始まる英数字と _）` });
      return;
    }
    if (seen.has(id)) {
      res.status(400).json({ error: `エリアIDが重複しています: ${id}` });
      return;
    }
    seen.add(id);
    areas.push({ id, name: String(raw?.name ?? '').trim() || id });
  }

  const locations = listLocations(world.id);
  const orphaned = locations.filter((l) => l.area && !seen.has(l.area));
  if (orphaned.length) {
    const names = orphaned.slice(0, 5).map((l) => l.name).join('、');
    res.status(400).json({
      error: `${orphaned[0].area} は ${names}${orphaned.length > 5 ? ' ほか' : ''} が使用中です。先に場所のエリアを変えてください`,
    });
    return;
  }

  res.json(updateWorld(world.id, { areas }));
});

// §8.9: 配下一式の件数はGETの usage で確認し、承認後にCASCADE
worldsRouter.delete('/worlds/:id', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  deleteWorld(world.id);
  res.json({ ok: true });
});
