import type {
  CalendarConfig,
  ChatState,
  Character,
  Location,
  Message,
  Persona,
  Settings,
} from '../../../shared/types.js';
import { daylightOf, toGameTime } from './calendar.js';
import { MAX_REFERENCES } from '../llm/image.js';

/**
 * スナップショットのプロンプト組み立て（§13）。
 *
 * **ここではLLMを呼ばない。** テンプレートで組んで利用者に見せ、直してもらうのが
 * この機能の入り方（送る前に確認・修正できる）。プレビューが課金しないのも同じ理由。
 *
 * **基準は対象メッセージの `state_after`。** チャットの現在ステートではない。
 * 過去のメッセージを選んだとき、当時の場所・天候・時刻・在席者で描けるようにするため。
 */

/** 地の文から拾う長さ。長すぎると画像モデルが要点を落とす */
const MAX_SCENE_CHARS = 400;

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

/** 対象メッセージの地の文だけを拾う。セリフは絵にならない */
function sceneText(message: Message): string {
  const narration = (message.utterances ?? [])
    .filter((u) => u.speaker === 'narrator')
    .map((u) => u.text.trim())
    .filter(Boolean)
    .join(' ');
  // 発話パースが効いていない古いメッセージは本文をそのまま使う
  const raw = narration || message.content;
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SCENE_CHARS);
}

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

  return { prompt: blocks.join('\n'), warnings };
}

export interface Reference {
  url: string;
  label: string;
}

/**
 * 参照画像（`input_references`）に使うアバターを集める。
 *
 * **URLはクライアントから受け取らない。** ここでアバターから組み直すことで、
 * 任意のURLをサーバに取りに行かせられないようにする。
 */
export function collectReferences(input: {
  characters: Character[];
  persona: Persona | null;
  includePersona: boolean;
}): Reference[] {
  const out: Reference[] = [];
  for (const c of input.characters) {
    if (c.avatar) out.push({ url: c.avatar, label: c.name });
  }
  if (input.includePersona && input.persona?.avatar) {
    out.push({ url: input.persona.avatar, label: input.persona.name });
  }
  // モデルによって上限が違うので、低い方（4件）に合わせて切る
  return out.slice(0, MAX_REFERENCES);
}
