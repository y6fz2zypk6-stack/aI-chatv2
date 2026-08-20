import { Router } from 'express';
import type { CalendarConfig, Scenario, ScenarioView } from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
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
import { toGameTime, toMinutes } from '../domain/calendar.js';
import { seedVars } from '../domain/vars.js';
import { parseUtterances } from '../llm/parse.js';

export const scenariosRouter = Router();

/**
 * 開始時刻の年月日時分（§4.5）。
 *
 * **換算はサーバだけが行う。** 暦は世界ごとに違う（月数・日数・曜日名）ので、
 * クライアントに計算を持たせると二重実装になる（`routes/chats.ts` のステート更新と同じ方針）。
 */

/** 保存した形に、ほどいた開始時刻を添えて返す */
const withGameTime = (s: Scenario, cal: CalendarConfig): ScenarioView => ({
  ...s,
  initial_game_time: toGameTime(cal, s.initial_state.time),
});

/**
 * `initial_state.game_time` が来ていたら通算分へ直す。
 *
 * **`game_time` は必ず消す。** `updateScenario` は initial_state を素で混ぜるので、
 * 残すと派生値がDBのJSONへ焼き付く。
 * 5つ揃っていなければ何もしない（`time` 直接指定の経路＝書き出し・取り込みを壊さない）。
 */
function applyGameTime(body: Record<string, unknown>, cal: CalendarConfig): void {
  const init = body.initial_state as (Record<string, unknown> & { time?: number }) | undefined;
  if (!init || typeof init !== 'object') return;
  const gt = init.game_time as
    | { year?: number; month?: number; day?: number; hh?: number; mm?: number }
    | undefined;
  delete init.game_time;
  if (!gt || ![gt.year, gt.month, gt.day, gt.hh, gt.mm].every((v) => Number.isFinite(v))) return;
  init.time = Math.max(0, toMinutes(cal, gt.year!, gt.month!, gt.day!, gt.hh!, gt.mm!));
}

scenariosRouter.get('/worlds/:id/scenarios', (req, res) => {
  // 暦は世界ごとに1回だけ引く（シナリオごとに引かない）
  const cal = getCalendar(req.params.id);
  res.json(listScenarios(req.params.id).map((s) => withGameTime(s, cal)));
});

scenariosRouter.post('/worlds/:id/scenarios', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const cal = getCalendar(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  applyGameTime(body, cal);
  res.status(201).json(withGameTime(createScenario(req.params.id, body), cal));
});

scenariosRouter.put('/scenarios/:id', (req, res) => {
  const cur = getScenario(req.params.id);
  if (!cur) {
    res.status(404).json({ error: 'シナリオが見つかりません' });
    return;
  }
  const cal = getCalendar(cur.world_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  applyGameTime(body, cal);
  const s = updateScenario(req.params.id, body);
  res.json(withGameTime(s!, cal));
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

  // §4.6: 初期ステートはここでコピーした値が正。以後シナリオを編集しても影響しない
  // 進行フラグは世界のスキーマの default で埋めてから、シナリオの指定で上書きする（v1.5.3 §2.3）
  const world = getWorld(scenario.world_id);
  const initialState = {
    ...scenario.initial_state,
    present: [...scenario.initial_state.present],
    vars: seedVars(world?.vars_schema ?? [], scenario.initial_state.vars),
  };
  const chat = createChat({
    world_id: scenario.world_id,
    scenario_id: scenario.id,
    persona_id: persona?.id ?? null,
    participant_ids: [...scenario.participant_ids],
    model: (req.body?.model as string | undefined) || '',
    narrator_enabled: scenario.narrator_enabled,
    state: initialState,
    initial_state: initialState,
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
