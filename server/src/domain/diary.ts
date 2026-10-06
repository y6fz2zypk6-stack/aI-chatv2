import type { ChatState, Diary, DiaryDay, DiaryIndex, Message, Settings } from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
import { getCharacter, getCharacters } from '../db/repo/characters.js';
import { getChat } from '../db/repo/chats.js';
import { listDiaries, upsertDiary } from '../db/repo/diaries.js';
import { listMemories } from '../db/repo/memories.js';
import { listMessages } from '../db/repo/messages.js';
import { getDefaultPersona, getPersona } from '../db/repo/personas.js';
import { complete } from '../llm/openrouter.js';
import { formatGameDate, minToHhmm, worldDayOf, worldDayStart, MIN_PER_DAY } from './calendar.js';

/**
 * キャラクターの日記（§22）。
 *
 * **読み物であって、記憶ではない。** 本文生成のプロンプトには一切載せない。
 * 日記の内容が本編と食い違っても物語が壊れないよう、完全に独立させてある。
 *
 * 範囲は「世界の1日」（worldDayOf = 1日の区切り時刻起点）。天候の引き直しと同じ境界なので、
 * 深夜まで続いた場面は前日の日記に入る。範囲指定やLLMのフラグは使わない。
 */

/** 1回に渡す本文の上限。長い日は朝の方から削る（夜の方が「今日の締めくくり」に近い） */
const INPUT_MAX_CHARS = 24000;
export const DIARY_LENGTHS = { short: 300, normal: 600, long: 1000 } as const;
export type DiaryLength = keyof typeof DIARY_LENGTHS;

interface DaySlice {
  day: number;
  /** その日のメッセージと、各メッセージの時点で居合わせた人物 */
  items: { message: Message; present: Set<string> }[];
}

/**
 * メッセージを世界の日ごとに分ける。
 * 在席は「直前の状態」と「このメッセージの後の状態」の和で見る。
 * 場面の途中で去った人も、その場面には居合わせているため
 */
function sliceByDay(chatId: string): { slices: DaySlice[]; initial: ChatState } | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const cal = getCalendar(chat.world_id);
  const byDay = new Map<number, DaySlice>();
  let prev: ChatState = chat.initial_state;
  for (const m of listMessages(chatId)) {
    const day = worldDayOf(cal, m.state_after.time);
    const present = new Set([...(prev.present ?? []), ...(m.state_after.present ?? [])]);
    let s = byDay.get(day);
    if (!s) byDay.set(day, (s = { day, items: [] }));
    s.items.push({ message: m, present });
    prev = m.state_after;
  }
  return { slices: [...byDay.values()].sort((a, b) => b.day - a.day), initial: chat.initial_state };
}

export function diaryIndex(chatId: string): DiaryIndex | null {
  const chat = getChat(chatId);
  const sliced = sliceByDay(chatId);
  if (!chat || !sliced) return null;
  const cal = getCalendar(chat.world_id);
  const allIds = new Set<string>();
  const days: DiaryDay[] = sliced.slices.map((s) => {
    const ids = new Set<string>();
    for (const it of s.items) for (const id of it.present) ids.add(id);
    for (const id of ids) allIds.add(id);
    return {
      day: s.day,
      date_label: formatGameDate(cal, worldDayStart(cal, s.day)),
      character_ids: [...ids],
      message_count: s.items.length,
    };
  });
  const entries = listDiaries(chatId);
  for (const e of entries) allIds.add(e.character_id);
  const characters = getCharacters([...allIds]).map((c) => ({ id: c.id, name: c.name, avatar: c.avatar }));
  // 登録キャラだけを残す（在席IDに消されたキャラが残っていることがある）
  const known = new Set(characters.map((c) => c.id));
  for (const d of days) d.character_ids = d.character_ids.filter((id) => known.has(id));
  return { days: days.filter((d) => d.character_ids.length > 0), entries, characters };
}

/** 同じ日記を二重に書かせない（連打で2回払うのを防ぐ） */
const writing = new Set<string>();

export type DiaryResult = { ok: true; diary: Diary } | { ok: false; status: number; error: string };

