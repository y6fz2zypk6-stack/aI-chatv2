import { db, now } from '../index.js';
import type { Location } from '../../../../shared/types.js';

export function listLocations(worldId: string): Location[] {
  return db
    .prepare('SELECT * FROM locations WHERE world_id = ? ORDER BY created_at ASC')
    .all(worldId) as Location[];
}

export function getLocation(id: string): Location | undefined {
  return db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as Location | undefined;
}

export function createLocation(worldId: string, input: Partial<Location> & { id: string }): Location {
  const t = now();
  const l: Location = {
    id: input.id,
    world_id: worldId,
    name: input.name || input.id,
    indoor: input.indoor ? 1 : 0,
    area: input.area || '',
    open_min: input.open_min ?? null,
    close_min: input.close_min ?? null,
    note: input.note || '',
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO locations (id, world_id, name, indoor, area, open_min, close_min, note, created_at, updated_at)
     VALUES (@id, @world_id, @name, @indoor, @area, @open_min, @close_min, @note, @created_at, @updated_at)`,
  ).run(l);
  return l;
}

export function updateLocation(id: string, patch: Partial<Location>): Location | undefined {
  const cur = getLocation(id);
  if (!cur) return undefined;
  const next: Location = { ...cur, ...patch, id, world_id: cur.world_id, updated_at: now() };
  db.prepare(
    `UPDATE locations SET name=@name, indoor=@indoor, area=@area, open_min=@open_min, close_min=@close_min, note=@note, updated_at=@updated_at WHERE id=@id`,
  ).run(next);
  return next;
}

export function deleteLocation(id: string): void {
  db.prepare('DELETE FROM locations WHERE id = ?').run(id);
}
