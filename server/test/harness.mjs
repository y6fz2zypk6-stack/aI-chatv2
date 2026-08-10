// テスト用の共通ヘルパ
import { writeFileSync } from 'node:fs';

export const BASE = `http://localhost:${process.env.TEST_PORT || 3460}/api`;
const QUEUE = process.env.MOCK_QUEUE;

/** モックLLMが次に返す応答を積む */
export function setQueue(items) {
  writeFileSync(QUEUE, JSON.stringify(items));
}

const MOCK = `http://localhost:${process.env.MOCK_PORT || 4010}/v1`;

/** モックが受け取ったリクエストの一覧（プロンプトの中身・呼び出し回数の検証用） */
export async function mockRequests() {
  return (await fetch(`${MOCK}/__requests`)).json();
}

export async function clearMockRequests() {
  await fetch(`${MOCK}/__requests`, { method: 'DELETE' });
}

export async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* JSONでない応答 */
  }
  return { status: res.status, json, text };
}

/** SSEで生成し、delta / done / error をまとめて返す */
export async function generate(chatId, body) {
  const res = await fetch(`${BASE}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let j = null;
    try {
      j = JSON.parse(await res.text());
    } catch {
      /* noop */
    }
    return { httpStatus: res.status, error: j?.error };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = null;
  let error = null;
  let deltas = '';
  const notices = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const p = JSON.parse(data);
      if (ev === 'delta') deltas += p.text;
      else if (ev === 'done') done = p;
      else if (ev === 'error') error = p.message;
      else if (ev === 'notice') notices.push(p);
    }
  }
  return { httpStatus: 200, done, error, deltas, notices };
}

export async function getChat(chatId) {
  return (await api('GET', `/chats/${chatId}`)).json;
}

/** 通算分 → HH:MM */
export function hhmm(t) {
  const m = ((t % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** STATEフェンス付きの応答テキストを組み立てる */
export function reply({
  narr,
  char,
  name = 'アシュリー',
  elapsed,
  location,
  add,
  remove,
  fence = true,
  truncate = false,
}) {
  let t = '';
  if (narr) t += `ナレーター: ${narr}\n`;
  if (char) t += `${name}: ${char}\n`;
  if (!fence) return t.trim();
  let f = '\n@@@STATE\n';
  if (elapsed !== undefined) f += `elapsed_minutes: ${elapsed}\n`;
  if (location !== undefined) f += `location: ${location}\n`;
  if (add !== undefined) f += `present_add: ${add}\n`;
  if (remove !== undefined) f += `present_remove: ${remove}\n`;
  if (truncate) return (t + f).replace(/\n$/, ''); // @@@END を書かずに切る
  return t + f + '@@@END';
}

// ---- 結果の集計 ----

const results = [];
let current = '';

export function suite(name) {
  current = name;
  console.log(`\n── ${name}`);
}

export function check(name, ok, detail) {
  results.push({ suite: current, name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

export function note(text) {
  console.log(`    · ${text}`);
}

export function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(56)}`);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\n失敗:');
    for (const f of failed) console.log(`  [${f.suite}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  return failed.length;
}
