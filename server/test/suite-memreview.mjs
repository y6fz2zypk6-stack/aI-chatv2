// メモリーの棚卸し（§10.4）: 書き出し → 整理案 → プレビュー → 適用
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

export async function setupReviewWorld(label) {
  const world = (await api('POST', '/worlds', { name: label })).json;
  const p = `${label}_`;
  await api('POST', `/worlds/${world.id}/locations`, {
    id: `${p}inn`, name: '宿', indoor: 1, area: 'center',
  });
  const mina = (await api('POST', `/worlds/${world.id}/characters`, { name: 'ミナ' })).json;
  const toby = (await api('POST', `/worlds/${world.id}/characters`, { name: 'トビー' })).json;
  return { world, mina, toby, inn: `${p}inn` };
}

const addMem = (charId, body) => api('POST', `/characters/${charId}/memories`, body);
const memsOf = async (charId) => (await api('GET', `/characters/${charId}/memories`)).json;
const review = async (worldId) => (await api('GET', `/worlds/${worldId}/memories/review`)).json;
const preview = (worldId, plan) => api('POST', `/worlds/${worldId}/memory-plan/preview`, plan);
const apply = (worldId, plan) => api('POST', `/worlds/${worldId}/memory-plan/apply`, plan);

// ===========================================================================
export async function memReviewExportSuite(w) {
  suite('棚卸し: 書き出し');

  const a = (await addMem(w.mina.id, { content: '港で待ち合わせると約束した' })).json;
  const b = (await addMem(w.mina.id, { content: '兄が船に乗った', subject: w.toby.id })).json;
  const c = (await addMem(w.mina.id, { content: 'もう出さなくていい話' })).json;
  await api('PUT', `/memories/${c.id}`, { enabled: 0 });
  // subject に実在しないIDを入れる（保存できるのに永久に注入されない状態）
  const orphan = (await addMem(w.toby.id, { content: '幽霊タグの記憶', subject: 'ghost_id' })).json;
  await addMem(w.toby.id, { content: 'ピン留めの記憶', pinned: 1 });

  const lore = (await api('POST', `/worlds/${w.world.id}/lorebook`, { title: '港町' })).json;
  await api('PUT', `/lorebook/${lore.id}`, { ...lore, keys: ['港'], content: '港町は霧が多い。' });

  const r = await review(w.world.id);
  check('形式が分かる', r.format === 'character_chat_memory_review', r.format);
  check('世界の名前が入る', r.world.name === w.world.name, r.world.name);
  check('キャラ定義が入る', r.characters.length === 2, String(r.characters.length));
  check('キャラのpersonaを含む', 'persona' in r.characters[0], Object.keys(r.characters[0]).join(','));
  check('ロアが入る', r.lorebook.length === 1 && r.lorebook[0].keys[0] === '港',
    JSON.stringify(r.lorebook.map((e) => e.title)));

  check('メモリーはフラットな配列', Array.isArray(r.memories) && r.memories.length === 5,
    String(r.memories.length));
  check('キャラ名が添えられる',
    r.memories.every((m) => m.character_name === 'ミナ' || m.character_name === 'トビー'), '');
  check('対象タグが名前に直る',
    r.memories.find((m) => m.id === b.id)?.subject_name === 'トビー',
    r.memories.find((m) => m.id === b.id)?.subject_name);
  check('注入オフのものも含める（再提案を防ぐため）',
    r.memories.some((m) => m.id === c.id && m.enabled === 0), '');
  check('注入オフは injectable: false',
    r.memories.find((m) => m.id === c.id)?.injectable === false, '');
  check('解決できない対象は injectable: false',
    r.memories.find((m) => m.id === orphan.id)?.injectable === false, '');
  check('普通の記憶は injectable: true',
    r.memories.find((m) => m.id === a.id)?.injectable === true, '');

  check('統計: 総数', r.stats.total === 5, String(r.stats.total));
  check('統計: 注入オン', r.stats.enabled === 4, String(r.stats.enabled));
  check('統計: 注入オフ', r.stats.disabled === 1, String(r.stats.disabled));
  check('統計: 注入されない記憶を数える', r.stats.orphan_subject === 1, String(r.stats.orphan_subject));
  // 注入される3件（幽霊タグとOFFは数えない）の本文の長さ
  const want = '港で待ち合わせると約束した'.length + '兄が船に乗った'.length + 'ピン留めの記憶'.length;
  check('統計: 注入される文字数', r.stats.chars === want, `${r.stats.chars} / ${want}`);

  check('整理案の書き方を同梱する',
    typeof r.plan_format === 'string' && r.plan_format.includes('character_chat_memory_plan'), '');
  check('削除より注入オフを勧める文言がある', r.plan_format.includes('disable を勧めます'), '');

  // 別の世界のものが混ざらない
  const other = await setupReviewWorld('rv_other');
  await addMem(other.mina.id, { content: '別世界の記憶' });
  const r2 = await review(w.world.id);
  check('別の世界のメモリーは混ざらない',
    !r2.memories.some((m) => m.content === '別世界の記憶'), '');

  check('知らない世界は404',
    (await api('GET', '/worlds/nope/memories/review')).status === 404, '');

  return { a, b, c, orphan, lore, other };
}

