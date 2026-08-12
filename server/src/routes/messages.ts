import { Router, type Response } from 'express';
import type {
  CalendarConfig,
  Character,
  Chat,
  ChatState,
  EventEvalRow,
  GenerationStatus,
  Location,
  Message,
  Notice,
  Settings,
  StateDelta,
  Utterance,
  VarSchemaEntry,
  WorldEvent,
} from '../../../shared/types.js';
import { db, toJson } from '../db/index.js';
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
  listMessages,
  listVariants,
  previousMessage,
  updateMessageActive,
} from '../db/repo/messages.js';
import { getDefaultPersona, getPersona } from '../db/repo/personas.js';
import { getScenario } from '../db/repo/scenarios.js';
import { getSettings, resolveFlag } from '../db/repo/settings.js';
import { latestSummary } from '../db/repo/summaries.js';
import { getWorld } from '../db/repo/worlds.js';
import {
  deleteFiresFromSeq,
  deleteFiresOfMessage,
  firesAtMessage,
  firesOf,
  getEvent,
  listEvents,
  recordFire,
} from '../db/repo/events.js';
import { MIN_PER_DAY, formatGameTime, toGameTime, toMinutes, toTotalDay } from '../domain/calendar.js';
import { buildEventBlocks, runEventPipeline } from '../domain/events.js';
import { applyVarOps, buildVarsBlock, varsInstruction } from '../domain/vars.js';
import { seededRand } from '../util/random.js';
import { scopeEntries } from '../domain/lorebook.js';
import { maybeExtract } from '../domain/memory.js';
import { applyDelta } from '../domain/state.js';
import { maybeSummarize } from '../domain/summary.js';
import { extractStateSeparate } from '../llm/extract.js';
import { completeText, contextLengthOf, streamChat, streamTimeoutSeconds } from '../llm/openrouter.js';
import {
  FENCE_OPEN,
  fallbackDelta,
  parseStateDelta,
  parseUtterances,
  personaCollisions,
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
  /** 判定パイプラインで使う文脈（生成完了後に走らせる） */
  pipeline: {
    chat: Chat;
    settings: Settings;
    calendar: CalendarConfig;
    locations: Location[];
    varsSchema: VarSchemaEntry[];
    varsEnabled: boolean;
    eventsEnabled: boolean;
    characters: Character[];
  };
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
  let history = historyWindow(chatId, summary?.up_to_seq ?? 0, settings.history_window);
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

  // 有効化スイッチの3段解決（v1.5.3 §1.1）
  const varsEnabled = resolveFlag(chat.vars_enabled, scenario?.vars_enabled, settings.vars_enabled);
  const eventsEnabled = resolveFlag(
    chat.events_enabled,
    scenario?.events_enabled,
    settings.events_enabled,
  );

  // イベントの注入は「前のターンに採用された分」を載せる（v1.5.3 §6）。
  // 判定は生成完了後に走るため、このターンのプロンプトには直前の結果が入る。
  //
  // 発火は assistant のメッセージにだけ紐づく。ここで単純に履歴の末尾を見ると、
  // 送信時はユーザー発言を先に保存してから組み立てるため常に user を指してしまい、
  // 採用したイベントが実際のプロンプトに載らない（プレビューだけ載る）。
  // 必ず直近の assistant まで遡ること。
  const prevMessage = [...history].reverse().find((m) => m.role === 'assistant');
  let eventFacts = '';
  let eventInstructions = '';
  if (eventsEnabled && prevMessage) {
    const fires = firesAtMessage(chatId, prevMessage.id);
    const fired = fires
      .map((f) => getEvent(f.event_id))
      .filter((e): e is WorldEvent => !!e && !!e.inject);
    const blocks = buildEventBlocks(fired);
    eventFacts = blocks.facts;
    eventInstructions = blocks.instructions;
  }

  return {
    input: {
      varsBlock: varsEnabled ? buildVarsBlock(world.vars_schema, baseState.vars) : '',
      varsInstruction: varsEnabled ? varsInstruction(world.vars_schema) : '',
      eventFacts,
      eventInstructions,
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
    pipeline: {
      chat,
      settings,
      calendar,
      locations,
      varsSchema: world.vars_schema,
      varsEnabled,
      eventsEnabled,
      characters: [...participants, ...npcPool],
    },
  };
}

/** そのチャットの発火履歴を event_id ごとにまとめる */
function groupFires(chatId: string) {
  const map = new Map<string, ReturnType<typeof firesOf>>();
  for (const e of listEvents(getChat(chatId)!.world_id)) {
    map.set(e.id, firesOf(chatId, e.id));
  }
  return map;
}

/** 表示中候補の state_after を書き戻す（§6.4） */
function updateVariantState(variantId: string, state: ChatState): void {
  db.prepare('UPDATE message_variants SET state_after = ? WHERE id = ?').run(toJson(state), variantId);
}

/**
 * once_per_visit の訪問ID（v1.5.3 §6.1）。
 * 「その場所へ入った契機となる最新の location 変更メッセージID」。
 * initial_state の場所から一度も移動していない場合は chat_id + ":initial"。
 * location_note 使用中は訪問IDを作らない（対象外になる）。
 */
export function visitIdOf(chatId: string, state: ChatState): string | null {
  if (state.location_note) return null;
  const msgs = listMessages(chatId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const cur = msgs[i].state_after;
    if (cur.location !== state.location) break;
    const prev = i > 0 ? msgs[i - 1].state_after : null;
    if (!prev || prev.location !== cur.location) return msgs[i].id;
  }
  return `${chatId}:initial`;
}

// ---- SSEヘルパ ----

function sseInit(res: Response): (event: string, data: unknown) => void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (event, data) => {
    // done のあとも notice のために開けたままにするので、その間に画面を閉じられ得る。
    // 切れたソケットへの書き込みで落とさない
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* 接続が切れただけ。生成側の処理は続行する */
    }
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
  const body = req.body ?? {};
  const modes = (['content', 'regenerate', 'retry', 'autoContinue'] as const).filter(
    (k) => body[k] !== undefined && body[k] !== null && body[k] !== false && body[k] !== '',
  );
  if (modes.length !== 1) {
    res.status(400).json({ error: 'content / regenerate / retry / autoContinue のいずれか1つを指定してください' });
    return;
  }
  const mode = modes[0];

  // ---- ここからステート確定までが1区間（§5.4）----
  // ロックは「userメッセージの保存」「コンテキスト組み立て」より前に取る。
  // 組み立てはモデル情報の取得で待つことがあり（キャッシュが冷えているとき）、
  // その隙に2本目が入ると user が二重に保存され、AbortController も上書きされる。
  if (inflight.has(chatId)) {
    res.status(409).json({ error: '他の端末で生成中です' });
    return;
  }
  const abort = new AbortController();
  inflight.set(chatId, abort);
  // 何度呼んでも安全にする。区間の終わりで明示的に外し、
  // 途中で return / throw した場合は末尾の finally が拾う
  let lockHeld = true;
  const releaseLock = (): void => {
    if (!lockHeld) return;
    lockHeld = false;
    inflight.delete(chatId);
  };

  try {
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
      // 場面転換マーカーは生成された応答ではないので、作り直しの対象にしない
      // （やり直すと場面転換が消えて普通の応答に化ける）
      if (last.kind === 'scene_break') {
        res.status(400).json({ error: '場面転換は作り直せません。消してから進め直してください' });
        return;
      }
      target = last;
      const prev = previousMessage(chatId, last.seq);
      // 直前が無い（＝先頭メッセージの再生成）場合はChatの初期ステートを基準にする。
      // chats.state を使うと再生成のたびに経過時間が積み重なる（§8.1）。
      baseState = prev?.state_after ?? chat.initial_state;
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
      aborted = result.outcome === 'user_abort';
      // 上流の無応答は「停止」ではない。stopped として握り潰すと、
      // 中途半端な本文が保存されたうえに原因が利用者に伝わらない（§5.7）
      if (result.outcome === 'connect_timeout' || result.outcome === 'idle_timeout') {
        const reason = result.outcome === 'connect_timeout'
          ? `モデルからの応答が始まりませんでした（${streamTimeoutSeconds.connect}秒待ちました）`
          : `モデルからの応答が途切れました（${streamTimeoutSeconds.idle}秒待ちました）`;
        const got = result.text.length > 0 ? `（受信していた${result.text.length}文字は保存していません）` : '';
        failed = `${reason}。生成を中断しました${got}。もう一度試してください`;
      }
      emitVisible(true);
    } catch (err) {
      // streamChat が停止を拾いきれなかった場合の受け皿。
      // 停止操作を「通信・API失敗」として見せないための最後の砦（§5.7）
      if (abort.signal.aborted) aborted = true;
      else failed = (err as Error).message;
    }


    // 生成〜ステート確定までを1つの区間として扱う（§5.4）。
    // ストリームが終わった時点でロックを外すと、assistant・候補・発火履歴・
    // chats.state を書き終える前に次のターンが始まり、古い lastMessage を
    // 基準にしてしまう（メッセージの並び自体も崩れる）。
    // done 以降の要約・知識抽出はこの区間に含めない。
    let messageId = '';
    let content = '';
    let utterances: Utterance[] = [];
    let status: GenerationStatus = 'complete';
    let finalState: ChatState = baseState;
    // warnings は本文の後処理 + 発話パース + ステート適用、stateWarnings はステート適用だけ。
    // 用途が違うので分けて持つ（混ぜると「時間や場所の警告」の絞り込みができなくなる）
    let warnings: string[] = [];
    let stateWarnings: string[] = [];
    // 本文を整えた段階で出た警告（代弁の切り詰めなど）。
    // warnings は下で組み直すので、ここへ溜めてから合流させる
    const bodyWarnings: string[] = [];
    let firedTitles: string[] = [];
    let eventRows: EventEvalRow[] = [];
    let autoJoinSuggested: string[] = [];
    try {
      if (failed) {
        // 生成失敗: assistantは保存しない。末尾がuserのまま残るので retry で再試行できる（§5.6）
        send('error', { message: failed });
        res.end();
        return;
      }

      // ---- 後処理: フェンス分離 → サニタイズ → 発話パース → ステート適用 ----
      //
      // **フェンス分離を先にする。** サニタイズは代弁行で以降を捨てるので、
      // 逆順にすると「代弁 → フェンス」の応答でフェンスまで消え、
      // フェンス欠落として扱われる（利用者は無関係な方向を調べることになる）
      const { body: rawBody, fence } = splitFence(full);
      const sanitized = sanitizeResponse(rawBody, gathered.personaName);
      const text = sanitized.text;
      if (sanitized.impersonated) {
        bodyWarnings.push('あなたの発言を代弁した行があったため、その行以降を削除しました');
      }
      // 名前の衝突は解決順より手前で効くので、設定の問題として毎回知らせる（§5.2）
      bodyWarnings.push(...personaCollisions(gathered.personaName, gathered.parseCtx));

      if (!text.trim()) {
        // 名前の衝突や代弁で全部切り落とされた場合、「空でした」だけでは原因が分からない。
        // 本文を整える段階で気づいたことをそのまま添える
        const why = bodyWarnings.length > 0 ? `。${bodyWarnings.join(' / ')}` : '';
        send('error', {
          message: aborted ? '生成が停止されました（本文なし）' : `生成結果が空でした${why}`,
        });
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
      content = text;
      utterances = parseResult.utterances;
      autoJoinSuggested = parseResult.autoJoinCharacterIds;

      const pl = gathered.pipeline;
      const applied = applyDelta(
        gathered.input.calendar,
        baseState,
        delta,
        gathered.input.locations,
        pl.characters,
        {
          // 天候はシード固定（§7）。再生成しても同じ日なら同じ天気になる
          rand: seededRand(`${chatId}:weather:${Math.floor((baseState.time + delta.elapsed_minutes) / 1440)}`),
          varsSchema: pl.varsSchema,
          varsEnabled: pl.varsEnabled,
        },
      );

      status = aborted ? 'stopped' : 'complete';
      const stateDeltaLog =
        fence ??
        (delta.fallback
          ? `(fallback) elapsed_minutes: ${delta.elapsed_minutes}`
          : `(separate_call) ${JSON.stringify(delta)}`);

      if (target) {
        // 作り直す候補の分は判定をやり直すので、このメッセージの発火履歴を消す（v1.5.3）
        deleteFiresOfMessage(chatId, target.id);
        // regenerate: 対象メッセージに候補を追加し、表示中コピーを差し替える（§4.8）
        const v = insertVariant({
          message_id: target.id,
          content,
          utterances,
          state_delta: stateDeltaLog,
          state_after: applied.state,
        });
        updateMessageActive(target.id, {
          content,
          utterances,
          state_after: applied.state,
          active_variant: v.index,
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
          content,
          utterances,
          state_delta: stateDeltaLog,
          state_after: applied.state,
        });
        messageId = msg.id;
      }

      // ---- 判定パイプライン（v1.5.3 §6）----
      // assistant の state_after が確定した直後にのみ走る。注入は次ターンのプロンプトへ。
      // 途中で停止した場合は走らせず、次のターンで改めて判定させる。
      finalState = applied.state;
      if (status === 'complete' && pl.eventsEnabled) {
        const result = runEventPipeline({
          chatId,
          events: listEvents(chat.world_id),
          baseState,
          newState: applied.state,
          calendar: gathered.input.calendar,
          locations: gathered.input.locations,
          varsSchema: pl.varsSchema,
          varsEnabled: pl.varsEnabled,
          baseMessageId: lastMessage(chatId)?.id ?? chatId,
          visitId: visitIdOf(chatId, applied.state),
          firesByEvent: groupFires(chatId),
          maxPerTurn: Math.max(1, pl.settings.event_max_per_turn),
        });
        eventRows = result.rows;

        // set_vars の適用と発火記録は1トランザクションで揃える（§6.4）
        const commit = db.transaction(() => {
          let state = applied.state;
          for (const { event, scopeKey } of result.adopted) {
            if (pl.varsEnabled && event.set_vars.length) {
              const r = applyVarOps(pl.varsSchema, state.vars, event.set_vars);
              state = { ...state, vars: r.vars };
              applied.warnings.push(...r.warnings);
            }
            recordFire({
              chat_id: chatId,
              event_id: event.id,
              message_id: messageId,
              fired_at_time: applied.state.time,
              scope_key: scopeKey,
            });
            firedTitles.push(event.title);
          }
          if (state !== applied.state) {
            // 確定済みの state_after を書き戻す。表示中の候補も必ず揃える（§6.4）
            updateMessageActive(messageId, { state_after: state });
            const active = listVariants(messageId).find(
              (v) => v.index === (getMessage(messageId)?.active_variant ?? 0),
            );
            if (active) updateVariantState(active.id, state);
          }
          finalState = state;
        });
        commit();
      }

      stateWarnings = applied.warnings;
      warnings = [...bodyWarnings, ...parseResult.warnings, ...applied.warnings];
      setChatState(chatId, finalState);
    } finally {
      releaseLock();
    }

    // 要約・知識抽出はバックグラウンド（§8.3・§8.4）。
    // 互いに独立して判定する（auto_summarize を切っても自動抽出は動く）。
    // 結果は done のあとに notice として流す（§5.9）
    const summaryTask = maybeSummarize(chatId, settings);
    const extractTask = maybeExtract(chatId, settings);
    const needsSummary = summaryTask.needed;

    // オートプレイの継続判定（§8.7）: 区切りが良ければ自動停止
    let autoplayShouldStop = false;
    if (mode === 'autoContinue' && settings.autoplay_judge === 1 && !aborted) {
      autoplayShouldStop = await judgeAutoplayStop(content, settings);
    }

    send('done', {
      messageId,
      content,
      utterances,
      state: finalState,
      gameTime: toGameTime(gathered.input.calendar, finalState.time),
      needsSummary,
      firedEvents: firedTitles,
      eventRows,
      warnings,
      stateWarnings,
      fenceMissingStreak: fenceMissStreak.get(chatId) ?? 0,
      autoJoinSuggested,
      generationStatus: status,
      autoplayShouldStop,
    });

    // 裏で走った要約・抽出の結果を、ストリームを閉じる前に流す（§5.9）。
    // done は先に送っているので画面はもう待たされていない。inflight も解放済みなので
    // 次のターンを始めることもできる。
    for (const n of await settleNotices([summaryTask.done, extractTask.done])) {
      send('notice', n);
    }
    res.end();
  } finally {
    // 400 / 413 / 500 など、どの経路で抜けても必ず外す
    releaseLock();
  }
});

