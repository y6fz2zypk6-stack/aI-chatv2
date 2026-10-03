import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConnectionView, Settings } from '@shared/types';
import { api } from '../../api';
import { Field, Modal, TopBar } from '../../components';
import type { ModelGroup } from '../../models';
import { ask, useApp } from '../../store';
import { useSettings } from './useSettings';

// 設定のサブページで使い回す部品。ModelSelect と ConnectionEditor は分割前の SettingsPage.tsx から移したもの

/** サブページの枠。戻り先は既定でハブ（`/settings`） */
export function SettingsSubPage({
  title,
  back = '/settings',
  children,
}: {
  title: string;
  back?: string;
  children: ReactNode;
}) {
  return (
    <>
      <TopBar title={title} back={back} />
      <div className="content form settings-page">{children}</div>
    </>
  );
}

/** 小見出しの下や項目の下に置く、短い説明文 */
export function Note({ children }: { children: ReactNode }) {
  return <p className="set-note">{children}</p>;
}

/** 淡い面の囲み（計算結果・使われるモデルなど、読ませたい補足） */
export function Box({ children }: { children: ReactNode }) {
  return <div className="set-box">{children}</div>;
}

/** 折りたたみの補足（「くわしく」「書き方のコツ」） */
export function More({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="set-more">
      <summary>{summary}</summary>
      <div className="set-more-body">{children}</div>
    </details>
  );
}

export const Loading = ({ title }: { title: string }) => (
  <SettingsSubPage title={title}>
    <div className="empty-note">読み込み中…</div>
  </SettingsSubPage>
);

/**
 * 長文1つだけを編集するページ（共通の指示・要約の方針）。
 *
 * **打つたびには保存しない。** 入力欄から離れたときと、画面を離れたとき（戻るボタンを
 * 押さずにブラウザの戻るで離れた場合も含む）に保存する。
 */
export function LongTextPage({
  title,
  back,
  field,
  intro,
  askTitle,
  children,
}: {
  title: string;
  back?: string;
  field: 'system_prompt' | 'summary_policy';
  intro: ReactNode;
  askTitle: string;
  /** 入力欄の下に置く補足（折りたたみなど） */
  children?: ReactNode;
}) {
  const { settings, set, setLocal } = useSettings();
  /** サーバに保存済みの値。画面の値と比べて「保存済み」かを出す */
  const [saved, setSaved] = useState<string | null>(null);
  const latest = useRef<{ text: string; saved: string | null }>({ text: '', saved: null });

  useEffect(() => {
    if (settings && saved === null) setSaved(settings[field]);
  }, [settings, saved, field]);

  const text = settings?.[field] ?? '';
  latest.current = { text, saved };

  const save = async (value: string) => {
    if (value === latest.current.saved) return;
    await set({ [field]: value } as Partial<Settings>);
    setSaved(value);
  };

  // 画面を離れたときに、まだ保存していない分を保存する。
  // - アプリ内の移動: 後片付けで保存する
  // - スマホでアプリを切り替える・ホームへ戻る: visibilitychange（hidden）。ページはまだ生きているので確実に届く
  // - リロード・タブを閉じる: pagehide。keepalive を付けるが、サービスワーカーが効いているページでは
  //   Chrome が閉じる時点で打ち切ることがある（確実なのは上の2つ）
  useEffect(() => {
    const flush = () => {
      const { text: t, saved: sv } = latest.current;
      if (sv === null || t === sv) return;
      latest.current = { text: t, saved: t };
      void fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify({ [field]: t }),
      }).catch(() => {});
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      flush();
    };
  }, [field]);

  if (!settings) return <Loading title={title} />;
  const dirty = saved !== null && text !== saved;

  return (
    <SettingsSubPage title={title} back={back}>
      <Note>{intro}</Note>
      <textarea
        className="tall set-longtext"
        value={text}
        onChange={(e) => setLocal({ [field]: e.target.value } as Partial<Settings>)}
        onBlur={(e) => void save(e.target.value)}
      />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="set-status">{dirty ? '入力欄から離れると保存されます' : '✓ 保存済み'}</span>
        <button
          className="pill sm"
          onClick={async () => {
            if (!(await ask({ title: `${askTitle}を既定に戻しますか？`, body: 'いまの内容は消えます。', okLabel: '既定に戻す' })))
              return;
            const d = await api.get<Settings>('/settings/defaults');
            setLocal({ [field]: d[field] } as Partial<Settings>);
            await save(d[field]);
          }}
        >
          既定に戻す
        </button>
      </div>
      {children}
    </SettingsSubPage>
  );
}

/**
 * モデルの選択肢を接続先ごとに `<optgroup>` で分ける（§6.6）。
 * 値は `<接続先ID>::<モデルID>`。組み込みは区切り無しの素のモデルID。
 */
export function ModelSelect({
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

/**
 * 接続先の追加・編集。
 * **APIキーの欄は常に空で開く。** サーバはキーを返さないし（不変条件43）、
 * 触らなければ変わらない作りにしてある
 */
export function ConnectionEditor({
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
      <Field label="コンテキスト長（0 なら「文脈の予算」の想定コンテキスト長を使う）">
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
