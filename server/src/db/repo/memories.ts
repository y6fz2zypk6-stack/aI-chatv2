import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Memory } from '../../../../shared/types.js';

export function listMemories(characterId: string): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE character_id = ? ORDER BY pinned DESC, created_at ASC')
    .all(characterId) as Memory[];
}

export function getMemory(id: string): Memory | undefined {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
}

export function countMemories(characterId: string): number {
  return (
    db.prepare('SELECT COUNT(*) c FROM memories WHERE character_id = ?').get(characterId) as {
      c: number;
    }
  ).c;
}

export function createMemory(characterId: string, input: Partial<Memory>): Memory {
  const t = now();
  const m: Memory = {
    id: ulid(),
    character_id: characterId,
    subject: input.subject || '',
    content: input.content || '',
    source: input.source === 'auto' ? 'auto' : 'manual',
    pinned: input.pinned ? 1 : 0,
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    'INSERT INTO memories (id, character_id, subject, content, source, pinned, created_at, updated_at) VALUES (@id, @character_id, @subject, @content, @source, @pinned, @created_at, @updated_at)',
  ).run(m);
  return m;
}

export function updateMemory(id: string, patch: Partial<Memory>): Memory | undefined {
  const cur = getMemory(id);
  if (!cur) return undefined;
  const next: Memory = { ...cur, ...patch, id, character_id: cur.character_id, updated_at: now() };
  db.prepare(
    'UPDATE memories SET subject=@subject, content=@content, source=@source, pinned=@pinned, updated_at=@updated_at WHERE id=@id',
  ).run(next);
  return next;
}

export function deleteMemory(id: string): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}
