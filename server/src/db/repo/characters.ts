import { db, now, fromJson, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Character } from '../../../../shared/types.js';

interface Row extends Omit<Character, 'aliases'> {
  aliases: string;
}

function toApi(row: Row): Character {
  return { ...row, aliases: fromJson<string[]>(row.aliases, []) };
}

export function listCharacters(worldId: string): Character[] {
  const rows = db
    .prepare('SELECT * FROM characters WHERE world_id = ? ORDER BY created_at ASC')
    .all(worldId) as Row[];
  return rows.map(toApi);
}

export function getCharacter(id: string): Character | undefined {
  const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Row | undefined;
  return row ? toApi(row) : undefined;
}

export function getCharacters(ids: string[]): Character[] {
  return ids.map((id) => getCharacter(id)).filter((c): c is Character => !!c);
}

export function createCharacter(worldId: string, input: Partial<Character>): Character {
  const t = now();
  const c: Character = {
    id: ulid(),
    world_id: worldId,
    name: input.name || '新しいキャラクター',
    aliases: input.aliases ?? [],
    avatar: input.avatar || '',
    persona: input.persona || '',
    appearance: input.appearance || '',
    speech_style: input.speech_style || '',
    example_dialogue: input.example_dialogue || '',
    is_npc_pool: input.is_npc_pool ? 1 : 0,
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO characters (id, world_id, name, aliases, avatar, persona, appearance, speech_style, example_dialogue, is_npc_pool, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id, c.world_id, c.name, toJson(c.aliases), c.avatar, c.persona, c.appearance,
    c.speech_style, c.example_dialogue, c.is_npc_pool, c.created_at, c.updated_at,
  );
  return c;
}

export function updateCharacter(id: string, patch: Partial<Character>): Character | undefined {
  const cur = getCharacter(id);
  if (!cur) return undefined;
  const next: Character = { ...cur, ...patch, id, world_id: cur.world_id, updated_at: now() };
  db.prepare(
    `UPDATE characters SET name=?, aliases=?, avatar=?, persona=?, appearance=?, speech_style=?, example_dialogue=?, is_npc_pool=?, updated_at=? WHERE id=?`,
  ).run(
    next.name, toJson(next.aliases), next.avatar, next.persona, next.appearance,
    next.speech_style, next.example_dialogue, next.is_npc_pool ? 1 : 0, next.updated_at, id,
  );
  return next;
}

export function deleteCharacter(id: string): void {
  db.prepare('DELETE FROM characters WHERE id = ?').run(id);
}
