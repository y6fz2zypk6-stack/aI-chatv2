import type {
  CalendarConfig,
  ChatState,
  EventCondition,
  EventEvalRow,
  EventFire,
  Location,
  VarSchemaEntry,
  VarValue,
  WorldEvent,
} from '../../../shared/types.js';
import { parseHhmm } from '../../../shared/types.js';
import { MIN_PER_DAY, toGameTime } from './calendar.js';
import { readVar } from './vars.js';
import { seededRandom } from '../util/random.js';

// ===========================================================================
// 条件式（v1.5.3 §5）
// オブジェクトの複数キーは AND、配列で与えた値は OR。all / any / not で入れ子にできる。
// ===========================================================================

export interface EvalContext {
  state: ChatState;
  calendar: CalendarConfig;
  locations: Location[];
  varsSchema: VarSchemaEntry[];
  /** vars_enabled = 0 のとき var 述語は常に偽（§5.2） */
  varsEnabled: boolean;
}

function asList<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * 述語の一覧。**評価器とバリデータでここを共有する**（片方だけ増えると
 * 「保存できるのに効かない」「効くのに保存できない」がすぐ生まれる）。
 */
const PREDICATE_KEYS = [
  'season', 'month', 'week', 'weekday',
  'time_after', 'time_before',
  'location', 'location_area', 'weather',
  'present_has', 'present_lacks',
  'var', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in',
] as const;
const NESTED_KEYS = ['all', 'any', 'not'] as const;
const COMPARATOR_KEYS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'] as const;
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([...PREDICATE_KEYS, ...NESTED_KEYS]);

/**
 * 知らないキーが混ざっていないか。
 *
 * **これが無いと、キー名の誤字が「常に真」になる。** 述語を1つずつ見て
 * 「該当しなければ次へ」という作りなので、`{ seazon: "秋" }` はどの分岐にも
 * 引っかからないまま最後の `return true` に落ちる。EVENTS.md §14 は失敗を
 * すべて「静かに発火しない」側で説明しているのに、ここだけ逆へ振れてしまう。
 *
 * 比較子だけあって `var` が無い形（`{ eq: 1 }`）も同じ理由で弾く。
 */
function hasOnlyKnownKeys(cond: EventCondition): boolean {
  const keys = Object.keys(cond);
  if (keys.some((k) => !KNOWN_KEYS.has(k))) return false;
  if (cond.var === undefined && COMPARATOR_KEYS.some((k) => cond[k] !== undefined)) return false;
  return true;
}

function compareVar(cond: EventCondition, value: VarValue | undefined): boolean {
  if (value === undefined) return false;
  if (cond.eq !== undefined) return value === cond.eq;
  if (cond.ne !== undefined) return value !== cond.ne;
  if (cond.in !== undefined) return cond.in.includes(value);
  if (typeof value !== 'number') return false;
  if (cond.gt !== undefined) return value > cond.gt;
  if (cond.gte !== undefined) return value >= cond.gte;
  if (cond.lt !== undefined) return value < cond.lt;
  if (cond.lte !== undefined) return value <= cond.lte;
  // 比較子が無い場合は「値が真であること」とみなす
  return Boolean(value);
}

export function evalCondition(cond: EventCondition | null | undefined, ctx: EvalContext): boolean {
  if (!cond || Object.keys(cond).length === 0) return true;

  // 保存時にバリデータで弾いているが、それ以前に保存された条件式が残っている。
  // 解釈できないものは「満たさない」に倒す（time_after の扱いと揃える）
  if (!hasOnlyKnownKeys(cond)) return false;

  if (cond.all && !cond.all.every((c) => evalCondition(c, ctx))) return false;
  if (cond.any && !cond.any.some((c) => evalCondition(c, ctx))) return false;
  if (cond.not && evalCondition(cond.not, ctx)) return false;

  const { state, calendar } = ctx;
  const gt = toGameTime(calendar, state.time);
  const minOfDay = state.time % MIN_PER_DAY;
  // location_note 使用中はエリアが導出できないので location 系は偽にする（§5.2）
  const usingNote = !!state.location_note;
  const loc = usingNote ? undefined : ctx.locations.find((l) => l.id === state.location);

  const season = asList(cond.season);
  if (season && !season.includes(gt.season)) return false;
  const month = asList(cond.month);
  if (month && !month.includes(gt.month)) return false;
  const week = asList(cond.week);
  if (week && !week.includes(gt.week)) return false;
  const weekday = asList(cond.weekday);
  if (weekday && !weekday.includes(gt.weekday)) return false;

  // 解釈できない時刻表記は「満たさない」とする。0分に丸めると常時真になり、
  // 全時間帯で発火してしまう（誤りが静かに広がる方向へ倒れる）
  if (cond.time_after !== undefined) {
    const t = parseHhmm(cond.time_after);
    if (t === null || minOfDay < t) return false;
  }
  if (cond.time_before !== undefined) {
    const t = parseHhmm(cond.time_before);
    if (t === null || minOfDay >= t) return false;
  }

  const location = asList(cond.location);
  if (location && (usingNote || !location.includes(state.location))) return false;
  const area = asList(cond.location_area);
  if (area && (usingNote || !loc || !area.includes(loc.area))) return false;

  const weather = asList(cond.weather);
  if (weather && !weather.includes(state.weather)) return false;

  const has = asList(cond.present_has);
  if (has && !has.every((id) => state.present.includes(id))) return false;
  const lacks = asList(cond.present_lacks);
  if (lacks && lacks.some((id) => state.present.includes(id))) return false;

  if (cond.var !== undefined) {
    if (!ctx.varsEnabled) return false;
    if (!compareVar(cond, readVar(ctx.varsSchema, state.vars, cond.var))) return false;
  }

  return true;
}

