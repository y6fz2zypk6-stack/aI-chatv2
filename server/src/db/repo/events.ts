import { db, now, fromJson, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';

export interface EventCondition {
  season?: string;
  month?: number;
  week?: number;
  weekday?: string;
  time_after?: string;
  time_before?: string;
  location?: string;
  location_area?: string;
  weather?: string;
}

export interface WorldEvent {
  id: string;
  world_id: string;
  title: string;
  condition: EventCondition;
  trigger: 'once' | 'once_per_year' | 'cooldown';
  cooldown_days: number;
  inject: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface Row extends Omit<WorldEvent, 'condition'> {
  condition: string;
}

function toApi(row: Row): WorldEvent {
  return { ...row, condition: fromJson<EventCondition>(row.condition, {}) };
}

export function listEvents(worldId: string): WorldEvent[] {
  const rows = db
    .prepare('SELECT * FROM world_events WHERE world_id = ? ORDER BY created_at ASC')
    .all(worldId) as Row[];
  return rows.map(toApi);
}

export function getEvent(id: string): WorldEvent | undefined {
  const row = db.prepare('SELECT * FROM world_events WHERE id = ?').get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

export function createEvent(worldId: string, input: Partial<WorldEvent>): WorldEvent {
  const t = now();
  const e: WorldEvent = {
    id: ulid(),
    world_id: worldId,
    title: input.title || '新しいイベント',
    condition: input.condition ?? {},
    trigger: input.trigger ?? 'once',
    cooldown_days: input.cooldown_days ?? 0,
    inject: input.inject || '',
    enabled: input.enabled ?? 1,
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO world_events (id, world_id, title, condition, trigger, cooldown_days, inject, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id, e.world_id, e.title, toJson(e.condition), e.trigger, e.cooldown_days, e.inject,
    e.enabled, e.created_at, e.updated_at,
  );
  return e;
}

export function updateEvent(id: string, patch: Partial<WorldEvent>): WorldEvent | undefined {
  const cur = getEvent(id);
  if (!cur) return undefined;
  const next: WorldEvent = { ...cur, ...patch, id, world_id: cur.world_id, updated_at: now() };
  db.prepare(
    `UPDATE world_events SET title=?, condition=?, trigger=?, cooldown_days=?, inject=?, enabled=?, updated_at=? WHERE id=?`,
  ).run(
    next.title, toJson(next.condition), next.trigger, next.cooldown_days, next.inject,
    next.enabled, next.updated_at, id,
  );
  return next;
}

export function deleteEvent(id: string): void {
  db.prepare('DELETE FROM world_events WHERE id = ?').run(id);
}

// ---- 発火履歴（event_fires。ゲーム内時刻の通算分で記録 §4.13）----

export function lastFire(eventId: string, chatId: string): number | null {
  const row = db
    .prepare(
      'SELECT game_time FROM event_fires WHERE event_id = ? AND chat_id = ? ORDER BY game_time DESC LIMIT 1',
    )
    .get(eventId, chatId) as { game_time: number } | undefined;
  return row?.game_time ?? null;
}

export function listFires(eventId: string, chatId: string): number[] {
  const rows = db
    .prepare('SELECT game_time FROM event_fires WHERE event_id = ? AND chat_id = ?')
    .all(eventId, chatId) as { game_time: number }[];
  return rows.map((r) => r.game_time);
}

export function recordFire(eventId: string, chatId: string, gameTime: number): void {
  db.prepare('INSERT INTO event_fires (event_id, chat_id, game_time) VALUES (?, ?, ?)').run(
    eventId,
    chatId,
    gameTime,
  );
}
