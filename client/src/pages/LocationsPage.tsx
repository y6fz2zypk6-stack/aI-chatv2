import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Location } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

const AREAS = ['hilltop', 'center', 'backstreet', 'harbor', 'outskirts'];

function minToHhmm(min: number | null): string {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function hhmmToMin(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export default function LocationsPage() {
  const { id } = useParams<{ id: string }>();
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<Location | null>(null);
  const [isNew, setIsNew] = useState(false);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api.get<Location[]>(`/worlds/${id}/locations`).then(setLocations).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  const add = () => {
    setIsNew(true);
    setEditing({
      id: '',
      world_id: id!,
      name: '',
      indoor: 0,
      area: 'center',
      open_min: null,
      close_min: null,
      note: '',
      created_at: 0,
      updated_at: 0,
    });
  };

  const remove = async (l: Location) => {
    if (!confirm(`「${l.name}」を削除しますか？`)) return;
    try {
      await api.del(`/locations/${l.id}`);
      load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <main className="page">
      <h1 className="page-title">
        📍 場所
        <span className="spacer" />
        <button className="btn primary small" onClick={add}>
          ＋ 追加
        </button>
      </h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to={`/worlds/${id}`}>← 世界に戻る</Link>
      </div>

      {locations.map((l) => (
        <div key={l.id} className="card">
          <div className="row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">
                {l.name} <span className="chip">{l.id}</span>
                {l.indoor === 1 && <span className="chip"> 屋内</span>}
              </div>
              <div className="card-sub">
                エリア: {l.area || '—'}
                {l.open_min != null &&
                  l.close_min != null &&
                  ` ／ 営業 ${minToHhmm(l.open_min)}–${minToHhmm(l.close_min)}`}
                {l.note && ` ／ ${l.note}`}
              </div>
            </div>
            <button
              className="btn small"
              onClick={() => {
                setIsNew(false);
                setEditing({ ...l });
              }}
            >
              編集
            </button>
            <button className="btn danger small" onClick={() => remove(l)}>
              削除
            </button>
          </div>
        </div>
      ))}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{isNew ? '場所を追加' : '場所を編集'}</h3>
            <div className="grid-2">
              <div className="field">
                <label>ID（英小文字・数字・_ ）</label>
                <input
                  className="input"
                  value={editing.id}
                  disabled={!isNew}
                  onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                  placeholder="vein_bookstore"
                />
              </div>
              <div className="field">
                <label>表示名</label>
                <input
                  className="input"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>エリア</label>
                <select
                  className="select"
                  value={editing.area}
                  onChange={(e) => setEditing({ ...editing, area: e.target.value })}
                >
                  {AREAS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>補足</label>
                <input
                  className="input"
                  value={editing.note}
                  onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                />
              </div>
              <div className="field">
                <label>開店（例 16:00。空欄で終日）</label>
                <input
                  className="input"
                  defaultValue={minToHhmm(editing.open_min)}
                  onBlur={(e) => setEditing({ ...editing, open_min: hhmmToMin(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>閉店（翌日なら 26:00 のように24超）</label>
                <input
                  className="input"
                  defaultValue={minToHhmm(editing.close_min)}
                  onBlur={(e) => setEditing({ ...editing, close_min: hhmmToMin(e.target.value) })}
                />
              </div>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={editing.indoor === 1}
                onChange={(e) => setEditing({ ...editing, indoor: e.target.checked ? 1 : 0 })}
              />
              屋内（天候行を注入しない）
            </label>
            <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setEditing(null)}>
                キャンセル
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  try {
                    if (isNew) {
                      await api.post(`/worlds/${id}/locations`, editing);
                    } else {
                      await api.put(`/locations/${editing.id}`, editing);
                    }
                    setEditing(null);
                    load();
                    toast('保存しました');
                  } catch (err) {
                    toast((err as Error).message, true);
                  }
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
