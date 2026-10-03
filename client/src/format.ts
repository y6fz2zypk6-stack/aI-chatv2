// 日時の表記。画面ごとに書式がばらばらになっていたので、ここに集める（DESIGN_SPEC 7章 B-1）。
// 引数の `now` は、テストで「今日・昨日・今年」を決め打ちにするためだけにある。

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 同じ暦日か（ローカル時刻で見る） */
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * 一覧の右端に出す日時。新しいほど細かく、古いほど粗く出す。
 *   今日 → `14:13`／昨日 → `昨日`／今年 → `9/28`／それ以前 → `2025/9/28`
 */
export function formatListStamp(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  if (sameDay(d, today)) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(d, yesterday)) return '昨日';
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 年月日と時分。あらすじの最終更新・発火履歴・アルバムの原寸で使う。`2026/10/01 14:13` */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
