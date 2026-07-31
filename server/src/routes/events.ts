import { Router } from 'express';
import type { VarSchemaEntry, WorldEvent } from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
import { getChat } from '../db/repo/chats.js';
import {
  createEvent,
  deleteEvent,
  firesOf,
  getEvent,
  listEvents,
  updateEvent,
} from '../db/repo/events.js';
import { listLocations } from '../db/repo/locations.js';
import { getScenario } from '../db/repo/scenarios.js';
import { getSettings, resolveFlag } from '../db/repo/settings.js';
import { getWorld } from '../db/repo/worlds.js';
import { runEventPipeline } from '../domain/events.js';
import { visitIdOf } from './messages.js';

export const eventsRouter = Router();

eventsRouter.get('/worlds/:id/events', (req, res) => {
  const events = listEvents(req.params.id);
  res.json(events);
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

/**
 * フェーズ遷移の欠落チェック（v1.5.3 §4.2・§9.1）。
 * update_mode = system_only の phase変数はモデルが進められないため、
 * 各値へ遷移させる critical イベントが無いと事件が途中で止まる。
 */
function missingPhaseTransitions(
  schema: VarSchemaEntry[],
  events: WorldEvent[],
): { key: string; label: string; missing: { value: number; name: string }[] }[] {
  const out: ReturnType<typeof missingPhaseTransitions> = [];
  for (const entry of schema) {
    if ((entry.role ?? 'flag') !== 'phase' || !entry.phases?.length) continue;
    const missing = entry.phases
      .filter((p) => {
        // 初期値へは遷移不要
        if (p.value === (entry.default ?? 0)) return false;
        return !events.some(
          (e) =>
            e.enabled === 1 &&
            e.set_vars.some(
              (op) => op.key === entry.key && op.op === 'set' && Number(op.value) === p.value,
            ),
        );
      })
      .map((p) => ({ value: p.value, name: p.name }));
    if (missing.length) out.push({ key: entry.key, label: entry.label || entry.key, missing });
  }
  return out;
}

eventsRouter.get('/worlds/:id/events/phase-check', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.json({ missing: missingPhaseTransitions(world.vars_schema, listEvents(world.id)) });
});

/**
 * 「現在のチャットで評価」（v1.5.3 §9.1）。
 * 選んだチャットの現在ステートで when / check / trigger / 抽選を回して結果を返す。
 * 記録も state の書き換えもしない。
 */
eventsRouter.post('/worlds/:id/events/evaluate', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const chat = getChat(String(req.body?.chat_id ?? ''));
  if (!chat || chat.world_id !== world.id) {
    res.status(404).json({ error: 'この世界のチャットを指定してください' });
    return;
  }
  const settings = getSettings();
  const scenario = chat.scenario_id ? getScenario(chat.scenario_id) : null;
  const events = listEvents(world.id);
  const result = runEventPipeline({
    chatId: chat.id,
    events,
    baseState: chat.state,
    newState: chat.state,
    calendar: getCalendar(world.id),
    locations: listLocations(world.id),
    varsSchema: world.vars_schema,
    varsEnabled: resolveFlag(chat.vars_enabled, scenario?.vars_enabled, settings.vars_enabled),
    baseMessageId: `${chat.id}:preview`,
    visitId: visitIdOf(chat.id, chat.state),
    firesByEvent: new Map(events.map((e) => [e.id, firesOf(chat.id, e.id)])),
    maxPerTurn: Math.max(1, settings.event_max_per_turn),
  });
  res.json({ rows: result.rows, state: chat.state });
});
