import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
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

  const add = async () => {
    const e = await api.post<WorldEvent>(`/worlds/${id}/events`, { title: '新しいイベント' });
    load();
    startEdit(e);
  };

  const startEdit = (e: WorldEvent) => {
    setEditing({ ...e });
    setConditionJson(JSON.stringify(e.condition, null, 2));
  };

  const save = async () => {
    if (!editing) return;
    try {
      const condition = JSON.parse(conditionJson || '{}');
      await api.put(`/events/${editing.id}`, { ...editing, condition });
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
    load();
  };

  const describeCondition = (c: EventCondition) => {
    const parts: string[] = [];
    if (c.season) parts.push(`季節=${c.season}`);
    if (c.month != null) parts.push(`${c.month}月`);
    if (c.week != null) parts.push(`第${c.week}週`);
    if (c.weekday) parts.push(`${c.weekday}曜`);
    if (c.time_after) parts.push(`${c.time_after}以降`);
    if (c.time_before) parts.push(`${c.time_before}まで`);
    if (c.location) parts.push(`場所=${c.location}`);
    if (c.location_area) parts.push(`エリア=${c.location_area}`);
    if (c.weather) parts.push(`天候=${c.weather}`);
    return parts.join(' / ') || '（条件なし = 毎ターン候補）';
  };

  return (
    <main className="page">
      <h1 className="page-title">
        🎉 pendingイベント
        <span className="spacer" />
        <button className="btn primary small" onClick={add}>
          ＋ 追加
        </button>
      </h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to={`/worlds/${id}`}>← 世界に戻る</Link>
      </div>

      {events.map((e) => (
        <div key={e.id} className="card">
          <div className="row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">
                {e.title}
                <span className="chip" style={{ marginLeft: 6 }}>
                  {TRIGGER_LABEL[e.trigger]}
                  {e.trigger === 'cooldown' && ` ${e.cooldown_days}日`}
                </span>
                {e.enabled === 0 && <span className="chip"> 無効</span>}
              </div>
              <div className="card-sub">
                {describeCondition(e.condition)}
                {e.inject && ` ／ 「${e.inject.slice(0, 40)}」`}
              </div>
            </div>
            <button className="btn small" onClick={() => startEdit(e)}>
              編集
            </button>
            <button className="btn danger small" onClick={() => remove(e)}>
              削除
            </button>
          </div>
        </div>
      ))}
      {events.length === 0 && (
        <div className="empty-note">
          条件を満たしたターンに一文を注入するイベントを設定できます
          （例: 9月第4週の17時以降 →「今夜はヴァニタス・ナハト…」）
        </div>
      )}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(ev) => ev.stopPropagation()}>
            <h3>イベントを編集</h3>
            <div className="field">
              <label>タイトル</label>
              <input
                className="input"
                value={editing.title}
                onChange={(ev) => setEditing({ ...editing, title: ev.target.value })}
              />
            </div>
            <div className="field">
              <label>発火時に注入する一文</label>
              <textarea
                className="textarea"
                value={editing.inject}
                onChange={(ev) => setEditing({ ...editing, inject: ev.target.value })}
                placeholder="今夜はヴァニタス・ナハト。中央大通りは夜通しの市で賑わっている。"
              />
            </div>
            <div className="field">
              <label>
                条件（JSON。使える項目: season / month / week / weekday / time_after /
                time_before / location / location_area / weather）
              </label>
              <textarea
                className="textarea mono"
                rows={6}
                value={conditionJson}
                onChange={(ev) => setConditionJson(ev.target.value)}
                placeholder={'{ "month": 9, "week": 4, "time_after": "17:00" }'}
              />
            </div>
            <div className="grid-2">
              <div className="field">
                <label>トリガー</label>
                <select
                  className="select"
                  value={editing.trigger}
                  onChange={(ev) =>
                    setEditing({ ...editing, trigger: ev.target.value as WorldEvent['trigger'] })
                  }
                >
                  <option value="once">once（チャットごとに一度きり）</option>
                  <option value="once_per_year">once_per_year（ゲーム内年で年1回）</option>
                  <option value="cooldown">cooldown（日数指定）</option>
                </select>
              </div>
              {editing.trigger === 'cooldown' && (
                <div className="field">
                  <label>クールダウン（ゲーム内日数）</label>
                  <input
                    className="input"
                    type="number"
                    value={editing.cooldown_days}
                    onChange={(ev) =>
                      setEditing({
                        ...editing,
                        cooldown_days: parseInt(ev.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
              )}
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={editing.enabled === 1}
                onChange={(ev) => setEditing({ ...editing, enabled: ev.target.checked ? 1 : 0 })}
              />
              有効
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
