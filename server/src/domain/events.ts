import type { CalendarConfig, ChatState, Location } from '../../../shared/types.js';
import { hhmmToMin, MIN_PER_DAY, toGameTime } from './calendar.js';
import {
  lastFire,
  listEvents,
  listFires,
  recordFire,
  type WorldEvent,
} from '../db/repo/events.js';

/**
 * pendingイベント（§8.6）。条件を満たしたターンに、ロアブックとは別枠で一文を注入する。
 * 発火判定は基準ステートに対して行い、記録は生成保存時に行う。
 */
export function evaluateEvents(input: {
  worldId: string;
  chatId: string;
  state: ChatState;
  calendar: CalendarConfig;
  locations: Location[];
}): WorldEvent[] {
  const { state, calendar } = input;
  const gt = toGameTime(calendar, state.time);
  const minOfDay = state.time % MIN_PER_DAY;
  const loc = input.locations.find((l) => l.id === state.location);

  const fired: WorldEvent[] = [];
  for (const e of listEvents(input.worldId)) {
    if (e.enabled !== 1 || !e.inject) continue;
    const c = e.condition;

    if (c.season && c.season !== gt.season) continue;
    if (c.month != null && c.month !== gt.month) continue;
    if (c.week != null && c.week !== gt.week) continue;
    if (c.weekday && c.weekday !== gt.weekday) continue;
    if (c.time_after && minOfDay < hhmmToMin(c.time_after)) continue;
    if (c.time_before && minOfDay >= hhmmToMin(c.time_before)) continue;
    if (c.location && c.location !== state.location) continue;
    if (c.location_area && c.location_area !== (loc?.area ?? '')) continue;
    if (c.weather && c.weather !== state.weather) continue;

    // trigger 判定（チャット単位の発火履歴に対して）
    if (e.trigger === 'once') {
      if (lastFire(e.id, input.chatId) != null) continue;
    } else if (e.trigger === 'once_per_year') {
      const daysPerYear = calendar.months_per_year * calendar.days_per_month;
      const yearOf = (t: number) => Math.floor(t / MIN_PER_DAY / daysPerYear);
      if (listFires(e.id, input.chatId).some((t) => yearOf(t) === yearOf(state.time))) continue;
    } else if (e.trigger === 'cooldown') {
      const last = lastFire(e.id, input.chatId);
      if (last != null && state.time - last < e.cooldown_days * MIN_PER_DAY) continue;
    }

    fired.push(e);
  }
  return fired;
}

export function recordEventFires(events: WorldEvent[], chatId: string, gameTime: number): void {
  for (const e of events) recordFire(e.id, chatId, gameTime);
}
