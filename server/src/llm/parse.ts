import type { StateDelta, Utterance, VarValue } from '../../../shared/types.js';

export const FENCE_OPEN = '@@@STATE';
export const FENCE_CLOSE = '@@@END';

/** 応答本文から @@@STATE フェンスを分離する（§5.1） */
export function splitFence(raw: string): { body: string; fence: string | null } {
  const idx = raw.indexOf(FENCE_OPEN);
  if (idx === -1) return { body: raw.trim(), fence: null };
  const body = raw.slice(0, idx).trim();
  let rest = raw.slice(idx + FENCE_OPEN.length);
  const endIdx = rest.indexOf(FENCE_CLOSE);
  if (endIdx !== -1) rest = rest.slice(0, endIdx);
  return { body, fence: rest.trim() };
}

/** カンマ・読点区切りのID列 */
function splitIds(s: string): string[] {
  return s
    .split(/[,、，]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 経過時間（分）として読む。読めなければ null。
 *
 * **数字だけを拾って連結しないこと。** `value.replace(/[^\d-]/g, '')` のような書き方だと
 * 「1時間30分」が 130 分になる。ゲーム内時刻はここから直接進むので、
 * パーサの誤読がそのまま履歴に残ってしまう。
 *
 * 時刻を読む `parseHhmm`（`shared/types.ts`）とは別物。あちらは「18:30」という
 * 時点を読む関数で、こちらは長さを読む。流用すると意味がずれる。
 *
 * 受けるのは次だけ。それ以外は null にして、呼び出し側で既定値＋警告に落とす。
 *   - 整数そのまま: `10` / `90` / `-5`
 *   - 分: `90分` / `30m` / `30min`
 *   - 時間: `2時間` / `2h`
 *   - 時間＋分: `1時間30分` / `1h30m`
 */
export function parseDurationMinutes(raw: string): number | null {
  const s = raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[−ー―]/g, '-')
    .toLowerCase();
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);

  const m = /^(?:(\d+)\s*(?:時間|h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:分|m|min|mins|minute|minutes))?$/
    .exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/** フェンス内容 → StateDelta。壊れていれば null */
export function parseStateDelta(fence: string | null): StateDelta | null {
  if (fence == null) return null;
  const delta: StateDelta = { elapsed_minutes: 10, present_add: [], present_remove: [] };
  let sawAny = false;
  for (const line of fence.split('\n')) {
    const m = /^\s*([a-zA-Z_]+)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    switch (key) {
      case 'elapsed_minutes': {
        const n = parseDurationMinutes(value);
        if (n === null) delta.elapsed_unparsed = value.slice(0, 40);
        else delta.elapsed_minutes = n;
        sawAny = true;
        break;
      }
      case 'location':
        if (value) delta.location = value;
        sawAny = true;
        break;
      case 'present_add':
        delta.present_add = splitIds(value);
        sawAny = true;
        break;
      case 'present_remove':
        delta.present_remove = splitIds(value);
        sawAny = true;
        break;
      case 'set_var': {
        // set_var: case_ash_phase=2, toby_met=true （代入のみ。§3.2）
        const assigns: Record<string, VarValue> = {};
        for (const pair of value.split(/[,、，]/)) {
          const eq = pair.indexOf('=');
          if (eq <= 0) continue;
          const k = pair.slice(0, eq).trim();
          const raw = pair.slice(eq + 1).trim();
          if (!k || raw === '') continue;
          if (raw === 'true') assigns[k] = true;
          else if (raw === 'false') assigns[k] = false;
          else if (/^-?\d+(\.\d+)?$/.test(raw)) assigns[k] = Number(raw);
          else assigns[k] = raw.slice(0, 32);
        }
        if (Object.keys(assigns).length) delta.set_var = assigns;
        sawAny = true;
        break;
      }
    }
  }
  return sawAny ? delta : null;
}

/** フェンス欠落・生成停止時のフォールバック差分 */
export function fallbackDelta(elapsed: number): StateDelta {
  return { elapsed_minutes: elapsed, present_add: [], present_remove: [], fallback: true };
}

// ---- サニタイズ（§5.5） ----

/**
 * 保存前に行頭の assistant / human / system を除去し、
 * ユーザー（ペルソナ）のターンが始まった行以降を切り捨てる
 */
export interface SanitizeResult {
  text: string;
  /**
   * ペルソナ（または `user:`）の行が現れて、そこ以降を捨てたか。
   *
   * **捨てたことを呼び出し側へ伝える。** 伝えないと、代弁が原因で本文が短くなった
   * ことに誰も気づけない。とくにフェンス欠落と取り違えると、利用者は
   * 「モデルが @@@STATE を書いてくれない」方向を調べ始めてしまう（§5.6）。
   */
  impersonated: boolean;
}

/**
 * 本文から「モデルが書いてはいけない行」を落とす（§5.4）。
 *
 * **`@@@STATE` フェンスを渡さないこと。** フェンスは本文の後ろに付くので、
 * 代弁行で打ち切るこの処理に通すとフェンスまで消える。呼び出し側は
 * `splitFence` で本文とフェンスを分けたあと、本文だけをここへ渡す。
 */
export function sanitizeResponse(raw: string, personaName: string): SanitizeResult {
  const lines = raw.split('\n');
  const out: string[] = [];
  let impersonated = false;
  for (const line of lines) {
    if (/^\s*(assistant|human|system)\s*[:：]/i.test(line)) continue;
    if (
      personaName &&
      (line.startsWith(`${personaName}:`) || line.startsWith(`${personaName}：`))
    ) {
      impersonated = true;
      break;
    }
    if (/^\s*user\s*[:：]/i.test(line)) {
      impersonated = true;
      break;
    }
    out.push(line);
  }
  return { text: out.join('\n').trim(), impersonated };
}

// ---- 発話パース（§5.4） ----
// 本体は shared/utterances.ts（クライアントの生成中の表示と同じ規則を使うため）
export { parseUtterances, type ParseContext, type ParseResult } from '../../../shared/utterances.js';
import type { ParseContext } from '../../../shared/utterances.js';

/**
 * ペルソナ名が他の話者ラベルと衝突していないか（§5.2）。
 *
 * **解決順の問題ではなく、設定の問題として知らせる。** 同名だと `sanitizeResponse` が
 * その行で本文を打ち切るので、たとえばペルソナ名が「ナレーター」だと
 * 地の文が丸ごと消える。これは解決順より手前で起きるため、順序を入れ替えても直らない。
 * 気づけないまま「応答が途中で切れる」と悩むことになるので、生成のたびに警告を返す。
 */
export function personaCollisions(personaName: string, ctx: ParseContext): string[] {
  const name = personaName.trim();
  if (!name) return [];
  const out: string[] = [];
  if (name === 'ナレーター') {
    out.push(
      'ペルソナ名が「ナレーター」と同じです。地の文がユーザーの代弁とみなされて削除されるので、ペルソナ名を変えてください',
    );
  }
  const clash = [...ctx.participants, ...ctx.npcPool].find(
    (c) => c.name === name || c.aliases.includes(name),
  );
  if (clash) {
    out.push(
      `ペルソナ名が「${clash.name}」の名前（または別名）と同じです。そのキャラの発話が代弁とみなされるので、どちらかの名前を変えてください`,
    );
  }
  return out;
}

/** 発話配列から保存用の生テキスト（話者ラベル付き）を組み立て直す */
export function utterancesToContent(utterances: Utterance[]): string {
  return utterances
    .map((u) => (u.speaker === 'npc' ? `NPC[${u.name}]: ${u.text}` : `${u.name}: ${u.text}`))
    .join('\n');
}
