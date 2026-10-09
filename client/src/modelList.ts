// モデルの一覧（GET /models）の並べ替え・絞り込み・表示。状態を持たない純粋な関数だけを置く。
// サーバのテスト（server/test/format.mjs）から Node でそのまま読み込むので、ほかのモジュールを import しない

/** 一覧の1件。`ModelInfo`（shared/types.ts）と同じ形 */
export interface ListedModel {
  id: string;
  name: string;
  context_length: number;
}

/**
 * 「~作者/系列-latest」（常にその系列の最新版を使う名前、§6.6）を先に、あとはIDの順。
 * 新しい版を探しに来たとき、まず目に入る位置に置く
 */
export function sortModels<T extends { id: string }>(models: T[]): T[] {
  return [...models].sort((a, b) => {
    const la = a.id.startsWith('~') ? 0 : 1;
    const lb = b.id.startsWith('~') ? 0 : 1;
    return la - lb || a.id.localeCompare(b.id, 'en');
  });
}

/**
 * 空白で区切った語を**すべて**含むものだけ残す。IDと名前のどちらに含まれてもよく、大文字小文字は見ない。
 * 「opus 5.5」のように系列と版を分けて打てるようにする
 */
export function filterModels<T extends { id: string; name: string }>(models: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models;
  return models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** コンテキスト長を「1000k」の形に。0（不明）は空文字 */
export function contextK(n: number): string {
  if (!n || n < 0) return '';
  return `${Math.round(n / 1000)}k`;
}
