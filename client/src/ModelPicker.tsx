import { useEffect, useMemo, useState } from 'react';
import { makeModelRef, parseModelRef, type ModelInfo } from '@shared/types';
import { api } from './api';
import { Icon } from './icons';
import { contextK, filterModels, sortModels } from './modelList';
import { describeModelRef, useModelMeta } from './models';

interface ListState {
  models?: ModelInfo[];
  error?: string;
}

/**
 * モデルを選ぶボトムシート（§6.6）。会話のピルと、設定のモデル欄で共通に使う。
 *
 * **候補を決め打ちにしない。** 接続先の `/models` をそのまま全部並べ、検索で絞る。
 * 新しいモデルが出ても、アプリを直さずにその場で選べる。一覧に無いモデル
 * （`/models` を持たない接続先・まだ載っていないもの）は、IDを直接入力して使う
 */
export default function ModelPicker(props: {
  /** 見出し（例: 「この会話のモデル」） */
  title: string;
  /** いまの値。空文字は「既定」 */
  value: string;
  /** 既定の行の見出し（例: 「既定（会話の本文）を使う」） */
  defaultTitle: string;
  /** 既定が実際に指すモデル参照。行の下に「接続先 · ID」で出す */
  defaultRef: string;
  onPick: (ref: string) => void;
  onClose: () => void;
}) {
  const { value, onClose } = props;
  const { connections, resolved } = useModelMeta();
  // 最初はいまの値（無ければ既定）の接続先の一覧を見せる
  const [connId, setConnId] = useState(() => parseModelRef(value || props.defaultRef).connectionId);
  /** 接続先ごとの一覧。一度引いたものは覚えておき、チップを行き来しても引き直さない */
  const [lists, setLists] = useState<Record<string, ListState>>({});
  const [query, setQuery] = useState('');
  const [direct, setDirect] = useState('');

  useEffect(() => {
    if (lists[connId]) return;
    let alive = true;
    api
      .get<ModelInfo[]>(`/models?connection=${encodeURIComponent(connId)}`)
      .then((models) => {
        if (alive) setLists((cur) => ({ ...cur, [connId]: { models: sortModels(models) } }));
      })
      .catch((err) => {
        if (alive) setLists((cur) => ({ ...cur, [connId]: { error: (err as Error).message } }));
      });
    return () => {
      alive = false;
    };
    // lists は「引いたか」を見るためだけに読む。入れると引き終えるたびに走り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const state = lists[connId];
  const shown = useMemo(() => filterModels(state?.models ?? [], query), [state, query]);

  // 一覧に無い指定（直接入力したもの・一覧から消えたモデル）も、いま使っていると分かるように出す
  const current = parseModelRef(value);
  const offList =
    !!value &&
    current.connectionId === connId &&
    !!state?.models &&
    !state.models.some((m) => m.id === current.modelId);

  const pickDirect = () => {
    const id = direct.trim();
    if (!id) return;
    // 「<接続先ID>::<モデルID>」をそのまま貼られたときは、そのまま使う
    props.onPick(id.includes('::') ? id : makeModelRef(connId, id));
  };

  const row = (modelId: string, sub: string) => {
    const ref = makeModelRef(connId, modelId);
    const on = value === ref;
    return (
      <button
        key={modelId}
        className={`mp-row${on ? ' on' : ''}`}
        aria-pressed={on}
        onClick={() => props.onPick(ref)}
      >
        <span className="txt">
          <b>{modelId}</b>
          {sub && <span>{sub}</span>}
        </span>
        {on && (
          <span className="ck">
            <Icon.check size={16} />
          </span>
        )}
      </button>
    );
  };

  const defaultSub = describeModelRef(connections, resolved, props.defaultRef);

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div
        className="sheet model-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="grabber" aria-hidden="true" />
        <div className="sheet-head">
          <h3 id="model-sheet-title">{props.title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            <Icon.x size={16} />
          </button>
        </div>

        <div className="mp-body">
          <button className={`mp-default${!value ? ' on' : ''}`} aria-pressed={!value} onClick={() => props.onPick('')}>
            <span className="txt">
              <b>{props.defaultTitle}</b>
              {defaultSub && <span>{defaultSub}</span>}
            </span>
            {!value && (
              <span className="ck">
                <Icon.check size={18} />
              </span>
            )}
          </button>

          {connections.length > 0 && (
            <div className="mp-conns" role="group" aria-label="接続先">
              {connections.map((c) => (
                <button
                  key={c.id || 'builtin'}
                  className={`mp-conn${c.id === connId ? ' on' : ''}`}
                  aria-pressed={c.id === connId}
                  onClick={() => setConnId(c.id)}
                >
                  {c.id === connId && <Icon.check size={14} />}
                  {c.name}
                </button>
              ))}
            </div>
          )}

          <div className="mp-field">
            <label className="mp-label" htmlFor="mp-direct">
              モデルIDを直接入力
            </label>
            <form
              className="mp-direct"
              onSubmit={(e) => {
                e.preventDefault();
                pickDirect();
              }}
            >
              <input
                id="mp-direct"
                value={direct}
                onChange={(e) => setDirect(e.target.value)}
                placeholder={connId ? '例: モデルの名前' : '例: anthropic/claude-opus-5.5'}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button type="submit" className="pill" disabled={!direct.trim()}>
                使う
              </button>
            </form>
          </div>

          <div className="mp-list">
            {/* 長い一覧を下へ送っても、検索はいつでも打てるよう上に貼りつける */}
            <div className="mp-search">
              <Icon.search size={18} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="一覧から検索"
                aria-label="一覧から検索"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              {query && (
                <button type="button" className="mp-clear" aria-label="検索を消す" onClick={() => setQuery('')}>
                  <Icon.x size={14} />
                </button>
              )}
            </div>
            {offList && row(current.modelId, 'いま使っている指定（一覧に無い）')}
            {!state && <div className="mp-state">一覧を読み込み中…</div>}
            {state?.error && (
              <div className="mp-state">
                一覧を取れませんでした（{state.error}）。上の欄にモデルIDを直接入力してください
              </div>
            )}
            {state?.models && shown.length === 0 && (
              <div className="mp-state">
                {query ? `「${query}」に合うモデルがありません。` : 'この接続先にはモデルがありません。'}
                上の欄にモデルIDを直接入力できます
              </div>
            )}
            {shown.map((m) => {
              const now = resolved[makeModelRef(connId, m.id)];
              return row(
                m.id,
                [m.name !== m.id ? m.name : '', contextK(m.context_length), now ? `いまは ${now.label}` : '']
                  .filter(Boolean)
                  .join(' · '),
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
