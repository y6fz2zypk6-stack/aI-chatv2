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
