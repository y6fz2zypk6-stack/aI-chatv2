import { randomBytes } from 'node:crypto';

// Crockford Base32
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRand: number[] = [];

/** 依存なしのULID実装。時系列ソート可能・同一ミリ秒内は単調増加 */
export function ulid(): string {
  const now = Date.now();
  let rand: number[];
  if (now === lastTime) {
    // 同一ミリ秒内はランダム部をインクリメントして単調性を保つ
    rand = [...lastRand];
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) {
        rand[i]++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    rand = Array.from({ length: 16 }, (_, i) => bytes[i] % 32);
  }
  lastTime = now;
  lastRand = rand;

  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ENC[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  return ts + rand.map((v) => ENC[v]).join('');
}
