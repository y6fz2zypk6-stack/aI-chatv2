import { db, now } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Memory } from '../../../../shared/types.js';

export function listMemories(characterId: string): Memory[] {
  return db
    .prepare(
      // 無効にしたものは一覧の末尾へ回す（記録としては残すが、普段は視界の外へ）
      'SELECT * FROM memories WHERE character_id = ? ORDER BY enabled DESC, pinned DESC, created_at ASC',
    )
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

/** ゲーム内時刻は通算分の整数か null（＝日付不明）に正規化する */
function normalizeGameTime(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
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
    game_time: normalizeGameTime(input.game_time),
    enabled: input.enabled === 0 ? 0 : 1,
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    'INSERT INTO memories (id, character_id, subject, content, source, pinned, game_time, enabled, created_at, updated_at) VALUES (@id, @character_id, @subject, @content, @source, @pinned, @game_time, @enabled, @created_at, @updated_at)',
  ).run(m);
  return m;
}

export function updateMemory(id: string, patch: Partial<Memory>): Memory | undefined {
  const cur = getMemory(id);
  if (!cur) return undefined;
  const next: Memory = {
    ...cur,
    ...patch,
    id,
    character_id: cur.character_id,
    // patch に game_time が無ければ現状維持。あれば null を含めて素直に採用する
    game_time: 'game_time' in patch ? normalizeGameTime(patch.game_time) : cur.game_time,
    enabled: 'enabled' in patch ? (patch.enabled === 0 ? 0 : 1) : cur.enabled,
    updated_at: now(),
  };
  db.prepare(
    'UPDATE memories SET subject=@subject, content=@content, source=@source, pinned=@pinned, game_time=@game_time, enabled=@enabled, updated_at=@updated_at WHERE id=@id',
  ).run(next);
  return next;
}

export function deleteMemory(id: string): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}
