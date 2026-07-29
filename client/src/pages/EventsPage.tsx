import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Field, Modal, Row, Stepper, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

interface EventCondition {
  season?: string;
  month?: number;
  week?: number;
  weekday?: string;
  time_after?: string;
  time_before?: string;
  location?: string;
  location_area?: string;
  weather?: string;
}

interface WorldEvent {
  id: string;
  world_id: string;
  title: string;
  condition: EventCondition;
  trigger: 'once' | 'once_per_year' | 'cooldown';
  cooldown_days: number;
  inject: string;
  enabled: number;
}

const TRIGGER_LABEL: Record<WorldEvent['trigger'], string> = {
  once: '一度きり',
  once_per_year: '年に一度',
  cooldown: 'クールダウン',
};

function describeCondition(c: EventCondition): string {
  const parts: string[] = [];
  if (c.season) parts.push(c.season);
  if (c.month != null) parts.push(`${c.month}月`);
  if (c.week != null) parts.push(`第${c.week}週`);
  if (c.weekday) parts.push(`${c.weekday}曜`);
  if (c.time_after) parts.push(`${c.time_after}以降`);
  if (c.time_before) parts.push(`${c.time_before}まで`);
  if (c.location) parts.push(c.location);
  if (c.location_area) parts.push(c.location_area);
  if (c.weather) parts.push(c.weather);
  return parts.join(' / ') || '条件なし（毎ターン候補）';
}

export default function EventsPage() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [editing, setEditing] = useState<WorldEvent | null>(null);
  const [conditionJson, setConditionJson] = useState('');
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api.get<WorldEvent[]>(`/worlds/${id}/events`).then(setEvents).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  const startEdit = (e: WorldEvent) => {
    setEditing({ ...e });
    setConditionJson(JSON.stringify(e.condition, null, 2));
  };

  const add = async () => {
    const e = await api.post<WorldEvent>(`/worlds/${id}/events`, { title: '新しいイベント' });
    load();
    startEdit(e);
  };

  const save = async () => {
    if (!editing) return;
    try {
      await api.put(`/events/${editing.id}`, {
        ...editing,
        condition: JSON.parse(conditionJson || '{}'),
      });
      setEditing(null);
      load();
      toast('保存しました');
    } catch (err) {
      toast(`保存できません: ${(err as Error).message}`, true);
    }
  };

  const remove = async (e: WorldEvent) => {
    if (!confirm(`「${e.title}」を削除しますか？`)) return;
    await api.del(`/events/${e.id}`);
    setEditing(null);
    load();
  };

  return (
    <>
      <TopBar title="イベント" back={`/worlds/${id}`} />
      <div className="content">
        {events.map((e) => (
          <Row
            key={e.id}
            avatar={<Icon.sparkle size={18} />}
            avatarTinted
            name={
              <>
                {e.title} <span className="tag mute">{TRIGGER_LABEL[e.trigger]}</span>
                {e.enabled === 0 && <span className="tag mute">OFF</span>}
              </>
            }
            desc={
              <>
                {describeCondition(e.condition)}
                {e.inject && ` / 「${e.inject.slice(0, 30)}…」`}
              </>
            }
            onClick={() => startEdit(e)}
            chevron
          />
        ))}
        <div className="chatrow add tappable" onClick={add}>
          <span className="av">
            <Icon.plus size={19} />
          </span>
          <div className="body">
            <span className="nm">イベントを追加</span>
          </div>
        </div>
        {events.length === 0 && (
          <div className="empty-note">
            条件を満たしたターンに一文を注入します
            <br />
            例: 9月第4週の17時以降 →「今夜はヴァニタス・ナハト。」
          </div>
        )}
      </div>

      {editing && (
        <Modal
          title="イベント"
          onClose={() => setEditing(null)}
          actions={
            <>
              <button className="pill sm danger" onClick={() => void remove(editing)}>
                削除
              </button>
              <button className="pill sm primary" onClick={save}>
                保存
              </button>
            </>
          }
        >
          <Field label="タイトル">
            <input
              value={editing.title}
              onChange={(ev) => setEditing({ ...editing, title: ev.target.value })}
            />
          </Field>
          <Field label="発火時に注入する一文">
            <textarea
              value={editing.inject}
              onChange={(ev) => setEditing({ ...editing, inject: ev.target.value })}
              placeholder="今夜はヴァニタス・ナハト。中央大通りは夜通しの市で賑わっている。"
            />
          </Field>
          <Field label="条件（season / month / week / weekday / time_after / time_before / location / location_area / weather）">
            <textarea
              className="mono"
              value={conditionJson}
              onChange={(ev) => setConditionJson(ev.target.value)}
              placeholder={'{ "month": 9, "week": 4, "time_after": "17:00" }'}
            />
          </Field>
          <Field label="トリガー">
            <div className="select-wrap">
              <select
                value={editing.trigger}
                onChange={(ev) =>
                  setEditing({ ...editing, trigger: ev.target.value as WorldEvent['trigger'] })
                }
              >
                <option value="once">一度きり（チャットごと）</option>
                <option value="once_per_year">年に一度（ゲーム内年）</option>
                <option value="cooldown">クールダウン（日数指定）</option>
              </select>
            </div>
          </Field>
          {editing.trigger === 'cooldown' && (
            <div className="setting">
              <div className="txt">
                <label>クールダウン（ゲーム内日数）</label>
              </div>
              <Stepper
                value={editing.cooldown_days}
                min={0}
                onChange={(v) => setEditing({ ...editing, cooldown_days: v })}
              />
            </div>
          )}
          <div className="setting">
            <div className="txt">
              <label>有効</label>
            </div>
            <button
              className={`toggle${editing.enabled === 1 ? ' on' : ''}`}
              onClick={() => setEditing({ ...editing, enabled: editing.enabled ? 0 : 1 })}
              role="switch"
              aria-checked={editing.enabled === 1}
            >
              <span className="knob" />
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
