import { Router } from 'express';
import type { LorebookEntry } from '../../../shared/types.js';
import {
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  updateCharacter,
} from '../db/repo/characters.js';
import { chatsReferencingCharacter } from '../db/repo/chats.js';
import { createLorebookEntry } from '../db/repo/lorebook.js';
import {
  countMemories,
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
} from '../db/repo/memories.js';
import { removeCharacterFromScenarios } from '../db/repo/scenarios.js';
import { getWorld } from '../db/repo/worlds.js';

export const charactersRouter = Router();

charactersRouter.get('/worlds/:id/characters', (req, res) => {
  res.json(listCharacters(req.params.id));
});

charactersRouter.post('/worlds/:id/characters', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.status(201).json(createCharacter(req.params.id, req.body ?? {}));
});

charactersRouter.get('/characters/:id', (req, res) => {
  const c = getCharacter(req.params.id);
  if (!c) {
    res.status(404).json({ error: 'キャラクターが見つかりません' });
    return;
  }
  res.json({ ...c, memory_count: countMemories(c.id) });
});

charactersRouter.put('/characters/:id', (req, res) => {
  const c = updateCharacter(req.params.id, req.body ?? {});
  if (!c) {
    res.status(404).json({ error: 'キャラクターが見つかりません' });
    return;
  }
  res.json(c);
});

// §8.9: chats.participant_ids に参照があれば削除不可（restrict）
charactersRouter.delete('/characters/:id', (req, res) => {
  const c = getCharacter(req.params.id);
  if (!c) {
    res.status(404).json({ error: 'キャラクターが見つかりません' });
    return;
  }
  const refs = chatsReferencingCharacter(c.id);
  if (refs.length) {
    res.status(409).json({
      error: `以下のチャットで使用中のため削除できません: ${refs.map((r) => r.title).join('、')}。先にチャットを削除してください`,
      chats: refs,
    });
    return;
  }
  removeCharacterFromScenarios(c.id);
  deleteCharacter(c.id); // memories はCASCADE
  res.json({ ok: true });
});

// ---- Character Card V2 取り込み（§8.8） ----

interface V2Card {
  spec?: string;
  data?: {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    character_book?: { entries?: V2BookEntry[] };
    extensions?: Record<string, unknown>;
  };
}

interface V2BookEntry {
  keys?: string[];
  content?: string;
  enabled?: boolean;
  constant?: boolean;
  insertion_order?: number;
  priority?: number;
  name?: string;
  comment?: string;
  extensions?: { character_chat?: { category?: string } };
}

export function v2EntryToLore(e: V2BookEntry): Partial<LorebookEntry> {
  const category = e.extensions?.character_chat?.category;
  return {
    title: e.name || e.comment || e.keys?.[0] || '無題',
    keys: Array.isArray(e.keys) ? e.keys : [],
    content: e.content || '',
    enabled: e.enabled === false ? 0 : 1,
    always: e.constant ? 1 : 0,
    priority: e.insertion_order ?? e.priority ?? 0,
    category: (['世界観', '人物', '用語', 'イベント', 'その他'].includes(category ?? '')
      ? category
      : 'その他') as LorebookEntry['category'],
  };
}

charactersRouter.post('/worlds/:id/characters/import', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const card = (req.body ?? {}) as V2Card;
  if (card.spec !== 'chara_card_v2' || !card.data?.name) {
    res.status(400).json({ error: 'Character Card V2（chara_card_v2）形式ではありません' });
    return;
  }
  const d = card.data;
  const persona = [d.description, d.personality].filter(Boolean).join('\n\n');
  // 本アプリで書き出したカードの拡張（aliases / avatar / 口調 / 準レギュラー）を復元
  const ext = (d.extensions?.character_chat ?? {}) as {
    aliases?: string[];
    avatar?: string;
    speech_style?: string;
    is_npc_pool?: number;
  };
  const character = createCharacter(req.params.id, {
    name: d.name,
    persona,
    example_dialogue: d.mes_example || '',
    aliases: Array.isArray(ext.aliases) ? ext.aliases : [],
    avatar: ext.avatar || '',
    speech_style: ext.speech_style || '',
    is_npc_pool: ext.is_npc_pool ? 1 : 0,
  });
  let loreCount = 0;
  for (const e of d.character_book?.entries ?? []) {
    createLorebookEntry(req.params.id, { ...v2EntryToLore(e), character_id: character.id });
    loreCount++;
  }
  res.status(201).json({ character, imported_lore: loreCount, first_mes: d.first_mes || '' });
});

// ---- メモリー ----

charactersRouter.get('/characters/:id/memories', (req, res) => {
  res.json(listMemories(req.params.id));
});

charactersRouter.post('/characters/:id/memories', (req, res) => {
  if (!getCharacter(req.params.id)) {
    res.status(404).json({ error: 'キャラクターが見つかりません' });
    return;
  }
  res.status(201).json(createMemory(req.params.id, req.body ?? {}));
});

charactersRouter.put('/memories/:id', (req, res) => {
  const m = updateMemory(req.params.id, req.body ?? {});
  if (!m) {
    res.status(404).json({ error: 'メモリーが見つかりません' });
    return;
  }
  res.json(m);
});

charactersRouter.delete('/memories/:id', (req, res) => {
  if (!getMemory(req.params.id)) {
    res.status(404).json({ error: 'メモリーが見つかりません' });
    return;
  }
  deleteMemory(req.params.id);
  res.json({ ok: true });
});
