// 場面のスナップショット（§21）
import {
  BASE,
  api,
  check,
  clearMockRequests,
  generate,
  getChat,
  mockRequests,
  reply,
  setQueue,
  suite,
} from './harness.mjs';

const T1800 = 877 * 1440 + 18 * 60;

/** 画像だけ小さなdata URLで持たせる（実物のアバターと同じ形） */
const AVATAR = (tag) => `data:image/webp;base64,${Buffer.from(tag).toString('base64')}`;

export async function setupSnapshotWorld(label) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const p = `${label}_`;
  await api('POST', `/worlds/${world.id}/locations`, {
    id: `${p}shop`, name: '本屋', indoor: 1, area: 'center',
  });
  await api('POST', `/worlds/${world.id}/locations`, {
    id: `${p}harbor`, name: '港', indoor: 0, area: 'harbor',
  });
  const ashley = (await api('POST', `/worlds/${world.id}/characters`, {
    name: 'アシュリー', appearance: 'silver hair, green coat', avatar: AVATAR('ashley'),
  })).json;
  const toby = (await api('POST', `/worlds/${world.id}/characters`, {
    name: 'トビー', appearance: 'short brown hair, freckles', avatar: AVATAR('toby'),
  })).json;
  const persona = (await api('POST', '/personas', {
    name: 'ミナ', description: 'わたし', appearance: 'black bob, red scarf', avatar: AVATAR('mina'),
  })).json;
  return { world, ashley, toby, persona, shop: `${p}shop`, harbor: `${p}harbor` };
}

export async function newChat(w, opts = {}) {
  const scenario = (
    await api('POST', `/worlds/${w.world.id}/scenarios`, {
      title: 'snap',
      participant_ids: [w.ashley.id, w.toby.id],
      opening: 'ナレーター: 開始。',
      initial_state: {
        time: opts.time ?? T1800,
        location: opts.location ?? w.shop,
        location_note: '',
        weather: opts.weather ?? '晴',
        present: opts.present ?? [w.ashley.id],
        vars: {},
      },
    })
  ).json;
  return (await api('POST', `/scenarios/${scenario.id}/chats`, { persona_id: w.persona.id })).json;
}

/** 直近の assistant メッセージのIDを返す */
export async function lastAssistant(chatId) {
  const d = await getChat(chatId);
  return [...d.messages].reverse().find((m) => m.role === 'assistant')?.id;
}

