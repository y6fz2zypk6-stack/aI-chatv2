// 日記（§22）と「1日の区切り時刻」の改名（day_rollover_min）。
// 日記の要は「世界の1日で切ること」「居合わせた場面だけ渡すこと」「本文に混ざらないこと」
import { api, check, clearMockRequests, generate, mockRequests, reply, setQueue, suite } from './harness.mjs';

// 3年8月10日 22:00
const T2200 = 877 * 1440 + 22 * 60;

async function setup(label) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const park = `${label}_park`;
  await api('POST', `/worlds/${world.id}/locations`, { id: park, name: '公園', indoor: 0, area: 'center' });
  const kai = (await api('POST', `/worlds/${world.id}/characters`, { name: 'カイ' })).json;
  const rin = (await api('POST', `/worlds/${world.id}/characters`, { name: 'リン' })).json;
  const scenario = (
    await api('POST', `/worlds/${world.id}/scenarios`, {
      title: 'diary',
      participant_ids: [kai.id, rin.id],
      opening: 'ナレーター: 夜の公園。',
      initial_state: {
        time: T2200, location: park, location_note: '', weather: '晴', present: [kai.id], vars: {},
      },
    })
  ).json;
  const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
  return { world, chat, kai, rin, park };
}

export async function dayRolloverRenameSuite() {
  suite('1日の区切り時刻（旧 weather_rollover_min）');
  const world = (await api('POST', '/worlds', { name: 'rollover' })).json;
  // 旧キーで送っても新キーに読み替えて保存される（古い書き出しファイルの取り込みと同じ経路）
  const r = await api('PUT', `/worlds/${world.id}/calendar`, { weather_rollover_min: 120 });
  check('旧キーの値が新キーに入る', r.json.calendar.day_rollover_min === 120, JSON.stringify(r.json.calendar));
  check('旧キーは保存されない', !('weather_rollover_min' in r.json.calendar));
  const g = (await api('GET', `/worlds/${world.id}/calendar`)).json;
  check('読み直しても値が残る', g.day_rollover_min === 120, String(g.day_rollover_min));
  // 新キーがあれば旧キーより優先
  const r2 = await api('PUT', `/worlds/${world.id}/calendar`, { day_rollover_min: 300, weather_rollover_min: 60 });
  check('新旧が両方あれば新キーを使う', r2.json.calendar.day_rollover_min === 300, String(r2.json.calendar.day_rollover_min));

  const { normalizeCalendar } = await import('../dist/server/src/domain/calendar.js');
  check('DBに旧キーだけが残っていても読み替える', normalizeCalendar({ weather_rollover_min: 180 }).day_rollover_min === 180);
  check('どちらも無ければ既定の4時', normalizeCalendar({}).day_rollover_min === 240);
}

export async function diarySuite() {
  suite('日記');
  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });
  try {
    const w = await setup('dy');
    const turn = async (text, elapsed, extra = {}) => {
      setQueue([{ text: reply({ name: 'カイ', char: text, elapsed, location: w.park, ...extra }) }]);
      await generate(w.chat.id, { content: 'うん' });
    };
    await turn('「よる十一時だね」', 60); // 23:00
    await turn('「ふかよるの公園」', 120, { add: w.rin.id }); // 翌1:00（区切り前なので同じ日）
    await turn('「あさのひかり」', 300); // 6:00（次の日）

    const idx = (await api('GET', `/chats/${w.chat.id}/diary`)).json;
    check('日付は2日ぶん', idx.days.length === 2, JSON.stringify(idx.days.map((d) => d.date_label)));
    const [day1, day0] = idx.days;
    check('新しい日が先', day1.day === day0.day + 1);
    check('前日の日付表記は8月10日', day0.date_label.includes('8月10日'), day0.date_label);
    check('リンは前日の深夜から居合わせた', day0.character_ids.includes(w.rin.id));

    // カイの前日の日記: 深夜1時の場面も前日に入る
    await clearMockRequests();
    setQueue([{ text: '8月10日\n夜の公園に行った。' }]);
    const r = await api('POST', `/chats/${w.chat.id}/diary`, { character_id: w.kai.id, day: day0.day });
    check('日記が保存される', r.status === 200 && r.json.content.includes('夜の公園'), JSON.stringify(r.json));
    const p = (await mockRequests()).filter((q) => !q.stream).pop()?.prompt ?? '';
    check('深夜1時の場面が前日の日記に入る', p.includes('ふかよる'));
    check('翌朝の場面は入らない', !p.includes('あさのひかり'));
    check('時刻が添えられる', p.includes('[01:00]'), p.slice(0, 200));

    // リンは23時の場面に居合わせていない
    await clearMockRequests();
    setQueue([{ text: 'きょうのこと。' }]);
    await api('POST', `/chats/${w.chat.id}/diary`, { character_id: w.rin.id, day: day0.day, length: 'short' });
    const pr = (await mockRequests()).filter((q) => !q.stream).pop()?.prompt ?? '';
    check('居合わせた場面だけを渡す', pr.includes('ふかよる') && !pr.includes('よる十一時'));
    check('長さの指定が効く', pr.includes('300文字'));

    // 書き直しは上書き（1キャラ1日1件）
    setQueue([{ text: '書き直した日記。' }]);
    const again = await api('POST', `/chats/${w.chat.id}/diary`, { character_id: w.kai.id, day: day0.day });
    const idx2 = (await api('GET', `/chats/${w.chat.id}/diary`)).json;
    check('書き直しは同じ1件を上書きする',
      again.json.id === r.json.id && idx2.entries.filter((e) => e.character_id === w.kai.id).length === 1);

    // 居合わせなかった日は書けない
    const none = await api('POST', `/chats/${w.chat.id}/diary`, { character_id: w.rin.id, day: day0.day - 5 });
    check('居合わせていない日は 400', none.status === 400, String(none.status));

    // 編集
    const ed = await api('PUT', `/diaries/${r.json.id}`, { content: '手で直した。' });
    check('編集できる', ed.json.content === '手で直した。');

    // 本文の生成には混ざらない
    await clearMockRequests();
    await turn('「つぎのひ」', 10);
    const gen = (await mockRequests()).filter((q) => q.stream).pop()?.prompt ?? '';
    check('日記は本文のプロンプトに載らない', !gen.includes('手で直した') && !gen.includes('きょうのこと'));

    const del = await api('DELETE', `/diaries/${r.json.id}`);
    const idx3 = (await api('GET', `/chats/${w.chat.id}/diary`)).json;
    check('削除できる', del.status === 200 && !idx3.entries.some((e) => e.id === r.json.id));
  } finally {
    await api('PUT', '/settings', base);
  }
}
