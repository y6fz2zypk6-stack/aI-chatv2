import { useCallback, useEffect, useState } from 'react';
import type { Persona } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [editing, setEditing] = useState<Persona | null>(null);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => {});
  }, []);

  useEffect(load, [load]);

  const create = async () => {
    const p = await api.post<Persona>('/personas', {
      name: '新しいペルソナ',
      is_default: personas.length === 0 ? 1 : 0,
    });
    load();
    setEditing(p);
  };

  const save = async () => {
    if (!editing) return;
    try {
      await api.put(`/personas/${editing.id}`, editing);
      setEditing(null);
      load();
      toast('保存しました');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const remove = async (p: Persona) => {
    if (!confirm(`「${p.name}」を削除しますか？`)) return;
    await api.del(`/personas/${p.id}`);
    load();
  };

  return (
    <main className="page">
      <h1 className="page-title">
        🙋 ペルソナ
        <span className="spacer" />
        <button className="btn primary small" onClick={create}>
          ＋ 追加
        </button>
      </h1>
      {personas.map((p) => (
        <div key={p.id} className="card">
          <div className="row">
            <span style={{ fontSize: 22 }}>{p.avatar || '🙂'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">
                {p.name} {p.is_default === 1 && <span className="chip on">既定</span>}
              </div>
              {p.description && <div className="card-sub">{p.description}</div>}
            </div>
            <button className="btn small" onClick={() => setEditing({ ...p })}>
              編集
            </button>
            <button className="btn danger small" onClick={() => remove(p)}>
              削除
            </button>
          </div>
        </div>
      ))}
      {personas.length === 0 && (
        <div className="empty-note">ペルソナ（あなたの分身）を作成してください</div>
      )}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>ペルソナを編集</h3>
            <div className="field">
              <label>名前</label>
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>アイコン（絵文字）</label>
              <input
                className="input"
                value={editing.avatar}
                onChange={(e) => setEditing({ ...editing, avatar: e.target.value })}
                placeholder="🙂"
              />
            </div>
            <div className="field">
              <label>説明（プロンプトに入ります）</label>
              <textarea
                className="textarea"
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={editing.is_default === 1}
                onChange={(e) => setEditing({ ...editing, is_default: e.target.checked ? 1 : 0 })}
              />
              既定のペルソナにする
            </label>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setEditing(null)}>
                キャンセル
              </button>
              <button className="btn primary" onClick={save}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
