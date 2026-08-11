import type { Character, Notice, Settings } from '../../../shared/types.js';
import { getChat, updateChat } from '../db/repo/chats.js';
import { getCharacters, listCharacters } from '../db/repo/characters.js';
import { createMemory, listMemories } from '../db/repo/memories.js';
import { messageAtSeq, messagesAfterSeq } from '../db/repo/messages.js';
import { complete } from '../llm/openrouter.js';

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

/**
 * 応答からJSONオブジェクトの部分だけを取り出す。
 * コードフェンス（```json ... ```）や前置きを付けて返すモデルがあるため、
 * 生の文字列をそのまま JSON.parse しない。
 */
function extractJsonObject(raw: string): string {
  const s = raw.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return '';
  return s.slice(start, end + 1);
}

/** 空応答・パース失敗の理由を利用者に見せられる形にする */
function failureNote(name: string, finishReason: string, raw: string, cap: number): string {
  if (finishReason === 'length') {
    // 本文生成の「最大トークン」ではなく、要約・抽出用の上限であることを明示する。
    // 別物なので、本文側を上げても直らない
    return `${name}: 応答が上限（要約・抽出の最大トークン ${cap}）で切れました。設定でこの値を上げるか、要約・抽出のモデルを変えてください`;
  }
  if (finishReason === 'content_filter') {
    return `${name}: モデルが内容を拒否しました（content_filter）`;
  }
  if (!raw.trim()) {
    return `${name}: モデルが空の応答を返しました（finish_reason=${finishReason || '不明'}）。要約・抽出のモデルを変えると直ることがあります`;
  }
  return `${name}: 応答をJSONとして読めませんでした: ${raw.trim().slice(0, 100)}`;
}

export interface MemoryCandidate {
  character_id: string;
  character_name: string;
  subject: string;
  content: string;
  /** 保存条件をどう満たすかの説明。調整用に返すだけで保存はしない */
  why: string;
  /** 出来事のゲーム内時刻（通算分）。抽出範囲の末尾のステートから採る */
  game_time: number | null;
}

export interface ExtractResult {
  candidates: MemoryCandidate[];
  /** 対象にした範囲。抽出しなかった場合は null */
  range: { fromSeq: number; toSeq: number; count: number } | null;
  /** 抽出しなかった理由など、画面に出す短い説明 */
  notes: string[];
  /** 1人でも応答を読み取れなかった。true なら抽出済み境界を進めない */
  failed: boolean;
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
  let failed = false;
  const chat = getChat(chatId);
  if (!chat) return { candidates: [], range: null, notes: ['チャットが見つかりません'], failed: false };

  const targets = messagesAfterSeq(chatId, chat.extracted_up_to_seq ?? 0);
  if (targets.length === 0) {
    return { candidates: [], range: null, notes: ['新しいメッセージがありません'], failed: false };
  }
  if (!opts.ignoreMinimum && targets.length < MIN_EXTRACT_MESSAGES) {
    return {
      candidates: [],
      range: null,
      notes: [`新しいメッセージが ${targets.length} 件で、抽出の下限（${MIN_EXTRACT_MESSAGES} 件）に達していません`],
      failed: false,
    };
  }

  const participants = getCharacters(chat.participant_ids).filter((c) => !c.is_npc_pool);
  if (participants.length === 0) {
    return { candidates: [], range: null, notes: ['対象になるキャラクターがいません'], failed: false };
  }

  // subject は「その人物が在席中のときだけ注入する」判定に使うため、必ず実在のIDにする。
  // ID一覧を渡さないとモデルは名前を返し、どの条件にも一致せず永久に注入されなくなる
  const known = listCharacters(chat.world_id);
  const knownIds = new Set(known.map((c) => c.id));
  const idList = known.map((c) => `${c.id} = ${c.name}`).join('\n');

  const convo = targets.map((m) => m.content).join('\n');
  const model = settings.utility_model || settings.default_model;
  // 出力の上限。本文生成の max_tokens とは別枠（§14）
  const maxTokens = Math.max(256, settings.utility_max_tokens);
  const candidates: MemoryCandidate[] = [];
  // 「いつの出来事か」は抽出範囲の末尾のゲーム内時刻とする。
  // 範囲内で日をまたぐこともあるが、記憶は範囲全体をまとめた1件なので末尾に寄せる
  const gameTime = targets[targets.length - 1]?.state_after?.time ?? null;

