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

/** デコード後の上限。クライアントは1024pxへ縮めて送るが、APIを直接叩かれても止める */
const MAX_BYTES = 6 * 1024 * 1024;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/** 先頭バイトがその種別のものか。宣言だけ信じない */
function sniff(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

type Decoded =
  | { ok: true; mime: string; image: Buffer }
  | { ok: false; status: number; message: string };

/**
 * data URL を検証して中身を取り出す。
 *
 * **ここを通ったものをそのまま上流へ送る**ので、素通しにしない。
 * 形式・実際の中身・大きさの3つを見る。
 */
function decodeDataUrl(raw: unknown): Decoded {
  if (typeof raw !== 'string' || !raw) {
    return { ok: false, status: 400, message: '画像が指定されていません' };
  }
  const m = DATA_URL.exec(raw.trim());
  if (!m) {
    return {
      ok: false,
      status: 400,
      message: 'PNG・JPEG・WebP の data URL だけを受け付けます',
    };
  }
  const image = Buffer.from(m[2], 'base64');
  if (image.length === 0) return { ok: false, status: 400, message: '画像が空です' };
  if (image.length > MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `画像が大きすぎます（${Math.round(image.length / 1024 / 1024)}MB / 上限6MB）`,
    };
  }
  const actual = sniff(image);
  if (!actual) return { ok: false, status: 400, message: '画像として読めません' };
  if (actual !== m[1]) {
    return {
      ok: false,
      status: 400,
      message: `種別が中身と一致しません（${m[1]} と指定されていますが ${actual} です）`,
    };
  }
  return { ok: true, mime: actual, image };
}

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
    const decoded = decodeDataUrl((req.body ?? {}).data_url);
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
