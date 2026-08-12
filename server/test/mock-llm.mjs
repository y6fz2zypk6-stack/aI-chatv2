// OpenRouter互換のモック。応答内容はキューファイルから1件ずつ取り出す。
// テスト側は setQueue() で「次に返す応答」を積んでから生成を呼ぶ。
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const QUEUE = process.env.MOCK_QUEUE;
const PORT = Number(process.env.MOCK_PORT || 4010);

function popQueue() {
  if (!QUEUE || !existsSync(QUEUE)) return null;
  const q = JSON.parse(readFileSync(QUEUE, 'utf-8'));
  const item = q.shift() ?? null;
  writeFileSync(QUEUE, JSON.stringify(q));
  return item;
}

/** 直近のリクエスト本文。プロンプトの中身と呼び出し回数を検証するために保持する */
const seen = [];

let modelsDelayMs = 0;

const server = http.createServer(async (req, res) => {
  // テスト用: 受け取ったリクエストを覗く / 消す
  if (req.url.endsWith('/__requests')) {
    if (req.method === 'DELETE') seen.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(seen));
    return;
  }

  // モデル一覧の応答を遅らせる（受付直後のraceを観測するため）
  if (req.url.endsWith('/__models_delay')) {
    let body = '';
    for await (const c of req) body += c;
    modelsDelayMs = Number(JSON.parse(body || '{}').ms) || 0;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    return;
  }

  if (req.url.endsWith('/models')) {
    if (modelsDelayMs) await new Promise((r) => setTimeout(r, modelsDelayMs));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', context_length: 200000 },
          { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 200000 },
        ],
      }),
    );
    return;
  }

  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('{}');
    return;
  }

  let body = '';
  for await (const c of req) body += c;
  const reqJson = JSON.parse(body);
  seen.push({
    stream: !!reqJson.stream,
    at: Date.now(),
    prompt: (reqJson.messages ?? []).map((m) => m.content).join('\n---\n'),
    maxTokens: reqJson.max_tokens ?? null,
  });
  const item = popQueue() ?? {
    text: 'ナレーター: （既定応答）\n\n@@@STATE\nelapsed_minutes: 10\n@@@END',
  };

  // status を指定すると上流エラーを再現できる（停止との区別を見るため）
  if (item.status && item.status >= 400) {
    res.writeHead(item.status, { 'Content-Type': 'text/plain' });
    res.end(item.text ?? 'error');
    return;
  }

  // 非ストリーミング（要約・抽出・継続判定）
  if (!reqJson.stream) {
    // gapMs を指定すると応答を遅らせられる。実行中ガードの検証に使う
    if (item.gapMs) await new Promise((r) => setTimeout(r, item.gapMs));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: item.text, ...(item.refusal ? { refusal: item.refusal } : {}) },
            finish_reason: item.finish ?? 'stop',
          },
        ],
      }),
    );
    return;
  }

  /** 指定時間だけ黙る。切断されたら true（呼び出し側は打ち切る） */
  const stall = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      req.on('close', () => {
        clearTimeout(t);
        resolve(true);
      });
    });

  // headDelayMs: レスポンスヘッダを返すまで黙る。
  // 「接続は受けたがヘッダがまだ」の窓（停止・接続確立タイムアウト）を作るために使う
  if (item.headDelayMs && (await stall(item.headDelayMs))) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // 実際のSSEサーバと同じく、本文を待たせるときもヘッダは先に送り出す。
  // これをしないと「ヘッダは来たが本文が来ない」状態が作れず、
  // 接続確立タイムアウトと idle タイムアウトの区別を検証できない
  res.flushHeaders?.();

  // 1文字ずつ流す。gapMs を指定すると遅くなるので停止テストに使える
  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  // stallMs: stallAfter 文字まで流したところで黙り込む（idleタイムアウトの検証用）。
  // stallAfter を省くと1文字も流さないまま黙る（ヘッダだけ返して本文が来ないケース）
  let sent = 0;
  for (const ch of [...item.text]) {
    if (closed) break;
    if (item.stallMs && sent === (item.stallAfter ?? 0)) {
      if (await stall(item.stallMs)) return;
      closed = true;
      break;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
    sent++;
    if (item.gapMs) await new Promise((r) => setTimeout(r, item.gapMs));
  }
  if (!closed) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

server.listen(PORT, () => console.log(`[mock-llm] :${PORT}`));
