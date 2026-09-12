import { Router, type Response } from 'express';
import type { MemoryPlan } from '../../../shared/types.js';
import { getWorld } from '../db/repo/worlds.js';
import { PlanError, buildReview, planApply, planPreview } from '../domain/memreview.js';

export const memReviewRouter = Router();

/** RFC 5987 でエンコードし日本語ファイル名を落とさない（§8.8） */
function attachment(res: Response, filename: string): void {
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="memories.json"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
}

// ---- メモリーの棚卸し（§10.4）----

// 書き出し。世界書き出し（/worlds/:id/export）は会話やシナリオまで入って重いので別口にする。
// こちらは「整理の判断に要るものだけ」= キャラ定義・ロア・全メモリー
memReviewRouter.get('/worlds/:id/memories/export', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  attachment(res, `${world.name}_memories.json`);
  res.json(buildReview(world.id, world.name));
});

/** 画面の要約表示用。書き出しと同じ中身をダウンロードさせずに返す */
memReviewRouter.get('/worlds/:id/memories/review', (req, res) => {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.json(buildReview(world.id, world.name));
});

/**
 * まとめて適用するので **POST**（消す対象をボディで渡す。URLに何十件も並べない）。
 * `/snapshots/delete` と同じ考え方。
 */
function run(
  req: { params: { id: string }; body?: unknown },
  res: Response,
  fn: (worldId: string, plan: MemoryPlan) => unknown,
): void {
  const world = getWorld(req.params.id);
  if (!world) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const plan = (req.body ?? {}) as MemoryPlan;
  if (plan.format && plan.format !== 'character_chat_memory_plan') {
    res.status(400).json({ error: 'character_chat_memory_plan 形式のJSONではありません' });
    return;
  }
  try {
    res.json(fn(world.id, plan));
  } catch (err) {
    // **黙って読み飛ばさない。** 幻のIDが混ざった整理案は理由を添えて弾く
    if (err instanceof PlanError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(400).json({
      error: `整理案を適用できませんでした（変更は取り消されました）: ${(err as Error).message}`,
    });
  }
}

memReviewRouter.post('/worlds/:id/memory-plan/preview', (req, res) => {
  run(req, res, planPreview);
});

memReviewRouter.post('/worlds/:id/memory-plan/apply', (req, res) => {
  run(req, res, planApply);
});
