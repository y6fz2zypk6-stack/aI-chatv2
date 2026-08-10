import { Router, type Response } from 'express';
import type {
  Character,
  ChatState,
  LorebookEntry,
  Scenario,
  VarSchemaEntry,
  WorldArea,
  WorldEvent,
} from '../../../shared/types.js';
import { getCalendar, upsertCalendar } from '../db/repo/calendars.js';
import { getChat } from '../db/repo/chats.js';
import { createCharacter, getCharacter, listCharacters } from '../db/repo/characters.js';
import { createEvent, listEvents } from '../db/repo/events.js';
import { createLocation, getLocation, listLocations } from '../db/repo/locations.js';
import { createLorebookEntry, listLorebook } from '../db/repo/lorebook.js';
import { createMemory, listMemories } from '../db/repo/memories.js';
import { listMessages, listVariants } from '../db/repo/messages.js';
import { createScenario, listScenarios } from '../db/repo/scenarios.js';
import { latestSummary } from '../db/repo/summaries.js';
import { createWorld, getWorld, updateWorld } from '../db/repo/worlds.js';

export const exportsRouter = Router();

/** RFC 5987 でエンコードし日本語ファイル名を落とさない（§8.8） */
function attachment(res: Response, filename: string): void {
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.json"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
}

// ---- 会話の書き出し（JSON: 候補含む全データ ／ テキスト §8.8）----

exportsRouter.get('/chats/:id/export', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  const messages = listMessages(chat.id);
  const title = chat.title || '無題の会話';

  if (req.query.format === 'text') {
    const text = messages.map((m) => m.content).join('\n\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    attachment(res, `${title}.txt`);
    res.send(text);
    return;
  }

  attachment(res, `${title}.json`);
  res.json({
    format: 'character_chat_conversation',
    version: 1,
    chat,
    messages: messages.map((m) => ({ ...m, variants: listVariants(m.id) })),
    summary: latestSummary(chat.id) ?? null,
  });
});

// ---- キャラクターの書き出し（Character Card V2 §8.8）----

exportsRouter.get('/characters/:id/export', (req, res) => {
  const c = getCharacter(req.params.id);
  if (!c) {
    res.status(404).json({ error: 'キャラクターが見つかりません' });
    return;
  }
  const lore = listLorebook(c.world_id).filter((e) => e.character_id === c.id);
  attachment(res, `${c.name}.json`);
  res.json({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: c.name,
      description: c.persona,
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: c.example_dialogue,
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      character_book: {
        entries: lore.map((e, i) => ({
          keys: e.keys,
          content: e.content,
          enabled: e.enabled === 1,
          constant: e.always === 1,
          insertion_order: e.priority,
          name: e.title,
          id: i,
          extensions: { character_chat: { category: e.category } },
        })),
      },
      extensions: {
        character_chat: {
          aliases: c.aliases,
          avatar: c.avatar,
          speech_style: c.speech_style,
          is_npc_pool: c.is_npc_pool,
        },
      },
    },
  });
});

// ---- 世界一式の書き出し・取り込み（独自JSON §8.8）----

exportsRouter.get('/worlds/:id/export', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const characters = listCharacters(world.id);
  attachment(res, `${world.name}.json`);
  res.json({
    format: 'character_chat_world',
    version: 1,
    world,
    calendar: getCalendar(world.id),
    characters: characters.map((c) => ({ ...c, memories: listMemories(c.id) })),
    lorebook: listLorebook(world.id),
    locations: listLocations(world.id),
    events: listEvents(world.id),
    scenarios: listScenarios(world.id),
  });
});

interface WorldImport {
  format?: string;
  world?: {
    name?: string;
    description?: string;
    system_prompt?: string;
    narrator_prompt?: string;
    areas?: WorldArea[];
    vars_schema?: VarSchemaEntry[];
  };
  calendar?: Record<string, unknown>;
  characters?: (Partial<Character> & {
    id?: string;
    memories?: {
      subject?: string;
      content?: string;
      pinned?: number;
      game_time?: number | null;
      enabled?: number;
    }[];
  })[];
  lorebook?: (Partial<LorebookEntry> & { character_id?: string | null })[];
  locations?: { id?: string; name?: string; indoor?: number; area?: string; open_min?: number | null; close_min?: number | null; note?: string }[];
  events?: Record<string, unknown>[];
  scenarios?: (Partial<Scenario> & { initial_state?: Partial<ChatState> })[];
}

