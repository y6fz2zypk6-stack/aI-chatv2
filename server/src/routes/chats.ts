import { Router } from 'express';
import { db, toJson } from '../db/index.js';
import { getCalendar } from '../db/repo/calendars.js';
import { copyFiresForFork, deleteFire, firesOf, listEvents, listFires } from '../db/repo/events.js';
import { runEventPipeline } from '../domain/events.js';
import {
  createChat,
  deleteChat,
  getChat,
  listChats,
  setChatState,
  updateChat,
} from '../db/repo/chats.js';
import {
  getMessage,
  insertMessage,
  insertVariantAt,
  lastMessage,
  listMessages,
  listMessagesUpToSeq,
  listVariants,
  updateMessageActive,
} from '../db/repo/messages.js';
import { getScenario } from '../db/repo/scenarios.js';
import { getSettings, resolveFlag } from '../db/repo/settings.js';
import {
  deleteSummaries,
  insertSummary,
  latestSummary,
  updateSummaryContent,
} from '../db/repo/summaries.js';
import type { Chat, VarValue } from '../../../shared/types.js';
import { getWorld } from '../db/repo/worlds.js';
import { memoryDateLabel, toGameTime, toMinutes } from '../domain/calendar.js';
import { applyManualVars } from '../domain/vars.js';
import { extractCandidates, runExtract } from '../domain/memory.js';
import { normalizeState } from '../domain/state.js';
import { runSummarize } from '../domain/summary.js';
import { assembleContext } from '../llm/prompt.js';
import { gatherContext, visitIdOf } from './messages.js';

export const chatsRouter = Router();

chatsRouter.get('/chats', (req, res) => {
  const worldId = req.query.world_id as string | undefined;
  const archived = req.query.archived as string | undefined;
  res.json(
    listChats({
      worldId,
      archived: archived === undefined ? undefined : archived === '1',
    }),
  );
});

chatsRouter.get('/chats/:id', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  const calendar = getCalendar(chat.world_id);
  res.json({
    chat,
    messages: listMessages(chat.id),
    gameTime: toGameTime(calendar, chat.state.time),
    // 3段の解決結果と、どこで決まったか。UIが「いまはON（シナリオの設定）」と出せるようにする
    flags: resolvedFlags(chat),
  });
});

/** chat → scenario → 全体設定 の解決結果と、決め手になった段を返す（§3.4） */
function resolvedFlags(chat: Chat) {
  const settings = getSettings();
  const scenario = chat.scenario_id ? getScenario(chat.scenario_id) : undefined;
  const one = (
    chatValue: number | null,
    scenarioValue: number | null | undefined,
    globalValue: number,
  ) => ({
    enabled: resolveFlag(chatValue, scenarioValue, globalValue),
    from:
      chatValue !== null && chatValue !== undefined
        ? ('chat' as const)
        : scenarioValue !== null && scenarioValue !== undefined
          ? ('scenario' as const)
          : ('settings' as const),
  });
  return {
    events: one(chat.events_enabled, scenario?.events_enabled, settings.events_enabled),
    vars: one(chat.vars_enabled, scenario?.vars_enabled, settings.vars_enabled),
    /**
     * シナリオの段を飛ばしているか。
     * シナリオを削除すると chats.scenario_id は FK で NULL になるので、
     * 「参照先が見つからない」ではなく「参照が無い」で判定する
     */
    scenarioMissing: !scenario,
  };
}

chatsRouter.put('/chats/:id', (req, res) => {
  const chat = updateChat(req.params.id, req.body ?? {});
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  res.json(chat);
});

chatsRouter.delete('/chats/:id', (req, res) => {
  if (!getChat(req.params.id)) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  deleteChat(req.params.id);
  res.json({ ok: true });
});

