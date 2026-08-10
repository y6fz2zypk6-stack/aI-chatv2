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

  // 応答が読めないときの扱い
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);

    // 空応答（JSONモードで空を返すモデル）→ 素のプロンプトで1度だけ試し直す
    setQueue([{ text: '' }, { text: memJson([{ content: '再試行で取れた', why: 'x' }]) }]);
    let p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('空応答なら素のプロンプトで試し直す', p.candidates.length === 1,
      JSON.stringify(p.notes));

    // 2回とも空 → 失敗として理由を出す
    setQueue([{ text: '' }, { text: '' }]);
    p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('2回とも空なら失敗として扱う', p.failed === true, String(p.failed));
    check('空応答だと分かる説明を出す',
      p.notes.some((n) => n.includes('空の応答')), JSON.stringify(p.notes));

    // コードフェンス付き → 剥がして読む
    setQueue([{ text: '```json\n' + memJson([{ content: 'フェンス付き', why: 'x' }]) + '\n```' }]);
    p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('コードフェンス付きでも読める', p.candidates.length === 1, JSON.stringify(p.notes));

    // 前置き付き
    setQueue([{ text: '以下が結果です。\n' + memJson([{ content: '前置き付き', why: 'x' }]) }]);
    p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('前置きが付いていても読める', p.candidates.length === 1, JSON.stringify(p.notes));

    // 途中で切れた（上限到達）
    setQueue([{ text: '{"memories": [{"content": "とちゅ', finish: 'length' }]);
    p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('途中で切れたら失敗として扱う', p.failed === true, String(p.failed));
    check('上限到達だと分かる説明を出す',
      p.notes.some((n) => n.includes('長さの上限')), JSON.stringify(p.notes));

    // 拒否
    setQueue([{ text: '', refusal: 'この内容には応じられません' }]);
    p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('拒否も理由を出す', p.notes.some((n) => n.includes('拒否')), JSON.stringify(p.notes));
  }

  // 失敗したら抽出済み境界を進めない（範囲を取り返せなくしない）
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    const before = (await api('GET', `/chats/${chat.id}`)).json.chat.extracted_up_to_seq;
    setQueue([{ text: '' }, { text: '' }]);
    const r = await api('POST', `/chats/${chat.id}/extract`);
    check('失敗時は保存件数0', r.json.added === 0, JSON.stringify(r.json));
    check('失敗を呼び出し元へ返す', r.json.failed === true);
    const after = (await api('GET', `/chats/${chat.id}`)).json.chat.extracted_up_to_seq;
    check('失敗時は境界を進めない', after === before, `${before} → ${after}`);

    // 直したら同じ範囲を拾い直せる
    setQueue([{ text: memJson([{ content: '直したら取れた', why: 'x' }]) }]);
    const r2 = await api('POST', `/chats/${chat.id}/extract`);
    check('直せば同じ範囲を拾い直せる', r2.json.added === 1, JSON.stringify(r2.json));
    const fixed = (await api('GET', `/chats/${chat.id}`)).json.chat.extracted_up_to_seq;
    check('成功したら境界が進む', fixed > (before ?? 0), `${before} → ${fixed}`);
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

