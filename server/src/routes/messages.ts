import { Router, type Response } from 'express';
import type { ChatState, Message, StateDelta, Utterance } from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
import { getChat, setChatState, updateChat } from '../db/repo/chats.js';
import { getCharacters, listCharacters } from '../db/repo/characters.js';
import { listLocations } from '../db/repo/locations.js';
import { listLorebook } from '../db/repo/lorebook.js';
import { listMemories } from '../db/repo/memories.js';
import {
  deleteMessage,
  getMessage,
  historyWindow,
  insertMessage,
  insertVariant,
  lastMessage,
  listVariants,
  nextVariantIndex,
  previousMessage,
  updateMessageActive,
} from '../db/repo/messages.js';
import { getDefaultPersona, getPersona } from '../db/repo/personas.js';
import { getScenario } from '../db/repo/scenarios.js';
import { getSettings } from '../db/repo/settings.js';
import { latestSummary } from '../db/repo/summaries.js';
import { getWorld } from '../db/repo/worlds.js';
import type { WorldEvent } from '../db/repo/events.js';
import { toGameTime, toTotalDay } from '../domain/calendar.js';
import { evaluateEvents, recordEventFires } from '../domain/events.js';
import { scopeEntries } from '../domain/lorebook.js';
import { runExtract } from '../domain/memory.js';
import { applyDelta } from '../domain/state.js';
import { maybeSummarize } from '../domain/summary.js';
import { extractStateSeparate } from '../llm/extract.js';
import { completeText, contextLengthOf, streamChat } from '../llm/openrouter.js';
import {
  FENCE_OPEN,
  fallbackDelta,
  parseStateDelta,
  parseUtterances,
  sanitizeResponse,
  splitFence,
  type ParseContext,
} from '../llm/parse.js';
import { assembleContext, type AssembleInput } from '../llm/prompt.js';

export const messagesRouter = Router();

/** 同一チャットへの同時生成の防止（§3.2・§5.8） */
const inflight = new Map<string, AbortController>();
/** フェンス連続欠落カウント（§5.7-2） */
const fenceMissStreak = new Map<string, number>();

// ---- コンテキスト収集 ----

export interface GatherResult {
  input: AssembleInput;
  parseCtx: ParseContext;
  personaName: string;
  model: string;
  firedEvents: WorldEvent[];
}

export async function gatherContext(
  chatId: string,
  baseState: ChatState,
  excludeMessageId: string | null,
): Promise<GatherResult> {
  const chat = getChat(chatId)!;
  const settings = getSettings();
  const world = getWorld(chat.world_id)!;
  const scenario = chat.scenario_id ? (getScenario(chat.scenario_id) ?? null) : null;
  const participants = getCharacters(chat.participant_ids);
  const npcPool = listCharacters(chat.world_id).filter(
    (c) => c.is_npc_pool === 1 && !chat.participant_ids.includes(c.id),
  );
  const persona =
    (chat.persona_id ? getPersona(chat.persona_id) : undefined) ??
    (settings.active_persona_id ? getPersona(settings.active_persona_id) : undefined) ??
    getDefaultPersona() ??
    null;
  const calendar = getCalendar(chat.world_id);
  const locations = listLocations(chat.world_id);
  const loreEntries = scopeEntries(listLorebook(chat.world_id), [
    ...chat.participant_ids,
    ...npcPool.map((c) => c.id),
  ]);
  const summary = latestSummary(chatId) ?? null;
  let history = historyWindow(chatId, summary?.up_to_message_id ?? null, settings.history_window);
  if (excludeMessageId) history = history.filter((m) => m.id !== excludeMessageId);

  // ロアのキーワード走査窓（§7.2）: 履歴窓とは独立に直近 lore_scan_window 件
  const scanMessages = history.slice(-settings.lore_scan_window);
  const loreScanText = scanMessages.map((m) => m.content).join('\n');

  const memories = [...participants, ...npcPool].map((character) => ({
    character,
    items: listMemories(character.id),
  }));

  // 日付が変わったターンの検出（§6.4 行7）: 基準時刻と直近の異なるステート時刻を比較
  let dayChanged = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i].state_after.time;
    if (t !== baseState.time) {
      dayChanged = toTotalDay(t) !== toTotalDay(baseState.time);
      break;
    }
  }

  const model = chat.model || settings.default_model;
  const contextLength = await contextLengthOf(model, settings.fallback_context_length);

  // pendingイベントの発火判定（§8.6）。記録は生成保存時に行う
  const firedEvents = evaluateEvents({
    worldId: chat.world_id,
    chatId,
    state: baseState,
    calendar,
    locations,
  });

  return {
    firedEvents,
    input: {
      eventInjects: firedEvents.map((e) => e.inject),
      settings,
      world,
      scenario,
      chat,
      participants,
      npcPool,
      persona,
      calendar,
      locations,
      loreEntries,
      loreScanText,
      memories,
      summary,
      history,
      baseState,
      dayChanged,
      contextLength,
    },
    parseCtx: { participants, npcPool, personaName: persona?.name || 'あなた' },
    personaName: persona?.name || 'あなた',
    model,
  };
}

