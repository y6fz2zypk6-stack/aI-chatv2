// テストランナー。モックLLMとサーバを立ててスイートを実行する。
//   npm test -w server
// 前提: あらかじめ `npm run build -w server` でビルドしておく。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(path.join(tmpdir(), 'charchat-test-'));
const dbPath = path.join(workDir, 'test.sqlite');
const queuePath = path.join(workDir, 'queue.json');

/** 空きポートを確保する（他のプロセスと衝突して誤った結果になるのを防ぐ） */
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

const PORT = Number(process.env.TEST_PORT) || (await freePort());
const MOCK_PORT = Number(process.env.MOCK_PORT) || (await freePort());

writeFileSync(queuePath, '[]');
process.env.MOCK_QUEUE = queuePath;
process.env.TEST_PORT = String(PORT);
process.env.MOCK_PORT = String(MOCK_PORT);

const children = [];
function launch(cmd, args, env, label) {
  const c = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', (b) => {
    if (process.env.TEST_VERBOSE) process.stdout.write(`[${label}] ${b}`);
  });
  c.stderr.on('data', (b) => process.stderr.write(`[${label}] ${b}`));
  children.push(c);
  return c;
}

async function waitFor(url, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* まだ起動していない */
    }
    if (Date.now() > until) throw new Error(`起動を待てませんでした: ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function startServer() {
  return launch(
    process.execPath,
    [path.join(here, '../dist/server/src/index.js')],
    {
      DB_PATH: dbPath,
      PORT: String(PORT),
      OPENROUTER_API_KEY: 'test',
      OPENROUTER_BASE_URL: `http://localhost:${MOCK_PORT}/v1`,
      DEFAULT_MODEL: 'anthropic/claude-opus-5',
      UTILITY_MODEL: 'anthropic/claude-sonnet-5',
      APP_PASSWORD: '',
    },
    'server',
  );
}

function stopAll() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* noop */
    }
  }
  children.length = 0;
}

let exitCode = 1;
try {
  console.log(`サーバ :${PORT} / モックLLM :${MOCK_PORT} / DB ${dbPath}`);
  const mock = launch(process.execPath, [path.join(here, 'mock-llm.mjs')], { MOCK_PORT: String(MOCK_PORT) }, 'mock');
  mock.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`モックLLMが終了しました (code=${code})。ポート ${MOCK_PORT} を確認してください`);
      process.exit(1);
    }
  });
  await waitFor(`http://localhost:${MOCK_PORT}/v1/models`);
  let server = startServer();
  await waitFor(`http://localhost:${PORT}/api/config`);

  const { report } = await import('./harness.mjs');
  const s = await import('./suites.mjs');
  const s2 = await import('./suite-events.mjs');
  const s3 = await import('./suite-memory.mjs');

  const w = await s.setupWorld('t');
  const snapshot = await s.normalFlow(w);
  await s.regressionInitialState(w);
  await s.abnormal(w);
  await s.edges(w);
  await s.chatListPreview(w);
  await s.areasSuite();
  await s.lastTrainSuite(w);

  // v1.5.3: 進行フラグと条件付きイベント
  const ew = await s2.setupEventWorld('ev');
  await s2.varsSuite(ew);
  await s2.eventsSuite(ew);
  await s2.advanceSuite(ew);

  // メモリー抽出と3段フラグの解決
  const mw = await s3.setupMemoryWorld('mem');
  await s3.memorySuite(mw);
  await s3.memoryDateSuite(mw);
  await s3.flagResolutionSuite(mw);
  await s3.summarySuite(mw);
  await s3.summaryCadenceSuite(mw);
  await s3.noticeSuite(mw);
  await s3.commitSuite(mw);
  await s3.memoryToggleSuite(mw);
  await s3.utilityTokensSuite(mw);
  await s3.situationSuite(mw);
  await s3.memoryBudgetSuite(mw);

  // 再起動して同じ状態が復元されるかを見る
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  server = startServer();
  await waitFor(`http://localhost:${PORT}/api/config`);
  await s.restored(snapshot);

  exitCode = report() > 0 ? 1 : 0;
} catch (err) {
  console.error('\nテストの実行に失敗しました:', err);
  exitCode = 1;
} finally {
  stopAll();
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(exitCode);
