import { db, now, fromJson, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Scenario, ChatState } from '../../../../shared/types.js';

export const EMPTY_STATE: ChatState = {
  time: 0,
  location: '',
  location_note: '',
  weather: '晴',
  present: [],
};

interface Row extends Omit<Scenario, 'participant_ids' | 'initial_state'> {
  participant_ids: string;
  initial_state: string;
}

function toApi(row: Row): Scenario {
  return {
    ...row,
    participant_ids: fromJson<string[]>(row.participant_ids, []),
    initial_state: { ...EMPTY_STATE, ...fromJson<Partial<ChatState>>(row.initial_state, {}) },
  };
}

export function listScenarios(worldId: string): Scenario[] {
  const rows = db
    .prepare('SELECT * FROM scenarios WHERE world_id = ? ORDER BY created_at ASC')
    .all(worldId) as Row[];
  return rows.map(toApi);
}

export function getScenario(id: string): Scenario | undefined {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

export function createScenario(worldId: string, input: Partial<Scenario>): Scenario {
  const t = now();
  const s: Scenario = {
    id: ulid(),
    world_id: worldId,
    title: input.title || '新しいシナリオ',
    description: input.description || '',
    participant_ids: input.participant_ids ?? [],
    default_persona_id: input.default_persona_id ?? null,
    opening: input.opening || '',
    initial_state: { ...EMPTY_STATE, ...(input.initial_state ?? {}) },
    narrator_enabled: input.narrator_enabled ?? 1,
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO scenarios (id, world_id, title, description, participant_ids, default_persona_id, opening, initial_state, narrator_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id, s.world_id, s.title, s.description, toJson(s.participant_ids), s.default_persona_id,
    s.opening, toJson(s.initial_state), s.narrator_enabled, s.created_at, s.updated_at,
  );
  return s;
}

export function updateScenario(id: string, patch: Partial<Scenario>): Scenario | undefined {
  const cur = getScenario(id);
  if (!cur) return undefined;
  const next: Scenario = {
    ...cur,
    ...patch,
    id,
    world_id: cur.world_id,
    initial_state: { ...cur.initial_state, ...(patch.initial_state ?? {}) },
    updated_at: now(),
  };
  db.prepare(
    `UPDATE scenarios SET title=?, description=?, participant_ids=?, default_persona_id=?, opening=?, initial_state=?, narrator_enabled=?, updated_at=? WHERE id=?`,
  ).run(
    next.title, next.description, toJson(next.participant_ids), next.default_persona_id,
    next.opening, toJson(next.initial_state), next.narrator_enabled, next.updated_at, id,
  );
  return next;
}

export function deleteScenario(id: string): void {
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
}

/** Character削除時に scenarios.participant_ids から自動除去（§8.9） */
export function removeCharacterFromScenarios(characterId: string): void {
  const rows = db.prepare('SELECT id, participant_ids FROM scenarios').all() as {
    id: string;
    participant_ids: string;
  }[];
  const stmt = db.prepare('UPDATE scenarios SET participant_ids = ?, updated_at = ? WHERE id = ?');
  for (const r of rows) {
    const ids = fromJson<string[]>(r.participant_ids, []);
    if (ids.includes(characterId)) {
      stmt.run(toJson(ids.filter((i) => i !== characterId)), now(), r.id);
    }
  }
}
