import type {
  Chat,
  DirectorNote,
  DirectorView,
  Message,
  Notice,
  Scenario,
  Settings,
} from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
import { getCharacters } from '../db/repo/characters.js';
import { getChat } from '../db/repo/chats.js';
import { insertDirectorNote, latestDirectorNote } from '../db/repo/directorNotes.js';
import { listMessages } from '../db/repo/messages.js';
import { getDefaultPersona, getPersona } from '../db/repo/personas.js';
import { getScenario } from '../db/repo/scenarios.js';
import { getSettings, resolveFlag } from '../db/repo/settings.js';
import { latestSummary } from '../db/repo/summaries.js';
import { getWorld } from '../db/repo/worlds.js';
import { complete } from '../llm/openrouter.js';
import { formatGameDate, formatSituationTime } from './calendar.js';

// ---------------------------------------------------------------------------
// 裏の台本（§23）
//
// 本文を書くモデルは「設定＋あらすじ＋直近の会話」しか見ておらず、物語がどこへ
// 向かっているかを知らない。ここでは安いモデルに数場面ごとに台本（ledger）を
// 書き直させ、本文のプロンプトには短い演出指示（cue）だけを渡す。
//
//   - ledger は**本文のプロンプトに載せない。** 秘密や回収予定を丸ごと渡すと、
//     本文側が先回りして明かしてしまう。次の台本更新の材料にだけ使う
//   - cue は末尾 system（層D）に載る。前置きのキャッシュ（§6.7）は崩さない
//   - 有効化は events_enabled と同じ3段解決。**OFFなら呼び出しも注入も一切しない**
// ---------------------------------------------------------------------------

const LEDGER_OPEN = '@@@LEDGER';
const CUE_OPEN = '@@@CUE';
const END = '@@@END';

/** 台本更新に渡す会話の上限（文字）。古い方から落とす */
const MAX_CONVO_CHARS = 24000;
/** 前回の更新から増えた分が少なくても、最低これだけは直近を見せる */
const MIN_RECENT_MESSAGES = 12;

/** 同じチャットで台本更新が重ならないようにする */
const running = new Set<string>();

export interface DirectorFlag {
  enabled: boolean;
  from: 'chat' | 'scenario' | 'settings';
}

export function resolveDirector(
  chat: Pick<Chat, 'director_enabled'>,
  scenario: Pick<Scenario, 'director_enabled'> | null | undefined,
  settings: Settings,
): DirectorFlag {
  const c = chat.director_enabled;
  const s = scenario?.director_enabled;
  return {
    enabled: resolveFlag(c, s, settings.director_enabled),
    from:
      c !== null && c !== undefined ? 'chat' : s !== null && s !== undefined ? 'scenario' : 'settings',
  };
}

function flagOf(chat: Chat, settings: Settings): DirectorFlag {
  const scenario = chat.scenario_id ? (getScenario(chat.scenario_id) ?? null) : null;
  return resolveDirector(chat, scenario, settings);
}

/** 前回の台本から増えた応答（assistant）の数 */
function pendingCount(messages: Message[], note: DirectorNote | undefined): number {
  const from = note?.up_to_seq ?? 0;
  return messages.filter((m) => m.role === 'assistant' && m.seq > from).length;
}

/**
 * 更新が要るか。初回は早めに（応答2回で）作る。
 * 間隔どおり6回待つと、最初の数場面が台本なしで終わってしまう
 */
function thresholdOf(note: DirectorNote | undefined, settings: Settings): number {
  const interval = Math.max(1, settings.director_interval);
  return note ? interval : Math.min(2, interval);
}

export function getDirectorView(chatId: string): DirectorView | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const settings = getSettings();
  const flag = flagOf(chat, settings);
  const note = latestDirectorNote(chatId) ?? null;
  return {
    ...flag,
    note,
    pending: pendingCount(listMessages(chatId), note ?? undefined),
    interval: Math.max(1, settings.director_interval),
    running: running.has(chatId),
  };
}

/**
 * 本文のプロンプトに載せるブロック。**OFF・台本なし・cue が空なら空文字。**
 * 空のときは見出しも出さず、1文字も足さない
 */
