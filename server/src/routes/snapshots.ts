import { Router } from 'express';
import type { Chat, Message, Settings } from '../../../shared/types.js';
import { chatDisplayName } from '../../../shared/types.js';
import { getCalendar } from '../db/repo/calendars.js';
import { getChat } from '../db/repo/chats.js';
import { getCharacter, getCharacters } from '../db/repo/characters.js';
import { listLocations } from '../db/repo/locations.js';
import { getMessage } from '../db/repo/messages.js';
import { getDefaultPersona, getPersona } from '../db/repo/personas.js';
import { getSettings } from '../db/repo/settings.js';
import {
  createSnapshot,
  deleteSnapshot,
  deleteSnapshots,
  getSnapshotImage,
  getSnapshotMeta,
  getSnapshotThumb,
  listAlbumWorlds,
  listSnapshotsByWorld,
  listSnapshotsMissingThumb,
  setSnapshotThumb,
} from '../db/repo/snapshots.js';
import { getWorld } from '../db/repo/worlds.js';
import { decodeImageDataUrl } from '../util/imageData.js';
import { buildSnapshotPrompt, collectReferences, type SnapshotInput } from '../domain/snapshot.js';
import { generateImage } from '../llm/image.js';

export const snapshotsRouter = Router();

/**
 * 場面のスナップショット（§21）。
 *
 * **生成ロック（messages.ts の `inflight`）は使わない。** 画像生成の最中も
 * 会話を続けられるべきなので、別枠の軽いロックで「同じメッセージへの二重生成」だけを弾く。
 */
const generating = new Set<string>();

type Resolved =
  | { ok: false; status: number; message: string }
  | {
      ok: true;
      message: Message;
      chat: Chat;
      settings: Settings;
      input: SnapshotInput;
    };

const fail = (status: number, message: string): Resolved => ({ ok: false, status, message });

/** 対象メッセージと、それに必要な文脈をまとめて引く */
function resolveTarget(messageId: string, includePersona: boolean): Resolved {
  const message = getMessage(messageId);
  if (!message) return fail(404, 'メッセージが見つかりません');
  if (message.role !== 'assistant' || message.kind !== 'normal') {
    return fail(400, 'スナップショットを作れるのはAIの応答だけです');
  }
  const chat = getChat(message.chat_id);
  if (!chat) return fail(404, 'チャットが見つかりません');

  const settings = getSettings();
  if (!settings.image_model.trim()) {
    return fail(
      400,
      '画像モデルが未設定です。設定画面の「スナップショット」でモデルを選んでください',
    );
  }

  const persona =
    (chat.persona_id ? getPersona(chat.persona_id) : undefined) ??
    (settings.active_persona_id ? getPersona(settings.active_persona_id) : undefined) ??
    getDefaultPersona() ??
    null;

  // **基準は state_after。** チャットの現在ステートではない（§21）。
  // 在席者も当時の present から引く。参加キャラ一覧だと、その時いなかった人まで描かれる
  const state = message.state_after;
  const characters = getCharacters(state.present ?? []);

  return {
    ok: true,
    message,
    chat,
    settings,
    input: {
      settings,
      calendar: getCalendar(chat.world_id),
      state,
      locations: listLocations(chat.world_id),
      characters,
      persona,
      includePersona,
      message,
    },
  };
}

const asBool = (v: unknown): boolean => v === true || v === '1' || v === 'true';

/** 生成しない＝課金しない。組み立てた結果を見せるだけ */
snapshotsRouter.post('/messages/:id/snapshot/preview', (req, res) => {
  const includePersona = asBool(req.query.include_persona ?? req.body?.include_persona);
  const r = resolveTarget(req.params.id, includePersona);
  if (!r.ok) {
    res.status(r.status).json({ error: r.message });
    return;
  }
  const { prompt, warnings } = buildSnapshotPrompt(r.input);
  const references = collectReferences(r.input);
  if (references.length === 0) {
    warnings.push(
      '参照に使える画像がありません。キャラクターの編集画面で参照画像かアバターを設定すると見た目が安定します',
    );
  }
  res.json({
    prompt,
    warnings,
    // 何が送られるのかを画面に見せる。URLは返さない（クライアントは使わない）。
    // 出どころ（参照画像 / アバター）も添える。アバターは切り抜き済みで質が落ちるため
    references: references.map((x) => ({ label: x.label, from: x.from })),
    model: r.settings.image_model,
    aspect_ratio: r.settings.image_aspect_ratio,
    quality: r.settings.image_quality,
  });
});

