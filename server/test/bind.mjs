// BIND が待ち受けインターフェースを本当に絞れているかを確かめる。
//   node test/bind.mjs
// 前提: あらかじめ `npm run build -w server` でビルドしておく。
//
// Tailscale などVPN内だけに公開する構成では、ここが効いていないと
// 公開IPからそのまま到達できてしまうため、実際に別インターフェース経由で叩いて確認する。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(path.join(tmpdir(), 'charchat-bind-'));

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
}

/** ループバック以外のIPv4。無ければこのホストでは外部到達の検証ができない */
function externalIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** サーバを起動し、起動ログか終了を待つ */
function start(env, port) {
  const child = spawn(process.execPath, [path.join(here, '../dist/server/src/index.js')], {
    env: {
      ...process.env,
      DB_PATH: path.join(workDir, `${port}.sqlite`),
      PORT: String(port),
      OPENROUTER_API_KEY: 'test',
      APP_PASSWORD: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  return {
    child,
    log: () => out,
    exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
  };
}

/** 指定アドレスへTCP接続できるか（HTTPまで行かず接続可否だけ見る） */
function canConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host);
  });
}

async function waitUp(host, port, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await canConnect(host, port)) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

const ext = externalIp();
console.log(`外部インターフェース: ${ext ?? '（無し）'}`);

