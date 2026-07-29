import { useEffect, useState } from 'react';
import { CURATED_MODELS, modelLabel, type Persona, type Settings } from '@shared/types';
import { api } from '../api';
import { Field, SettingRow, Stepper, Toggle, TopBar } from '../components';
import { useApp } from '../store';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    api.get<Settings>('/settings').then(setSettings).catch(() => {});
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => {});
  }, []);

  if (!settings) return <div className="empty-note">読み込み中…</div>;

  // 変更は即座に保存する（参照アプリと同じ挙動）
  const set = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await api.put('/settings', patch);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const modelOptions = (
    <>
      <option value="">既定（.env の設定）</option>
      {CURATED_MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </>
  );

  return (
    <>
      <TopBar title="設定" back="/chats" />
      <div className="content form">
        <div className="section">
          <span className="kicker">Generation</span>
          <Field label="既定モデル">
            <div className="select-wrap">
              <select
                value={CURATED_MODELS.some((m) => m.id === settings.default_model) ? settings.default_model : ''}
                onChange={(e) => void set({ default_model: e.target.value })}
              >
                {modelOptions}
              </select>
            </div>
          </Field>
          <SettingRow label="最大トークン" hint="1回の応答の長さの上限">
            <Stepper
              value={settings.max_tokens}
              step={256}
              min={256}
              onChange={(v) => void set({ max_tokens: v })}
            />
          </SettingRow>
          <SettingRow label="履歴の窓" hint="LLMに渡す生の履歴の件数">
            <Stepper
              value={settings.history_window}
              step={4}
              min={4}
              onChange={(v) => void set({ history_window: v })}
            />
          </SettingRow>
          <SettingRow label="コンテキスト安全余白" hint="モデルの上限から確保するトークン">
            <Stepper
              value={settings.context_safety_tokens}
              step={256}
              min={0}
              onChange={(v) => void set({ context_safety_tokens: v })}
            />
          </SettingRow>
        </div>

        <div className="section">
          <span className="kicker">Summary & Memory</span>
          <SettingRow label="自動要約" hint="長い会話を折りたたんで注入">
            <Toggle
              on={settings.auto_summarize === 1}
              onChange={(v) => void set({ auto_summarize: v ? 1 : 0 })}
            />
          </SettingRow>
          {settings.auto_summarize === 1 && (
            <>
              <SettingRow label="要約する間隔（メッセージ）" sub>
                <Stepper
                  value={settings.summary_interval}
                  step={2}
                  min={4}
                  onChange={(v) => void set({ summary_interval: v })}
                />
              </SettingRow>
              <SettingRow label="あらすじの目安（文字）" sub>
                <Stepper
                  value={settings.summary_max_chars}
                  step={100}
                  min={100}
                  onChange={(v) => void set({ summary_max_chars: v })}
                />
              </SettingRow>
            </>
          )}
          <SettingRow label="自動抽出" hint="会話からメモリー候補を拾う">
            <Toggle
              on={settings.auto_extract === 1}
              onChange={(v) => void set({ auto_extract: v ? 1 : 0 })}
            />
          </SettingRow>
          <Field label="要約・抽出のモデル">
            <div className="select-wrap">
              <select
                value={CURATED_MODELS.some((m) => m.id === settings.utility_model) ? settings.utility_model : ''}
                onChange={(e) => void set({ utility_model: e.target.value })}
              >
                {modelOptions}
              </select>
            </div>
          </Field>
        </div>

        <div className="section">
          <span className="kicker">Lorebook</span>
          <SettingRow
            label="ロアブックの走査回数"
            hint="1=会話本文のみ。2以上は発火したロアの中の語も辿る"
          >
            <Stepper
              value={settings.lore_recursion}
              min={1}
              max={4}
              onChange={(v) => void set({ lore_recursion: v })}
            />
          </SettingRow>
          <SettingRow label="キーワード走査窓" hint="直近この件数の本文から発火を判定">
            <Stepper
              value={settings.lore_scan_window}
              min={1}
              onChange={(v) => void set({ lore_scan_window: v })}
            />
          </SettingRow>
          <SettingRow label="注入予算（文字）" hint="超えた分はそのターンは落とす">
            <Stepper
              value={settings.lore_budget_chars}
              step={1000}
              min={1000}
              onChange={(v) => void set({ lore_budget_chars: v })}
            />
          </SettingRow>
        </div>

        <div className="section">
          <span className="kicker">Autoplay</span>
          <SettingRow label="オートプレイの継続をAIが判断" hint="区切りが良ければ自動で止まる">
            <Toggle
              on={settings.autoplay_judge === 1}
              onChange={(v) => void set({ autoplay_judge: v ? 1 : 0 })}
            />
          </SettingRow>
          <SettingRow label="最大上限ターン" sub>
            <Stepper
              value={settings.autoplay_steps}
              min={1}
              onChange={(v) => void set({ autoplay_steps: v })}
            />
          </SettingRow>
        </div>

        <div className="section">
          <span className="kicker">State</span>
          <SettingRow label="ステート機能" hint="時刻・場所・在席をアプリが管理する">
            <Toggle
              on={settings.state_enabled === 1}
              onChange={(v) => void set({ state_enabled: v ? 1 : 0 })}
            />
          </SettingRow>
          <Field label="ステートの抽出方式">
            <div className="select-wrap">
              <select
                value={settings.state_extraction_mode}
                onChange={(e) =>
                  void set({
                    state_extraction_mode: e.target.value as Settings['state_extraction_mode'],
                  })
                }
              >
                <option value="fenced">応答末尾のフェンス（既定）</option>
                <option value="separate_call">別コールで抽出（軽量モデル）</option>
              </select>
            </div>
          </Field>
        </div>

        <div className="section">
          <span className="kicker">Persona</span>
          <Field label="既定のペルソナ">
            <div className="select-wrap">
              <select
                value={settings.active_persona_id}
                onChange={(e) => void set({ active_persona_id: e.target.value })}
              >
                <option value="">（ペルソナ側の既定に従う）</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        </div>

        <div className="section">
          <span className="kicker">System Prompt</span>
          <Field label="アプリ全体共通の指示">
            <textarea
              className="tall"
              value={settings.system_prompt}
              onChange={(e) => setSettings({ ...settings, system_prompt: e.target.value })}
              onBlur={(e) => void set({ system_prompt: e.target.value })}
            />
          </Field>
        </div>

        <div className="empty-note">
          変更は自動で保存されます
          <br />
          現在の既定モデル: {modelLabel(settings.default_model)}
        </div>
      </div>
    </>
  );
}
