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
  const world = updateWorld(req.params.id, req.body ?? {});
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.json(world);
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