  for (const c of participants) {
    // 重複除けには **注入を切ったものも含める。**
    // OFF は「もう出さなくていい」という意思表示なので、外すと同じ内容が拾い直されて
    // 何度でも復活してしまう
    const existing = listMemories(c.id).map((m) => m.content);
    const messages = [
      { content: buildPrompt({ character: c, idList, existing, convo }), role: 'user' as const },
    ];
    try {
      // JSONモードで空を返すモデルがあるので、空だったら素のプロンプトで1度だけ試し直す。
      // 明示的な拒否と、長さ超過は再試行しても同じなので、そのまま理由として扱う
      let r = await complete({ model, messages, maxTokens, json: true });
      if (!r.refusal && !r.text.trim() && r.finishReason !== 'length') {
        r = await complete({ model, messages, maxTokens });
      }
      if (r.refusal) {
        notes.push(`${c.name}: モデルが拒否しました（${r.refusal.slice(0, 80)}）`);
        failed = true;
        continue;
      }
      const body = extractJsonObject(r.text);
      if (!body) {
        notes.push(failureNote(c.name, r.finishReason, r.text, maxTokens));
        failed = true;
        continue;
      }
      let parsed: { memories?: { subject?: string; content?: string; why?: string }[] };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        notes.push(failureNote(c.name, r.finishReason, r.text, maxTokens));
        failed = true;
        continue;
      }
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
          game_time: gameTime,
        });
        taken++;
      }
    } catch (err) {
      notes.push(`${c.name}: 抽出の呼び出しに失敗しました（${(err as Error).message}）`);
      failed = true;
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
    failed,
  };
}

/**
 * 失敗したチャットの再開ライン。
 * 応答を読めなかった範囲は境界を進めずに残すが、毎ターン叩き直さないよう、
 * 未抽出がこの件数に達するまでは自動実行を見送る。
 */
const retryAt = new Map<string, number>();

export interface ExtractRunResult {
  added: number;
  notes: string[];
  failed: boolean;
  /** 画面に出す一言。成功・失敗のどちらでも必ず入れる */
  message: string;
  /** 実行中だったので見送った（通知しない） */
  skipped: boolean;
}

/**
 * 抽出して保存し、抽出済み境界を進める。
 * **例外を投げず、必ず結果を返す。** 自動抽出はバックグラウンドで走るため、
 * 投げると理由が誰にも届かない。
 */
export async function runExtract(chatId: string, settings: Settings): Promise<ExtractRunResult> {
  if (extracting.has(chatId)) {
    return { added: 0, notes: [], failed: false, message: '', skipped: true };
  }
  extracting.add(chatId);
  try {
    const result = await extractCandidates(chatId, settings);
    if (!result.range) {
      return { added: 0, notes: result.notes, failed: false, message: result.notes[0] ?? '', skipped: false };
    }

    if (result.failed) {
      // **境界を進めない。** 進めるとこの範囲は二度と抽出されず、
      // モデルの設定を直しても取り返せなくなる
      retryAt.set(chatId, result.range.count + Math.max(MIN_EXTRACT_MESSAGES, settings.summary_interval));
      console.warn(`[memory] 抽出に失敗（範囲は保留）: ${result.notes.join(' / ')}`);
      return {
        added: 0,
        notes: result.notes,
        failed: true,
        message: `メモリーの抽出に失敗しました: ${result.notes[0] ?? '理由不明'}`,
        skipped: false,
      };
    }

    for (const c of result.candidates) {
      createMemory(c.character_id, {
        subject: c.subject,
        content: c.content,
        source: 'auto',
        game_time: c.game_time,
      });
    }
    const chat = getChat(chatId);
    const targets = chat ? messagesAfterSeq(chatId, chat.extracted_up_to_seq ?? 0) : [];
    const last = targets[targets.length - 1];
    if (last) updateChat(chatId, { extracted_up_to: last.id, extracted_up_to_seq: last.seq });
    retryAt.delete(chatId);
    const added = result.candidates.length;
    return {
      added,
      notes: result.notes,
      failed: false,
      message: added
        ? `メモリーを${added}件保存しました`
        : `メモリー: ${result.range.count}件を見ましたが、保存に値する内容はありませんでした`,
      skipped: false,
    };
  } catch (err) {
    const message = `メモリーの抽出に失敗しました: ${(err as Error).message}`;
    console.warn(`[memory] ${message}`);
    return { added: 0, notes: [message], failed: true, message, skipped: false };
  } finally {
    extracting.delete(chatId);
  }
}

