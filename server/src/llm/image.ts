import { BASE, headers } from './openrouter.js';

/**
 * 画像生成（§21）。`openrouter.ts` と並ぶ薄い層。
 *
 * **呼び出し側はこの形だけを知る。** PixAI など別のサービスへ差し替えるときに、
 * ルートやドメイン層を触らずに済ませるため。
 */

/**
 * ストリームの待ち時間（§5.7）と同じ考え方の上限。
 * 画像生成は数十秒かかるうえ、上流が黙り込むと呼び出し側の finally へ到達できない。
 */
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS) || 120_000;

/** 画面に出す説明で使う（秒） */
export const imageTimeoutSeconds = Math.round(IMAGE_TIMEOUT_MS / 1000);

/**
 * 参照画像の上限。
 * 16件まで受けるモデルもあれば4件のものもあるので、**低い方に合わせる**。
 * 超過分を黙って落とすのではなく、呼び出し側が枚数を絞ってから渡すこと。
 */
export const MAX_REFERENCES = 4;

export interface ImageResult {
  mime: string;
  data: Buffer;
}

export interface ImageOptions {
  model: string;
  prompt: string;
  aspectRatio: string;
  quality: string;
  /** data URL または HTTP(S) URL。空配列なら送らない */
  references: string[];
}

/**
 * OpenRouter の専用 Image API（`POST /images`）で1枚生成する。
 *
 * 新しい画像モデルはこちらにのみ追加されるため、`/chat/completions` +
 * `modalities` の旧経路は使わない。
 */
export async function generateImage(opts: ImageOptions): Promise<ImageResult> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, IMAGE_TIMEOUT_MS);

  const refs = opts.references.filter((u) => !!u).slice(0, MAX_REFERENCES);
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    aspect_ratio: opts.aspectRatio,
    quality: opts.quality,
  };
  // 参照が無いときはキーごと省く。空配列を送って弾くプロバイダがある
  if (refs.length > 0) {
    body.input_references = refs.map((url) => ({ type: 'image_url', image_url: { url } }));
  }
  // response_format は送らない。応答は常に data[].b64_json

  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}/images`, {
        method: 'POST',
        headers: headers(),
        signal: ctl.signal,
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (timedOut) throw timeoutError();
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`画像生成に失敗しました（${res.status}）: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      data?: { b64_json?: string; media_type?: string }[];
    };
    const first = json.data?.[0];
    // **空を黙って保存しない。** 0バイトのスナップショットが並ぶと原因が追えなくなる
    if (!first?.b64_json) {
      throw new Error('画像が返りませんでした。モデルが画像生成に対応しているか確認してください');
    }
    const data = Buffer.from(first.b64_json, 'base64');
    if (data.length === 0) throw new Error('画像が空でした');

    // media_type は省略されることがある（PNGのとき等）。既定を当てる
    return { mime: first.media_type || 'image/png', data };
  } catch (err) {
    if (timedOut) throw timeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function timeoutError(): Error {
  return new Error(
    `画像生成の応答が${imageTimeoutSeconds}秒ありませんでした。中断しましたが、` +
      '上流で生成が進んでいた場合は課金されていることがあります',
  );
}

/** 画像モデルの一覧（設定画面の補完用）。失敗しても他の機能には影響させない */
export async function listImageModels(): Promise<unknown> {
  const res = await fetch(`${BASE}/images/models`, { headers: headers() });
  if (!res.ok) throw new Error(`OpenRouter /images/models failed: ${res.status}`);
  return res.json();
}
