// vite build のあとに走らせ、実際の成果物を precache する sw.js を作る。
//   node scripts/build-sw.mjs
//
// ハッシュ付きのファイル名はビルドごとに変わるので、sw.js に固定で書けない。
// ここで dist を読んで一覧を埋め込み、内容から版番号を作る。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');

/** dist配下を再帰的に集める（URLパスで返す） */
function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = `${base}/${name}`;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

const all = walk(dist);

// 起動に要るものだけを precache する。
// 書体のwoff2は全体で10MB超あり、install時に全部取りに行くと重すぎるので、
// fonts.css だけ入れて実体は使ったものから拾う（未取得の字は端末の書体で出る）
const precache = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  ...all.filter((p) => p.startsWith('/assets/')),
  ...all.filter((p) => p.startsWith('/icons/')),
  '/fonts/fonts.css',
].filter((p, i, xs) => xs.indexOf(p) === i);

// 一覧に無いものを precache すると addAll がまるごと失敗するので、実在を確かめる
const missing = precache.filter((p) => p !== '/' && !all.includes(p));
if (missing.length) {
  console.error(`[sw] dist に無いファイルを precache しようとしています: ${missing.join(', ')}`);
  process.exit(1);
}

// 版番号は中身から作る。同じビルドなら同じ、変われば別のキャッシュになる
const hash = createHash('sha256');
for (const p of precache) {
  if (p === '/') continue;
  hash.update(p);
  hash.update(readFileSync(path.join(dist, p)));
}
const version = hash.digest('hex').slice(0, 12);

const template = readFileSync(path.join(here, '..', 'sw.template.js'), 'utf-8');
const sw = template
  .replaceAll('__VERSION__', version)
  .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));
if (sw.includes('__VERSION__') || sw.includes('__PRECACHE__')) {
  console.error('[sw] 差し込みに失敗しました');
  process.exit(1);
}

writeFileSync(path.join(dist, 'sw.js'), sw);
console.log(`[sw] charchat-${version} / precache ${precache.length}件`);