// ---- 条件式の検証（保存時） ----

/** 実在チェックに使う参照先。渡さなかった項目は照合しない */
export interface ConditionRefs {
  locationIds?: Set<string>;
  areaIds?: Set<string>;
  varKeys?: Set<string>;
}

export interface ConditionCheck {
  errors: string[];
  /** 保存はできるが、ほぼ確実に意図と違う書き方 */
  warnings: string[];
}

const STRING_LIST_KEYS = ['season', 'weekday', 'location', 'location_area', 'weather',
  'present_has', 'present_lacks'] as const;
const NUMBER_LIST_KEYS = ['month', 'week'] as const;

/**
 * 条件式を保存前に検証する（§5.2）。
 *
 * 誤りを保存させないのが目的。評価器は「解釈できない＝満たさない」に倒すので、
 * 検証が無いと「保存はできたが永久に発火しない（あるいは常に発火する）」イベントが
 * 静かに出来上がる。
 */
export function validateCondition(cond: unknown, refs: ConditionRefs = {}): ConditionCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${path} はオブジェクトで書いてください`);
      return;
    }
    const c = node as Record<string, unknown>;

    for (const key of Object.keys(c)) {
      if (!KNOWN_KEYS.has(key)) {
        errors.push(`${path}.${key} は知らない項目です（近い綴りの誤りかもしれません）`);
      }
    }

    // 入れ子
    for (const key of ['all', 'any'] as const) {
      if (c[key] === undefined) continue;
      if (!Array.isArray(c[key])) {
        errors.push(`${path}.${key} は配列で書いてください`);
        continue;
      }
      (c[key] as unknown[]).forEach((child, i) => walk(child, `${path}.${key}[${i}]`));
    }
    if (c.not !== undefined) walk(c.not, `${path}.not`);

    // 値の型
    for (const key of STRING_LIST_KEYS) {
      const v = c[key];
      if (v === undefined) continue;
      const list = Array.isArray(v) ? v : [v];
      if (list.some((x) => typeof x !== 'string' || x === '')) {
        errors.push(`${path}.${key} は文字列（または文字列の配列）で書いてください`);
      }
    }
    for (const key of NUMBER_LIST_KEYS) {
      const v = c[key];
      if (v === undefined) continue;
      const list = Array.isArray(v) ? v : [v];
      if (list.some((x) => typeof x !== 'number' || !Number.isInteger(x))) {
        errors.push(`${path}.${key} は整数（または整数の配列）で書いてください`);
      }
    }

    // 時刻
    const times: Record<string, number> = {};
    for (const key of ['time_after', 'time_before'] as const) {
      const v = c[key];
      if (v === undefined) continue;
      const t = typeof v === 'string' ? parseHhmm(v) : null;
      if (t === null) errors.push(`${path}.${key} は "17:00" の形式で書いてください`);
      else times[key] = t;
    }
    if (times.time_after !== undefined && times.time_before !== undefined
      && times.time_after > times.time_before) {
      warnings.push(
        `${path} の time_after が time_before より後です。この書き方では決して満たされません` +
          '（日をまたぐ時間帯は any で2つに分けてください）',
      );
    }

    // 進行フラグ
    const comparators = COMPARATOR_KEYS.filter((k) => c[k] !== undefined);
    if (c.var === undefined) {
      if (comparators.length > 0) {
        errors.push(`${path}.${comparators[0]} は var と一緒に書いてください`);
      }
    } else {
      if (typeof c.var !== 'string' || c.var === '') {
        errors.push(`${path}.var は進行フラグのキー名で書いてください`);
      } else if (refs.varKeys && !refs.varKeys.has(c.var)) {
        errors.push(`${path}.var の "${c.var}" は、この世界の進行フラグにありません`);
      }
      if (comparators.length > 1) {
        errors.push(`${path} の比較子は1つだけにしてください（${comparators.join(' / ')}）`);
      }
      if (c.in !== undefined && !Array.isArray(c.in)) {
        errors.push(`${path}.in は配列で書いてください`);
      }
      for (const key of ['gt', 'gte', 'lt', 'lte'] as const) {
        if (c[key] !== undefined && typeof c[key] !== 'number') {
          errors.push(`${path}.${key} は数値で書いてください`);
        }
      }
    }

    // 実在チェック
    const check = (key: 'location' | 'location_area', ids: Set<string> | undefined, label: string) => {
      const v = c[key];
      if (v === undefined || !ids) return;
      for (const x of Array.isArray(v) ? v : [v]) {
        if (typeof x === 'string' && x !== '' && !ids.has(x)) {
          errors.push(`${path}.${key} の "${x}" は、この世界の${label}にありません`);
        }
      }
    };
    check('location', refs.locationIds, '場所');
    check('location_area', refs.areaIds, 'エリア');
  };

  walk(cond, 'when');
  return { errors, warnings };
}

// ===========================================================================
// 判定パイプライン（v1.5.3 §6）
// assistant の生成が完了し state_after が確定した直後にのみ走る。
// 注入は次のターンのプロンプトに載る。
// ===========================================================================

export interface PipelineInput {
  chatId: string;
  events: WorldEvent[];
  /** 直前メッセージの state_after（on_enter の「前」の評価に使う） */
  baseState: ChatState;
  /** 今回確定した state_after */
  newState: ChatState;
  calendar: CalendarConfig;
  locations: Location[];
  varsSchema: VarSchemaEntry[];
  varsEnabled: boolean;
  /** 抽選シードの judgeKey に使う。基準メッセージのID */
  baseMessageId: string;
  /** once_per_visit の訪問ID */
  visitId: string | null;
  /** そのチャットの発火履歴（event_id → 履歴） */
  firesByEvent: Map<string, EventFire[]>;
  maxPerTurn: number;
}

export interface PipelineResult {
  adopted: { event: WorldEvent; scopeKey: string }[];
  rows: EventEvalRow[];
}

function scopeKeyOf(e: WorldEvent, input: PipelineInput): string | null {
  const gt = toGameTime(input.calendar, input.newState.time);
  const daysPerYear = input.calendar.months_per_year * input.calendar.days_per_month;
  switch (e.trigger) {
    case 'once':
      return 'once';
    case 'once_per_day':
      return String(Math.floor(input.newState.time / MIN_PER_DAY));
    case 'once_per_visit':
      return input.visitId;
    case 'once_per_phase': {
      const value = readVar(input.varsSchema, input.newState.vars, e.trigger_var);
      return value === undefined ? null : `${e.trigger_var}:${String(value)}`;
    }
    case 'once_per_year':
      return String(Math.floor(Math.floor(input.newState.time / MIN_PER_DAY) / daysPerYear) + 1);
    default:
      // cooldown / repeat はスコープを持たない
      void gt;
      return null;
  }
}

/** §7: スコープを持つ trigger では judgeKey を scopeKey で「置き換える」（連結しない） */
function drawKeyOf(e: WorldEvent, input: PipelineInput, scopeKey: string | null): string {
  if (scopeKey !== null) return scopeKey;
  if (e.check === 'on_day_change') return String(Math.floor(input.newState.time / MIN_PER_DAY));
  return input.baseMessageId;
}

export function runEventPipeline(input: PipelineInput): PipelineResult {
  const rows: EventEvalRow[] = [];
  const candidates: { event: WorldEvent; scopeKey: string }[] = [];

  const ctxFor = (state: ChatState): EvalContext => ({
    state,
    calendar: input.calendar,
    locations: input.locations,
    varsSchema: input.varsSchema,
    varsEnabled: input.varsEnabled,
  });
  const newCtx = ctxFor(input.newState);
  const baseCtx = ctxFor(input.baseState);

  const dayChanged =
    Math.floor(input.newState.time / MIN_PER_DAY) !== Math.floor(input.baseState.time / MIN_PER_DAY);
  const locationChanged =
    input.newState.location !== input.baseState.location ||
    input.newState.location_note !== input.baseState.location_note;

  for (const e of input.events) {
    if (!e.enabled) continue;
    const row = (outcome: EventEvalRow['outcome'], detail?: string): void => {
      rows.push({ id: e.id, title: e.title, kind: e.kind, inject_mode: e.inject_mode, outcome, detail });
    };

    // 2. when の評価
    if (!evalCondition(e.when, newCtx)) {
      row('condition');
      continue;
    }

    // 3. check の判定
    if (e.check === 'on_enter') {
      // 状態を保存せず、基準ステートと新ステートの両方で評価して false → true を見る
      if (evalCondition(e.when, baseCtx)) {
        row('check', '条件が前ターンから継続中');
        continue;
      }
    } else if (e.check === 'on_day_change' && !dayChanged) {
      row('check', '日付が変わっていない');
      continue;
    } else if (e.check === 'on_location_change' && !locationChanged) {
      row('check', '場所が変わっていない');
      continue;
    }

    // 4. trigger / cooldown の判定
    const scopeKey = scopeKeyOf(e, input);
    const fires = input.firesByEvent.get(e.id) ?? [];
    if (e.trigger === 'once_per_phase' && (!e.trigger_var || scopeKey === null)) {
      row('trigger', 'trigger_var が未設定または未定義');
      continue;
    }
    if (e.trigger === 'once_per_visit' && scopeKey === null) {
      // location_note 使用中は訪問IDを作らない
      row('trigger', '訪問IDを特定できない');
      continue;
    }
    if (scopeKey !== null) {
      if (fires.some((f) => f.scope_key === scopeKey)) {
        row('trigger', `同じスコープ（${scopeKey}）で発火済み`);
        continue;
      }
    } else if (e.trigger === 'cooldown') {
      const last = fires.reduce((mx, f) => Math.max(mx, f.fired_at_time), -Infinity);
      if (Number.isFinite(last) && input.newState.time - last < e.cooldown_days * MIN_PER_DAY) {
        row('trigger', 'クールダウン中');
        continue;
      }
    }
    // repeat は履歴を見ない

    // 5. chance の抽選（シード固定）
    if (e.chance < 1) {
      const drawKey = drawKeyOf(e, input, scopeKey);
      const r = seededRandom(`${input.chatId}:${e.id}:${drawKey}`);
      if (r >= e.chance) {
        row('chance', `抽選外れ（${r.toFixed(3)} ≧ ${e.chance}）`);
        continue;
      }
    }

    candidates.push({ event: e, scopeKey: scopeKey ?? '' });
  }

  // 6. priority DESC, id ASC で並べて上位 maxPerTurn 件
  candidates.sort((a, b) =>
    a.event.priority !== b.event.priority
      ? b.event.priority - a.event.priority
      : a.event.id < b.event.id ? -1 : 1,
  );

  const adopted: { event: WorldEvent; scopeKey: string }[] = [];
  let instructionUsed = false;
  for (const c of candidates) {
    if (adopted.length >= input.maxPerTurn) {
      rows.push({ id: c.event.id, title: c.event.title, kind: c.event.kind,
        inject_mode: c.event.inject_mode, outcome: 'capped', detail: '上限件数を超過' });
      continue;
    }
    // instruction は1ターン1件まで（§6.3）
    if (c.event.inject_mode === 'instruction') {
      if (instructionUsed) {
        rows.push({ id: c.event.id, title: c.event.title, kind: c.event.kind,
          inject_mode: c.event.inject_mode, outcome: 'capped', detail: '演出指示は1ターン1件まで' });
        continue;
      }
      instructionUsed = true;
    }
    adopted.push(c);
    rows.push({ id: c.event.id, title: c.event.title, kind: c.event.kind,
      inject_mode: c.event.inject_mode, outcome: 'adopted' });
  }

  return { adopted, rows };
}

/** 「発生中の出来事」「今回の演出指示」ブロック（§6.3）。採用0件なら見出しごと省略 */
export function buildEventBlocks(events: WorldEvent[]): { facts: string; instructions: string } {
  const sorted = [...events].sort((a, b) => b.priority - a.priority);
  const facts = sorted.filter((e) => e.inject_mode === 'fact' && e.inject).map((e) => e.inject);
  const instructions = sorted
    .filter((e) => e.inject_mode === 'instruction' && e.inject)
    .map((e) => e.inject);
  return {
    facts: facts.length ? `# 発生中の出来事\n${facts.join('\n')}` : '',
    instructions: instructions.length ? `# 今回の演出指示\n${instructions.join('\n')}` : '',
  };
}