/**
 * バックグラウンド処理の結果を待つ。
 * 応答生成そのものは終わっているので、ここで無限に待たない。
 * 打ち切った分は通知が出ないだけで、処理自体は最後まで走る。
 */
const NOTICE_WAIT_MS = 60_000;

async function settleNotices(tasks: Promise<Notice | null>[]): Promise<Notice[]> {
  const timeout = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), NOTICE_WAIT_MS);
    // Node のイベントループをこのタイマーで引き延ばさない
    if (typeof t.unref === 'function') t.unref();
  });
  const settled = await Promise.all(
    tasks.map((task) =>
      Promise.race([task, timeout]).catch((err) => {
        console.error('[notice] バックグラウンド処理が失敗:', (err as Error).message);
        return null;
      }),
    ),
  );
  return settled.filter((n): n is Notice => !!n);
}

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

// ---- 場面を進める（生成せずに時間だけ動かす）----
//
// 手動のステート編集（PUT /chats/:id/state）は値を入れ替えるだけで、天候の抽選も
// イベント判定も走らない。「翌朝にする」たびに天気が固定されたままになるのはこのため。
// ここでは生成ターンとまったく同じ関数（applyDelta → runEventPipeline）を通し、
// 遷移で起きるはずのことを実際に起こす。LLMは呼ばない。
//
// 場面転換マーカーのメッセージを1件残すのは表示のためだけではない:
//   ① 発火は assistant のメッセージに紐づき、次ターンの注入はそこから引く。
//      マーカーを作らずに直前の応答へ紐づけると、その応答の発火と混ざって再注入される
//   ② 基準ステートは「直前メッセージの state_after」なので、鎖を繋いでおく必要がある

