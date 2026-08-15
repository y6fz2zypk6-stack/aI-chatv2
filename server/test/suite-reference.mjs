// 参照用の高画質画像（§21.4）
import zlib from 'node:zlib';
import { BASE, api, check, clearMockRequests, generate, mockRequests, reply, setQueue, suite } from './harness.mjs';
import { lastAssistant, newChat, setupSnapshotWorld } from './suite-snapshot.mjs';

/**
 * 検証用の本物のPNG。**先頭バイトを見る検査があるので、でたらめな文字列では通らない。**
 * 幅を変えると中身（＝バイト列）が変わるので、差し替えの検証に使える。
 */
function png(width) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let x = 0xffffffff;
    for (const b of buf) x = crcTable[(x ^ b) & 0xff] ^ (x >>> 8);
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
  const height = 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

/** バイナリはJSONではないので fetch を直に使う */
async function fetchBinary(path) {
  const res = await fetch(`${BASE}${path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

const imageCalls = async () => (await mockRequests()).filter((r) => r.image);

/** 1ターン生成して、その応答へスナップショットを作る。送られた参照を返す */
async function shootAndGetRefs(w, chat, opts = {}) {
  setQueue([{ text: reply({ narr: '窓の外を見た。', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 't' });
  const mid = await lastAssistant(chat.id);
  await clearMockRequests();
  setQueue([{}]);
  const r = await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x', ...opts });
  const sent = (await imageCalls())[0]?.body ?? {};
  return { status: r.status, refs: sent.input_references ?? [], mid };
}

// ===========================================================================
export async function referenceSuite() {
  suite('参照画像');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', {
    auto_summarize: 0, auto_extract: 0, image_model: 'openai/gpt-image-2',
  });

  const w = await setupSnapshotWorld('ref');
  const small = png(8);
  const other = png(16);

  // 保存と取り出し
  let meta;
  {
    const r = await api('PUT', `/characters/${w.ashley.id}/reference`, {
      data_url: dataUrl('image/png', small),
    });
    meta = r.json;
    check('参照画像を保存できる', r.status === 201, `${r.status} / ${r.json?.error}`);
    check('サイズが入る', meta.bytes === small.length, `${meta.bytes} vs ${small.length}`);
    check('持ち主が入る', meta.character_id === w.ashley.id && meta.persona_id === null,
      JSON.stringify([meta.character_id, meta.persona_id]));
    check('メタに画像本体を含まない', meta.image === undefined, JSON.stringify(Object.keys(meta)));

    const got = await api('GET', `/characters/${w.ashley.id}/reference`);
    check('メタを引ける', got.status === 200 && got.json.id === meta.id, String(got.status));

    const none = await api('GET', `/characters/${w.toby.id}/reference`);
    check('未設定なら404', none.status === 404, String(none.status));
    const nobody = await api('GET', '/characters/nope/reference');
    check('居ないキャラは404', nobody.status === 404, String(nobody.status));
  }

  // **ここが崩れると会話画面の読み込みが重くなる**
  {
    const b64 = small.toString('base64').slice(0, 40);
    const one = await api('GET', `/characters/${w.ashley.id}`);
    check('キャラのJSONに参照画像は載らない', !one.text.includes(b64),
      `${Math.round(one.text.length / 1024)}KB`);
    const list = await api('GET', `/worlds/${w.world.id}/characters`);
    check('キャラ一覧にも載らない', !list.text.includes(b64),
      `${Math.round(list.text.length / 1024)}KB`);
    check('アバターは従来どおり載る', list.text.includes('data:image/webp'));
  }

  // バイナリ配信
  {
    const img = await fetchBinary(`/references/${meta.id}/image`);
    check('画像はバイナリで返る', img.status === 200 && img.buf.length === small.length,
      `${img.status} / ${img.buf.length}バイト`);
    check('保存したものと同じ中身', img.buf.equals(small));
    check('Content-Type が画像', img.headers.get('content-type') === 'image/png',
      img.headers.get('content-type'));
    check('Cache-Control は private',
      (img.headers.get('cache-control') ?? '').includes('private'),
      img.headers.get('cache-control'));
  }

  // 差し替え: IDが変わり、古いIDは消える
  {
    const r2 = await api('PUT', `/characters/${w.ashley.id}/reference`, {
      data_url: dataUrl('image/png', other),
    });
    check('差し替えるとIDが変わる', r2.json.id !== meta.id, `${meta.id} → ${r2.json.id}`);
    check('古いIDは取れない', (await fetchBinary(`/references/${meta.id}/image`)).status === 404);
    check('新しい中身が返る',
      (await fetchBinary(`/references/${r2.json.id}/image`)).buf.equals(other));
    check('1人1枚に保たれる', r2.json.bytes === other.length, String(r2.json.bytes));
    meta = r2.json;
  }

  // 検証: 素通しにしない
  {
    const cases = [
      ['指定なし', {}, 400],
      ['画像でないdata URL', { data_url: 'data:text/plain;base64,aGVsbG8=' }, 400],
      ['ただの文字列', { data_url: 'https://example.com/a.png' }, 400],
      ['中身が空', { data_url: 'data:image/png;base64,' }, 400],
      ['画像として読めない中身', { data_url: 'data:image/png;base64,' + Buffer.from('not an image at all').toString('base64') }, 400],
    ];
    for (const [label, body, want] of cases) {
      const r = await api('PUT', `/characters/${w.toby.id}/reference`, body);
      check(`${label} は ${want}`, r.status === want, `${r.status} / ${r.json?.error}`);
    }

    // 中身は正しいPNGだが、JPEGだと名乗っている。宣言だけを信じないことの確認
    const lying = await api('PUT', `/characters/${w.toby.id}/reference`, {
      data_url: dataUrl('image/jpeg', small),
    });
    check('宣言と中身が食い違えば400', lying.status === 400, `${lying.status} / ${lying.json?.error}`);
    check('何が違うのかを教える', (lying.json?.error ?? '').includes('一致しません'), lying.json?.error);

    // 6MB超。base64は約1.37倍になるので、ボディ上限（10mb）より手前で自分の検査に当たる
    const big = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(6.5 * 1024 * 1024)]);
    const r = await api('PUT', `/characters/${w.toby.id}/reference`, {
      data_url: dataUrl('image/png', big),
    });
    check('6MB超は413', r.status === 413, `${r.status} / ${r.json?.error}`);
    check('理由が分かる', (r.json?.error ?? '').includes('大きすぎます'), r.json?.error);
    check('弾いたものは保存されない',
      (await api('GET', `/characters/${w.toby.id}/reference`)).status === 404);
  }

  // 生成: 参照画像があればアバターではなくそちらを送る
  {
    const chat = await newChat(w, { present: [w.ashley.id] });
    const { status, refs } = await shootAndGetRefs(w, chat);
    check('生成できる', status === 201, String(status));
    check('参照は1件', refs.length === 1, String(refs.length));
    check('アバターではなく参照画像を送る',
      String(refs[0]?.image_url?.url ?? '').startsWith('data:image/png;base64,'),
      String(refs[0]?.image_url?.url ?? '').slice(0, 40));
    check('送った中身が保存したものと一致する',
      Buffer.from(String(refs[0].image_url.url).split(',')[1], 'base64').equals(other));

    const p = (await api('POST', `/messages/${await lastAssistant(chat.id)}/snapshot/preview`)).json;
    check('プレビューが出どころを返す',
      p.references[0]?.from === 'reference' && p.references[0]?.label === 'アシュリー',
      JSON.stringify(p.references));
  }

  // 参照画像が無いキャラは従来どおりアバター
  {
    const chat = await newChat(w, { present: [w.toby.id] });
    const { refs } = await shootAndGetRefs(w, chat);
    check('参照画像が無ければアバターを送る',
      String(refs[0]?.image_url?.url ?? '').startsWith('data:image/webp;base64,'),
      String(refs[0]?.image_url?.url ?? '').slice(0, 40));

    const p = (await api('POST', `/messages/${await lastAssistant(chat.id)}/snapshot/preview`)).json;
    check('プレビューが avatar と返す', p.references[0]?.from === 'avatar',
      JSON.stringify(p.references));
  }

  // ペルソナの参照画像は include_persona のときだけ
  {
    await api('PUT', `/personas/${w.persona.id}/reference`, {
      data_url: dataUrl('image/png', small),
    });
    const chat = await newChat(w, { present: [w.toby.id] });
    const withP = await shootAndGetRefs(w, chat, { include_persona: true });
    check('ペルソナの参照画像も送られる',
      withP.refs.length === 2 &&
        String(withP.refs[1]?.image_url?.url ?? '').startsWith('data:image/png;base64,'),
      `${withP.refs.length}件 / ${String(withP.refs[1]?.image_url?.url ?? '').slice(0, 30)}`);

    const chat2 = await newChat(w, { present: [w.toby.id] });
    const without = await shootAndGetRefs(w, chat2);
    check('既定ではペルソナを送らない', without.refs.length === 1, String(without.refs.length));
  }

  // 外すと元に戻る
  {
    const del = await api('DELETE', `/characters/${w.ashley.id}/reference`);
    check('外せる', del.status === 200, String(del.status));
    check('外したら画像も消える', (await fetchBinary(`/references/${meta.id}/image`)).status === 404);
    check('二度目は404', (await api('DELETE', `/characters/${w.ashley.id}/reference`)).status === 404);

    const chat = await newChat(w, { present: [w.ashley.id] });
    const { refs } = await shootAndGetRefs(w, chat);
    check('外したあとはアバターに戻る',
      String(refs[0]?.image_url?.url ?? '').startsWith('data:image/webp;base64,'),
      String(refs[0]?.image_url?.url ?? '').slice(0, 40));
  }

  // 連鎖削除。外部キーは foreign_keys が切れた瞬間に黙って壊れる
  {
    const c = (await api('POST', `/worlds/${w.world.id}/characters`, { name: '使い捨て' })).json;
    const r = (await api('PUT', `/characters/${c.id}/reference`, {
      data_url: dataUrl('image/png', small),
    })).json;
    check('作れた', (await fetchBinary(`/references/${r.id}/image`)).status === 200);

    const usage = (await api('GET', `/worlds/${w.world.id}`)).json.usage;
    check('世界の削除確認に枚数が入る', usage.references === 1, String(usage.references));

    await api('DELETE', `/characters/${c.id}`);
    check('キャラを消すと参照画像も消える',
      (await fetchBinary(`/references/${r.id}/image`)).status === 404);
  }

  {
    const c = (await api('POST', `/worlds/${w.world.id}/characters`, { name: '世界ごと' })).json;
    const r = (await api('PUT', `/characters/${c.id}/reference`, {
      data_url: dataUrl('image/png', other),
    })).json;
    await api('DELETE', `/worlds/${w.world.id}`);
    check('世界を消すと参照画像も消える',
      (await fetchBinary(`/references/${r.id}/image`)).status === 404);
  }

  // ペルソナは世界に属さないので、世界を消しても残る
  {
    const p = await api('GET', `/personas/${w.persona.id}/reference`);
    check('ペルソナの参照画像は世界の削除で消えない', p.status === 200, String(p.status));
    await api('DELETE', `/personas/${w.persona.id}/reference`);
  }

  await api('PUT', '/settings', base);
}
