import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Persona } from '../../../../shared/types.js';

export function listPersonas(): Persona[] {
  return db.prepare('SELECT * FROM personas ORDER BY is_default DESC, created_at ASC').all() as Persona[];
}

export function getPersona(id: string): Persona | undefined {
  return db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as Persona | undefined;
}

export function getDefaultPersona(): Persona | undefined {
  return db.prepare('SELECT * FROM personas ORDER BY is_default DESC, created_at ASC LIMIT 1').get() as
    | Persona
    | undefined;
}

export function createPersona(input: Partial<Persona>): Persona {
  const t = now();
  const p: Persona = {
    id: ulid(),
    name: input.name || '新しいペルソナ',
    avatar: input.avatar || '',
    description: input.description || '',
    appearance: input.appearance || '',
    is_default: input.is_default ? 1 : 0,
    created_at: t,
    updated_at: t,
  };
  const tx = db.transaction(() => {
    if (p.is_default) db.prepare('UPDATE personas SET is_default = 0').run();
    db.prepare(
      `INSERT INTO personas (id, name, avatar, description, appearance, is_default, created_at, updated_at)
       VALUES (@id, @name, @avatar, @description, @appearance, @is_default, @created_at, @updated_at)`,
    ).run(p);
  });
  tx();
  return p;
}

export function updatePersona(id: string, patch: Partial<Persona>): Persona | undefined {
  const cur = getPersona(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch, id, updated_at: now() };
  const tx = db.transaction(() => {
    if (next.is_default) db.prepare('UPDATE personas SET is_default = 0').run();
    db.prepare(
      `UPDATE personas SET name=@name, avatar=@avatar, description=@description, appearance=@appearance, is_default=@is_default, updated_at=@updated_at WHERE id=@id`,
    ).run(next);
  });
  tx();
  return next;
}

export function deletePersona(id: string): void {
  db.prepare('DELETE FROM personas WHERE id = ?').run(id);
}