// ===========================================================================
/** 要約プロンプト（固定の骨組み + 編集できる方針） */
export async function summarySuite(w) {
  suite('要約プロンプト');

  const base = (await api('GET', '/settings')).json;
  const defaults = (await api('GET', '/settings/defaults')).json;

  check('既定の方針に「何を落とすか」がある', defaults.summary_policy.includes('# 何を落とすか'),
    defaults.summary_policy.split('\n')[0]);
  check('既定の方針に見出しの指定がある', defaults.summary_policy.includes('## 未解決'));

  /** 要約を1回起こし、そのとき送られたプロンプトを返す */
  const promptOf = async () => {
    const chat = await newChat(w);
    await advance(chat.id, w, 20); // 41件 ≧ summary_interval
    await clearMockRequests();
    setQueue([{ text: 'まとめたあらすじ。' }]);
    await api('POST', `/chats/${chat.id}/summarize`);
    const reqs = (await mockRequests()).filter((r) => !r.stream);
    return reqs[reqs.length - 1]?.prompt ?? '';
  };

  await api('PUT', '/settings', { auto_extract: 0, summary_max_chars: 700 });

  // 骨組み
  {
    const p = await promptOf();
    check('統合の指示がある', p.includes('統合し、1本のあらすじとして書き直す'));
    check('前回分を落とさない指示がある', p.includes('出来事・約束・未解決の項目は落とさない'));
    check('人物設定を除外する指示がある', p.includes('人物の設定'));
    check('日付の形式を指定している', p.includes('[5年9月10日(秋)] の形式'));
    check('文字数が反映される', p.includes('700文字程度'), '');
    check('「古い出来事も消さずに残し」は無くなった', !p.includes('古い出来事も消さずに残し'));
    check('方針が本文に入る', p.includes('# 要約の方針') && p.includes('# 何を落とすか'));
  }

  // 自動で発火した瞬間に、何件の生データを対象にしているか
  {
    const autoTargets = async (interval) => {
      await api('PUT', '/settings', {
        auto_summarize: 1, auto_extract: 0, summary_interval: interval,
      });
      const chat = await newChat(w);
      for (let t = 1; t <= 20; t++) {
        await clearMockRequests();
        setQueue([
          { text: reply({ char: `「${t}」`, elapsed: 10, location: w.shop }) },
          { text: `あらすじ${t}` },
        ]);
        await generate(chat.id, { content: `t${t}` });
        await new Promise((r) => setTimeout(r, 400));
        const reqs = (await mockRequests()).filter((r) => !r.stream);
        if (reqs.length) {
          const body = reqs[0].prompt.slice(reqs[0].prompt.indexOf('# 今回の会話'));
          return (body.match(/^\[/gm) ?? []).length;
        }
      }
      return 0;
    };
    const c8 = await autoTargets(8);
    const c16 = await autoTargets(16);
    note(`初回要約の対象件数: interval=8 → ${c8}件 / interval=16 → ${c16}件`);
    // 初回は冒頭メッセージ1件が乗るので interval/2 + 1 になる
    check('対象件数は interval のおよそ半分', c8 === 5 && c16 === 9, `${c8} / ${c16}`);
    check('interval の差がそのまま対象件数の差になる', c16 - c8 === (16 - 8) / 2,
      `${c8} → ${c16}`);
  }

  // 方針を差し替えられる
  {
    await api('PUT', '/settings', { summary_policy: '# 方針\n一行で書く。' });
    const p = await promptOf();
    check('差し替えた方針が使われる', p.includes('一行で書く。'));
    check('差し替えても骨組みは残る',
      p.includes('人物の設定') && p.includes('出来事・約束・未解決の項目は落とさない'));
    check('差し替えたら既定の方針は入らない', !p.includes('# 何を落とすか'));
  }

  // 空にしたら既定へ戻す（骨組みだけになるのを防ぐ）
  {
    await api('PUT', '/settings', { summary_policy: '   ' });
    const p = await promptOf();
    check('方針が空なら既定を使う', p.includes('# 何を落とすか'));
  }

  await api('PUT', '/settings', base);
}

// ===========================================================================
/** 要約の発火間隔（毎ターン走らないこと） */
export async function summaryCadenceSuite(w) {
  suite('要約の発火間隔');

  const base = (await api('GET', '/settings')).json;

  /** interval を設定して n ターン進め、要約が走ったターンを返す */
  const firedTurns = async (interval, turns) => {
    await api('PUT', '/settings', {
      auto_summarize: 1, auto_extract: 0, summary_interval: interval,
    });
    const chat = await newChat(w);
    const fired = [];
    for (let t = 1; t <= turns; t++) {
      await clearMockRequests();
      setQueue([
        { text: reply({ char: `「${t}」`, elapsed: 10, location: w.shop }) },
        { text: `あらすじ${t}` },
      ]);
      await generate(chat.id, { content: `t${t}` });
      await new Promise((r) => setTimeout(r, 400));
      const utility = (await mockRequests()).filter((r) => !r.stream);
      if (utility.length) fired.push(t);
    }
    return fired;
  };

  // 修正前は retain が interval をほぼ食い尽くし、どの interval でも毎ターンになっていた
  let small = [];
  {
    const fired = await firedTurns(8, 12);
    small = fired.slice(1).map((t, i) => t - fired[i]);
    note(`interval=8 の発火ターン: ${fired.join(',') || '（なし）'}`);
    check('複数回発火するところまで進んでいる', fired.length >= 3, `${fired.length}回`);
    check('interval=8 で毎ターン要約しない', small.length > 0 && small.every((g) => g >= 2),
      `間隔 ${small.join(',') || '—'}`);
    check('発火間隔が一定', new Set(small).size === 1, `間隔 ${small.join(',')}`);
  }

  // interval を大きくすると間隔も比例して広がる
  {
    const fired = await firedTurns(16, 18);
    const gaps = fired.slice(1).map((t, i) => t - fired[i]);
    note(`interval=16 の発火ターン: ${fired.join(',') || '（なし）'}`);
    check('複数回発火するところまで進んでいる', fired.length >= 2, `${fired.length}回`);
    check('interval=16 は interval=8 より間隔が広い',
      gaps.length > 0 && gaps.every((g) => g > small[0]),
      `間隔 ${gaps.join(',')} vs ${small[0]}`);
  }

  // 1回の要約で必ず前へ進む（進まないと次ターンも同じ判定になる）
  {
    await api('PUT', '/settings', { auto_summarize: 1, auto_extract: 0, summary_interval: 8 });
    const chat = await newChat(w);
    for (let t = 1; t <= 5; t++) {
      setQueue([
        { text: reply({ char: `「${t}」`, elapsed: 10, location: w.shop }) },
        { text: `あらすじ${t}` },
      ]);
      await generate(chat.id, { content: `t${t}` });
      await new Promise((r) => setTimeout(r, 300));
    }
    const sum = (await api('GET', `/chats/${chat.id}/summary`)).json;
    check('境界が前へ進んでいる', (sum?.up_to_seq ?? 0) > 0, `up_to_seq=${sum?.up_to_seq}`);
  }

  await api('PUT', '/settings', base);
}

// ===========================================================================
// メモリーのゲーム内日付（実時間ではなく state の時刻を持たせる）
// ===========================================================================
export async function memoryDateSuite(w) {
  suite('メモリーのゲーム内日付');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  const chat = await newChat(w);
  await advance(chat.id, w, 5); // 10分×5 = 18:50
  const at = T1800 + 50;

  setQueue([{ text: memJson([{ subject: '', content: '港で待ち合わせると約束した', why: 'x' }]) }]);
  const r = await api('POST', `/chats/${chat.id}/extract`);
  check('抽出して保存できる', r.json.added === 1, JSON.stringify(r.json));

  const find = async (content) =>
    (await api('GET', `/characters/${w.ashley.id}/memories`)).json.find((m) => m.content === content);

  const m = await find('港で待ち合わせると約束した');
  check('抽出範囲末尾のゲーム内時刻を保存する', m?.game_time === at, String(m?.game_time));
  check('一覧では絶対日付を返す', m?.game_time_label === '3年8月10日', m?.game_time_label);

  // 同じ日なら「今日」として注入される
  await clearMockRequests();
  setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'x' });
  let prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
  check('同じ日は「今日」として注入する', prompt.includes('- (今日) 港で待ち合わせると約束した'),
    prompt.split('\n').filter((l) => l.includes('港で')).join(' | '));

  // 日をまたぐと相対表記が動く
  const gt = (await api('GET', `/chats/${chat.id}/state`)).json.gameTime;
  await api('PUT', `/chats/${chat.id}/state`, { game_time: { ...gt, day: gt.day + 3 } });
  await clearMockRequests();
  setQueue([{ text: reply({ char: '「ええ」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'y' });
  prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
  check('3日経つと「3日前」になる', prompt.includes('- (3日前) 港で待ち合わせると約束した'),
    prompt.split('\n').filter((l) => l.includes('港で')).join(' | '));

  // 手動追加は日付を持たない（実時間から推測しない）
  const manual = (await api('POST', `/characters/${w.ashley.id}/memories`, { content: '手動で足した' })).json;
  check('手動追加の日付は null', manual.game_time === null, String(manual.game_time));
  check('日付不明ならラベルは空', manual.game_time_label === '', manual.game_time_label);

  await clearMockRequests();
  setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'z' });
  prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
  check('日付不明は日付を付けずに注入する', prompt.includes('- 手動で足した'),
    prompt.split('\n').filter((l) => l.includes('手動で')).join(' | '));

  // 編集しても日付は消えない
  await api('PUT', `/memories/${m.id}`, { content: m.content, subject: '', pinned: 1 });
  const after = await find('港で待ち合わせると約束した');
  check('日付を含まない更新でも日付は残る', after?.game_time === at, String(after?.game_time));

  // 書き出し → 取り込みで日付が保たれる
  const dump = (await api('GET', `/worlds/${w.world.id}/export`)).json;
  const imported = (await api('POST', '/worlds/import', { ...dump, world: { ...dump.world, name: 'mem_copy' } })).json;
  const copied = (await api('GET', `/worlds/${imported.world.id}/characters`)).json
    .find((c) => c.name === 'アシュリー');
  const copiedMems = (await api('GET', `/characters/${copied.id}/memories`)).json;
  check('取り込み後も日付が残る',
    copiedMems.find((x) => x.content === '港で待ち合わせると約束した')?.game_time === at,
    JSON.stringify(copiedMems.map((x) => [x.content, x.game_time])));

  await api('PUT', '/settings', base);
}

// ===========================================================================
// 裏で走った要約・抽出の結果を知らせる（成功も失敗も）
// ===========================================================================
export async function noticeSuite(w) {
  suite('要約・抽出の通知');

  const base = (await api('GET', '/settings')).json;

  // 自動要約が成功したら通知が届く
  {
    await api('PUT', '/settings', { auto_summarize: 1, auto_extract: 0, summary_interval: 8 });
    const chat = await newChat(w);
    let fired = null;
    for (let t = 1; t <= 6 && !fired; t++) {
      setQueue([
        { text: reply({ char: `「${t}」`, elapsed: 10, location: w.shop }) },
        { text: `あらすじ${t}` },
      ]);
      const g = await generate(chat.id, { content: `t${t}` });
      const n = (g.notices ?? []).find((x) => x.kind === 'summary');
      if (n) fired = n;
    }
    check('要約が走ったら通知が届く', !!fired, JSON.stringify(fired));
    check('成功として届く', fired?.ok === true, JSON.stringify(fired));
    check('件数が分かる文言になっている', /\d+件を要約しました/.test(fired?.message ?? ''),
      fired?.message);
  }

  // 要約が空応答なら失敗として届く（「変更なし」で黙らせない）
  {
    await api('PUT', '/settings', { auto_summarize: 1, auto_extract: 0, summary_interval: 8 });
    const chat = await newChat(w);
    let fired = null;
    for (let t = 1; t <= 6 && !fired; t++) {
      setQueue([
        { text: reply({ char: `「${t}」`, elapsed: 10, location: w.shop }) },
        { text: '' },
      ]);
      const g = await generate(chat.id, { content: `t${t}` });
      const n = (g.notices ?? []).find((x) => x.kind === 'summary');
      if (n) fired = n;
    }
    check('空応答でも通知が届く', !!fired, JSON.stringify(fired));
    check('失敗として届く', fired?.ok === false, JSON.stringify(fired));
    check('理由が分かる文言になっている', (fired?.message ?? '').includes('空の応答'), fired?.message);
    const sum = (await api('GET', `/chats/${chat.id}/summary`)).json;
    check('失敗時はあらすじを保存しない', !sum, JSON.stringify(sum));
  }

  // 自動抽出の成功・失敗
  {
    await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 1, summary_interval: 8 });
    const chat = await newChat(w);
    let fired = null;
    for (let t = 1; t <= 6 && !fired; t++) {
      setQueue([
        { text: reply({ char: `「${t}」`, elapsed: 10, location: w.shop }) },
        { text: memJson([{ subject: '', content: `通知の確認${t}`, why: 'x' }]) },
      ]);
      const g = await generate(chat.id, { content: `t${t}` });
      const n = (g.notices ?? []).find((x) => x.kind === 'memory');
      if (n) fired = n;
    }
    check('抽出が走ったら通知が届く', !!fired, JSON.stringify(fired));
    check('保存件数が分かる', /メモリーを\d+件保存しました/.test(fired?.message ?? ''), fired?.message);
  }

  {
    await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 1, summary_interval: 8 });
    const chat = await newChat(w);
    let fired = null;
    for (let t = 1; t <= 6 && !fired; t++) {
      setQueue([
        { text: reply({ char: `「${t}」`, elapsed: 10, location: w.shop }) },
        { text: '' },
        { text: '' },
      ]);
      const g = await generate(chat.id, { content: `t${t}` });
      const n = (g.notices ?? []).find((x) => x.kind === 'memory');
      if (n) fired = n;
    }
    check('抽出の失敗も通知が届く', fired?.ok === false, JSON.stringify(fired));
    check('抽出の失敗理由が分かる', (fired?.message ?? '').includes('空の応答'), fired?.message);
  }

  // 走らなかったターンでは通知を出さない（毎ターン出ると邪魔になる）
  {
    await api('PUT', '/settings', { auto_summarize: 1, auto_extract: 1, summary_interval: 64 });
    const chat = await newChat(w);
    setQueue([{ text: reply({ char: '「静か」', elapsed: 10, location: w.shop }) }]);
    const g = await generate(chat.id, { content: 't' });
    check('何も走らなければ通知は出ない', (g.notices ?? []).length === 0, JSON.stringify(g.notices));
  }

  // 手動要約も同じ文言を返す
  {
    await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0, summary_interval: 8 });
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    setQueue([{ text: '手で作ったあらすじ' }]);
    let r = (await api('POST', `/chats/${chat.id}/summarize`)).json;
    check('手動要約は成功の文言を返す', r.ok === true && /件を要約しました/.test(r.message), JSON.stringify(r));

    setQueue([{ text: '' }]);
    r = (await api('POST', `/chats/${chat.id}/summarize`)).json;
    check('手動要約の失敗も文言で返す', r.ok === false && r.message.includes('空の応答'), JSON.stringify(r));
  }

  await api('PUT', '/settings', base);
}

