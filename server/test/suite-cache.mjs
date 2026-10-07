// プロンプトキャッシュ（§6.7）。
// 要は「前置きが毎ターン同じバイト列のまま残ること」。区切りの位置と、
// 毎ターン変わるもの（ロア・状況）が前置きに混ざらないことを見る。
import { api, check, clearMockRequests, generate, mockRequests, reply, setQueue, suite } from './harness.mjs';

const T1800 = 877 * 1440 + 18 * 60;

async function setup(label) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const room = `${label}_room`;
  await api('POST', `/worlds/${world.id}/locations`, { id: room, name: '書斎', indoor: 1, area: 'center' });
  const kai = (await api('POST', `/worlds/${world.id}/characters`, { name: 'カイ' })).json;
  const lore = (await api('POST', `/worlds/${world.id}/lorebook`, { title: '時計塔' })).json;
  await api('PUT', `/lorebook/${lore.id}`, {
    ...lore, keys: ['とけいとう'], content: '時計塔は百年止まったままだ。',
  });
  const scenario = (
    await api('POST', `/worlds/${world.id}/scenarios`, {
      title: 'cache',
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

async function turn(w, content) {
  await clearMockRequests();
  setQueue([{ text: reply({ name: 'カイ', char: '「ああ」', elapsed: 5, location: w.room }) }]);
  await generate(w.chat.id, { content });
  return (await mockRequests()).filter((q) => q.stream).pop();
}

const hasCache = (m) => Array.isArray(m.content) && m.content.some((p) => p.cache_control);
const textOf = (m) => (Array.isArray(m.content) ? m.content.map((p) => p.text).join('') : m.content);

export async function promptCacheSuite() {
  suite('プロンプトキャッシュ');
  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0, history_window: 12 });
  try {
    const w = await setup('pc');

    const r1 = await turn(w, 'とけいとう の話をしよう');
    const m1 = r1.rawMessages;
    check('先頭のsystemに区切りが付く', hasCache(m1[0]) && m1[0].content[0].cache_control.ttl === '1h',
      JSON.stringify(m1[0].content).slice(0, 200));
    const last = m1[m1.length - 1];
    check('末尾のsystemには区切りを付けない', last.role === 'system' && !hasCache(last));
    check('履歴の最後に区切りが付く', hasCache(m1[m1.length - 2]));
    check('区切りは4つ以内', m1.filter(hasCache).length <= 4, String(m1.filter(hasCache).length));
    check('発火ロアは末尾に入る', textOf(last).includes('時計塔は百年'));
    check('発火ロアは前置きに入らない', !textOf(m1[0]).includes('時計塔は百年'));
    check('現在の状況は末尾に入る', textOf(last).includes('# 現在の状況'));

    const r2 = await turn(w, 'つづけて');
    check('2ターン目も先頭systemが同一（キャッシュが当たる）', textOf(r2.rawMessages[0]) === textOf(m1[0]));

    // 段階窓: history_window=12 → step=4。最大16件、超えたら4件まとめて落とす。
    // 1ターン2件増えるので、満杯になってからは2ターンに1回だけ先頭がずれる
    const histLens = [];
    const firsts = [];
    for (let i = 0; i < 12; i++) {
      const r = await turn(w, `ターン${i}`);
      const hist = r.rawMessages.filter((m) => m.role !== 'system');
      histLens.push(hist.length);
      firsts.push(textOf(hist[0]));
    }
    check('履歴は窓+step件を超えない', histLens.every((n) => n <= 16), histLens.join(','));
    let shifts = 0;
    let fullTurns = 0;
    for (let i = 1; i < firsts.length; i++) {
      if (histLens[i - 1] < 12) continue;
      fullTurns++;
      if (firsts[i] !== firsts[i - 1]) shifts++;
    }
    check('満杯後も先頭は毎ターンずれない', fullTurns >= 4 && shifts * 2 <= fullTurns + 1,
      `${shifts}回 / ${fullTurns}ターン / ${histLens.join(',')}`);

    // Anthropic 以外のモデルには cache_control を送らない（自動キャッシュに任せる）。
    // 直API接続（§6.6）は connections スイートで2つ目のモックを使って見る
    await api('PUT', `/chats/${w.chat.id}`, { model: 'openai/gpt-6.1-sol' });
    const r3 = await turn(w, 'べつのモデルで');
    check('Anthropic以外のモデルには区切りを付けない',
      r3.model === 'openai/gpt-6.1-sol' && !r3.rawMessages.some(hasCache) &&
        r3.rawMessages.every((m) => typeof m.content === 'string'),
      `${r3.model} / ${r3.rawMessages.filter(hasCache).length}`);
  } finally {
    await api('PUT', '/settings', base);
  }
}
