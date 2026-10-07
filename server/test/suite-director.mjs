// 裏の台本（§23）。
// 要は「OFFなら何も起きない（呼び出しゼロ・注入ゼロ）」と
// 「台本本体は本文に渡らず、短い指示だけが末尾に載る」こと。
import { api, check, clearMockRequests, generate, mockRequests, reply, setQueue, suite } from './harness.mjs';

const T1800 = 877 * 1440 + 18 * 60;
const HEAD = '# 物語の舵取り';

const directorText = (cue, secret = '時計塔の鐘は兄が止めた') =>
  `@@@LEDGER\n## 現在の幕と、物語の向かう先\n第一幕\n## 人物の秘密と思惑\n${secret}\n@@@CUE\n- ${cue}\n@@@END`;

async function setup(label, scenarioFlag = null) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const room = `${label}_room`;
  await api('POST', `/worlds/${world.id}/locations`, { id: room, name: '書斎', indoor: 1, area: 'center' });
  const kai = (await api('POST', `/worlds/${world.id}/characters`, { name: 'カイ' })).json;
  const scenario = (
    await api('POST', `/worlds/${world.id}/scenarios`, {
      title: 'director',
      participant_ids: [kai.id],
      opening: 'ナレーター: 書斎は静かだ。',
      director_enabled: scenarioFlag,
      initial_state: {
        time: T1800, location: room, location_note: '', weather: '晴', present: [kai.id], vars: {},
      },
    })
  ).json;
  const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;
  return { chat, room, scenario };
}

/** 1ターン。extra は本文の後に積む応答（台本更新など） */
async function turn(w, content, extra = []) {
  await clearMockRequests();
  setQueue([{ text: reply({ name: 'カイ', char: '「ああ」', elapsed: 5, location: w.room }) }, ...extra]);
  const g = await generate(w.chat.id, { content });
  const reqs = await mockRequests();
  const stream = reqs.filter((q) => q.stream).pop();
  const directorCalls = reqs.filter((q) => !q.stream && q.prompt.includes('@@@LEDGER'));
  return { g, stream, directorCalls };
}

const textOf = (m) => (Array.isArray(m.content) ? m.content.map((p) => p.text).join('') : m.content);
const tailOf = (req) => textOf(req.rawMessages.at(-1));
const dirNotices = (g) => (g.notices ?? []).filter((n) => n.kind === 'director');

