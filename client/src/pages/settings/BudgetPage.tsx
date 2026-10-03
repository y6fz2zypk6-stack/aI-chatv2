import { useEffect, useState } from 'react';
import { modelLabel, parseModelRef, type ConnectionView, type ModelInfo } from '@shared/types';
import { api } from '../../api';
import { SettingRow, Stepper } from '../../components';
import { Loading, More, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/** 本文の生成で、応答の上限に足しているゆとり（server/src/routes/messages.ts と同じ値） */
const FENCE_ALLOWANCE = 200;

/**
 * 文脈の予算。1回の呼び出しに何をどれだけ渡すか。
 * 内訳の計算は server/src/llm/prompt.ts の入力予算と同じ式
 * （コンテキスト長 −（max_tokens＋200）− 安全余白）
 */
export default function BudgetPage() {
  const { settings, set } = useSettings();
  /** 既定モデルのコンテキスト長。取れなければ null（想定コンテキスト長で見積もる） */
  const [known, setKnown] = useState<{ length: number; model: string } | null>(null);

  const ref = settings?.default_model ?? '';
  useEffect(() => {
    if (!ref) return;
    let alive = true;
    void (async () => {
      const { connectionId, modelId } = parseModelRef(ref);
      try {
        const conns = await api.get<ConnectionView[]>('/connections');
        const conn = conns.find((c) => c.id === (connectionId ?? ''));
        if (conn && conn.context_length > 0) {
          if (alive) setKnown({ length: conn.context_length, model: ref });
          return;
        }
        const models = await api.get<ModelInfo[]>(`/models?connection=${encodeURIComponent(connectionId ?? '')}`);
        const m = models.find((x) => x.id === modelId);
        if (alive) setKnown(m?.context_length ? { length: m.context_length, model: ref } : null);
      } catch {
        if (alive) setKnown(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ref]);

  if (!settings) return <Loading title="文脈の予算" />;

  const ctx = known?.length ?? settings.fallback_context_length;
  const reply = settings.max_tokens + FENCE_ALLOWANCE;
  const safety = settings.context_safety_tokens;
  const input = ctx - reply - safety;
  const pct = (n: number) => `${Math.max(0, (n / ctx) * 100)}%`;
  const n = (v: number) => v.toLocaleString();

  return (
    <SettingsSubPage title="文脈の予算">
      <div className="section">
        <label className="lbl">1回の呼び出しの内訳</label>
        <div className="budget-bar" aria-hidden="true">
          <span className="in" style={{ width: pct(Math.max(0, input)) }} />
          <span className="out" style={{ width: pct(reply) }} />
          <span className="safe" style={{ width: pct(safety) }} />
        </div>
        <ul className="budget-legend">
          <li>
            <i className="in" />
            入力に使える分 <b>{n(Math.max(0, input))}</b>
          </li>
          <li>
            <i className="out" />
            応答の分 <b>{n(reply)}</b>
          </li>
          <li>
            <i className="safe" />
            安全余白 <b>{n(safety)}</b>
          </li>
        </ul>
        <p className="set-note">
          {known
            ? `コンテキスト長 ${n(ctx)}（${modelLabel(known.model)}）`
            : `コンテキスト長 ${n(ctx)}（想定コンテキスト長。既定モデルの上限が分からないため）`}
        </p>
        {input <= 0 && (
          <div className="warn-list">
            <div>
              入力に使える分がありません。応答の長さの上限か安全余白を減らすか、想定コンテキスト長を見直してください
            </div>
          </div>
        )}
      </div>

      <SettingRow label="履歴の窓" unit="件" hint="あらすじより後の会話を、最大この件数まで渡します">
        <Stepper value={settings.history_window} step={4} min={4} onChange={(v) => void set({ history_window: v })} />
      </SettingRow>
      <SettingRow label="安全余白" unit="トークン" hint="文字数からの見積もりがずれても溢れないよう、空けておく分">
        <Stepper
          value={settings.context_safety_tokens}
          step={256}
          min={0}
          onChange={(v) => void set({ context_safety_tokens: v })}
        />
      </SettingRow>
      <SettingRow label="想定コンテキスト長" unit="トークン" hint="モデルの上限が分からないとき、この長さとみなします">
        <Stepper
          value={settings.fallback_context_length}
          step={4096}
          min={4096}
          onChange={(v) => void set({ fallback_context_length: v })}
        />
      </SettingRow>
      <More summary="入りきらないときは">
        古い履歴 → キーワードのロア → 場所・季節のロア → 古いメモリーの順に削ります。常に入れるロアとピン留めのメモリーは削りません。
      </More>
    </SettingsSubPage>
  );
}
