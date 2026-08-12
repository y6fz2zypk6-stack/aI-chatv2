// .env と相対 DB_PATH の基準がリポジトリルートであることを確かめる。
//   node test/env.mjs
// 前提: あらかじめ `npm run build -w server` でビルドしておく。
//
// ここが狂うと、以降のテストの前提（どの設定・どのDBを見ているか）が全て崩れる。
// 実行時の cwd は `server/`（ルートの npm script は -w server 付きで走る）なので、
// 「cwd 基準ではなくルート基準か」を実際にファイルが出来る場所で見る。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const root = path.resolve(serverDir, '..');
const entry = path.join(serverDir, 'dist/server/src/index.js');

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

/** 実際に使われる経路で起動する（cwd は server/、ルートの npm script と同じ） */
function run(env, ms = 4000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [entry], {
      cwd: serverDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (b) => (out += b));
    c.stderr.on('data', (b) => (out += b));
    const timer = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('exit', (code) => {
      clearTimeout(timer);
      // 起動ログはマイグレーション行で長くなるので、失敗時に読む1行だけ残す
      const lines = out.split('\n').filter((l) => l.trim());
      resolve({ code, out, brief: lines[lines.length - 1] ?? '' });
    });
  });
}

// 実データに触らないよう、使い捨ての相対ディレクトリで検証する
const tmpRel = `.tmp-envtest-${process.pid}`;
const rootTmp = path.join(root, tmpRel);
const serverTmp = path.join(serverDir, tmpRel);
const cleanup = () => {
  rmSync(rootTmp, { recursive: true, force: true });
  rmSync(serverTmp, { recursive: true, force: true });
};

console.log('\n── .env と DB_PATH の基準');
try {
  // 1. 相対 DB_PATH はルート基準で解決される（cwd=server/ でも server/ の下に作らない）
  {
    cleanup();
    const r = await run({
      DB_PATH: `./${tmpRel}/app.sqlite`,
      PORT: '0',
      BIND: '127.0.0.1',
      APP_PASSWORD: 'x',
      OPENROUTER_API_KEY: 'x',
    });
    check('相対 DB_PATH はルート基準', existsSync(path.join(rootTmp, 'app.sqlite')), r.brief);
    check('cwd（server/）の下には作らない', !existsSync(path.join(serverTmp, 'app.sqlite')));
  }

  // 2. 旧い場所にDBが残っていたら起動を止める（空DBを作って初期データを流し込まない）
  {
    cleanup();
    mkdirSync(serverTmp, { recursive: true });
    writeFileSync(path.join(serverTmp, 'app.sqlite'), '');
    const r = await run({
      DB_PATH: `./${tmpRel}/app.sqlite`,
      PORT: '0',
      BIND: '127.0.0.1',
      APP_PASSWORD: 'x',
      OPENROUTER_API_KEY: 'x',
    });
    check('旧い場所にDBがあると起動を中止する', r.code === 1, `code=${r.code}`);
    check('移動先を提示する', r.out.includes('DB_PATH に旧い場所の絶対パス'), r.brief);
    check('新しい側にDBを作らない', !existsSync(path.join(rootTmp, 'app.sqlite')));
  }

  // 3. ルートの .env が読まれ、server/.env は読まれない。
  //    実運用の .env を壊さないよう、既に置かれている場合はこの項目だけ飛ばす
  {
    cleanup();
    const rootEnv = path.join(root, '.env');
    const serverEnv = path.join(serverDir, '.env');
    if (existsSync(rootEnv) || existsSync(serverEnv)) {
      console.log('  - .env が既にあるので読み込み位置の検証は省略します');
    } else {
      // ルート側だけに DB_PATH を書く。読まれていなければDBは既定の場所に出来る
      writeFileSync(rootEnv, `DB_PATH=./${tmpRel}/from-root.sqlite\n`);
      writeFileSync(serverEnv, `DB_PATH=./${tmpRel}/from-server.sqlite\n`);
      try {
        const r = await run({
          PORT: '0',
          BIND: '127.0.0.1',
          APP_PASSWORD: 'x',
          OPENROUTER_API_KEY: 'x',
        });
        check('ルートの .env が読まれる', existsSync(path.join(rootTmp, 'from-root.sqlite')), r.brief);
        check('server/.env は読まれない', !existsSync(path.join(rootTmp, 'from-server.sqlite')));
        check('server/.env があることを知らせる', r.out.includes('は読まれません'));
      } finally {
        rmSync(rootEnv, { force: true });
        rmSync(serverEnv, { force: true });
      }
    }
  }
} finally {
  cleanup();
}

console.log(failed === 0 ? '\n.env の基準: OK' : `\n.env の基準: ${failed}件 失敗`);
process.exit(failed === 0 ? 0 : 1);
