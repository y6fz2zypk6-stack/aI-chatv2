// 「最新」のモデル（§6.6）。`~anthropic/claude-opus-latest` のような名前は上流へそのまま送り、
// 応答の model 欄に入っている実際の版を覚える。覚えた版は画面の表示と予算（§6.5）に使う。
import { api, check, clearMockRequests, generate, mockRequests, reply, setQueue, suite } from './harness.mjs';

const T1800 = 877 * 1440 + 18 * 60;
const OPUS = '~anthropic/claude-opus-latest';
const SONNET = '~anthropic/claude-sonnet-latest';
/** モックの /models に載せていない「最新」。実際に答えた版から長さを引く経路を見る */
const HAIKU = '~anthropic/claude-haiku-latest';

async function setup(label) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const room = `${label}_room`;
  await api('POST', `/worlds/${world.id}/locations`, { id: room, name: '書斎', indoor: 1, area: 'center' });
  const kai = (await api('POST', `/worlds/${world.id}/characters`, { name: 'カイ' })).json;
  const scenario = (
    await api('POST', `/worlds/${world.id}/scenarios`, {
      title: 'latest',
      participant_ids: [kai.id],
      opening: 'ナレーター: 書斎は静かだ。',
      initial_state: {
        time: T1800, location: room, location_note: '', weather: '晴', present: [kai.id], vars: {},
      },
    })
  ).json;
  const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
  return { chat, room };
}

async function turn(w, content, extra = {}) {
  await clearMockRequests();
  setQueue([{ text: reply({ name: 'カイ', char: '「ああ」', elapsed: 5, location: w.room }), ...extra }]);
  await generate(w.chat.id, { content });
  return (await mockRequests()).filter((q) => q.stream).pop();
}

const resolved = async () => (await api('GET', '/models/resolved')).json;
const hasCache = (m) => Array.isArray(m.content) && m.content.some((p) => p.cache_control);

export async function latestModelSuite() {
  suite('「最新」のモデル');
  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });
  const budget = (ctx) => ctx - (base.max_tokens + 200) - base.context_safety_tokens;
  try {
    // 表示名の辞書（画面の候補ではない）。「最新」の名前にも名前が付いている
    const curated = (await api('GET', '/models/curated')).json;
    check('表示名の辞書に「最新」の名前がある',
      curated.slice(0, 6).every((m) => m.latest === true && /^~.+-latest$/.test(m.id) && m.label.includes('（最新）')),
      curated.slice(0, 6).map((m) => m.id).join(','));

    // 一覧（シートが並べるもの）にも「最新」の名前が載っている（本物の OpenRouter と同じ）
    const listed = (await api('GET', '/models?connection=')).json;
    check('モデルの一覧に「最新」の名前も載る', listed.some((m) => m.id === OPUS && m.context_length > 0),
      listed.filter((m) => m.id.startsWith('~')).map((m) => m.id).join(','));

    const w = await setup('lt');
    await api('PUT', `/chats/${w.chat.id}`, { model: OPUS });
    check('答える前は記録が無い', !((await resolved())[OPUS]));
    const p0 = (await api('GET', `/chats/${w.chat.id}/prompt-preview`)).json;
    check('一覧に載っている「最新」は、その長さで予算を組む', p0.inputBudget === budget(1000000),
      `${p0.inputBudget} / ${budget(1000000)}`);

    // 1回目: 上流へは「最新」の名前のまま送り、答えた版を覚える
    const r1 = await turn(w, 'こんにちは');
    check('上流へは「最新」の名前のまま送る', r1?.model === OPUS, r1?.model);
    check('「最新」の Anthropic にもキャッシュの区切りが付く', (r1?.rawMessages ?? []).some(hasCache));
    const v1 = (await resolved())[OPUS];
    check('答えた版を覚える', v1?.model === 'anthropic/claude-opus-5.5', JSON.stringify(v1));
    check('表示名は候補の名前', v1?.label === 'Opus 5.5', v1?.label);


    // 同じ版のあいだは書き直さない
    await turn(w, 'つづけて');
    const v1b = (await resolved())[OPUS];
    check('同じ版なら記録を書き直さない', v1b?.updated_at === v1?.updated_at, `${v1?.updated_at} → ${v1b?.updated_at}`);

    // 新しい版が出たら、何もしなくても記録が変わる
    await new Promise((r) => setTimeout(r, 5));
    await turn(w, 'あたらしい版', { servedModel: 'anthropic/claude-opus-5.6' });
    const v2 = (await resolved())[OPUS];
    check('新しい版が答えたら記録が変わる', v2?.model === 'anthropic/claude-opus-5.6' && v2.updated_at > v1.updated_at,
      JSON.stringify(v2));
    check('候補に無い版は一覧の名前から表示名を作る', v2?.label === 'Opus 5.6', v2?.label);

    // 予算: 一覧に「最新」の名前が無いときは、実際に答えた版の長さを使う（32k に落とさない）
    await api('PUT', `/chats/${w.chat.id}`, { model: HAIKU });
    const h0 = (await api('GET', `/chats/${w.chat.id}/prompt-preview`)).json;
    check('一覧に無い「最新」は、答える前は既定の長さ', h0.inputBudget === budget(base.fallback_context_length),
      `${h0.inputBudget} / ${budget(base.fallback_context_length)}`);
    await turn(w, 'はいくで');
    const h1 = (await api('GET', `/chats/${w.chat.id}/prompt-preview`)).json;
    check('答えた後は実際の版の長さで予算を組む', h1.inputBudget === budget(200000),
      `${h1.inputBudget} / ${budget(200000)}`);

    // 版を固定したモデルは記録しない（応答の model 欄が違っていても）
    await api('PUT', `/chats/${w.chat.id}`, { model: 'anthropic/claude-opus-5' });
    await turn(w, 'こていの版', { servedModel: 'anthropic/claude-opus-5-20260101' });
    check('版を固定したモデルは記録しない', !('anthropic/claude-opus-5' in (await resolved())));

    // 要約（非ストリーミングの呼び出し）でも覚える
    await api('PUT', '/settings', { utility_model: SONNET });
    await clearMockRequests();
    setQueue([{ text: 'これまでの出来事。' }]);
    await api('POST', `/chats/${w.chat.id}/summarize`);
    const sum = (await mockRequests()).filter((q) => !q.stream).pop();
    const v3 = (await resolved())[SONNET];
    check('要約にも「最新」の名前のまま送る', sum?.model === SONNET, sum?.model);
    check('要約の呼び出しでも答えた版を覚える', v3?.model === 'anthropic/claude-sonnet-5.5' && v3.label === 'Sonnet 5.5',
      JSON.stringify(v3));

    return { ref: OPUS, model: 'anthropic/claude-opus-5.6' };
  } finally {
    await api('PUT', '/settings', base);
  }
}

/** 再起動の後で呼ぶ。答えた版はDBに残る */
export async function latestRestoredSuite(saved) {
  suite('「最新」のモデル: 再起動後');
  const v = (await resolved())[saved.ref];
  check('再起動しても答えた版を覚えている', v?.model === saved.model, JSON.stringify(v));
}
