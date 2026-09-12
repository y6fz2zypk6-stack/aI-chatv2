/**
 * メモリーの棚卸し（§10.4）。
 *
 * 書き出し → 整理案（Claudeに作らせる）→ プレビュー → 適用 の往復を担う。
 *
 * 設計の要が2つある。
 *
 * ① **削除を既定にしない。** 自動抽出の重複除けには `enabled = 0` のものも渡している
 *    （§10.2）。消すと同じ記憶が次の抽出で復活するので、勧めるのは注入オフの方。
 *    `delete` を禁じはしないが、必ず警告を添える。
 *
 * ② **黙って読み飛ばさない。** 未知のID・他の世界のIDは 400 にする。
 *    整理案はLLMが書いたものなので、幻のIDが混ざり得る。黙ってスキップすると
 *    「適用したのに減っていない」が理由の分からないまま起きる。
 */
import type {
  Character,
  LorebookEntry,
  Memory,
  MemoryPlan,
  MemoryReviewItem,
  MemoryReviewStats,
  PlanResult,
  PlanRow,
} from '../../../shared/types.js';
import { db } from '../db/index.js';
import { listCharacters } from '../db/repo/characters.js';
import { getCalendar } from '../db/repo/calendars.js';
import {
  createLorebookEntry,
  listLorebook,
  updateLorebookEntry,
} from '../db/repo/lorebook.js';
import { createMemory, deleteMemory, listMemories, updateMemory } from '../db/repo/memories.js';
import { memoryDateLabel } from './calendar.js';

/** 1回の整理案で扱える操作数の上限。事故と暴走の両方を止める */
export const MAX_PLAN_OPS = 500;

/** 整理案の本文の上限。メモリー1件の内容として現実的な長さ */
const MAX_CONTENT_CHARS = 2000;

export class PlanError extends Error {}

/** 世界のメモリーを、キャラ名・対象名・日付ラベルつきで集める */
function collect(worldId: string): {
  characters: Character[];
  lorebook: LorebookEntry[];
  items: MemoryReviewItem[];
} {
  const characters = listCharacters(worldId);
  const nameOf = new Map(characters.map((c) => [c.id, c.name]));
  const cal = getCalendar(worldId);
  const items: MemoryReviewItem[] = [];
  for (const c of characters) {
    for (const m of listMemories(c.id)) {
      // subject に外部キー制約が無いので、解決できるかをここで見る（§10.2）
      const resolved = !m.subject || nameOf.has(m.subject);
      items.push({
        ...m,
        character_name: c.name,
        subject_name: m.subject ? (nameOf.get(m.subject) ?? '') : '',
        // 一覧と同じく「いまが何日か」は持たないので絶対日付だけになる
        game_time_label: memoryDateLabel(cal, m.game_time, null),
        injectable: m.enabled !== 0 && resolved,
      });
    }
  }
  return { characters, lorebook: listLorebook(worldId), items };
}

/**
 * 注入される側の統計。
 * **文字数を出すのが肝。** メモリーには専用予算が無く削減順も最後なので、増えても
 * メモリー自身は削られない。先に削られるのは履歴の方（§6.5）。
 * 「何件減ったか」より「注入がどれだけ軽くなったか」の方が効果を表す
 */
function statsOf(items: { content: string; enabled: number; injectable: boolean }[]): MemoryReviewStats {
  let enabled = 0;
  let chars = 0;
  let orphan = 0;
  for (const m of items) {
    if (m.enabled !== 0) {
      enabled++;
      if (m.injectable) chars += m.content.length;
      else orphan++;
    }
  }
  return {
    total: items.length,
    enabled,
    disabled: items.length - enabled,
    chars,
    orphan_subject: orphan,
  };
}

