import type { LorebookEntry } from '../../../shared/types.js';

export interface LoreFireInput {
  /** スコープ済み（world一致・character_id条件・enabled=1）のエントリ（§7.1） */
  entries: LorebookEntry[];
  /** キーワード走査対象: 直近 lore_scan_window 件の本文連結（§7.2） */
  scanText: string;
  currentLocationId: string;
  currentSeason: string;
  /** 再帰走査 1〜4（§7.3） */
  recursion: number;
  /** 注入予算・文字数（§7.4） */
  budgetChars: number;
}

export interface LoreFireResult {
  fired: LorebookEntry[];
  adopted: LorebookEntry[];
  dropped: LorebookEntry[];
  /** always だけで予算超過（設定ミス警告） */
  alwaysOverBudget: boolean;
}

type FireReason = 'always' | 'tag' | 'keyword';

function keyMatches(entry: LorebookEntry, text: string): boolean {
  const lower = text.toLowerCase();
  return entry.keys.some((k) => k && lower.includes(k.toLowerCase()));
}

/** 発火判定 → 優先順ソート → 予算内採用（§7.2〜7.4） */
export function fireLorebook(input: LoreFireInput): LoreFireResult {
  const reasons = new Map<string, FireReason>();

  // always と場所・季節タグは初回のみ判定（走査に依存しない）
  for (const e of input.entries) {
    if (e.always) {
      reasons.set(e.id, 'always');
    } else if (
      (input.currentLocationId && e.trigger_locations.includes(input.currentLocationId)) ||
      (input.currentSeason && e.trigger_seasons.includes(input.currentSeason))
    ) {
      reasons.set(e.id, 'tag');
    }
  }

  // キーワード走査 + 再帰（発火本文を次の走査対象に追加して連鎖を辿る）
  let scan = input.scanText;
  const depth = Math.max(1, Math.min(4, input.recursion));
  for (let i = 0; i < depth; i++) {
    let newlyFired = false;
    for (const e of input.entries) {
      if (reasons.has(e.id)) continue;
      if (e.keys.length && keyMatches(e, scan)) {
        reasons.set(e.id, 'keyword');
        scan += '\n' + e.content;
        newlyFired = true;
      }
    }
    if (!newlyFired) break;
  }

  const fired = input.entries.filter((e) => reasons.has(e.id));

  // 優先順: ①always → ②場所・季節 → ③キーワード。同順位内は priority DESC, id ASC
  const rank: Record<FireReason, number> = { always: 0, tag: 1, keyword: 2 };
  const sorted = [...fired].sort((a, b) => {
    const r = rank[reasons.get(a.id)!] - rank[reasons.get(b.id)!];
    if (r !== 0) return r;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : 1;
  });

  const adopted: LorebookEntry[] = [];
  const dropped: LorebookEntry[] = [];
  let used = 0;
  let alwaysOverBudget = false;
  for (const e of sorted) {
    const len = e.content.length;
    if (reasons.get(e.id) === 'always') {
      // always は予算計算に含めるが落とさない
      adopted.push(e);
      used += len;
      if (used > input.budgetChars) alwaysOverBudget = true;
    } else if (used + len <= input.budgetChars) {
      adopted.push(e);
      used += len;
    } else {
      dropped.push(e);
    }
  }

  return { fired: sorted, adopted, dropped, alwaysOverBudget };
}

/** §7.1 のスコープ絞り込み */
export function scopeEntries(
  all: LorebookEntry[],
  participantIds: string[],
): LorebookEntry[] {
  return all.filter(
    (e) => e.enabled === 1 && (e.character_id == null || participantIds.includes(e.character_id)),
  );
}