// ===========================================================================
export async function memReviewPreviewSuite(w, seeded) {
  suite('棚卸し: プレビュー');

  const before = await review(w.world.id);

  // 何も書き換わらない
  {
    const r = await preview(w.world.id, {
      format: 'character_chat_memory_plan',
      memories: { disable: [seeded.a.id] },
    });
    check('プレビューは200', r.status === 200, JSON.stringify(r.json));
    const after = await review(w.world.id);
    check('プレビューでは何も変わらない',
      after.stats.enabled === before.stats.enabled && after.stats.chars === before.stats.chars,
      `${before.stats.enabled}/${before.stats.chars} → ${after.stats.enabled}/${after.stats.chars}`);
    check('消える中身が読める',
      r.json.rows[0].content === '港で待ち合わせると約束した', r.json.rows[0].content);
    check('キャラ名も添える', r.json.rows[0].character_name === 'ミナ', r.json.rows[0].character_name);
    check('統計の見込みが出る',
      r.json.stats.after.chars === before.stats.chars - '港で待ち合わせると約束した'.length,
      `${before.stats.chars} → ${r.json.stats.after.chars}`);
  }

  // 削除には必ず警告を添える
  {
    const r = await preview(w.world.id, { memories: { delete: [seeded.a.id] } });
    check('削除は通るが警告が出る',
      r.status === 200 && r.json.warnings.some((x) => x.includes('復活')),
      JSON.stringify(r.json.warnings));
    check('注入オフを勧める',
      r.json.warnings.some((x) => x.includes('注入オフ')), '');
  }

  // 発火条件の無いロアを警告する
  {
    const r = await preview(w.world.id, {
      lorebook: { create: [{ title: '発火しないロア', content: '本文だけ' }] },
    });
    check('keysもalwaysも無いロアを警告する',
      r.json.warnings.some((x) => x.includes('発火語')), JSON.stringify(r.json.warnings));
    const r2 = await preview(w.world.id, {
      lorebook: { create: [{ title: '発火するロア', content: '本文', keys: ['宿'] }] },
    });
    check('keysがあれば警告しない', r2.json.warnings.length === 0, JSON.stringify(r2.json.warnings));
  }

  // 幻のIDは黙って読み飛ばさない
  {
    check('未知のメモリーIDは400',
      (await preview(w.world.id, { memories: { disable: ['no_such_id'] } })).status === 400, '');
    const other = await memsOf(seeded.other.mina.id);
    const r = await preview(w.world.id, { memories: { disable: [other[0].id] } });
    check('他の世界のメモリーIDは400', r.status === 400, String(r.status));
    check('理由が読める', (r.json.error ?? '').includes('この世界にありません'), r.json.error);
    check('未知のロアIDは400',
      (await preview(w.world.id, { lorebook: { update: [{ id: 'nope', content: 'x' }] } })).status === 400, '');
    check('知らないキャラへの追加は400',
      (await preview(w.world.id, { memories: { create: [{ character_id: 'nope', content: 'x' }] } })).status === 400, '');
  }

  // 同じIDが2つの操作に出たら決められない
  {
    const r = await preview(w.world.id, {
      memories: { disable: [seeded.a.id], delete: [seeded.a.id] },
    });
    check('同じIDが複数の操作にあると400', r.status === 400, String(r.status));
    check('理由が読める', (r.json.error ?? '').includes('複数の操作'), r.json.error);
  }

  // そのほかの入力検証
  {
    check('操作が空なら400', (await preview(w.world.id, {})).status === 400, '');
    check('本文が空の追加は400',
      (await preview(w.world.id, { memories: { create: [{ character_id: w.mina.id, content: '  ' }] } })).status === 400, '');
    check('別形式のJSONは400',
      (await preview(w.world.id, { format: 'character_chat_world', memories: { disable: [seeded.a.id] } })).status === 400, '');
    const many = { memories: { disable: Array.from({ length: 501 }, (_, i) => `id${i}`) } };
    check('操作が多すぎると400', (await preview(w.world.id, many)).status === 400, '');
  }

  // 解決できない対象は常時へ落として知らせる
  {
    const r = await preview(w.world.id, {
      memories: { create: [{ character_id: w.mina.id, subject: 'ghost', content: 'x' }] },
    });
    check('解決できない対象は常時扱いにして警告',
      r.json.warnings.some((x) => x.includes('常時扱い')), JSON.stringify(r.json.warnings));
  }
}