exportsRouter.post('/worlds/import', (req, res) => {
  const data = (req.body ?? {}) as WorldImport;
  if (data.format !== 'character_chat_world' || !data.world?.name) {
    res.status(400).json({ error: 'character_chat_world 形式のJSONではありません' });
    return;
  }

  const world = createWorld(data.world);
  upsertCalendar(world.id, data.calendar ?? {});

  // キャラは新IDを発行し、旧ID→新IDの対応表で参照を張り替える
  const idMap = new Map<string, string>();
  for (const c of data.characters ?? []) {
    const created = createCharacter(world.id, c);
    if (c.id) idMap.set(c.id, created.id);
    for (const m of c.memories ?? []) {
      if (!m.content) continue;
      createMemory(created.id, {
        subject: m.subject ? (idMap.get(m.subject) ?? m.subject) : '',
        content: m.content,
        pinned: m.pinned ?? 0,
        // 暦は世界ごと持ち出すので、ゲーム内時刻はそのまま持ち込める
        game_time: m.game_time ?? null,
        enabled: m.enabled ?? 1,
      });
    }
  }
  const remap = (id: string | null | undefined): string | null =>
    id ? (idMap.get(id) ?? null) : null;

  // 場所IDはグローバル一意（PUT /locations/:id のAPI形状のため）。
  // 衝突時は接尾辞を付けて取り込み、参照（ロアの場所トリガー・シナリオ初期ステート）を張り替える
  const locMap = new Map<string, string>();
  for (const l of data.locations ?? []) {
    if (!l.id || !/^[a-z0-9_]+$/.test(l.id)) continue;
    let newId = l.id;
    for (let n = 2; getLocation(newId); n++) newId = `${l.id}_${n}`;
    locMap.set(l.id, newId);
    createLocation(world.id, { ...l, id: newId, note: l.note ?? '' });
  }
  const remapLoc = (id: string | null | undefined): string =>
    id ? (locMap.get(id) ?? id) : '';

  // 古い書き出し（areas を持たない）から取り込むと、場所が参照するエリアが
  // 世界の一覧に無い状態になり得る。使われているエリアは必ず選べるようにしておく
  {
    const areas = [...world.areas];
    const known = new Set(areas.map((a) => a.id));
    for (const l of listLocations(world.id)) {
      if (l.area && !known.has(l.area)) {
        known.add(l.area);
        areas.push({ id: l.area, name: l.area });
      }
    }
    if (areas.length !== world.areas.length) updateWorld(world.id, { areas });
  }

  for (const e of data.lorebook ?? []) {
    createLorebookEntry(world.id, {
      ...e,
      character_id: remap(e.character_id),
      trigger_locations: (e.trigger_locations ?? []).map((id) => remapLoc(id)),
    });
  }
  for (const e of data.events ?? []) {
    createEvent(world.id, e as Partial<WorldEvent>);
  }
  for (const s of data.scenarios ?? []) {
    createScenario(world.id, {
      ...s,
      participant_ids: (s.participant_ids ?? [])
        .map((id) => idMap.get(id))
        .filter((id): id is string => !!id),
      default_persona_id: null,
      initial_state: s.initial_state
        ? ({
            ...s.initial_state,
            location: remapLoc(s.initial_state.location),
            present: (s.initial_state.present ?? [])
              .map((id) => idMap.get(id))
              .filter((id): id is string => !!id),
          } as ChatState)
        : undefined,
    });
  }

  res.status(201).json({
    world,
    imported: {
      characters: data.characters?.length ?? 0,
      lorebook: data.lorebook?.length ?? 0,
      locations: data.locations?.length ?? 0,
      events: data.events?.length ?? 0,
      scenarios: data.scenarios?.length ?? 0,
    },
  });
});
