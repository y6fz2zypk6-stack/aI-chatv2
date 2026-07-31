import {
  MAX_VARS,
  VAR_KEY_RE,
  type EventVarOp,
  type VarSchemaEntry,
  type VarValue,
} from '../../../shared/types.js';

/**
 * 進行フラグ（state.vars）の検証と適用（v1.5.3 §2・§3.2・§4.1）。
 * スキーマに無いキーは書き込みを拒否し、型不一致・上限超過はその1件だけ捨てる。
 */

export type VarSource = 'llm' | 'system';

export interface ApplyVarsResult {
  vars: Record<string, VarValue>;
  warnings: string[];
}

export function schemaOf(schema: VarSchemaEntry[], key: string): VarSchemaEntry | undefined {
  return schema.find((s) => s.key === key);
}

/** 型ごとの既定値。スキーマに default があればそれを使う */
export function defaultValue(entry: VarSchemaEntry): VarValue {
  if (entry.default !== undefined) return entry.default;
  return entry.type === 'number' ? 0 : entry.type === 'boolean' ? false : '';
}

/** 条件式の評価などで使う「現在値」。未設定なら既定値 */
export function readVar(
  schema: VarSchemaEntry[],
  vars: Record<string, VarValue> | undefined,
  key: string,
): VarValue | undefined {
  const cur = vars?.[key];
  if (cur !== undefined) return cur;
  const entry = schemaOf(schema, key);
  return entry ? defaultValue(entry) : undefined;
}

/** スキーマの default で初期化した vars を作る（scenario.initial_state.vars が優先） */
export function seedVars(
  schema: VarSchemaEntry[],
  initial: Record<string, VarValue> | undefined,
): Record<string, VarValue> {
  const out: Record<string, VarValue> = {};
  for (const entry of schema) out[entry.key] = defaultValue(entry);
  for (const [k, v] of Object.entries(initial ?? {})) {
    if (schemaOf(schema, k)) out[k] = v;
  }
  return out;
}

function coerce(entry: VarSchemaEntry, value: VarValue): VarValue | null {
  if (entry.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return n;
  }
  if (entry.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }
  const s = String(value);
  return s.length > 32 ? s.slice(0, 32) : s;
}

/**
 * 1件の代入を適用する。棄却した場合は warnings に理由を積む。
 * source = 'llm' のとき update_mode = system_only のキーは破棄する。
 */
function assign(
  schema: VarSchemaEntry[],
  vars: Record<string, VarValue>,
  key: string,
  value: VarValue,
  source: VarSource,
  warnings: string[],
): void {
  if (!VAR_KEY_RE.test(key)) {
    warnings.push(`進行フラグ「${key}」はキー名の形式が不正なため無視しました`);
    return;
  }
  const entry = schemaOf(schema, key);
  if (!entry) {
    warnings.push(`進行フラグ「${key}」は世界のスキーマに定義がないため無視しました`);
    return;
  }
  if (source === 'llm' && (entry.update_mode ?? 'system_and_llm') === 'system_only') {
    warnings.push(`進行フラグ「${key}」はシステム専用のため、モデルの指定を無視しました`);
    return;
  }
  const coerced = coerce(entry, value);
  if (coerced === null) {
    warnings.push(`進行フラグ「${key}」の値「${String(value)}」は型（${entry.type}）に合わないため無視しました`);
    return;
  }

  let next = coerced;
  if (entry.type === 'number' && typeof next === 'number') {
    if (entry.min !== undefined && next < entry.min) {
      warnings.push(`進行フラグ「${key}」を下限 ${entry.min} に丸めました`);
      next = entry.min;
    }
    if (entry.max !== undefined && next > entry.max) {
      warnings.push(`進行フラグ「${key}」を上限 ${entry.max} に丸めました`);
      next = entry.max;
    }
    // monotonic は通常更新でのみ効く（候補切替・fork は保存済みの値を復元するだけ）
    if (entry.monotonic) {
      const cur = vars[key];
      if (typeof cur === 'number' && next < cur) {
        warnings.push(`進行フラグ「${key}」は後退できないため、${cur} → ${next} を棄却しました`);
        return;
      }
    }
  }

  if (vars[key] === undefined && Object.keys(vars).length >= MAX_VARS) {
    warnings.push(`進行フラグが上限（${MAX_VARS}件）に達しているため「${key}」を無視しました`);
    return;
  }
  vars[key] = next;
}

