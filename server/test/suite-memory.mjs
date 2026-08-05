// メモリー自動抽出（過剰抽出の抑制・subject の検証・トリガーの独立）
import {
  api,
  check,
  clearMockRequests,
  generate,
  mockRequests,
  note,
  reply,
  setQueue,
  suite,
} from './harness.mjs';

const T1800 = 877 * 1440 + 18 * 60;

export async function setupMemoryWorld(label) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const p = `${label}_`;
  await api('POST', `/worlds/${world.id}/locations`, { id: `${p}shop`, name: '店', indoor: 1, area: 'center' });
  const ashley = (await api('POST', `/worlds/${world.id}/characters`, { name: 'アシュリー' })).json;
  const toby = (await api('POST', `/worlds/${world.id}/characters`, { name: 'トビー' })).json;
  return { world, ashley, toby, shop: `${p}shop` };
}

async function newChat(w) {
  const scenario = (
    await api('POST', `/worlds/${w.world.id}/scenarios`, {
      title: 'mem',
      participant_ids: [w.ashley.id],
      opening: 'ナレーター: 開始。',
      initial_state: {
        time: T1800, location: w.shop, location_note: '', weather: '晴',
        present: [w.ashley.id], vars: {},
      },
    })
  ).json;
  return (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
}

/** 会話を n ターン進める（1ターン = user + assistant の2件） */
async function advance(chatId, w, n) {
  for (let i = 0; i < n; i++) {
    setQueue([{ text: reply({ char: `「${i}」`, elapsed: 10, location: w.shop }) }]);
    await generate(chatId, { content: `t${i}` });
  }
}

const memJson = (items) => JSON.stringify({ memories: items });

// ===========================================================================
export async function memorySuite(w) {
  suite('メモリー抽出');

  // 抽出の下限。狭い範囲から絞り出させない
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 2); // 冒頭1 + 4件 = 5件（下限8未満）
    setQueue([{ text: memJson([{ content: '拾われるべきでない', why: '' }]) }]);
    const r = await api('POST', `/chats/${chat.id}/extract`);
    check('新規が下限未満なら抽出しない', r.json.added === 0, JSON.stringify(r.json));

    // プレビューは下限を無視して試せる
    setQueue([{ text: memJson([{ content: '候補です', why: '忘れると矛盾する' }]) }]);
    const p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('プレビューは下限を無視する', p.candidates.length === 1, JSON.stringify(p.notes));
    check('プレビューは理由も返す', p.candidates[0].why === '忘れると矛盾する');
    check('プレビューは対象範囲を返す', p.range?.count === 5, JSON.stringify(p.range));
    check('プレビューでは保存しない',
      (await api('GET', `/characters/${w.ashley.id}/memories`)).json.length === 0);
  }

  // プロンプトの中身
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    await clearMockRequests();
    setQueue([{ text: memJson([]) }]);
    await api('POST', `/chats/${chat.id}/extract-preview`);
    const prompt = (await mockRequests()).map((r) => r.prompt).join('\n');
    check('人物IDの一覧を渡している', prompt.includes(`${w.toby.id} = トビー`));
    check('「空配列でよい」と明示している', prompt.includes('空配列'));
    check('件数の上限値を目標として与えていない', !prompt.includes('最大5件'), '');
    check('保存条件の5項目が入っている',
      ['数シーン後', '将来の会話', '明確な矛盾', '一時的な感情', '重複しない'].every((k) =>
        prompt.includes(k),
      ));
    check('判断の例を添えている', prompt.includes('保存しない: 「紅茶を淹れた」'));
  }

  // subject の検証（名前を返されたら常時扱いに落とす）
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    setQueue([
      {
        text: memJson([
          { subject: 'トビー', content: '名前で返ってきた', why: 'x' },
          { subject: w.toby.id, content: 'IDで返ってきた', why: 'y' },
          { subject: '', content: '空で返ってきた', why: 'z' },
        ]),
      },
    ]);
    const p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    const byContent = Object.fromEntries(p.candidates.map((c) => [c.content, c.subject]));
    check('人物IDとして解決できない対象は空にする', byContent['名前で返ってきた'] === '',
      JSON.stringify(byContent));
    check('正しいIDはそのまま残す', byContent['IDで返ってきた'] === w.toby.id);
    check('空はそのまま', byContent['空で返ってきた'] === '');
    check('落としたことを通知する',
      p.notes.some((n) => n.includes('解決できない')), JSON.stringify(p.notes));
  }

  // 上限は超えた分を切り捨てる（プロンプトには書かない）
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    const many = Array.from({ length: 8 }, (_, i) => ({ content: `m${i}`, why: 'x' }));
    setQueue([{ text: memJson(many) }]);
    const p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('1回の抽出は5件まで', p.candidates.length === 5, `${p.candidates.length}件`);
    check('切り捨てを通知する', p.notes.some((n) => n.includes('切り捨て')), JSON.stringify(p.notes));
  }

  // 保存すると境界が進み、同じ範囲を再抽出しない
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    setQueue([{ text: memJson([{ subject: '', content: '保存される事実', why: 'x' }]) }]);
    const r1 = await api('POST', `/chats/${chat.id}/extract`);
    check('抽出して保存できる', r1.json.added === 1, JSON.stringify(r1.json));
    const saved = (await api('GET', `/characters/${w.ashley.id}/memories`)).json;
    check('source が auto になる', saved.some((m) => m.content === '保存される事実' && m.source === 'auto'));

    setQueue([{ text: memJson([{ content: '二重に保存されるべきでない', why: 'x' }]) }]);
    const r2 = await api('POST', `/chats/${chat.id}/extract`);
    check('同じ範囲を再抽出しない', r2.json.added === 0, JSON.stringify(r2.json));
  }

  // 抽出が要約から独立している
  {
    await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 1 });
    const chat = await newChat(w);
    await clearMockRequests();
    await advance(chat.id, w, 20); // 41件 ≧ summary_interval(32)
    await new Promise((r) => setTimeout(r, 900));
    const utility = (await mockRequests()).filter((r) => !r.stream);
    check('自動要約がOFFでも自動抽出は走る', utility.length > 0, `${utility.length}回`);
    check('走ったのは抽出（要約ではない）',
      utility.every((r) => r.prompt.includes('長期的に記憶すべき')),
      utility.map((r) => r.prompt.slice(0, 24)).join(' / '));
    await api('PUT', '/settings', { auto_summarize: 1, auto_extract: 0 });
  }

  // 実行中ガード: 抽出が終わる前に次のターンが来ても二重に走らせない
  {
    await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 1 });
    const chat = await newChat(w);
    await advance(chat.id, w, 20);
    await new Promise((r) => setTimeout(r, 900));
    await clearMockRequests();

    // 抽出応答を遅らせたうえで、続けて2ターン送る
    setQueue([
      { text: reply({ char: '「A」', elapsed: 10, location: w.shop }) },
      { text: memJson([]), gapMs: 1200 },
      { text: reply({ char: '「B」', elapsed: 10, location: w.shop }) },
      { text: memJson([]) },
    ]);
    await generate(chat.id, { content: 'a' });
    await generate(chat.id, { content: 'b' });
    await new Promise((r) => setTimeout(r, 1800));
    const utility = (await mockRequests()).filter((r) => !r.stream);
    note(`このあいだのユーティリティ呼び出し: ${utility.length}回`);
    check('抽出中に次のターンが来ても二重に走らせない', utility.length <= 1, `${utility.length}回`);
    await api('PUT', '/settings', { auto_summarize: 1, auto_extract: 0 });
  }
}