export function buildDirectorBlock(chat: Chat, scenario: Scenario | null, settings: Settings): string {
  if (!resolveDirector(chat, scenario, settings).enabled) return '';
  const cue = latestDirectorNote(chat.id)?.cue.trim();
  if (!cue) return '';
  return `# 物語の舵取り（作者の裏メモ）
以下は次の数場面に向けた作者の方針である。場面の流れに合うときだけ自然に織り込み、急がない。
すでに描写したことは繰り返さない。ユーザーの行動や選択を代わりに決めない。
登場人物はこのメモの存在を知らず、知らないはずのことを口にしない。

${cue}`;
}

// ---- 台本の更新 ----

function buildPrompt(input: {
  worldPrompt: string;
  scenario: string;
  characters: string;
  persona: string;
  summary: string;
  ledger: string;
  convo: string;
  now: string;
  maxChars: number;
}): string {
  return `あなたは長編小説の作者であり、読者（ユーザー）と一緒に物語を紡いでいる。
本文は別の書き手が書く。あなたの仕事は、物語の裏で「どこへ向かうか」を設計し続けることである。
本文は書かない。

# 方針
- すでに起きたことを正とする。過去の出来事や設定と矛盾する計画を立てない。
- 驚きを用意する。ただし、後から振り返ると筋が通っている驚きにする。回収する前に必ず伏線を張る。
- 転機は一度に一つ。急がない。張った伏線は数場面以上寝かせてから回収する。
- ユーザーの分身（対話相手）の行動・感情・選択は決めない。ユーザーが選べる余地を残す。
- 前回の台本を引き継ぎ、状況に合わせて更新する。不要になった計画は捨ててよい。
- ユーザーが計画と違う方向へ進んだら、それを尊重して計画のほうを組み替える。

# 出力形式（この形式以外を書かない）
${LEDGER_OPEN}
## 現在の幕と、物語の向かう先
## 張った伏線（未回収）
- 内容 ／ どこで張ったか ／ 回収の見込み
## 人物の秘密と思惑
## 次に起こしたい転機
## 避けること
${CUE_OPEN}
- 次の数場面で本文の書き手に頼む演出を1〜3行。具体的で小さなものにする（例: ある人物の手元の傷に一度だけ視線を留める）。
- 秘密そのものは書かない。書き手が先に明かしてしまうため。
${END}

台本（${LEDGER_OPEN} から ${CUE_OPEN} まで）は${input.maxChars}文字程度に収める。

# 世界設定
${input.worldPrompt || '（なし）'}

# シナリオ
${input.scenario || '（なし）'}

# 登場人物
${input.characters || '（なし）'}

# ユーザーの分身
${input.persona || '（なし）'}

# これまでのあらすじ
${input.summary || '（なし）'}

# 前回の台本
${input.ledger || '（まだない。ここから設計する）'}

# 直近の本文（各行の [日付] はゲーム内日付）
${input.convo}

# 現在
${input.now}`;
}

export function parseDirectorOutput(text: string): { ledger: string; cue: string } | null {
  const li = text.indexOf(LEDGER_OPEN);
  const ci = text.indexOf(CUE_OPEN);
  if (li === -1 || ci === -1 || ci < li) return null;
  const ledger = text.slice(li + LEDGER_OPEN.length, ci).trim();
  const ei = text.indexOf(END, ci);
  const cue = text.slice(ci + CUE_OPEN.length, ei === -1 ? undefined : ei).trim();
  if (!ledger || !cue) return null;
  return { ledger, cue };
}

export interface DirectorResult {
  ok: boolean;
  skipped: boolean;
  message: string;
  note: DirectorNote | null;
}

/**
 * 台本を1回更新する。**例外を投げず、必ず結果を返す**（要約と同じ。裏で走るため）。
 * 手動更新（ボタン）からも呼ぶので、有効化スイッチはここでは見ない
 */
export async function runDirector(chatId: string, settings: Settings): Promise<DirectorResult> {
  if (running.has(chatId)) return { ok: true, skipped: true, message: '', note: null };
  running.add(chatId);
  try {
    return await directOnce(chatId, settings);
  } catch (err) {
    const message = `裏の台本の更新に失敗しました: ${(err as Error).message}`;
    console.warn(`[director] ${message}`);
    return { ok: false, skipped: false, message, note: null };
  } finally {
    running.delete(chatId);
  }
}

