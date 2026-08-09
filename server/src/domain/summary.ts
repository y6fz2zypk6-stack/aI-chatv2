import type { Message, Settings } from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
import { getChat } from '../db/repo/chats.js';
import { DEFAULT_SUMMARY_POLICY } from '../db/repo/settings.js';
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

/**
 * 要約プロンプトの骨組み。**利用者は編集できない。**
 * ここにあるのはアプリの構造上どうしても必要な制約で、書き忘れると静かに壊れる:
 *   - 統合を書き忘れる → 前回分が捨てられ、古い出来事が消える
 *   - 人物設定の除外を書き忘れる → ロアブックと二重管理になりコンテキストを食う
 *
 * 取捨選択と文体は settings.summary_policy（編集可能）が受け持つ。
 */
function buildRules(maxChars: number): string {
  return `# 必ず守ること
- 前回までのあらすじは選別済みである。言い回しは縮めてよいが、そこに書かれた
  出来事・約束・未解決の項目は落とさない。
- 今回の会話は生の記録である。下の「要約の方針」に従って取捨選択する。
- 人物の設定（容姿・口調・経歴・立場）は書かない。ロアブックが保持している。
- 出来事には [5年9月10日(秋)] の形式でゲーム内日付を添える。
- 全体を${maxChars}文字程度に収める。
- あらすじ本文のみを出力する。前置き・説明・見出し以外の装飾を書かない。`;
}

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
  const policy = settings.summary_policy?.trim() || DEFAULT_SUMMARY_POLICY;
  const prompt = `以下はロールプレイ会話の記録である。
前回までのあらすじと今回の会話を統合し、1本のあらすじとして書き直すこと。

${buildRules(settings.summary_max_chars)}

# 要約の方針
${policy}

# 前回までのあらすじ
${prev?.content || '（なし）'}

# 今回の会話（各行の [日付] はゲーム内日付）
${lines}`;

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
