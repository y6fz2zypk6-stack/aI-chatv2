import { Router } from 'express';
import { fallbackPersona } from '../db/repo/chats.js';
import {
  createPersona,
  deletePersona,
  getDefaultPersona,
  getPersona,
  listPersonas,
  updatePersona,
} from '../db/repo/personas.js';

export const personasRouter = Router();

personasRouter.get('/personas', (_req, res) => {
  res.json(listPersonas());
});

personasRouter.post('/personas', (req, res) => {
  res.status(201).json(createPersona(req.body ?? {}));
});

personasRouter.put('/personas/:id', (req, res) => {
  const p = updatePersona(req.params.id, req.body ?? {});
  if (!p) {
    res.status(404).json({ error: 'ペルソナが見つかりません' });
    return;
  }
  res.json(p);
});

// §8.9: 参照チャットは既定ペルソナへフォールバックさせた上で削除可
personasRouter.delete('/personas/:id', (req, res) => {
  const p = getPersona(req.params.id);
  if (!p) {
    res.status(404).json({ error: 'ペルソナが見つかりません' });
    return;
  }
  const others = listPersonas().filter((x) => x.id !== p.id);
  const fallback = others.find((x) => x.is_default === 1) ?? others[0] ?? null;
  fallbackPersona(p.id, fallback?.id ?? null);
  deletePersona(p.id);
  res.json({ ok: true, fallback_id: fallback?.id ?? null });
});
