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
      p.notes.some((n) => n.includes('要約・抽出の最大トークン')), JSON.stringify(p.notes));

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
    check('日付の形式を指定している（季節ではなく曜日）', p.includes('[5年9月10日(金)] の形式'));
    // 会話ログの日付マーカーもメモリーと同じ表記にする（突き合わせられるように）
    check('会話ログに曜日つきの日付マーカーが付く', p.includes('[3年8月10日(火)] '),
      p.split('\n').find((l) => /^\[\d+年/.test(l)) ?? 'マーカーが無い');
    check('日付マーカーに季節を出さない', !p.includes('(秋)'), '');
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
  check('一覧では絶対日付を返す', m?.game_time_label === '3年8月10日(火)', m?.game_time_label);

  // 同じ日なら「今日」として注入される
  await clearMockRequests();
  setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'x' });
  let prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
  check('同じ日は「今日」として注入する',
    prompt.includes('- (3年8月10日(火) / 今日) 港で待ち合わせると約束した'),
    prompt.split('\n').filter((l) => l.includes('港で')).join(' | '));

  // 日をまたぐと相対表記が動く
  const gt = (await api('GET', `/chats/${chat.id}/state`)).json.gameTime;
  await api('PUT', `/chats/${chat.id}/state`, { game_time: { ...gt, day: gt.day + 3 } });
  await clearMockRequests();
  setQueue([{ text: reply({ char: '「ええ」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'y' });
  prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
  check('3日経つと「3日前」になる',
    prompt.includes('- (3年8月10日(火) / 3日前) 港で待ち合わせると約束した'),
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

// ===========================================================================
// 要約・抽出の出力上限（本文の max_tokens とは別枠）
// ===========================================================================
export async function utilityTokensSuite(w) {
  suite('要約・抽出の最大トークン');

  const base = (await api('GET', '/settings')).json;
  const chat = await newChat(w);
  await advance(chat.id, w, 5);

  // 抽出に使われる値は utility_max_tokens。本文の max_tokens ではない
  {
    await api('PUT', '/settings', { max_tokens: 2048, utility_max_tokens: 8192 });
    await clearMockRequests();
    setQueue([{ text: memJson([]) }]);
    await api('POST', `/chats/${chat.id}/extract-preview`);
    const [call] = await mockRequests();
    check('抽出は utility_max_tokens を使う', call?.maxTokens === 8192, String(call?.maxTokens));
    check('本文の max_tokens は使わない', call?.maxTokens !== 2048, String(call?.maxTokens));
  }

  // 設定を変えると反映される
  {
    await api('PUT', '/settings', { utility_max_tokens: 16384 });
    await clearMockRequests();
    setQueue([{ text: memJson([]) }]);
    await api('POST', `/chats/${chat.id}/extract-preview`);
    const [call] = await mockRequests();
    check('設定した値が使われる', call?.maxTokens === 16384, String(call?.maxTokens));
  }

  // 要約も同じ値を使う（あらすじの必要量が上回るときはそちら）
  {
    await api('PUT', '/settings', { utility_max_tokens: 4096, summary_max_chars: 700 });
    await clearMockRequests();
    setQueue([{ text: 'あらすじ' }]);
    await api('POST', `/chats/${chat.id}/summarize`);
    const [call] = await mockRequests();
    check('要約も utility_max_tokens を使う', call?.maxTokens === 4096, String(call?.maxTokens));

    await api('PUT', '/settings', { utility_max_tokens: 1024, summary_max_chars: 3000 });
    await clearMockRequests();
    setQueue([{ text: 'あらすじ2' }]);
    await api('POST', `/chats/${chat.id}/summarize`);
    const [c2] = await mockRequests();
    check('あらすじの必要量が上回ればそちらを使う', c2?.maxTokens === 6000, String(c2?.maxTokens));
  }

  // 上限で切れたときの説明が、正しい設定項目を指す
  {
    await api('PUT', '/settings', { utility_max_tokens: 4096 });
    setQueue([{ text: '{"memories": [{"content": "とちゅ', finish: 'length' }]);
    const p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
    const note = p.notes.join(' / ');
    check('要約・抽出側の上限だと分かる', note.includes('要約・抽出の最大トークン 4096'), note);
    check('本文側の設定を案内しない', !note.includes('設定の「最大トークン」'), note);
  }

  await api('PUT', '/settings', base);
}

// ===========================================================================
// 「現在の状況」の日付と日の出・日没
// ===========================================================================
export async function situationSuite(w) {
  suite('現在の状況の日時');

  const chat = await newChat(w); // 3年8月10日 18:00 開始
  const pv = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
  const line1 = pv.situationBlock.split('\n')[1] ?? '';
  const line2 = pv.situationBlock.split('\n')[2] ?? '';

  check('1行目に年月日が入る', line1.startsWith('3年8月10日'), line1);
  check('季節・週・曜日も残っている', line1.includes('（秋・第2週の火曜日）'), line1);
  check('時刻も入る', line1.includes('18:00'), line1);
  check('場所も並ぶ', line1.includes('場所:'), line1);
  // この世界の「店」は屋内なので天候は省かれる（既存の規則）
  check('屋内では天候を出さない', !line1.includes('天候:'), line1);

  check('2行目に日照の状態が入る', /^(日の出前|日中|日没後)/.test(line2), line2);
  check('日の出の時刻が入る', /日の出 \d{2}:\d{2}/.test(line2), line2);
  check('日没の時刻が入る', /日没 \d{2}:\d{2}/.test(line2), line2);
}

// ===========================================================================
// メモリーの予算削減（1件ずつ・古い順・ピン留めは残す）
// ===========================================================================
export async function memoryBudgetSuite(w) {
  suite('メモリーの予算削減');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  // 既存のメモリーを片付けてから始める
  for (const c of [w.ashley, w.toby]) {
    for (const m of (await api('GET', `/characters/${c.id}/memories`)).json) {
      await api('DELETE', `/memories/${m.id}`);
    }
  }

  // 長めの記憶を古い順に作る。ピン留めは1件だけ
  const pad = 'あ'.repeat(300);
  const made = [];
  for (const [i, name] of ['最古', '2番目', '3番目', '最新'].entries()) {
    const m = (await api('POST', `/characters/${w.ashley.id}/memories`, {
      content: `${name}の記憶${pad}`,
    })).json;
    made.push(m);
    if (i === 0) await api('PUT', `/memories/${m.id}`, { ...m, pinned: 1 }); // 最古をピン留め
    await new Promise((r) => setTimeout(r, 5)); // created_at をずらす
  }
  const other = (await api('POST', `/characters/${w.toby.id}/memories`, {
    content: `トビーの記憶${pad}`,
  })).json;

  const chat = await newChat(w);
  const preview = async () => (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;

  // 予算に余裕があるうちは全部載る
  const full = await preview();
  check('余裕があれば全部載る', full.trimmed.memories === 0, JSON.stringify(full.trimmed));

  /**
   * 入力予算は `context − (max_tokens + 200) − safety` なので、max_tokens を動かせば
   * 予算だけを狙った値にできる。モデルのcontext長を直接書かずに済むよう、
   * いまの予算から逆算する。
   */
  const squeezeTo = async (wantTokens) => {
    await api('PUT', '/settings', {
      max_tokens: full.inputBudget + base.max_tokens - Math.round(wantTokens),
    });
    return preview();
  };
  const perMemory = Math.ceil((pad.length + 8) * 1.1); // 1件あたりの概算トークン

  // 軽く絞る → 古いものだけが落ちる
  {
    const pv = await squeezeTo(full.estimatedTokens - perMemory * 1.5);
    check('予算が足りないと削られる', pv.trimmed.memories > 0, JSON.stringify(pv.trimmed));
    check('全部は落ちない', pv.trimmed.memories < 3, `${pv.trimmed.memories}件`);
    check('ピン留めは残る', pv.system.includes('最古の記憶'), 'ピン留めが落ちている');
    check('古いものから落ちる（2番目が先に消える）',
      !pv.system.includes('2番目の記憶'), '2番目が残っている');
    check('新しいものは残る', pv.system.includes('最新の記憶'), `削減 ${pv.trimmed.memories}件`);
    // ブロックまるごとではなく1件単位であること
    check('同じキャラの他の記憶まで巻き添えにしない',
      pv.system.includes('が記憶している事実'), '見出しごと消えている');
  }

  // 限界まで絞ってもピン留めは残る
  {
    const pv = await squeezeTo(full.estimatedTokens - perMemory * 4);
    check('限界まで削ってもピン留めは残る', pv.system.includes('最古の記憶'),
      `削減 ${pv.trimmed.memories}件`);
    check('ピン留め以外は落ちる', !pv.system.includes('最新の記憶'),
      `削減 ${pv.trimmed.memories}件`);
  }

  for (const m of [...made, other]) await api('DELETE', `/memories/${m.id}`);
  await api('PUT', '/settings', base);
}

// ===========================================================================
// 参加キャラの後編集と、初期投入データ
// ===========================================================================
export async function participantsSuite(w) {
  suite('参加キャラの編集');

  const npc = (await api('POST', `/worlds/${w.world.id}/characters`, {
    name: 'サーニャ', persona: 'サーニャの人物像です', is_npc_pool: 1,
  })).json;
  // 名前がキーワード・対象キャラは未指定（＝共通）
  await api('POST', `/worlds/${w.world.id}/lorebook`, {
    title: 'サーニャの噂', keys: ['サーニャ'], content: '# サーニャ\n濃紺の髪の女性。', character_id: null,
  });

  const chat = await newChat(w);
  const sheetIn = async () => {
    const pv = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    return pv.system.includes('サーニャの人物像です');
  };

  // 準レギュラーのまま・対象キャラ未指定では注入されない（今回の調査結果の固定）
  setQueue([{ text: reply({ char: '「サーニャの話をしましょう」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'サーニャさんの話' });
  check('準レギュラー＋対象キャラ未指定では定義が載らない', (await sheetIn()) === false, '載っている');

  // 参加キャラに加えると必ず載る
  let r = await api('PUT', `/chats/${chat.id}`, {
    participant_ids: [...chat.participant_ids, npc.id],
  });
  check('参加キャラを後から足せる', r.json.participant_ids.includes(npc.id),
    JSON.stringify(r.json.participant_ids));
  check('加えると定義が載る', (await sheetIn()) === true, '載らない');

  // 外すと戻る
  r = await api('PUT', `/chats/${chat.id}`, { participant_ids: chat.participant_ids });
  check('参加キャラから外せる', !r.json.participant_ids.includes(npc.id),
    JSON.stringify(r.json.participant_ids));
  check('外すと定義も載らなくなる', (await sheetIn()) === false, 'まだ載っている');

  // 対象キャラを指定すれば、準レギュラーのままでも載る
  const entry = (await api('GET', `/worlds/${w.world.id}/lorebook`)).json
    .find((e) => e.title === 'サーニャの噂');
  await api('PUT', `/lorebook/${entry.id}`, { ...entry, character_id: npc.id });
  check('対象キャラを指定すれば準レギュラーでも載る', (await sheetIn()) === true, '載らない');

  await api('DELETE', `/lorebook/${entry.id}`);
  await api('DELETE', `/characters/${npc.id}`);
}

export async function seedSuite() {
  suite('初期投入データ');

  const worlds = (await api('GET', '/worlds')).json;
  const seeded = worlds.find((x) => x.name === '桜坂学園の世界');
  check('初期世界が入っている', !!seeded, worlds.map((x) => x.name).join(', '));
  if (!seeded) return;

  const locs = (await api('GET', `/worlds/${seeded.id}/locations`)).json;
  check('場所が入っている', locs.length >= 15, `${locs.length}件`);
  check('屋内・屋外が混ざっている',
    locs.some((l) => l.indoor === 1) && locs.some((l) => l.indoor === 0));
  check('営業時間のある場所がある', locs.some((l) => l.open_min !== null && l.close_min !== null));

  const areas = seeded.areas.map((a) => a.id);
  check('エリアが世界に登録されている', areas.length >= 4, areas.join(','));
  check('場所のエリアはすべて登録済み',
    locs.every((l) => !l.area || areas.includes(l.area)),
    locs.filter((l) => l.area && !areas.includes(l.area)).map((l) => l.id).join(','));

  const cal = (await api('GET', `/worlds/${seeded.id}/calendar`)).json;
  check('現代の暦になっている', cal.days_per_month === 30 && cal.months_per_year === 12,
    `${cal.months_per_year}ヶ月 / ${cal.days_per_month}日`);
  check('四季が12ヶ月ぶん割り当てられている',
    Object.values(cal.seasons).flat().sort((a, b) => a - b).join(',') === '1,2,3,4,5,6,7,8,9,10,11,12',
    JSON.stringify(cal.seasons));
  check('天候表が全季節ぶんある',
    Object.keys(cal.seasons).every((s) => cal.weather_table[s]),
    Object.keys(cal.weather_table).join(','));
}

// ===========================================================================
// メモリーの日付を手で設定する
// ===========================================================================
export async function memoryDateEditSuite(w) {
  suite('メモリーの日付編集');

  const cal = (await api('GET', `/worlds/${w.world.id}/calendar`)).json;
  const perDay = 1440;
  const dayOf = (y, mo, d) =>
    (((y - 1) * cal.months_per_year + (mo - 1)) * cal.days_per_month + (d - 1)) * perDay;

  const mk = async (content, body = {}) =>
    (await api('POST', `/characters/${w.ashley.id}/memories`, { content, ...body })).json;

  // 手で足したものは日付なし。あとから付けられる
  {
    const m = await mk('あとから日付を付ける');
    check('手動追加は日付なしのまま', m.game_time === null && m.game_time_parts === null,
      JSON.stringify([m.game_time, m.game_time_parts]));

    const r = await api('PUT', `/memories/${m.id}`, {
      ...m, game_time_parts: { year: 3, month: 8, day: 10 },
    });
    check('年月日で設定できる', r.json.game_time === dayOf(3, 8, 10),
      `${r.json.game_time} / 期待 ${dayOf(3, 8, 10)}`);
    check('ラベルが返る', r.json.game_time_label === '3年8月10日(火)', r.json.game_time_label);
    check('編集欄用の年月日も返る',
      JSON.stringify(r.json.game_time_parts) === JSON.stringify({ year: 3, month: 8, day: 10 }),
      JSON.stringify(r.json.game_time_parts));

    // 日付なしに戻せる
    const cleared = await api('PUT', `/memories/${m.id}`, { ...r.json, game_time_parts: null });
    check('日付なしに戻せる', cleared.json.game_time === null && cleared.json.game_time_label === '',
      JSON.stringify([cleared.json.game_time, cleared.json.game_time_label]));

    // game_time_parts を送らなければ触らない
    await api('PUT', `/memories/${m.id}`, { ...r.json, game_time_parts: { year: 3, month: 8, day: 10 } });
    const untouched = await api('PUT', `/memories/${m.id}`, { content: '本文だけ直す' });
    check('日付を送らない更新では現状維持', untouched.json.game_time === dayOf(3, 8, 10),
      String(untouched.json.game_time));
    await api('DELETE', `/memories/${m.id}`);
  }

  // 作成時にも指定できる
  {
    const m = await mk('作成時に日付を付ける', { game_time_parts: { year: 2, month: 3, day: 4 } });
    check('作成時に日付を付けられる', m.game_time === dayOf(2, 3, 4), String(m.game_time));
    check('作成時のラベルも返る', m.game_time_label === '2年3月4日(水)', m.game_time_label);
    await api('DELETE', `/memories/${m.id}`);
  }

  // 手で付けた日付が注入にも効く。絶対日付と相対表記を並べる
  {
    const chat = await newChat(w); // 3年8月10日 18:00 開始
    const m = await mk('手で付けた日付が効く', { game_time_parts: { year: 3, month: 8, day: 7 } });
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'x' });
    const prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('絶対日付＋相対表記で注入される',
      prompt.includes('- (3年8月7日(土) / 3日前) 手で付けた日付が効く'),
      prompt.split('\n').find((l) => l.includes('手で付けた')) ?? '載っていない');
    await api('DELETE', `/memories/${m.id}`);
  }

  // memories はキャラに紐づくので、より過去から始めたチャットでは未来日付になりうる
  {
    const chat = await newChat(w); // 3年8月10日 18:00 開始
    const m = await mk('まだ先の出来事', { game_time_parts: { year: 3, month: 8, day: 20 } });
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'x' });
    const prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('未来の記憶は「まだ起きていない出来事」と明示する',
      prompt.includes('- (3年8月20日(金) / まだ起きていない出来事) まだ先の出来事'),
      prompt.split('\n').find((l) => l.includes('まだ先の')) ?? '載っていない');
    await api('DELETE', `/memories/${m.id}`);
  }

  // 1年より前は相対表記が意味を持たないので絶対日付だけ
  {
    const chat = await newChat(w);
    const m = await mk('ずっと昔の出来事', { game_time_parts: { year: 1, month: 1, day: 1 } });
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: w.shop }) }]);
    await generate(chat.id, { content: 'x' });
    const prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
    check('遠い過去は絶対日付だけで注入する',
      prompt.includes('- (1年1月1日(日)) ずっと昔の出来事'),
      prompt.split('\n').find((l) => l.includes('ずっと昔')) ?? '載っていない');
    await api('DELETE', `/memories/${m.id}`);
  }
}

// ===========================================================================
// メモリーの日付は「根拠になった発話」の時刻を使う。
// 範囲が日をまたぐと、末尾に寄せていたときは数日前の出来事まで今日扱いになっていた
// ===========================================================================
export async function memoryAtSuite(w) {
  suite('メモリーの日付は根拠の発話から');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  const commit = (chatId, body) => api('POST', `/chats/${chatId}/extract/commit`, body);
  const mems = async () => (await api('GET', `/characters/${w.ashley.id}/memories`)).json;
  const find = async (content) => (await mems()).find((m) => m.content === content);

  // 10分 → 1日 → 10分。抽出範囲の中で日付が変わる会話を作る
  const chat = await newChat(w);
  setQueue([{ text: reply({ char: '「今日はここまで」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'a' });
  setQueue([{ text: reply({ narr: '一夜明けた。', char: '「おはよう」', elapsed: 1440, location: w.shop }) }]);
  await generate(chat.id, { content: 'b' });
  setQueue([{ text: reply({ char: '「そうだね」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'c' });

  const d = (await api('GET', `/chats/${chat.id}`)).json;
  const msgs = d.messages; // 抽出済み境界は0なので、全件がそのまま抽出範囲になる
  const timeAt = (n) => msgs[n - 1].state_after.time; // プロンプトの [n] は1始まり
  const last = msgs.length;
  check('範囲が日をまたいでいる', timeAt(2) !== timeAt(last), `${timeAt(2)} / ${timeAt(last)}`);

  await clearMockRequests();
  setQueue([
    {
      text: memJson([
        { subject: '', content: '初日に約束した', why: 'x', at: 2 },
        { subject: '', content: '翌日に知らされた', why: 'y' },
      ]),
    },
  ]);
  const p = (await api('POST', `/chats/${chat.id}/extract-preview`)).json;
  const prompt = (await mockRequests()).map((q) => q.prompt).join('\n');
  check('会話に発言番号を振って渡す', prompt.includes('[1] ') && prompt.includes(`[${last}] `),
    prompt.split('\n').filter((l) => l.startsWith('[')).slice(0, 3).join(' | '));
  check('本文に番号を混ぜないよう指示する', prompt.includes('[番号] を含めない'), '');

  const c1 = p.candidates.find((c) => c.content === '初日に約束した');
  const c2 = p.candidates.find((c) => c.content === '翌日に知らされた');
  check('at で指した発話の時刻になる', c1?.game_time === timeAt(2), String(c1?.game_time));
  check('根拠の発話の seq を返す', c1?.at_seq === msgs[1].seq, `${c1?.at_seq} / ${msgs[1].seq}`);
  check('at が無ければ範囲末尾に落ちる', c2?.game_time === timeAt(last), String(c2?.game_time));
  check('候補ごとに違う日付ラベルになる',
    !!c1?.game_time_label && c1.game_time_label !== c2?.game_time_label,
    `${c1?.game_time_label} / ${c2?.game_time_label}`);

  // プレビューで見た日付が、そのまま保存される
  const saved = await commit(chat.id, {
    candidates: p.candidates.map((c) => ({
      character_id: c.character_id, subject: c.subject, content: c.content, at_seq: c.at_seq,
    })),
    toSeq: p.range.toSeq,
  });
  check('候補をそのまま保存できる', saved.json.added === 2, JSON.stringify(saved.json));
  check('保存後も根拠の発話の日付になる', (await find('初日に約束した'))?.game_time === timeAt(2),
    String((await find('初日に約束した'))?.game_time));
  check('at の無い候補は範囲末尾のまま', (await find('翌日に知らされた'))?.game_time === timeAt(last),
    String((await find('翌日に知らされた'))?.game_time));

  // 端から端まで: 古い発話に紐づいた記憶は「◯日前」として入る
  await clearMockRequests();
  setQueue([{ text: reply({ char: '「ええ」', elapsed: 10, location: w.shop }) }]);
  await generate(chat.id, { content: 'd' });
  const injected = (await mockRequests()).map((q) => q.prompt).join('\n');
  check('初日の記憶は「昨日」として注入する', injected.includes('/ 昨日) 初日に約束した'),
    injected.split('\n').filter((l) => l.includes('初日に')).join(' | '));
  check('当日の記憶は「今日」として注入する', injected.includes('/ 今日) 翌日に知らされた'),
    injected.split('\n').filter((l) => l.includes('翌日に')).join(' | '));

  // 読めない at は今までどおり範囲末尾へ落とす（モデルが答えなくても劣化しない）
  {
    const c = await newChat(w);
    await advance(c.id, w, 5);
    setQueue([
      {
        text: memJson([
          { subject: '', content: 'atが0', why: 'x', at: 0 },
          { subject: '', content: 'atが範囲外', why: 'x', at: 999 },
          { subject: '', content: 'atが文字列', why: 'x', at: 'にばんめ' },
          { subject: '', content: 'atが負', why: 'x', at: -3 },
        ]),
      },
    ]);
    const pr = (await api('POST', `/chats/${c.id}/extract-preview`)).json;
    check('壊れた at は4件とも範囲末尾に落ちる',
      pr.candidates.length === 4 && pr.candidates.every((x) => x.game_time === T1800 + 50),
      JSON.stringify(pr.candidates.map((x) => [x.content, x.game_time])));
  }

  // 日付はクライアントの申告ではなくサーバがDBから引き直す
  {
    const c = await newChat(w);
    await advance(c.id, w, 5);
    const one = (await api('GET', `/chats/${c.id}`)).json;
    const firstEnd = one.messages[one.messages.length - 1].seq;
    await commit(c.id, { candidates: [], toSeq: firstEnd }); // ここまでを抽出済みにする

    await advance(c.id, w, 5);
    const two = (await api('GET', `/chats/${c.id}`)).json;
    const end = two.messages[two.messages.length - 1];
    const r = await commit(c.id, {
      candidates: [
        { character_id: w.ashley.id, subject: '', content: '抽出済みの範囲は指せない', at_seq: 2 },
        { character_id: w.ashley.id, subject: '', content: '範囲より先も指せない', at_seq: end.seq + 99 },
        { character_id: w.ashley.id, subject: '', content: '範囲内なら効く', at_seq: firstEnd + 1 },
      ],
      toSeq: end.seq,
    });
    check('3件保存できる', r.json.added === 3, JSON.stringify(r.json));
    check('抽出済みの範囲を指しても境界の時刻になる',
      (await find('抽出済みの範囲は指せない'))?.game_time === end.state_after.time,
      String((await find('抽出済みの範囲は指せない'))?.game_time));
    check('範囲より先を指しても境界の時刻になる',
      (await find('範囲より先も指せない'))?.game_time === end.state_after.time,
      String((await find('範囲より先も指せない'))?.game_time));
    const inRange = two.messages.find((m) => m.seq === firstEnd + 1);
    check('範囲内の at_seq はその発話の時刻をDBから引く',
      (await find('範囲内なら効く'))?.game_time === inRange.state_after.time,
      `${(await find('範囲内なら効く'))?.game_time} / ${inRange.state_after.time}`);
  }

  await api('PUT', '/settings', base);
}
