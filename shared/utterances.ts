// 発話のパース（§5.4）。応答本文を「話者ごとの発話」に分ける。
//
// **サーバ（保存時）とクライアント（生成中の表示）が同じ規則を使うためにここへ置いている。**
// 生成中だけ別の分け方をすると、完了した瞬間に吹き出しの区切りが変わって見える。
// サーバ側は server/src/llm/parse.ts から再エクスポートして使う。
import type { Character, Utterance } from './types.js';

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

/**
 * ラベル文字列を話者に解決する。優先順位は§5.2。
 *
 * **参加キャラが最優先。** 実際に場にいる人物の名前は、ペルソナ名や「ナレーター」と
 * 同名でも人物の発話として扱う。その次にペルソナ名を見るのは、代弁を早い段階で
 * 検出するため（`personaCollisions` も参照）。
 */
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
