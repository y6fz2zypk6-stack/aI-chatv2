import type { Message, Settings } from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
import { getChat } from '../db/repo/chats.js';
import { insertSummary, latestSummary } from '../db/repo/summaries.js';
import { messagesAfterSeq } from '../db/repo/messages.js';
import { toGameTime } from './calendar.js';
import { completeText } from '../llm/openrouter.js';

/** 同じチャットで要約が重ならないようにする（重なると毎ターン走る） */
const summarizing = new Set<string>();

/** §8.3: retainWindow(n) = max(1, min(24, n - 2)) */
export function retainWindow(n: number): number {
  return Math.max(1, Math.min(24, n - 2));
}

/** §8.3 要約プロンプトに必ず含める文 */
const SUMMARY_RULES = `- 出来事には、そのときのゲーム内日付を添えること。
- 人物の設定（容姿・口調・経歴・立場）は要約に含めない。これらはロアブックが保持している。
  要約に書くのは、出来事と、人物間の関係の変化のみ。`;

/**
 * 要約の実行（§8.3）。
 * 前回のあらすじと今回の対象範囲を統合した1本のあらすじとして書き直させる。
 * 前回分を捨てて新規分だけ要約する実装は禁止。
 */
export async function runSummarize(chatId: string, settings: Settings): Promise<string | null> {
  if (summarizing.has(chatId)) return null;
  summarizing.add(chatId);
  try {
    return await summarizeOnce(chatId, settings);
  } finally {
    summarizing.delete(chatId);
  }
}

async function summarizeOnce(chatId: string, settings: Settings): Promise<string | null> {
  const chat = getChat(chatId);
  if (!chat) return null;
  const prev = latestSummary(chatId);
  const unsummarized = messagesAfterSeq(chatId, prev?.up_to_seq ?? 0);
  if (unsummarized.length === 0) return prev?.content ?? null;

  const retain = retainWindow(unsummarized.length);
  const targets = unsummarized.slice(0, Math.max(0, unsummarized.length - retain));
  if (targets.length === 0) return prev?.content ?? null;

  const calendar = getCalendar(chat.world_id);
  const fmtDate = (m: Message) => {
    const gt = toGameTime(calendar, m.state_after.time);
    return `${gt.year}年${gt.month}月${gt.day}日(${gt.season})`;
  };

  const lines = targets.map((m) => `[${fmtDate(m)}] ${m.content}`).join('\n');
  const model = settings.utility_model || settings.default_model;
  const prompt = `以下はロールプレイ会話の記録である。前回までのあらすじと今回の会話を統合し、1本のあらすじとして書き直すこと。
古い出来事も消さずに残し、全体を${settings.summary_max_chars}文字程度に圧縮する。
${SUMMARY_RULES}

# 前回までのあらすじ
${prev?.content || '（なし）'}

# 今回の会話（各行の [日付] はゲーム内日付）
${lines}

あらすじ本文のみを出力すること。`;

  const content = (
    await completeText({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: Math.max(1024, Math.ceil(settings.summary_max_chars * 2)),
    })
  ).trim();
  if (!content) return prev?.content ?? null;

  const upTo = targets[targets.length - 1];
  insertSummary(chatId, upTo.id, upTo.seq, content);
  return content;
}

/** 応答保存直後のバックグラウンド判定（§8.3-1,2） */
export function maybeSummarize(chatId: string, settings: Settings): { needed: boolean } {
  if (!settings.auto_summarize) return { needed: false };
  // 要約はLLM呼び出しなので数秒〜十数秒かかる。実行中に次のターンが来ても
  // 未要約件数は減っていないため、ガードが無いと毎ターン起動してしまう
  if (summarizing.has(chatId)) return { needed: false };
  const prev = latestSummary(chatId);
  const count = messagesAfterSeq(chatId, prev?.up_to_seq ?? 0).length;
  const needed = count >= settings.summary_interval;
  if (needed) {
    runSummarize(chatId, settings).catch((err) =>
      console.error('[summary] 自動要約に失敗:', (err as Error).message),
    );
  }
  return { needed };
}
