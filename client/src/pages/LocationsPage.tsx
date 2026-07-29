import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Location } from '@shared/types';
import { api } from '../api';
import { Field, Modal, Row, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

const AREAS = ['hilltop', 'center', 'backstreet', 'harbor', 'outskirts'];

function minToHhmm(min: number | null): string {
  if (min == null) return '';
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
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
      setEditing(null);
      load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const save = async () => {
    if (!editing) return;
    try {
      if (isNew) await api.post(`/worlds/${id}/locations`, editing);
      else await api.put(`/locations/${editing.id}`, editing);
      setEditing(null);
      load();
      toast('保存しました');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <>
      <TopBar title="場所" back={`/worlds/${id}`} />
      <div className="content">
        {locations.map((l) => (
          <Row
            key={l.id}
            avatar={<Icon.pin2 size={18} />}
            avatarTinted
            name={
              <>
                {l.name} {l.indoor === 1 && <span className="tag mute">屋内</span>}
              </>
            }
            desc={
              <>
                {l.id}　{l.area}
                {l.open_min != null &&
                  l.close_min != null &&
                  `　${minToHhmm(l.open_min)}–${minToHhmm(l.close_min)}`}
                {l.note && `　${l.note}`}
              </>
            }
            onClick={() => {
              setIsNew(false);
              setEditing({ ...l });
            }}
            chevron
          />
        ))}
        <div className="chatrow add tappable" onClick={add}>
          <span className="av">
            <Icon.plus size={19} />
          </span>
          <div className="body">
            <span className="nm">場所を追加</span>
          </div>
        </div>
      </div>

      {editing && (
        <Modal
          title={isNew ? '場所を追加' : '場所を編集'}
          onClose={() => setEditing(null)}
          actions={
            <>
              {!isNew && (
                <button className="pill sm danger" onClick={() => void remove(editing)}>
                  削除
                </button>
              )}
              <button className="pill sm primary" onClick={save}>
                保存
              </button>
            </>
          }
        >
          <div className="grid-2">
            <Field label="ID（英小文字・数字・_）">
              <input
                value={editing.id}
                disabled={!isNew}
                onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                placeholder="vein_bookstore"
              />
            </Field>
            <Field label="表示名">
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="エリア">
              <div className="select-wrap">
                <select
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
            </Field>
            <Field label="補足">
              <input
                value={editing.note}
                onChange={(e) => setEditing({ ...editing, note: e.target.value })}
              />
            </Field>
            <Field label="開店（例 16:00。空欄で終日）">
              <input
                defaultValue={minToHhmm(editing.open_min)}
                onBlur={(e) => setEditing({ ...editing, open_min: hhmmToMin(e.target.value) })}
              />
            </Field>
            <Field label="閉店（翌日なら 26:00 のように24超）">
              <input
                defaultValue={minToHhmm(editing.close_min)}
                onBlur={(e) => setEditing({ ...editing, close_min: hhmmToMin(e.target.value) })}
              />
            </Field>
          </div>
          <div className="setting">
            <div className="txt">
              <label>屋内</label>
              <span>天候行を状況ブロックに入れない</span>
            </div>
            <button
              className={`toggle${editing.indoor === 1 ? ' on' : ''}`}
              onClick={() => setEditing({ ...editing, indoor: editing.indoor ? 0 : 1 })}
              role="switch"
              aria-checked={editing.indoor === 1}
            >
              <span className="knob" />
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
