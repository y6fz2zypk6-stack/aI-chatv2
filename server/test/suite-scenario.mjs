// シナリオの開始時刻（§4.5）。年月日時分で受け、通算分への変換はサーバだけが行う
import { api, check, suite } from './harness.mjs';

/** 既定の暦は12か月×28日。formula を変えたら気づけるよう、期待値を1つ直書きする */
const DAYS_PER_MONTH = 28;
const MONTHS_PER_YEAR = 12;
const minutesOf = (y, mo, d, hh, mm) =>
  ((y - 1) * MONTHS_PER_YEAR * DAYS_PER_MONTH + (mo - 1) * DAYS_PER_MONTH + (d - 1)) * 1440 +
  hh * 60 +
  mm;

export async function scenarioTimeSuite(w) {
  suite('シナリオの開始時刻');

  const gt = { year: 3, month: 8, day: 10, hh: 18, mm: 0 };
  const expected = minutesOf(3, 8, 10, 18, 0);
  check('期待値の計算が既定の暦と合っている', expected === 877 * 1440 + 18 * 60, String(expected));

  // 作成時から効く
  const created = (
    await api('POST', `/worlds/${w.world.id}/scenarios`, {
      title: '時刻テスト',
      initial_state: { location: w.shop, present: [], game_time: gt },
    })
  ).json;
  check('POST で年月日から通算分になる', created.initial_state.time === expected,
    `${created.initial_state.time} vs ${expected}`);
  check('POST の応答が年月日を添えて返る',
    created.initial_game_time?.year === 3 && created.initial_game_time?.month === 8 &&
      created.initial_game_time?.day === 10 && created.initial_game_time?.hh === 18,
    JSON.stringify(created.initial_game_time));
  check('曜日・季節も添う',
    !!created.initial_game_time?.weekday && !!created.initial_game_time?.season,
    JSON.stringify(created.initial_game_time));

  // **派生値をDBへ焼き付けない**
  check('game_time は保存されない', created.initial_state.game_time === undefined,
    JSON.stringify(Object.keys(created.initial_state)));

  // 一覧にも添う
  const listed = (await api('GET', `/worlds/${w.world.id}/scenarios`)).json.find(
    (s) => s.id === created.id,
  );
  check('一覧にも年月日が添う', listed.initial_game_time?.day === 10,
    JSON.stringify(listed.initial_game_time));
  check('一覧でも game_time は保存されていない',
    listed.initial_state.game_time === undefined, JSON.stringify(Object.keys(listed.initial_state)));

  // 更新
  const updated = (
    await api('PUT', `/scenarios/${created.id}`, {
      ...listed,
      initial_state: { ...listed.initial_state, game_time: { year: 1, month: 1, day: 1, hh: 9, mm: 30 } },
    })
  ).json;
  check('PUT で書き換わる', updated.initial_state.time === minutesOf(1, 1, 1, 9, 30),
    `${updated.initial_state.time} vs ${minutesOf(1, 1, 1, 9, 30)}`);
  check('1年1月1日0:00 は0分', minutesOf(1, 1, 1, 0, 0) === 0);
  check('PUT の応答も年月日つき',
    updated.initial_game_time.hh === 9 && updated.initial_game_time.mm === 30,
    JSON.stringify(updated.initial_game_time));

  const reread = (await api('GET', `/worlds/${w.world.id}/scenarios`)).json.find(
    (s) => s.id === created.id,
  );
  check('引き直しても game_time は無い', reread.initial_state.game_time === undefined,
    JSON.stringify(Object.keys(reread.initial_state)));
  check('場所などは巻き添えで消えない', reread.initial_state.location === w.shop,
    reread.initial_state.location);

  // 5つ揃っていなければ無視する（書き出し・取り込みの経路を壊さない）
  {
    const before = reread.initial_state.time;
    const partial = (
      await api('PUT', `/scenarios/${created.id}`, {
        ...reread,
        initial_state: { ...reread.initial_state, game_time: { year: 5, month: 2 } },
      })
    ).json;
    check('欠けた game_time は無視する', partial.initial_state.time === before,
      `${partial.initial_state.time} vs ${before}`);

    const direct = (
      await api('PUT', `/scenarios/${created.id}`, {
        ...reread,
        initial_state: { ...reread.initial_state, time: 12345 },
      })
    ).json;
    check('time の直接指定は従来どおり通る', direct.initial_state.time === 12345,
      String(direct.initial_state.time));
  }

  // 端から端まで: そのシナリオから始めた会話の時刻
  {
    await api('PUT', `/scenarios/${created.id}`, {
      ...reread,
      participant_ids: [w.ashley.id],
      initial_state: { ...reread.initial_state, present: [w.ashley.id], game_time: gt },
    });
    const chat = (await api('POST', `/scenarios/${created.id}/chats`, {})).json;
    const d = (await api('GET', `/chats/${chat.id}`)).json;
    check('会話の開始時刻が指定どおり', d.chat.state.time === expected,
      `${d.chat.state.time} vs ${expected}`);
    check('会話のゲーム内日付が 3年8月10日18:00',
      d.gameTime.year === 3 && d.gameTime.month === 8 && d.gameTime.day === 10 &&
        d.gameTime.hh === 18 && d.gameTime.mm === 0,
      JSON.stringify(d.gameTime));
    await api('DELETE', `/chats/${chat.id}`);
  }

  await api('DELETE', `/scenarios/${created.id}`);
}
