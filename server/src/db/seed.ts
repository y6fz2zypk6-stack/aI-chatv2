import { db } from './index.js';
import { createWorld } from './repo/worlds.js';
import { createLocation } from './repo/locations.js';
import { ensureCalendar, upsertCalendar } from './repo/calendars.js';

/**
 * §4.10 の初期投入データ。DBが空の場合のみ投入する。
 *
 * 中身は「すぐ触って動きが分かる」ための足場であって、作例ではない。
 * 現代日本の学園を選んでいるのは、暦・営業時間・エリアの効き方を
 * 説明なしで確かめられるため（放課後、部活、下校時刻、店の開閉）。
 * キャラクター・ロア・シナリオは入れない。そこは利用者が作るところ。
 */
export function seedIfEmpty(): void {
  const count = (db.prepare('SELECT COUNT(*) c FROM worlds').get() as { c: number }).c;
  if (count > 0) return;

  const world = createWorld({
    name: '桜坂学園の世界',
    description:
      '現代日本の高校とその周辺。場所と暦だけが入った状態です。' +
      'キャラクター・ロアブック・シナリオを足して使ってください。',
    areas: [
      { id: 'school', name: '校内' },
      { id: 'school_ground', name: '校庭・屋外' },
      { id: 'station', name: '駅前' },
      { id: 'shopping', name: '商店街' },
      { id: 'residential', name: '住宅街' },
      { id: 'riverside', name: '川沿い' },
    ],
  });

  ensureCalendar(world.id);
  // 現代日本に合わせて暦を差し替える。既定の暦（1か月28日・終電1380分）は
  // 異世界向けなので、そのままだと日付が現実とずれて分かりにくい
  upsertCalendar(world.id, {
    months_per_year: 12,
    days_per_month: 30,
    weekdays: ['日', '月', '火', '水', '木', '金', '土'],
    seasons: { 春: [3, 4, 5], 夏: [6, 7, 8], 秋: [9, 10, 11], 冬: [12, 1, 2] },
    sun: {
      '1': { rise: '06:50', set: '16:40' },
      '4': { rise: '05:25', set: '18:10' },
      '7': { rise: '04:35', set: '19:00' },
      '10': { rise: '05:45', set: '17:15' },
    },
    last_train_enabled: 1,
    last_train_label: '終電',
    last_train_min: 23 * 60 + 40,
    last_train_notice_min: 30,
    after_last_train_text: '終電は行ってしまった。歩くか、誰かに頼るしかない。',
    weather_table: {
      春: { 晴: 45, 曇: 30, 雨: 20, 霧: 5 },
      夏: { 晴: 45, 曇: 25, 雨: 25, 雷雨: 5 },
      秋: { 晴: 50, 曇: 30, 雨: 20 },
      冬: { 晴: 40, 曇: 35, 雨: 15, 雪: 10 },
    },
  });

  const locations: {
    id: string;
    name: string;
    indoor: number;
    area: string;
    open_min: number | null;
    close_min: number | null;
    note?: string;
  }[] = [
    // 校内
    { id: 'classroom', name: '教室', indoor: 1, area: 'school', open_min: null, close_min: null },
    { id: 'hallway', name: '廊下', indoor: 1, area: 'school', open_min: null, close_min: null },
    { id: 'library', name: '図書室', indoor: 1, area: 'school', open_min: 8 * 60 + 30, close_min: 18 * 60, note: '土日は閉室' },
    { id: 'staff_room', name: '職員室', indoor: 1, area: 'school', open_min: 7 * 60 + 30, close_min: 20 * 60 },
    { id: 'music_room', name: '音楽室', indoor: 1, area: 'school', open_min: null, close_min: null, note: '旧校舎の三階。放課後は吹奏楽部が使う' },
    { id: 'infirmary', name: '保健室', indoor: 1, area: 'school', open_min: 8 * 60, close_min: 17 * 60 },
    // 校庭・屋外
    { id: 'rooftop', name: '屋上', indoor: 0, area: 'school_ground', open_min: null, close_min: null, note: '本当は立入禁止。鍵は壊れたまま' },
    { id: 'courtyard', name: '中庭', indoor: 0, area: 'school_ground', open_min: null, close_min: null },
    { id: 'schoolgate', name: '校門', indoor: 0, area: 'school_ground', open_min: null, close_min: null },
    { id: 'gym', name: '体育館', indoor: 1, area: 'school_ground', open_min: null, close_min: 19 * 60, note: '完全下校は19時' },
    // 駅前・商店街
    { id: 'station_front', name: '駅前', indoor: 0, area: 'station', open_min: null, close_min: null },
    { id: 'cafe_kotori', name: '喫茶〈ことり〉', indoor: 1, area: 'station', open_min: 10 * 60, close_min: 20 * 60 },
    { id: 'family_restaurant', name: 'ファミレス', indoor: 1, area: 'station', open_min: 7 * 60, close_min: 25 * 60 },
    { id: 'bookstore', name: '書店', indoor: 1, area: 'shopping', open_min: 10 * 60, close_min: 21 * 60 },
    { id: 'convenience_store', name: 'コンビニ', indoor: 1, area: 'shopping', open_min: 0, close_min: 24 * 60, note: '24時間営業' },
    { id: 'shopping_street', name: '商店街', indoor: 0, area: 'shopping', open_min: null, close_min: null },
    // 住宅街・川沿い
    { id: 'home', name: '自宅', indoor: 1, area: 'residential', open_min: null, close_min: null },
    { id: 'park', name: '公園', indoor: 0, area: 'residential', open_min: null, close_min: null },
    { id: 'riverbank', name: '河川敷', indoor: 0, area: 'riverside', open_min: null, close_min: null },
    { id: 'bridge', name: '橋', indoor: 0, area: 'riverside', open_min: null, close_min: null },
  ];
  for (const l of locations) {
    createLocation(world.id, { ...l, note: l.note ?? '' });
  }
  console.log(`[seed] 初期世界「${world.name}」と場所${locations.length}件を投入しました`);
}
