/**
 * クライアントから受け取る画像（data URL）の検査（§21.4）。
 *
 * **参照画像とサムネイルで同じものを使う。** 検査を2箇所に書くと片方だけ緩む。
 * ここを通ったものは**そのままDBへ入り、参照画像は上流へも送られる**ので、
 * 形式・実際の中身・大きさの3つを必ず見る。
 */

/** デコード後の上限。クライアントは縮めて送るが、APIを直接叩かれても止める */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/** 先頭バイトがその種別のものか。宣言だけ信じない */
export function sniffImage(buf: Buffer): string | null {
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

export type DecodedImage =
  | { ok: true; mime: string; image: Buffer }
  | { ok: false; status: number; message: string };

/** data URL を検証して中身を取り出す */
export function decodeImageDataUrl(raw: unknown): DecodedImage {
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
  if (image.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `画像が大きすぎます（${Math.round(image.length / 1024 / 1024)}MB / 上限6MB）`,
    };
  }
  const actual = sniffImage(image);
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
