import { Router } from 'express';
import { chatsUsingLocation } from '../db/repo/chats.js';
import { getCalendar, upsertCalendar } from '../db/repo/calendars.js';
import {
  createLocation,
  deleteLocation,
  getLocation,
  listLocations,
  updateLocation,
} from '../db/repo/locations.js';
import { removeLocationFromLorebook } from '../db/repo/lorebook.js';
import { listScenarios } from '../db/repo/scenarios.js';
import { getWorld } from '../db/repo/worlds.js';

export const locationsRouter = Router();

locationsRouter.get('/worlds/:id/locations', (req, res) => {
  res.json(listLocations(req.params.id));
});

locationsRouter.post('/worlds/:id/locations', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const id = String(req.body?.id ?? '').trim();
  if (!/^[a-z0-9_]+$/.test(id)) {
    res.status(400).json({ error: 'IDは英小文字・数字・アンダースコアで指定してください（例: vein_bookstore）' });
    return;
  }
  if (getLocation(id)) {
    res.status(409).json({ error: 'このIDは既に使われています' });
    return;
  }
  res.status(201).json(createLocation(req.params.id, { ...req.body, id }));
});

locationsRouter.put('/locations/:id', (req, res) => {
  const l = updateLocation(req.params.id, req.body ?? {});
  if (!l) {
    res.status(404).json({ error: '場所が見つかりません' });
    return;
  }
  res.json(l);
});

// §8.9: chats.state.location / scenarios.initial_state で使用中なら削除不可
locationsRouter.delete('/locations/:id', (req, res) => {
  const loc = getLocation(req.params.id);
  if (!loc) {
    res.status(404).json({ error: '場所が見つかりません' });
    return;
  }
  const chatRefs = chatsUsingLocation(loc.id);
  const scenarioRefs = listScenarios(loc.world_id).filter(
    (s) => s.initial_state.location === loc.id,
  );
  if (chatRefs.length || scenarioRefs.length) {
    const names = [
      ...chatRefs.map((c) => `チャット「${c.title}」`),
      ...scenarioRefs.map((s) => `シナリオ「${s.title}」`),
    ];
    res.status(409).json({ error: `使用中のため削除できません: ${names.join('、')}` });
    return;
  }
  removeLocationFromLorebook(loc.id);
  deleteLocation(loc.id);
  res.json({ ok: true });
});

// ---- 暦（§4.12）----

locationsRouter.get('/worlds/:id/calendar', (req, res) => {
  res.json(getCalendar(req.params.id));
});

locationsRouter.put('/worlds/:id/calendar', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.json(upsertCalendar(req.params.id, req.body ?? {}));
});
