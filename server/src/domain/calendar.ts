import { parseHhmm, type CalendarConfig, type GameTime } from '../../../shared/types.js';

// 時刻の演算・変換はこのモジュールに一本化する。
// それ以外の場所で時刻演算を書くことを禁止する（§4.12）。
// 内部表現は「暦元期（1年1月1日 00:00）からの通算分（整数）」のみ。

export const MIN_PER_DAY = 1440;

/** §4.12 の既定暦 + §8.2 の既定天候テーブル */
export const DEFAULT_CALENDAR: CalendarConfig = {
  months_per_year: 12,
  days_per_month: 28,
  weekdays: ['日', '月', '火', '水', '木', '金', '土'],
  seasons: { 春: [3, 4], 夏: [5, 6], 秋: [7, 8, 9], 冬: [10, 11, 12, 1, 2] },
  sun: {
    '1': { rise: '08:10', set: '16:20' },
    '7': { rise: '05:20', set: '20:40' },
  },
  last_train_enabled: 1,
  last_train_label: '終電',
  last_train_min: 1380,
  last_train_notice_min: 60,
  after_last_train_text: '終電は終了。帰りは徒歩か辻馬車になる。',
  weather_table: {
    春: { 霧: 40, 雨: 30, 曇: 20, 晴: 10 },
    夏: { 晴: 50, 曇: 30, 雨: 20 },
    秋: { 晴: 50, 曇: 30, 雨: 20 },
    冬: { 雨: 30, みぞれ: 25, 曇: 25, 雪: 10, 晴: 10 },
  },
};

export function normalizeCalendar(partial: Partial<CalendarConfig> | null | undefined): CalendarConfig {
  return { ...DEFAULT_CALENDAR, ...(partial ?? {}) };
}

function minutesPerYear(cfg: CalendarConfig): number {
  return cfg.months_per_year * cfg.days_per_month * MIN_PER_DAY;
}

/** 通算分 → 通算日 */
export function toTotalDay(time: number): number {
  return Math.floor(time / MIN_PER_DAY);
}

/** 月番号から季節名を返す */
export function seasonOfMonth(cfg: CalendarConfig, month: number): string {
  for (const [name, months] of Object.entries(cfg.seasons)) {
    if (months.includes(month)) return name;
  }
  return '';
}

/** 通算分 → 表示用構造体 */
export function toGameTime(cfg: CalendarConfig, time: number): GameTime {
  const t = Math.max(0, Math.floor(time));
  const totalDay = toTotalDay(t);
  const daysPerYear = cfg.months_per_year * cfg.days_per_month;
  const year = Math.floor(totalDay / daysPerYear) + 1;
  const dayOfYear = totalDay % daysPerYear;
  const month = Math.floor(dayOfYear / cfg.days_per_month) + 1;
  const day = (dayOfYear % cfg.days_per_month) + 1;
  const weekday = cfg.weekdays[totalDay % cfg.weekdays.length];
  const week = Math.ceil(day / 7);
  const minOfDay = t % MIN_PER_DAY;
  return {
    year,
    month,
    day,
    weekday,
    week,
    season: seasonOfMonth(cfg, month),
    hh: Math.floor(minOfDay / 60),
    mm: minOfDay % 60,
  };
}

/** 年月日時分 → 通算分 */
export function toMinutes(
  cfg: CalendarConfig,
  y: number,
  month: number,
  day: number,
  hh: number,
  mm: number,
): number {
  const totalDay =
    (y - 1) * cfg.months_per_year * cfg.days_per_month + (month - 1) * cfg.days_per_month + (day - 1);
  return totalDay * MIN_PER_DAY + hh * 60 + mm;
}

/** "HH:MM" → 0時からの分 */
/** 解釈できない表記は0分として扱う（日の出・日没表の後方互換） */
export function hhmmToMin(s: string): number {
  return parseHhmm(s) ?? 0;
}

