import { Router } from 'express';
import { getCharacter } from '../db/repo/characters.js';
import { getPersona } from '../db/repo/personas.js';
import {
  deleteReference,
  getReferenceImage,
  getReferenceMeta,
  putReference,
  type RefOwner,
} from '../db/repo/references.js';
import { decodeImageDataUrl } from '../util/imageData.js';

/**
 * 参照用の高画質画像（§21.4）。
 *
 * アバターは丸アイコン用に**正方形へ切り抜いて320px**まで落としてあるので、
 * 参照に使うと服装や全身が伝わらない。ここへ上げた画像は切り抜かず、
 * スナップショットのときだけアバターより優先して上流へ渡す。
 *
 * **キャラ本体の PUT には混ぜない。** 通常APIのボディ上限は256kb（§16.3）で、
 * 参照画像はそれを超える。この2本だけ大きめのパーサを通してある。
 */
export const referencesRouter = Router();

/** 持ち主が実在するか。無ければ404 */
function ownerOf(kind: RefOwner['kind'], id: string): RefOwner | null {
  const found = kind === 'character' ? getCharacter(id) : getPersona(id);
  return found ? { kind, id } : null;
}

const NOT_FOUND: Record<RefOwner['kind'], string> = {
  character: 'キャラクターが見つかりません',
  persona: 'ペルソナが見つかりません',
};

/** キャラとペルソナで中身は同じ。持ち主の解決だけ差し替える */
function mount(kind: RefOwner['kind'], base: string) {
  referencesRouter.get(`${base}/:id/reference`, (req, res) => {
    const owner = ownerOf(kind, req.params.id);
    if (!owner) {
      res.status(404).json({ error: NOT_FOUND[kind] });
      return;
    }
    const meta = getReferenceMeta(owner);
    if (!meta) {
      res.status(404).json({ error: '参照画像は設定されていません' });
      return;
    }
    res.json(meta);
  });

  referencesRouter.put(`${base}/:id/reference`, (req, res) => {
    const owner = ownerOf(kind, req.params.id);
    if (!owner) {
      res.status(404).json({ error: NOT_FOUND[kind] });
      return;
    }
    const decoded = decodeImageDataUrl((req.body ?? {}).data_url);
    if (!decoded.ok) {
      res.status(decoded.status).json({ error: decoded.message });
      return;
    }
    res.status(201).json(putReference(owner, decoded.mime, decoded.image));
  });

  referencesRouter.delete(`${base}/:id/reference`, (req, res) => {
    const owner = ownerOf(kind, req.params.id);
    if (!owner) {
      res.status(404).json({ error: NOT_FOUND[kind] });
      return;
    }
    if (!deleteReference(owner)) {
      res.status(404).json({ error: '参照画像は設定されていません' });
      return;
    }
    res.json({ ok: true });
  });
}

mount('character', '/characters');
mount('persona', '/personas');

/**
 * 画像のバイナリ配信。スナップショットと同じ扱い（§21.5）:
 * `private` であること（認証の内側の個人的な内容）、
 * 差し替えるとIDが変わるので `immutable` が使える。
 */
referencesRouter.get('/references/:id/image', (req, res) => {
  const row = getReferenceImage(req.params.id);
  if (!row) {
    res.status(404).json({ error: '参照画像が見つかりません' });
    return;
  }
  res.setHeader('Content-Type', row.mime || 'image/webp');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(row.image);
});
