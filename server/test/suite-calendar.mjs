// 自由な季節名（雨季・乾季など）と、暦の書き間違いの検出（§12.1）
import { api, check, generate, reply, setQueue, suite } from './harness.mjs';
import { newChat, setupWorld } from './suites.mjs';

/** 12か月ぶんを2つに割る */
const DRY = [1, 2, 3, 4, 5, 6];
const WET = [7, 8, 9, 10, 11, 12];

const putCalendar = (worldId, patch) => api('PUT', `/worlds/${worldId}/calendar`, patch);

export async function calendarSeasonSuite() {
  suite('自由な季節');

  const w = await setupWorld('cal');

  // 既定の暦は警告ゼロであること（これが崩れると検証がノイズになる）
  {
    const r = (await api('GET', `/worlds/${w.world.id}/calendar/warnings`)).json;
    check('既定の暦は警告ゼロ', r.warnings.length === 0, JSON.stringify(r.warnings));
  }

  // 春夏秋冬を捨てて乾季・雨季にする
  {
    const r = await putCalendar(w.world.id, {
      seasons: { 乾季: DRY, 雨季: WET },
      weather_table: { 乾季: { 晴: 80, 曇: 20 }, 雨季: { 雨: 90, 曇: 10 } },
    });
    check('保存できる', r.status === 200, String(r.status));
    check('応答は calendar と warnings に分かれる',
      !!r.json.calendar && Array.isArray(r.json.warnings), JSON.stringify(Object.keys(r.json)));
    check('春夏秋冬は消える',
      JSON.stringify(Object.keys(r.json.calendar.seasons)) === JSON.stringify(['乾季', '雨季']),
      JSON.stringify(Object.keys(r.json.calendar.seasons)));
    check('正しく書けていれば警告ゼロ', r.json.warnings.length === 0, JSON.stringify(r.json.warnings));

    const got = (await api('GET', `/worlds/${w.world.id}/calendar`)).json;
    check('GET の形は変わらない（calendar そのもの）', got.seasons?.雨季?.length === 6,
      JSON.stringify(Object.keys(got)).slice(0, 80));
    // **warnings を送り返してきても保存しない**（浅いマージの罠。§4.5 の game_time と同じ）
    await putCalendar(w.world.id, { ...got, warnings: ['ゴミ'] });
    const again = (await api('GET', `/worlds/${w.world.id}/calendar`)).json;
    check('warnings はDBへ焼き付かない', again.warnings === undefined,
      JSON.stringify(Object.keys(again)));
  }

  // 雨季の月へ日付をまたぐと、雨季の表から引かれる
  {
    // 8月10日 = 雨季。そこから日付をまたぐ
    const { chat } = await newChat(w, { time: 877 * 1440 + 23 * 60 });
    setQueue([{ text: reply({ char: '「夜更けです」', elapsed: 300, location: w.shop }) }]);
    const g = await generate(chat.id, { content: 't' });
    const state = (await api('GET', `/chats/${chat.id}/state`)).json;
    check('雨季の表から引かれる（雨か曇）', ['雨', '曇'].includes(state.state.weather),
      state.state.weather);
    check('季節名が雨季になる', state.gameTime.season === '雨季', state.gameTime.season);
    check('余計な警告は出さない',
      !(g.done?.warnings ?? []).some((x) => x.includes('天候表')),
      JSON.stringify(g.done?.warnings));
  }

  // 天候表を消すと、**別の季節の表に落ちず晴**になり、警告が出る
  {
    await putCalendar(w.world.id, {
      weather_table: { 乾季: { 雪: 100 } }, // 雨季の表を消す。乾季は雪100（落ちたら分かる）
    });
    const warn = (await api('GET', `/worlds/${w.world.id}/calendar/warnings`)).json.warnings;
    check('表の無い季節を指摘する', warn.some((x) => x.includes('雨季') && x.includes('天候表')),
      JSON.stringify(warn));

    const { chat } = await newChat(w, { time: 877 * 1440 + 23 * 60 });
    setQueue([{ text: reply({ char: '「夜更けです」', elapsed: 300, location: w.shop }) }]);
    const g = await generate(chat.id, { content: 't' });
    const state = (await api('GET', `/chats/${chat.id}/state`)).json;
    check('先頭の表（乾季=雪）に落ちない', state.state.weather !== '雪', state.state.weather);
    check('晴に固定される', state.state.weather === '晴', state.state.weather);
    check('引けなかったことを警告する',
      (g.done?.warnings ?? []).some((x) => x.includes('天候表がありません')),
      JSON.stringify(g.done?.warnings));
  }

  // どの季節にも属さない月
  {
    const r = await putCalendar(w.world.id, {
      seasons: { 乾季: [1, 2, 3, 4, 5], 雨季: WET }, // 6月が抜けている
      weather_table: { 乾季: { 晴: 100 }, 雨季: { 雨: 100 } },
    });
    check('未割当の月を指摘する',
      r.json.warnings.some((x) => x.includes('6') && x.includes('どの季節にも')),
      JSON.stringify(r.json.warnings));
  }

  // 検証の残り
  {
    const cases = [
      [
        '暦の外の月番号',
        { seasons: { 乾季: [1, 2, 3, 4, 5, 6, 13], 雨季: WET }, weather_table: { 乾季: { 晴: 1 }, 雨季: { 雨: 1 } } },
        '13',
      ],
      [
        '月の重複',
        { seasons: { 乾季: [1, 2, 3, 4, 5, 6, 7], 雨季: WET }, weather_table: { 乾季: { 晴: 1 }, 雨季: { 雨: 1 } } },
        '両方に入っています',
      ],
      [
        '対応する季節の無い天候表',
        { seasons: { 乾季: DRY, 雨季: WET }, weather_table: { 乾季: { 晴: 1 }, 雨季: { 雨: 1 }, 春: { 霧: 1 } } },
        '使われません',
      ],
      [
        '重みが全て0',
        { seasons: { 乾季: DRY, 雨季: WET }, weather_table: { 乾季: { 晴: 0 }, 雨季: { 雨: 1 } } },
        '重みが全て0',
      ],
    ];
    for (const [label, patch, needle] of cases) {
      const r = await putCalendar(w.world.id, patch);
      check(`${label}を指摘する`, r.json.warnings.some((x) => x.includes(needle)),
        JSON.stringify(r.json.warnings));
      check(`${label}でも保存は通る`, r.status === 200, String(r.status));
    }
  }

  // 1か月だけの季節も作れる
  {
    const r = await putCalendar(w.world.id, {
      seasons: { 乾季: [1, 2, 3, 4, 5, 6, 7, 8], 台風期: [9], 雨季: [10, 11, 12] },
      weather_table: { 乾季: { 晴: 1 }, 台風期: { 嵐: 1 }, 雨季: { 雨: 1 } },
    });
    check('1か月だけの季節も作れる', r.json.warnings.length === 0, JSON.stringify(r.json.warnings));

    const { chat } = await newChat(w, { time: (2 * 336 + 8 * 28 + 9) * 1440 + 12 * 60 });
    const state = (await api('GET', `/chats/${chat.id}/state`)).json;
    check('9月は台風期になる', state.gameTime.season === '台風期',
      `${state.gameTime.month}月 / ${state.gameTime.season}`);
  }

  const missing = await api('GET', '/worlds/nope/calendar/warnings');
  check('知らない世界は404', missing.status === 404, String(missing.status));
}
