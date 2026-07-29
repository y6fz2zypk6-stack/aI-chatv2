// 依存なしでPWAアイコンPNGを生成するスクリプト（開発時に一度実行して成果物をコミット）
// 使い方: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '../public/icons');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512; // 512基準の座標系
  const radius = 118 * s;
  // 吹き出し形状（アイコンSVGと同じデザイン）
  const bubble = { cx: 256 * s, cy: 234 * s, rx: 160 * s, ry: 124 * s };
  const dots = [196, 256, 316].map((x) => ({ x: x * s, y: 240 * s, r: 16 * s }));
  const tail = { x1: 158 * s, y1: 330 * s, x2: 132 * s, y2: 406 * s, x3: 240 * s, y3: 362 * s };

  const inRoundRect = (x, y) => {
    const rx = Math.max(radius - x, x - (size - radius), 0);
    const ry = Math.max(radius - y, y - (size - radius), 0);
    return rx * rx + ry * ry <= radius * radius;
  };
  const inEllipse = (x, y) =>
    ((x - bubble.cx) / bubble.rx) ** 2 + ((y - bubble.cy) / bubble.ry) ** 2 <= 1;
  const inTriangle = (x, y) => {
    const { x1, y1, x2, y2, x3, y3 } = tail;
    const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
    const a = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d;
    const b = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d;
    const c = 1 - a - b;
    return a >= 0 && b >= 0 && c >= 0;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundRect(x + 0.5, y + 0.5)) {
        px[i + 3] = 0;
        continue;
      }
      // 背景: 対角グラデーション #f9b95c → #e97c2e
      const t = (x + y) / (2 * size);
      let r = lerp(0xf9, 0xe9, t);
      let g = lerp(0xb9, 0x7c, t);
      let b = lerp(0x5c, 0x2e, t);
      if (inEllipse(x + 0.5, y + 0.5) || inTriangle(x + 0.5, y + 0.5)) {
        r = 0xff;
        g = 0xfd;
        b = 0xf9;
        for (const d0 of dots) {
          if ((x + 0.5 - d0.x) ** 2 + (y + 0.5 - d0.y) ** 2 <= d0.r * d0.r) {
            r = 0xf6;
            g = 0xa5;
            b = 0x44;
          }
        }
      }
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = 255;
    }
  }
  return px;
}

for (const size of [192, 512]) {
  const png = encodePng(size, render(size));
  writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`icon-${size}.png (${png.length} bytes)`);
}