// ---- SSEヘルパ ----

function sseInit(res: Response): (event: string, data: unknown) => void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// ---- 生成本体（§5.3・§5.6・§8.1） ----

messagesRouter.post('/chats/:id/messages', async (req, res) => {
  const chatId = req.params.id;
  const chat = getChat(chatId);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  if (inflight.has(chatId)) {
    res.status(409).json({ error: '他の端末で生成中です' });
    return;
  }

  const body = req.body ?? {};
  const modes = (['content', 'regenerate', 'retry', 'autoContinue'] as const).filter(
    (k) => body[k] !== undefined && body[k] !== null && body[k] !== false && body[k] !== '',
  );
  if (modes.length !== 1) {
    res.status(400).json({ error: 'content / regenerate / retry / autoContinue のいずれか1つを指定してください' });
    return;
  }
  const mode = modes[0];

  const settings = getSettings();
  const last = lastMessage(chatId);

  // ---- 基準ステートの決定（§8.1 ★重要）----
  let baseState: ChatState;
  let target: Message | null = null; // regenerate 対象

  if (mode === 'content') {
    const content = String(body.content ?? '').trim();
    if (!content) {
      res.status(400).json({ error: '本文が空です' });
      return;
    }
    // userメッセージの state_after は直前の値をコピー（§4.7）
    const userState = last?.state_after ?? chat.state;
    const persona =
      (chat.persona_id ? getPersona(chat.persona_id) : undefined) ?? getDefaultPersona();
    insertMessage({
      chat_id: chatId,
      role: 'user',
      content,
      utterances: [
        { speaker: 'user', name: persona?.name || 'あなた', text: content },
      ],
      state_after: userState,
    });
    if (!chat.title) {
      updateChat(chatId, { title: content.slice(0, 24) });
    }
    baseState = userState;
  } else if (mode === 'regenerate') {
    // 末尾assistantに候補を追加。基準は対象の1つ前のメッセージ（§8.5・§8.1）
    if (!last || last.role !== 'assistant') {
      res.status(400).json({ error: 'regenerate はチャット末尾がassistantの場合のみ可能です' });
      return;
    }
    target = last;
    const prev = previousMessage(chatId, last.id);
    baseState = prev?.state_after ?? chat.state;
  } else if (mode === 'retry') {
    // retry: 末尾userへの応答再試行。userは追加保存しない（§5.6）
    if (!last || last.role !== 'user') {
      res.status(400).json({ error: 'retry はチャット末尾がuserの場合のみ可能です' });
      return;
    }
    baseState = last.state_after;
  } else {
    // autoContinue: ユーザー入力なしでターンを進める（§8.7）。基準は現在の最後のメッセージ
    if (!last || last.role !== 'assistant') {
      res.status(400).json({ error: 'autoContinue はチャット末尾がassistantの場合のみ可能です' });
      return;
    }
    baseState = last.state_after;
  }

  // ---- コンテキスト組み立て ----
  let gathered: GatherResult;
  try {
    gathered = await gatherContext(chatId, baseState, target?.id ?? null);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }
  if (mode === 'autoContinue') gathered.input.autoContinueNudge = true;
  const assembled = assembleContext(gathered.input);
  if (assembled.overBudget) {
    // 必須項目だけで上限超過（§6.5）
    res.status(413).json({
      error: `必須コンテキストがモデルの入力予算を超えています（推定${assembled.estimatedTokens}tok / 予算${assembled.inputBudget}tok）`,
    });
    return;
  }

  // ---- SSEストリーミング（§5.3）----
  const send = sseInit(res);
  const abort = new AbortController();
  inflight.set(chatId, abort);

  // @@@STATE 出現以降は画面に流さない。フェンス断片の誤表示を防ぐため
  // 末尾 FENCE_OPEN.length 文字は常に保留してから送る
  let full = '';
  let visibleEmitted = 0;
  const emitVisible = (flushAll: boolean) => {
    const fenceIdx = full.indexOf(FENCE_OPEN);
    const limit =
      fenceIdx !== -1
        ? fenceIdx
        : flushAll
          ? full.length
          : Math.max(visibleEmitted, full.length - FENCE_OPEN.length);
    if (limit > visibleEmitted) {
      send('delta', { text: full.slice(visibleEmitted, limit) });
      visibleEmitted = limit;
    }
  };

  let aborted = false;
  let failed: string | null = null;
  try {
    const result = await streamChat({
      model: gathered.model,
      messages: assembled.messages,
      maxTokens: settings.max_tokens + 200, // §5.7: max_tokens到達でフェンスが切れる対策
      stop: assembled.stop,
      signal: abort.signal,
      onDelta: (text) => {
        full += text;
        emitVisible(false);
      },
    });
    full = result.text;
    aborted = result.aborted;
    emitVisible(true);
  } catch (err) {
    failed = (err as Error).message;
  } finally {
    inflight.delete(chatId);
  }

  if (failed) {
    // 生成失敗: assistantは保存しない。末尾がuserのまま残るので retry で再試行できる（§5.6）
    send('error', { message: failed });
    res.end();
    return;
  }

  // ---- 後処理: サニタイズ → フェンス分離 → 発話パース → ステート適用 ----
  const sanitized = sanitizeResponse(full, gathered.personaName);
  const { body: text, fence } = splitFence(sanitized);

  if (!text.trim()) {
    send('error', { message: aborted ? '生成が停止されました（本文なし）' : '生成結果が空でした' });
    res.end();
    return;
  }

  let delta: StateDelta;
  if (settings.state_enabled !== 1) {
    delta = fallbackDelta(0);
  } else if (aborted) {
    // §5.8: 停止時は elapsed 0 のフォールバック。停止操作でゲーム内時間を進めない
    delta = fallbackDelta(0);
  } else if (settings.state_extraction_mode === 'separate_call') {
    // §5.7-3: 本文生成後に軽量モデルで差分だけ抽出する
    const extracted = await extractStateSeparate({
      model: settings.utility_model || settings.default_model,
      body: text,
      baseState,
      locations: gathered.input.locations,
      characters: [...gathered.input.participants, ...gathered.input.npcPool],
    });
    if (extracted) {
      delta = extracted;
      fenceMissStreak.set(chatId, 0);
    } else {
      delta = fallbackDelta(10);
      fenceMissStreak.set(chatId, (fenceMissStreak.get(chatId) ?? 0) + 1);
    }
  } else {
    const parsed = parseStateDelta(fence);
    if (parsed) {
      delta = parsed;
      fenceMissStreak.set(chatId, 0);
    } else {
      // §5.7: フェンス欠落時は elapsed 10、その他変更なし
      delta = fallbackDelta(10);
      fenceMissStreak.set(chatId, (fenceMissStreak.get(chatId) ?? 0) + 1);
    }
  }

  const parseResult = parseUtterances(text, gathered.parseCtx);
  const content = text;
  const utterances: Utterance[] = parseResult.utterances;

  const applied = applyDelta(
    gathered.input.calendar,
    baseState,
    delta,
    gathered.input.locations,
    [...gathered.input.participants, ...gathered.input.npcPool],
  );

  const status = aborted ? 'stopped' : 'complete';
  const stateDeltaLog =
    fence ??
    (delta.fallback
      ? `(fallback) elapsed_minutes: ${delta.elapsed_minutes}`
      : `(separate_call) ${JSON.stringify(delta)}`);

  let messageId: string;
  if (target) {
    // regenerate: 対象メッセージに候補を追加し、表示中コピーを差し替える（§4.8）
    const idx = nextVariantIndex(target.id);
    insertVariant({
      message_id: target.id,
      index: idx,
      content,
      utterances,
      state_delta: stateDeltaLog,
      state_after: applied.state,
    });
    updateMessageActive(target.id, {
      content,
      utterances,
      state_after: applied.state,
      active_variant: idx,
      generation_status: status,
    });
    messageId = target.id;
  } else {
    // 通常送信 / retry: 新規assistant + index 0 のvariant（§4.8: 初回生成も必ず作る）
    const msg = insertMessage({
      chat_id: chatId,
      role: 'assistant',
      content,
      utterances,
      state_after: applied.state,
      generation_status: status,
    });
    insertVariant({
      message_id: msg.id,
      index: 0,
      content,
      utterances,
      state_delta: stateDeltaLog,
      state_after: applied.state,
    });
    messageId = msg.id;
  }

  setChatState(chatId, applied.state);

  // pendingイベントの発火を記録（§4.13。ゲーム内時刻 = 基準ステートの時刻）
  if (gathered.firedEvents.length) {
    recordEventFires(gathered.firedEvents, chatId, baseState.time);
  }

  // 要約・知識抽出はバックグラウンド（§8.3・§8.4）
  const { needed: needsSummary } = maybeSummarize(chatId, settings);
  if (needsSummary && settings.auto_extract === 1) {
    runExtract(chatId, settings).catch((err) =>
      console.error('[memory] 自動抽出に失敗:', (err as Error).message),
    );
  }

  // オートプレイの継続判定（§8.7）: 区切りが良ければ自動停止
  let autoplayShouldStop = false;
  if (mode === 'autoContinue' && settings.autoplay_judge === 1 && !aborted) {
    autoplayShouldStop = await judgeAutoplayStop(content, settings);
  }

  send('done', {
    messageId,
    content,
    utterances,
    state: applied.state,
    gameTime: toGameTime(gathered.input.calendar, applied.state.time),
    needsSummary,
    firedEvents: gathered.firedEvents.map((e) => e.title),
    warnings: [...parseResult.warnings, ...applied.warnings],
    stateWarnings: applied.warnings,
    fenceMissingStreak: fenceMissStreak.get(chatId) ?? 0,
    autoJoinSuggested: parseResult.autoJoinCharacterIds,
    generationStatus: status,
    autoplayShouldStop,
  });
  res.end();
});

