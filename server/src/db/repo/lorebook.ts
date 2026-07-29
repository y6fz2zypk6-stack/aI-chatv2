import { db, now, fromJson, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { LorebookEntry } from '../../../../shared/types.js';

interface Row extends Omit<LorebookEntry, 'keys' | 'trigger_locations' | 'trigger_seasons'> {
  keys: string;
  trigger_locations: string;
  trigger_seasons: string;
}

function toApi(row: Row): LorebookEntry {
  return {
    ...row,
    keys: fromJson<string[]>(row.keys, []),
    trigger_locations: fromJson<string[]>(row.trigger_locations, []),
    trigger_seasons: fromJson<string[]>(row.trigger_seasons, []),
  };
}

export function listLorebook(worldId: string): LorebookEntry[] {
  const rows = db
    .prepare('SELECT * FROM lorebook_entries WHERE world_id = ? ORDER BY priority DESC, id ASC')
    .all(worldId) as Row[];
  return rows.map(toApi);
}

export function getLorebookEntry(id: string): LorebookEntry | undefined {
  const row = db.prepare('SELECT * FROM lorebook_entries WHERE id = ?').get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

export function createLorebookEntry(worldId: string, input: Partial<LorebookEntry>): LorebookEntry {
  const t = now();
  const e: LorebookEntry = {
    id: ulid(),
    world_id: worldId,
    character_id: input.character_id ?? null,
    title: input.title || '新しいエントリ',
    keys: input.keys ?? [],
    content: input.content || '',
    enabled: input.enabled ?? 1,
    always: input.always ?? 0,
    priority: input.priority ?? 0,
    category: input.category ?? 'その他',
    trigger_locations: input.trigger_locations ?? [],
    trigger_seasons: input.trigger_seasons ?? [],
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO lorebook_entries (id, world_id, character_id, title, keys, content, enabled, always, priority, category, trigger_locations, trigger_seasons, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id, e.world_id, e.character_id, e.title, toJson(e.keys), e.content, e.enabled, e.always,
    e.priority, e.category, toJson(e.trigger_locations), toJson(e.trigger_seasons),
    e.created_at, e.updated_at,
  );
  return e;
}

export function updateLorebookEntry(id: string, patch: Partial<LorebookEntry>): LorebookEntry | undefined {
  const cur = getLorebookEntry(id);
  if (!cur) return undefined;
  const next: LorebookEntry = { ...cur, ...patch, id, world_id: cur.world_id, updated_at: now() };
  db.prepare(
    `UPDATE lorebook_entries SET character_id=?, title=?, keys=?, content=?, enabled=?, always=?, priority=?, category=?, trigger_locations=?, trigger_seasons=?, updated_at=? WHERE id=?`,
  ).run(
    next.character_id, next.title, toJson(next.keys), next.content, next.enabled, next.always,
    next.priority, next.category, toJson(next.trigger_locations), toJson(next.trigger_seasons),
    next.updated_at, id,
  );
  return next;
}

export function deleteLorebookEntry(id: string): void {
  db.prepare('DELETE FROM lorebook_entries WHERE id = ?').run(id);
}

/** Location削除時に trigger_locations から自動除去（§8.9） */
export function removeLocationFromLorebook(locationId: string): void {
  const rows = db.prepare('SELECT id, trigger_locations FROM lorebook_entries').all() as {
    id: string;
    trigger_locations: string;
  }[];
  const stmt = db.prepare('UPDATE lorebook_entries SET trigger_locations = ?, updated_at = ? WHERE id = ?');
  for (const r of rows) {
    const ids = fromJson<string[]>(r.trigger_locations, []);
    if (ids.includes(locationId)) {
      stmt.run(toJson(ids.filter((i) => i !== locationId)), now(), r.id);
    }
  }
}
