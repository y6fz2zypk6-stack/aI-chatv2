import { retainWindow, type Message, type Notice, type Settings } from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
import { getChat } from '../db/repo/chats.js';
import { DEFAULT_SUMMARY_POLICY } from '../db/repo/settings.js';
import { insertSummary, latestSummary } from '../db/repo/summaries.js';
import { messagesAfterSeq } from '../db/repo/messages.js';
import { formatGameDate } from './calendar.js';
import { complete } from '../llm/openrouter.js';

/** 同じチャットで要約が重ならないようにする（重なると毎ターン走る） */
const summarizing = new Set<string>();

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
- 出来事には [5年9月10日(金)] の形式でゲーム内日付を添える。
- 全体を${maxChars}文字程度に収める。
- あらすじ本文のみを出力する。前置き・説明・見出し以外の装飾を書かない。`;
}

export interface SummarizeResult {
  ok: boolean;
  /** 保存されたあらすじ。保存しなかった場合は直前のもの（無ければ null） */
  content: string | null;
  /** 画面に出す一言。成功・失敗のどちらでも必ず入れる */
  message: string;
  /** 今回まとめたメッセージ件数 */
  count: number;
  /** 実行中だったので見送った（通知しない） */
  skipped: boolean;
}

const skip = (content: string | null = null): SummarizeResult => ({
  ok: true,
  content,
  message: '',
  count: 0,
  skipped: true,
});

/**
 * 要約の実行（§8.3）。
 * 前回のあらすじと今回の対象範囲を統合した1本のあらすじとして書き直させる。
 * 前回分を捨てて新規分だけ要約する実装は禁止。
 *
 * **例外を投げず、必ず結果を返す。** 呼び出し側（自動要約）はバックグラウンドで
 * 走らせるため、投げると理由が誰にも届かない。
 */
export async function runSummarize(chatId: string, settings: Settings): Promise<SummarizeResult> {
  if (summarizing.has(chatId)) return skip();
  summarizing.add(chatId);
  try {
    return await summarizeOnce(chatId, settings);
  } catch (err) {
    const message = `要約に失敗しました: ${(err as Error).message}`;
    console.warn(`[summary] ${message}`);
    return { ok: false, content: null, message, count: 0, skipped: false };
  } finally {
    summarizing.delete(chatId);
  }
}

async function summarizeOnce(chatId: string, settings: Settings): Promise<SummarizeResult> {
  const chat = getChat(chatId);
  if (!chat) {
    return { ok: false, content: null, message: 'チャットが見つかりません', count: 0, skipped: false };
  }
  const prev = latestSummary(chatId);
  const unsummarized = messagesAfterSeq(chatId, prev?.up_to_seq ?? 0);
  if (unsummarized.length === 0) {
    return { ok: true, content: prev?.content ?? null, message: '要約する範囲がありません', count: 0, skipped: false };
  }

  const retain = retainWindow(unsummarized.length, settings.summary_interval);
  const targets = unsummarized.slice(0, Math.max(0, unsummarized.length - retain));
  if (targets.length === 0) {
    return {
      ok: true,
      content: prev?.content ?? null,
      message: `要約する範囲がありません（直近${retain}件は生のまま残します）`,
      count: 0,
      skipped: false,
    };
  }

  const calendar = getCalendar(chat.world_id);
  // メモリーの日付（§10.2）と同じ表記にして、突き合わせられるようにする
  const lines = targets
    .map((m) => `[${formatGameDate(calendar, m.state_after.time)}] ${m.content}`)
    .join('\n');
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

  // 出力の上限。あらすじの文字数から要る分を見積もり、設定値を下回らないようにする
  const maxTokens = Math.max(
    settings.utility_max_tokens,
    Math.ceil(settings.summary_max_chars * 2),
  );
  const r = await complete({
    model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
  });
  const content = r.text.trim();
  if (!content) {
    // 空応答を「変更なし」で流すと、あらすじが更新されないまま毎ターン再挑戦になる。
    // 理由が分かる形で失敗として返す（§10.2 と同じ方針）
    const why = r.refusal
      ? `モデルが拒否しました（${r.refusal.slice(0, 80)}）`
      : r.finishReason === 'length'
        ? `応答が上限（要約・抽出の最大トークン ${maxTokens}）で切れました`
        : `モデルが空の応答を返しました（finish_reason=${r.finishReason || '不明'}）`;
    return {
      ok: false,
      content: prev?.content ?? null,
      message: `要約に失敗しました: ${why}。要約・抽出のモデルを見直してください`,
      count: targets.length,
      skipped: false,
    };
  }

  const upTo = targets[targets.length - 1];
  insertSummary(chatId, upTo.id, upTo.seq, content);
  return {
    ok: true,
    content,
    message: `${targets.length}件を要約しました（${content.length}文字）`,
    count: targets.length,
    skipped: false,
  };
}

/**
 * 応答保存直後のバックグラウンド判定（§8.3-1,2）。
 * 起動した場合は `done` に結果が入る。呼び出し側はこれを待って通知を出す。
 */
export function maybeSummarize(
  chatId: string,
  settings: Settings,
): { needed: boolean; done: Promise<Notice | null> } {
  const none = { needed: false, done: Promise.resolve(null) };
  if (!settings.auto_summarize) return none;
  // 要約はLLM呼び出しなので数秒〜十数秒かかる。実行中に次のターンが来ても
  // 未要約件数は減っていないため、ガードが無いと毎ターン起動してしまう
  if (summarizing.has(chatId)) return none;
  const prev = latestSummary(chatId);
  const count = messagesAfterSeq(chatId, prev?.up_to_seq ?? 0).length;
  if (count < settings.summary_interval) return none;

  const done = runSummarize(chatId, settings).then((r) =>
    r.skipped || !r.message ? null : { kind: 'summary' as const, ok: r.ok, message: r.message },
  );
  return { needed: true, done };
}
