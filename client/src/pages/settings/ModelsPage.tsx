import { useState } from 'react';
import type { ConnectionView } from '@shared/types';
import { api } from '../../api';
import { Field, SectionHead, SettingRow, Stepper } from '../../components';
import { Icon } from '../../icons';
import { useModelGroups } from '../../models';
import { useApp } from '../../store';
import { ConnectionEditor, Loading, ModelSelect, Note, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/** モデルと接続先。会話の本文に使うモデルと、裏方の処理に使うモデルを分けて置く */
export default function ModelsPage() {
  const { settings, set } = useSettings();
  /** 接続先（§6.6）。モデルの選択肢もここから組む */
  const { groups, connections, reload } = useModelGroups();
  const [editing, setEditing] = useState<Partial<ConnectionView> | null>(null);
  const toast = useApp((s) => s.toast);

  if (!settings) return <Loading title="モデルと接続先" />;

  return (
    <SettingsSubPage title="モデルと接続先">
      <div className="section">
        <SectionHead>会話の本文</SectionHead>
        <Note>新しい会話で使うモデル。会話ごとに、右上のピルからも切り替えられます</Note>
        <Field label="モデル">
          <ModelSelect value={settings.default_model} groups={groups} onChange={(v) => void set({ default_model: v })} />
        </Field>
        <Note>
          「（最新）」を選ぶと、新しい版が出たとき自動で切り替わります。書きぶりや料金が変わることがあるので、気になるときは版を固定してください。
        </Note>
        <SettingRow label="応答の長さの上限" unit="トークン" hint="1回の応答で書ける量。本文だけに効きます">
          <Stepper value={settings.max_tokens} step={256} min={256} onChange={(v) => void set({ max_tokens: v })} />
        </SettingRow>
      </div>

      <div className="section">
        <SectionHead>裏方の処理</SectionHead>
        <Note>あらすじ・メモリーの抽出・オートプレイの判断・ステートの別呼び出しに使います</Note>
        <Field label="モデル">
          <ModelSelect value={settings.utility_model} groups={groups} onChange={(v) => void set({ utility_model: v })} />
        </Field>
        <SettingRow label="出力の上限" unit="トークン" hint="考えてから答えるモデルは、考える分もここから引かれます">
          <Stepper
            value={settings.utility_max_tokens}
            step={1024}
            min={512}
            max={65536}
            onChange={(v) => void set({ utility_max_tokens: v })}
          />
        </SettingRow>
      </div>

      {/* 接続先（§6.6）。OpenAI互換のサービスへ振り分ける */}
      <div className="section">
        <div className="head">
          <SectionHead>接続先</SectionHead>
          <button className="pill sm" onClick={() => setEditing({ name: '', base_url: '', context_length: 0 })}>
            <Icon.plus size={14} />
            追加
          </button>
        </div>
        {connections.map((c) => (
          <div key={c.id || 'builtin'} className="connrow">
            <div className="body">
              <b>{c.name}</b>
              <span className="mono">{c.base_url}</span>
              <div className="row wrap">
                {c.builtin && <span className="tag">.env</span>}
                <span className={`tag${c.has_key ? '' : ' mute'}`}>{c.has_key ? `キー ${c.key_hint}` : 'キー未設定'}</span>
                {c.context_length > 0 && (
                  <span className="tag mute">コンテキスト {c.context_length.toLocaleString()}</span>
                )}
                {c.in_use && !c.builtin && <span className="tag mute">使用中</span>}
              </div>
            </div>
            <div className="row">
              <button
                className="pill sm"
                onClick={async () => {
                  const r = await api.post<{ ok: boolean; message: string }>(`/connections/${c.id}/test`);
                  toast(r.message, !r.ok);
                }}
              >
                試す
              </button>
              {!c.builtin && (
                <button className="icon-btn" onClick={() => setEditing({ ...c })} aria-label="編集">
                  <Icon.pencil size={16} />
                </button>
              )}
            </div>
          </div>
        ))}
        {groups.some((g) => g.failed) && (
          <div className="warn-list">
            <div>
              モデル一覧を取れない接続先があります。`/models` を持たないサービスでは、モデル名を直接入力してください
            </div>
          </div>
        )}
        <Note>APIキーはこのサーバのデータベースに保存され、画面には末尾4文字だけ出ます。</Note>
      </div>

      {editing && (
        <ConnectionEditor
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </SettingsSubPage>
  );
}
