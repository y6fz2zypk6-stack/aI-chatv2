// 接続先（§6.6）: OpenAI互換の直APIへ振り分ける
import {
  api,
  check,
  clearMockRequests,
  clearMockRequests2,
  generate,
  mockRequests,
  mockRequests2,
  reply,
  setQueue,
  setQueue2,
  suite,
} from './harness.mjs';

const T1800 = 877 * 1440 + 18 * 60;

const conns = async () => (await api('GET', '/connections')).json;
const findConn = async (name) => (await conns()).find((c) => c.name === name);

// ===========================================================================
export async function connectionCrudSuite() {
  suite('接続先: 登録と検証');

  // 組み込みは常に一覧の先頭にいる
  {
    const list = await conns();
    const builtin = list.find((c) => c.builtin);
    check('組み込みが一覧にある', !!builtin && builtin.id === '', JSON.stringify(builtin?.id));
    check('組み込みの名前が分かる', (builtin?.name ?? '').includes('OpenRouter'), builtin?.name);
    check('組み込みにもキーの有無が出る', builtin?.has_key === true, String(builtin?.has_key));
    check('組み込みは使用中扱い（消させない）', builtin?.in_use === true, '');
  }

  // 作成と検証
  {
    const r = await api('POST', '/connections', {
      name: 'テスト接続', base_url: 'https://example.test/v1/', api_key: 'sk-abcd1234',
    });
    check('作成は201', r.status === 201, String(r.status));
    check('末尾のスラッシュを落とす', r.json.base_url === 'https://example.test/v1', r.json.base_url);

    // ★ この機能の要: キーを返さない
    check('api_key をレスポンスに載せない', !('api_key' in r.json), Object.keys(r.json).join(','));
    check('設定済みかは分かる', r.json.has_key === true, '');
    check('末尾4文字だけ見せる', r.json.key_hint === '••••1234', r.json.key_hint);

    const list = await conns();
    check('一覧にも api_key が無い', list.every((c) => !('api_key' in c)), '');

    check('名前が空なら400',
      (await api('POST', '/connections', { name: ' ', base_url: 'https://a.test/v1' })).status === 400, '');
    check('URLが空なら400',
      (await api('POST', '/connections', { name: 'x', base_url: '' })).status === 400, '');
    check('http(s) 以外は400',
      (await api('POST', '/connections', { name: 'x', base_url: 'ftp://a.test' })).status === 400, '');
  }

  // 更新: キーを省略したら現状維持、空文字で消す
  {
    const c = await findConn('テスト接続');
    const r = await api('PUT', `/connections/${c.id}`, { name: 'テスト接続2' });
    check('名前を変えられる', r.json.name === 'テスト接続2', r.json.name);
    check('キーを省略したら現状維持', r.json.key_hint === '••••1234', r.json.key_hint);

    const r2 = await api('PUT', `/connections/${c.id}`, { api_key: '' });
    check('空文字で消せる', r2.json.has_key === false && r2.json.key_hint === '', r2.json.key_hint);

    await api('PUT', `/connections/${c.id}`, { api_key: 'sk-zzzz9999' });
    check('入れ直せる', (await findConn('テスト接続2'))?.key_hint === '••••9999', '');

    check('URLが不正な更新は400',
      (await api('PUT', `/connections/${c.id}`, { base_url: 'nope' })).status === 400, '');
    check('名前が空の更新は400',
      (await api('PUT', `/connections/${c.id}`, { name: '' })).status === 400, '');
    check('知らないIDは404',
      (await api('PUT', '/connections/nope', { name: 'x' })).status === 404, '');
  }

  // 組み込みは編集も削除もできない
  {
    check('組み込みへのPUTは404扱い',
      (await api('PUT', '/connections/', { name: 'x' })).status === 404, '');
    check('組み込みのDELETEは404扱い',
      (await api('DELETE', '/connections/')).status === 404, '');
  }

  // 削除
  {
    const c = await findConn('テスト接続2');
    check('使っていなければ消せる', (await api('DELETE', `/connections/${c.id}`)).status === 200, '');
    check('消えている', !(await findConn('テスト接続2')), '');
    check('もう一度消すと404', (await api('DELETE', `/connections/${c.id}`)).status === 404, '');
  }
}

