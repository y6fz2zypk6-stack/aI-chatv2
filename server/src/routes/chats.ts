import { Router } from 'express';
import { db, toJson } from '../db/index.js';
import { getCalendar } from '../db/repo/calendars.js';
import { deleteChat, getChat, listChats, setChatState, updateChat } from '../db/repo/chats.js';
import { lastMessage, listMessages, listVariants, updateMessageActive } from '../db/repo/messages.js';
import { getSettings } from '../db/repo/settings.js';
import {
  deleteSummaries,
  insertSummary,
  latestSummary,
  updateSummaryContent,
} from '../db/repo/summaries.js';
import { toGameTime, toMinutes } from '../domain/calendar.js';
import { runExtract } from '../domain/memory.js';
import { normalizeState } from '../domain/state.js';
import { runSummarize } from '../domain/summary.js';
import { assembleContext } from '../llm/prompt.js';
import { gatherContext } from './messages.js';

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
  });
});

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

// ---- ステート（§10.3）----

chatsRouter.get('/chats/:id/state', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  const calendar = getCalendar(chat.world_id);
  const last = lastMessage(chat.id);
  res.json({
    state: chat.state,
    gameTime: toGameTime(calendar, chat.state.time),
    calendar,
    lastMessageId: last?.id ?? null,
  });
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
    res.json(insertSummary(chat.id, last.id, content));
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

chatsRouter.post('/chats/:id/extract', async (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  try {
    const added = await runExtract(chat.id, getSettings());
    res.json({ added });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
