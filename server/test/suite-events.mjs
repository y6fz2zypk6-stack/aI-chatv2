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
    await mk('読めない', { time_after: 'よる' });

    const { chat } = await newChat(w, { time: 877 * 1440 + 20 * 60 }); // 20:00
    const rows = (await api('POST', `/worlds/${w.world.id}/events/evaluate`, { chat_id: chat.id }))
      .json.rows;
    // 採用まで見ると1ターンの上限（既定2件）に引っかかるので、条件を通ったかだけを見る
    const by = Object.fromEntries(rows.map((r) => [r.title, r.outcome]));
    const passed = (t) => by[t] !== undefined && by[t] !== 'condition';
    check('半角の time_after が効く', passed('半角'), by['半角']);
    check('全角コロンでも同じに扱う', passed('全角コロン'), by['全角コロン']);
    check('区切り無しでも同じに扱う', passed('区切り無し'), by['区切り無し']);
    check('読めない時刻は「満たさない」にする（常時真にしない）',
      by['読めない'] === 'condition', by['読めない']);
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
