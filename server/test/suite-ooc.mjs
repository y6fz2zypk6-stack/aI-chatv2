// 一時指示（OOC、§10.3）。
// この機能の要は「静かに昇格しないこと」なので、混入防止のテストを厚めに置く。
import {
  api,
  check,
  clearMockRequests,
  generate,
  mockRequests,
  reply,
  setQueue,
  suite,
} from './harness.mjs';

const T1800 = 877 * 1440 + 18 * 60;
const HEAD = '# 一時的なユーザー指示';

export async function setupOocWorld(label) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const p = `${label}_`;
  await api('POST', `/worlds/${world.id}/locations`, {
    id: `${p}dock`, name: '波止場', indoor: 0, area: 'center',
  });
  const mina = (await api('POST', `/worlds/${world.id}/characters`, { name: 'ミナ' })).json;
  return { world, mina, dock: `${p}dock` };
}

async function newChat(w) {
  const scenario = (
    await api('POST', `/worlds/${w.world.id}/scenarios`, {
      title: 'ooc',
      participant_ids: [w.mina.id],
      opening: 'ナレーター: 波止場に立つ。',
      initial_state: {
        time: T1800, location: w.dock, location_note: '', weather: '晴',
        present: [w.mina.id], vars: {},
      },
    })
  ).json;
  return (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
}

const setOoc = (chatId, content, scope) =>
  api('PUT', `/chats/${chatId}/temporary-instruction`, { content, scope });
const chatOf = async (chatId) => (await api('GET', `/chats/${chatId}`)).json.chat;
const oocOf = async (chatId) => (await chatOf(chatId)).temporary_instruction;

/** 本文生成のリクエスト（stream=true）だけを拾う。要約・抽出は非ストリーミング */
const streamed = (reqs) => reqs.filter((q) => q.stream);
/** 末尾system = 最後のメッセージ。モックは messages を `\n---\n` で連結して記録する */
const tailSystem = (prompt) => prompt.split('\n---\n').pop();

/** 1ターン生成して、モックが受け取った本文生成のプロンプトを返す */
async function turn(w, chatId, content = 'つづけて', item) {
  await clearMockRequests();
  setQueue([item ?? { text: reply({ char: '「はい」', elapsed: 10, location: w.dock }) }]);
  const g = await generate(chatId, { content });
  const reqs = streamed(await mockRequests());
  return { g, prompt: reqs.map((q) => q.prompt).join('\n'), reqs };
}

// ===========================================================================
export async function oocSuite(w) {
  suite('一時指示（OOC）: 注入');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  // 未設定なら1文字も足さない
  {
    const chat = await newChat(w);
    const { prompt } = await turn(w, chat.id);
    check('未設定ならブロックが出ない', !prompt.includes(HEAD), '');
    check('既定は未設定', (await oocOf(chat.id)) === '', await oocOf(chat.id));
  }

  // 設定すると出る。複数行は箇条書きになる
  {
    const chat = await newChat(w);
    const r = await setOoc(chat.id, '今日は元気\n\nめずらしく髪を結んでいる', 'persistent');
    check('保存できる', r.status === 200, String(r.status));
    const { prompt } = await turn(w, chat.id);
    check('ブロックが注入される', prompt.includes(HEAD), '');
    check('1行目が箇条書きで入る', prompt.includes('- 今日は元気'), '');
    check('2行目も入る', prompt.includes('- めずらしく髪を結んでいる'), '');
    check('空行は捨てる', !prompt.includes('\n- \n'), '');
    check('メタ指示だと明示する',
      prompt.includes('登場人物はこの指示文自体を認識・引用・言及してはならない。'), '');

    // 末尾system の最後に置く（後ろほど強く参照される）
    const tail = tailSystem(prompt);
    check('末尾systemに入る', tail.includes(HEAD), tail.slice(0, 40));
    check('「現在の状況」より後ろ',
      tail.indexOf(HEAD) > tail.indexOf('# 現在の状況'),
      `${tail.indexOf('# 現在の状況')} → ${tail.indexOf(HEAD)}`);

    // 会話履歴には混ざらない
    const d = await api('GET', `/chats/${chat.id}`);
    check('メッセージとして保存しない',
      !d.json.messages.some((m) => m.content.includes('髪を結んでいる')),
      d.json.messages.map((m) => m.content.slice(0, 12)).join(' | '));
    const userSegments = prompt.split('\n---\n').filter((s) => s.includes('つづけて'));
    check('user メッセージに混ざらない',
      userSegments.every((s) => !s.includes('髪を結んでいる')), userSegments.join(' | '));
  }

  // 「今回の演出指示」よりも後ろに置く
  {
    const chat = await newChat(w);
    await api('POST', `/worlds/${w.world.id}/events`, {
      title: '夕暮れ', kind: 'ambient', inject_mode: 'instruction', check: 'every_turn',
      trigger: 'repeat', chance: 1, when: { time_after: '17:00' },
      inject: '夕暮れの色で書くこと。',
    });
    await setOoc(chat.id, '会話中心で', 'persistent');
    await turn(w, chat.id, 'いち'); // 1ターン目で発火させ、次ターンへ注入させる
    const { prompt } = await turn(w, chat.id, 'に');
    const tail = tailSystem(prompt);
    check('イベントの演出指示が入っている', tail.includes('# 今回の演出指示'), tail.slice(-200));
    check('一時指示は演出指示より後ろ',
      tail.indexOf(HEAD) > tail.indexOf('# 今回の演出指示'),
      `${tail.indexOf('# 今回の演出指示')} → ${tail.indexOf(HEAD)}`);
    await api('PUT', `/worlds/${w.world.id}`, { events_enabled: 0 });
  }

  // プロンプト確認からも見える
  {
    const chat = await newChat(w);
    await setOoc(chat.id, '雨がすごく強い', 'persistent');
    const p = (await api('GET', `/chats/${chat.id}/prompt-preview`)).json;
    check('プロンプト確認の「現在の状況」に出る', p.situationBlock.includes(HEAD),
      p.situationBlock.slice(-80));
  }

  // チャット間で漏れない
  {
    const a = await newChat(w);
    const b = await newChat(w);
    await setOoc(a.id, 'Aだけの指示', 'persistent');
    const { prompt } = await turn(w, b.id);
    check('別の会話へ漏れない', !prompt.includes('Aだけの指示'), '');
  }

  await api('PUT', '/settings', base);
}

// ===========================================================================
export async function oocScopeSuite(w) {
  suite('一時指示（OOC）: 有効範囲');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  // once: 正常完了で消える
  {
    const chat = await newChat(w);
    await setOoc(chat.id, '今回だけの指示', 'once');
    const { prompt } = await turn(w, chat.id);
    check('once もそのターンには効く', prompt.includes('- 今回だけの指示'), '');
    check('正常完了で消える', (await oocOf(chat.id)) === '', await oocOf(chat.id));
    const next = await turn(w, chat.id, 'つぎ');
    check('次のターンには載らない', !next.prompt.includes(HEAD), '');
  }

  // once: 停止しても残る（そのまま retry で効く）
  {
    const chat = await newChat(w);
    await setOoc(chat.id, '停止しても残る指示', 'once');
    setQueue([{ text: reply({ char: '「'.padEnd(60, 'あ') + '」', elapsed: 40, location: w.dock }), gapMs: 30 }]);
    const p = generate(chat.id, { content: 'とめる' });
    await new Promise((r) => setTimeout(r, 500));
    await api('POST', `/chats/${chat.id}/stop`);
    const g = await p;
    check('停止として保存される', g.done?.generationStatus === 'stopped', g.done?.generationStatus);
    check('停止では消えない', (await oocOf(chat.id)) === '停止しても残る指示', await oocOf(chat.id));
  }

  // once: 上流エラーでも残る
  {
    const chat = await newChat(w);
    await setOoc(chat.id, '失敗しても残る指示', 'once');
    setQueue([{ status: 500, text: 'upstream boom' }]);
    await generate(chat.id, { content: 'こわれる' });
    check('上流エラーでは消えない', (await oocOf(chat.id)) === '失敗しても残る指示', await oocOf(chat.id));

    // そのまま retry すると同じ指示が効く
    const { prompt } = await turn(w, chat.id, 'やりなおし');
    check('retry で同じ指示が効く', prompt.includes('- 失敗しても残る指示'), '');
    check('retry の完了で消える', (await oocOf(chat.id)) === '', await oocOf(chat.id));
  }

  // once: タイムアウトでも残る
  {
    const chat = await newChat(w);
    await setOoc(chat.id, 'タイムアウトでも残る', 'once');
    setQueue([{ text: reply({ char: '「届かない」', elapsed: 10, location: w.dock }), headDelayMs: 3000 }]);
    await generate(chat.id, { content: 'まつ' });
    check('タイムアウトでは消えない',
      (await oocOf(chat.id)) === 'タイムアウトでも残る', await oocOf(chat.id));
  }

  // once: 再生成では消えない（同じ場面の書き直し）
  {
    const chat = await newChat(w);
    await turn(w, chat.id, 'いち');
    await setOoc(chat.id, '再生成でも残る指示', 'once');

    await clearMockRequests();
    setQueue([{ text: reply({ char: '「二度目」', elapsed: 10, location: w.dock }) }]);
    await generate(chat.id, { regenerate: true });
    check('再生成では消えない', (await oocOf(chat.id)) === '再生成でも残る指示', await oocOf(chat.id));
    let reqs = streamed(await mockRequests());
    check('再生成にも効く', reqs.map((q) => q.prompt).join('\n').includes('- 再生成でも残る指示'), '');

    // 2回目の再生成でも効く
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「三度目」', elapsed: 10, location: w.dock }) }]);
    await generate(chat.id, { regenerate: true });
    reqs = streamed(await mockRequests());
    check('2回目の再生成にも効く',
      reqs.map((q) => q.prompt).join('\n').includes('- 再生成でも残る指示'), '');

    // 新しい発言を送ると消える
    await turn(w, chat.id, 'つぎへ');
    check('新しい発言の完了で消える', (await oocOf(chat.id)) === '', await oocOf(chat.id));
  }

  // persistent: 残り続ける
  {
    const chat = await newChat(w);
    await setOoc(chat.id, 'ずっと効く指示', 'persistent');
    await turn(w, chat.id, 'いち');
    check('正常完了後も残る', (await oocOf(chat.id)) === 'ずっと効く指示', await oocOf(chat.id));
    const { prompt } = await turn(w, chat.id, 'に');
    check('次のターンにも効く', prompt.includes('- ずっと効く指示'), '');
    const del = await api('DELETE', `/chats/${chat.id}/temporary-instruction`);
    check('手動で消せる', del.status === 200 && (await oocOf(chat.id)) === '', await oocOf(chat.id));
  }

  // 分岐は引き継ぐ
  {
    const chat = await newChat(w);
    await turn(w, chat.id, 'いち');
    await setOoc(chat.id, '分岐にも引き継ぐ', 'persistent');
    const d = await api('GET', `/chats/${chat.id}`);
    const last = d.json.messages[d.json.messages.length - 1];
    const forked = (await api('POST', `/chats/${chat.id}/fork`, { message_id: last.id })).json;
    check('分岐先にも一時指示が残る',
      forked.temporary_instruction === '分岐にも引き継ぐ', forked.temporary_instruction);
    check('分岐先の有効範囲も同じ',
      forked.temporary_instruction_scope === 'persistent', forked.temporary_instruction_scope);
  }

  // 入力の検証
  {
    const chat = await newChat(w);
    check('未知の有効範囲は400',
      (await setOoc(chat.id, 'x', 'forever')).status === 400, '');
    check('有効範囲の省略も400',
      (await api('PUT', `/chats/${chat.id}/temporary-instruction`, { content: 'x' })).status === 400, '');
    check('501文字は400',
      (await setOoc(chat.id, 'あ'.repeat(501), 'once')).status === 400, '');
    check('500文字は通る', (await setOoc(chat.id, 'あ'.repeat(500), 'once')).status === 200, '');
    check('存在しない会話は404',
      (await setOoc('nope', 'x', 'once')).status === 404, '');

    // PUT /chats/:id 経由でも壊れた値は入らない
    await api('PUT', `/chats/${chat.id}`, { temporary_instruction_scope: 'banana' });
    check('汎用の更新でも未知の有効範囲は入らない',
      (await chatOf(chat.id)).temporary_instruction_scope === 'once',
      (await chatOf(chat.id)).temporary_instruction_scope);
  }

  // 再起動をまたいで残ることは、サーバを立て直したあとで確かめる（run.mjs）
  const survivor = await newChat(w);
  await setOoc(survivor.id, '再起動しても残る指示', 'persistent');

  await api('PUT', '/settings', base);
  return { chatId: survivor.id, content: '再起動しても残る指示' };
}

/** サーバ再起動後に呼ぶ。列に入っているので当然残るが、移行の取りこぼしをここで捕まえる */
export async function oocRestoredSuite(saved) {
  suite('一時指示（OOC）: 再起動後');
  const chat = await chatOf(saved.chatId);
  check('再起動後も一時指示が残る', chat.temporary_instruction === saved.content,
    chat.temporary_instruction);
  check('再起動後も有効範囲が残る', chat.temporary_instruction_scope === 'persistent',
    chat.temporary_instruction_scope);
}

// ===========================================================================
// 要約・メモリー抽出・ロア走査へ混ざらないこと（不変条件41）
export async function oocIsolationSuite(w) {
  suite('一時指示（OOC）: 他へ混ざらない');

  const base = (await api('GET', '/settings')).json;
  const chat = await newChat(w);
  // 指示文にしか出てこない語をロアのキーに使う
  const lore = (await api('POST', `/worlds/${w.world.id}/lorebook`, { title: '銀鍵の伝説' })).json;
  await api('PUT', `/lorebook/${lore.id}`, {
    ...lore, keys: ['ぎんのかぎ'], content: '銀の鍵は封じられた扉を開く。',
  });

  await setOoc(chat.id, 'ぎんのかぎ の話題を匂わせて', 'persistent');
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });
  for (const t of ['いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち']) {
    await turn(w, chat.id, t);
  }

  // ロア: 指示文にしか無いキーでは発火しない
  {
    const { prompt } = await turn(w, chat.id, 'きゅう');
    check('一時指示は注入されている', prompt.includes('- ぎんのかぎ の話題を匂わせて'), '');
    check('一時指示のキーでロアが発火しない',
      !prompt.includes('銀の鍵は封じられた扉を開く。'),
      prompt.includes('銀鍵') ? '発火してしまった' : '');
  }

  // 要約: 指示文が要約プロンプトに現れない
  {
    await clearMockRequests();
    setQueue([{ text: 'これまでの出来事。' }]);
    await api('POST', `/chats/${chat.id}/summarize`);
    const nonStream = (await mockRequests()).filter((q) => !q.stream);
    check('要約が走った', nonStream.length > 0, `${nonStream.length}件`);
    check('要約プロンプトに指示文が入らない',
      nonStream.every((q) => !q.prompt.includes('ぎんのかぎ の話題を匂わせて')), '');
  }

  // メモリー抽出: 指示文が抽出プロンプトに現れない
  {
    await clearMockRequests();
    setQueue([{ text: JSON.stringify({ memories: [] }) }]);
    await api('POST', `/chats/${chat.id}/extract-preview`);
    const nonStream = (await mockRequests()).filter((q) => !q.stream);
    check('抽出が走った', nonStream.length > 0, `${nonStream.length}件`);
    check('抽出プロンプトに指示文が入らない',
      nonStream.every((q) => !q.prompt.includes('ぎんのかぎ の話題を匂わせて')), '');
  }

  await api('PUT', '/settings', base);
}
