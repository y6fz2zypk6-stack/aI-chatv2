import type { Character, StateDelta, Utterance, VarValue } from '../../../shared/types.js';

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
        const n = parseInt(value.replace(/[^\d-]/g, ''), 10);
        if (Number.isFinite(n)) delta.elapsed_minutes = n;
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

export interface ParseContext {
  /** 参加キャラ */
  participants: Character[];
  /** 準レギュラー（is_npc_pool = 1、未参加のもの） */
  npcPool: Character[];
  personaName: string;
}

export interface ParseResult {
  utterances: Utterance[];
  warnings: string[];
  /** 準レギュラーが発話した場合の自動参加提案（§5.4-4） */
  autoJoinCharacterIds: string[];
}

interface Resolved {
  speaker: Utterance['speaker'];
  name: string;
  characterId?: string;
  matchLen: number;
  autoJoin?: boolean;
}

/** ラベル文字列を話者に解決する。優先順位は§5.4 */
function resolveSpeaker(label: string, ctx: ParseContext): Resolved | null {
  const candidates: Resolved[] = [];

  const tryChar = (c: Character, autoJoin: boolean) => {
    if (label === c.name) {
      candidates.push({ speaker: 'char', name: c.name, characterId: c.id, matchLen: c.name.length + 1000, autoJoin });
    }
    for (const a of c.aliases) {
      if (a && label === a) {
        candidates.push({ speaker: 'char', name: c.name, characterId: c.id, matchLen: a.length, autoJoin });
      }
    }
  };

  // 1. 参加キャラ
  for (const c of ctx.participants) tryChar(c, false);
  if (candidates.length) return pickLongest(candidates);

  // 2. ペルソナ名（本来出ないはず）
  if (label === ctx.personaName && ctx.personaName) {
    return { speaker: 'user', name: ctx.personaName, matchLen: label.length };
  }

  // 3. 「ナレーター」完全一致
  if (label === 'ナレーター') {
    return { speaker: 'narrator', name: 'ナレーター', matchLen: label.length };
  }

  // 4. 準レギュラー
  for (const c of ctx.npcPool) tryChar(c, true);
  if (candidates.length) return pickLongest(candidates);

  // 5. NPC[名前]
  const npc = /^NPC\[(.*)\]$/.exec(label);
  if (npc) {
    return { speaker: 'npc', name: npc[1].trim() || '？', matchLen: label.length };
  }

  return null;
}

function pickLongest(list: Resolved[]): Resolved {
  return list.sort((a, b) => b.matchLen - a.matchLen)[0];
}

/**
 * 応答本文（フェンス除去済み）を発話配列にパースする。
 * 行頭「話者名: 」を厳格判定し、該当しない行は直前の発話に連結する。
 */
export function parseUtterances(body: string, ctx: ParseContext): ParseResult {
  const warnings: string[] = [];
  const autoJoin = new Set<string>();
  const utterances: Utterance[] = [];

  const push = (u: Utterance) => {
    utterances.push(u);
  };

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      // 空行は段落区切りとして直前の発話に保持
      if (utterances.length) utterances[utterances.length - 1].text += '\n';
      continue;
    }
    const m = /^([^\s:：][^:：]{0,29})[:：]\s?(.*)$/.exec(line);
    let resolved: Resolved | null = null;
    if (m) resolved = resolveSpeaker(m[1].trim(), ctx);

    if (resolved) {
      if (resolved.speaker === 'user') {
        warnings.push(`ペルソナ名が話者として出力されました: ${line.slice(0, 40)}`);
      }
      if (resolved.autoJoin && resolved.characterId) autoJoin.add(resolved.characterId);
      push({
        speaker: resolved.speaker,
        name: resolved.name,
        characterId: resolved.characterId,
        text: m![2],
      });
    } else if (utterances.length) {
      // 6. 該当なし → 直前の発話に連結
      const last = utterances[utterances.length - 1];
      last.text += (last.text.endsWith('\n') || last.text === '' ? '' : '\n') + line;
      if (m) warnings.push(`未知の話者ラベルを本文として扱いました: ${m[1].slice(0, 20)}`);
    } else {
      // 先頭からラベルなし → ナレーター扱い（防御）
      push({ speaker: 'narrator', name: 'ナレーター', text: line });
      warnings.push('先頭行に話者ラベルがないため地の文として扱いました');
    }
  }

  // 7. 連続する同一話者の発話をマージ（間を空行1つで連結）
  const merged: Utterance[] = [];
  for (const u of utterances) {
    u.text = u.text.replace(/\n+$/, '');
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.speaker === u.speaker &&
      prev.name === u.name &&
      prev.characterId === u.characterId
    ) {
      prev.text = `${prev.text}\n\n${u.text}`;
    } else {
      merged.push({ ...u });
    }
  }

  return { utterances: merged, warnings, autoJoinCharacterIds: [...autoJoin] };
}

/** 発話配列から保存用の生テキスト（話者ラベル付き）を組み立て直す */
export function utterancesToContent(utterances: Utterance[]): string {
  return utterances
    .map((u) => (u.speaker === 'npc' ? `NPC[${u.name}]: ${u.text}` : `${u.name}: ${u.text}`))
    .join('\n');
}