export function minToHhmm(min: number): string {
  const m = ((min % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * 月ごとの日出・日没。未定義の月は前後の定義済み月から線形補間する。
 * 補間は年をまたいでラップアラウンドする（12月→1月も両者の間で補間）。
 */
export function sunTimes(cfg: CalendarConfig, month: number): { riseMin: number; setMin: number } {
  const defined = Object.entries(cfg.sun)
    .map(([m, v]) => ({ month: parseInt(m, 10), rise: hhmmToMin(v.rise), set: hhmmToMin(v.set) }))
    .filter((e) => Number.isFinite(e.month))
    .sort((a, b) => a.month - b.month);
  if (defined.length === 0) return { riseMin: 6 * 60, setMin: 18 * 60 };
  const exact = defined.find((e) => e.month === month);
  if (exact) return { riseMin: exact.rise, setMin: exact.set };
  if (defined.length === 1) return { riseMin: defined[0].rise, setMin: defined[0].set };

  const mpy = cfg.months_per_year;
  // 前後の定義済み月（ラップアラウンド）を探す
  let prev = defined[defined.length - 1];
  let next = defined[0];
  for (const e of defined) {
    if (e.month < month) prev = e;
  }
  for (let i = defined.length - 1; i >= 0; i--) {
    if (defined[i].month > month) next = defined[i];
  }
  const span = (next.month - prev.month + mpy) % mpy || mpy;
  const pos = (month - prev.month + mpy) % mpy;
  const ratio = pos / span;
  return {
    riseMin: Math.round(prev.rise + (next.rise - prev.rise) * ratio),
    setMin: Math.round(prev.set + (next.set - prev.set) * ratio),
  };
}

export type Daylight = '日の出前' | '日中' | '日没後';

export function daylightOf(cfg: CalendarConfig, time: number): Daylight {
  const gt = toGameTime(cfg, time);
  const { riseMin, setMin } = sunTimes(cfg, gt.month);
  const minOfDay = time % MIN_PER_DAY;
  if (minOfDay < riseMin) return '日の出前';
  if (minOfDay < setMin) return '日中';
  return '日没後';
}

/** 天候テーブルから重み付き抽選 */
export function drawWeather(cfg: CalendarConfig, season: string, rand: () => number = Math.random): string {
  const table = cfg.weather_table[season] ?? Object.values(cfg.weather_table)[0];
  if (!table) return '晴';
  const entries = Object.entries(table).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return '晴';
  let r = rand() * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

// ---- 営業時間・終電（Phase 5） ----

export type OpenStatus = '営業中' | '開店前' | '閉店済み' | null;

/**
 * 営業状況の判定。open/close 未設定は判定対象外（null）。
 * 閉店が翌日の場合は 1440 超（例: 26:00 = 1560）で表現される。
 */
export function openStatusOf(
  openMin: number | null,
  closeMin: number | null,
  time: number,
): OpenStatus {
  if (openMin == null || closeMin == null) return null;
  const m = time % MIN_PER_DAY;
  if (closeMin > MIN_PER_DAY) {
    // 深夜営業: 当日 open〜24:00 と翌日 0:00〜close-1440
    if (m >= openMin || m < closeMin - MIN_PER_DAY) return '営業中';
    return m < openMin ? '開店前' : '閉店済み';
  }
  if (m < openMin) return '開店前';
  if (m < closeMin) return '営業中';
  return '閉店済み';
}

/**
 * 終電行（§6.4）。通知窓の中でだけ表示する。
 * - 終電の notice 分前〜終電: 「終電まで残り◯分。」
 * - 終電後〜翌日の日の出まで: after_last_train_text
 * - それ以外: null（行を出さない）
 */
export function lastTrainLine(cfg: CalendarConfig, time: number): string | null {
  // 鉄道が無い世界観では行ごと出さない
  if (cfg.last_train_enabled === 0) return null;
  const m = time % MIN_PER_DAY;
  const last = cfg.last_train_min;
  const notice = cfg.last_train_notice_min;
  const label = cfg.last_train_label || '終電';
  if (m >= last - notice && m < last) {
    return `${label}まで残り${last - m}分。`;
  }
  const gt = toGameTime(cfg, time);
  const { riseMin } = sunTimes(cfg, gt.month);
  if (m >= last || m < riseMin) {
    return cfg.after_last_train_text || null;
  }
  return null;
}

// ---- メモリーの日付表記 ----

/** 「1年7月12日」形式。日付だけを見せたいとき用 */
export function formatGameDate(cfg: CalendarConfig, time: number): string {
  const gt = toGameTime(cfg, time);
  return `${gt.year}年${gt.month}月${gt.day}日`;
}

/**
 * 記憶の日付をプロンプト・UIに出す表記（§8.4）。
 * memories はチャットではなくキャラクターに紐づくので、同じ世界の別チャットが
 * 別の日付にいると差が負になったり極端に開いたりする。相対表記は
 * 「過去1年以内」に限り、それ以外は絶対日付に落として破綻を避ける。
 */
export function memoryDateLabel(
  cfg: CalendarConfig,
  memTime: number | null | undefined,
  nowTime: number | null,
): string {
  if (memTime == null || !Number.isFinite(memTime)) return '';
  if (nowTime == null || !Number.isFinite(nowTime)) return formatGameDate(cfg, memTime);
  const days = toTotalDay(nowTime) - toTotalDay(memTime);
  if (days === 0) return '今日';
  if (days === 1) return '昨日';
  const daysPerYear = cfg.months_per_year * cfg.days_per_month;
  if (days > 1 && days <= daysPerYear) return `${days}日前`;
  return formatGameDate(cfg, memTime);
}

/** 「秋・第2週の水曜日 18:40」形式 */
export function formatGameTime(gt: GameTime): string {
  return `${gt.season}・第${gt.week}週の${gt.weekday}曜日 ${String(gt.hh).padStart(2, '0')}:${String(gt.mm).padStart(2, '0')}`;
}