// ===========================================================================
// プレビューで見た候補をそのまま保存する
// ===========================================================================
export async function commitSuite(w) {
  suite('メモリー候補の保存');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  const commit = (chatId, body) => api('POST', `/chats/${chatId}/extract/commit`, body);
  const mems = async () => (await api('GET', `/characters/${w.ashley.id}/memories`)).json;

  // プレビュー → そのまま保存
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    await clearMockRequests();
    setQueue([
      {
        text: memJson([
          { subject: w.toby.id, content: '見たまま保存される', why: 'x' },
          { subject: '', content: 'これも保存される', why: 'y' },
        ]),
      },
    ]);
    const p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    check('プレビューが2件返る', p.candidates.length === 2, JSON.stringify(p.notes));

    await clearMockRequests();
    const r = await commit(chat.id, {
      candidates: p.candidates.map((c) => ({
        character_id: c.character_id, subject: c.subject, content: c.content,
      })),
      toSeq: p.range.toSeq,
    });
    check('保存できる', r.json.added === 2, JSON.stringify(r.json));
    check('抽出をやり直さない（LLMを呼ばない）', (await mockRequests()).length === 0,
      `${(await mockRequests()).length}回呼んでいる`);

    const saved = await mems();
    const one = saved.find((m) => m.content === '見たまま保存される');
    check('内容がそのまま入る', !!one, JSON.stringify(saved.map((m) => m.content)));
    check('対象タグも保たれる', one?.subject === w.toby.id, one?.subject);
    check('自動抽出と同じ扱いになる', one?.source === 'auto', one?.source);
    check('ゲーム内日付が入る', one?.game_time === T1800 + 50, String(one?.game_time));

    // 境界が進み、同じ範囲を自動抽出が拾い直さない
    const d = (await api('GET', `/chats/${chat.id}`)).json;
    check('抽出済み境界が進む', d.chat.extracted_up_to_seq === p.range.toSeq,
      `${d.chat.extracted_up_to_seq} / ${p.range.toSeq}`);
    const again = await commit(chat.id, { candidates: [], toSeq: p.range.toSeq });
    check('同じ範囲は二度保存できない', again.status === 400, String(again.status));
  }

  // 中身はサーバで検証する（クライアントを信用しない）
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    const p = (await api('GET', `/chats/${chat.id}`)).json;
    const toSeq = p.messages[p.messages.length - 1].seq;
    const before = (await mems()).length;

    const r = await commit(chat.id, {
      candidates: [
        { character_id: 'not_a_character', subject: '', content: '参加者でないので落ちる' },
        { character_id: w.ashley.id, subject: 'トビー', content: '対象が名前なら常時扱い' },
        { character_id: w.ashley.id, subject: '', content: '   ' },
      ],
      toSeq,
    });
    check('参加者でないキャラ宛ては保存しない', r.json.added === 1, JSON.stringify(r.json));
    check('落としたことを知らせる', r.json.message.includes('除きました'), r.json.message);
    const saved = await mems();
    check('空の内容は保存しない',
      saved.length === before + 1, `${before} → ${saved.length}`);
    check('解決できない対象は常時扱いに落とす',
      saved.find((m) => m.content === '対象が名前なら常時扱い')?.subject === '', '');
  }

  // 範囲の検証
  {
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    const d = (await api('GET', `/chats/${chat.id}`)).json;
    const lastSeq = d.messages[d.messages.length - 1].seq;
    check('存在しない範囲は400',
      (await commit(chat.id, { candidates: [], toSeq: lastSeq + 99 })).status === 400);
    check('toSeq が無ければ400',
      (await commit(chat.id, { candidates: [] })).status === 400);
    check('candidates が配列でなければ400',
      (await commit(chat.id, { candidates: 'x', toSeq: lastSeq })).status === 400);
  }

  // 抽出に失敗したあとの立て直しに使える（クレジット切れなどからの復帰）
  {
    await api('PUT', '/settings', { auto_extract: 1, summary_interval: 8 });
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    setQueue([{ text: '' }, { text: '' }]);
    const failed = await api('POST', `/chats/${chat.id}/extract`);
    check('まず失敗させる', failed.json.failed === true, JSON.stringify(failed.json));

    const d = (await api('GET', `/chats/${chat.id}`)).json;
    const toSeq = d.messages[d.messages.length - 1].seq;
    const r = await commit(chat.id, {
      candidates: [{ character_id: w.ashley.id, subject: '', content: '立て直して保存' }],
      toSeq,
    });
    check('失敗後でも手で保存できる', r.json.added === 1, JSON.stringify(r.json));
    const after = (await api('GET', `/chats/${chat.id}`)).json;
    check('保存すると境界も進む', after.chat.extracted_up_to_seq === toSeq,
      `${after.chat.extracted_up_to_seq} / ${toSeq}`);
  }

  await api('PUT', '/settings', base);
}

