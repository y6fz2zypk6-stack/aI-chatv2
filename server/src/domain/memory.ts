import type { Character, Settings } from '../../../shared/types.js';
import { getChat, updateChat } from '../db/repo/chats.js';
import { getCharacters, listCharacters } from '../db/repo/characters.js';
import { createMemory, listMemories } from '../db/repo/memories.js';
import { messagesAfterSeq } from '../db/repo/messages.js';
import { completeText } from '../llm/openrouter.js';

/**
 * 知識抽出（§8.4）。長期記憶の対象は char のみ。
 * この処理のみJSONモードを使い、既存分を重複除けとしてモデルに渡す。
 *
 * 過剰抽出への対策を3点持つ:
 *   ① 実行中ガード。要約の完了を待たずに毎ターン走るのを防ぐ（§10.2）
 *   ② 最小範囲。1〜2メッセージから絞り出させない
 *   ③ 「該当なしが通常」と明示し、件数の上限値を目標として与えない
 */

/** 同じチャットで抽出が重ならないようにする */
const extracting = new Set<string>();

/**
 * これ未満の新規メッセージでは抽出しない。
 * 範囲が狭いと、モデルは些細な動作や一時的な感情を拾うしかなくなる。
 */
export const MIN_EXTRACT_MESSAGES = 8;

/** 1キャラ・1回の抽出で保存する上限。目標値として働かないようプロンプトには書かない */
const HARD_CAP = 5;

export interface MemoryCandidate {
  character_id: string;
  character_name: string;
  subject: string;
  content: string;
  /** 保存条件をどう満たすかの説明。調整用に返すだけで保存はしない */
  why: string;
}

export interface ExtractResult {
  candidates: MemoryCandidate[];
  /** 対象にした範囲。抽出しなかった場合は null */
  range: { fromSeq: number; toSeq: number; count: number } | null;
  /** 抽出しなかった理由など、画面に出す短い説明 */
  notes: string[];
}

function buildPrompt(input: {
  character: Character;
  idList: string;
  existing: string[];
  convo: string;
}): string {
  return `以下のロールプレイ会話から、キャラクター「${input.character.name}」が長期的に記憶すべき事実だけを抽出せよ。

# 保存の条件（すべて満たすものだけを保存する）
1. 数シーン後にも有効である
2. 将来の会話・判断・行動へ影響する
3. 忘れると明確な矛盾または不自然さが生じる
4. 単なる動作、一時的な感情、その場限りの雑談ではない
5. 既存の記憶と重複しない

# 重要
- 該当するものが無いのが通常である。無理に候補を作らず、空配列を返すこと。
- 件数を埋めるための抽出を禁止する。1件も無ければ空配列でよい。
- 容姿・口調・設定そのものは抽出しない（別途ロアブックが保持している）。

# 判断の例
保存する: 「相手に、ある件を口外しないと約束した」→ 忘れると次に会ったとき矛盾する
保存する: 「相手がどこで働いているかを知った」→ 今後どこを訪ねるかに影響する
保存しない: 「紅茶を淹れた」→ 単なる動作
保存しない: 「雨で少し憂鬱だった」→ 一時的な感情
保存しない: 「本の話で盛り上がった」→ その場限りの雑談

# subject に使える人物ID（該当しなければ空文字）
${input.idList || '（なし）'}

# 既存の記憶
${input.existing.map((c) => `- ${c}`).join('\n') || '（なし）'}

# 会話
${input.convo}

次のJSON形式のみで出力すること。
{"memories": [{"subject": "人物IDまたは空文字", "content": "記憶する事実", "why": "条件3をどう満たすか"}]}`;
}

/**
 * 候補を抽出する（保存はしない）。
 * 画面のプレビューと実際の保存で同じ経路を通すため、ここに集約する。
 */
