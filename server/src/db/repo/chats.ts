import { db, now, fromJson, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Chat, ChatState } from '../../../../shared/types.js';
import { EMPTY_STATE } from './scenarios.js';

interface Row extends Omit<Chat, 'participant_ids' | 'state'> {
  participant_ids: string;
  state: string;
}

function toApi(row: Row): Chat {
  return {
    ...row,
    participant_ids: fromJson<string[]>(row.participant_ids, []),
    state: { ...EMPTY_STATE, ...fromJson<Partial<ChatState>>(row.state, {}) },
  };
}

export function listChats(opts: { worldId?: string; archived?: boolean } = {}): Chat[] {
  let sql = 'SELECT * FROM chats';
  const cond: string[] = [];
  const args: unknown[] = [];
  if (opts.worldId) {
    cond.push('world_id = ?');
    args.push(opts.worldId);
  }
  if (opts.archived !== undefined) {
    cond.push('archived = ?');
    args.push(opts.archived ? 1 : 0);
  }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY updated_at DESC';
  return (db.prepare(sql).all(...args) as Row[]).map(toApi);
}

export function getChat(id: string): Chat | undefined {
  const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

export function createChat(input: {
  world_id: string;
  scenario_id: string | null;
  title?: string;
  persona_id: string | null;
  participant_ids: string[];
  model?: string;
  narrator_enabled: number;
  state: ChatState;
}): Chat {
  const t = now();
  const c: Chat = {
    id: ulid(),
    world_id: input.world_id,
    scenario_id: input.scenario_id,
    title: input.title || '',
    persona_id: input.persona_id,
    participant_ids: input.participant_ids,
    model: input.model || '',
    narrator_enabled: input.narrator_enabled,
    state: input.state,
    extracted_up_to: null,
    archived: 0,
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO chats (id, world_id, scenario_id, title, persona_id, participant_ids, model, narrator_enabled, state, extracted_up_to, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id, c.world_id, c.scenario_id, c.title, c.persona_id, toJson(c.participant_ids),
    c.model, c.narrator_enabled, toJson(c.state), c.extracted_up_to, c.archived,
    c.created_at, c.updated_at,
  );
  return c;
}

export function updateChat(id: string, patch: Partial<Chat>): Chat | undefined {
  const cur = getChat(id);
  if (!cur) return undefined;
  const next: Chat = {
    ...cur,
    ...patch,
    id,
    world_id: cur.world_id,
    state: patch.state ? { ...cur.state, ...patch.state } : cur.state,
    updated_at: now(),
  };
  db.prepare(
    `UPDATE chats SET scenario_id=?, title=?, persona_id=?, participant_ids=?, model=?, narrator_enabled=?, state=?, extracted_up_to=?, archived=?, updated_at=? WHERE id=?`,
  ).run(
    next.scenario_id, next.title, next.persona_id, toJson(next.participant_ids), next.model,
    next.narrator_enabled, toJson(next.state), next.extracted_up_to, next.archived,
    next.updated_at, id,
  );
  return next;
}

export function setChatState(id: string, state: ChatState): void {
  db.prepare('UPDATE chats SET state = ?, updated_at = ? WHERE id = ?').run(
    toJson(state),
    now(),
    id,
  );
}

export function deleteChat(id: string): void {
  db.prepare('DELETE FROM chats WHERE id = ?').run(id);
}

/** Character削除の参照チェック用（§8.9）: participant_ids に含むChat名一覧 */
export function chatsReferencingCharacter(characterId: string): { id: string; title: string }[] {
  const rows = db.prepare('SELECT id, title, participant_ids FROM chats').all() as {
    id: string;
    title: string;
    participant_ids: string;
  }[];
  return rows
    .filter((r) => fromJson<string[]>(r.participant_ids, []).includes(characterId))
    .map((r) => ({ id: r.id, title: r.title || '(無題)' }));
}

/** Location削除の参照チェック用（§8.9） */
export function chatsUsingLocation(locationId: string): { id: string; title: string }[] {
  const rows = db.prepare('SELECT id, title, state FROM chats').all() as {
    id: string;
    title: string;
    state: string;
  }[];
  return rows
    .filter((r) => fromJson<Partial<ChatState>>(r.state, {}).location === locationId)
    .map((r) => ({ id: r.id, title: r.title || '(無題)' }));
}

/** Persona削除時の既定ペルソナへのフォールバック（§8.9） */
export function fallbackPersona(deletedPersonaId: string, fallbackId: string | null): void {
  db.prepare('UPDATE chats SET persona_id = ? WHERE persona_id = ?').run(
    fallbackId,
    deletedPersonaId,
  );
}
