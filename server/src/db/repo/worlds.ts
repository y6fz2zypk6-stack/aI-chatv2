import { db, fromJson, now, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';
import { DEFAULT_AREAS, type VarSchemaEntry, type World, type WorldArea } from '../../../../shared/types.js';

interface Row extends Omit<World, 'vars_schema' | 'areas'> {
  vars_schema: string;
  areas: string;
}

function toApi(row: Row): World {
  return {
    ...row,
    areas: fromJson<WorldArea[]>(row.areas, []),
    vars_schema: fromJson<VarSchemaEntry[]>(row.vars_schema, []),
  };
}

export function listWorlds(): World[] {
  return (db.prepare('SELECT * FROM worlds ORDER BY updated_at DESC').all() as Row[]).map(toApi);
}

export function getWorld(id: string): World | undefined {
  const row = db.prepare('SELECT * FROM worlds WHERE id = ?').get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

export function createWorld(input: Partial<World>): World {
  const t = now();
  const world: World = {
    id: ulid(),
    name: input.name || '新しい世界',
    description: input.description || '',
    system_prompt: input.system_prompt || '',
    narrator_prompt: input.narrator_prompt || '',
    areas: input.areas ?? DEFAULT_AREAS.map((a) => ({ ...a })),
    vars_schema: input.vars_schema ?? [],
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO worlds (id, name, description, system_prompt, narrator_prompt, areas, vars_schema, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    world.id, world.name, world.description, world.system_prompt, world.narrator_prompt,
    toJson(world.areas), toJson(world.vars_schema), world.created_at, world.updated_at,
  );
  return world;
}

export function updateWorld(id: string, patch: Partial<World>): World | undefined {
  const cur = getWorld(id);
  if (!cur) return undefined;
  const next: World = { ...cur, ...patch, id, updated_at: now() };
  db.prepare(
    `UPDATE worlds SET name=?, description=?, system_prompt=?,
     narrator_prompt=?, areas=?, vars_schema=?, updated_at=? WHERE id=?`,
  ).run(
    next.name, next.description, next.system_prompt, next.narrator_prompt,
    toJson(next.areas), toJson(next.vars_schema), next.updated_at, id,
  );
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
    // 画像は容量が大きいので、何枚消えるかを削除の確認に出す（§21.8）
    snapshots: count(
      `SELECT COUNT(*) c FROM snapshots s
         JOIN chats ch ON ch.id = s.chat_id
        WHERE ch.world_id = ?`,
    ),
  };
}
