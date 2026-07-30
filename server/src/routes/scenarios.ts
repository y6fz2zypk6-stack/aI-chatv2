import { Router } from 'express';
import { createChat } from '../db/repo/chats.js';
import { getCharacters, listCharacters } from '../db/repo/characters.js';
import { insertMessage, insertVariant } from '../db/repo/messages.js';
import { getDefaultPersona, getPersona } from '../db/repo/personas.js';
import {
  createScenario,
  deleteScenario,
  getScenario,
  listScenarios,
  updateScenario,
} from '../db/repo/scenarios.js';
import { getSettings } from '../db/repo/settings.js';
import { getWorld } from '../db/repo/worlds.js';
import { parseUtterances } from '../llm/parse.js';

export const scenariosRouter = Router();

scenariosRouter.get('/worlds/:id/scenarios', (req, res) => {
  res.json(listScenarios(req.params.id));
});

scenariosRouter.post('/worlds/:id/scenarios', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.status(201).json(createScenario(req.params.id, req.body ?? {}));
});

scenariosRouter.put('/scenarios/:id', (req, res) => {
  const s = updateScenario(req.params.id, req.body ?? {});
  if (!s) {
    res.status(404).json({ error: 'シナリオが見つかりません' });
    return;
  }
  res.json(s);
});

// §8.9: Scenario は削除可。chats.scenario_id は FK で SET NULL
scenariosRouter.delete('/scenarios/:id', (req, res) => {
  if (!getScenario(req.params.id)) {
    res.status(404).json({ error: 'シナリオが見つかりません' });
    return;
  }
  deleteScenario(req.params.id);
  res.json({ ok: true });
});

// ---- Chat作成（§4.6: Scenarioからのコピー）----
scenariosRouter.post('/scenarios/:id/chats', (req, res) => {
  const scenario = getScenario(req.params.id);
  if (!scenario) {
    res.status(404).json({ error: 'シナリオが見つかりません' });
    return;
  }
  const settings = getSettings();
  const personaId =
    (req.body?.persona_id as string | undefined) ||
    scenario.default_persona_id ||
    settings.active_persona_id ||
    getDefaultPersona()?.id ||
    null;
  const persona = personaId ? getPersona(personaId) : undefined;

  const chat = createChat({
    world_id: scenario.world_id,
    scenario_id: scenario.id,
    persona_id: persona?.id ?? null,
    participant_ids: [...scenario.participant_ids],
    model: (req.body?.model as string | undefined) || '',
    narrator_enabled: scenario.narrator_enabled,
    state: { ...scenario.initial_state, present: [...scenario.initial_state.present] },
  });

  // 冒頭の応答文（話者ラベル付きの生テキスト）を最初のassistantとして保存
  if (scenario.opening.trim()) {
    const participants = getCharacters(chat.participant_ids);
    const npcPool = listCharacters(chat.world_id).filter(
      (c) => c.is_npc_pool === 1 && !chat.participant_ids.includes(c.id),
    );
    const parsed = parseUtterances(scenario.opening.trim(), {
      participants,
      npcPool,
      personaName: persona?.name || 'あなた',
    });
    const msg = insertMessage({
      chat_id: chat.id,
      role: 'assistant',
      content: scenario.opening.trim(),
      utterances: parsed.utterances,
      state_after: chat.state,
      generation_status: 'complete',
    });
    insertVariant({
      message_id: msg.id,
      content: msg.content,
      utterances: parsed.utterances,
      state_delta: '(opening)',
      state_after: chat.state,
    });
  }

  res.status(201).json(chat);
});
