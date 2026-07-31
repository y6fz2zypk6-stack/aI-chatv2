/**
 * シード固定の乱数（v1.5.3 §7）。
 * Math.random() を使うと、同じ場面を再生成するたびに天候やイベントの抽選結果が
 * 変わってしまう。天候（§8.2）とイベント抽選の両方がここを通る。
 */

/** FNV-1a 32bit */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 与えたシードから 0 以上 1 未満の値を1つ返す（mulberry32 の1ステップ） */
export function seededRandom(seed: string): number {
  let a = hashSeed(seed) + 0x6d2b79f5;
  a = Math.imul(a ^ (a >>> 15), 1 | a);
  a = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/** seededRandom を () => number の形で渡したいとき用 */
export function seededRand(seed: string): () => number {
  let n = 0;
  return () => seededRandom(`${seed}#${n++}`);
}
