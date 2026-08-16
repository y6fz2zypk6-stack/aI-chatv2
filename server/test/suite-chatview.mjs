// 会話画面まわり: 履歴のページング（§5.9）・会話の名前（§3.5）・サムネイル（§21.9）
import zlib from 'node:zlib';
import { BASE, api, check, generate, reply, setQueue, suite } from './harness.mjs';
import { newChat, setupWorld } from './suites.mjs';

/** 中身が検査を通る本物のPNG（先頭バイトを見る検査があるので、でたらめでは通らない） */
function png(width = 8) {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let x = 0xffffffff;
    for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 3 + 1) * 4))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

async function fetchBinary(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

// ===========================================================================
// 履歴のページング（§5.9）
// ===========================================================================
export async function paginationSuite(w) {
  suite('履歴のページング');

  const { chat } = await newChat(w);
  // 冒頭1件 + 25往復 = 51件
  for (let i = 1; i <= 25; i++) {
    setQueue([{ text: reply({ char: `「${i}」`, elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: `t${i}` });
  }

  const d = (await api('GET', `/chats/${chat.id}`)).json;
  check('全体の件数を返す', d.total === 51, String(d.total));
  check('既定では末尾40件だけ返す', d.messages.length === 40, String(d.messages.length));
  check('まだ前があると伝える', d.hasMore === true, String(d.hasMore));
  check('返るのは末尾（最後のメッセージが入っている）',
    d.messages[d.messages.length - 1].seq === 51, String(d.messages[d.messages.length - 1].seq));
  check('昇順で返る',
    d.messages.every((m, i) => i === 0 || m.seq > d.messages[i - 1].seq));
  // 画像のメタは全件渡す（遡ったときにそのまま使えるように）
  check('スナップショットのメタは同梱される', Array.isArray(d.snapshots));

  const first = d.messages[0].seq;
  const older = (await api('GET', `/chats/${chat.id}/messages?before_seq=${first}`)).json;
  check('それより前を取れる', older.messages.length === 11, String(older.messages.length));
  check('遡った分も昇順', older.messages[0].seq === 1, String(older.messages[0].seq));
  check('先頭まで読んだら hasMore は偽', older.hasMore === false, String(older.hasMore));
  check('重複しない', older.messages[older.messages.length - 1].seq === first - 1,
    `${older.messages[older.messages.length - 1].seq} vs ${first - 1}`);

  const limited = (await api('GET', `/chats/${chat.id}?limit=5`)).json;
  check('limit が効く', limited.messages.length === 5, String(limited.messages.length));
  check('limit を絞っても total は全体', limited.total === 51, String(limited.total));

  const page2 = (
    await api('GET', `/chats/${chat.id}/messages?before_seq=${limited.messages[0].seq}&limit=5`)
  ).json;
  check('前もページで取れる', page2.messages.length === 5, String(page2.messages.length));
  check('途中なら hasMore は真', page2.hasMore === true, String(page2.hasMore));

  const bad = await api('GET', `/chats/${chat.id}/messages`);
  check('before_seq が無ければ400', bad.status === 400, String(bad.status));

  // 短い会話では遡る導線を出さない
  const { chat: small } = await newChat(w);
  const sd = (await api('GET', `/chats/${small.id}`)).json;
  check('40件未満なら hasMore は偽', sd.hasMore === false, `${sd.messages.length}件`);
}

// ===========================================================================
// 会話の名前（§3.5）
// ===========================================================================
export async function chatTitleSuite(w) {
  suite('会話の名前');

  const { chat } = await newChat(w);
  setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'つづけて' });

  const after = (await api('GET', `/chats/${chat.id}`)).json.chat;
  // 「つづけて」のような文字列が会話の名前として残り続けるのをやめた
  check('最初の発言でタイトルが自動で付かない', after.title === '', JSON.stringify(after.title));

  const named = (await api('PUT', `/chats/${chat.id}`, { title: '灯台の夜' })).json;
  check('名前を付けられる', named.title === '灯台の夜', named.title);
  const cleared = (await api('PUT', `/chats/${chat.id}`, { title: '' })).json;
  check('空に戻せる', cleared.title === '', JSON.stringify(cleared.title));

  // 分岐: 元が無名なら分岐先も無名
  const d = (await api('GET', `/chats/${chat.id}`)).json;
  const target = [...d.messages].reverse().find((m) => m.role === 'assistant');
  const f1 = (await api('POST', `/chats/${chat.id}/fork`, { message_id: target.id })).json;
  check('無名の分岐先は無名のまま', f1.title === '', JSON.stringify(f1.title));

  await api('PUT', `/chats/${chat.id}`, { title: '灯台の夜' });
  const f2 = (await api('POST', `/chats/${chat.id}/fork`, { message_id: target.id })).json;
  check('名前付きなら「（分岐）」が付く', f2.title === '灯台の夜（分岐）', f2.title);
}

// ===========================================================================
// サムネイル（§21.9）
// ===========================================================================
export async function thumbSuite(sw) {
  suite('サムネイル');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', {
    auto_summarize: 0, auto_extract: 0, image_model: 'openai/gpt-image-2',
  });

  const scenario = (
    await api('POST', `/worlds/${sw.world.id}/scenarios`, {
      title: 'thumb',
      participant_ids: [sw.ashley.id],
      opening: 'ナレーター: 開始。',
      initial_state: {
        time: 877 * 1440 + 18 * 60, location: sw.shop, location_note: '',
        weather: '晴', present: [sw.ashley.id], vars: {},
      },
    })
  ).json;
  const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
  setQueue([{ text: reply({ narr: '灯りが揺れる。', elapsed: 10, location: sw.shop }) }]);
  await generate(chat.id, { content: 't' });
  const d = (await api('GET', `/chats/${chat.id}`)).json;
  const mid = [...d.messages].reverse().find((m) => m.role === 'assistant').id;

  setQueue([{}]);
  const snap = (await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' })).json;
  check('作った直後は未作成', snap.thumb_bytes === 0, String(snap.thumb_bytes));
  check('未作成なら404', (await fetchBinary(`/snapshots/${snap.id}/thumb`)).status === 404);

  const thumb = png(16);
  const put = await api('PUT', `/snapshots/${snap.id}/thumb`, {
    data_url: dataUrl('image/png', thumb),
  });
  check('サムネイルを保存できる', put.status === 200, `${put.status} / ${put.json?.error}`);
  check('メタに大きさが入る', put.json.thumb_bytes === thumb.length,
    `${put.json.thumb_bytes} vs ${thumb.length}`);
  check('メタに画像本体を含まない', put.json.thumb === undefined,
    JSON.stringify(Object.keys(put.json)));

  const got = await fetchBinary(`/snapshots/${snap.id}/thumb`);
  check('バイナリで返る', got.status === 200 && got.buf.equals(thumb),
    `${got.status} / ${got.buf.length}バイト`);
  check('Cache-Control は private',
    (got.headers.get('cache-control') ?? '').includes('private'),
    got.headers.get('cache-control'));

  // 原寸は別物のまま
  const full = await fetchBinary(`/snapshots/${snap.id}/image`);
  check('原寸はそのまま残る', full.status === 200 && !full.buf.equals(thumb),
    `${full.buf.length}バイト`);

  // 会話の応答にも大きさが載る（表示側が縮小版を選べるように）
  const detail = (await api('GET', `/chats/${chat.id}`)).json;
  check('会話の応答に thumb_bytes が載る',
    detail.snapshots[0].thumb_bytes === thumb.length, JSON.stringify(detail.snapshots[0]));
  check('会話の応答に画像は載らない', !JSON.stringify(detail.snapshots).includes('iVBORw0KGgo'));

  // 参照画像と同じ検査を通す
  const bad = await api('PUT', `/snapshots/${snap.id}/thumb`, { data_url: 'not a data url' });
  check('画像でなければ400', bad.status === 400, `${bad.status} / ${bad.json?.error}`);
  const missing = await api('PUT', '/snapshots/nope/thumb', {
    data_url: dataUrl('image/png', thumb),
  });
  check('知らないIDは404', missing.status === 404, String(missing.status));

  // 未作成の洗い出し（アルバムの作り直し用）
  setQueue([{}]);
  const snap2 = (await api('POST', `/messages/${mid}/snapshot`, { prompt: 'y' })).json;
  const list = (await api('GET', `/worlds/${sw.world.id}/snapshots/missing-thumbs`)).json;
  check('未作成のIDを引ける', list.ids.includes(snap2.id) && !list.ids.includes(snap.id),
    JSON.stringify(list.ids));

  await api('DELETE', `/snapshots/${snap.id}`);
  await api('DELETE', `/snapshots/${snap2.id}`);
  await api('PUT', '/settings', base);
}
