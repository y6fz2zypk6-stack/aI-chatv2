import type {
  CalendarConfig,
  Character,
  ChatState,
  Location,
  StateDelta,
  VarSchemaEntry,
} from '../../../shared/types.js';
import { drawWeather, toGameTime, toTotalDay } from './calendar.js';
import { applySetVar } from './vars.js';

export interface ApplyResult {
  state: ChatState;
  dayChanged: boolean;
  warnings: string[];
}

export interface ApplyOptions {
  /** 天候の抽選に使う乱数。既定はシード無し（テスト・後方互換用） */
  rand?: () => number;
  /** 進行フラグのスキーマ。vars_enabled = 1 のときだけ set_var を適用する */
  varsSchema?: VarSchemaEntry[];
  varsEnabled?: boolean;
}

/**
 * ステート差分の適用（§8.1）。
 * 基準ステートは呼び出し側が「直前メッセージの state_after」を渡すこと。
 */
export function applyDelta(
  cfg: CalendarConfig,
  base: ChatState,
  delta: StateDelta,
  locations: Location[],
  characters: Character[],
  options: ApplyOptions = {},
): ApplyResult {
  const rand = options.rand ?? Math.random;
  const warnings: string[] = [];
  const state: ChatState = { ...base, present: [...base.present], vars: { ...(base.vars ?? {}) } };

  // elapsed_minutes < 0 は 0 として扱う。> 1440 はそのまま適用し、UI側でバッジ表示
  let elapsed = Math.floor(delta.elapsed_minutes);
  if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;
  if (elapsed > 1440) warnings.push(`elapsed_minutes が ${elapsed} 分（24時間超）`);
  // 読めなかった指定は既定値で進める。黙って進めると、なぜその時刻になったのか追えない
  if (delta.elapsed_unparsed) {
    warnings.push(
      `elapsed_minutes の「${delta.elapsed_unparsed}」を読み取れませんでした。${elapsed}分として進めます`,
    );
  }

  // 場所: ID一致 → 表示名一致 → location_note へ退避
  if (delta.location) {
    const byId = locations.find((l) => l.id === delta.location);
    const byName = byId ? undefined : locations.find((l) => l.name === delta.location);
    const loc = byId ?? byName;
    if (loc) {
      state.location = loc.id;
      state.location_note = '';
    } else if (delta.location !== base.location && delta.location !== base.location_note) {
      // 未登録の場所 → location は変更せず note に退避
      state.location_note = delta.location;
      warnings.push(`未登録の場所「${delta.location}」を location_note に退避`);
    }
  }

  // present: (present ∪ add) − remove。未登録IDは aliases で名寄せ、それでも駄目なら無視
  const resolveCharId = (idOrName: string): string | null => {
    const byId = characters.find((c) => c.id === idOrName);
    if (byId) return byId.id;
    const byName = characters.find((c) => c.name === idOrName || c.aliases.includes(idOrName));
    return byName ? byName.id : null;
  };
  const present = new Set(state.present);
  for (const raw of delta.present_add) {
    const id = resolveCharId(raw);
    if (id) present.add(id);
    else warnings.push(`present_add の「${raw}」を解決できず無視`);
  }
  for (const raw of delta.present_remove) {
    const id = resolveCharId(raw);
    if (id) present.delete(id);
    else warnings.push(`present_remove の「${raw}」を解決できず無視`);
  }
  state.present = [...present];

  // 進行フラグ（§3.2）。無効時は set_var 行を破棄して警告のみ残す（§1.2）
  if (delta.set_var && Object.keys(delta.set_var).length) {
    if (options.varsEnabled) {
      const r = applySetVar(options.varsSchema ?? [], state.vars, delta.set_var);
      state.vars = r.vars;
      warnings.push(...r.warnings);
    } else {
      warnings.push('進行フラグが無効のため set_var を無視しました');
    }
  }

  // 時間適用と日替わり判定 → 天候は日付が変わったときのみ抽選（§8.2）
  const newTime = base.time + elapsed;
  const dayChanged = toTotalDay(newTime) !== toTotalDay(base.time);
  if (dayChanged) {
    const season = toGameTime(cfg, newTime).season;
    state.weather = drawWeather(cfg, season, rand);
  }
  state.time = newTime;

  return { state, dayChanged, warnings };
}

/** ステート編集パネルからの手動更新用の正規化 */
export function normalizeState(input: Partial<ChatState>, base: ChatState): ChatState {
  return {
    time: Number.isFinite(input.time) ? Math.max(0, Math.floor(input.time!)) : base.time,
    location: input.location ?? base.location,
    location_note: input.location_note ?? base.location_note,
    weather: input.weather ?? base.weather,
    present: Array.isArray(input.present) ? input.present : base.present,
    vars: input.vars ?? base.vars ?? {},
  };
}
