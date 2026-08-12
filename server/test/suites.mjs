// ステート・variant・再生成・分岐のテストスイート
import {
  api,
  check,
  clearMockRequests,
  generate,
  getChat,
  hhmm,
  mockRequests,
  note,
  reply,
  setModelsDelay,
  setQueue,
  suite,
} from './harness.mjs';

// 3年8月10日 18:00 = 877日 * 1440分 + 18時間
export const T1800 = 877 * 1440 + 18 * 60;

/** テスト用の世界・キャラを用意する */
export async function setupWorld(label) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const p = `${label}_`;
  await api('POST', `/worlds/${world.id}/locations`, { id: `${p}shop`, name: '本屋', indoor: 1, area: 'center' });
  await api('POST', `/worlds/${world.id}/locations`, { id: `${p}cafe`, name: 'カフェ', indoor: 1, area: 'center' });
  const ashley = (await api('POST', `/worlds/${world.id}/characters`, { name: 'アシュリー' })).json;
  const luna = (await api('POST', `/worlds/${world.id}/characters`, { name: 'ルナ' })).json;
  return { world, ashley, luna, shop: `${p}shop`, cafe: `${p}cafe` };
}

/** シナリオとチャットを作る */
export async function newChat(w, opts = {}) {
  const scenario = (
    await api('POST', `/worlds/${w.world.id}/scenarios`, {
      title: 'test',
      participant_ids: [w.ashley.id, w.luna.id],
      opening: opts.opening ?? 'ナレーター: 開始。',
      initial_state: {
        time: opts.time ?? T1800,
        location: opts.location ?? w.shop,
        location_note: '',
        weather: '晴',
        present: opts.present ?? [w.ashley.id],
      },
    })
  ).json;
  const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
  return { scenario, chat };
}