/** CONTINUE/STOP の継続判定（§8.7）。判定不能時は継続 */
async function judgeAutoplayStop(
  lastResponse: string,
  settings: ReturnType<typeof getSettings>,
): Promise<boolean> {
  try {
    const raw = await completeText({
      model: settings.utility_model || settings.default_model,
      messages: [
        {
          role: 'user',
          content: `以下はロールプレイの直近の応答である。場面が区切り（会話の一段落・場面転換・ユーザーの判断が必要な地点）に達しているか判定し、CONTINUE か STOP のどちらか1語のみを出力せよ。\n\n${lastResponse.slice(-2000)}`,
        },
      ],
      maxTokens: 8,
    });
    return raw.trim().toUpperCase().includes('STOP');
  } catch {
    return false;
  }
}

// ---- 停止（§5.8）: クライアントabortではなくサーバ側AbortController ----
messagesRouter.post('/chats/:id/stop', (req, res) => {
  const ctl = inflight.get(req.params.id);
  if (!ctl) {
    res.status(404).json({ error: '生成中ではありません' });
    return;
  }
  ctl.abort();
  res.json({ ok: true });
});

// ---- 編集（§8.5）: 本文のみ修正。state_after は変更しない ----
messagesRouter.put('/messages/:id', (req, res) => {
  const msg = getMessage(req.params.id);
  if (!msg) {
    res.status(404).json({ error: 'メッセージが見つかりません' });
    return;
  }
  const content = String(req.body?.content ?? '');
  if (!content.trim()) {
    res.status(400).json({ error: '本文が空です' });
    return;
  }
  let utterances: Utterance[];
  if (msg.role === 'assistant') {
    const chat = getChat(msg.chat_id)!;
    const participants = getCharacters(chat.participant_ids);
    const npcPool = listCharacters(chat.world_id).filter(
      (c) => c.is_npc_pool === 1 && !chat.participant_ids.includes(c.id),
    );
    const persona =
      (chat.persona_id ? getPersona(chat.persona_id) : undefined) ?? getDefaultPersona();
    const parsed = parseUtterances(content, {
      participants,
      npcPool,
      personaName: persona?.name || 'あなた',
    });
    utterances = parsed.utterances;
  } else {
    utterances = msg.utterances.length
      ? [{ ...msg.utterances[0], text: content }]
      : [{ speaker: 'user', name: 'あなた', text: content }];
  }
  updateMessageActive(msg.id, { content, utterances });
  res.json(getMessage(msg.id));
});

