import type { Character, ChatState, Location, StateDelta } from '../../../shared/types.js';
import { completeText } from './openrouter.js';
import { parseStateDelta, splitFence } from './parse.js';

/**
 * state_extraction_mode: separate_call（§5.7-3）
 * 本文生成後に軽量モデルで差分だけを抽出する。フェンスが安定しないモデル向けの代替。
 */
export async function extractStateSeparate(opts: {
  model: string;
  body: string;
  baseState: ChatState;
  locations: Location[];
  characters: Character[];
}): Promise<StateDelta | null> {
  const locList = opts.locations.map((l) => `${l.id}=${l.name}`).join(', ');
  const charList = opts.characters.map((c) => `${c.id}=${c.name}`).join(', ');
  const prompt = `以下はロールプレイの応答本文である。この場面で起きたステートの変化を抽出し、指定形式のみで出力せよ。

場所ID: ${locList}
人物ID: ${charList}
現在の場所: ${opts.baseState.location_note || opts.baseState.location}

出力形式（この形式のみ。説明文は書かない）:
@@@STATE
elapsed_minutes: この応答内で経過した時間（分）。会話のみなら5〜15、移動や場面転換があれば実際の所要時間
location: 場面終了時点の場所。ID一覧から選ぶ。一覧にない場所なら日本語の短い地名をそのまま書く。変化がなければ現在の場所
present_add: その場に加わった人物ID（カンマ区切り。なければ空）
present_remove: その場を離れた人物ID（カンマ区切り。なければ空）
@@@END

応答本文:
${opts.body}`;

  try {
    const raw = await completeText({
      model: opts.model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 256,
    });
    const { fence } = splitFence(raw.includes('@@@STATE') ? raw : `@@@STATE\n${raw}\n@@@END`);
    return parseStateDelta(fence);
  } catch {
    return null;
  }
}