// ===========================================================================
export async function memReviewApplySuite(w, seeded) {
  suite('棚卸し: 適用');

  // 一通りの操作が効く
  {
    const r = await apply(w.world.id, {
      format: 'character_chat_memory_plan',
      memories: {
        disable: [seeded.a.id],
        enable: [seeded.c.id],
        update: [{ id: seeded.b.id, content: '兄は南の島へ向かった' }],
        create: [{ character_id: w.mina.id, content: '統合された記憶' }],
      },
      lorebook: {
        create: [{ title: '港町の霧', keys: ['霧'], content: '港町は年中霧が出る。', category: '場所' }],
      },
    });
    check('適用は200', r.status === 200, JSON.stringify(r.json));
    check('適用件数を返す', r.json.applied.memories === 4 && r.json.applied.lorebook === 1,
      JSON.stringify(r.json.applied));

    const mems = await memsOf(w.mina.id);
    check('disable が効く', mems.find((m) => m.id === seeded.a.id)?.enabled === 0, '');
    check('enable が効く', mems.find((m) => m.id === seeded.c.id)?.enabled === 1, '');
    check('update が効く',
      mems.find((m) => m.id === seeded.b.id)?.content === '兄は南の島へ向かった', '');
    check('create が効く', mems.some((m) => m.content === '統合された記憶'), '');
    check('追加した記憶は日付不明にする（LLMの申告を信じない）',
      mems.find((m) => m.content === '統合された記憶')?.game_time === null, '');
    check('追加した記憶は手動扱い',
      mems.find((m) => m.content === '統合された記憶')?.source === 'manual', '');

    const lore = (await api('GET', `/worlds/${w.world.id}/lorebook`)).json;
    check('ロアが作られる', lore.some((e) => e.title === '港町の霧'), '');
    const made = lore.find((e) => e.title === '港町の霧');
    check('ロアの発火語が入る', made?.keys[0] === '霧', JSON.stringify(made?.keys));
    check('ロアのカテゴリが入る', made?.category === '場所', made?.category);
  }

  // 削除
  {
    const m = (await addMem(w.toby.id, { content: '消される記憶' })).json;
    const r = await apply(w.world.id, { memories: { delete: [m.id] } });
    check('delete が効く', r.status === 200 && !(await memsOf(w.toby.id)).some((x) => x.id === m.id), '');
  }

  // 途中で失敗したら全部戻る
  {
    const before = await review(w.world.id);
    const beforeLore = (await api('GET', `/worlds/${w.world.id}/lorebook`)).json.length;
    const good = (await memsOf(w.mina.id))[0];
    const r = await apply(w.world.id, {
      memories: {
        disable: [good.id],
        // 幻のIDを混ぜる。ここで弾かれるので、上の disable も適用されないはず
        delete: ['phantom_id'],
      },
    });
    check('壊れた整理案は400', r.status === 400, String(r.status));
    const after = await review(w.world.id);
    check('1件も書き換わらない',
      after.stats.enabled === before.stats.enabled && after.stats.total === before.stats.total,
      `${before.stats.enabled}/${before.stats.total} → ${after.stats.enabled}/${after.stats.total}`);
    check('ロアも増えない',
      (await api('GET', `/worlds/${w.world.id}/lorebook`)).json.length === beforeLore, '');
  }

  // 適用後の書き出しに反映される
  {
    const r = await review(w.world.id);
    check('書き出しが適用後の姿になる',
      r.memories.some((m) => m.content === '兄は南の島へ向かった') &&
        !r.memories.some((m) => m.content === '消される記憶'), '');
  }

  check('知らない世界は404',
    (await apply('nope', { memories: { disable: ['x'] } })).status === 404, '');
}