export async function writeDiary(
  chatId: string,
  characterId: string,
  day: number,
  length: DiaryLength,
  settings: Settings,
): Promise<DiaryResult> {
  const chat = getChat(chatId);
  if (!chat) return { ok: false, status: 404, error: 'チャットが見つかりません' };
  const character = getCharacter(characterId);
  if (!character) return { ok: false, status: 404, error: 'キャラクターが見つかりません' };
  const sliced = sliceByDay(chatId);
  const slice = sliced?.slices.find((s) => s.day === day);
  const witnessed = (slice?.items ?? []).filter((it) => it.present.has(characterId));
  if (witnessed.length === 0) {
    return { ok: false, status: 400, error: `この日、${character.name}が居合わせた場面がありません` };
  }

  const key = `${chatId}:${characterId}:${day}`;
  if (writing.has(key)) return { ok: false, status: 409, error: 'この日の日記はいま書いています' };
  writing.add(key);
  try {
    const cal = getCalendar(chat.world_id);
    const dateLabel = formatGameDate(cal, worldDayStart(cal, day));
    const persona =
      (chat.persona_id ? getPersona(chat.persona_id) : undefined) ?? getDefaultPersona() ?? null;
    const userName = persona?.name || 'あなた';

    // 場面転換マーカーは本文が無いので区切りとして見せる
    const lines = witnessed.map(({ message: m }) => {
      const t = minToHhmm(((m.state_after.time % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY);
      if (m.kind === 'scene_break') return `[${t}] ――場面転換――`;
      const body = m.role === 'user' ? `${userName}: ${m.content}` : m.content;
      return `[${t}] ${body}`;
    });
    // 上限を超えたら朝の方から落とす
    let omitted = 0;
    let total = lines.reduce((n, l) => n + l.length + 1, 0);
    while (total > INPUT_MAX_CHARS && lines.length > 1) {
      total -= lines.shift()!.length + 1;
      omitted++;
    }

    const firstState = witnessed[0].message.state_after;
    const weather = firstState.weather ? `天候: ${firstState.weather}` : '';

    // 記憶はピン留め（大事なもの）だけ。全部渡すとコストのわりに日記が説明的になる
    const pinned = listMemories(characterId).filter((m) => m.pinned === 1 && m.enabled !== 0);

    const chars = DIARY_LENGTHS[length];
    const sections = [
      `あなたは${character.name}として、${dateLabel}の日記を書く。`,
      `# ${character.name}の人物像\n${character.persona || '（記載なし）'}`,
    ];
    if (character.speech_style) sections.push(`## 話し方\n${character.speech_style}`);
    if (character.example_dialogue) sections.push(`## 口調例\n${character.example_dialogue}`);
    if (pinned.length) {
      sections.push(
        `# ${character.name}が大切に覚えていること\n${pinned.map((m) => `- ${m.content}`).join('\n')}`,
      );
    }
    sections.push(
      `# この日の記録（${character.name}が居合わせた場面のみ）
各行の [時刻] はゲーム内時刻。「${userName}」は相手の人物、「ナレーター」は地の文。
${weather}${omitted ? `\n（この日の前半 ${omitted} 件は長いため省略）` : ''}

${lines.join('\n')}`,
    );
    sections.push(`# 書き方
- ${character.name}本人が、その日の終わりに自分のためだけに書く日記として一人称で書く。口調・語彙は${character.name}のものにする。
- 材料は記録にある出来事だけ。記録に無い出来事・会話を作らない。
- ${character.name}が見聞きしていないことや、他人の内心の断定は書かない。
- 口に出さなかった本音・迷い・期待・照れは書いてよい。誰にも見せない日記である。
- 出来事を時系列で全部なぞらない。${character.name}の心に残ったことを選んで書く。
- ${chars}文字程度。
- 1行目に日付（${dateLabel}）を${character.name}らしい書き方で置き、そのあと本文。前置き・解説・見出し記号は書かない。`);

    const model = settings.utility_model || settings.default_model;
    const maxTokens = Math.max(settings.utility_max_tokens, Math.ceil(chars * 3));
    const r = await complete({
      model,
      messages: [{ role: 'user', content: sections.join('\n\n') }],
      maxTokens,
    });
    const content = r.text.trim();
    if (!content) {
      const why = r.refusal
        ? `モデルが拒否しました（${r.refusal.slice(0, 80)}）`
        : r.finishReason === 'length'
          ? `応答が上限（${maxTokens}トークン）で切れました`
          : `モデルが空の応答を返しました（finish_reason=${r.finishReason || '不明'}）`;
      return { ok: false, status: 502, error: `日記を書けませんでした: ${why}` };
    }
    const diary = upsertDiary({
      chat_id: chatId,
      character_id: characterId,
      day,
      date_label: dateLabel,
      content,
      model,
    });
    return { ok: true, diary };
  } catch (err) {
    return { ok: false, status: 502, error: `日記を書けませんでした: ${(err as Error).message}` };
  } finally {
    writing.delete(key);
  }
}
