import { db, now, fromJson, toJson } from '../index.js';
import type { CalendarConfig } from '../../../../shared/types.js';
import { DEFAULT_CALENDAR, normalizeCalendar } from '../../domain/calendar.js';

export function getCalendar(worldId: string): CalendarConfig {
  const row = db.prepare('SELECT config FROM calendars WHERE world_id = ?').get(worldId) as
    | { config: string }
    | undefined;
  return normalizeCalendar(row ? fromJson<Partial<CalendarConfig>>(row.config, {}) : {});
}

export function upsertCalendar(worldId: string, patch: Partial<CalendarConfig>): CalendarConfig {
  const next = { ...getCalendar(worldId), ...patch };
  const t = now();
  db.prepare(
    `INSERT INTO calendars (world_id, config, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(world_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  ).run(worldId, toJson(next), t, t);
  return next;
}

export function ensureCalendar(worldId: string): void {
  const row = db.prepare('SELECT world_id FROM calendars WHERE world_id = ?').get(worldId);
  if (!row) upsertCalendar(worldId, DEFAULT_CALENDAR);
}
