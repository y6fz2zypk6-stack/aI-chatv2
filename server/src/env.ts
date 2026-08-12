/**
 * `.env` と相対 `DB_PATH` の基準を「リポジトリルート」に固定する（§2.2）。
 *
 * **このモジュールは index.ts の最上段で副作用importすること。**
 * ESMは本体より先にすべてのimportを評価するので、index.ts の本体で dotenv.config() を
 * 呼ぶ形に書き換えると、その前に `./db/index.js` が評価されて DB_PATH 未設定のまま
 * DBが開かれる。同じ理由で db/index.ts からも（fromRoot 経由で）このモジュールを引いており、
 * DBを開く前に必ずここが走る。
 *
 * **cwd を基準にできない。** ルートの `npm run dev` / `npm start` は `-w server` 付きで
 * 走るので cwd は `server/` になる。`dotenv/config` のままだと `server/.env` が読まれ、
 * README と SPEC が指示するルートの `.env` は無視される。
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function isRepoRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
      workspaces?: unknown;
    };
    return Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0;
  } catch {
    // package.json が無い・壊れている。どちらも「ここはルートではない」で構わない
    return false;
  }
}

/**
 * `workspaces` を持つ package.json のある最も近い親を探す。
 * このファイルの位置は実行方法で変わる（tsx: `server/src`、ビルド後: `server/dist/server/src`）
 * が、どちらから上へ辿っても同じルートに着く。cwd は保険。
 */
function findRepoRoot(): string {
  for (const start of [path.dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let dir = start;
    for (;;) {
      if (isRepoRoot(dir)) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  // ルートが見つからない（dist だけ持ち出した等）。従来どおり cwd 基準に落とす
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

/** 相対パスをリポジトリルート基準で解決する */
export function fromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

// ---- 旧レイアウト（server/.env・server/data/）の取り残し ----
//
// 基準が cwd だった頃は `server/` の下に置かれていた。移し忘れたまま起動すると
// 設定が黙って無視され、DBは空として作られて seedIfEmpty() が走る。
// 「初期データの世界が増えて会話が消えた」ように見えるので、気づける形にする。
//
// この判定は **DBを開く前** でなければ意味がない（開いた時点でファイルが作られ、
// 次回からは「新しい側にDBがある」状態になってしまう）。だからモジュール本体で行う。

const legacyEnv = path.join(REPO_ROOT, 'server', '.env');
if (fs.existsSync(legacyEnv)) {
  console.warn(
    `[server] 注意: ${legacyEnv} は読まれません。設定はリポジトリルートの .env に置いてください`,
  );
}

const rawDbPath = process.env.DB_PATH || './data/app.sqlite';
// 絶対パス指定なら移行の対象外。相対パスのときだけ、旧基準（server/）の同じ相対位置を見る
const legacyDb = path.isAbsolute(rawDbPath) ? null : path.resolve(REPO_ROOT, 'server', rawDbPath);
if (legacyDb && !fs.existsSync(fromRoot(rawDbPath)) && fs.existsSync(legacyDb)) {
  console.error(
    [
      '[server] 起動を中止しました: 旧い場所にDBが残っています。',
      `  いま参照する場所: ${fromRoot(rawDbPath)}（ありません）`,
      `  旧い場所:         ${legacyDb}（あります）`,
      '',
      '  .env と DB の基準がリポジトリルートに変わりました。次のどちらかをしてください。',
      `    mv ${path.join(REPO_ROOT, 'server', 'data')} ${path.join(REPO_ROOT, 'data')}`,
      '    または DB_PATH に旧い場所の絶対パスを設定する',
      '',
      '  そのまま起動すると空のDBとして初期データが作られ、会話が消えたように見えます。',
    ].join('\n'),
  );
  process.exit(1);
}
