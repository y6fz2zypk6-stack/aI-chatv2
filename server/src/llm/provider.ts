/**
 * 接続先の解決（§6.6）。
 *
 * 上流はもともと OpenRouter 1本で、`BASE` と `headers()` の2つがすべての呼び出しの
 * 結節点になっていた。ここを接続先ごとに引き直すことで、ドメイン層を触らずに
 * **OpenAI互換のサービスへ振り分けられる**ようにする。
 *
 * **組み込み（`.env` の OpenRouter）は DB に持たない。** IDは空文字で、編集も削除も
 * させない。モデル参照に `::` が無ければ組み込みなので、既存の設定は何も変えずに動く。
 */
import { parseModelRef } from '../../../shared/types.js';
import { getConnectionSecret } from '../db/repo/connections.js';

export interface ResolvedConnection {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 0 なら呼び出し側の既定（settings.fallback_context_length）へ落とす */
  contextLength: number;
  /** 組み込み（.env の OpenRouter）か */
  builtin: boolean;
}

/** 組み込みの表示名。画面とエラー文言で使う */
export const BUILTIN_NAME = 'OpenRouter（.env）';

export function builtinConnection(): ResolvedConnection {
  return {
    id: '',
    name: BUILTIN_NAME,
    // OPENROUTER_BASE_URL はテストでモックへ向けるための seam でもある（§2.3）
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    contextLength: 0,
    builtin: true,
  };
}

/**
 * 接続先IDから接続先を引く。
 * **未知のIDは投げる。** 黙って組み込みへ落とすと、消された接続先を指したチャットが
 * 別のサービスへ本文を送ってしまう。
 */
export function resolveConnection(id: string): ResolvedConnection {
  if (!id) return builtinConnection();
  const row = getConnectionSecret(id);
  if (!row) {
    throw new Error(
      `接続先が見つかりません（${id}）。設定の「モデルと接続先」で選び直してください`,
    );
  }
  return {
    id: row.id,
    name: row.name || '(名前なし)',
    baseUrl: row.base_url,
    apiKey: row.api_key,
    contextLength: row.context_length,
    builtin: false,
  };
}

/** モデル参照（`<接続先ID>::<モデルID>`）をほどいて、接続先と素のモデルIDにする */
export function resolveModelRef(ref: string): { conn: ResolvedConnection; modelId: string } {
  const { connectionId, modelId } = parseModelRef(ref);
  return { conn: resolveConnection(connectionId), modelId };
}

export function headersOf(conn: ResolvedConnection): Record<string, string> {
  if (!conn.apiKey) {
    throw new Error(`接続先「${conn.name}」のAPIキーが設定されていません`);
  }
  const h: Record<string, string> = {
    Authorization: `Bearer ${conn.apiKey}`,
    'Content-Type': 'application/json',
  };
  // **OpenRouter 固有のヘッダは組み込みのときだけ。** 他社には意味が無く、
  // 厳しいゲートウェイでは未知のヘッダを弾くことがある
  if (conn.builtin) {
    h['HTTP-Referer'] = process.env.APP_URL || 'http://localhost';
    h['X-Title'] = process.env.APP_TITLE || 'Character Chat';
  }
  return h;
}