/** 1件の記憶の長さの上限。プレビューの内容をそのまま保存するので、ここで歯止めを置く */
const MAX_CONTENT_CHARS = 2000;
/** 1回の保存で受け付ける件数の上限 */
const MAX_COMMIT = 20;

/**
 * プレビューで見た候補を **そのまま** 保存する。
 *
 * `runExtract` を呼び直すと抽出のコールをもう一度払ううえ、モデルの出力は毎回同じとは
 * 限らないので「見たものと保存されるものが違う」ことになる。それを避けるための経路。
 *
 * 中身はクライアント由来なので、キャラID・subject・日付・範囲はすべてサーバで引き直す。
 */
export function commitCandidates(
  chatId: string,
  input: { candidates: { character_id?: string; subject?: string; content?: string }[]; toSeq: number },
): { added: number; message: string; error?: string } {
  const chat = getChat(chatId);
  if (!chat) return { added: 0, message: '', error: 'チャットが見つかりません' };

  const from = chat.extracted_up_to_seq ?? 0;
  const toSeq = Math.floor(input.toSeq);
  if (!Number.isFinite(toSeq) || toSeq <= from) {
    return { added: 0, message: '', error: 'その範囲はすでに抽出済みです' };
  }
  const boundary = messageAtSeq(chatId, toSeq);
  if (!boundary) return { added: 0, message: '', error: '指定された範囲が見つかりません' };

  // 保存先は「このチャットの参加キャラ」に限る。プレビューもそこからしか作らない
  const allowed = new Set(getCharacters(chat.participant_ids).map((c) => c.id));
  const knownIds = new Set(listCharacters(chat.world_id).map((c) => c.id));
  // 日付はクライアントの申告ではなく、範囲末尾のステートから引き直す
  const gameTime = boundary.state_after?.time ?? null;

  const items = (input.candidates ?? []).slice(0, MAX_COMMIT);
  let added = 0;
  let rejected = 0;
  for (const c of items) {
    const content = (c.content ?? '').trim().slice(0, MAX_CONTENT_CHARS);
    if (!content) continue;
    if (!c.character_id || !allowed.has(c.character_id)) {
      rejected++;
      continue;
    }
    const subject = c.subject && knownIds.has(c.subject) ? c.subject : '';
    createMemory(c.character_id, { subject, content, source: 'auto', game_time: gameTime });
    added++;
  }

  // 保存したら境界を進める。進めないと自動抽出が同じ範囲をもう一度拾って重複する。
  // 直前の失敗で待たせていた分もここで解除する
  updateChat(chatId, { extracted_up_to: boundary.id, extracted_up_to_seq: boundary.seq });
  retryAt.delete(chatId);

  const parts = [added ? `メモリーを${added}件保存しました` : 'メモリーは保存しませんでした'];
  if (rejected) parts.push(`${rejected}件は対象のキャラクターではないため除きました`);
  parts.push(`ここまでを抽出済みにしました`);
  return { added, message: parts.join('。') };
}

/**
 * 応答保存直後のバックグラウンド判定。
 * 自動要約とは独立に判定する（auto_summarize を切っても自動抽出は動く）。
 * 起動した場合は `done` に結果が入る。呼び出し側はこれを待って通知を出す。
 */
export function maybeExtract(
  chatId: string,
  settings: Settings,
): { needed: boolean; done: Promise<Notice | null> } {
  const none = { needed: false, done: Promise.resolve(null) };
  if (settings.auto_extract !== 1) return none;
  if (extracting.has(chatId)) return none;
  const chat = getChat(chatId);
  if (!chat) return none;
  const pending = messagesAfterSeq(chatId, chat.extracted_up_to_seq ?? 0).length;
  // 抽出の間隔は要約と揃える（§10.2）。
  // 直前に失敗している場合は、さらに間隔ぶん貯まるまで待つ
  const threshold = retryAt.get(chatId) ?? Math.max(MIN_EXTRACT_MESSAGES, settings.summary_interval);
  if (pending < threshold) return none;

  const done = runExtract(chatId, settings).then((r) =>
    r.skipped || !r.message ? null : { kind: 'memory' as const, ok: !r.failed, message: r.message },
  );
  return { needed: true, done };
}