// ===========================================================================
// メモリーの注入オンオフ（消さずに黙らせる）
// ===========================================================================
export async function memoryToggleSuite(w) {
  suite('メモリーの注入オンオフ');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  const mk = async (content) =>
    (await api('POST', `/characters/${w.ashley.id}/memories`, { content })).json;
  const promptOf = async (chatId) => {
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
    await generate(chatId, { content: 'x' });
    return (await mockRequests()).map((q) => q.prompt).join('\n');
  };

  // 既定は有効。OFF にすると注入から外れるが、記録は残る
  {
    const on = await mk('残す・注入する');
    const off = await mk('残す・注入しない');
    check('既定は有効', on.enabled === 1 && off.enabled === 1, `${on.enabled} / ${off.enabled}`);

    const chat = await newChat(w);
    let prompt = await promptOf(chat.id);
    check('OFFにする前は両方載る',
      prompt.includes('残す・注入する') && prompt.includes('残す・注入しない'), '');

    const r = await api('PUT', `/memories/${off.id}`, { ...off, enabled: 0 });
    check('OFFにできる', r.json.enabled === 0, String(r.json.enabled));

    prompt = await promptOf(chat.id);
    check('OFFにすると注入されない', !prompt.includes('残す・注入しない'), 'まだ載っている');
    check('ONのものは載ったまま', prompt.includes('残す・注入する'), '載らなくなった');

    const list = (await api('GET', `/characters/${w.ashley.id}/memories`)).json;
    check('記録としては残る', list.some((m) => m.id === off.id && m.content === '残す・注入しない'),
      '消えている');

    // 戻せる
    await api('PUT', `/memories/${off.id}`, { ...off, enabled: 1 });
    prompt = await promptOf(chat.id);
    check('ONに戻すとまた載る', prompt.includes('残す・注入しない'), '戻らない');
    await api('DELETE', `/memories/${off.id}`);
    await api('DELETE', `/memories/${on.id}`);
  }

  // 触らない更新で勝手に戻らない
  {
    const m = await mk('触らない更新の確認');
    await api('PUT', `/memories/${m.id}`, { ...m, enabled: 0 });
    const r = await api('PUT', `/memories/${m.id}`, { content: '本文だけ直す' });
    check('enabled を含まない更新では現状維持', r.json.enabled === 0, String(r.json.enabled));
    await api('DELETE', `/memories/${m.id}`);
  }

  // OFF のものも重複除けには渡す（切ったものが拾い直されない）
  {
    const m = await mk('切ったので二度と出さない');
    await api('PUT', `/memories/${m.id}`, { ...m, enabled: 0 });
    const chat = await newChat(w);
    await advance(chat.id, w, 5);
    await clearMockRequests();
    setQueue([{ text: memJson([]) }]);
    await api('POST', `/chats/${chat.id}/extract-preview`);
    const prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('OFFのメモリーも既存の記憶として渡す', prompt.includes('切ったので二度と出さない'),
      '渡していない（同じ内容が拾い直される）');
    await api('DELETE', `/memories/${m.id}`);
  }

  // 書き出し → 取り込みで保たれる
  {
    const m = await mk('書き出しでもOFFのまま');
    await api('PUT', `/memories/${m.id}`, { ...m, enabled: 0 });
    const dump = (await api('GET', `/worlds/${w.world.id}/export`)).json;
    const imported = (await api('POST', '/worlds/import', {
      ...dump, world: { ...dump.world, name: 'toggle_copy' },
    })).json;
    const copied = (await api('GET', `/worlds/${imported.world.id}/characters`)).json
      .find((c) => c.name === 'アシュリー');
    const copiedMems = (await api('GET', `/characters/${copied.id}/memories`)).json;
    check('取り込み後もOFFのまま',
      copiedMems.find((x) => x.content === '書き出しでもOFFのまま')?.enabled === 0,
      JSON.stringify(copiedMems.map((x) => [x.content, x.enabled])));
    await api('DELETE', `/memories/${m.id}`);
  }

  await api('PUT', '/settings', base);
}
