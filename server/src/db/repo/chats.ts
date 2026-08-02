import { db, now, fromJson, toJson } from '../index.js';
import { ulid } from '../../util/ulid.js';
import type { Chat, ChatListItem, ChatState } from '../../../../shared/types.js';
import { EMPTY_STATE } from './scenarios.js';

interface Row extends Omit<Chat, 'participant_ids' | 'state' | 'initial_state'> {
  participant_ids: string;
  state: string;
  initial_state: string;
}

function toApi(row: Row): Chat {
  return {
    ...row,
    participant_ids: fromJson<string[]>(row.participant_ids, []),
    state: { ...EMPTY_STATE, ...fromJson<Partial<ChatState>>(row.state, {}) },
    initial_state: { ...EMPTY_STATE, ...fromJson<Partial<ChatState>>(row.initial_state, {}) },
  };
}

/** 一覧に出す抜粋の最大長。表示は2行でクランプするので少し余裕を持たせる */
const PREVIEW_CHARS = 80;

/**
 * 最新メッセージの本文から一覧用の抜粋を作る。
 * 話者ラベル（「アシュリー: 」）と強調記号・鉤括弧を落として1行に畳む。
 */
export function toPreview(content: string | null | undefined): string {
  if (!content) return '';
  const lines: string[] = [];
  for (const raw of content.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    // 行頭の話者ラベルを落とす。「18:30に着いた」を誤って切らないよう数字だけの見出しは残す
    const m = /^([^\s:：][^:：]{0,29})[:：]\s?(.*)$/.exec(line);
    if (m && !/^\d+$/.test(m[1])) line = m[2].trim();
    if (line) lines.push(line);
  }
  const text = lines
    .join(' ')
    .replace(/\*+/g, '')
    .replace(/[「」『』]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

export function listChats(opts: { worldId?: string; archived?: boolean } = {}): ChatListItem[] {
  // 最新メッセージの本文を1件だけ添える（messages.content は常に採用中の候補の本文）
  let sql = `SELECT c.*, (
               SELECT m.content FROM messages m
                WHERE m.chat_id = c.id ORDER BY m.seq DESC LIMIT 1
             ) AS last_content
               FROM chats c`;
  const cond: string[] = [];
  const args: unknown[] = [];
  if (opts.worldId) {
    cond.push('c.world_id = ?');
    args.push(opts.worldId);
  }
  if (opts.archived !== undefined) {
    cond.push('c.archived = ?');
    args.push(opts.archived ? 1 : 0);
  }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY c.updated_at DESC';
  return (db.prepare(sql).all(...args) as (Row & { last_content: string | null })[]).map((row) => {
    const { last_content, ...rest } = row;
    return { ...toApi(rest as Row), preview: toPreview(last_content) };
  });
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
  events_enabled?: number | null;
  vars_enabled?: number | null;
  state: ChatState;
  /** 省略時は state をそのまま初期ステートとする */
  initial_state?: ChatState;
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
    events_enabled: input.events_enabled ?? null,
    vars_enabled: input.vars_enabled ?? null,
    state: input.state,
    initial_state: input.initial_state ?? input.state,
    extracted_up_to: null,
    extracted_up_to_seq: null,
    archived: 0,
    created_at: t,
    updated_at: t,
  };
  db.prepare(
    `INSERT INTO chats (id, world_id, scenario_id, title, persona_id, participant_ids, model, narrator_enabled, events_enabled, vars_enabled, state, initial_state, extracted_up_to, extracted_up_to_seq, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id, c.world_id, c.scenario_id, c.title, c.persona_id, toJson(c.participant_ids),
    c.model, c.narrator_enabled, c.events_enabled, c.vars_enabled,
    toJson(c.state), toJson(c.initial_state),
    c.extracted_up_to, c.extracted_up_to_seq, c.archived, c.created_at, c.updated_at,
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
    // 初期ステートは作成時に確定させ、以後は書き換えない
    initial_state: cur.initial_state,
    state: patch.state ? { ...cur.state, ...patch.state } : cur.state,
    updated_at: now(),
  };
  db.prepare(
    `UPDATE chats SET scenario_id=?, title=?, persona_id=?, participant_ids=?, model=?, narrator_enabled=?, events_enabled=?, vars_enabled=?, state=?, extracted_up_to=?, extracted_up_to_seq=?, archived=?, updated_at=? WHERE id=?`,
  ).run(
    next.scenario_id, next.title, next.persona_id, toJson(next.participant_ids), next.model,
    next.narrator_enabled, next.events_enabled, next.vars_enabled,
    toJson(next.state), next.extracted_up_to, next.extracted_up_to_seq,
    next.archived, next.updated_at, id,
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
