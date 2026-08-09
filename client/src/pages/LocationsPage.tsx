import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AREA_ID_RE,
  formatHhmm,
  parseHhmm,
  type Location,
  type World,
  type WorldArea,
} from '@shared/types';
import { api } from '../api';
import { Field, Modal, Row, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

/**
 * 開店・閉店の入力欄。
 * 非制御（defaultValue + onBlur）にすると、blur が起きないまま保存された場合に
 * 入力が反映されない。制御にして、打った内容がそのまま状態へ入るようにする。
 * 解釈できない表記は黙って捨てず、その場で知らせる。
 */
function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const [text, setText] = useState(formatHhmm(value));
  useEffect(() => setText(formatHhmm(value)), [value]);
  const parsed = parseHhmm(text);
  const invalid = text.trim() !== '' && parsed === null;
  return (
    <Field label={label}>
      <input
        value={text}
        inputMode="numeric"
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseHhmm(e.target.value));
        }}
        placeholder="16:00"
      />
      <span className={`time-hint${invalid ? ' bad' : ''}`}>
        {invalid
          ? '時刻として読み取れません（例: 16:00）'
          : parsed === null
            ? '空欄なら終日'
            : `${formatHhmm(parsed)} として保存します`}
      </span>
    </Field>
  );
}

export default function LocationsPage() {
  const { id } = useParams<{ id: string }>();
  const [locations, setLocations] = useState<Location[]>([]);
  const [areas, setAreas] = useState<WorldArea[]>([]);
  const [editing, setEditing] = useState<Location | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [editingAreas, setEditingAreas] = useState(false);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api.get<Location[]>(`/worlds/${id}/locations`).then(setLocations).catch(() => {});
    api.get<World>(`/worlds/${id}`).then((w) => setAreas(w.areas)).catch(() => {});
  }, [id]);

  /** 表示はエリア名で行う。見つからないIDはそのまま出して気づけるようにする */
  const areaName = (areaId: string) => areas.find((a) => a.id === areaId)?.name || areaId;

  useEffect(load, [load]);

  const add = () => {
    setIsNew(true);
    setEditing({
      id: '',
      world_id: id!,
      name: '',
      indoor: 0,
      area: areas[0]?.id ?? '',
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
      <TopBar
        title="場所"
        back={`/worlds/${id}`}
        actions={
          <button className="icon-btn" onClick={() => setEditingAreas(true)} title="エリアを編集">
            <Icon.pencil size={17} />
          </button>
        }
      />
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
                {l.id}　{areaName(l.area)}
                {l.open_min != null &&
                  l.close_min != null &&
                  `　${formatHhmm(l.open_min)}–${formatHhmm(l.close_min)}`}
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
                  <option value="">（未設定）</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
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
            <TimeField
              label="開店"
              value={editing.open_min}
              onChange={(v) => setEditing({ ...editing, open_min: v })}
            />
            <TimeField
              label="閉店（翌日なら 26:00 のように24超）"
              value={editing.close_min}
              onChange={(v) => setEditing({ ...editing, close_min: v })}
            />
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

      {editingAreas && (
        <AreaEditor
          worldId={id!}
          areas={areas}
          usedIds={new Set(locations.map((l) => l.area).filter(Boolean))}
          onClose={() => setEditingAreas(false)}
          onSaved={() => {
            setEditingAreas(false);
            load();
          }}
        />
      )}
    </>
  );
}

/**
 * エリアの編集。
 * IDは場所とイベント条件から参照されるため、作成後は変えられない（変えると参照が壊れる）。
 * 変更できるのは表示名と並び順で、未使用のエリアだけ削除できる。
 */
function AreaEditor(props: {
  worldId: string;
  areas: WorldArea[];
  usedIds: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [areas, setAreas] = useState<WorldArea[]>(props.areas.map((a) => ({ ...a })));
  const [newId, setNewId] = useState('');
  const toast = useApp((s) => s.toast);

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= areas.length) return;
    const next = [...areas];
    [next[i], next[j]] = [next[j], next[i]];
    setAreas(next);
  };

  const add = () => {
    const id = newId.trim().toLowerCase();
    if (!AREA_ID_RE.test(id)) {
      toast('IDは英小文字で始まる英数字と _ で入力してください', true);
      return;
    }
    if (areas.some((a) => a.id === id)) {
      toast('そのIDは既にあります', true);
      return;
    }
    setAreas([...areas, { id, name: id }]);
    setNewId('');
  };

  const save = async () => {
    try {
      await api.put(`/worlds/${props.worldId}/areas`, { areas });
      toast('保存しました');
      props.onSaved();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <Modal
      title="エリア"
      onClose={props.onClose}
      actions={
        <button className="pill sm primary" onClick={save}>
          保存
        </button>
      }
    >
      <div className="empty-note" style={{ textAlign: 'left', margin: '-4px 0 0', padding: 0 }}>
        表示名と並び順は自由に変えられます。IDは場所とイベントの条件から参照されているため、
        作成後は変更できません。
      </div>
      {areas.map((a, i) => (
        <div key={a.id} className="area-row">
          <input
            value={a.name}
            onChange={(e) =>
              setAreas(areas.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
            }
            placeholder={a.id}
          />
          <code>{a.id}</code>
          <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="上へ">
            <Icon.chevU size={15} />
          </button>
          <button
            className="icon-btn"
            onClick={() => move(i, 1)}
            disabled={i === areas.length - 1}
            aria-label="下へ"
          >
            <Icon.chevD size={15} />
          </button>
          <button
            className="icon-btn"
            style={{ color: 'var(--danger)' }}
            disabled={props.usedIds.has(a.id)}
            title={props.usedIds.has(a.id) ? '使用中のため削除できません' : '削除'}
            onClick={() => setAreas(areas.filter((_, j) => j !== i))}
            aria-label="削除"
          >
            <Icon.trash size={15} />
          </button>
        </div>
      ))}
      <Field label="エリアを追加（IDは後から変えられません）">
        <div className="row" style={{ gap: 8 }}>
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="temple"
          />
          <button className="pill sm" onClick={add} disabled={!newId.trim()}>
            追加
          </button>
        </div>
      </Field>
    </Modal>
  );
}