snapshotsRouter.post('/messages/:id/snapshot', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const includePersona = asBool(body.include_persona);
  const r = resolveTarget(req.params.id, includePersona);
  if (!r.ok) {
    res.status(r.status).json({ error: r.message });
    return;
  }

  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) {
    res.status(400).json({ error: 'プロンプトが空です' });
    return;
  }

  // finally まで確実に届くよう、ここで確定させておく
  const messageId = r.message.id;
  if (generating.has(messageId)) {
    res.status(409).json({ error: 'このメッセージのスナップショットを生成中です' });
    return;
  }
  generating.add(messageId);
  try {
    // **参照URLはクライアントから受け取らない。** サーバがアバターから組み直す。
    // 任意のURLを送り込めるようにすると、取得先を指定できる踏み台になる
    const useRefs = body.references === undefined ? true : asBool(body.references);
    const references = useRefs ? collectReferences(r.input).map((x) => x.url) : [];

    const image = await generateImage({
      model: r.settings.image_model,
      prompt,
      aspectRatio: String(body.aspect_ratio ?? r.settings.image_aspect_ratio),
      quality: String(body.quality ?? r.settings.image_quality),
      references,
    });

    const meta = createSnapshot({
      chatId: r.chat.id,
      messageId,
      prompt,
      model: r.settings.image_model,
      mime: image.mime,
      image: image.data,
    });
    res.status(201).json(meta);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  } finally {
    generating.delete(messageId);
  }
});

/**
 * 画像のバイナリ配信。
 *
 * **JSONに載せない**ため、実体はここでしか出さない（§21）。
 * `private` であること: 認証の内側の個人的な内容なので、共有プロキシに載せてはいけない。
 * 作成後に中身が変わらないので `immutable` が使える。
 */
snapshotsRouter.get('/snapshots/:id/image', (req, res) => {
  const row = getSnapshotImage(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'スナップショットが見つかりません' });
    return;
  }
  res.setHeader('Content-Type', row.mime || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(row.image);
});

/**
 * 一覧用の縮小版（§21.9）。
 *
 * **サーバでは縮小できない。** 画像ライブラリ（ネイティブ依存）を増やしたくないので、
 * ブラウザのcanvasで作ったものを受け取る。作られていなくても表示は原寸に落ちるだけなので、
 * ここが失敗しても生成そのものは成功として扱う（呼び出し側で握りつぶしてよい）。
 */
snapshotsRouter.put('/snapshots/:id/thumb', (req, res) => {
  if (!getSnapshotMeta(req.params.id)) {
    res.status(404).json({ error: 'スナップショットが見つかりません' });
    return;
  }
  const decoded = decodeImageDataUrl((req.body ?? {}).data_url);
  if (!decoded.ok) {
    res.status(decoded.status).json({ error: decoded.message });
    return;
  }
  setSnapshotThumb(req.params.id, decoded.mime, decoded.image);
  res.json(getSnapshotMeta(req.params.id));
});

snapshotsRouter.get('/snapshots/:id/thumb', (req, res) => {
  const row = getSnapshotThumb(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'サムネイルはまだ作られていません' });
    return;
  }
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(row.image);
});

// ---- アルバム（§21.8） ----

/** 世界ごとの枚数と合計サイズ。どこに何枚あるかの入口 */
snapshotsRouter.get('/albums', (_req, res) => {
  res.json(listAlbumWorlds());
});

/** その世界の一覧。会話名とseqを添える（画像は含めない） */
snapshotsRouter.get('/worlds/:id/snapshots', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  const items = listSnapshotsByWorld(req.params.id);
  // **表示名まで解決して返す（§3.5）。** 名前が未設定の会話は参加キャラの名前で出す。
  // home・チャット画面と呼び名を揃えるため、ここで `chatDisplayName` を通す。
  // 会話ごとに1回だけ引く（世界あたりの会話数は多くない）
  const nameOf = new Map<string, string>();
  for (const it of items) {
    if (nameOf.has(it.chat_id)) continue;
    const chat = getChat(it.chat_id);
    const first = chat?.participant_ids[0] ? getCharacter(chat.participant_ids[0]) : undefined;
    nameOf.set(it.chat_id, chatDisplayName(it.chat_title, first?.name));
  }
  res.json(items.map((it) => ({ ...it, chat_title: nameOf.get(it.chat_id)! })));
});

/** サムネイル未作成のID。アルバムの「サムネイルを作る」が使う（§21.9） */
snapshotsRouter.get('/worlds/:id/snapshots/missing-thumbs', (req, res) => {
  if (!getWorld(req.params.id)) {
    res.status(404).json({ error: '世界が見つかりません' });
    return;
  }
  res.json({ ids: listSnapshotsMissingThumb(req.params.id) });
});

/**
 * まとめて削除。**DELETE ではなく POST。**
 * 消す対象をボディで渡すため（URLに何十件も並べない）。
 */
snapshotsRouter.post('/snapshots/delete', (req, res) => {
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(raw.ids) ? raw.ids.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length === 0) {
    res.status(400).json({ error: '削除するスナップショットが指定されていません' });
    return;
  }
  res.json({ deleted: deleteSnapshots(ids) });
});

snapshotsRouter.delete('/snapshots/:id', (req, res) => {
  if (!getSnapshotMeta(req.params.id)) {
    res.status(404).json({ error: 'スナップショットが見つかりません' });
    return;
  }
  deleteSnapshot(req.params.id);
  res.json({ ok: true });
});