/** 画像だけは JSON ではなくバイナリで返るので fetch を直に使う */
async function fetchImage(id) {
  const res = await fetch(`${BASE}/snapshots/${id}/image`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

const imageCalls = async () => (await mockRequests()).filter((r) => r.image);

// ===========================================================================
export async function snapshotSuite(w) {
  suite('スナップショット');

  // 分割そのもの。**表示（BubbleText）とプロンプトが同じ規則を使う**ための共有関数（§21.2）
  {
    const { splitDialogue } = await import('../dist/shared/types.js');
    const act = (s) => splitDialogue(s).filter((p) => !p.dlg).map((p) => p.text).join(' ');
    const dlg = (s) => splitDialogue(s).filter((p) => p.dlg).map((p) => p.text).join(' ');
    const mixed = '「……補修図です。」ノアは腰を屈めた。「刻印石三基——」眼鏡に指を添える。';
    check('地の文だけを取り出せる', act(mixed) === 'ノアは腰を屈めた。 眼鏡に指を添える。', act(mixed));
    check('セリフだけを取り出せる', dlg(mixed) === '……補修図です。 刻印石三基——', dlg(mixed));
    check('閉じていない「以降はセリフ扱い', act('見上げた。「まだ降って') === '見上げた。',
      act('見上げた。「まだ降って'));
    check('セリフしか無ければ地の文は空', act('「はい」') === '', act('「はい」'));
    check('強調記号は外す', act('*ゆっくりと*頷いた。') === 'ゆっくりと頷いた。', act('*ゆっくりと*頷いた。'));
    check('「」の無い文はまるごと地の文', act('風が吹いた。') === '風が吹いた。', act('風が吹いた。'));
  }

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', {
    auto_summarize: 0, auto_extract: 0,
    image_model: 'openai/gpt-image-2',
    image_style_prompt: 'anime illustration',
    image_aspect_ratio: '16:9',
    image_quality: 'medium',
  });

  // 機能の入口。設定が無ければ何も出さない
  {
    await api('PUT', '/settings', { image_model: '' });
    const off = (await api('GET', '/config')).json;
    check('画像モデル未設定なら imageEnabled は偽', off.imageEnabled === false, String(off.imageEnabled));

    const chat = await newChat(w);
    setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);
    const r = await api('POST', `/messages/${mid}/snapshot/preview`);
    check('未設定なら400で設定へ誘導する', r.status === 400 && (r.json?.error ?? '').includes('画像モデル'),
      `${r.status} / ${r.json?.error}`);

    await api('PUT', '/settings', { image_model: 'openai/gpt-image-2' });
    const on = (await api('GET', '/config')).json;
    check('設定すると imageEnabled が真になる', on.imageEnabled === true, String(on.imageEnabled));
    check('モデル名そのものは配らない', on.imageModel === undefined, JSON.stringify(Object.keys(on)));
  }

  // プレビューは組み立てるだけ。課金しない
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ narr: '雨が窓を叩いている。', char: '「静かですね」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);

    await clearMockRequests();
    const r = await api('POST', `/messages/${mid}/snapshot/preview`);
    check('プレビューは200', r.status === 200, `${r.status} / ${r.json?.error}`);
    check('プレビューでは画像APIを呼ばない', (await imageCalls()).length === 0);

    const p = r.json.prompt;
    check('画風が先頭に入る', p.startsWith('anime illustration'), p.split('\n')[0]);
    check('在席キャラの外見が入る', p.includes('silver hair, green coat'), p.replace(/\n/g, ' / '));
    check('不在のキャラの外見は入らない', !p.includes('freckles'), p.replace(/\n/g, ' / '));
    check('場所・時刻が入る', p.includes('本屋') && p.includes('18:'), p.replace(/\n/g, ' / '));
    check('屋内では天候を出さない', !p.includes('晴'), p.replace(/\n/g, ' / '));
    check('地の文が入る', p.includes('雨が窓を叩いている'), p.replace(/\n/g, ' / '));
    check('セリフは入らない', !p.includes('静かですね'), p.replace(/\n/g, ' / '));
    check('ペルソナは既定で入らない', !p.includes('red scarf'), p.replace(/\n/g, ' / '));
    // 参照専用の画像が無ければアバターに落ちる（§21.4）
    check('参照に使う画像を名前と出どころで返す',
      JSON.stringify(r.json.references) === JSON.stringify([{ label: 'アシュリー', from: 'avatar' }]),
      JSON.stringify(r.json.references));

    const withPersona = (await api('POST', `/messages/${mid}/snapshot/preview?include_persona=1`)).json;
    check('include_persona でペルソナの外見が入る', withPersona.prompt.includes('red scarf'));
    check('ペルソナのアバターも参照に加わる',
      JSON.stringify(withPersona.references.map((x) => x.label)) ===
        JSON.stringify(['アシュリー', 'ミナ']),
      JSON.stringify(withPersona.references));
  }

  // 基準は state_after。チャットの現在ステートではない
  {
    const chat = await newChat(w);
    // 1ターン目: 本屋（屋内・晴）
    setQueue([{ text: reply({ narr: '棚の間を歩く。', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't1' });
    const first = await lastAssistant(chat.id);
    // 2ターン目: 港へ移動（屋外）
    setQueue([{ text: reply({ narr: '潮の匂いがする。', elapsed: 30, location: w.harbor }) }]);
    await generate(chat.id, { content: 't2' });

    const now = (await api('GET', `/chats/${chat.id}/state`)).json;
    check('現在地は港になっている', now.state.location === w.harbor, now.state.location);

    const past = (await api('POST', `/messages/${first}/snapshot/preview`)).json;
    check('過去のメッセージは当時の場所で組み立てる',
      past.prompt.includes('本屋') && !past.prompt.includes('港'), past.prompt.replace(/\n/g, ' / '));
    check('過去のメッセージは当時の地の文を使う', past.prompt.includes('棚の間を歩く'),
      past.prompt.replace(/\n/g, ' / '));
  }

  // 在席者が増えれば、その時点の全員が入る
  {
    const chat = await newChat(w, { present: [w.ashley.id, w.toby.id] });
    setQueue([{ text: reply({ char: '「ふたりです」', elapsed: 10, location: w.harbor }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);
    const p = (await api('POST', `/messages/${mid}/snapshot/preview`)).json;
    check('在席者が2人ならどちらの外見も入る',
      p.prompt.includes('silver hair') && p.prompt.includes('freckles'), p.prompt.replace(/\n/g, ' / '));
    check('屋外では天候が入る', p.prompt.includes('晴'), p.prompt.replace(/\n/g, ' / '));
  }

  // 生成 → 保存 → バイナリ配信
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ narr: '灯りが揺れる。', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);

    await clearMockRequests();
    setQueue([{}]); // 画像は既定の1x1 PNG
    const r = await api('POST', `/messages/${mid}/snapshot`, { prompt: '手で直したプロンプト' });
    check('生成できる', r.status === 201, `${r.status} / ${r.json?.error}`);
    check('メタにサイズが入る', r.json.bytes > 0, String(r.json.bytes));
    check('メタに画像本体を含まない', r.json.image === undefined, JSON.stringify(Object.keys(r.json)));

    const sent = (await imageCalls())[0]?.body ?? {};
    check('編集後のプロンプトがそのまま送られる', sent.prompt === '手で直したプロンプト', sent.prompt);
    check('response_format は送らない', sent.response_format === undefined, String(sent.response_format));
    check('aspect_ratio と quality を送る', sent.aspect_ratio === '16:9' && sent.quality === 'medium',
      `${sent.aspect_ratio} / ${sent.quality}`);
    check('在席キャラのアバターを参照として送る',
      (sent.input_references ?? []).length === 1
        && sent.input_references[0].type === 'image_url'
        && String(sent.input_references[0].image_url.url).startsWith('data:image/webp;base64,'),
      JSON.stringify(sent.input_references));

    const img = await fetchImage(r.json.id);
    check('画像はバイナリで返る', img.status === 200 && img.buf.length === r.json.bytes,
      `${img.status} / ${img.buf.length}バイト`);
    check('PNGとして保存されている', img.buf.subarray(1, 4).toString() === 'PNG',
      img.buf.subarray(0, 8).toString('hex'));
    check('Content-Type が画像', img.headers.get('content-type') === 'image/png',
      img.headers.get('content-type'));
    // 認証の内側の個人的な内容なので、共有プロキシに載せてはいけない
    check('Cache-Control は private',
      (img.headers.get('cache-control') ?? '').includes('private'),
      img.headers.get('cache-control'));
    check('immutable が付く', (img.headers.get('cache-control') ?? '').includes('immutable'),
      img.headers.get('cache-control'));

    // ここが崩れると会話の読み込みが一気に重くなる
    const detail = await api('GET', `/chats/${chat.id}`);
    check('チャットの応答にメタだけ同梱される', detail.json.snapshots?.length === 1,
      JSON.stringify(detail.json.snapshots?.length));
    check('チャットの応答に画像データを含まない',
      !detail.text.includes('iVBORw0KGgo') && detail.json.snapshots[0].image === undefined,
      `${Math.round(detail.text.length / 1024)}KB`);
    check('どのメッセージの絵かが分かる', detail.json.snapshots[0].message_id === mid);

    // 参照を切れる
    await clearMockRequests();
    setQueue([{}]);
    await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x', references: false });
    const noRef = (await imageCalls())[0]?.body ?? {};
    check('references:false なら input_references を送らない',
      noRef.input_references === undefined, JSON.stringify(noRef.input_references));

    // 削除
    const del = await api('DELETE', `/snapshots/${r.json.id}`);
    check('削除できる', del.status === 200, String(del.status));
    check('削除後は画像も取れない', (await fetchImage(r.json.id)).status === 404);
  }

  // 参照は4件で切る（16件受けるモデルと4件のモデルがあるので低い方に合わせる）
  {
    const many = [];
    for (let i = 0; i < 6; i++) {
      many.push((await api('POST', `/worlds/${w.world.id}/characters`, {
        name: `群衆${i}`, appearance: `person ${i}`, avatar: i === 5 ? '' : AVATAR(`c${i}`),
      })).json);
    }
    const chat = await newChat(w, { present: many.map((c) => c.id) });
    setQueue([{ text: reply({ narr: '大勢いる。', elapsed: 10, location: w.harbor }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);

    await clearMockRequests();
    setQueue([{}]);
    await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' });
    const sent = (await imageCalls())[0]?.body ?? {};
    check('参照は4件までに切る', (sent.input_references ?? []).length === 4,
      String((sent.input_references ?? []).length));

    const p = (await api('POST', `/messages/${mid}/snapshot/preview`)).json;
    check('アバターが空のキャラは参照に入れない',
      !p.references.some((x) => x.label === '群衆5'), JSON.stringify(p.references));
    for (const c of many) await api('DELETE', `/characters/${c.id}`);
  }

  // media_type が省略された応答でも保存できる
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ narr: 'x。', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);
    setQueue([{ noMediaType: true }]);
    const r = await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' });
    check('media_type が無くても保存できる', r.status === 201, `${r.status} / ${r.json?.error}`);
    check('image/png として扱う', r.json.mime === 'image/png', r.json.mime);
  }

  // 対象にできないメッセージ
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'ユーザーの発言' });
    const d = await getChat(chat.id);
    const userMsg = d.messages.find((m) => m.role === 'user');
    const r = await api('POST', `/messages/${userMsg.id}/snapshot/preview`);
    check('userメッセージには作れない', r.status === 400, `${r.status} / ${r.json?.error}`);

    await api('POST', `/chats/${chat.id}/advance`, { minutes: 60 });
    const after = await getChat(chat.id);
    const marker = after.messages.find((m) => m.kind === 'scene_break');
    const r2 = await api('POST', `/messages/${marker.id}/snapshot/preview`);
    check('場面転換マーカーにも作れない', r2.status === 400, `${r2.status} / ${r2.json?.error}`);
  }

  // 上流の失敗は理由を返し、空を保存しない
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ narr: 'y。', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);

    setQueue([{ status: 502, text: 'upstream down' }]);
    const r = await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' });
    check('上流エラーは502で理由を返す', r.status === 502 && (r.json?.error ?? '').includes('502'),
      `${r.status} / ${r.json?.error}`);
    check('失敗したら保存しない',
      (await api('GET', `/chats/${chat.id}`)).json.snapshots.length === 0);

    // 直せば作れる
    setQueue([{}]);
    const ok = await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' });
    check('直せば作れる（ロックが残らない）', ok.status === 201, `${ok.status} / ${ok.json?.error}`);
  }

  // 二重生成は弾くが、会話の生成は止めない
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ narr: 'z。', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);

    // タイムアウト（2500ms）より十分手前で終わる遅延にする。
    // ここで見たいのはロックの効き方であって、タイムアウトではない
    setQueue([{ headDelayMs: 1000 }]);
    const slow = api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' });
    await new Promise((r) => setTimeout(r, 300));

    const dup = await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' });
    check('同じメッセージへの二重生成は409', dup.status === 409, `${dup.status} / ${dup.json?.error}`);

    // 画像生成の最中でも会話は進められる（生成ロックとは別枠）
    setQueue([{ text: reply({ char: '「進めます」', elapsed: 10, location: w.shop }) }]);
    const g = await generate(chat.id, { content: '画像生成中の発言' });
    check('画像生成中でも会話は生成できる', g.done?.generationStatus === 'complete',
      `${g.httpStatus ?? 200} / ${g.done?.generationStatus ?? g.error}`);

    const first = await slow;
    check('1本目は完了する', first.status === 201, `${first.status} / ${first.json?.error}`);
  }

  // キャラ発話の中の地の文（§21.2）。**ここが第2弾で直した本体。**
  // セリフと動作が同じ塊に入るので、話者ではなく「」で分ける
  {
    const chat = await newChat(w);
    setQueue([{
      text: reply({
        char: '「……補修図です。」ノアは腰を屈め、囲みの中を目で数えた。「刻印石三基——」',
        elapsed: 10, location: w.shop,
      }),
    }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);
    const p = (await api('POST', `/messages/${mid}/snapshot/preview`)).json;
    check('ナレーター行が無くてもキャラ発話の地の文を拾う',
      p.prompt.includes('腰を屈め'), p.prompt.replace(/\n/g, ' / '));
    check('「」の中のセリフは入らない',
      !p.prompt.includes('補修図') && !p.prompt.includes('刻印石'), p.prompt.replace(/\n/g, ' / '));
    check('地の文が無いという警告は出ない',
      !p.warnings.some((x) => x.includes('地の文がありません')), JSON.stringify(p.warnings));
  }

  // 閉じていない「で終わる本文でも落とせる
  {
    const chat = await newChat(w);
    setQueue([{
      text: reply({ char: '窓の外を見た。「まだ降っている', elapsed: 10, location: w.shop }),
    }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);
    const p = (await api('POST', `/messages/${mid}/snapshot/preview`)).json;
    check('閉じていない「以降も落とす',
      p.prompt.includes('窓の外を見た') && !p.prompt.includes('まだ降っている'),
      p.prompt.replace(/\n/g, ' / '));
  }

  // セリフしかないターンは、場面の描写が無いことを警告する
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);
    const p = (await api('POST', `/messages/${mid}/snapshot/preview`)).json;
    check('セリフだけなら地の文が無いと警告する',
      p.warnings.some((x) => x.includes('地の文がありません')), JSON.stringify(p.warnings));
  }

  // 文字を描かせない指示（既定ON）
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ narr: '掲示板に紙が貼ってある。', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);

    const on = (await api('POST', `/messages/${mid}/snapshot/preview`)).json;
    check('既定では文字を描かせない指示が付く',
      on.prompt.includes('Do not render any text'), on.prompt.replace(/\n/g, ' / '));
    check('指示は末尾に置く（プレビューで消せる）',
      on.prompt.trim().endsWith('or UI.'), on.prompt.split('\n').pop());

    await api('PUT', '/settings', { image_no_text: 0 });
    const off = (await api('POST', `/messages/${mid}/snapshot/preview`)).json;
    check('OFFなら付かない', !off.prompt.includes('Do not render'), off.prompt.replace(/\n/g, ' / '));
    await api('PUT', '/settings', { image_no_text: 1 });
  }

  // メッセージを消せばスナップショットも消える
  {
    const chat = await newChat(w);
    setQueue([{ text: reply({ narr: 'w。', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = await lastAssistant(chat.id);
    setQueue([{}]);
    const snap = (await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' })).json;
    check('作成できた', !!snap.id, JSON.stringify(snap));

    await api('DELETE', `/messages/${mid}`);
    check('メッセージを消すとスナップショットも消える',
      (await fetchImage(snap.id)).status === 404);
  }

  await api('PUT', '/settings', base);
}

// ===========================================================================
// アルバム（§21.4）。容量の整理が目的なので、枚数とサイズが正しいことを見る。
// **世界ごと消す検証をするので、専用の世界を作って使い捨てる**
// ===========================================================================
export async function albumSuite() {
  suite('アルバム');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', {
    auto_summarize: 0, auto_extract: 0, image_model: 'openai/gpt-image-2',
  });

  const a = await setupSnapshotWorld('album_a');
  const b = await setupSnapshotWorld('album_b');

  /** 1ターン進めてスナップショットを1枚作る */
  const shoot = async (world, chat, note) => {
    setQueue([{ text: reply({ narr: note, elapsed: 10, location: world.shop }) }]);
    await generate(chat.id, { content: note });
    const mid = await lastAssistant(chat.id);
    setQueue([{}]);
    return (await api('POST', `/messages/${mid}/snapshot`, { prompt: note })).json;
  };

  const chatA1 = await newChat(a);
  const chatA2 = await newChat(a);
  const chatB1 = await newChat(b);
  const s1 = await shoot(a, chatA1, 'あ1');
  const s2 = await shoot(a, chatA1, 'あ2');
  const s3 = await shoot(a, chatA2, 'あ3');
  const s4 = await shoot(b, chatB1, 'い1');

  // 入口: 世界ごとの枚数と合計サイズ
  {
    const albums = (await api('GET', '/albums')).json;
    const rowA = albums.find((x) => x.world_id === a.world.id);
    const rowB = albums.find((x) => x.world_id === b.world.id);
    check('世界ごとの枚数が出る', rowA?.count === 3 && rowB?.count === 1,
      `${rowA?.count} / ${rowB?.count}`);
    check('合計サイズが出る', rowA?.bytes === s1.bytes + s2.bytes + s3.bytes,
      `${rowA?.bytes} vs ${s1.bytes + s2.bytes + s3.bytes}`);
    check('世界名が付く', rowA?.world_name === 'album_a', rowA?.world_name);
    check('1枚も無い世界は出さない', !albums.some((x) => x.count === 0),
      JSON.stringify(albums.map((x) => x.count)));
  }

  // 世界の一覧: 会話名付き・画像なし・混ざらない
  {
    const r = await api('GET', `/worlds/${a.world.id}/snapshots`);
    check('世界の一覧は200', r.status === 200, String(r.status));
    check('その世界の分だけ返る', r.json.length === 3, String(r.json.length));
    check('別の世界の分は混ざらない', !r.json.some((x) => x.id === s4.id),
      JSON.stringify(r.json.map((x) => x.id)));
    check('会話名が付く', r.json.every((x) => typeof x.chat_title === 'string'),
      JSON.stringify(r.json.map((x) => x.chat_title)));
    check('メッセージのseqが付く', r.json.every((x) => x.seq > 0),
      JSON.stringify(r.json.map((x) => x.seq)));
    // ここが崩れると、アルバムを開くだけで全画像がJSONに載る
    check('画像データを含まない',
      !r.text.includes('iVBORw0KGgo') && r.json.every((x) => x.image === undefined),
      `${Math.round(r.text.length / 1024)}KB`);
    check('会話ごとにまとまって並ぶ',
      r.json[0].chat_id === r.json[1].chat_id && r.json[2].chat_id !== r.json[0].chat_id,
      JSON.stringify(r.json.map((x) => x.chat_id)));

    const missing = await api('GET', '/worlds/nope/snapshots');
    check('知らない世界は404', missing.status === 404, String(missing.status));
  }

  // 一括削除
  {
    const empty = await api('POST', '/snapshots/delete', { ids: [] });
    check('空の指定は400', empty.status === 400, `${empty.status} / ${empty.json?.error}`);

    const r = await api('POST', '/snapshots/delete', { ids: [s1.id, 'no-such-id', s2.id] });
    check('まとめて消せる', r.json?.deleted === 2, JSON.stringify(r.json));
    check('消えたものは画像も取れない', (await fetchImage(s1.id)).status === 404);
    check('存在しないIDが混ざっても他は消える', (await fetchImage(s2.id)).status === 404);
    check('指定していないものは残る', (await fetchImage(s3.id)).status === 200);

    const albums = (await api('GET', '/albums')).json;
    check('削除後は枚数が減る',
      albums.find((x) => x.world_id === a.world.id)?.count === 1,
      String(albums.find((x) => x.world_id === a.world.id)?.count));
  }

  // 会話を消すとその会話の画像が消える（外部キーの連鎖）
  {
    const s5 = await shoot(a, chatA1, 'あ4');
    check('作り直せた', (await fetchImage(s5.id)).status === 200);
    await api('DELETE', `/chats/${chatA1.id}`);
    check('会話を消すとその画像も消える', (await fetchImage(s5.id)).status === 404);
    check('別の会話の画像は残る', (await fetchImage(s3.id)).status === 200);
  }

  // 世界を消すとその世界の画像が全部消える
  {
    const usage = (await api('GET', `/worlds/${a.world.id}`)).json.usage;
    check('削除の確認に枚数が入る', usage.snapshots === 1, String(usage.snapshots));

    await api('DELETE', `/worlds/${a.world.id}`);
    check('世界を消すとその画像も消える', (await fetchImage(s3.id)).status === 404);
    check('別の世界の画像は残る', (await fetchImage(s4.id)).status === 200);

    const albums = (await api('GET', '/albums')).json;
    check('アルバムからも消える', !albums.some((x) => x.world_id === a.world.id),
      JSON.stringify(albums.map((x) => x.world_id)));
  }

  await api('DELETE', `/worlds/${b.world.id}`);
  await api('PUT', '/settings', base);
}

// ===========================================================================
// 上流が黙り込んだとき（タイムアウト）
// ===========================================================================
export async function snapshotTimeoutSuite(w) {
  suite('スナップショットのタイムアウト');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', {
    auto_summarize: 0, auto_extract: 0, image_model: 'openai/gpt-image-2',
  });

  const chat = await newChat(w);
  setQueue([{ text: reply({ narr: 't。', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 't' });
  const mid = await lastAssistant(chat.id);

  setQueue([{ headDelayMs: 8000 }]);
  const started = Date.now();
  const r = await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' });
  const took = Date.now() - started;

  check('待ち続けずに打ち切る', took < 5000, `${took}ms`);
  check('理由の分かるエラーを返す', (r.json?.error ?? '').includes('応答が'), r.json?.error);
  check('課金の可能性を伝える', (r.json?.error ?? '').includes('課金'), r.json?.error);
  check('空を保存しない', (await api('GET', `/chats/${chat.id}`)).json.snapshots.length === 0);

  setQueue([{}]);
  const ok = await api('POST', `/messages/${mid}/snapshot`, { prompt: 'x' });
  check('タイムアウト後も次を作れる', ok.status === 201, `${ok.status} / ${ok.json?.error}`);

  await api('PUT', '/settings', base);
}