export async function directorSuite() {
  suite('裏の台本');
  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', {
    auto_summarize: 0, auto_extract: 0, director_enabled: 0, director_interval: 3,
  });
  try {
    // ---- OFF（既定） ----
    const off = await setup('dr_off');
    let calls = 0;
    let injected = false;
    for (const t of ['いち', 'に', 'さん']) {
      const r = await turn(off, t);
      calls += r.directorCalls.length;
      if (tailOf(r.stream).includes(HEAD)) injected = true;
    }
    check('OFFなら台本の更新を呼ばない', calls === 0, String(calls));
    check('OFFなら本文に何も足さない', !injected);
    const offView = (await api('GET', `/chats/${off.chat.id}/director`)).json;
    check('OFFの表示', offView.enabled === false && offView.from === 'settings' && offView.note === null,
      JSON.stringify(offView));

    // ---- 会話だけON ----
    const w = await setup('dr_on');
    await api('PUT', `/chats/${w.chat.id}`, { director_enabled: 1 });

    // 冒頭（assistant）+ 1回目の応答 = 2回 → 初回の台本を作る
    const r1 = await turn(w, 'はじめよう', [{ text: directorText('カイの左手の包帯に一度だけ視線を留める') }]);
    check('初回は応答2回で台本を作る', r1.directorCalls.length === 1, String(r1.directorCalls.length));
    check('更新の通知が出る（中身は出さない）',
      dirNotices(r1.g).length === 1 && dirNotices(r1.g)[0].ok && !dirNotices(r1.g)[0].message.includes('包帯'),
      JSON.stringify(r1.g.notices));
    check('台本更新のプロンプトに本文が入る', r1.directorCalls[0]?.prompt.includes('はじめよう'));

    const v1 = (await api('GET', `/chats/${w.chat.id}/director`)).json;
    check('台本が保存される', v1.enabled && v1.from === 'chat' && v1.note?.cue.includes('包帯')
      && v1.note?.ledger.includes('兄が止めた'), JSON.stringify(v1).slice(0, 300));

    const r2 = await turn(w, 'つづけて');
    const tail2 = tailOf(r2.stream);
    check('次のターンの末尾に指示が載る', tail2.includes(HEAD) && tail2.includes('包帯'));
    const whole2 = r2.stream.rawMessages.map(textOf).join('\n');
    check('台本本体（秘密）は本文に渡さない', !whole2.includes('兄が止めた'));
    check('指示は前置き（キャッシュ層）に入らない', !textOf(r2.stream.rawMessages[0]).includes(HEAD));
    check('間隔に満たなければ更新しない', r2.directorCalls.length === 0, String(r2.directorCalls.length));

    const r3 = await turn(w, 'さらに');
    check('間隔に満たなければ更新しない（2回目）', r3.directorCalls.length === 0);
    const r4 = await turn(w, 'もっと', [{ text: directorText('窓の外で鐘が一度だけ鳴る') }]);
    check('間隔（3回）で更新する', r4.directorCalls.length === 1, String(r4.directorCalls.length));
    check('2回目の更新には前回の台本を渡す', r4.directorCalls[0]?.prompt.includes('兄が止めた'));

    // 形式が崩れた応答は保存しない
    await api('PUT', '/settings', { director_interval: 1 });
    const r5 = await turn(w, 'まだ', [{ text: 'すみません、台本は書けません。' }]);
    const n5 = dirNotices(r5.g);
    check('形式が崩れたら失敗の通知', n5.length === 1 && n5[0].ok === false, JSON.stringify(n5));
    const v5 = (await api('GET', `/chats/${w.chat.id}/director`)).json;
    check('失敗しても前の台本は残る', v5.note?.cue.includes('鐘'), JSON.stringify(v5.note));
    await api('PUT', '/settings', { director_interval: 3 });

    // 分岐は分岐点までの台本を引き継ぐ
    const msgs = (await api('GET', `/chats/${w.chat.id}`)).json.messages;
    const forked = (await api('POST', `/chats/${w.chat.id}/fork`, { message_id: msgs.at(-1).id })).json;
    const fv = (await api('GET', `/chats/${forked.id}/director`)).json;
    check('分岐先に台本とON/OFFを引き継ぐ', fv.enabled && fv.note?.cue.includes('鐘'), JSON.stringify(fv).slice(0, 200));
    const early = (await api('POST', `/chats/${w.chat.id}/fork`, { message_id: msgs[1].id })).json;
    const ev = (await api('GET', `/chats/${early.id}/director`)).json;
    check('分岐点より後に書いた台本は持ち込まない', ev.note === null, JSON.stringify(ev.note));

    // 白紙に戻す
    await api('DELETE', `/chats/${forked.id}/director`);
    const cleared = (await api('GET', `/chats/${forked.id}/director`)).json;
    check('白紙に戻せる', cleared.note === null);

    // ---- シナリオでON、会話でOFF ----
    const sc = await setup('dr_sc', 1);
    const s1 = await turn(sc, 'はじめよう', [{ text: directorText('雨の匂いを描く') }]);
    check('シナリオのONを継承する', s1.directorCalls.length === 1);
    const scView = (await api('GET', `/chats/${sc.chat.id}/director`)).json;
    check('決め手はシナリオ', scView.from === 'scenario', scView.from);
    await api('PUT', `/chats/${sc.chat.id}`, { director_enabled: 0 });
    const s2 = await turn(sc, 'つづけて');
    check('会話のOFFが優先される（注入しない）', !tailOf(s2.stream).includes(HEAD));

    // 手動更新はOFFでも動く（保存はするが注入しない）
    setQueue([{ text: directorText('手動で書いた指示') }]);
    const manual = await api('POST', `/chats/${off.chat.id}/director/refresh`);
    check('手動更新はOFFでも動く', manual.status === 200 && manual.json.view?.note?.cue.includes('手動'),
      JSON.stringify(manual.json).slice(0, 200));
    const r6 = await turn(off, 'よん');
    check('OFFのままなら手動の台本も注入しない', !tailOf(r6.stream).includes('手動'));
  } finally {
    await api('PUT', '/settings', base);
  }
}