let exitCode = 1;
const running = [];
try {
  console.log('\n── BIND');

  // ① BIND=127.0.0.1 → ループバックのみ
  {
    const port = await freePort();
    const s = start({ BIND: '127.0.0.1' }, port);
    running.push(s.child);
    check('BIND=127.0.0.1 でループバックから到達できる', await waitUp('127.0.0.1', port));
    check('起動ログに待ち受け先が出る', s.log().includes(`127.0.0.1:${port}`), s.log().split('\n')[0]);
    if (ext) {
      check(
        `BIND=127.0.0.1 では外部IF（${ext}）から到達できない`,
        !(await canConnect(ext, port)),
        `${ext}:${port}`,
      );
    } else {
      console.log('    · 外部インターフェースが無いため到達不能の確認は省略');
    }
    check(
      'パスワード未設定でも「公開されている」警告は出さない',
      !s.log().includes('外部に公開されています'),
    );
  }

  // ② BIND 未設定 → 全インターフェース（既定の挙動を変えていないこと）
  {
    const port = await freePort();
    // 無認証のまま公開するのは既定で止まるので、承知していることを明示する（§16）
    const s = start({ ALLOW_UNAUTHENTICATED: '1' }, port);
    running.push(s.child);
    check('BIND 未設定でループバックから到達できる', await waitUp('127.0.0.1', port));
    if (ext) {
      check(`BIND 未設定なら外部IF（${ext}）からも到達できる`, await canConnect(ext, port));
    }
    check(
      'BIND 未設定のときは全インターフェース待ち受けを注意する',
      s.log().includes('全インターフェースで待ち受けています'),
    );
    check(
      'パスワード未設定かつ公開なら強い警告を出す',
      s.log().includes('外部に公開されています'),
    );
  }

  // ②' 認証なしで全インターフェースに公開する構成は、待ち受ける前に止める（§16）
  {
    const port = await freePort();
    const s = start({}, port);
    running.push(s.child);
    const code = await s.exited;
    check('無認証＋全インターフェースなら起動しない', code === 1, `exit=${code}`);
    check('逃げ道を3つとも案内する',
      ['APP_PASSWORD=', 'BIND=127.0.0.1', 'ALLOW_UNAUTHENTICATED=1'].every((k) => s.log().includes(k)),
      s.log().trim());
    check('待ち受けは始まっていない', !s.log().includes('で待ち受けています'), s.log().trim());
  }

  // ②'' 到達範囲を絞っていれば、パスワード無しでも起動する（Tailscale・ローカル運用）
  {
    const port = await freePort();
    const s = start({ BIND: '127.0.0.1' }, port);
    running.push(s.child);
    check('BINDで絞ってあればパスワード無しでも起動する', await waitUp('127.0.0.1', port));
  }

  // ②''' パスワードがあれば全インターフェースでも起動する
  {
    const port = await freePort();
    const s = start({ APP_PASSWORD: 'secret' }, port);
    running.push(s.child);
    check('パスワードがあれば全インターフェースでも起動する', await waitUp('127.0.0.1', port));
  }

  // ③ 存在しないアドレス → 分かる形で落ちる
  //    （ループバック以外なのでパスワードを付けないと起動ガードで先に止まる）
  {
    const port = await freePort();
    const s = start({ BIND: '10.255.255.254', APP_PASSWORD: 'secret' }, port);
    running.push(s.child);
    const code = await s.exited;
    check('存在しないアドレスなら起動に失敗する', code === 1, `exit=${code}`);
    check(
      '原因が分かるメッセージを出す',
      s.log().includes('このホストに存在しません'),
      s.log().trim().split('\n').slice(-1)[0],
    );
    check('失敗したのに「待ち受けています」と言わない',
      !s.log().includes('で待ち受けています'), s.log().trim());
  }

  // ③' ポートが埋まっている → 成功したように見せない
  //
  // Express 5 の app.listen は、渡したコールバックを error にも登録する。
  // うっかりコールバックで成功を通知すると、起動できていないのに
  // 「待ち受けています」＋起動時の警告一式が出てしまう
  {
    const port = await freePort();
    const first = start({ BIND: '127.0.0.1', APP_PASSWORD: 'secret' }, port);
    running.push(first.child);
    check('1本目は起動する', await waitUp('127.0.0.1', port));

    // 同じポートへもう1本
    const dup = start({ BIND: '127.0.0.1', APP_PASSWORD: 'secret' }, port);
    running.push(dup.child);
    const code = await dup.exited;
    check('ポートが埋まっていたら起動に失敗する', code === 1, `exit=${code}`);
    check('ポートが原因だと分かる', dup.log().includes('既に使われています'),
      dup.log().trim().split('\n').slice(-1)[0]);
    check('起動できていないのに「待ち受けています」と言わない',
      !dup.log().includes('で待ち受けています'), dup.log().trim());
    // onListen が走っていないことを、そこでしか出ない警告で確かめる
    check('起動時の警告一式も出さない',
      !dup.log().includes('認証Cookieに secure'), dup.log().trim());
  }

  // ④ BIND に外部から届くアドレスを書いても、素通りさせない（§16.2）
  {
    const target = ext ?? '192.168.1.10';
    const port = await freePort();
    const s = start({ BIND: target }, port);
    running.push(s.child);
    const code = await s.exited;
    check(`BIND=${target}（外部から届く）＋パスワード無しなら起動しない`, code === 1, `exit=${code}`);
    check('待ち受けは始まっていない', !s.log().includes('で待ち受けています'), s.log().trim());
    check('BINDの値を message に含める', s.log().includes(`BIND=${target}`),
      s.log().trim().split('\n')[0]);
  }

  // ⑤ 到達範囲の判定そのもの（実際に待ち受けなくても確かめられる部分）
  {
    const { isReachRestricted, bindsAllInterfaces } = await import('../dist/server/src/bind.js');
    const restricted = ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', '100.64.0.1',
      '100.101.102.103', '::ffff:127.0.0.1'];
    const open = ['', '0.0.0.0', '::', '203.0.113.10', '192.168.1.10', '10.0.0.5',
      '172.16.0.1', '100.63.255.255', '100.128.0.1', 'example.com'];
    check('ループバックとTailscale帯だけを「絞れている」とする',
      restricted.every((b) => isReachRestricted(b)),
      restricted.filter((b) => !isReachRestricted(b)).join(',') || 'なし');
    check('公開IP・LAN・解釈できない値は「絞れていない」',
      open.every((b) => !isReachRestricted(b)),
      open.filter((b) => isReachRestricted(b)).join(',') || 'なし');
    check('全インターフェース判定は未設定と 0.0.0.0 / ::',
      ['', '0.0.0.0', '::', '[::]'].every(bindsAllInterfaces) &&
        !bindsAllInterfaces('127.0.0.1') && !bindsAllInterfaces('203.0.113.10'));
  }

  console.log(`\n${failed === 0 ? 'すべて通りました' : `${failed}件失敗`}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\nBINDの検証に失敗しました:', err);
  exitCode = 1;
} finally {
  for (const c of running) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* noop */
    }
  }
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(exitCode);