// ---- 削除（§8.5）: 削除後の最新メッセージの state_after を chats.state に反映 ----
messagesRouter.delete('/messages/:id', (req, res) => {
  const msg = getMessage(req.params.id);
  if (!msg) {
    res.status(404).json({ error: 'メッセージが見つかりません' });
    return;
  }
  deleteMessage(msg.id);
  const chat = getChat(msg.chat_id);
  if (chat) {
    const last = lastMessage(chat.id);
    if (last) {
      setChatState(chat.id, last.state_after);
    } else if (chat.scenario_id) {
      const scenario = getScenario(chat.scenario_id);
      if (scenario) setChatState(chat.id, scenario.initial_state);
    }
  }
  res.json({ ok: true });
});

// ---- 候補切替（§8.5）: チャット末尾のassistantに対してのみ許可 ----
messagesRouter.put('/messages/:id/variant', (req, res) => {
  const msg = getMessage(req.params.id);
  if (!msg) {
    res.status(404).json({ error: 'メッセージが見つかりません' });
    return;
  }
  const last = lastMessage(msg.chat_id);
  if (!last || last.id !== msg.id) {
    res.status(409).json({
      error: '候補切替はチャットの最後のメッセージに対してのみ可能です（過去メッセージはforkで分岐してください）',
    });
    return;
  }
  const index = Number(req.body?.index);
  const variants = listVariants(msg.id);
  const v = variants.find((x) => x.index === index);
  if (!v) {
    res.status(404).json({ error: '指定の候補がありません' });
    return;
  }
  updateMessageActive(msg.id, {
    content: v.content,
    utterances: v.utterances,
    state_after: v.state_after,
    active_variant: v.index,
  });
  setChatState(msg.chat_id, v.state_after);
  res.json(getMessage(msg.id));
});

// ---- 候補・state_delta 生ログ一覧（ステート編集パネルのデバッグ表示用 §10.3） ----
messagesRouter.get('/messages/:id/variants', (req, res) => {
  const msg = getMessage(req.params.id);
  if (!msg) {
    res.status(404).json({ error: 'メッセージが見つかりません' });
    return;
  }
  res.json(listVariants(msg.id));
});
