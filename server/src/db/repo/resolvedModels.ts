import { db, now } from '../index.js';

/**
 * 「最新」の名前（`~anthropic/claude-opus-latest` など、§6.6）に、実際に答えた版。
 *
 * **応答のたびに書かない。** 版が変わったときだけ書く。生成のたびに同じ値で
 * UPDATE を打つと、書き込みが本文の保存と取り合う。読み出しもメモリから返す
 */
interface Row {
  ref: string;
  model: string;
  updated_at: number;
}

let cache: Map<string, Row> | null = null;

function load(): Map<string, Row> {
  if (!cache) {
    cache = new Map();
    for (const r of db.prepare('SELECT ref, model, updated_at FROM resolved_models').all() as Row[]) {
      cache.set(r.ref, r);
    }
  }
  return cache;
}

/** 版が変わったときだけ書く。同じなら何もしない */
export function recordResolvedModel(ref: string, model: string): void {
  if (!ref || !model || ref === model) return;
  const map = load();
  if (map.get(ref)?.model === model) return;
  const row = { ref, model, updated_at: now() };
  db.prepare(
    `INSERT INTO resolved_models (ref, model, updated_at) VALUES (@ref, @model, @updated_at)
     ON CONFLICT(ref) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`,
  ).run(row);
  map.set(ref, row);
}

export function getResolvedModel(ref: string): string | undefined {
  return load().get(ref)?.model;
}

export function listResolvedModels(): Row[] {
  return [...load().values()];
}