/** モデルの set_var（代入のみ）を適用する */
export function applySetVar(
  schema: VarSchemaEntry[],
  vars: Record<string, VarValue> | undefined,
  setVar: Record<string, VarValue> | undefined,
): ApplyVarsResult {
  const out = { ...(vars ?? {}) };
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(setVar ?? {})) {
    assign(schema, out, k, v, 'llm', warnings);
  }
  return { vars: out, warnings };
}

/** イベントの set_vars（op: set / add）を適用する */
export function applyVarOps(
  schema: VarSchemaEntry[],
  vars: Record<string, VarValue> | undefined,
  ops: EventVarOp[],
): ApplyVarsResult {
  const out = { ...(vars ?? {}) };
  const warnings: string[] = [];
  for (const op of ops) {
    if (op.op === 'add') {
      const entry = schemaOf(schema, op.key);
      if (!entry) {
        warnings.push(`進行フラグ「${op.key}」は世界のスキーマに定義がないため無視しました`);
        continue;
      }
      if (entry.type !== 'number') {
        warnings.push(`進行フラグ「${op.key}」は数値ではないため add を無視しました`);
        continue;
      }
      const cur = out[op.key];
      const base = typeof cur === 'number' ? cur : (defaultValue(entry) as number);
      assign(schema, out, op.key, base + Number(op.value ?? 0), 'system', warnings);
    } else {
      assign(schema, out, op.key, op.value, 'system', warnings);
    }
  }
  return { vars: out, warnings };
}

/** ステート編集UIからの手動更新（スキーマ検証はするが monotonic と system_only は課さない） */
export function applyManualVars(
  schema: VarSchemaEntry[],
  input: Record<string, VarValue>,
): ApplyVarsResult {
  const out: Record<string, VarValue> = {};
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const entry = schemaOf(schema, k);
    if (!entry) {
      warnings.push(`進行フラグ「${k}」は世界のスキーマに定義がないため無視しました`);
      continue;
    }
    const coerced = coerce(entry, v);
    if (coerced === null) {
      warnings.push(`進行フラグ「${k}」の値が型に合わないため無視しました`);
      continue;
    }
    out[k] = coerced;
  }
  return { vars: out, warnings };
}

/** 「進行状況」ブロック（§3.3）。public_state のみを読み、private_note は絶対に載せない */
export function buildVarsBlock(
  schema: VarSchemaEntry[],
  vars: Record<string, VarValue> | undefined,
): string {
  if (!schema.length) return '';
  const lines: string[] = [];
  for (const entry of schema) {
    const value = readVar(schema, vars, entry.key);
    if (value === undefined) continue;
    if ((entry.role ?? 'flag') === 'phase') {
      const phase = entry.phases?.find((p) => p.value === value);
      lines.push(`${entry.label || entry.key}:`);
      lines.push(`- 現在フェーズ: ${String(value)}${phase ? `「${phase.name}」` : ''}`);
      if (phase?.public_state) lines.push(`- 状況: ${phase.public_state}`);
      lines.push('');
    } else {
      lines.push(`${entry.key} = ${String(value)}${entry.label ? `（${entry.label}）` : ''}`);
    }
  }
  const body = lines.join('\n').trim();
  return body ? `# 進行状況\n${body}` : '';
}

/** §3.1 の指示文。使えるキーの一覧を添える */
export function varsInstruction(schema: VarSchemaEntry[]): string {
  const writable = schema.filter((s) => (s.update_mode ?? 'system_and_llm') !== 'system_only');
  if (!writable.length) return '';
  return `# 進行状況の更新
物語の段階が進んだ場合のみ、@@@STATE ブロック内に次の行を追加すること。
set_var: キー=値
- 複数ある場合はカンマで区切る。例: set_var: ${writable[0].key}=${writable[0].type === 'boolean' ? 'true' : '1'}
- 使用できるキーと意味は「進行状況」に示したものだけ。
- 変化がないターンでは、この行を書かないこと。`;
}