// ---- 分岐（§8.5）----
// 指定メッセージまでをコピーした新チャットを作り、そのメッセージの state_after を
// 新チャットの chats.state にコピーする。variant_index 指定時はその候補を active として分岐
// （過去メッセージの候補切替の確定操作は fork に統一）。
chatsRouter.post('/chats/:id/fork', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  const messageId = String(req.body?.message_id ?? '');
  const target = getMessage(messageId);
  if (!target || target.chat_id !== chat.id) {
    res.status(404).json({ error: '分岐元メッセージが見つかりません' });
    return;
  }
  const variantIndex = req.body?.variant_index as number | undefined;
  let forkContent = target.content;
  let forkUtterances = target.utterances;
  let forkState = target.state_after;
  let forkActive = target.active_variant;
  if (variantIndex !== undefined) {
    const v = listVariants(target.id).find((x) => x.index === Number(variantIndex));
    if (!v) {
      res.status(404).json({ error: '指定の候補がありません' });
      return;
    }
    forkContent = v.content;
    forkUtterances = v.utterances;
    forkState = v.state_after;
    forkActive = v.index;
  }

  const newChat = createChat({
    world_id: chat.world_id,
    scenario_id: chat.scenario_id,
    title: `${chat.title || '無題'}（分岐）`,
    persona_id: chat.persona_id,
    participant_ids: [...chat.participant_ids],
    model: chat.model,
    narrator_enabled: chat.narrator_enabled,
    state: forkState,
    // 分岐は先頭からコピーするので、初期ステートは元Chatと同じものを引き継ぐ
    initial_state: chat.initial_state,
  });

  // メッセージと候補を昇順にコピー（seq は新チャット内で1から振り直される）
  const idMap = new Map<string, string>();
  for (const m of listMessagesUpToSeq(chat.id, target.seq)) {
    const isTarget = m.id === target.id;
    const copied = insertMessage({
      chat_id: newChat.id,
      role: m.role,
      content: isTarget ? forkContent : m.content,
      utterances: isTarget ? forkUtterances : m.utterances,
      state_after: isTarget ? forkState : m.state_after,
      generation_status: m.generation_status,
    });
    idMap.set(m.id, copied.id);
    const variants = listVariants(m.id);
    for (const v of variants) {
      insertVariantAt({
        message_id: copied.id,
        index: v.index,
        content: v.content,
        utterances: v.utterances,
        state_delta: v.state_delta,
        state_after: v.state_after,
      });
    }
    if (variants.length && (isTarget ? forkActive : m.active_variant) !== 0) {
      updateMessageActive(copied.id, { active_variant: isTarget ? forkActive : m.active_variant });
    }
  }

  // 発火履歴も引き継ぐ。コピーしないと分岐先で once イベントがもう一度起きる（v1.5.3 §8）
  copyFiresForFork(chat.id, newChat.id, target.seq, idMap);

  res.status(201).json(getChat(newChat.id));
});

// ---- ステート（§10.3）----

chatsRouter.get('/chats/:id/state', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  const calendar = getCalendar(chat.world_id);
  const last = lastMessage(chat.id);
  const world = getWorld(chat.world_id);
  const scenario = chat.scenario_id ? getScenario(chat.scenario_id) : null;
  const settings = getSettings();
  res.json({
    state: chat.state,
    gameTime: toGameTime(calendar, chat.state.time),
    calendar,
    lastMessageId: last?.id ?? null,
    // ステート編集UIの vars 欄と発火履歴の表示に使う（v1.5.3 §9.2）
    varsSchema: world?.vars_schema ?? [],
    varsEnabled: resolveFlag(chat.vars_enabled, scenario?.vars_enabled, settings.vars_enabled),
    eventsEnabled: resolveFlag(chat.events_enabled, scenario?.events_enabled, settings.events_enabled),
    fires: listFires(chat.id),
  });
});

// 発火履歴の取り消し（once イベントの誤爆を救済する。§9.2）
chatsRouter.delete('/chats/:id/fires/:fireId', (req, res) => {
  if (!getChat(req.params.id)) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  deleteFire(req.params.fireId);
  res.json({ ok: true });
});

// 手動編集: chats.state に加え、生成の基準となる末尾メッセージの state_after にも反映する
// （§8.1 の基準ステートは「直前メッセージの state_after」のため、両方揃えないと編集が効かない）
chatsRouter.put('/chats/:id/state', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const next = normalizeState(body, chat.state);
  // vars はスキーマで検証してから入れる（手動編集なので monotonic / system_only は課さない）
  if (body.vars && typeof body.vars === 'object') {
    const world = getWorld(chat.world_id);
    const r = applyManualVars(world?.vars_schema ?? [], body.vars as Record<string, VarValue>);
    next.vars = r.vars;
  }
  // 年月日・時分での指定を受けた場合はサーバ側で通算分へ変換する
  // （時刻演算は calendar.ts に一本化するため、クライアントでは変換しない）
  const gtInput = body.game_time as
    | { year?: number; month?: number; day?: number; hh?: number; mm?: number }
    | undefined;
  if (gtInput && [gtInput.year, gtInput.month, gtInput.day, gtInput.hh, gtInput.mm].every((v) => Number.isFinite(v))) {
    const cal = getCalendar(chat.world_id);
    next.time = Math.max(
      0,
      toMinutes(cal, gtInput.year!, gtInput.month!, gtInput.day!, gtInput.hh!, gtInput.mm!),
    );
  }
  setChatState(chat.id, next);
  const last = lastMessage(chat.id);
  if (last) {
    updateMessageActive(last.id, { state_after: next });
    const variants = listVariants(last.id);
    const active = variants.find((v) => v.index === last.active_variant);
    if (active) {
      // 表示中候補のスナップショットも揃える
      updateVariantState(active.id, next);
    }
  }
  const calendar = getCalendar(chat.world_id);
  res.json({ state: next, gameTime: toGameTime(calendar, next.time) });
});

