import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { World } from '../../../../shared/types.js';

export function listWorlds(): World[] {
  return db.prepare('SELECT * FROM worlds ORDER BY updated_at DESC').all() as World[];
}

export function getWorld(id: string): World | undefined {
  return db.prepare('SELECT * FROM worlds WHERE id = ?').get(id) as World | undefined;
}

export function createWorld(input: Partial<World>): World {
  const t = now();
  const world: World = {
    id: ulid(),
    name: input.name || '新しい世界',
    description: input.description || '',
    system_prompt: input.system_prompt || '',
    narrator_prompt: input.narrator_prompt || '',
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO worlds (id, name, description, system_prompt, narrator_prompt, created_at, updated_at)
     VALUES (@id, @name, @description, @system_prompt, @narrator_prompt, @created_at, @updated_at)`,
  ).run(world);
  return world;
}

export function updateWorld(id: string, patch: Partial<World>): World | undefined {
  const cur = getWorld(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch, id, updated_at: now() };
  db.prepare(
    `UPDATE worlds SET name=@name, description=@description, system_prompt=@system_prompt,
     narrator_prompt=@narrator_prompt, updated_at=@updated_at WHERE id=@id`,
  ).run(next);
  return next;
}

export function deleteWorld(id: string): void {
  db.prepare('DELETE FROM worlds WHERE id = ?').run(id);
}

/** World削除確認ダイアログ用の配下件数（§8.9） */
export function worldUsage(id: string) {
  const count = (sql: string) =>
    (db.prepare(sql).get(id) as { c: number }).c;
  return {
    characters: count('SELECT COUNT(*) c FROM characters WHERE world_id = ?'),
    scenarios: count('SELECT COUNT(*) c FROM scenarios WHERE world_id = ?'),
    chats: count('SELECT COUNT(*) c FROM chats WHERE world_id = ?'),
    lorebook: count('SELECT COUNT(*) c FROM lorebook_entries WHERE world_id = ?'),
    locations: count('SELECT COUNT(*) c FROM locations WHERE world_id = ?'),
    events: count('SELECT COUNT(*) c FROM world_events WHERE world_id = ?'),
  };
}