interface AdvanceBody {
  /** 相対指定（分）。game_time と排他 */
  minutes?: number;
  /** 絶対指定。年月日時分をすべて渡す */
  game_time?: { year?: number; month?: number; day?: number; hh?: number; mm?: number };
  location?: string;
  present_add?: string[];
  present_remove?: string[];
  /** マーカーの本文。省略すると日時と場所から作る */
  text?: string;
}

/** 1回の場面転換で進められる上限。打ち間違いで暦を吹き飛ばさないための歯止め */
const ADVANCE_MAX_MINUTES = 366 * MIN_PER_DAY;

function sceneBreakText(cal: CalendarConfig, state: ChatState, locations: Location[]): string {
  const place = state.location_note || locations.find((l) => l.id === state.location)?.name || '';
  return `――${formatGameTime(toGameTime(cal, state.time))}${place ? `、${place}` : ''}。`;
}

messagesRouter.post('/chats/:id/advance', (req, res) => {
  const chatId = req.params.id;
  const chat = getChat(chatId);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  if (inflight.has(chatId)) {
    res.status(409).json({ error: '生成中です' });
    return;
  }

  const body = (req.body ?? {}) as AdvanceBody;
  const calendar = getCalendar(chat.world_id);
  const last = lastMessage(chatId);
  const baseState = last?.state_after ?? chat.initial_state;

  // 目標時刻 → 経過分。時刻の演算は calendar.ts に一本化する（§4.12）
  let elapsed: number;
  const g = body.game_time;
  if (g && [g.year, g.month, g.day, g.hh, g.mm].every((v) => Number.isFinite(v))) {
    elapsed = toMinutes(calendar, g.year!, g.month!, g.day!, g.hh!, g.mm!) - baseState.time;
  } else if (Number.isFinite(body.minutes)) {
    elapsed = Math.floor(body.minutes!);
  } else {
    res.status(400).json({ error: 'minutes か game_time のどちらかを指定してください' });
    return;
  }
  if (elapsed <= 0) {
    res.status(400).json({
      error: '時間は前にだけ進められます。巻き戻すときはステート編集を使ってください',
    });
    return;
  }
  if (elapsed > ADVANCE_MAX_MINUTES) {
    res.status(400).json({ error: `一度に進められるのは ${ADVANCE_MAX_MINUTES / MIN_PER_DAY} 日までです` });
    return;
  }

  const scenario = chat.scenario_id ? getScenario(chat.scenario_id) : null;
  const settings = getSettings();
  const world = getWorld(chat.world_id);
  const varsEnabled = resolveFlag(chat.vars_enabled, scenario?.vars_enabled, settings.vars_enabled);
  const eventsEnabled = resolveFlag(
    chat.events_enabled,
    scenario?.events_enabled,
    settings.events_enabled,
  );
  const varsSchema = world?.vars_schema ?? [];
  const locations = listLocations(chat.world_id);
  const characters = listCharacters(chat.world_id);

  const delta: StateDelta = {
    elapsed_minutes: elapsed,
    location: body.location ?? '',
    present_add: Array.isArray(body.present_add) ? body.present_add : [],
    present_remove: Array.isArray(body.present_remove) ? body.present_remove : [],
    set_var: {},
  };
  const applied = applyDelta(calendar, baseState, delta, locations, characters, {
    // 生成ターンと同じ種を使う。同じ日に着けば天気も同じになる（§7）
    rand: seededRand(`${chatId}:weather:${Math.floor((baseState.time + elapsed) / MIN_PER_DAY)}`),
    varsSchema,
    varsEnabled,
  });

  const text = (body.text ?? '').trim() || sceneBreakText(calendar, applied.state, locations);
  const utterances: Utterance[] = [{ speaker: 'narrator', name: 'ナレーター', text }];
  const msg = insertMessage({
    chat_id: chatId,
    role: 'assistant',
    content: text,
    utterances,
    state_after: applied.state,
    generation_status: 'complete',
    kind: 'scene_break',
  });
  insertVariant({
    message_id: msg.id,
    content: text,
    utterances,
    state_delta: `(advance) elapsed_minutes: ${elapsed}`,
    state_after: applied.state,
  });

  // ---- 判定パイプライン（生成ターンと同じ）----
  let finalState = applied.state;
  const firedTitles: string[] = [];
  let eventRows: EventEvalRow[] = [];
  if (eventsEnabled) {
    const result = runEventPipeline({
      chatId,
      events: listEvents(chat.world_id),
      baseState,
      newState: applied.state,
      calendar,
      locations,
      varsSchema,
      varsEnabled,
      baseMessageId: last?.id ?? chatId,
      visitId: visitIdOf(chatId, applied.state),
      firesByEvent: groupFires(chatId),
      maxPerTurn: Math.max(1, settings.event_max_per_turn),
    });
    eventRows = result.rows;
    const commit = db.transaction(() => {
      let state = applied.state;
      for (const { event, scopeKey } of result.adopted) {
        if (varsEnabled && event.set_vars.length) {
          const r = applyVarOps(varsSchema, state.vars, event.set_vars);
          state = { ...state, vars: r.vars };
          applied.warnings.push(...r.warnings);
        }
        recordFire({
          chat_id: chatId,
          event_id: event.id,
          message_id: msg.id,
          fired_at_time: applied.state.time,
          scope_key: scopeKey,
        });
        firedTitles.push(event.title);
      }
      if (state !== applied.state) {
        updateMessageActive(msg.id, { state_after: state });
        const active = listVariants(msg.id)[0];
        if (active) updateVariantState(active.id, state);
      }
      finalState = state;
    });
    commit();
  }

  setChatState(chatId, finalState);

  // 要約・知識抽出はここでは走らせない。LLMを呼ばない操作から
  // 勝手に呼び出しが飛ぶのは分かりにくいため（次の生成ターンで判定される）
  res.status(201).json({
    message: getMessage(msg.id),
    state: finalState,
    gameTime: toGameTime(calendar, finalState.time),
    elapsedMinutes: elapsed,
    dayChanged: applied.dayChanged,
    weather: finalState.weather,
    warnings: applied.warnings,
    firedEvents: firedTitles,
    eventRows,
    eventsEnabled,
  });
});

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
  // そのメッセージ以降の発火履歴も消す（v1.5.3 §8）
  deleteFiresFromSeq(msg.chat_id, msg.seq);
  deleteMessage(msg.id);
  const chat = getChat(msg.chat_id);
  if (chat) {
    const last = lastMessage(chat.id);
    // 全て消えた場合はChat作成時の初期ステートへ戻す。
    // シナリオを参照しないのは、編集・削除された場合に値が変わってしまうため（§4.6）
    setChatState(chat.id, last ? last.state_after : chat.initial_state);
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
