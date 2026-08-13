// v1.5.3: 進行フラグ（state.vars）と条件付きイベント
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
  setQueue,
  suite,
} from './harness.mjs';

const T1800 = 877 * 1440 + 18 * 60;

/** 進行フラグ付きの世界を用意する */
export async function setupEventWorld(label) {
  const world = (await api('POST', '/worlds', {
    name: label,
    vars_schema: [
      {
        key: 'case_phase',
        type: 'number',
        role: 'phase',
        default: 0,
        label: '事件の進行段階',
        min: 0,
        max: 3,
        monotonic: true,
        update_mode: 'system_only',
        phases: [
          { value: 0, name: '未発生', public_state: 'まだ表面化していない。', private_note: '秘密のメモ' },
          { value: 1, name: '違和感', public_state: '不自然な情報が出始めている。' },
          { value: 2, name: '調査開始', public_state: '調査している。' },
          { value: 3, name: '決着', public_state: '最終局面。' },
        ],
      },
      { key: 'toby_met', type: 'boolean', default: false, label: 'トビーと接触済み' },
      { key: 'trust', type: 'number', default: 0, label: '信頼度', min: 0, max: 10 },
    ],
  })).json;
  const p = `${label}_`;
  await api('POST', `/worlds/${world.id}/locations`, { id: `${p}shop`, name: '本屋', indoor: 1, area: 'center' });
  await api('POST', `/worlds/${world.id}/locations`, { id: `${p}harbor`, name: '港', indoor: 0, area: 'harbor' });
  const ashley = (await api('POST', `/worlds/${world.id}/characters`, { name: 'アシュリー' })).json;
  return { world, ashley, shop: `${p}shop`, harbor: `${p}harbor` };
}

async function newChat(w, opts = {}) {
  const scenario = (
    await api('POST', `/worlds/${w.world.id}/scenarios`, {
      title: 'ev',
      participant_ids: [w.ashley.id],
      opening: 'ナレーター: 開始。',
      // イベント・進行フラグはこのシナリオで有効にする（全体設定の vars_enabled は既定0）
      events_enabled: opts.eventsEnabled ?? 1,
      vars_enabled: opts.varsEnabled ?? 1,
      initial_state: {
        time: opts.time ?? T1800,
        location: opts.location ?? w.shop,
        location_note: '',
        weather: opts.weather ?? '晴',
        present: [w.ashley.id],
        vars: opts.vars ?? {},
      },
    })
  ).json;
  const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
  return { scenario, chat };
}

const mkEvent = (worldId, body) => api('POST', `/worlds/${worldId}/events`, body);

/**
 * 世界のイベントを全部消す。
 * ブロックごとに作ったイベントが残ると 1ターンの採用上限（既定2件）に引っかかり、
 * そのブロックが見たいイベントが優先度で押し出されてしまう。
 */
async function resetEvents(w) {
  for (const e of (await api('GET', `/worlds/${w.world.id}/events`)).json ?? []) {
    await api('DELETE', `/events/${e.id}`);
  }
}

// ===========================================================================
export async function varsSuite(w) {
  suite('進行フラグ（state.vars）');

  // 初期値がスキーマから入る
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    const d = await getChat(chat.id);
    check('初期値がスキーマの default で入る',
      d.chat.state.vars?.case_phase === 0 && d.chat.state.vars?.toby_met === false,
      JSON.stringify(d.chat.state.vars));
  }

  // シナリオの initial_state.vars が優先される
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { vars: { case_phase: 1 } });
    const d = await getChat(chat.id);
    check('シナリオの初期値が default より優先される', d.chat.state.vars?.case_phase === 1,
      JSON.stringify(d.chat.state.vars));
  }

  // set_var のパースと適用
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    setQueue([{ text: 'アシュリー: 「進みます」\n\n@@@STATE\nelapsed_minutes: 10\nset_var: toby_met=true, trust=3\n@@@END' }]);
    await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    check('set_var が state.vars に入る',
      d.chat.state.vars?.toby_met === true && d.chat.state.vars?.trust === 3,
      JSON.stringify(d.chat.state.vars));
    check('set_var は state_after にも入る',
      d.messages.slice(-1)[0].state_after.vars?.toby_met === true);
  }

  // system_only のキーはモデルが書き込めない
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    setQueue([{ text: 'アシュリー: 「勝手に進める」\n\n@@@STATE\nelapsed_minutes: 10\nset_var: case_phase=3\n@@@END' }]);
    const g = await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    check('system_only のキーはモデルの指定を破棄する', d.chat.state.vars?.case_phase === 0,
      String(d.chat.state.vars?.case_phase));
    check('破棄したことを警告で返す',
      (g.done?.warnings ?? []).some((x) => x.includes('システム専用')), JSON.stringify(g.done?.warnings));
  }

  // スキーマ外のキー・型不一致・範囲外
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    setQueue([{ text: 'アシュリー: 「雑多」\n\n@@@STATE\nelapsed_minutes: 10\nset_var: unknown_key=1, trust=99, toby_met=maybe\n@@@END' }]);
    const g = await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    const v = d.chat.state.vars ?? {};
    check('スキーマ外のキーは書き込まれない', v.unknown_key === undefined, JSON.stringify(v));
    check('範囲外の数値は上限に丸められる', v.trust === 10, String(v.trust));
    check('型に合わない値は無視される', v.toby_met === false, String(v.toby_met));
    note(`警告: ${JSON.stringify(g.done?.warnings)}`);
  }

  // 進行状況ブロックがプロンプトに載り、private_note は載らない
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { vars: { case_phase: 2 } });
    const pv = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    check('進行状況ブロックが出る', pv.varsBlock.includes('事件の進行段階') && pv.varsBlock.includes('調査している'),
      pv.varsBlock.replace(/\n/g, ' / '));
    check('private_note はプロンプトに載らない',
      !pv.varsBlock.includes('秘密のメモ') && !pv.system.includes('秘密のメモ'));
    check('set_var の指示文が system に入る', pv.system.includes('進行状況の更新'));
    check('system_only のキーは指示文の例に出さない',
      !pv.system.includes('set_var: case_phase='), '');
  }

  // vars_enabled = 0 なら存在しないものとして扱う（§1.2）
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { varsEnabled: 0, vars: { case_phase: 2, toby_met: true } });
    const pv = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    check('無効時: 進行状況ブロックを出さない', !pv.varsBlock, pv.varsBlock);
    check('無効時: set_var の指示文も出さない', !pv.system.includes('進行状況の更新'));
    setQueue([{ text: 'アシュリー: 「無視される」\n\n@@@STATE\nelapsed_minutes: 10\nset_var: toby_met=false\n@@@END' }]);
    await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    check('無効時: set_var を適用しない（値は保持したまま）',
      d.chat.state.vars?.toby_met === true && d.chat.state.vars?.case_phase === 2,
      JSON.stringify(d.chat.state.vars));
  }

  // 手動編集
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await api('PUT', `/chats/${chat.id}/state`, { vars: { case_phase: 2, toby_met: true } });
    const d = await getChat(chat.id);
    check('手動編集では system_only のキーも変更できる（救済手段）',
      d.chat.state.vars?.case_phase === 2, JSON.stringify(d.chat.state.vars));
  }
}

