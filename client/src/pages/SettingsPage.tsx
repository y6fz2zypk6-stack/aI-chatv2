import { useEffect, useState } from 'react';
import {
  modelLabel,
  parseModelRef,
  summarizeEveryMessages,
  type ConnectionView,
  type Persona,
  type Settings,
} from '@shared/types';
import { api } from '../api';
import { Field, Modal, SettingRow, Stepper, Toggle, TopBar } from '../components';
import { Icon } from '../icons';
import { useModelGroups, type ModelGroup } from '../models';
import { ask, useApp } from '../store';

/**
 * モデルの選択肢を接続先ごとに `<optgroup>` で分ける（§6.6）。
 * 値は `<接続先ID>::<モデルID>`。組み込みは区切り無しの素のモデルID。
 */
function ModelSelect({
  value,
  groups,
  onChange,
}: {
  value: string;
  groups: ModelGroup[];
  onChange: (ref: string) => void;
}) {
  const known = groups.some((g) => g.options.some((o) => o.ref === value));
  return (
    <div className="select-wrap">
      <select value={known ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">既定（.env の設定）</option>
        {/* 一覧に無いIDを選んでいるとき（自由入力・消えたモデル）も見えるようにする */}
        {!known && value && <option value={value}>{value}（一覧に無い指定）</option>}
        {groups.map((g) => (
          <optgroup key={g.connection.id || 'builtin'} label={g.connection.name}>
            {g.options.map((o) => (
              <option key={o.ref} value={o.ref}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  /** 画像モデルの候補。取れなくても手打ちできるので、失敗は黙って無視する */
  const [imageModels, setImageModels] = useState<string[]>([]);
  /** 接続先（§6.6）。モデルの選択肢もここから組む */
  const { groups, connections, reload } = useModelGroups();
  const [editing, setEditing] = useState<Partial<ConnectionView> | null>(null);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    api.get<Settings>('/settings').then(setSettings).catch(() => {});
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => {});
    api
      .get<{ data?: { id?: string }[] }>('/images/models')
      .then((r) => setImageModels((r.data ?? []).map((m) => m.id ?? '').filter(Boolean)))
      .catch(() => {});
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

  return (
    <>
      <TopBar title="設定" back="/chats" />
      <div className="content form">
        {/* 接続先（§6.6）。OpenAI互換のサービスへ振り分ける */}
        <div className="section">
          <div className="head">
            <span className="kicker">Connections</span>
            <div className="row">
              <button
                className="pill sm"
                onClick={() => setEditing({ name: '', base_url: '', context_length: 0 })}
              >
                <Icon.plus size={14} />
                追加
              </button>
            </div>
          </div>
          {connections.map((c) => (
            <div key={c.id || 'builtin'} className="connrow">
              <div className="body">
                <b>{c.name}</b>
                <span className="mono">{c.base_url}</span>
                <div className="row wrap">
                  {c.builtin && <span className="tag">.env</span>}
                  <span className={`tag${c.has_key ? '' : ' mute'}`}>
                    {c.has_key ? `キー ${c.key_hint}` : 'キー未設定'}
                  </span>
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
                    const r = await api.post<{ ok: boolean; message: string }>(
                      `/connections/${c.id}/test`,
                    );
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
                モデル一覧を取れない接続先があります。`/models` を持たないサービスでは、
                モデル名を直接入力してください
              </div>
            </div>
          )}
          <div className="empty-note" style={{ textAlign: 'left', padding: '10px 0 0' }}>
            OpenAI互換のサービス（OpenAI直・DeepSeek直・Groq・手元のLM Studio など）を足せます。
            <b>APIキーはこのサーバのデータベースに保存されます</b>（画面には末尾4文字しか出ません）。
          </div>
        </div>

        <div className="section">
          <span className="kicker">Generation</span>
          <Field label="既定モデル">
            <ModelSelect
              value={settings.default_model}
              groups={groups}
              onChange={(v) => void set({ default_model: v })}
            />
          </Field>
          <SettingRow label="最大トークン" hint="1回の応答の長さの上限（本文の生成だけに効きます）">
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
              <SettingRow
                label="要約する間隔（メッセージ）"
                hint={`未要約がこの件数に達したら要約します。直近の一部は生のまま残すので、実際は約${summarizeEveryMessages(settings.summary_interval)}メッセージ（${Math.round(summarizeEveryMessages(settings.summary_interval) / 2)}ターン）ごとです`}
                sub
              >
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
              <Field label="要約の方針（何を残し、何を落とし、どう書くか）">
                <textarea
                  className="tall"
                  value={settings.summary_policy}
                  onChange={(e) => setSettings({ ...settings, summary_policy: e.target.value })}
                  onBlur={(e) => void set({ summary_policy: e.target.value })}
                />
              </Field>
              <div className="empty-note" style={{ padding: 0, textAlign: 'left' }}>
                「何を落とすか」を必ず書いてください。落とす基準が無いと、
                短くする方法が文を詰めることしか無くなり、冗漫なあらすじになります。
                <br />
                前回分との統合・人物設定を書かないこと・日付の付け方・文字数は、
                アプリ側で必ず付けるのでここに書く必要はありません。
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="pill sm"
                    onClick={async () => {
                      if (!(await ask({ title: '要約の方針を既定に戻しますか？', body: 'いまの内容は消えます。', okLabel: '既定に戻す' }))) return;
                      void api
                        .get<Settings>('/settings/defaults')
                        .then((d) => set({ summary_policy: d.summary_policy }));
                    }}
                  >
                    既定に戻す
                  </button>
                </div>
              </div>
            </>
          )}
          <SettingRow label="自動抽出" hint="会話からメモリー候補を拾う">
            <Toggle
              on={settings.auto_extract === 1}
              onChange={(v) => void set({ auto_extract: v ? 1 : 0 })}
            />
          </SettingRow>
          <Field label="要約・抽出のモデル">
            <ModelSelect
              value={settings.utility_model}
              groups={groups}
              onChange={(v) => void set({ utility_model: v })}
            />
          </Field>
          <SettingRow
            label="要約・抽出の最大トークン"
            hint="上の「最大トークン」とは別枠です。「上限で切れました」と出るときはここを上げてください（考えてから答えるモデルは、考えている分もここから引かれます）"
          >
            <Stepper
              value={settings.utility_max_tokens}
              step={1024}
              min={512}
              max={65536}
              onChange={(v) => void set({ utility_max_tokens: v })}
            />
          </SettingRow>
        </div>

        {/* スナップショット（§21）。モデルが空だと会話画面に入口を出さない */}
        <div className="section">
          <span className="kicker">Snapshot</span>
          <Field label="画像モデル（空にすると機能を使いません）">
            <input
              value={settings.image_model}
              onChange={(e) => void set({ image_model: e.target.value })}
              placeholder="openai/gpt-image-2"
              list="image-models"
            />
            <datalist id="image-models">
              {imageModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <div className="empty-note" style={{ padding: '6px 0 0', textAlign: 'left' }}>
              設定すると、AIの応答の「⋯」に「この場面を描く」が出ます。
              生成のたびに課金されるので、自動では作りません
            </div>
          </Field>
          <Field label="画風（すべてのスナップショットの先頭に付きます）">
            <textarea
              value={settings.image_style_prompt}
              onChange={(e) => void set({ image_style_prompt: e.target.value })}
              placeholder="anime illustration, soft lighting, watercolor"
            />
          </Field>
          <Field label="既定の比率">
            <div className="select-wrap">
              <select
                value={settings.image_aspect_ratio}
                onChange={(e) => void set({ image_aspect_ratio: e.target.value })}
              >
                {['16:9', '4:3', '1:1', '3:4', '9:16'].map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="既定の品質（対応しないモデルでは無視されます）">
            <div className="select-wrap">
              <select
                value={settings.image_quality}
                onChange={(e) => void set({ image_quality: e.target.value })}
              >
                <option value="low">低（安い・速い）</option>
                <option value="medium">中</option>
                <option value="high">高（高い・遅い）</option>
              </select>
            </div>
          </Field>
          <SettingRow
            label="画面に文字を描かせない"
            hint="地の文をそのまま渡すので、指示が無いと看板や書類の形で文字を描き込むことがあります"
          >
            <Toggle
              on={settings.image_no_text === 1}
              onChange={(v) => void set({ image_no_text: v ? 1 : 0 })}
            />
          </SettingRow>
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
          <span className="kicker">Events & Progress</span>
          <SettingRow label="条件付きイベント" hint="条件を満たしたターンに一文を注入する">
            <Toggle
              on={settings.events_enabled === 1}
              onChange={(v) => void set({ events_enabled: v ? 1 : 0 })}
            />
          </SettingRow>
          <SettingRow label="進行フラグ" hint="物語の段階や到達済みフラグをステートで持つ">
            <Toggle
              on={settings.vars_enabled === 1}
              onChange={(v) => void set({ vars_enabled: v ? 1 : 0 })}
            />
          </SettingRow>
          <SettingRow label="1ターンのイベント上限" hint="演出指示は上限に関わらず1件まで" sub>
            <Stepper
              value={settings.event_max_per_turn}
              min={1}
              max={5}
              onChange={(v) => void set({ event_max_per_turn: v })}
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
          {parseModelRef(settings.default_model).connectionId && (
            <>
              {' / '}
              {connections.find((c) => c.id === parseModelRef(settings.default_model).connectionId)
                ?.name ?? '不明な接続先'}
            </>
          )}
        </div>
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
    </>
  );
}

/**
 * 接続先の追加・編集。
 * **APIキーの欄は常に空で開く。** サーバはキーを返さないし（不変条件43）、
 * 触らなければ変わらない作りにしてある
 */
function ConnectionEditor({
  value,
  onClose,
  onSaved,
}: {
  value: Partial<ConnectionView>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(value.name ?? '');
  const [url, setUrl] = useState(value.base_url ?? '');
  const [key, setKey] = useState('');
  const [ctx, setCtx] = useState(value.context_length ?? 0);
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);
  const isNew = !value.id;

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name, base_url: url, context_length: ctx };
      // 空のままなら送らない（既存のキーを消さないため）
      if (key.trim() || isNew) body.api_key = key.trim();
      if (isNew) await api.post('/connections', body);
      else await api.put(`/connections/${value.id}`, body);
      onSaved();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/connections/${value.id}`);
      onSaved();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? '接続先を追加' : '接続先'}
      onClose={onClose}
      actions={
        <>
          {!isNew && (
            <button className="pill sm danger" disabled={busy} onClick={() => void remove()}>
              削除
            </button>
          )}
          <button className="pill sm primary" disabled={busy || !name.trim() || !url.trim()} onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      <Field label="名前">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="手元のLM Studio" autoFocus />
      </Field>
      <Field label="ベースURL">
        <input
          className="mono"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.deepseek.com/v1"
        />
        <div className="empty-note" style={{ padding: '6px 0 0', textAlign: 'left' }}>
          `/chat/completions` の<b>手前まで</b>を入れてください（末尾の `/v1` まで）
        </div>
      </Field>
      <Field label={value.has_key ? 'APIキー（空のままなら変更しません）' : 'APIキー'}>
        <input
          className="mono"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={value.has_key ? value.key_hint : 'sk-…'}
        />
        {value.has_key && (
          <div className="empty-note" style={{ padding: '6px 0 0', textAlign: 'left' }}>
            消したいときは、半角スペースだけ入れずに空のまま保存しても消えません。
            キーを外すには別の値を入れ直してください
          </div>
        )}
      </Field>
      <Field label="コンテキスト長（0 なら全体設定を使う）">
        <input
          type="number"
          value={ctx}
          min={0}
          onChange={(e) => setCtx(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        />
        <div className="empty-note" style={{ padding: '6px 0 0', textAlign: 'left' }}>
          `/models` を返さないサービスでは、ここを入れないと既定の 32768 で見積もられます
        </div>
      </Field>
    </Modal>
  );
}