async function directOnce(chatId: string, settings: Settings): Promise<DirectorResult> {
  const chat = getChat(chatId);
  if (!chat) return { ok: false, skipped: false, message: 'チャットが見つかりません', note: null };
  const messages = listMessages(chatId);
  const last = messages[messages.length - 1];
  if (!last) return { ok: false, skipped: false, message: 'まだ本文がありません', note: null };

  const world = getWorld(chat.world_id);
  const scenario = chat.scenario_id ? (getScenario(chat.scenario_id) ?? null) : null;
  const calendar = getCalendar(chat.world_id);
  const prev = latestDirectorNote(chatId);
  const persona =
    (chat.persona_id ? getPersona(chat.persona_id) : undefined) ??
    (settings.active_persona_id ? getPersona(settings.active_persona_id) : undefined) ??
    getDefaultPersona() ??
    null;
  const personaName = persona?.name || 'あなた';

  // 前回の境界より後ろは全部、ただし最低 MIN_RECENT_MESSAGES 件は見せる。
  // 上限を超えたら古い方から落とす（直近ほど次の展開に効く）
  const fromSeq = prev?.up_to_seq ?? 0;
  const firstNew = messages.findIndex((m) => m.seq > fromSeq);
  const start = Math.max(0, Math.min(firstNew === -1 ? messages.length : firstNew, messages.length - MIN_RECENT_MESSAGES));
  const lines = messages
    .slice(start)
    .map((m) => {
      const body = m.role === 'user' ? `${personaName}: ${m.content}` : m.content;
      return `[${formatGameDate(calendar, m.state_after.time)}] ${body}`;
    });
  let total = lines.reduce((s, l) => s + l.length + 1, 0);
  while (lines.length > 2 && total > MAX_CONVO_CHARS) total -= lines.shift()!.length + 1;

  const characters = getCharacters(chat.participant_ids)
    .map((c) => `## ${c.name}\n${c.persona || ''}`.trim())
    .join('\n\n');

  const prompt = buildPrompt({
    worldPrompt: world?.system_prompt ?? '',
    scenario: scenario?.description ?? '',
    characters,
    persona: persona ? `${persona.name}\n${persona.description}` : '',
    summary: latestSummary(chatId)?.content ?? '',
    ledger: prev?.ledger ?? '',
    convo: lines.join('\n'),
    now: formatSituationTime(calendar, last.state_after.time),
    maxChars: settings.director_max_chars,
  });

  const model = settings.director_model || settings.utility_model || settings.default_model;
  const maxTokens = Math.max(settings.utility_max_tokens, Math.ceil(settings.director_max_chars * 3));
  const r = await complete({ model, messages: [{ role: 'user', content: prompt }], maxTokens });
  const parsed = parseDirectorOutput(r.text);
  if (!parsed) {
    const why = r.refusal
      ? `モデルが拒否しました（${r.refusal.slice(0, 80)}）`
      : r.finishReason === 'length'
        ? `応答が上限（${maxTokens}トークン）で切れました`
        : !r.text.trim()
          ? `モデルが空の応答を返しました（finish_reason=${r.finishReason || '不明'}）`
          : '決められた形式で返ってきませんでした';
    return { ok: false, skipped: false, message: `裏の台本の更新に失敗しました: ${why}`, note: null };
  }

  const note = insertDirectorNote({
    chat_id: chatId,
    up_to_seq: last.seq,
    ledger: parsed.ledger,
    cue: parsed.cue,
    model,
  });
  // **中身は通知に出さない。** ネタバレを避けたい人がいるため。見たい人は会話の設定から開く
  return { ok: true, skipped: false, message: '裏の台本を更新しました', note };
}

/**
 * 応答保存直後のバックグラウンド判定。要約（maybeSummarize）と同じ形で返す。
 * OFF のときは何もしない（呼び出しゼロ）
 */
export function maybeDirect(
  chatId: string,
  settings: Settings,
): { needed: boolean; done: Promise<Notice | null> } {
  const none = { needed: false, done: Promise.resolve(null) };
  const chat = getChat(chatId);
  if (!chat || !flagOf(chat, settings).enabled) return none;
  if (running.has(chatId)) return none;
  const note = latestDirectorNote(chatId);
  if (pendingCount(listMessages(chatId), note) < thresholdOf(note, settings)) return none;

  const done = runDirector(chatId, settings).then((r) =>
    r.skipped || !r.message ? null : { kind: 'director' as const, ok: r.ok, message: r.message },
  );
  return { needed: true, done };
}