/** 整理案の書き方。書き出したJSON自身に埋めて、毎回プロンプトを書かずに済むようにする */
const PLAN_FORMAT = `この JSON を読んで、メモリーの整理案を次の形の JSON だけで返してください。

{
  "format": "character_chat_memory_plan",
  "version": 1,
  "memories": {
    "disable": ["メモリーID", ...],
    "enable":  ["メモリーID", ...],
    "delete":  ["メモリーID", ...],
    "update":  [{ "id": "メモリーID", "content": "書き直した本文", "subject": "人物IDまたは空文字", "pinned": 0 }],
    "create":  [{ "character_id": "キャラID", "subject": "人物IDまたは空文字", "content": "統合した本文", "pinned": 0 }]
  },
  "lorebook": {
    "create": [{ "title": "見出し", "keys": ["発火語", ...], "content": "本文", "category": "人物", "character_id": null, "always": 0, "priority": 0 }],
    "update": [{ "id": "ロアID", "content": "書き直した本文" }]
  }
}

整理の方針:
- 重複をまとめる = memories.create（統合した1件）＋ memories.disable（元の数件）
- 恒常設定になったものをロアへ落とす = lorebook.create ＋ memories.disable
- **消すより disable を勧めます。** delete すると自動抽出が同じ内容を次回また拾い直します
- injectable が false のものは、保存されていても注入されていません。優先して見てください
- ロアを作るときは keys（発火語）を必ず入れてください。空だと永久に発火しません
- ID は必ずこの JSON にあるものを使ってください。存在しない ID は拒否されます
- キャラクターシート（persona / speech_style）に既に書いてあることは、メモリーに残す必要がありません`;

