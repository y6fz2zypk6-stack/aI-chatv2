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

const server = http.createServer(async (req, res) => {
  // テスト用: 受け取ったリクエストを覗く / 消す
  if (req.url.endsWith('/__requests')) {
    if (req.method === 'DELETE') seen.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(seen));
    return;
  }

  if (req.url.endsWith('/models')) {
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
  });
  const item = popQueue() ?? {
    text: 'ナレーター: （既定応答）\n\n@@@STATE\nelapsed_minutes: 10\n@@@END',
  };

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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // 1文字ずつ流す。gapMs を指定すると遅くなるので停止テストに使える
  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  for (const ch of [...item.text]) {
    if (closed) break;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
    if (item.gapMs) await new Promise((r) => setTimeout(r, item.gapMs));
  }
  if (!closed) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

server.listen(PORT, () => console.log(`[mock-llm] :${PORT}`));