// ===========================================================================
export async function normalFlow(w) {
  suite('正常系: ステート・候補・再生成・分岐');
  const { chat } = await newChat(w);

  let d = await getChat(chat.id);
  check('初期状態が 18:00 / 本屋', hhmm(d.chat.state.time) === '18:00' && d.chat.state.location === w.shop,
    `${hhmm(d.chat.state.time)} / ${d.chat.state.location}`);

  // 応答A: 20分・カフェへ
  setQueue([{ text: reply({ char: '「行きましょうか」', elapsed: 20, location: w.cafe }) }]);
  check('通常送信が成功', !!(await generate(chat.id, { content: 'こんばんは' })).done);
  d = await getChat(chat.id);
  check('A: 18:20 / カフェ', hhmm(d.chat.state.time) === '18:20' && d.chat.state.location === w.cafe,
    `${hhmm(d.chat.state.time)} / ${d.chat.state.location}`);

  // 応答B: 30分・本屋のまま（再生成）
  setQueue([{ text: reply({ char: '「まだここにいます」', elapsed: 30, location: w.shop }) }]);
  check('再生成が成功', !!(await generate(chat.id, { regenerate: true })).done);
  d = await getChat(chat.id);
  const msg = d.messages[d.messages.length - 1];
  check('B: 18:30（18:50に累積しない）', hhmm(d.chat.state.time) === '18:30', hhmm(d.chat.state.time));
  check('B: 本屋のまま', d.chat.state.location === w.shop, d.chat.state.location);
  check('候補が2件・activeが1', msg.variant_count === 2 && msg.active_variant === 1,
    `${msg.variant_count}件 / active=${msg.active_variant}`);

  // 候補切替でステートが連動する
  await api('PUT', `/messages/${msg.id}/variant`, { index: 0 });
  d = await getChat(chat.id);
  check('→A: 18:20 / カフェ / 本文もA',
    hhmm(d.chat.state.time) === '18:20' && d.chat.state.location === w.cafe &&
      d.messages[d.messages.length - 1].content.includes('行きましょうか'),
    `${hhmm(d.chat.state.time)} / ${d.chat.state.location}`);
  await api('PUT', `/messages/${msg.id}/variant`, { index: 1 });
  d = await getChat(chat.id);
  check('→B: 18:30 / 本屋 / 本文もB',
    hhmm(d.chat.state.time) === '18:30' && d.chat.state.location === w.shop &&
      d.messages[d.messages.length - 1].content.includes('まだここに'),
    `${hhmm(d.chat.state.time)} / ${d.chat.state.location}`);

  // 何度再生成しても基準は user メッセージの state_after（18:00）
  const seen = [];
  for (const mins of [15, 45, 5]) {
    setQueue([{ text: reply({ char: `「${mins}分」`, elapsed: mins, location: w.shop }) }]);
    await generate(chat.id, { regenerate: true });
    seen.push(hhmm((await getChat(chat.id)).chat.state.time));
  }
  check('再生成を繰り返しても累積しない', seen.join(',') === '18:15,18:45,18:05', seen.join(','));

  const variants = (await api('GET', `/messages/${msg.id}/variants`)).json;
  check('候補 index が 0..4 で重複なし',
    JSON.stringify(variants.map((v) => v.index)) === '[0,1,2,3,4]',
    JSON.stringify(variants.map((v) => v.index)));

  // 数ターン進めてから、過去の候補を選んで分岐する
  for (const i of [1, 2, 3]) {
    setQueue([{ text: reply({ char: `「${i}ターン目」`, elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: `ターン${i}` });
  }
  const before = await getChat(chat.id);
  const targetBefore = before.messages.find((m) => m.id === msg.id);
  const pick = variants.find((v) => v.content.includes('まだここに'));

  const fork = (await api('POST', `/chats/${chat.id}/fork`, { message_id: msg.id, variant_index: pick.index })).json;
  check('分岐が作成される', !!fork?.id);

  const after = await getChat(chat.id);
  check('元Chatのメッセージ数が変わらない', after.messages.length === before.messages.length,
    `${after.messages.length} vs ${before.messages.length}`);
  check('元Chatの現在ステートが変わらない',
    JSON.stringify(after.chat.state) === JSON.stringify(before.chat.state));
  const targetAfter = after.messages.find((m) => m.id === msg.id);
  check('元Chatの表示中候補が変わらない',
    targetAfter.active_variant === targetBefore.active_variant &&
      targetAfter.content === targetBefore.content);

  const fd = await getChat(fork.id);
  check('分岐先に対象より後のメッセージが無い', fd.messages.length === targetBefore.seq,
    `${fd.messages.length}件 / 対象seq=${targetBefore.seq}`);
  const forkLast = fd.messages[fd.messages.length - 1];
  check('分岐先の末尾が選んだ候補の本文', forkLast.content === pick.content);
  check('分岐先のステートが選んだ候補の state_after と一致',
    JSON.stringify(fd.chat.state) === JSON.stringify(pick.state_after),
    `${hhmm(fd.chat.state.time)} / ${fd.chat.state.location}`);
  check('分岐先の末尾メッセージの state_after も一致',
    JSON.stringify(forkLast.state_after) === JSON.stringify(pick.state_after));
  check('分岐先に候補もコピーされる', forkLast.variant_count === variants.length,
    `${forkLast.variant_count} vs ${variants.length}`);
  check('分岐先の seq が1から連番',
    JSON.stringify(fd.messages.map((m) => m.seq)) === JSON.stringify(fd.messages.map((_, i) => i + 1)),
    JSON.stringify(fd.messages.map((m) => m.seq)));

  // 再起動後の比較用
  return {
    chatId: chat.id,
    forkId: fork.id,
    orig: { state: after.chat.state, count: after.messages.length },
    fork: { state: fd.chat.state, count: fd.messages.length, lastContent: forkLast.content },
  };
}

// ===========================================================================
export async function restored(snapshot) {
  suite('再起動後の復元');
  const orig = await getChat(snapshot.chatId);
  const fork = await getChat(snapshot.forkId);
  check('元Chat: ステート一致', JSON.stringify(orig.chat.state) === JSON.stringify(snapshot.orig.state));
  check('元Chat: メッセージ数一致', orig.messages.length === snapshot.orig.count);
  check('分岐: ステート一致', JSON.stringify(fork.chat.state) === JSON.stringify(snapshot.fork.state));
  check('分岐: メッセージ数一致', fork.messages.length === snapshot.fork.count);
  check('分岐: 末尾本文一致',
    fork.messages[fork.messages.length - 1].content === snapshot.fork.lastContent);
  check('分岐: gameTime が state.time と整合',
    `${String(fork.gameTime.hh).padStart(2, '0')}:${String(fork.gameTime.mm).padStart(2, '0')}` ===
      hhmm(fork.chat.state.time),
    JSON.stringify(fork.gameTime));
}

// ===========================================================================
export async function regressionInitialState(w) {
  suite('回帰: Chatの初期ステート（先頭再生成の累積・全削除後の復元）');

  // 先頭メッセージを繰り返し再生成しても累積しない
  {
    const { chat } = await newChat(w);
    const seen = [];
    for (const i of [1, 2, 3]) {
      setQueue([{ text: reply({ char: `「${i}回目」`, elapsed: 20, location: w.shop }) }]);
      const g = await generate(chat.id, { regenerate: true });
      if (!g.done) {
        check(`先頭の再生成 ${i}回目`, false, g.error ?? `http=${g.httpStatus}`);
        break;
      }
      seen.push(hhmm((await getChat(chat.id)).chat.state.time));
    }
    note(`先頭を elapsed=20 で3回再生成 → ${seen.join(' , ')}`);
    check('先頭の再生成が累積しない（毎回18:20）', seen.every((t) => t === '18:20'), seen.join(' , '));

    // その後の通常送信にも持ち越されない
    setQueue([{ text: reply({ char: '「続き」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'つぎ' });
    check('先頭再生成の後の通常送信が 18:30',
      hhmm((await getChat(chat.id)).chat.state.time) === '18:30',
      hhmm((await getChat(chat.id)).chat.state.time));
  }

  // シナリオを後から編集しても、全削除後は「作成時」の初期ステートに戻る
  {
    const { scenario, chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「進みます」', elapsed: 30, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    await api('PUT', `/scenarios/${scenario.id}`, {
      initial_state: { time: 877 * 1440 + 9 * 60, location: w.cafe, location_note: '', weather: '雪', present: [] },
    });
    let d = await getChat(chat.id);
    check('シナリオ編集は進行中のChatに影響しない', hhmm(d.chat.state.time) === '18:30', hhmm(d.chat.state.time));
    for (const m of [...d.messages]) await api('DELETE', `/messages/${m.id}`);
    d = await getChat(chat.id);
    check('全削除後は作成時の初期ステートに戻る（編集後のシナリオを拾わない）',
      hhmm(d.chat.state.time) === '18:00' && d.chat.state.location === w.shop && d.chat.state.weather === '晴',
      `${hhmm(d.chat.state.time)} / ${d.chat.state.location} / ${d.chat.state.weather}`);
  }

  // シナリオを削除しても、全削除後は初期ステートに戻る
  {
    const { scenario, chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「進みます」', elapsed: 45, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    await api('DELETE', `/scenarios/${scenario.id}`);
    let d = await getChat(chat.id);
    check('シナリオ削除で scenario_id が NULL', d.chat.scenario_id === null, String(d.chat.scenario_id));
    for (const m of [...d.messages]) await api('DELETE', `/messages/${m.id}`);
    d = await getChat(chat.id);
    check('シナリオ削除後も全削除で初期ステートに戻る',
      hhmm(d.chat.state.time) === '18:00', hhmm(d.chat.state.time));
  }

  // 初期ステートは書き換えられない
  {
    const { chat } = await newChat(w);
    await api('PUT', `/chats/${chat.id}`, {
      initial_state: { time: 0, location: '', location_note: '', weather: '', present: [] },
    });
    const d = await getChat(chat.id);
    check('PUT /chats/:id では初期ステートを変更できない',
      hhmm(d.chat.initial_state.time) === '18:00' && d.chat.initial_state.location === w.shop,
      JSON.stringify(d.chat.initial_state));
  }

  // 分岐先も同じ初期ステートを引き継ぐ
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「1」', elapsed: 25, location: w.cafe }) }]);
    await generate(chat.id, { content: 'A' });
    const d = await getChat(chat.id);
    const fork = (await api('POST', `/chats/${chat.id}/fork`, {
      message_id: d.messages[d.messages.length - 1].id,
    })).json;
    const fd = await getChat(fork.id);
    check('分岐先の初期ステートが元Chatと同じ',
      JSON.stringify(fd.chat.initial_state) === JSON.stringify(d.chat.initial_state),
      JSON.stringify(fd.chat.initial_state));
    // 分岐先で先頭を再生成しても累積しない
    for (const m of [...fd.messages].slice(1)) await api('DELETE', `/messages/${m.id}`);
    const seen = [];
    for (const i of [1, 2]) {
      setQueue([{ text: reply({ char: `「${i}」`, elapsed: 20, location: w.shop }) }]);
      await generate(fork.id, { regenerate: true });
      seen.push(hhmm((await getChat(fork.id)).chat.state.time));
    }
    check('分岐先でも先頭の再生成が累積しない', seen.every((t) => t === '18:20'), seen.join(' , '));
  }
}

// ===========================================================================
export async function abnormal(w) {
  suite('異常系');

  // 生成途中で停止
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「'.padEnd(60, 'あ') + '」', elapsed: 40, location: w.cafe }), gapMs: 30 }]);
    const p = generate(chat.id, { content: 'テスト' });
    await new Promise((r) => setTimeout(r, 500));
    const stopRes = await api('POST', `/chats/${chat.id}/stop`);
    const g = await p;
    check('停止: /stop が 200', stopRes.status === 200, String(stopRes.status));
    check('停止: stopped として保存される', g.done?.generationStatus === 'stopped', g.done?.generationStatus);
    const d = await getChat(chat.id);
    check('停止: ゲーム内時間が進まない', hhmm(d.chat.state.time) === '18:00', hhmm(d.chat.state.time));
    check('停止: 場所も変わらない', d.chat.state.location === w.shop, d.chat.state.location);
    const last = d.messages[d.messages.length - 1];
    check('停止: 途中までの本文と state_after が残る',
      last.content.length > 0 && last.state_after.time === T1800, `${last.content.length}文字`);
  }

  // ヘッダが返る前に停止（送信直後に止めた場合）
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「届かない」', elapsed: 40, location: w.cafe }), headDelayMs: 3000 }]);
    const p = generate(chat.id, { content: '送ってすぐ止める' });
    await new Promise((r) => setTimeout(r, 300)); // まだヘッダは返っていない
    const stopRes = await api('POST', `/chats/${chat.id}/stop`);
    const g = await p;
    check('ヘッダ前の停止: /stop が 200', stopRes.status === 200, String(stopRes.status));
    // abort が fetch 側で起きても通信エラーにしない（§5.7）
    check('ヘッダ前の停止: 通信エラー扱いにしない',
      !/aborted|AbortError|fetch failed/i.test(g.error ?? ''), g.error ?? '（エラーなし）');
    check('ヘッダ前の停止: 停止だと分かる説明を返す',
      (g.error ?? '').includes('停止'), g.error ?? '（エラーなし）');

    const d = await getChat(chat.id);
    check('ヘッダ前の停止: assistant は保存しない（末尾は user のまま）',
      d.messages[d.messages.length - 1].role === 'user',
      d.messages.slice(-2).map((m) => m.role).join(','));
    check('ヘッダ前の停止: 時間も進まない', hhmm(d.chat.state.time) === '18:00', hhmm(d.chat.state.time));

    // ロックが解けていること。解けていないと以後ずっと409になる
    setQueue([{ text: reply({ char: '「今度は届く」', elapsed: 10, location: w.shop }) }]);
    const again = await generate(chat.id, { content: 'やり直し' });
    check('ヘッダ前の停止: そのあと再試行できる（409にならない）',
      again.done?.generationStatus === 'complete',
      `${again.httpStatus ?? 200} / ${again.done?.generationStatus ?? again.error}`);
  }

  // 通常のAPIエラーは停止と区別する
  {
    const { chat } = await newChat(w);
    setQueue([{ status: 502, text: 'upstream is down' }]);
    const g = await generate(chat.id, { content: '失敗させる' });
    check('APIエラー: エラーとして返る', !!g.error, g.error ?? '（エラーなし）');
    check('APIエラー: 停止とは違う説明になる', !(g.error ?? '').includes('停止'), g.error);
    const d = await getChat(chat.id);
    check('APIエラー: assistant は保存しない',
      d.messages[d.messages.length - 1].role === 'user',
      d.messages.slice(-2).map((m) => m.role).join(','));
    setQueue([{ text: reply({ char: '「復帰」', elapsed: 10, location: w.shop }) }]);
    const again = await generate(chat.id, { content: 'やり直し' });
    check('APIエラー: そのあと再試行できる', again.done?.generationStatus === 'complete',
      `${again.httpStatus ?? 200} / ${again.done?.generationStatus ?? again.error}`);
  }

  // 上流が黙り込んだとき（タイムアウト）。
  // ロックは finally で外す作りなので、そこへ到達できないと以後ずっと409になる。
  // タイムアウト値はテスト用に 1200ms へ落としてある（run.mjs）
  {
    const cases = [
      {
        label: '接続確立前',
        queue: { text: reply({ char: '「来ない」' }), headDelayMs: 5000 },
        expect: '応答が始まりません',
      },
      {
        label: 'ヘッダだけ来て本文が来ない',
        queue: { text: reply({ char: '「来ない」' }), stallMs: 5000, stallAfter: 0 },
        expect: '応答が途切れました',
      },
      {
        label: '途中まで来て止まる',
        queue: { text: reply({ char: '「途中まで」' }), stallMs: 5000, stallAfter: 6 },
        expect: '応答が途切れました',
      },
    ];

    for (const c of cases) {
      const { chat } = await newChat(w);
      setQueue([c.queue]);
      const started = Date.now();
      const g = await generate(chat.id, { content: c.label });
      const took = Date.now() - started;

      check(`${c.label}: 待ち続けずに打ち切る`, took < 4000, `${took}ms`);
      check(`${c.label}: 上流の無応答だと分かる説明を返す`,
        (g.error ?? '').includes(c.expect), g.error ?? '（エラーなし）');
      check(`${c.label}: 「停止しました」にはしない`, !(g.error ?? '').includes('停止'), g.error);
      check(`${c.label}: assistant は保存しない`,
        (await getChat(chat.id)).messages.slice(-1)[0].role === 'user',
        (await getChat(chat.id)).messages.slice(-2).map((m) => m.role).join(','));

      // ロックが解放されていること
      setQueue([{ text: reply({ char: '「復帰」', elapsed: 10, location: w.shop }) }]);
      const again = await generate(chat.id, { content: 'やり直し' });
      check(`${c.label}: そのあと生成できる（409にならない）`,
        again.done?.generationStatus === 'complete',
        `${again.httpStatus ?? 200} / ${again.done?.generationStatus ?? again.error}`);
    }

    // 受信済みの本文を捨てたことは伝える（黙って消さない）
    {
      const { chat } = await newChat(w);
      setQueue([{ text: reply({ char: '「途中まで」' }), stallMs: 5000, stallAfter: 6 }]);
      const g = await generate(chat.id, { content: '捨てたことを伝える' });
      check('途中まで受信していたら、その文字数を伝える',
        /受信していた\d+文字は保存していません/.test(g.error ?? ''), g.error);
    }
  }

  // ペルソナの代弁。本文は切り詰めるが、フェンスは巻き込まない
  {
    const persona = (await api('POST', '/personas', { name: 'ミナ', description: 'わたし' })).json;
    const scenario = (
      await api('POST', `/worlds/${w.world.id}/scenarios`, {
        title: 'impersonate',
        participant_ids: [w.ashley.id],
        opening: 'ナレーター: 開始。',
        initial_state: { time: T1800, location: w.shop, weather: '晴', present: [w.ashley.id] },
      })
    ).json;
    const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, { persona_id: persona.id })).json;

    setQueue([
      {
        text:
          'アシュリー: 「ここまでは正しい」\n' +
          'ミナ: 「勝手に喋らされている」\n' +
          '\n@@@STATE\nelapsed_minutes: 25\nlocation: ' + w.cafe + '\n@@@END',
      },
    ]);
    const g = await generate(chat.id, { content: '代弁させる' });
    const d = await getChat(chat.id);
    const last = d.messages[d.messages.length - 1];

    check('代弁: 代弁行以降の本文は保存しない', !last.content.includes('勝手に喋らされている'),
      last.content.replace(/\n/g, ' / '));
    check('代弁: 手前の本文は残る', last.content.includes('ここまでは正しい'), last.content);
    // フェンスは本文の外。代弁の切り詰めで一緒に捨ててはいけない
    check('代弁: フェンスは解釈される（elapsed 25 が効く）', hhmm(d.chat.state.time) === '18:25',
      hhmm(d.chat.state.time));
    check('代弁: フェンスの location も効く', d.chat.state.location === w.cafe, d.chat.state.location);
    check('代弁: フェンス欠落として数えない', g.done?.fenceMissingStreak === 0,
      String(g.done?.fenceMissingStreak));
    check('代弁: 代弁を検出したことを警告で返す',
      (g.done?.warnings ?? []).some((x) => x.includes('代弁')), JSON.stringify(g.done?.warnings));
  }

  // STATEフェンスが欠落
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「フェンスなし」', fence: false }) }]);
    const g = await generate(chat.id, { content: 'テスト' });
    let d = await getChat(chat.id);
    check('フェンス欠落: 10分のフォールバック', hhmm(d.chat.state.time) === '18:10', hhmm(d.chat.state.time));
    check('フェンス欠落: 場所は変わらない', d.chat.state.location === w.shop);
    check('フェンス欠落: streak が 1', g.done?.fenceMissingStreak === 1, String(g.done?.fenceMissingStreak));
    for (const i of [2, 3]) {
      setQueue([{ text: reply({ char: `「${i}」`, fence: false }) }]);
      const r = await generate(chat.id, { content: `t${i}` });
      if (i === 3) check('フェンス欠落: 3回連続で streak=3', r.done?.fenceMissingStreak === 3,
        String(r.done?.fenceMissingStreak));
    }
    setQueue([{ text: reply({ char: '「復帰」', elapsed: 5, location: w.shop }) }]);
    const r = await generate(chat.id, { content: 'ok' });
    check('フェンス欠落: 復帰で streak が 0', r.done?.fenceMissingStreak === 0, String(r.done?.fenceMissingStreak));
  }

  // STATEフェンスが途中で切れる
  {
    const { chat } = await newChat(w);
    setQueue([{ text: `アシュリー: 「途中で切れます」\n\n@@@STATE\nelapsed_minutes: 25\nlocation: ${w.cafe.slice(0, -2)}` }]);
    const g = await generate(chat.id, { content: 'テスト' });
    const d = await getChat(chat.id);
    check('フェンス切断: elapsed は読める', hhmm(d.chat.state.time) === '18:25', hhmm(d.chat.state.time));
    check('フェンス切断: 壊れた location は location_note へ退避',
      d.chat.state.location === w.shop && d.chat.state.location_note !== '',
      `${d.chat.state.location} / note=${d.chat.state.location_note}`);
    check('フェンス切断: 本文に @@@ が混入しない',
      !d.messages[d.messages.length - 1].content.includes('@@@'));
    check('フェンス切断: 画面に流す差分にも @@@ が出ない', !g.deltas.includes('@@@'));
  }

  // 不正な location ID
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「路地裏へ」', elapsed: 10, location: '存在しない場所' }) }]);
    await generate(chat.id, { content: 't' });
    let d = await getChat(chat.id);
    check('不正な場所: location は変わらない', d.chat.state.location === w.shop, d.chat.state.location);
    check('不正な場所: location_note へ退避', d.chat.state.location_note === '存在しない場所',
      d.chat.state.location_note);
    setQueue([{ text: reply({ char: '「戻ります」', elapsed: 10, location: w.cafe }) }]);
    await generate(chat.id, { content: 't2' });
    d = await getChat(chat.id);
    check('不正な場所: 登録場所に戻ると note がクリアされる',
      d.chat.state.location === w.cafe && d.chat.state.location_note === '',
      `${d.chat.state.location} / note="${d.chat.state.location_note}"`);
    setQueue([{ text: reply({ char: '「本屋へ」', elapsed: 5, location: '本屋' }) }]);
    await generate(chat.id, { content: 't3' });
    check('不正な場所: 表示名でも場所IDに解決する',
      (await getChat(chat.id)).chat.state.location === w.shop);
  }

  // present_add と present_remove に同じ人物（仕様§8.1の式どおり remove が勝つ）
  {
    const { chat } = await newChat(w, { present: [w.ashley.id, w.luna.id] });
    setQueue([{ text: reply({ char: '「両方指定」', elapsed: 10, add: w.luna.id, remove: w.luna.id }) }]);
    await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    note(`present = ${JSON.stringify(d.chat.state.present)}`);
    check('add/remove 同一人物: present が重複しない',
      new Set(d.chat.state.present).size === d.chat.state.present.length,
      JSON.stringify(d.chat.state.present));
    check('add/remove 同一人物: remove が優先される（不在になる）',
      !d.chat.state.present.includes(w.luna.id), JSON.stringify(d.chat.state.present));
  }

  // 生成の連打
  {
    const { chat } = await newChat(w);
    setQueue([
      { text: reply({ char: '「1本目」', elapsed: 10, location: w.shop }), gapMs: 25 },
      { text: reply({ char: '「2本目」', elapsed: 99, location: w.cafe }) },
    ]);
    const rs = await Promise.all([
      generate(chat.id, { content: '連打1' }),
      new Promise((r) => setTimeout(r, 120)).then(() => generate(chat.id, { content: '連打2' })),
      new Promise((r) => setTimeout(r, 160)).then(() => generate(chat.id, { content: '連打3' })),
    ]);
    check('連打: 後続が 409 で弾かれる', rs.filter((r) => r.httpStatus === 409).length === 2,
      JSON.stringify(rs.map((r) => r.httpStatus)));
    const d = await getChat(chat.id);
    check('連打: 409 の分の user メッセージが残らない',
      d.messages.filter((m) => m.role === 'user').length === 1,
      JSON.stringify(d.messages.filter((m) => m.role === 'user').map((m) => m.content)));
    check('連打: 時刻が二重適用されない', hhmm(d.chat.state.time) === '18:10', hhmm(d.chat.state.time));
  }

  // 分岐中に別端末からメッセージが追加される
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'A' });
    const target = (await getChat(chat.id)).messages.slice(-1)[0];
    setQueue([{ text: reply({ char: '「2」', elapsed: 10, location: w.cafe }), gapMs: 10 }]);
    const [forkRes, genRes] = await Promise.all([
      api('POST', `/chats/${chat.id}/fork`, { message_id: target.id }),
      generate(chat.id, { content: 'B（別端末）' }),
    ]);
    check('分岐中の追加: 分岐が成功', forkRes.status === 201, String(forkRes.status));
    check('分岐中の追加: 別端末の生成も成功', !!genRes.done, genRes.error ?? `http=${genRes.httpStatus}`);
    const fd = await getChat(forkRes.json.id);
    check('分岐中の追加: 分岐先に後発メッセージが混入しない',
      fd.messages.length === target.seq && !fd.messages.some((m) => m.content.includes('別端末')),
      `${fd.messages.length}件 / 対象seq=${target.seq}`);
    check('分岐中の追加: 分岐先ステートが対象の state_after と一致',
      JSON.stringify(fd.chat.state) === JSON.stringify(target.state_after));
  }

  // 候補 index の重複
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「v0」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const mid = (await getChat(chat.id)).messages.slice(-1)[0].id;
    setQueue([1, 2, 3].map((n) => ({ text: reply({ char: `「v${n}」`, elapsed: 10 + n, location: w.shop }) })));
    await Promise.all([
      generate(chat.id, { regenerate: true }),
      generate(chat.id, { regenerate: true }),
      generate(chat.id, { regenerate: true }),
    ]);
    for (const n of [4, 5]) {
      setQueue([{ text: reply({ char: `「v${n}」`, elapsed: 10 + n, location: w.shop }) }]);
      await generate(chat.id, { regenerate: true });
    }
    const idx = (await api('GET', `/messages/${mid}/variants`)).json.map((v) => v.index);
    check('候補index: 重複しない', new Set(idx).size === idx.length, JSON.stringify(idx));
    check('候補index: 0から連番', JSON.stringify(idx) === JSON.stringify(idx.map((_, i) => i)), JSON.stringify(idx));
    const m = (await getChat(chat.id)).messages.find((x) => x.id === mid);
    check('候補index: active_variant が実在する', idx.includes(m.active_variant),
      `active=${m.active_variant} / ${JSON.stringify(idx)}`);
  }

  // 過去メッセージの削除とステート復元
  {
    const { chat } = await newChat(w);
    for (const [i, mins] of [20, 30, 40].entries()) {
      setQueue([{ text: reply({ char: `「${i}」`, elapsed: mins, location: i === 1 ? w.cafe : w.shop }) }]);
      await generate(chat.id, { content: `t${i}` });
    }
    let d = await getChat(chat.id);
    const prevState = d.messages[d.messages.length - 2].state_after;
    await api('DELETE', `/messages/${d.messages[d.messages.length - 1].id}`);
    d = await getChat(chat.id);
    check('削除: 末尾削除で直前の state_after に戻る',
      JSON.stringify(d.chat.state) === JSON.stringify(prevState), hhmm(d.chat.state.time));

    const expected = d.messages[d.messages.length - 1].state_after;
    await api('DELETE', `/messages/${d.messages[2].id}`);
    d = await getChat(chat.id);
    check('削除: 中間削除後は末尾の state_after が現在ステート',
      JSON.stringify(d.chat.state) === JSON.stringify(expected), hhmm(d.chat.state.time));
    note(`seq に欠番が出る（順序のみに使うため無害）: ${JSON.stringify(d.messages.map((m) => m.seq))}`);

    for (const m of [...d.messages]) await api('DELETE', `/messages/${m.id}`);
    d = await getChat(chat.id);
    check('削除: 全削除で初期ステートに戻る',
      hhmm(d.chat.state.time) === '18:00' && d.messages.length === 0,
      `${hhmm(d.chat.state.time)} / ${d.messages.length}件`);
    setQueue([{ text: reply({ char: '「再開」', elapsed: 10, location: w.shop }) }]);
    check('削除: 全削除後も生成できる', !!(await generate(chat.id, { content: '再開' })).done);
    check('削除: seq が 1 から振り直される',
      JSON.stringify((await getChat(chat.id)).messages.map((m) => m.seq)) === '[1,2]');
  }

  // 過去メッセージへの確定操作は拒否される
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'A' });
    const past = (await getChat(chat.id)).messages.slice(-1)[0];
    setQueue([{ text: reply({ char: '「2」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'B' });
    check('拒否: 過去メッセージの候補切替は 409',
      (await api('PUT', `/messages/${past.id}/variant`, { index: 0 })).status === 409);
    check('拒否: 末尾が assistant のときの retry は 400',
      (await generate(chat.id, { retry: true })).httpStatus === 400);
    check('拒否: 複数モードの同時指定は 400',
      (await api('POST', `/chats/${chat.id}/messages`, { content: 'x', regenerate: true })).status === 400);
  }
}

// ===========================================================================
export async function edges(w) {
  suite('境界');

  // メッセージ0件のチャット
  {
    const { chat } = await newChat(w, { opening: '' });
    check('冒頭なし: メッセージ0件', (await getChat(chat.id)).messages.length === 0);
    setQueue([{ text: reply({ char: '「はじめまして」', elapsed: 20, location: w.shop }) }]);
    check('冒頭なし: 生成できる', !!(await generate(chat.id, { content: 'こんばんは' })).done);
    const d = await getChat(chat.id);
    check('冒頭なし: 18:20 / seq が 1,2',
      hhmm(d.chat.state.time) === '18:20' && JSON.stringify(d.messages.map((m) => m.seq)) === '[1,2]',
      `${hhmm(d.chat.state.time)} / ${JSON.stringify(d.messages.map((m) => m.seq))}`);
  }

  // elapsed_minutes の異常値
  {
    const { chat: c1 } = await newChat(w);
    setQueue([{ text: reply({ char: '「マイナス」', elapsed: -50, location: w.shop }) }]);
    await generate(c1.id, { content: 't' });
    check('elapsed: 負値は0として扱う', hhmm((await getChat(c1.id)).chat.state.time) === '18:00');

    const { chat: c2 } = await newChat(w);
    setQueue([{ text: reply({ char: '「24時間超」', elapsed: 2000, location: w.shop }) }]);
    const g = await generate(c2.id, { content: 't' });
    const d = await getChat(c2.id);
    check('elapsed: 24時間超はそのまま適用', d.messages.slice(-1)[0].state_after.time - T1800 === 2000);
    check('elapsed: 24時間超で警告が返る',
      (g.done?.warnings ?? []).some((x) => x.includes('elapsed_minutes')), JSON.stringify(g.done?.warnings));

    const { chat: c3 } = await newChat(w);
    setQueue([{ text: 'アシュリー: 「数値でない」\n\n@@@STATE\nelapsed_minutes: たくさん\n@@@END' }]);
    await generate(c3.id, { content: 't' });
    check('elapsed: 数値でなければ既定10分', hhmm((await getChat(c3.id)).chat.state.time) === '18:10');
  }

  // 分岐の異常入力
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'A' });
    const d = await getChat(chat.id);
    const mid = d.messages.slice(-1)[0].id;
    check('分岐: 存在しない variant_index は 404',
      (await api('POST', `/chats/${chat.id}/fork`, { message_id: mid, variant_index: 99 })).status === 404);
    check('分岐: 存在しない message_id は 404',
      (await api('POST', `/chats/${chat.id}/fork`, { message_id: 'NOPE' })).status === 404);
    check('分岐: message_id 未指定は 404',
      (await api('POST', `/chats/${chat.id}/fork`, {})).status === 404);
    const other = await newChat(w);
    check('分岐: 別チャットの message_id は 404',
      (await api('POST', `/chats/${chat.id}/fork`,
        { message_id: (await getChat(other.chat.id)).messages[0].id })).status === 404);

    // user メッセージからの分岐 → 末尾が user なので retry できる
    const userMsg = d.messages.find((m) => m.role === 'user');
    const fork = await api('POST', `/chats/${chat.id}/fork`, { message_id: userMsg.id });
    check('分岐: user メッセージからも分岐できる', fork.status === 201, String(fork.status));
    const fd = await getChat(fork.json.id);
    check('分岐: 分岐先ステートがその user の state_after',
      JSON.stringify(fd.chat.state) === JSON.stringify(userMsg.state_after));
    setQueue([{ text: reply({ char: '「分岐後の応答」', elapsed: 15, location: w.shop }) }]);
    check('分岐: 分岐先で retry できる', !!(await generate(fork.json.id, { retry: true })).done);
    check('分岐: retry 後は 18:15（分岐時点が基準）',
      hhmm((await getChat(fork.json.id)).chat.state.time) === '18:15');
  }

  // 手動編集と候補切替の相互作用
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「v0」', elapsed: 20, location: w.shop }) }]);
    await generate(chat.id, { content: 'A' });
    setQueue([{ text: reply({ char: '「v1」', elapsed: 30, location: w.cafe }) }]);
    await generate(chat.id, { regenerate: true });
    const mid = (await getChat(chat.id)).messages.slice(-1)[0].id;
    await api('PUT', `/chats/${chat.id}/state`, { weather: '雨' });
    let d = await getChat(chat.id);
    check('手動編集: 反映され、末尾の state_after にも入る',
      d.chat.state.weather === '雨' && d.messages.slice(-1)[0].state_after.weather === '雨');
    await api('PUT', `/messages/${mid}/variant`, { index: 0 });
    d = await getChat(chat.id);
    check('手動編集: 候補切替でその候補の state_after になる（仕様どおり上書き）',
      hhmm(d.chat.state.time) === '18:20' && d.chat.state.location === w.shop,
      `${hhmm(d.chat.state.time)} / ${d.chat.state.location} / ${d.chat.state.weather}`);
  }

  // 日付をまたぐ
  {
    const { chat } = await newChat(w, { time: 877 * 1440 + 23 * 60 + 30, opening: 'ナレーター: 深夜。' });
    setQueue([{ text: reply({ char: '「日付をまたぎます」', elapsed: 60, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    check('日跨ぎ: 00:30 になり日が進む', hhmm(d.chat.state.time) === '00:30' && d.gameTime.day === 11,
      `${hhmm(d.chat.state.time)} / day=${d.gameTime.day}`);
    check('日跨ぎ: 天候が設定される', !!d.chat.state.weather, d.chat.state.weather);
    const pv = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    check('日跨ぎ: 次ターンの状況ブロックに日付変更の一文が入る',
      pv.situationBlock.includes('日付が変わり'));
  }
}

// ===========================================================================
/** 一覧の抜粋（GET /chats の preview） */
export async function chatListPreview(w) {
  suite('一覧の抜粋');

  const previewOf = async (chatId) => {
    const list = (await api('GET', '/chats?archived=0')).json;
    return list.find((c) => c.id === chatId)?.preview;
  };

  // 冒頭のナレーター行が、話者ラベルを落として出る
  {
    const { chat } = await newChat(w, { opening: 'ナレーター: 雨が窓を叩いている。' });
    check('冒頭から抜粋が作られる', (await previewOf(chat.id)) === '雨が窓を叩いている。',
      await previewOf(chat.id));
  }

  // 最新メッセージが自分の入力ならそれが出る
  {
    const { chat } = await newChat(w);
    setQueue([{ text: reply({ char: '「おかえり」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'ただいま' });
    check('AI応答が最新なら応答から抜粋する', (await previewOf(chat.id)) === 'おかえり',
      await previewOf(chat.id));
  }

  // 鉤括弧・強調記号を落とし、複数行を1行に畳む
  {
    const { chat } = await newChat(w, { opening: '' });
    setQueue([{
      text: 'アシュリー: 「おかえり」\nナレーター: *本を閉じて*顔を上げた。\n\n@@@STATE\nelapsed_minutes: 10\n@@@END',
    }]);
    await generate(chat.id, { content: 't' });
    check('鉤括弧と強調記号を落として1行に畳む',
      (await previewOf(chat.id)) === 'おかえり 本を閉じて顔を上げた。', await previewOf(chat.id));
  }

  // 「18:30」のような行頭は話者ラベルとして切らない
  {
    const { chat } = await newChat(w, { opening: '' });
    setQueue([{ text: reply({ char: '「またね」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: '18:30に駅で' });
    const d = await getChat(chat.id);
    await api('DELETE', `/messages/${d.messages.slice(-1)[0].id}`);
    check('数字だけの行頭は話者ラベルとして切らない',
      (await previewOf(chat.id)) === '18:30に駅で', await previewOf(chat.id));
  }

  // 長文は切り詰める
  {
    const { chat } = await newChat(w, { opening: '' });
    const longLine = 'あ'.repeat(200);
    setQueue([{ text: `ナレーター: ${longLine}\n\n@@@STATE\nelapsed_minutes: 10\n@@@END` }]);
    await generate(chat.id, { content: 't' });
    const p = await previewOf(chat.id);
    check('長文は80文字＋省略記号に切り詰める', p.length === 81 && p.endsWith('…'), `${p.length}文字`);
  }

  // メッセージが1件も無ければ空
  {
    const { chat } = await newChat(w, { opening: '' });
    check('メッセージが無ければ空文字', (await previewOf(chat.id)) === '', await previewOf(chat.id));
  }

  // アーカイブしたチャットは通常の一覧から外れる
  {
    const { chat } = await newChat(w);
    await api('PUT', `/chats/${chat.id}`, { archived: 1 });
    check('アーカイブすると通常の一覧から外れる', (await previewOf(chat.id)) === undefined);
    const arch = (await api('GET', '/chats?archived=1')).json;
    check('アーカイブ一覧には出る', arch.some((c) => c.id === chat.id));
  }
}

// ===========================================================================
/** 世界ごとのエリア（PUT /worlds/:id/areas） */
export async function areasSuite() {
  suite('エリア');

  const world = (await api('POST', '/worlds', { name: 'area-test' })).json;
  const areasOf = async () => (await api('GET', `/worlds/${world.id}`)).json.areas;

  {
    const defaults = await areasOf();
    check('新しい世界には既定のエリアが8件入る', defaults.length === 8,
      defaults.map((a) => a.id).join(','));
    check('既定に予備の3件が含まれる',
      ['market', 'residential', 'underground'].every((id) => defaults.some((a) => a.id === id)),
      defaults.map((a) => a.id).join(','));
    check('既定の表示名は日本語', defaults[0].name === '丘の上', defaults[0].name);
  }

  // 表示名の変更は自由
  {
    const areas = await areasOf();
    areas[0] = { ...areas[0], name: '城下の丘' };
    const r = await api('PUT', `/worlds/${world.id}/areas`, { areas });
    check('表示名を変えられる', r.status === 200 && r.json.areas[0].name === '城下の丘',
      JSON.stringify(r.json?.areas?.[0]));
    check('IDは変わらない', r.json.areas[0].id === 'hilltop', r.json?.areas?.[0]?.id);
  }

  // 並べ替え
  {
    const areas = await areasOf();
    const swapped = [areas[1], areas[0], ...areas.slice(2)];
    const r = await api('PUT', `/worlds/${world.id}/areas`, { areas: swapped });
    check('並べ替えられる', r.json.areas[0].id === 'center', r.json?.areas?.[0]?.id);
  }

  // 追加
  {
    const areas = await areasOf();
    const r = await api('PUT', `/worlds/${world.id}/areas`, {
      areas: [...areas, { id: 'temple', name: '聖域' }],
    });
    check('エリアを追加できる', r.json.areas.some((a) => a.id === 'temple'));
  }

  // 不正なID・重複
  {
    const areas = await areasOf();
    const bad = await api('PUT', `/worlds/${world.id}/areas`, {
      areas: [...areas, { id: '聖域', name: '聖域' }],
    });
    check('日本語のIDは拒否する', bad.status === 400, `${bad.status} ${bad.json?.error ?? ''}`);
    const dup = await api('PUT', `/worlds/${world.id}/areas`, {
      areas: [...areas, { id: areas[0].id, name: 'かぶり' }],
    });
    check('IDの重複は拒否する', dup.status === 400, `${dup.status} ${dup.json?.error ?? ''}`);
    check('拒否したときは元のまま', (await areasOf()).length === areas.length);
  }

  // 使用中のエリアは消せない
  {
    await api('POST', `/worlds/${world.id}/locations`, {
      id: 'area_test_dock', name: '桟橋', indoor: 0, area: 'harbor',
    });
    const areas = await areasOf();
    const r = await api('PUT', `/worlds/${world.id}/areas`, {
      areas: areas.filter((a) => a.id !== 'harbor'),
    });
    check('使用中のエリアは削除できない', r.status === 400, `${r.status} ${r.json?.error ?? ''}`);
    check('どの場所が使っているか知らせる', (r.json?.error ?? '').includes('桟橋'), r.json?.error);
    check('未使用のエリアは削除できる',
      (await api('PUT', `/worlds/${world.id}/areas`, {
        areas: areas.filter((a) => a.id !== 'underground'),
      })).status === 200);
  }

  // 汎用PUTからは変更できない（参照整合の確認を迂回させない）
  {
    const before = await areasOf();
    await api('PUT', `/worlds/${world.id}`, { name: 'area-test2', areas: [] });
    check('PUT /worlds/:id ではエリアを変えられない', (await areasOf()).length === before.length,
      `${before.length} → ${(await areasOf()).length}`);
  }

  // 書き出し → 取り込みでエリアが引き継がれる
  {
    const dump = (await api('GET', `/worlds/${world.id}/export`)).json;
    const r = await api('POST', '/worlds/import', dump);
    const copied = (await api('GET', `/worlds/${r.json.world.id}`)).json.areas;
    check('取り込み先にエリアが引き継がれる', copied.some((a) => a.name === '城下の丘'),
      JSON.stringify(copied.map((a) => a.name)));
  }

  // areas を持たない古い書き出しでも、使われているエリアは選べる
  {
    const dump = (await api('GET', `/worlds/${world.id}/export`)).json;
    delete dump.world.areas;
    dump.locations = [{ id: 'legacy_zone_loc', name: '旧区画', indoor: 0, area: 'legacy_zone' }];
    const r = await api('POST', '/worlds/import', dump);
    const copied = (await api('GET', `/worlds/${r.json.world.id}`)).json.areas;
    check('古い書き出しでも使用中のエリアが補われる',
      copied.some((a) => a.id === 'legacy_zone'), JSON.stringify(copied.map((a) => a.id)));
  }
}

// ===========================================================================
/** 終電行（呼び方の差し替え・オンオフ） */
export async function lastTrainSuite(w) {
  suite('終電行');

  const setCal = (patch) => api('PUT', `/worlds/${w.world.id}/calendar`, patch);
  const cal = (await api('GET', `/worlds/${w.world.id}/calendar`)).json;

  // 22:30（既定は終電23:00・通知60分前）で通知窓に入る
  const at2230 = async () => {
    const { chat } = await newChat(w, { time: 877 * 1440 + 22 * 60 + 30 });
    return (await api('GET', `/chats/${chat.id}/prompt-preview`)).json.situationBlock;
  };
  const at2330 = async () => {
    const { chat } = await newChat(w, { time: 877 * 1440 + 23 * 60 + 30 });
    return (await api('GET', `/chats/${chat.id}/prompt-preview`)).json.situationBlock;
  };

  check('既定では「終電まで残り◯分」が出る', (await at2230()).includes('終電まで残り30分'),
    (await at2230()).split('\n').find((l) => l.includes('残り')) ?? '（無し）');
  check('既定では終電後の文が出る', (await at2330()).includes(cal.after_last_train_text));

  // 呼び方を差し替える
  {
    await setCal({ ...cal, last_train_label: '最終転移' });
    const s = await at2230();
    check('呼び方を差し替えられる', s.includes('最終転移まで残り30分'),
      s.split('\n').find((l) => l.includes('残り')) ?? '（無し）');
    check('差し替えたら「終電」の語は出ない', !s.includes('終電まで'));
  }

  // 空文字なら既定の呼び方へ戻す
  {
    await setCal({ ...cal, last_train_label: '' });
    check('呼び方が空なら「終電」に戻す', (await at2230()).includes('終電まで残り30分'));
  }

  // オフにすると通知も終電後の文も出ない
  {
    await setCal({ ...cal, last_train_enabled: 0 });
    const before = await at2230();
    const after = await at2330();
    check('オフ: 通知窓でも行が出ない', !before.includes('残り'),
      before.split('\n').find((l) => l.includes('残り')) ?? '（無し）');
    check('オフ: 終電後の文も出ない', !after.includes(cal.after_last_train_text));
  }

  // 保存は差分更新。触れなかったキーは保存済みの値が残る
  {
    await setCal({ last_train_label: '最終バス' });
    const saved = (await api('GET', `/worlds/${w.world.id}/calendar`)).json;
    check('指定したキーだけ変わる', saved.last_train_label === '最終バス', saved.last_train_label);
    check('触れていないキーは保存済みの値が残る', saved.last_train_enabled === 0,
      String(saved.last_train_enabled));
  }

  await setCal(cal);
  check('元の設定へ戻せる', (await at2230()).includes('終電まで残り30分'));
}

// ===========================================================================
// 生成ロックの範囲（LLM終了時ではなく、ステート確定まで保持する）
// ===========================================================================
export async function generationLockSuite(w) {
  suite('生成ロックの範囲');

  const base = (await api('GET', '/settings')).json;
  // 本文生成のあとに別コールを挟むモードにして、
  // 「ストリーム終了 → DB後処理」の隙間を観測できる幅にする
  await api('PUT', '/settings', { state_extraction_mode: 'separate_call', auto_summarize: 0, auto_extract: 0 });

  const { chat } = await newChat(w);
  setQueue([
    { text: 'アシュリー: 「1ターン目」' },
    // ステート抽出の別コール。ここで待たせているあいだに次の生成を投げる
    { text: '@@@STATE\nelapsed_minutes: 10\n@@@END', gapMs: 900 },
    { text: 'アシュリー: 「2ターン目」' },
    { text: '@@@STATE\nelapsed_minutes: 10\n@@@END' },
  ]);

  const first = generate(chat.id, { content: '1通目' });
  await new Promise((r) => setTimeout(r, 450)); // ストリームは終わり、後処理の途中
  const second = await generate(chat.id, { content: '2通目' });
  check('後処理中に来た生成は弾く', second.httpStatus === 409,
    `status=${second.httpStatus} ${second.error ?? ''}`);
  await first;

  const d = await getChat(chat.id);
  const roles = d.messages.map((m) => m.role).join(',');
  check('メッセージの並びが崩れない', roles === 'assistant,user,assistant', roles);

  // ロックは後処理の完了後に外れる（次のターンは普通に通る）
  setQueue([
    { text: 'アシュリー: 「3ターン目」' },
    { text: '@@@STATE\nelapsed_minutes: 10\n@@@END' },
  ]);
  const third = await generate(chat.id, { content: '3通目' });
  check('後処理が終われば次の生成は通る', third.httpStatus === 200 && !!third.done,
    `status=${third.httpStatus} ${third.error ?? ''}`);

  await api('PUT', '/settings', base);
}

// ===========================================================================
// 世界の取り込みは1トランザクション（途中で失敗しても半端に残さない）
// ===========================================================================
export async function importRollbackSuite() {
  suite('取り込みのロールバック');

  const before = (await api('GET', '/worlds')).json.length;
  const locId = 'rollback_test_loc';

  // 世界・キャラ・場所までは作れるが、シナリオで壊れるデータ
  const broken = {
    format: 'character_chat_world',
    version: 1,
    world: { name: '壊れた取り込み', description: '' },
    characters: [{ id: 'c1', name: '取り込みキャラ' }],
    locations: [{ id: locId, name: '取り込み場所', indoor: 1, area: 'center' }],
    lorebook: [{ title: '取り込みロア', keys: ['x'], content: 'y' }],
    // participant_ids が配列でない → シナリオ作成の手前で落ちる
    scenarios: [{ title: '壊れたシナリオ', participant_ids: 'not-an-array' }],
  };
  const r = await api('POST', '/worlds/import', broken);
  check('壊れたデータの取り込みは失敗する', r.status === 400, `status=${r.status}`);
  check('取り消したことを伝える', (r.json?.error ?? '').includes('取り消されました'), r.json?.error);

  const worlds = (await api('GET', '/worlds')).json;
  check('世界が残らない', worlds.length === before && !worlds.some((w) => w.name === '壊れた取り込み'),
    `${before} → ${worlds.length}`);

  // 場所IDはグローバル一意なので、巻き戻っていれば同じIDをそのまま取り込める
  const fixed = { ...broken, world: { name: '直した取り込み' }, scenarios: [] };
  const ok = await api('POST', '/worlds/import', fixed);
  check('直せば取り込める', ok.status === 201, `status=${ok.status} ${ok.json?.error ?? ''}`);
  const locs = (await api('GET', `/worlds/${ok.json.world.id}/locations`)).json;
  check('場所IDが取られたままにならない', locs.some((l) => l.id === locId),
    locs.map((l) => l.id).join(','));
  const chars = (await api('GET', `/worlds/${ok.json.world.id}/characters`)).json;
  check('キャラも二重に残っていない', chars.length === 1, `${chars.length}件`);

  await api('DELETE', `/worlds/${ok.json.world.id}`);
}

// ===========================================================================
// 経過時間の読み取り（数字だけ拾って別の分数に化けさせない）
// ===========================================================================
export async function durationSuite(w) {
  suite('経過時間の読み取り');

  // パーサそのもの
  {
    const { parseDurationMinutes, parseStateDelta } = await import('../dist/server/src/llm/parse.js');
    const cases = [
      ['10', 10], ['90', 90], ['0', 0], ['-5', -5],
      ['１０', 10], // 全角
      ['90分', 90], ['30m', 30], ['45 min', 45],
      ['2時間', 120], ['2h', 120],
      ['1時間30分', 90], ['1h30m', 90],
      ['よくわからない', null], ['約10分ほど', null], ['', null], ['1.5時間', null],
    ];
    const wrong = cases.filter(([input, want]) => parseDurationMinutes(input) !== want);
    check('経過時間を正しく読む', wrong.length === 0,
      wrong.map(([i, want]) => `"${i}" → ${parseDurationMinutes(i)}（期待 ${want}）`).join(' / '));
    check('「1時間30分」を130分にしない', parseDurationMinutes('1時間30分') === 90,
      String(parseDurationMinutes('1時間30分')));

    const bad = parseStateDelta('elapsed_minutes: よくわからない');
    check('読めない値は既定値のまま', bad.elapsed_minutes === 10, String(bad.elapsed_minutes));
    check('読めなかった生の値を持ち帰る', bad.elapsed_unparsed === 'よくわからない', bad.elapsed_unparsed);
  }

  // 実際の生成に効く
  {
    const { chat } = await newChat(w);
    setQueue([{ text: 'アシュリー: 「休憩する」\n\n@@@STATE\nelapsed_minutes: 1時間30分\n@@@END' }]);
    await generate(chat.id, { content: 't' });
    check('「1時間30分」で90分進む', hhmm((await getChat(chat.id)).chat.state.time) === '19:30',
      hhmm((await getChat(chat.id)).chat.state.time));
  }

  // 読めない値は既定値で進めたことを警告する（黙って進めない）
  {
    const { chat } = await newChat(w);
    setQueue([{ text: 'アシュリー: 「しばらく」\n\n@@@STATE\nelapsed_minutes: しばらく\n@@@END' }]);
    const g = await generate(chat.id, { content: 't' });
    check('読めない値でも時間は既定の10分だけ進む',
      hhmm((await getChat(chat.id)).chat.state.time) === '18:10',
      hhmm((await getChat(chat.id)).chat.state.time));
    check('読めなかったことを警告で返す',
      (g.done?.warnings ?? []).some((x) => x.includes('読み取れませんでした')),
      JSON.stringify(g.done?.warnings));
  }
}

// ===========================================================================
// 話者名が衝突したときの解決順（§5.2）
// ===========================================================================
export async function speakerCollisionSuite(w) {
  suite('話者名の衝突');

  /** ペルソナ名を指定したチャットを作る */
  const chatWithPersona = async (personaName, participantIds = [w.ashley.id]) => {
    const persona = (await api('POST', '/personas', { name: personaName, description: 'わたし' })).json;
    const scenario = (
      await api('POST', `/worlds/${w.world.id}/scenarios`, {
        title: `collision_${personaName}`,
        participant_ids: participantIds,
        opening: 'ナレーター: 開始。',
        initial_state: { time: T1800, location: w.shop, weather: '晴', present: participantIds },
      })
    ).json;
    return (await api('POST', `/scenarios/${scenario.id}/chats`, { persona_id: persona.id })).json;
  };

  // 参加キャラ名 = ペルソナ名。
  // resolveSpeaker の「参加キャラ最優先」より手前で sanitizeResponse が切るので、
  // そのラベルの行は人物としては解決されない。本文が空になり原因が伝わることを見る
  {
    const chat = await chatWithPersona('アシュリー');
    setQueue([{ text: 'アシュリー: 「代弁とみなされる」\n\n@@@STATE\nelapsed_minutes: 10\n@@@END' }]);
    const g = await generate(chat.id, { content: 't' });
    const msgs = (await getChat(chat.id)).messages;
    check('参加キャラ名と同名なら、その行はサニタイズで落ちる',
      msgs.slice(-1)[0].role === 'user', msgs.slice(-2).map((m) => m.role).join(','));
    check('全部落ちたら「空でした」で終わらせず理由を添える',
      (g.error ?? '').includes('名前（または別名）と同じ'), g.error ?? '（エラーなし）');
    check('ゲーム内時間も進めない', hhmm((await getChat(chat.id)).chat.state.time) === '18:00',
      hhmm((await getChat(chat.id)).chat.state.time));
  }

  // ペルソナ名 = ナレーター → 地の文が消えるので、設定の問題として知らせる
  {
    const chat = await chatWithPersona('ナレーター');
    setQueue([{ text: 'ナレーター: 雨が降っている。\nアシュリー: 「本文」\n\n@@@STATE\nelapsed_minutes: 10\n@@@END' }]);
    const g = await generate(chat.id, { content: 't' });
    check('ペルソナ名がナレーターなら理由が分かる',
      (g.error ?? '').includes('「ナレーター」と同じ'), g.error ?? '（エラーなし）');
    check('地の文が消えることも説明に入る', (g.error ?? '').includes('削除'), g.error);
  }

  // 衝突していなければ警告は出ない
  {
    const chat = await chatWithPersona('ミナト');
    setQueue([{ text: reply({ char: '「ふつう」', elapsed: 10, location: w.shop }) }]);
    const g = await generate(chat.id, { content: 't' });
    check('衝突が無ければ余計な警告は出さない',
      !(g.done?.warnings ?? []).some((x) => x.includes('ペルソナ名')),
      JSON.stringify(g.done?.warnings));
  }

  // ペルソナ名は準レギュラーより先に見る（解決順の2位 vs 4位）
  {
    const npc = (await api('POST', `/worlds/${w.world.id}/characters`, {
      name: 'カゲロウ', is_npc_pool: 1,
    })).json;
    const chat = await chatWithPersona('カゲロウ');
    setQueue([{ text: 'アシュリー: 「先に喋る」\nカゲロウ: 「代弁される」\n\n@@@STATE\nelapsed_minutes: 10\n@@@END' }]);
    const g = await generate(chat.id, { content: 't' });
    const last = (await getChat(chat.id)).messages.slice(-1)[0];
    check('準レギュラーと同名でもペルソナ名を先に見る（代弁として切り詰める）',
      !last.content.includes('代弁される'), last.content.replace(/\n/g, ' / '));
    check('代弁として警告する',
      (g.done?.warnings ?? []).some((x) => x.includes('代弁')), JSON.stringify(g.done?.warnings));
    await api('DELETE', `/characters/${npc.id}`);
  }
}

// ===========================================================================
// JSONボディの上限（未認証のリクエストに大きなボディをパースさせない）
// ===========================================================================
export async function bodyLimitSuite(w) {
  suite('JSONボディの上限');

  // 通常APIは小さい上限。1MB は通らない
  {
    const big = 'あ'.repeat(400_000); // UTF-8で約1.2MB
    const r = await api('PUT', `/worlds/${w.world.id}`, { name: 'x', system_prompt: big });
    check('通常APIで1MB超は拒否する', r.status === 413, `status=${r.status}`);
  }

  // 実運用で通したい大きさは通る（長いプロンプト・アバター付きの更新）
  {
    const prose = 'あ'.repeat(50_000); // 約150KB
    const r = await api('PUT', `/worlds/${w.world.id}`, { system_prompt: prose });
    check('150KB程度のプロンプトは通る', r.status === 200, `status=${r.status}`);
    await api('PUT', `/worlds/${w.world.id}`, { system_prompt: '' });

    // 320px WebP のアバターは実測2〜3KB。余裕を見て30KB相当で試す
    const avatar = `data:image/webp;base64,${'A'.repeat(40_000)}`;
    const c = await api('POST', `/worlds/${w.world.id}/characters`, { name: 'アバター付き', avatar });
    check('アバター付きのキャラクター作成は通る', c.status === 201, `status=${c.status}`);
    if (c.status === 201) {
      const up = await api('PUT', `/characters/${c.json.id}`, { ...c.json, avatar });
      check('アバター付きの更新も通る', up.status === 200, `status=${up.status}`);
      await api('DELETE', `/characters/${c.json.id}`);
    }
  }

  // 取り込みルートだけは大きいボディを許す
  {
    const filler = 'あ'.repeat(400_000);
    const r = await api('POST', '/worlds/import', {
      format: 'character_chat_world',
      world: { name: '大きな取り込み', description: filler },
      scenarios: [],
    });
    check('取り込みは1MB超でも通る', r.status === 201, `status=${r.status} ${r.json?.error ?? ''}`);
    if (r.status === 201) await api('DELETE', `/worlds/${r.json.world.id}`);
  }

  // ログインは認証前に body を読むが、上限は小さい
  {
    const r = await api('POST', '/login', { password: 'あ'.repeat(400_000) });
    check('ログインでも1MB超は拒否する', r.status === 413, `status=${r.status}`);
    // 通常のログインは（パスワード未設定なので素通りだが）読めている
    const ok = await api('POST', '/login', { password: 'x' });
    check('通常サイズのログインbodyは読める', ok.status !== 413, `status=${ok.status}`);
  }
}

// ===========================================================================
// 生成ロックの取得タイミング（受付直後〜組み立ての間にも入れさせない）
// ===========================================================================
// 前提: サーバを再起動した直後に呼ぶこと。
// モデル一覧はプロセス内に1時間キャッシュされるので、温まっていると
// 組み立て中に待ちが発生せず、この race を再現できない。
export async function acceptLockSuite(w) {
  suite('生成ロックの取得タイミング');

  const { chat } = await newChat(w);
  await clearMockRequests();
  // 組み立て（モデル一覧の取得）で待たせ、2本目が割り込める幅を作る
  await setModelsDelay(700);
  setQueue([
    { text: reply({ char: '「1本目」', elapsed: 10, location: w.shop }) },
    { text: reply({ char: '「2本目」', elapsed: 10, location: w.shop }) },
  ]);

  // ほぼ同時に2本投げる
  const [a, b] = await Promise.all([
    generate(chat.id, { content: 'A' }),
    (async () => {
      await new Promise((r) => setTimeout(r, 60)); // 受付直後〜組み立て中に重ねる
      return generate(chat.id, { content: 'B' });
    })(),
  ]);
  await setModelsDelay(0);

  const statuses = [a.httpStatus, b.httpStatus].sort().join(',');
  check('片方だけが通る', statuses === '200,409', statuses);

  const d = await getChat(chat.id);
  const roles = d.messages.map((m) => m.role).join(',');
  check('user が二重に保存されない', roles === 'assistant,user,assistant', roles);
  check('userメッセージは1件だけ', d.messages.filter((m) => m.role === 'user').length === 1, roles);

  // 生成そのものも1回しか走っていない（＝AbortControllerが二重に作られていない）
  const streams = (await mockRequests()).filter((r) => r.stream).length;
  check('LLMの生成は1回だけ', streams === 1, `${streams}回`);

  // ロックは正しく外れている
  setQueue([{ text: reply({ char: '「3本目」', elapsed: 10, location: w.shop }) }]);
  const next = await generate(chat.id, { content: 'C' });
  check('そのあとの生成は通る', next.httpStatus === 200 && !!next.done,
    `status=${next.httpStatus} ${next.error ?? ''}`);
}