// ===========================================================================
export async function connectionRoutingSuite(mock2Port) {
  suite('接続先: 振り分け');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  const url2 = `http://localhost:${mock2Port}/v1`;
  const created = (await api('POST', '/connections', {
    name: '2つ目のモック', base_url: url2, api_key: 'sk-second-key', context_length: 8000,
  })).json;
  const CONN = created.id;

  // 疎通確認
  {
    const ok = await api('POST', `/connections/${CONN}/test`);
    check('接続を試せる', ok.json.ok === true, JSON.stringify(ok.json));
    check('モデル件数を返す', ok.json.count > 0, String(ok.json.count));

    const bad = (await api('POST', '/connections', {
      name: '壊れた接続', base_url: 'http://127.0.0.1:1/v1', api_key: 'x',
    })).json;
    const ng = await api('POST', `/connections/${bad.id}/test`);
    check('繋がらない接続は ok:false', ng.json.ok === false, JSON.stringify(ng.json));
    check('理由が読める', (ng.json.message ?? '').length > 0, ng.json.message);
    await api('DELETE', `/connections/${bad.id}`);
  }

  // 世界とチャットを用意
  const world = (await api('POST', '/worlds', { name: 'conn' })).json;
  await api('POST', `/worlds/${world.id}/locations`, {
    id: 'conn_room', name: '部屋', indoor: 1, area: 'center',
  });
  const mina = (await api('POST', `/worlds/${world.id}/characters`, { name: 'ミナ' })).json;
  const scenario = (await api('POST', `/worlds/${world.id}/scenarios`, {
    title: 'conn', participant_ids: [mina.id], opening: 'ナレーター: 部屋。',
    initial_state: { time: T1800, location: 'conn_room', location_note: '', weather: '晴',
      present: [mina.id], vars: {} },
  })).json;
  const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;

  const answer = reply({ char: '「はい」', elapsed: 10, location: 'conn_room' });

  // 既定（組み込み）は1つ目のモックへ
  {
    await clearMockRequests();
    await clearMockRequests2();
    setQueue([{ text: answer }]);
    await generate(chat.id, { content: 'いち' });
    const r1 = await mockRequests();
    const r2 = await mockRequests2();
    check('組み込みは1つ目のモックへ届く', r1.length === 1 && r2.length === 0,
      `mock1=${r1.length} mock2=${r2.length}`);
    check('組み込みのキーで呼ばれる', r1[0].auth === 'Bearer test', r1[0].auth);
    check('モデルIDがそのまま渡る', r1[0].model === 'anthropic/claude-opus-5', r1[0].model);
    check('組み込みには OpenRouter 固有ヘッダが付く',
      !!r1[0].referer && !!r1[0].title, `${r1[0].referer} / ${r1[0].title}`);
  }

  // 接続先を指定すると2つ目のモックへ
  {
    await api('PUT', `/chats/${chat.id}`, { model: `${CONN}::local-llama` });
    await clearMockRequests();
    await clearMockRequests2();
    setQueue2([{ text: answer }]);
    await generate(chat.id, { content: 'に' });
    const r1 = await mockRequests();
    const r2 = await mockRequests2();
    check('登録した接続先は2つ目のモックへ届く', r2.length === 1 && r1.length === 0,
      `mock1=${r1.length} mock2=${r2.length}`);
    check('その接続先のキーで呼ばれる', r2[0].auth === 'Bearer sk-second-key', r2[0].auth);
    check('接続先IDを外した素のモデルIDを送る', r2[0].model === 'local-llama', r2[0].model);
    check('組み込み以外に OpenRouter 固有ヘッダは付けない',
      !r2[0].referer && !r2[0].title, `${r2[0].referer} / ${r2[0].title}`);
  }

  // プロンプトキャッシュの区切り（§6.7）は OpenRouter 経由の Anthropic だけ。
  // 自前の接続先には、モデル名が anthropic/ でも未知のフィールドを送らない
  {
    await api('PUT', `/chats/${chat.id}`, { model: `${CONN}::anthropic/claude-local` });
    await clearMockRequests2();
    setQueue2([{ text: answer }]);
    await generate(chat.id, { content: 'さん' });
    const r2 = await mockRequests2();
    const raw = r2[0]?.rawMessages ?? [];
    check('接続先には cache_control を送らない',
      raw.length > 0 && raw.every((m) => typeof m.content === 'string'),
      JSON.stringify(raw.map((m) => typeof m.content)));
    await api('PUT', `/chats/${chat.id}`, { model: `${CONN}::local-llama` });
  }

  // 要約・抽出（utility_model）も振り分く
  {
    await api('PUT', '/settings', { utility_model: `${CONN}::local-small` });
    await clearMockRequests();
    await clearMockRequests2();
    setQueue2([{ text: 'これまでの出来事。' }]);
    await api('POST', `/chats/${chat.id}/summarize`);
    const r2 = (await mockRequests2()).filter((q) => !q.stream);
    check('要約も接続先へ振り分く', r2.length === 1, `${r2.length}件`);
    check('要約もその接続先のキーで呼ばれる', r2[0]?.auth === 'Bearer sk-second-key', r2[0]?.auth);
    check('要約のモデルIDも素の形', r2[0]?.model === 'local-small', r2[0]?.model);
    await api('PUT', '/settings', { utility_model: base.utility_model });
  }

  // 接続先ごとの context_length が予算に効く
  {
    const p = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    // 8000 - (max_tokens + 200) - context_safety_tokens
    const want = 8000 - (base.max_tokens + 200) - base.context_safety_tokens;
    check('接続先の context_length が予算に効く', p.inputBudget === want,
      `${p.inputBudget} / ${want}`);
  }

  // 使用中は消せない
  {
    const r = await api('DELETE', `/connections/${CONN}`);
    check('使用中の削除は409', r.status === 409, String(r.status));
    check('どこで使われているか分かる',
      (r.json.error ?? '').includes('使用中') && Array.isArray(r.json.usage) && r.json.usage.length > 0,
      JSON.stringify(r.json.usage));
    const list = await conns();
    check('一覧でも使用中と分かる', list.find((c) => c.id === CONN)?.in_use === true, '');
  }

  // 既存の値（`::` 無し）は組み込みへ落ちる — 回帰
  {
    await api('PUT', `/chats/${chat.id}`, { model: 'anthropic/claude-opus-5' });
    await clearMockRequests();
    await clearMockRequests2();
    setQueue([{ text: answer }]);
    await generate(chat.id, { content: 'さん' });
    check('`::` 無しの既存値は組み込みへ落ちる',
      (await mockRequests()).length === 1 && (await mockRequests2()).length === 0, '');
  }

  // 消された接続先を指したまま生成すると、理由の分かるエラーになる
  {
    await api('PUT', `/chats/${chat.id}`, { model: 'no_such_conn::x' });
    const g = await generate(chat.id, { content: 'よん' });
    check('知らない接続先は黙って組み込みへ落とさない',
      (g.error ?? '').includes('接続先が見つかりません'), g.error ?? '(エラーなし)');
    await api('PUT', `/chats/${chat.id}`, { model: '' });
  }

  // キーが未設定の接続先は、接続先名を添えて止まる
  {
    const nokey = (await api('POST', '/connections', {
      name: 'キー無し', base_url: url2,
    })).json;
    await api('PUT', `/chats/${chat.id}`, { model: `${nokey.id}::x` });
    const g = await generate(chat.id, { content: 'ご' });
    check('キー未設定は接続先名を添えて止まる',
      (g.error ?? '').includes('キー無し') && (g.error ?? '').includes('APIキー'),
      g.error ?? '(エラーなし)');
    await api('PUT', `/chats/${chat.id}`, { model: '' });
    await api('DELETE', `/connections/${nokey.id}`);
  }

  // 「既定（.env の設定）」を選ぶと行が消え、環境変数へ戻る
  {
    await api('PUT', '/settings', { default_model: 'openai/gpt-6-astra' });
    check('いったん上書きできる',
      (await api('GET', '/settings')).json.default_model === 'openai/gpt-6-astra', '');
    await api('PUT', '/settings', { default_model: '' });
    check('空文字なら .env の既定へ戻る（空文字を焼き付けない）',
      (await api('GET', '/settings')).json.default_model === 'anthropic/claude-opus-5',
      (await api('GET', '/settings')).json.default_model);
  }

  await api('PUT', '/settings', base);
}
