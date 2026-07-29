import { Router } from 'express';
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  updateEvent,
} from '../db/repo/events.js';
import { getWorld } from '../db/repo/worlds.js';

export const eventsRouter = Router();

eventsRouter.get('/worlds/:id/events', (req, res) => {
  res.json(listEvents(req.params.id));
});

eventsRouter.post('/worlds/:id/events', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.status(201).json(createEvent(req.params.id, req.body ?? {}));
});

eventsRouter.put('/events/:id', (req, res) => {
  const e = updateEvent(req.params.id, req.body ?? {});
  if (!e) {
    res.status(404).json({ error: 'イベントが見つかりません' });
    return;
  }
  res.json(e);
});

// §8.9: WorldEvent は参照されないため無条件で削除可（発火履歴はCASCADE）
eventsRouter.delete('/events/:id', (req, res) => {
  if (!getEvent(req.params.id)) {
    res.status(404).json({ error: 'イベントが見つかりません' });
    return;
  }
  deleteEvent(req.params.id);
  res.json({ ok: true });
});