export async function extractCandidates(
  chatId: string,
  settings: Settings,
  opts: { ignoreMinimum?: boolean } = {},
): Promise<ExtractResult> {
  const notes: string[] = [];
  const chat = getChat(chatId);
  if (!chat) return { candidates: [], range: null, notes: ['チャットが見つかりません'] };

  const targets = messagesAfterSeq(chatId, chat.extracted_up_to_seq ?? 0);
  if (targets.length === 0) {
    return { candidates: [], range: null, notes: ['新しいメッセージがありません'] };
  }
  if (!opts.ignoreMinimum && targets.length < MIN_EXTRACT_MESSAGES) {
    return {
      candidates: [],
      range: null,
      notes: [`新しいメッセージが ${targets.length} 件で、抽出の下限（${MIN_EXTRACT_MESSAGES} 件）に達していません`],
    };
  }

  const participants = getCharacters(chat.participant_ids).filter((c) => !c.is_npc_pool);
  if (participants.length === 0) {
    return { candidates: [], range: null, notes: ['対象になるキャラクターがいません'] };
  }

  // subject は「その人物が在席中のときだけ注入する」判定に使うため、必ず実在のIDにする。
  // ID一覧を渡さないとモデルは名前を返し、どの条件にも一致せず永久に注入されなくなる
  const known = listCharacters(chat.world_id);
  const knownIds = new Set(known.map((c) => c.id));
  const idList = known.map((c) => `${c.id} = ${c.name}`).join('\n');

  const convo = targets.map((m) => m.content).join('\n');
  const model = settings.utility_model || settings.default_model;
  const candidates: MemoryCandidate[] = [];

  for (const c of participants) {
    const existing = listMemories(c.id).map((m) => m.content);
    try {
      const raw = await completeText({
        model,
        messages: [
          { content: buildPrompt({ character: c, idList, existing, convo }), role: 'user' },
        ],
        maxTokens: 1024,
        json: true,
      });
      const parsed = JSON.parse(raw) as {
        memories?: { subject?: string; content?: string; why?: string }[];
      };
      let taken = 0;
      for (const m of parsed.memories ?? []) {
        const content = (m.content ?? '').trim();
        if (!content) continue;
        if (taken >= HARD_CAP) {
          notes.push(`${c.name}: ${HARD_CAP}件を超えた分は切り捨てました`);
          break;
        }
        // 未知のIDや名前が返ってきたら空文字（＝常時注入）に落とす
        const subject = m.subject && knownIds.has(m.subject) ? m.subject : '';
        if (m.subject && !subject) {
          notes.push(`${c.name}: 対象「${m.subject}」は人物IDとして解決できないため常時扱いにしました`);
        }
        candidates.push({
          character_id: c.id,
          character_name: c.name,
          subject,
          content,
          why: (m.why ?? '').trim(),
        });
        taken++;
      }
    } catch (err) {
      notes.push(`${c.name}: 抽出に失敗しました（${(err as Error).message}）`);
    }
  }

  return {
    candidates,
    range: {
      fromSeq: targets[0].seq,
      toSeq: targets[targets.length - 1].seq,
      count: targets.length,
    },
    notes,
  };
}

/** 抽出して保存し、抽出済み境界を進める */
export async function runExtract(chatId: string, settings: Settings): Promise<number> {
  if (extracting.has(chatId)) return 0;
  extracting.add(chatId);
  try {
    const result = await extractCandidates(chatId, settings);
    if (!result.range) return 0;
    for (const c of result.candidates) {
      createMemory(c.character_id, { subject: c.subject, content: c.content, source: 'auto' });
    }
    const chat = getChat(chatId);
    const targets = chat ? messagesAfterSeq(chatId, chat.extracted_up_to_seq ?? 0) : [];
    const last = targets[targets.length - 1];
    // 抽出に失敗した場合でも境界は進める。同じ範囲を延々と再試行させない
    if (last) updateChat(chatId, { extracted_up_to: last.id, extracted_up_to_seq: last.seq });
    return result.candidates.length;
  } finally {
    extracting.delete(chatId);
  }
}

/**
 * 応答保存直後のバックグラウンド判定。
 * 自動要約とは独立に判定する（auto_summarize を切っても自動抽出は動く）。
 */
export function maybeExtract(chatId: string, settings: Settings): { needed: boolean } {
  if (settings.auto_extract !== 1) return { needed: false };
  if (extracting.has(chatId)) return { needed: false };
  const chat = getChat(chatId);
  if (!chat) return { needed: false };
  const pending = messagesAfterSeq(chatId, chat.extracted_up_to_seq ?? 0).length;
  // 抽出の間隔は要約と揃える（§10.2）
  const needed = pending >= Math.max(MIN_EXTRACT_MESSAGES, settings.summary_interval);
  if (needed) {
    runExtract(chatId, settings).catch((err) =>
      console.error('[memory] 自動抽出に失敗:', (err as Error).message),
    );
  }
  return { needed };
}