// ===========================================================================
// 端から端まで: 重複2件を1件へ統合し、次の生成のプロンプトで統合後だけが載ること。
// **プレビューではなくモックが受け取った実際のプロンプトで見る**（§9.2）
export async function memReviewEndToEndSuite(w) {
  suite('棚卸し: 統合が注入へ反映される');

  const base = (await api('GET', '/settings')).json;
  await api('PUT', '/settings', { auto_summarize: 0, auto_extract: 0 });

  const fresh = await setupReviewWorld('rv_e2e');
  const dup1 = (await addMem(fresh.mina.id, { content: '主人公に本名を教えた' })).json;
  const dup2 = (await addMem(fresh.mina.id, { content: '主人公へ自分の本名を明かした' })).json;

  const scenario = (
    await api('POST', `/worlds/${fresh.world.id}/scenarios`, {
      title: 'e2e',
      participant_ids: [fresh.mina.id],
      opening: 'ナレーター: 宿の前。',
      initial_state: {
        time: T1800, location: fresh.inn, location_note: '', weather: '晴',
        present: [fresh.mina.id], vars: {},
      },
    })
  ).json;
  const chat = (await api('POST', `/scenarios/${scenario.id}/chats`, {})).json;

  const turn = async (text) => {
    await clearMockRequests();
    setQueue([{ text: reply({ char: '「はい」', elapsed: 10, location: fresh.inn }) }]);
    await generate(chat.id, { content: text });
    return (await mockRequests()).filter((q) => q.stream).map((q) => q.prompt).join('\n');
  };

  const p1 = await turn('いち');
  check('統合前は2件とも載っている',
    p1.includes('- 主人公に本名を教えた') && p1.includes('- 主人公へ自分の本名を明かした'), '');

  const r = await apply(fresh.world.id, {
    format: 'character_chat_memory_plan',
    memories: {
      create: [{ character_id: fresh.mina.id, content: '主人公は本名を知っている' }],
      disable: [dup1.id, dup2.id],
    },
  });
  check('統合を適用できる', r.status === 200, JSON.stringify(r.json));
  check('注入される文字数が減る', r.json.stats.after.chars < r.json.stats.before.chars,
    `${r.json.stats.before.chars} → ${r.json.stats.after.chars}`);

  const p2 = await turn('に');
  check('統合後の1件だけが注入される', p2.includes('- 主人公は本名を知っている'), '');
  check('元の2件は注入されない',
    !p2.includes('- 主人公に本名を教えた') && !p2.includes('- 主人公へ自分の本名を明かした'), '');

  // 消していないので、自動抽出の重複除けには残っている（これが disable を勧める理由）
  const kept = await memsOf(fresh.mina.id);
  check('元の記憶は記録として残る',
    kept.filter((m) => m.id === dup1.id || m.id === dup2.id).length === 2, '');

  await api('PUT', '/settings', base);
}