function updateVariantState(variantId: string, state: unknown): void {
  db.prepare('UPDATE message_variants SET state_after = ? WHERE id = ?').run(
    toJson(state),
    variantId,
  );
}

// ---- プロンプトプレビュー（§9）----

chatsRouter.get('/chats/:id/prompt-preview', async (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  try {
    const last = lastMessage(chat.id);
    const baseState = last?.state_after ?? chat.state;
    const gathered = await gatherContext(chat.id, baseState, null);
    const a = assembleContext(gathered.input);
    const brief = (e: { id: string; title: string }) => ({ id: e.id, title: e.title });
    res.json({
      system: a.system,
      historyMessages: a.messages.slice(1, -1),
      situationBlock: a.situationBlock,
      lore: {
        fired: a.lore.fired.map(brief),
        adopted: a.lore.adopted.map(brief),
        dropped: a.lore.dropped.map(brief),
      },
      estimatedTokens: a.estimatedTokens,
      inputBudget: a.inputBudget,
      trimmed: a.trimmed,
      overBudget: a.overBudget,
      model: gathered.model,
      stop: a.stop,
      // v1.5.3 §9.4: 進行状況ブロックと、そのターンのイベント判定を見せる
      varsBlock: gathered.input.varsBlock ?? '',
      varsEnabled: gathered.pipeline.varsEnabled,
      eventsEnabled: gathered.pipeline.eventsEnabled,
      eventRows: gathered.pipeline.eventsEnabled
        ? runEventPipeline({
            chatId: chat.id,
            events: listEvents(chat.world_id),
            // プレビューは「いま生成したらどうなるか」なので、前後とも現在ステートで見る
            baseState,
            newState: baseState,
            calendar: gathered.input.calendar,
            locations: gathered.input.locations,
            varsSchema: gathered.pipeline.varsSchema,
            varsEnabled: gathered.pipeline.varsEnabled,
            baseMessageId: last?.id ?? chat.id,
            visitId: visitIdOf(chat.id, baseState),
            firesByEvent: new Map(
              listEvents(chat.world_id).map((e) => [e.id, firesOf(chat.id, e.id)]),
            ),
            maxPerTurn: Math.max(1, getSettings().event_max_per_turn),
          }).rows
        : [],
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---- 要約（§8.3）----

chatsRouter.get('/chats/:id/summary', (req, res) => {
  res.json(latestSummary(req.params.id) ?? null);
});

chatsRouter.put('/chats/:id/summary', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  const content = String(req.body?.content ?? '');
  const cur = latestSummary(chat.id);
  if (cur) {
    updateSummaryContent(cur.id, content);
    res.json({ ...cur, content });
  } else {
    const last = lastMessage(chat.id);
    if (!last) {
      res.status(400).json({ error: 'メッセージがないため要約を保存できません' });
      return;
    }
    res.json(insertSummary(chat.id, last.id, last.seq, content));
  }
});

chatsRouter.post('/chats/:id/summarize', async (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  try {
    const content = await runSummarize(chat.id, getSettings());
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

chatsRouter.delete('/chats/:id/summary', (req, res) => {
  deleteSummaries(req.params.id);
  res.json({ ok: true });
});

// ---- 知識抽出（§8.4）----

/** 保存せずに候補と理由だけ返す。抽出条件を調整するための確認用 */
chatsRouter.post('/chats/:id/extract-preview', async (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  try {
    // 手動確認では下限を無視する（少ない範囲でも試せるようにする）
    const result = await extractCandidates(chat.id, getSettings(), { ignoreMinimum: true });
    // 日付は「保存後にプロンプトへ入る形」で見せる（現在時刻からの相対）
    const cal = getCalendar(chat.world_id);
    res.json({
      ...result,
      candidates: result.candidates.map((c) => ({
        ...c,
        game_time_label: memoryDateLabel(cal, c.game_time, chat.state.time),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

chatsRouter.post('/chats/:id/extract', async (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  try {
    res.json(await runExtract(chat.id, getSettings()));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
