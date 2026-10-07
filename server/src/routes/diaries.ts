import { Router } from 'express';
import { getChat } from '../db/repo/chats.js';
import { deleteDiary, getDiary, updateDiaryContent } from '../db/repo/diaries.js';
import { getSettings } from '../db/repo/settings.js';
import { DIARY_LENGTHS, diaryIndex, writeDiary, type DiaryLength } from '../domain/diary.js';

/** キャラクターの日記（§22）。プロンプトには載せない読み物 */
export const diariesRouter = Router();

diariesRouter.get('/chats/:id/diary', (req, res) => {
  const index = diaryIndex(req.params.id);
  if (!index) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  res.json(index);
});

diariesRouter.post('/chats/:id/diary', async (req, res) => {
  if (!getChat(req.params.id)) {
    res.status(404).json({ error: 'チャットが見つかりません' });
    return;
  }
  const body = (req.body ?? {}) as { character_id?: unknown; day?: unknown; length?: unknown };
  if (typeof body.character_id !== 'string' || !Number.isInteger(body.day)) {
    res.status(400).json({ error: 'character_id と day を指定してください' });
    return;
  }
  const length: DiaryLength =
    typeof body.length === 'string' && Object.hasOwn(DIARY_LENGTHS, body.length) ? (body.length as DiaryLength) : 'normal';
  const r = await writeDiary(req.params.id, body.character_id, body.day as number, length, getSettings());
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json(r.diary);
});

diariesRouter.put('/diaries/:id', (req, res) => {
  const content = (req.body ?? {}).content;
  if (typeof content !== 'string' || !content.trim()) {
    res.status(400).json({ error: '本文が空です' });
    return;
  }
  if (!getDiary(req.params.id)) {
    res.status(404).json({ error: '日記が見つかりません' });
    return;
  }
  res.json(updateDiaryContent(req.params.id, content));
});

diariesRouter.delete('/diaries/:id', (req, res) => {
  deleteDiary(req.params.id);
  res.json({ ok: true });
});
