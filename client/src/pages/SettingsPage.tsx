import { useEffect, useState } from 'react';
import type { ModelInfo, Persona, Settings } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    api.get<Settings>('/settings').then(setSettings).catch(() => {});
    api.get<ModelInfo[]>('/models').then(setModels).catch(() => {});
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => {});
  }, []);

  if (!settings) return <main className="page">読み込み中…</main>;

  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  const num = (v: string, fallback: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  const save = async () => {
    try {
      const saved = await api.put<Settings>('/settings', settings);
      setSettings(saved);
      toast('設定を保存しました');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <main className="page">
      <h1 className="page-title">⚙️ 設定</h1>

      <div className="section-title">モデル</div>
      <div className="card">
        <div className="field">
          <label>既定モデル</label>
          <input
            className="input"
            list="model-list"
            value={settings.default_model}
            onChange={(e) => set({ default_model: e.target.value })}
          />
        </div>
        <div className="field">
          <label>ユーティリティモデル（要約・抽出・判定）</label>
          <input
            className="input"
            list="model-list"
            value={settings.utility_model}
            onChange={(e) => set({ utility_model: e.target.value })}
          />
        </div>
        <datalist id="model-list">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
        <div className="grid-2">
          <div className="field">
            <label>max_tokens（本文の目安）</label>
            <input
              className="input"
              type="number"
              value={settings.max_tokens}
              onChange={(e) => set({ max_tokens: num(e.target.value, 2048) })}
            />
          </div>
          <div className="field">
            <label>コンテキスト安全余白（tokens）</label>
            <input
              className="input"
              type="number"
              value={settings.context_safety_tokens}
              onChange={(e) => set({ context_safety_tokens: num(e.target.value, 1024) })}
            />
          </div>
          <div className="field">
            <label>fallback_context_length</label>
            <input
              className="input"
              type="number"
              value={settings.fallback_context_length}
              onChange={(e) => set({ fallback_context_length: num(e.target.value, 32768) })}
            />
          </div>
          <div className="field">
            <label>履歴窓（件）</label>
            <input
              className="input"
              type="number"
              value={settings.history_window}
              onChange={(e) => set({ history_window: num(e.target.value, 48) })}
            />
          </div>
        </div>
      </div>

      <div className="section-title">共通システムプロンプト</div>
      <div className="card">
        <textarea
          className="textarea"
          rows={5}
          value={settings.system_prompt}
          onChange={(e) => set({ system_prompt: e.target.value })}
        />
      </div>

      <div className="section-title">要約・メモリー</div>
      <div className="card">
        <label className="checkbox-row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.auto_summarize === 1}
            onChange={(e) => set({ auto_summarize: e.target.checked ? 1 : 0 })}
          />
          自動要約
        </label>
        <label className="checkbox-row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.auto_extract === 1}
            onChange={(e) => set({ auto_extract: e.target.checked ? 1 : 0 })}
          />
          知識の自動抽出（トークン消費が増えます）
        </label>
        <div className="grid-2">
          <div className="field">
            <label>要約の間隔（未要約件数）</label>
            <input
              className="input"
              type="number"
              value={settings.summary_interval}
              onChange={(e) => set({ summary_interval: num(e.target.value, 32) })}
            />
          </div>
          <div className="field">
            <label>あらすじの目安（文字）</label>
            <input
              className="input"
              type="number"
              value={settings.summary_max_chars}
              onChange={(e) => set({ summary_max_chars: num(e.target.value, 500) })}
            />
          </div>
        </div>
      </div>

      <div className="section-title">ロアブック</div>
      <div className="card">
        <div className="grid-2">
          <div className="field">
            <label>再帰走査（1〜4）</label>
            <input
              className="input"
              type="number"
              min={1}
              max={4}
              value={settings.lore_recursion}
              onChange={(e) => set({ lore_recursion: num(e.target.value, 1) })}
            />
          </div>
          <div className="field">
            <label>キーワード走査窓（件）</label>
            <input
              className="input"
              type="number"
              value={settings.lore_scan_window}
              onChange={(e) => set({ lore_scan_window: num(e.target.value, 8) })}
            />
          </div>
          <div className="field">
            <label>注入予算（文字）</label>
            <input
              className="input"
              type="number"
              value={settings.lore_budget_chars}
              onChange={(e) => set({ lore_budget_chars: num(e.target.value, 12000) })}
            />
          </div>
        </div>
      </div>

      <div className="section-title">ステート</div>
      <div className="card">
        <label className="checkbox-row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.state_enabled === 1}
            onChange={(e) => set({ state_enabled: e.target.checked ? 1 : 0 })}
          />
          ステート機能（時刻・場所・在席の管理）
        </label>
        <div className="field">
          <label>ステート抽出方式</label>
          <select
            className="select"
            value={settings.state_extraction_mode}
            onChange={(e) =>
              set({ state_extraction_mode: e.target.value as Settings['state_extraction_mode'] })
            }
          >
            <option value="fenced">fenced（応答末尾のフェンス・既定）</option>
            <option value="separate_call">separate_call（別コール抽出・未実装 Phase 5）</option>
          </select>
        </div>
      </div>

      <div className="section-title">既定ペルソナ</div>
      <div className="card">
        <select
          className="select"
          value={settings.active_persona_id}
          onChange={(e) => set({ active_persona_id: e.target.value })}
        >
          <option value="">（ペルソナの既定設定に従う）</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={save}>
          保存
        </button>
      </div>
    </main>
  );
}
