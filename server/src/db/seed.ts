import { db } from './index.js';
import { createWorld } from './repo/worlds.js';
import { createLocation } from './repo/locations.js';
import { ensureCalendar } from './repo/calendars.js';

/** §4.10 の初期投入データ。DBが空の場合のみ、場所10件と既定の暦を持つ世界を投入する */
export function seedIfEmpty(): void {
  const count = (db.prepare('SELECT COUNT(*) c FROM worlds').get() as { c: number }).c;
  if (count > 0) return;

  const world = createWorld({
    name: 'ヴェイン古書店の世界',
    description: '霧の多い港街。初期投入の場所と暦を持つ。キャラクター・ロアは未登録。',
  });
  ensureCalendar(world.id);

  const locations: {
    id: string;
    name: string;
    indoor: number;
    area: string;
    open_min: number | null;
    close_min: number | null;
    note?: string;
  }[] = [
    { id: 'vein_bookstore', name: 'ヴェイン古書店', indoor: 1, area: 'backstreet', open_min: null, close_min: null, note: '営業は不定' },
    { id: 'willow_home', name: 'ウィロウの家', indoor: 1, area: 'outskirts', open_min: null, close_min: null },
    { id: 'security_bureau', name: '王立魔術保安庁', indoor: 1, area: 'hilltop', open_min: null, close_min: null },
    { id: 'old_shield', name: '〈オールド・シールド〉', indoor: 1, area: 'hilltop', open_min: 16 * 60, close_min: 21 * 60 },
    { id: 'mumei', name: '〈無銘〉', indoor: 1, area: 'backstreet', open_min: 21 * 60, close_min: 26 * 60 },
    { id: 'marlowe', name: '〈マルロウ〉', indoor: 1, area: 'backstreet', open_min: 11 * 60, close_min: 17 * 60 },
    { id: 'lillian', name: '〈リリアン・ベーカリー〉', indoor: 1, area: 'outskirts', open_min: 5 * 60, close_min: 12 * 60 },
    { id: 'harbor', name: '港', indoor: 0, area: 'harbor', open_min: null, close_min: null },
    { id: 'main_street', name: '中央大通り', indoor: 0, area: 'center', open_min: null, close_min: null },
    { id: 'market_street', name: '市場通り', indoor: 0, area: 'center', open_min: null, close_min: null },
  ];
  for (const l of locations) {
    createLocation(world.id, { ...l, note: l.note ?? '' });
  }
  console.log(`[seed] 初期世界「${world.name}」と場所${locations.length}件を投入しました`);
}
