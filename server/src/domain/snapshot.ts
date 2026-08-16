import type {
  CalendarConfig,
  ChatState,
  Character,
  Location,
  Message,
  Persona,
  Settings,
} from '../../../shared/types.js';
import { splitDialogue } from '../../../shared/types.js';
import { getReferenceImageOf, type RefOwner } from '../db/repo/references.js';
import { daylightOf, toGameTime } from './calendar.js';
import { MAX_REFERENCES } from '../llm/image.js';

/**
 * スナップショットのプロンプト組み立て（§21）。
 *
 * **ここではLLMを呼ばない。** テンプレートで組んで利用者に見せ、直してもらうのが
 * この機能の入り方（送る前に確認・修正できる）。プレビューが課金しないのも同じ理由。
 *
 * **基準は対象メッセージの `state_after`。** チャットの現在ステートではない。
 * 過去のメッセージを選んだとき、当時の場所・天候・時刻・在席者で描けるようにするため。
 */

/** 地の文から拾う長さ。長すぎると画像モデルが要点を落とす */
const MAX_SCENE_CHARS = 400;

/** `image_no_text` がONのとき末尾に付く1行 */
export const NO_TEXT_LINE =
  'Do not render any text, letters, captions, speech bubbles, subtitles, or UI.';

export interface SnapshotInput {
  settings: Settings;
  calendar: CalendarConfig;
  /** 対象メッセージの state_after を渡すこと */
  state: ChatState;
  locations: Location[];
  /** state.present から引いた在席者（参加キャラ一覧ではない） */
  characters: Character[];
  persona: Persona | null;
  includePersona: boolean;
  message: Message;
}

export interface SnapshotPrompt {
  prompt: string;
  warnings: string[];
}

/** その場面の場所・時刻・天候を1行で。プロンプト用の日本語ブロックとは別物 */
function sceneLine(input: SnapshotInput): string {
  const { calendar, state, locations } = input;
  const loc = locations.find((l) => l.id === state.location);
  const locName = state.location_note || loc?.name || state.location || '';
  const gt = toGameTime(calendar, state.time);
  const hhmm = `${String(gt.hh).padStart(2, '0')}:${String(gt.mm).padStart(2, '0')}`;

  const parts: string[] = [];
  if (locName) parts.push(locName);
  parts.push(`${gt.season}・${hhmm}・${daylightOf(calendar, state.time)}`);
  // 屋内では天候を出さない（本文側の扱いと揃える）
  const indoor = !state.location_note && loc?.indoor === 1;
  if (!indoor && state.weather) parts.push(state.weather);
  return parts.join(' / ');
}

/** 「」の中身（セリフ）を落として地の文だけ残す。表示側と同じ規則（`splitDialogue`） */
function stripDialogue(text: string): string {
  return splitDialogue(text)
    .filter((p) => !p.dlg)
    .map((p) => p.text)
    .join(' ');
}

/**
 * 対象メッセージの地の文だけを拾う。セリフは絵にならない。
 *
 * **話者では分けない。** このアプリのキャラ発話はセリフと地の文が同じ塊に入り、
 * 姿勢・視線・仕草といった描画に直結する記述はむしろそちらに集中している。
 * ナレーター行だけを拾うと、そういうターンの場面描写が丸ごと落ちる。
 * 自分の発言は絵の指示に入れないので、user の発話だけ除く。
 */
function sceneText(message: Message): string {
  const utterances = message.utterances ?? [];
  const narration = utterances
    .filter((u) => u.speaker !== 'user')
    .map((u) => stripDialogue(u.text).trim())
    .filter(Boolean)
    .join(' ');
  // 発話パースが効いていない古いメッセージだけ本文から拾う。
  // **`narration || content` にしないこと。** セリフしか無いターンで本文へ落ちると、
  // 話者ラベル（「アシュリー:」）が場面の描写として入り、警告も出なくなる
  const raw = utterances.length > 0 ? narration : stripDialogue(message.content);
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SCENE_CHARS);
}

/**
 * プロンプトを組み立てる。
 *
 * **見出し（`Characters:` などのラベル）は付けない。** 一度入れて試したが、
 * gpt-image 系では**付けない方が良い絵が出た**ので戻してある。
 * 同じことを繰り返し試さないよう、経緯としてここに残す。
 *
 * 要素を1行ずつ並べるだけ。画風は先頭、文字禁止の指示は末尾（プレビューで消せる）。
 */
export function buildSnapshotPrompt(input: SnapshotInput): SnapshotPrompt {
  const warnings: string[] = [];
  const blocks: string[] = [];

  if (input.settings.image_style_prompt.trim()) {
    blocks.push(input.settings.image_style_prompt.trim());
  }

  const withAppearance = input.characters.filter((c) => c.appearance.trim());
  for (const c of withAppearance) {
    blocks.push(`${c.name}: ${c.appearance.trim()}`);
  }
  if (input.includePersona && input.persona?.appearance.trim()) {
    blocks.push(`${input.persona.name}: ${input.persona.appearance.trim()}`);
  }

  blocks.push(sceneLine(input));

  const scene = sceneText(input.message);
  if (scene) blocks.push(scene);

  // 気づけるようにしておく。黙って人物なしの絵を作らない
  if (input.characters.length === 0) {
    warnings.push('この時点では在席している人物がいません。背景だけの絵になります');
  } else if (withAppearance.length === 0) {
    warnings.push(
      '在席している人物に外見が設定されていません。キャラクターの編集画面で「外見」を書くと絵が安定します',
    );
  }
  if (!scene) {
    warnings.push('このメッセージに地の文がありません。場面の描写はプロンプトに入っていません');
  }

  // 地の文をそのまま渡すので、指示が無いと看板や書類の形で文字を描き込むことがある。
  // プレビューで消せるようにしたいので、ここは末尾に置く
  if (input.settings.image_no_text === 1) {
    blocks.push(NO_TEXT_LINE);
  }

  return { prompt: blocks.join('\n'), warnings };
}

export interface Reference {
  url: string;
  label: string;
  /** 参照専用に上げた画像か、丸アイコンのアバターか。プレビューで見せる */
  from: 'reference' | 'avatar';
}

/**
 * 参照画像（`input_references`）を集める。
 *
 * **参照専用の画像があればそれだけを使う（§21.4）。** アバターは丸アイコン用に
 * 正方形へ切り抜いて320pxまで落としてあるので、服装や全身が伝わらない。
 * 無ければ従来どおりアバターへ落とす。
 *
 * **URLはクライアントから受け取らない。** ここでDBから組み直すことで、
 * 任意のURLをサーバに取りに行かせられないようにする。
 */
export function collectReferences(input: {
  characters: Character[];
  persona: Persona | null;
  includePersona: boolean;
}): Reference[] {
  const out: Reference[] = [];
  const pick = (owner: RefOwner, avatar: string, label: string) => {
    const ref = getReferenceImageOf(owner);
    if (ref) {
      out.push({ url: toDataUrl(ref), label, from: 'reference' });
    } else if (avatar) {
      out.push({ url: avatar, label, from: 'avatar' });
    }
  };

  for (const c of input.characters) {
    pick({ kind: 'character', id: c.id }, c.avatar, c.name);
  }
  if (input.includePersona && input.persona) {
    pick({ kind: 'persona', id: input.persona.id }, input.persona.avatar, input.persona.name);
  }
  // モデルによって上限が違うので、低い方（4件）に合わせて切る
  return out.slice(0, MAX_REFERENCES);
}

const toDataUrl = (row: { mime: string; image: Buffer }): string =>
  `data:${row.mime};base64,${row.image.toString('base64')}`;