/** 書き出し。判断に要るものを1ファイルへまとめる */
export function buildReview(worldId: string, worldName: string): Record<string, unknown> {
  const { characters, lorebook, items } = collect(worldId);
  return {
    format: 'character_chat_memory_review',
    version: 1,
    world: { id: worldId, name: worldName },
    // **キャラ定義とロアを同梱するのが肝。**「もうシートに書いてある」「もうロアにある」を
    // 判断させるために要る
    characters: characters.map((c) => ({
      id: c.id,
      name: c.name,
      aliases: c.aliases,
      persona: c.persona,
      speech_style: c.speech_style,
      is_npc_pool: c.is_npc_pool,
    })),
    lorebook: lorebook.map((e) => ({
      id: e.id,
      title: e.title,
      keys: e.keys,
      content: e.content,
      category: e.category,
      character_id: e.character_id,
      always: e.always,
      enabled: e.enabled,
      trigger_locations: e.trigger_locations,
      trigger_seasons: e.trigger_seasons,
    })),
    // **キャラ横断のフラット配列。** ネストすると人をまたいだ重複を見つけにくい
    memories: items,
    stats: statsOf(items),
    plan_format: PLAN_FORMAT,
  };
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asIds = (v: unknown): string[] =>
  asArray(v).filter((x): x is string => typeof x === 'string' && x.length > 0);
const trimmed = (v: unknown): string => String(v ?? '').trim();

/**
 * 整理案を検証し、何が起きるかを組み立てる。**DBには一切書かない。**
 * プレビューと適用で同じ結果を出すため、適用側もまずこれを通す。
 */
export function planPreview(worldId: string, plan: MemoryPlan): PlanResult {
  const { characters, lorebook, items } = collect(worldId);
  const charIds = new Set(characters.map((c) => c.id));
  const nameOf = new Map(characters.map((c) => [c.id, c.name]));
  const byId = new Map(items.map((m) => [m.id, m]));
  const loreById = new Map(lorebook.map((e) => [e.id, e]));

  const rows: PlanRow[] = [];
  const warnings: string[] = [];
  const mem = plan.memories ?? {};
  const lore = plan.lorebook ?? {};

  // 同じメモリーが複数の操作に出ていたら、どちらが勝つか決められない
  const touched = new Set<string>();
  const claim = (id: string, op: string): MemoryReviewItem => {
    const m = byId.get(id);
    if (!m) {
      throw new PlanError(
        `メモリーID ${id} はこの世界にありません（${op}）。書き出したJSONにあるIDを使ってください`,
      );
    }
    if (touched.has(id)) {
      throw new PlanError(`メモリーID ${id} が複数の操作に出ています（${op}）`);
    }
    touched.add(id);
    return m;
  };

  const ops =
    asIds(mem.disable).length +
    asIds(mem.enable).length +
    asIds(mem.delete).length +
    asArray(mem.update).length +
    asArray(mem.create).length +
    asArray(lore.create).length +
    asArray(lore.update).length;
  if (ops === 0) throw new PlanError('整理案に操作が1つもありません');
  if (ops > MAX_PLAN_OPS) {
    throw new PlanError(`操作が多すぎます（${ops}件）。${MAX_PLAN_OPS}件までにしてください`);
  }

  // 適用後の姿を組み立てて統計を出す（DBは触らない）
  const after = new Map(items.map((m) => [m.id, { ...m }]));

  for (const id of asIds(mem.disable)) {
    const m = claim(id, 'disable');
    rows.push({ op: 'disable', kind: 'memory', id, character_name: m.character_name,
      title: '', content: m.content, note: m.enabled === 0 ? 'すでに注入オフです' : '' });
    after.set(id, { ...m, enabled: 0, injectable: false });
  }

  for (const id of asIds(mem.enable)) {
    const m = claim(id, 'enable');
    rows.push({ op: 'enable', kind: 'memory', id, character_name: m.character_name,
      title: '', content: m.content, note: m.enabled !== 0 ? 'すでに注入オンです' : '' });
    const resolved = !m.subject || charIds.has(m.subject);
    after.set(id, { ...m, enabled: 1, injectable: resolved });
  }

  const deletes = asIds(mem.delete);
  for (const id of deletes) {
    const m = claim(id, 'delete');
    rows.push({ op: 'delete', kind: 'memory', id, character_name: m.character_name,
      title: '', content: m.content, note: '元に戻せません' });
    after.delete(id);
  }
  if (deletes.length > 0) {
    // ①の警告。ここを黙らせると「整理したのに復活する」が理由不明で起きる
    warnings.push(
      `${deletes.length}件を削除します。削除すると自動抽出が同じ内容を拾い直して復活するので、残したくないだけなら「注入オフ」を勧めます`,
    );
  }

  for (const raw of asArray(mem.update)) {
    const u = (raw ?? {}) as { id?: string; content?: string; subject?: string; pinned?: number };
    const m = claim(trimmed(u.id), 'update');
    const content = u.content === undefined ? m.content : trimmed(u.content);
    if (!content) throw new PlanError(`メモリーID ${m.id} の本文が空です（update）`);
    if (content.length > MAX_CONTENT_CHARS) {
      throw new PlanError(`メモリーID ${m.id} の本文が長すぎます（${content.length}文字）`);
    }
    let subject = u.subject === undefined ? m.subject : trimmed(u.subject);
    let note = '';
    if (subject && !charIds.has(subject)) {
      // 既存の commitCandidates と同じ扱い。常時注入へ落として必ず知らせる
      warnings.push(`対象「${subject}」は人物IDとして解決できないため常時扱いにしました`);
      subject = '';
      note = '対象を常時へ落としました';
    }
    const pinned = u.pinned === undefined ? m.pinned : u.pinned ? 1 : 0;
    rows.push({ op: 'update', kind: 'memory', id: m.id, character_name: m.character_name,
      title: '', content, note });
    after.set(m.id, { ...m, content, subject, pinned, injectable: m.enabled !== 0 });
  }

  let created = 0;
  for (const raw of asArray(mem.create)) {
    const c = (raw ?? {}) as { character_id?: string; subject?: string; content?: string; pinned?: number };
    const characterId = trimmed(c.character_id);
    if (!charIds.has(characterId)) {
      throw new PlanError(
        `キャラID ${characterId || '(空)'} はこの世界にありません（create）`,
      );
    }
    const content = trimmed(c.content);
    if (!content) throw new PlanError('追加するメモリーの本文が空です（create）');
    if (content.length > MAX_CONTENT_CHARS) {
      throw new PlanError(`追加するメモリーの本文が長すぎます（${content.length}文字）`);
    }
    let subject = trimmed(c.subject);
    let note = '';
    if (subject && !charIds.has(subject)) {
      warnings.push(`対象「${subject}」は人物IDとして解決できないため常時扱いにしました`);
      subject = '';
      note = '対象を常時へ落としました';
    }
    rows.push({ op: 'create', kind: 'memory', id: '', character_name: nameOf.get(characterId) ?? '',
      title: '', content, note });
    // 統計用の仮のキー。IDはまだ無い
    after.set(`new:${created++}`, {
      content, enabled: 1, injectable: true,
    } as MemoryReviewItem);
  }

  for (const raw of asArray(lore.create)) {
    const e = (raw ?? {}) as Partial<LorebookEntry>;
    const content = trimmed(e.content);
    if (!content) throw new PlanError('追加するロアの本文が空です（lorebook.create）');
    const title = trimmed(e.title) || '（無題）';
    const keys = asIds(e.keys);
    if (e.character_id && !charIds.has(e.character_id)) {
      throw new PlanError(`ロアの対象キャラ ${e.character_id} はこの世界にありません`);
    }
    let note = '';
    if (keys.length === 0 && !e.always) {
      // キーも always も無いロアは、作られても絶対に発火しない（§7.2）
      warnings.push(`ロア「${title}」に発火語（keys）がありません。このままでは注入されません`);
      note = '発火条件なし';
    }
    rows.push({ op: 'create', kind: 'lore', id: '', character_name: '', title, content, note });
  }

  for (const raw of asArray(lore.update)) {
    const e = (raw ?? {}) as Partial<LorebookEntry> & { id?: string };
    const id = trimmed(e.id);
    const cur = loreById.get(id);
    if (!cur) {
      throw new PlanError(`ロアID ${id || '(空)'} はこの世界にありません（lorebook.update）`);
    }
    rows.push({ op: 'update', kind: 'lore', id, character_name: '',
      title: trimmed(e.title) || cur.title,
      content: e.content === undefined ? cur.content : trimmed(e.content), note: '' });
  }

  return {
    rows,
    warnings,
    stats: { before: statsOf(items), after: statsOf([...after.values()]) },
  };
}

/**
 * 整理案を適用する。
 * **1トランザクション。** 途中で失敗して半分だけ消えた状態を作らない（§17と同じ方針）。
 * better-sqlite3 のトランザクションは同期実行なので、この中で await しないこと。
 */
export function planApply(worldId: string, plan: MemoryPlan): PlanResult {
  // まず検証する。ここで投げれば1件も書き込まれない
  const preview = planPreview(worldId, plan);
  const mem = plan.memories ?? {};
  const lore = plan.lorebook ?? {};
  const charIds = new Set(listCharacters(worldId).map((c) => c.id));

  let memories = 0;
  let lorebook = 0;
  db.transaction(() => {
    for (const id of asIds(mem.disable)) {
      updateMemory(id, { enabled: 0 });
      memories++;
    }
    for (const id of asIds(mem.enable)) {
      updateMemory(id, { enabled: 1 });
      memories++;
    }
    for (const id of asIds(mem.delete)) {
      deleteMemory(id);
      memories++;
    }
    for (const raw of asArray(mem.update)) {
      const u = (raw ?? {}) as { id?: string; content?: string; subject?: string; pinned?: number };
      const patch: Partial<Memory> = {};
      if (u.content !== undefined) patch.content = trimmed(u.content);
      if (u.subject !== undefined) {
        const s = trimmed(u.subject);
        patch.subject = s && charIds.has(s) ? s : '';
      }
      if (u.pinned !== undefined) patch.pinned = u.pinned ? 1 : 0;
      updateMemory(trimmed(u.id), patch);
      memories++;
    }
    for (const raw of asArray(mem.create)) {
      const c = (raw ?? {}) as { character_id?: string; subject?: string; content?: string; pinned?: number };
      const s = trimmed(c.subject);
      createMemory(trimmed(c.character_id), {
        subject: s && charIds.has(s) ? s : '',
        content: trimmed(c.content),
        pinned: c.pinned ? 1 : 0,
        source: 'manual',
        // **日付は受け取らない。** LLMの申告する日付を信じない既存の方針に合わせる
        // （不変条件40）。統合した記憶は日付不明として作る
        game_time: null,
      });
      memories++;
    }
    for (const raw of asArray(lore.create)) {
      const e = (raw ?? {}) as Partial<LorebookEntry>;
      createLorebookEntry(worldId, {
        title: trimmed(e.title) || '（無題）',
        keys: asIds(e.keys),
        content: trimmed(e.content),
        category: e.category,
        character_id: e.character_id ?? null,
        always: e.always ? 1 : 0,
        priority: Number.isFinite(Number(e.priority)) ? Math.floor(Number(e.priority)) : 0,
      });
      lorebook++;
    }
    for (const raw of asArray(lore.update)) {
      const e = (raw ?? {}) as Partial<LorebookEntry> & { id?: string };
      const patch: Partial<LorebookEntry> = {};
      if (e.title !== undefined) patch.title = trimmed(e.title);
      if (e.content !== undefined) patch.content = trimmed(e.content);
      if (e.keys !== undefined) patch.keys = asIds(e.keys);
      if (e.category !== undefined) patch.category = e.category;
      updateLorebookEntry(trimmed(e.id), patch);
      lorebook++;
    }
  })();

  // 適用後の姿で統計を取り直す（プレビューの見込みではなく実測）
  const { items } = collect(worldId);
  return {
    rows: preview.rows,
    warnings: preview.warnings,
    stats: { before: preview.stats.before, after: statsOf(items) },
    applied: { memories, lorebook },
  };
}
