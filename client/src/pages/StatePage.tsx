import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  CalendarConfig,
  Character,
  Chat,
  ChatState,
  GameTime,
  Location,
  Message,
  MessageVariant,
} from '@shared/types';
import { api } from '../api';
import { Field, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

interface StateResponse {
  state: ChatState;
  gameTime: GameTime;
  calendar: CalendarConfig;
  lastMessageId: string | null;
}

/** ステート編集パネル（§10.3）。time/location/location_note/weather/present を全て手動編集可能 */
export default function StatePage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<StateResponse | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [gt, setGt] = useState<GameTime | null>(null);
  const [state, setState] = useState<ChatState | null>(null);
  const [deltaLogs, setDeltaLogs] = useState<Record<string, string>>({});
  const toast = useApp((s) => s.toast);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api.get<StateResponse>(`/chats/${id}/state`);
      setData(d);
      setState(d.state);
      setGt(d.gameTime);
      const detail = await api.get<{ chat: Chat; messages: Message[] }>(`/chats/${id}`);
      setMessages(detail.messages);
      const [chars, locs] = await Promise.all([
        api.get<Character[]>(`/worlds/${detail.chat.world_id}/characters`),
        api.get<Location[]>(`/worlds/${detail.chat.world_id}/locations`),
      ]);
      setCharacters(chars);
      setLocations(locs);
    } catch (err) {
      toast((err as Error).message, true);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data || !state || !gt) return <div className="empty-note">読み込み中…</div>;

  const num = (v: string, fb: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fb;
  };

  const togglePresent = (cid: string) => {
    const present = state.present.includes(cid)
      ? state.present.filter((x) => x !== cid)
      : [...state.present, cid];
    setState({ ...state, present });
  };

  const save = async () => {
    try {
      // 年月日・時分をサーバへ渡し、通算分への変換は calendar.ts に任せる
      const r = await api.put<{ state: ChatState; gameTime: GameTime }>(`/chats/${id}/state`, {
        ...state,
        game_time: { year: gt.year, month: gt.month, day: gt.day, hh: gt.hh, mm: gt.mm },
      });
      setState(r.state);
      setGt(r.gameTime);
      toast('ステートを保存しました');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const loadDelta = async (m: Message) => {
    if (deltaLogs[m.id] !== undefined) return;
    try {
      const variants = await api.get<MessageVariant[]>(`/messages/${m.id}/variants`);
      const active = variants.find((v) => v.index === m.active_variant) ?? variants[0];
      setDeltaLogs((prev) => ({ ...prev, [m.id]: active?.state_delta ?? '(なし)' }));
    } catch {
      setDeltaLogs((prev) => ({ ...prev, [m.id]: '(取得失敗)' }));
    }
  };

  const assistants = messages.filter((m) => m.role === 'assistant').slice(-12).reverse();

  return (
    <>
      <TopBar title="ステート編集" sub={`${gt.season} 第${gt.week}週 ${gt.weekday}曜`} back={`/chats/${id}`} />
      <div className="content form">
        <div className="section">
          <span className="kicker">Game Time</span>
          <div className="row wrap">
            {(
              [
                ['年', 'year', 1],
                ['月', 'month', 1],
                ['日', 'day', 1],
                ['時', 'hh', 0],
                ['分', 'mm', 0],
              ] as const
            ).map(([label, key, min]) => (
              <div key={key} className="field" style={{ width: 84 }}>
                <label>{label}</label>
                <input
                  type="number"
                  min={min}
                  value={gt[key]}
                  onChange={(e) => setGt({ ...gt, [key]: num(e.target.value, gt[key]) })}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="section">
          <span className="kicker">Place & Weather</span>
          <Field label="場所">
            <div className="select-wrap">
              <select
                value={state.location}
                onChange={(e) => setState({ ...state, location: e.target.value })}
              >
                <option value="">（未設定）</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="場所メモ（未登録地。空にすると登録場所を優先）">
            <input
              value={state.location_note}
              onChange={(e) => setState({ ...state, location_note: e.target.value })}
              placeholder="路地裏、橋の上 など"
            />
          </Field>
          <Field label="天候">
            <input
              value={state.weather}
              onChange={(e) => setState({ ...state, weather: e.target.value })}
            />
          </Field>
        </div>

        <div className="section">
          <span className="kicker">Present</span>
          <div className="row wrap">
            {characters.map((c) => (
              <span
                key={c.id}
                className={`chip${state.present.includes(c.id) ? ' on' : ''}`}
                onClick={() => togglePresent(c.id)}
              >
                {c.name}
              </span>
            ))}
            {characters.length === 0 && <span className="empty-note">キャラクターがいません</span>}
          </div>
        </div>

        <div className="section">
          <span className="kicker">State Delta ログ</span>
          {assistants.map((m) => (
            <div key={m.id}>
              <div className="chatrow tappable" onClick={() => void loadDelta(m)}>
                <div className="body">
                  <div className="desc one">{m.content.slice(0, 60)}</div>
                </div>
                <span className="chev">
                  <Icon.chevR />
                </span>
              </div>
              {deltaLogs[m.id] !== undefined && (
                <pre className="pre-block">
                  {deltaLogs[m.id]}
                  {'\n\n'}state_after: {JSON.stringify(m.state_after)}
                </pre>
              )}
            </div>
          ))}
          {assistants.length === 0 && <div className="empty-note">まだ応答がありません</div>}
        </div>
      </div>

      <div className="footbar">
        <button className="pill primary grow" onClick={save}>
          <Icon.check />
          保存
        </button>
      </div>
    </>
  );
}