// ===========================================================================
export async function eventsSuite(w) {
  suite('条件付きイベント');

  // 条件・注入・次ターン反映
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: '夜市', kind: 'ambient', inject_mode: 'fact', check: 'every_turn',
      trigger: 'repeat', chance: 1,
      when: { all: [{ weather: ['晴'] }, { time_after: '19:00' }] },
      inject: '中央広場に夜市が出ている。',
    });

    // 18:00 → 条件を満たさない
    setQueue([{ text: reply({ char: '「まだ夕方」', elapsed: 10, location: w.shop }) }]);
    let g = await generate(chat.id, { content: 't' });
    check('条件を満たさなければ発火しない', (g.done?.firedEvents ?? []).length === 0,
      JSON.stringify(g.done?.firedEvents));

    // 19:30 へ進める → 発火
    setQueue([{ text: reply({ char: '「夜になった」', elapsed: 80, location: w.shop }) }]);
    g = await generate(chat.id, { content: 't2' });
    check('条件を満たすと発火する', (g.done?.firedEvents ?? []).includes('夜市'),
      JSON.stringify(g.done?.firedEvents));

    // 注入は「次のターン」のプロンプトに載る（§6）
    const pv = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    check('注入は次ターンのプロンプトに載る', pv.situationBlock.includes('夜市が出ている'),
      pv.situationBlock.split('\n').slice(-3).join(' / '));
    check('fact は「発生中の出来事」に置かれる', pv.situationBlock.includes('# 発生中の出来事'));

    // プレビューだけでなく、実際に投げるプロンプトにも載っていること。
    // プレビューはユーザー発言を挟まずに組み立てるので、ここを見ないと差に気づけない
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「賑やかだ」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't3' });
    const sent = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('実際の生成でも次ターンに注入される', sent.includes('夜市が出ている'),
      sent.split('\n').find((l) => l.includes('発生中の出来事') || l.includes('夜市')) ?? '注入ブロックが無い');
  }

  // 注入は1ターンで消える（発火したターンの「次の1ターン」だけ）
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: '一度きりの知らせ', kind: 'ambient', inject_mode: 'fact', check: 'every_turn',
      trigger: 'once', chance: 1, when: {}, inject: '店に貼り紙が出ている。',
    });

    // 1ターン目で発火する
    setQueue([{ text: reply({ char: '「ん？」', elapsed: 10, location: w.shop }) }]);
    let g = await generate(chat.id, { content: 't1' });
    check('1ターン目で発火する', (g.done?.firedEvents ?? []).includes('一度きりの知らせ'),
      JSON.stringify(g.done?.firedEvents));

    // 2ターン目のプロンプトに載る
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「貼り紙か」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't2' });
    let sent = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('次の1ターンには載る', sent.includes('店に貼り紙が出ている'),
      sent.includes('貼り紙') ? '' : '注入されていない');

    // 3ターン目には載らない（注入は持ち越さない）
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「行こうか」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't3' });
    sent = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('その次のターンには載らない（1ターン限り）', !sent.includes('店に貼り紙が出ている'),
      sent.includes('貼り紙') ? '2ターン以上載っている' : '');
  }

  // repeat + 毎ターン なら条件が続く限り毎ターン載る
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: '雨脚', kind: 'ambient', inject_mode: 'fact', check: 'every_turn',
      trigger: 'repeat', chance: 1, when: { weather: ['晴'] }, inject: '外は明るい。',
    });

    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't1' });
    const seen = [];
    for (const t of ['t2', 't3', 't4']) {
      await clearMockRequests();
      setQueue([{ text: reply({ char: `「${t}」`, elapsed: 10, location: w.shop }) }]);
      await generate(chat.id, { content: t });
      seen.push((await mockRequests()).map((q) => q.prompt).join('\n').includes('外は明るい'));
    }
    check('repeat + 毎ターン は連続して載る', seen.every(Boolean), JSON.stringify(seen));
  }

  // on_enter は「条件を満たしたターン」ではなく、その次のターンに載る
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { time: T1800 });
    await mkEvent(w.world.id, {
      title: '日没後', kind: 'ambient', inject_mode: 'instruction', check: 'on_enter',
      trigger: 'once', chance: 1, when: { time_after: '19:00' },
      inject: '暗くなった空気で書くこと。',
    });

    // 18:10 — 条件を満たさない
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「まだ明るい」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't1' });

    // 19:10 — このターンで条件を満たすが、判定は生成後なので今回のプロンプトには載らない
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「暗くなってきた」', elapsed: 60, location: w.shop }) }]);
    const g = await generate(chat.id, { content: 't2' });
    let sent = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('条件を満たしたターン自身には載らない', !sent.includes('暗くなった空気'),
      sent.includes('暗くなった空気') ? '同ターンに載っている' : '');
    check('そのターンの終わりに発火する', (g.done?.firedEvents ?? []).includes('日没後'),
      JSON.stringify(g.done?.firedEvents));

    // 次のターンで載る
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「そうだね」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't3' });
    sent = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('次のターンに載る', sent.includes('暗くなった空気'),
      sent.includes('暗くなった空気') ? '' : '注入されていない');
  }

  // instruction は別ブロックへ
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: 'トビー登場', kind: 'story', inject_mode: 'instruction', check: 'every_turn',
      trigger: 'repeat', chance: 1, priority: 50,
      when: { all: [{ location_area: ['harbor'] }] },
      inject: '積荷の陰からトビーを登場させる。',
    });
    setQueue([{ text: reply({ char: '「港へ」', elapsed: 20, location: w.harbor }) }]);
    await generate(chat.id, { content: 't' });
    const pv = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    check('instruction は「今回の演出指示」に置かれる',
      pv.situationBlock.includes('# 今回の演出指示') && pv.situationBlock.includes('トビーを登場させる'));
    const factIdx = pv.situationBlock.indexOf('# 発生中の出来事');
    const instIdx = pv.situationBlock.indexOf('# 今回の演出指示');
    check('ブロック順序: 現在の状況 → 進行状況 → 発生中の出来事 → 今回の演出指示',
      pv.situationBlock.indexOf('# 現在の状況') === 0 &&
        (factIdx === -1 || factIdx < instIdx) &&
        pv.situationBlock.indexOf('# 進行状況') < instIdx,
      `状況=0 進行=${pv.situationBlock.indexOf('# 進行状況')} 事実=${factIdx} 指示=${instIdx}`);
  }

  // on_enter は false → true の瞬間だけ
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: '入店', kind: 'ambient', inject_mode: 'fact', check: 'on_enter',
      trigger: 'repeat', chance: 1,
      when: { all: [{ location: [w.harbor] }] },
      inject: '港の潮の匂いが強い。',
    });
    setQueue([{ text: reply({ char: '「港へ」', elapsed: 10, location: w.harbor }) }]);
    let g = await generate(chat.id, { content: 't' });
    check('on_enter: 条件を満たした瞬間に発火', (g.done?.firedEvents ?? []).includes('入店'),
      JSON.stringify(g.done?.firedEvents));
    setQueue([{ text: reply({ char: '「まだ港」', elapsed: 10, location: w.harbor }) }]);
    g = await generate(chat.id, { content: 't2' });
    check('on_enter: 条件が継続中は再発火しない', !(g.done?.firedEvents ?? []).includes('入店'),
      JSON.stringify(g.done?.firedEvents));
  }

  // 抽選はシード固定（再生成で結果が変わらない）
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: 'コイン', kind: 'ambient', inject_mode: 'fact', check: 'every_turn',
      trigger: 'repeat', chance: 0.5,
      inject: '硬貨を拾った。',
    });
    setQueue([{ text: reply({ char: '「1回目」', elapsed: 10, location: w.shop }) }]);
    const first = await generate(chat.id, { content: 't' });
    const firstFired = (first.done?.firedEvents ?? []).includes('コイン');
    const results = [];
    for (const i of [1, 2, 3]) {
      setQueue([{ text: reply({ char: `「再生成${i}」`, elapsed: 10, location: w.shop }) }]);
      const g = await generate(chat.id, { regenerate: true });
      results.push((g.done?.firedEvents ?? []).includes('コイン'));
    }
    note(`初回=${firstFired} 再生成=${results.join(',')}`);
    check('抽選はシード固定で、再生成しても結果が変わらない',
      results.every((r) => r === firstFired), `${firstFired} vs ${results.join(',')}`);
  }

  // once_per_day は同じ日なら再抽選しない
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: '日課', kind: 'ambient', inject_mode: 'fact', check: 'every_turn',
      trigger: 'once_per_day', chance: 1,
      inject: '今日の分。',
    });
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    let g = await generate(chat.id, { content: 't' });
    check('once_per_day: 初回は発火', (g.done?.firedEvents ?? []).includes('日課'));
    setQueue([{ text: reply({ char: '「2」', elapsed: 10, location: w.shop }) }]);
    g = await generate(chat.id, { content: 't2' });
    check('once_per_day: 同じ日は再発火しない', !(g.done?.firedEvents ?? []).includes('日課'));
    setQueue([{ text: reply({ char: '「翌日」', elapsed: 1440, location: w.shop }) }]);
    g = await generate(chat.id, { content: 't3' });
    check('once_per_day: 日が変わると再発火', (g.done?.firedEvents ?? []).includes('日課'),
      JSON.stringify(g.done?.firedEvents));
  }

  // set_vars でフェーズを進める（critical イベント）
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: 'フェーズ1へ', kind: 'critical', inject_mode: 'fact', check: 'every_turn',
      trigger: 'once_per_phase', trigger_var: 'case_phase', chance: 1, priority: 100,
      when: { var: 'case_phase', eq: 0 },
      inject: '不自然な噂が流れている。',
      set_vars: [{ key: 'case_phase', op: 'set', value: 1 }],
    });
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    const g = await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    check('set_vars でフェーズが進む（system_only でもイベントなら可）',
      d.chat.state.vars?.case_phase === 1, String(d.chat.state.vars?.case_phase));
    check('書き戻しは state_after にも反映される',
      d.messages.slice(-1)[0].state_after.vars?.case_phase === 1);
    check('発火が報告される', (g.done?.firedEvents ?? []).includes('フェーズ1へ'));

    // once_per_phase: 同じフェーズでは再発火しない
    setQueue([{ text: reply({ char: '「2」', elapsed: 10, location: w.shop }) }]);
    const g2 = await generate(chat.id, { content: 't2' });
    check('once_per_phase: 同じフェーズでは再発火しない',
      !(g2.done?.firedEvents ?? []).includes('フェーズ1へ'), JSON.stringify(g2.done?.firedEvents));
  }

  // monotonic: 後退する set は棄却
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { vars: { case_phase: 2 } });
    await mkEvent(w.world.id, {
      title: '巻き戻し', kind: 'story', inject_mode: 'fact', check: 'every_turn',
      trigger: 'repeat', chance: 1, inject: '戻る。',
      set_vars: [{ key: 'case_phase', op: 'set', value: 1 }],
    });
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    check('monotonic: 後退する set は棄却される', d.chat.state.vars?.case_phase === 2,
      String(d.chat.state.vars?.case_phase));
  }

  // events_enabled = 0 なら判定ごとスキップ
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { eventsEnabled: 0 });
    await mkEvent(w.world.id, {
      title: '無効時', kind: 'ambient', inject_mode: 'fact', check: 'every_turn',
      trigger: 'repeat', chance: 1, inject: '出ないはず。',
    });
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    const g = await generate(chat.id, { content: 't' });
    check('無効時: 発火しない', (g.done?.firedEvents ?? []).length === 0,
      JSON.stringify(g.done?.firedEvents));
    const pv = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    check('無効時: 出来事ブロックを出さない', !pv.situationBlock.includes('# 発生中の出来事'));
  }

  // 再生成すると、そのメッセージの発火履歴を消してから再判定する
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    const ev = (await mkEvent(w.world.id, {
      title: '一度きり', kind: 'story', inject_mode: 'fact', check: 'every_turn',
      trigger: 'once', chance: 1, inject: '一度きりの出来事。',
    })).json;
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    let g = await generate(chat.id, { content: 't' });
    check('once: 初回は発火', (g.done?.firedEvents ?? []).includes('一度きり'));
    setQueue([{ text: reply({ char: '「作り直し」', elapsed: 10, location: w.shop }) }]);
    g = await generate(chat.id, { regenerate: true });
    check('再生成: 前の候補の履歴を消して再判定する（once でも再び発火）',
      (g.done?.firedEvents ?? []).includes('一度きり'), JSON.stringify(g.done?.firedEvents));
    const st = (await api('GET', `/chats/${chat.id}/state`)).json;
    check('再生成: 発火履歴が二重に残らない',
      st.fires.filter((f) => f.event_id === ev.id).length === 1,
      `${st.fires.filter((f) => f.event_id === ev.id).length}件`);
  }

  // 分岐は発火履歴を引き継ぐ
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: '分岐前に発火', kind: 'story', inject_mode: 'fact', check: 'every_turn',
      trigger: 'once', chance: 1, inject: '起きた。',
    });
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    const fork = (await api('POST', `/chats/${chat.id}/fork`, {
      message_id: d.messages.slice(-1)[0].id,
    })).json;
    const st = (await api('GET', `/chats/${fork.id}/state`)).json;
    check('分岐: 発火履歴が引き継がれる（once が再発火しない）',
      st.fires.some((f) => f.event_title === '分岐前に発火'),
      JSON.stringify(st.fires.map((f) => f.event_title)));
  }

  // メッセージ削除で以降の履歴も消える
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: '削除で消える', kind: 'story', inject_mode: 'fact', check: 'every_turn',
      trigger: 'once', chance: 1, inject: '起きた。',
    });
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const d = await getChat(chat.id);
    const before = (await api('GET', `/chats/${chat.id}/state`)).json.fires.length;
    await api('DELETE', `/messages/${d.messages.slice(-1)[0].id}`);
    const after = (await api('GET', `/chats/${chat.id}/state`)).json.fires.length;
    check('削除: そのメッセージ以降の発火履歴も消える', after < before, `${before} → ${after}`);
  }

  // 発火履歴の手動取り消し
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    await mkEvent(w.world.id, {
      title: '誤爆', kind: 'story', inject_mode: 'fact', check: 'every_turn',
      trigger: 'once', chance: 1, inject: '誤って発火。',
    });
    setQueue([{ text: reply({ char: '「1」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 't' });
    const st = (await api('GET', `/chats/${chat.id}/state`)).json;
    const fire = st.fires.find((f) => f.event_title === '誤爆');
    await api('DELETE', `/chats/${chat.id}/fires/${fire.id}`);
    const after = (await api('GET', `/chats/${chat.id}/state`)).json;
    check('発火履歴を手動で取り消せる', !after.fires.some((f) => f.id === fire.id));
  }

  // 天候もシード固定（再生成で変わらない）
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { time: 877 * 1440 + 23 * 60 + 30 });
    const seen = [];
    for (const i of [1, 2, 3]) {
      setQueue([{ text: reply({ char: `「${i}」`, elapsed: 60, location: w.shop }) }]);
      await generate(chat.id, i === 1 ? { content: 't' } : { regenerate: true });
      seen.push((await getChat(chat.id)).chat.state.weather);
    }
    note(`日跨ぎ後の天候: ${seen.join(' , ')}`);
    check('天候もシード固定で、再生成しても変わらない',
      new Set(seen).size === 1, seen.join(' , '));
  }

  // フェーズ遷移の欠落チェック（1へ進む道はあるが、2・3へ進む道が無い）
  {
    await resetEvents(w);
    await mkEvent(w.world.id, {
      title: '1へ', kind: 'critical', inject_mode: 'fact', check: 'every_turn',
      trigger: 'once_per_phase', trigger_var: 'case_phase', chance: 1,
      when: { var: 'case_phase', eq: 0 }, inject: '進む。',
      set_vars: [{ key: 'case_phase', op: 'set', value: 1 }],
    });
    const r = (await api('GET', `/worlds/${w.world.id}/events/phase-check`)).json;
    note(`欠落: ${JSON.stringify(r.missing.map((m) => `${m.key}:${m.missing.map((x) => x.value).join(',')}`))}`);
    const cp = r.missing.find((m) => m.key === 'case_phase');
    check('フェーズ遷移の欠落を検出する',
      !!cp && cp.missing.some((x) => x.value === 3) && cp.missing.some((x) => x.value === 2),
      JSON.stringify(r.missing));
    check('到達手段のあるフェーズは欠落に挙げない',
      !!cp && !cp.missing.some((x) => x.value === 1), JSON.stringify(cp?.missing));
  }

  // 時刻表記のゆれ（日本語キーボードの全角コロンなど）
  {
    await resetEvents(w);
    const mk = (title, when) =>
      mkEvent(w.world.id, { title, when, kind: 'ambient', trigger: 'repeat', chance: 1,
        check: 'every_turn', inject: `${title}。` });
    await mk('半角', { time_after: '19:00' });
    await mk('全角コロン', { time_after: '19：00' });
    await mk('区切り無し', { time_after: '1900' });
    // 読めない時刻はいま保存で弾かれる。評価側の挙動は下の「未知キー」ブロックで見る
    const unreadable = await mk('読めない', { time_after: 'よる' });
    check('読めない時刻は保存させない', unreadable.status === 400, String(unreadable.status));

    const { chat } = await newChat(w, { time: 877 * 1440 + 20 * 60 }); // 20:00
    const rows = (await api('POST', `/worlds/${w.world.id}/events/evaluate`, { chat_id: chat.id }))
      .json.rows;
    // 採用まで見ると1ターンの上限（既定2件）に引っかかるので、条件を通ったかだけを見る
    const by = Object.fromEntries(rows.map((r) => [r.title, r.outcome]));
    const passed = (t) => by[t] !== undefined && by[t] !== 'condition';
    check('半角の time_after が効く', passed('半角'), by['半角']);
    check('全角コロンでも同じに扱う', passed('全角コロン'), by['全角コロン']);
    check('区切り無しでも同じに扱う', passed('区切り無し'), by['区切り無し']);
  }

  // 条件式のキーの誤字。保存で弾き、既に入っているものは評価で真にしない
  {
    await resetEvents(w);
    const base = { kind: 'ambient', trigger: 'repeat', chance: 1, check: 'every_turn' };

    // 1. 保存できない
    const bad = await mkEvent(w.world.id, { title: '誤字', when: { seazon: '秋' }, ...base });
    check('未知のキーは400で弾く', bad.status === 400, `${bad.status} / ${JSON.stringify(bad.json)}`);
    check('どの項目かを返す', String(bad.json?.error ?? '').includes('seazon'), bad.json?.error);

    const noVar = await mkEvent(w.world.id, { title: '比較子だけ', when: { eq: 1 }, ...base });
    check('var の無い比較子は弾く', noVar.status === 400, String(noVar.status));

    const twoCmp = await mkEvent(w.world.id, {
      title: '比較子2つ', when: { var: 'case_phase', gte: 1, lte: 3 }, ...base,
    });
    check('比較子を2つ書いたら弾く', twoCmp.status === 400, String(twoCmp.status));

    const badTime = await mkEvent(w.world.id, { title: '時刻', when: { time_after: 'よる' }, ...base });
    check('読めない時刻は保存でも弾く', badTime.status === 400, String(badTime.status));

    const badLoc = await mkEvent(w.world.id, { title: '場所', when: { location: 'nowhere' }, ...base });
    check('実在しない場所IDを弾く', badLoc.status === 400, badLoc.json?.error);

    const badVar = await mkEvent(w.world.id, { title: 'フラグ', when: { var: 'no_such_key' }, ...base });
    check('vars_schema に無いキーを弾く', badVar.status === 400, badVar.json?.error);

    const nested = await mkEvent(w.world.id, {
      title: '入れ子', when: { all: [{ season: '秋' }, { seazon: '冬' }] }, ...base,
    });
    check('入れ子の中の誤字も見る', nested.status === 400, nested.json?.error);
    check('場所を指し示す', String(nested.json?.error ?? '').includes('when.all[1]'), nested.json?.error);

    // 2. 保存はできるが決して満たされない書き方は警告として返す
    const crossing = await mkEvent(w.world.id, {
      title: '日跨ぎ', when: { time_after: '22:00', time_before: '02:00' }, ...base,
      inject: '日跨ぎ。',
    });
    check('日跨ぎの時刻指定は保存できる', crossing.status === 201, String(crossing.status));
    check('日跨ぎは警告で知らせる',
      (crossing.json?.warnings ?? []).some((m) => m.includes('any で2つに分けて')),
      JSON.stringify(crossing.json?.warnings));

    // 3. 正しい条件式はそのまま通る
    const ok = await mkEvent(w.world.id, {
      title: '正しい', when: { all: [{ season: '秋' }, { not: { weather: '雨' } }] }, ...base,
      inject: '正しい。',
    });
    check('正しい条件式は通る', ok.status === 201, `${ok.status} / ${JSON.stringify(ok.json?.error)}`);
    check('警告も出ない', (ok.json?.warnings ?? []).length === 0, JSON.stringify(ok.json?.warnings));

    // 4. 弾かれた更新で既存の条件式を壊さない
    const rejected = await api('PUT', `/events/${ok.json.id}`, { when: { seazon: '秋' } });
    check('弾かれた更新は400', rejected.status === 400, String(rejected.status));
    const untouched = (await api('GET', `/worlds/${w.world.id}/events`)).json
      .find((e) => e.id === ok.json.id);
    check('弾かれた更新では条件式が変わらない',
      JSON.stringify(untouched.when)
        === JSON.stringify({ all: [{ season: '秋' }, { not: { weather: '雨' } }] }),
      JSON.stringify(untouched.when));

    // 5. 検証より前に保存された未知キーは、評価で「満たさない」に倒す。
    //    取り込みは復元用の経路なので検証しない（1件の誤字で世界全体を弾かない）。
    //    そこから入った条件式が常時真になっていないことを、実際に評価して確かめる
    const imported = await api('POST', '/worlds/import', {
      format: 'character_chat_world',
      world: { name: 'ev_legacy_when' },
      locations: [{ id: 'ev_legacy_loc', name: '広場', indoor: 0, area: 'center' }],
      events: [
        { title: '誤字が残っている', when: { seazon: '秋' }, ...base, inject: 'x。' },
        { title: '比較子だけ残っている', when: { eq: 1 }, ...base, inject: 'y。' },
        { title: '読めない時刻が残っている', when: { time_after: 'よる' }, ...base, inject: 'w。' },
        { title: '正しい', when: {}, ...base, inject: 'z。' },
      ],
    });
    check('取り込みは通す（復元を1件の誤字で止めない）', imported.status === 201,
      `${imported.status} / ${JSON.stringify(imported.json?.error)}`);

    const legacyWorld = imported.json.world.id;
    const legacyChat = await api('POST', `/worlds/${legacyWorld}/scenarios`, {
      title: 'legacy', initial_state: { time: 877 * 1440 + 20 * 60, location: 'ev_legacy_loc' },
    });
    const lc = (await api('POST', `/scenarios/${legacyChat.json.id}/chats`, {})).json;
    const legacyRows = (await api('POST', `/worlds/${legacyWorld}/events/evaluate`, { chat_id: lc.id }))
      .json.rows;
    const outcome = Object.fromEntries(legacyRows.map((r) => [r.title, r.outcome]));
    check('既に入っている未知キーは条件で落とす', outcome['誤字が残っている'] === 'condition',
      outcome['誤字が残っている']);
    check('var の無い比較子も条件で落とす', outcome['比較子だけ残っている'] === 'condition',
      outcome['比較子だけ残っている']);
    check('読めない時刻も条件で落とす（常時真にしない）',
      outcome['読めない時刻が残っている'] === 'condition', outcome['読めない時刻が残っている']);
    check('隣の正しいイベントは通る', outcome['正しい'] !== 'condition', outcome['正しい']);
  }

  // 条件式の評価API
  {
    const { chat } = await newChat(w);
    const r = await api('POST', `/worlds/${w.world.id}/events/evaluate`, { chat_id: chat.id });
    check('現在のチャットで評価できる', r.status === 200 && Array.isArray(r.json?.rows),
      `${r.status} / ${r.json?.rows?.length}件`);
    check('落ちた理由が区分で返る',
      r.json.rows.every((x) => ['adopted', 'condition', 'check', 'trigger', 'chance', 'capped'].includes(x.outcome)),
      JSON.stringify(r.json.rows.slice(0, 3)));
  }
}

// ===========================================================================
// 場面を進める（生成せずに遷移だけ起こす）
// ===========================================================================
export async function advanceSuite(w) {
  suite('場面を進める');

  // 天候は日付が変わったときだけ引き直される
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { weather: '晴' });

    // 同じ日のうちは引き直さない
    let r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 60 });
    check('分単位で進められる', r.json.gameTime.hh === 19 && r.json.gameTime.mm === 0,
      JSON.stringify(r.json.gameTime));
    check('同じ日なら日付は変わらない扱い', r.json.dayChanged === false, String(r.json.dayChanged));
    check('同じ日なら天候は維持される', r.json.weather === '晴', r.json.weather);

    // 日付をまたぐと引き直す（手動のステート編集では起きなかったところ）。
    // 抽選が実際に走ったことを確かめるため、その季節の天候表を1つだけにしてから見る
    const cal = (await api('GET', `/worlds/${w.world.id}/calendar`)).json;
    await api('PUT', `/worlds/${w.world.id}/calendar`, {
      weather_table: { ...cal.weather_table, 秋: { 雹: 100 } },
    });
    r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 14 * 60 });
    check('日をまたぐと日付が変わったと分かる', r.json.dayChanged === true, String(r.json.dayChanged));
    check('日をまたぐと天候が抽選し直される', r.json.weather === '雹', r.json.weather);
    await api('PUT', `/worlds/${w.world.id}/calendar`, { weather_table: cal.weather_table });
  }

  // 天候の切り替わりは日付の変わり目ではなく weather_rollover_min（既定 4:00）
  {
    await resetEvents(w);
    const cal = (await api('GET', `/worlds/${w.world.id}/calendar`)).json;
    // 抽選が走ったかを見分けるため、その季節の天候表を1つだけにする
    await api('PUT', `/worlds/${w.world.id}/calendar`, {
      weather_table: { ...cal.weather_table, 秋: { 雹: 100 } },
    });

    // 23:00 → 01:00。日付はまたぐが 4:00 はまたがない
    {
      const { chat } = await newChat(w, { time: 877 * 1440 + 23 * 60, weather: '晴' });
      const r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 120 });
      check('日付はまたいだと判定される', r.json.dayChanged === true, String(r.json.dayChanged));
      check('0時をまたいだだけでは天候を引き直さない', r.json.weather === '晴', r.json.weather);
    }

    // 03:00 → 05:00。日付はまたがないが 4:00 はまたぐ
    {
      const { chat } = await newChat(w, { time: 878 * 1440 + 3 * 60, weather: '晴' });
      const r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 120 });
      check('日付はまたいでいない', r.json.dayChanged === false, String(r.json.dayChanged));
      check('4時をまたぐと天候を引き直す', r.json.weather === '雹', r.json.weather);
    }

    // 0 にすると従来どおり 0:00 起点に戻る
    {
      await api('PUT', `/worlds/${w.world.id}/calendar`, { weather_rollover_min: 0 });
      const { chat } = await newChat(w, { time: 877 * 1440 + 23 * 60, weather: '晴' });
      const r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 120 });
      check('0 にすると0時で引き直す（旧挙動へ戻せる）', r.json.weather === '雹', r.json.weather);
      await api('PUT', `/worlds/${w.world.id}/calendar`, { weather_rollover_min: 240 });
    }

    await api('PUT', `/worlds/${w.world.id}/calendar`, { weather_table: cal.weather_table });
  }

  // 境界の計算そのもの（0付近が負になるので floor でなければならない）
  {
    const { weatherDayOf } = await import('../dist/server/src/domain/calendar.js');
    const cfg = (await api('GET', `/worlds/${w.world.id}/calendar`)).json;
    const at = (day, hh) => weatherDayOf(cfg, day * 1440 + hh * 60);
    check('起点より前は前日扱い（1日目 0:00 は -1）', at(0, 0) === -1, String(at(0, 0)));
    check('起点より前は前日扱い（1日目 3:00 も -1）', at(0, 3) === -1, String(at(0, 3)));
    check('起点で切り替わる（1日目 4:00 は 0）', at(0, 4) === 0, String(at(0, 4)));
    check('翌 3:00 はまだ同じ日', at(1, 3) === 0, String(at(1, 3)));
    check('翌 4:00 で次の日', at(1, 4) === 1, String(at(1, 4)));
    check('0 を指定すると通算日と一致する',
      weatherDayOf({ ...cfg, weather_rollover_min: 0 }, 5 * 1440) === 5,
      String(weatherDayOf({ ...cfg, weather_rollover_min: 0 }, 5 * 1440)));
    check('未設定でも壊れない（0時起点として扱う）',
      weatherDayOf({ ...cfg, weather_rollover_min: undefined }, 5 * 1440) === 5);
  }

  // 手動のステート編集では抽選も判定も起きない（違いを固定しておく）
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { weather: '晴' });
    const gt = (await api('GET', `/chats/${chat.id}/state`)).json.gameTime;
    await api('PUT', `/chats/${chat.id}/state`, { game_time: { ...gt, day: gt.day + 1 } });
    const after = (await api('GET', `/chats/${chat.id}/state`)).json;
    check('ステート編集は天候を引き直さない', after.state.weather === '晴', after.state.weather);
    check('ステート編集はメッセージを増やさない',
      (await getChat(chat.id)).messages.length === 1,
      String((await getChat(chat.id)).messages.length));
  }

  // 同じ日に着けば天候は同じ（シード固定）
  {
    await resetEvents(w);
    const a = await newChat(w);
    const b = await newChat(w);
    const ra = await api('POST', `/chats/${a.chat.id}/advance`, { minutes: 1440 });
    const rb = await api('POST', `/chats/${b.chat.id}/advance`, { minutes: 1440 });
    check('チャットが違えば天候の種も違ってよい',
      typeof ra.json.weather === 'string' && typeof rb.json.weather === 'string');
    // 同じチャット・同じ着地日なら何度やっても同じになる
    const again = await api('POST', `/chats/${a.chat.id}/advance`, { minutes: 60 });
    check('同じ日のうちは天候が動かない', again.json.weather === ra.json.weather,
      `${ra.json.weather} → ${again.json.weather}`);
  }

  // 日付指定で進める
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    const gt = (await api('GET', `/chats/${chat.id}/state`)).json.gameTime;
    const r = await api('POST', `/chats/${chat.id}/advance`, {
      game_time: { year: gt.year, month: gt.month, day: gt.day + 2, hh: 9, mm: 30 },
    });
    check('日時指定で進められる',
      r.json.gameTime.day === gt.day + 2 && r.json.gameTime.hh === 9 && r.json.gameTime.mm === 30,
      JSON.stringify(r.json.gameTime));
  }

  // 巻き戻しは受け付けない
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    const back = await api('POST', `/chats/${chat.id}/advance`, { minutes: -60 });
    check('過去へは進められない', back.status === 400, String(back.status));
    const zero = await api('POST', `/chats/${chat.id}/advance`, { minutes: 0 });
    check('0分も受け付けない', zero.status === 400, String(zero.status));
    const far = await api('POST', `/chats/${chat.id}/advance`, { minutes: 400 * 1440 });
    check('極端に大きい値は弾く', far.status === 400, String(far.status));
    const none = await api('POST', `/chats/${chat.id}/advance`, {});
    check('指定が無ければ400', none.status === 400, String(none.status));
  }

  // 場面転換マーカーが残り、ステートの鎖が繋がる
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    const r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 120 });
    const d = await getChat(chat.id);
    const marker = d.messages[d.messages.length - 1];
    check('場面転換がメッセージとして残る', marker.kind === 'scene_break', marker.kind);
    check('マーカーの本文に日時が入る', marker.content.includes('20:00'), marker.content);
    check('マーカーの state_after が結果と一致する',
      marker.state_after.time === r.json.state.time, `${marker.state_after.time} / ${r.json.state.time}`);
    check('chats.state も揃う', d.chat.state.time === r.json.state.time,
      `${d.chat.state.time} / ${r.json.state.time}`);

    // 続けて生成すると、マーカーの state_after が基準になる
    setQueue([{ text: reply({ char: '「夜だ」', elapsed: 10, location: w.shop }) }]);
    const g = await generate(chat.id, { content: 'つづき' });
    check('マーカーを基準に生成が続く', g.done?.gameTime.hh === 20 && g.done?.gameTime.mm === 10,
      JSON.stringify(g.done?.gameTime));

    // マーカーは作り直しの対象にしない
    await api('POST', `/chats/${chat.id}/advance`, { minutes: 60 });
    const bad = await api('POST', `/chats/${chat.id}/messages`, { regenerate: true });
    check('場面転換は再生成できない', bad.status === 400, String(bad.status));
  }

  // 取り消すと時間もステートも戻る
  {
    await resetEvents(w);
    const { chat } = await newChat(w);
    const before = (await api('GET', `/chats/${chat.id}/state`)).json.state.time;
    const r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 180 });
    await api('DELETE', `/messages/${r.json.message.id}`);
    const after = (await api('GET', `/chats/${chat.id}/state`)).json.state.time;
    check('マーカーを消すと時間が戻る', after === before, `${before} → ${after}`);
  }

  // イベント判定が走り、次のターンのプロンプトへ注入される
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { time: T1800, weather: '晴' });
    await mkEvent(w.world.id, {
      title: '朝市', kind: 'ambient', inject_mode: 'fact',
      check: 'on_day_change', trigger: 'repeat', chance: 1,
      when: { all: [{ time_after: '06:00' }, { time_before: '11:00' }] },
      inject: '広場に朝市が立っている。',
    });

    // 同じ日のうちは on_day_change が成立しない
    let r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 60 });
    check('日付が変わらなければ発火しない', (r.json.firedEvents ?? []).length === 0,
      JSON.stringify(r.json.firedEvents));

    // 翌朝へ進めると発火する
    r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 13 * 60 });
    check('日付が変わると on_day_change が発火する', (r.json.firedEvents ?? []).includes('朝市'),
      JSON.stringify(r.json.eventRows));

    // 発火はマーカーに紐づくので、次の生成のプロンプトに載る
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「賑やかだ」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: '朝だね' });
    const sent = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('場面転換で発火した分が次ターンに注入される', sent.includes('朝市が立っている'),
      sent.split('\n').find((l) => l.includes('朝市')) ?? '注入されていない');
  }

  // イベントがOFFなら判定しない
  {
    await resetEvents(w);
    const { chat } = await newChat(w, { eventsEnabled: 0 });
    await mkEvent(w.world.id, {
      title: '無効時イベント', kind: 'ambient', inject_mode: 'fact',
      check: 'every_turn', trigger: 'repeat', chance: 1, when: {}, inject: 'x',
    });
    const r = await api('POST', `/chats/${chat.id}/advance`, { minutes: 60 });
    check('イベントOFFなら判定しない', r.json.eventsEnabled === false && r.json.firedEvents.length === 0,
      JSON.stringify(r.json.firedEvents));
  }
}