// ===========================================================================
/** 3段フラグの解決結果が API から読めるか（UIの「いまはON/OFF」表示の裏付け） */
export async function flagResolutionSuite(w) {
  suite('設定の解決結果');

  const mkChat = async (scenarioFlags, chatFlags) => {
    const scenario = (
      await api('POST', `/worlds/${w.world.id}/scenarios`, {
        title: 'f',
        participant_ids: [w.ashley.id],
        opening: 'ナレーター: 開始。',
        ...scenarioFlags,
        initial_state: {
          time: T1800, location: w.shop, location_note: '', weather: '晴',
          present: [w.ashley.id], vars: {},
        },
      })
    ).json;
    const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
    if (chatFlags) await api('PUT', `/chats/${chat.id}`, chatFlags);
    return (await api('GET', `/chats/${chat.id}`)).json;
  };

  // 全体設定は events=1 / vars=0
  {
    const d = await mkChat({});
    check('シナリオがあるうちは飛ばさない', d.flags.scenarioMissing === false);
    check('指定が無ければ全体設定が根拠になる',
      d.flags.events.from === 'settings' && d.flags.events.enabled === true,
      JSON.stringify(d.flags.events));
    check('全体設定OFFのものはOFFで返る',
      d.flags.vars.from === 'settings' && d.flags.vars.enabled === false,
      JSON.stringify(d.flags.vars));
  }

  // シナリオの指定がチャットへ継承される（今回の報告の再現）
  {
    const d = await mkChat({ events_enabled: 0, vars_enabled: 1 });
    check('シナリオでOFFにするとチャットでもOFF',
      d.flags.events.enabled === false && d.flags.events.from === 'scenario',
      JSON.stringify(d.flags.events));
    check('シナリオでONにするとチャットでもON',
      d.flags.vars.enabled === true && d.flags.vars.from === 'scenario',
      JSON.stringify(d.flags.vars));
    check('チャットの列自体はNULL（＝継承）のまま',
      d.chat.events_enabled === null && d.chat.vars_enabled === null,
      `${d.chat.events_enabled} / ${d.chat.vars_enabled}`);
  }

  // チャットの指定が最優先
  {
    const d = await mkChat({ events_enabled: 0 }, { events_enabled: 1 });
    check('チャットの指定がシナリオより優先される',
      d.flags.events.enabled === true && d.flags.events.from === 'chat',
      JSON.stringify(d.flags.events));
  }

  // 全体設定OFF × チャットON（気付けない、と指摘された組み合わせ）
  {
    const d = await mkChat({}, { vars_enabled: 1 });
    check('全体設定OFFでもチャットONならONと分かる',
      d.flags.vars.enabled === true && d.flags.vars.from === 'chat',
      JSON.stringify(d.flags.vars));
  }

  // シナリオを消しても解決できる
  {
    const scenario = (
      await api('POST', `/worlds/${w.world.id}/scenarios`, {
        title: 'del', participant_ids: [w.ashley.id], opening: 'ナレーター: 開始。',
        events_enabled: 0,
        initial_state: {
          time: T1800, location: w.shop, location_note: '', weather: '晴',
          present: [w.ashley.id], vars: {},
        },
      })
    ).json;
    const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
    await api('DELETE', `/scenarios/${scenario.id}`);
    const d = (await api('GET', `/chats/${chat.id}`)).json;
    check('シナリオ削除後は全体設定へ落ちる', d.flags.events.from === 'settings',
      JSON.stringify(d.flags.events));
    check('削除でチャットの参照もNULLになる', d.chat.scenario_id === null, String(d.chat.scenario_id));
    check('シナリオの段を飛ばしていることを知らせる', d.flags.scenarioMissing === true);
  }
}
