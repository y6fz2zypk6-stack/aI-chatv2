import { db, now, fromJson, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type {
  EventCondition,
  EventFire,
  EventVarOp,
  WorldEvent,
} from '../../../../shared/types.js';

// 注意: "when" / "check" はSQLの予約語なので、必ず二重引用符で囲む

interface Row extends Omit<WorldEvent, 'when' | 'set_vars'> {
  when: string;
  set_vars: string;
}

function toApi(row: Row): WorldEvent {
  const when = fromJson<EventCondition | null>(row.when, null);
  return {
    ...row,
    // 空オブジェクトは「条件なし＝常に真」として扱う
    when: when && Object.keys(when).length ? when : null,
    set_vars: fromJson<EventVarOp[]>(row.set_vars, []),
  };
}

const COLUMNS = `id, world_id, title, kind, "when", "check", chance, trigger, trigger_var,
  cooldown_days, priority, inject_mode, inject, set_vars, enabled, created_at, updated_at`;

export function listEvents(worldId: string): WorldEvent[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM world_events WHERE world_id = ? ORDER BY priority DESC, created_at ASC`)
    .all(worldId) as Row[];
  return rows.map(toApi);
}

export function getEvent(id: string): WorldEvent | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM world_events WHERE id = ?`).get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

function normalize(input: Partial<WorldEvent>, base?: WorldEvent): Omit<WorldEvent, 'id' | 'world_id' | 'created_at' | 'updated_at'> {
  const chance = input.chance ?? base?.chance ?? 1;
  return {
    title: input.title ?? base?.title ?? '新しいイベント',
    kind: input.kind ?? base?.kind ?? 'ambient',
    when: input.when !== undefined ? input.when : (base?.when ?? null),
    check: input.check ?? base?.check ?? 'every_turn',
    chance: Math.max(0, Math.min(1, Number.isFinite(chance) ? chance : 1)),
    trigger: input.trigger ?? base?.trigger ?? 'once',
    trigger_var: input.trigger_var ?? base?.trigger_var ?? '',
    cooldown_days: input.cooldown_days ?? base?.cooldown_days ?? 0,
    priority: input.priority ?? base?.priority ?? 0,
    inject_mode: input.inject_mode ?? base?.inject_mode ?? 'fact',
    inject: input.inject ?? base?.inject ?? '',
    set_vars: input.set_vars ?? base?.set_vars ?? [],
    enabled: input.enabled ?? base?.enabled ?? 1,
  };
}

export function createEvent(worldId: string, input: Partial<WorldEvent>): WorldEvent {
  const t = now();
  const e: WorldEvent = { id: ulid(), world_id: worldId, ...normalize(input), created_at: t, updated_at: t };
  db.prepare(
    `INSERT INTO world_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id, e.world_id, e.title, e.kind, toJson(e.when ?? {}), e.check, e.chance, e.trigger,
    e.trigger_var, e.cooldown_days, e.priority, e.inject_mode, e.inject, toJson(e.set_vars),
    e.enabled, e.created_at, e.updated_at,
  );
  return e;
}

export function updateEvent(id: string, patch: Partial<WorldEvent>): WorldEvent | undefined {
  const cur = getEvent(id);
  if (!cur) return undefined;
  const e: WorldEvent = { ...cur, ...normalize(patch, cur), id, world_id: cur.world_id, updated_at: now() };
  db.prepare(
    `UPDATE world_events SET title=?, kind=?, "when"=?, "check"=?, chance=?, trigger=?, trigger_var=?,
       cooldown_days=?, priority=?, inject_mode=?, inject=?, set_vars=?, enabled=?, updated_at=? WHERE id=?`,
  ).run(
    e.title, e.kind, toJson(e.when ?? {}), e.check, e.chance, e.trigger, e.trigger_var,
    e.cooldown_days, e.priority, e.inject_mode, e.inject, toJson(e.set_vars), e.enabled,
    e.updated_at, id,
  );
  return e;
}

export function deleteEvent(id: string): void {
  db.prepare('DELETE FROM world_events WHERE id = ?').run(id);
}

// ---- 発火履歴（v1.5.3 §8）----

export function listFires(chatId: string): EventFire[] {
  return db
    .prepare(
      `SELECT f.*, e.title AS event_title FROM event_fires f
         LEFT JOIN world_events e ON e.id = f.event_id
        WHERE f.chat_id = ? ORDER BY f.created_at DESC`,
    )
    .all(chatId) as EventFire[];
}

/** そのチャットで、指定イベントが発火済みか（scope_key を指定すると同一スコープ内のみ） */
export function firesOf(chatId: string, eventId: string): EventFire[] {
  return db
    .prepare('SELECT * FROM event_fires WHERE chat_id = ? AND event_id = ? ORDER BY fired_at_time ASC')
    .all(chatId, eventId) as EventFire[];
}

export function recordFire(input: {
  chat_id: string;
  event_id: string;
  message_id: string | null;
  fired_at_time: number;
  scope_key: string;
}): EventFire {
  const f: EventFire = { id: ulid(), ...input, created_at: now() };
  db.prepare(
    `INSERT INTO event_fires (id, chat_id, event_id, message_id, fired_at_time, scope_key, created_at)
     VALUES (@id, @chat_id, @event_id, @message_id, @fired_at_time, @scope_key, @created_at)`,
  ).run(f);
  return f;
}

export function deleteFire(id: string): void {
  db.prepare('DELETE FROM event_fires WHERE id = ?').run(id);
}

/** 指定メッセージに紐づく発火履歴を消す（再生成で候補を作り直すとき） */
export function deleteFiresOfMessage(chatId: string, messageId: string): void {
  db.prepare('DELETE FROM event_fires WHERE chat_id = ? AND message_id = ?').run(chatId, messageId);
}

/** 指定 seq 以降のメッセージに紐づく発火履歴を消す（削除・巻き戻し） */
export function deleteFiresFromSeq(chatId: string, seq: number): void {
  db.prepare(
    `DELETE FROM event_fires WHERE chat_id = ? AND message_id IN (
       SELECT id FROM messages WHERE chat_id = ? AND seq >= ?
     )`,
  ).run(chatId, chatId, seq);
}

/** そのメッセージで採用されたイベント（次ターンの注入に使う） */
export function firesAtMessage(chatId: string, messageId: string): EventFire[] {
  return db
    .prepare('SELECT * FROM event_fires WHERE chat_id = ? AND message_id = ? ORDER BY created_at ASC')
    .all(chatId, messageId) as EventFire[];
}

/** fork: 指定メッセージ以前の発火履歴を新チャットへ複製する。ID対応表で message_id を張り替える */
export function copyFiresForFork(
  fromChatId: string,
  toChatId: string,
  upToSeq: number,
  messageIdMap: Map<string, string>,
): void {
  const rows = db
    .prepare(
      `SELECT f.* FROM event_fires f
         JOIN messages m ON m.id = f.message_id
        WHERE f.chat_id = ? AND m.seq <= ?`,
    )
    .all(fromChatId, upToSeq) as EventFire[];
  for (const r of rows) {
    recordFire({
      chat_id: toChatId,
      event_id: r.event_id,
      message_id: r.message_id ? (messageIdMap.get(r.message_id) ?? null) : null,
      fired_at_time: r.fired_at_time,
      scope_key: r.scope_key,
    });
  }
}
