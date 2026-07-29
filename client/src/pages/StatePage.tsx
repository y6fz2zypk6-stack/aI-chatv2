import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
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
  const [chat, setChat] = useState<Chat | null>(null);
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
      setChat(detail.chat);
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

  if (!data || !state || !gt || !chat) return <main className="page">読み込み中…</main>;

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
      // 時刻は年月日・時分をサーバに渡して通算分に変換してもらう（時刻演算はサーバの calendar.ts に一本化）
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
    <main className="page">
      <h1 className="page-title">🧭 ステート編集</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to={`/chats/${id}`}>← チャットに戻る</Link>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          ゲーム内時刻（{gt.season}・第{gt.week}週・{gt.weekday}曜日）
        </div>
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
            <div key={key} className="field" style={{ width: 86, marginBottom: 0 }}>
              <label>{label}</label>
              <input
                className="input"
                type="number"
                min={min}
                value={gt[key]}
                onChange={(e) => setGt({ ...gt, [key]: num(e.target.value, gt[key]) })}
              />
            </div>
          ))}
        </div>

        <hr className="divider" />

        <div className="grid-2">
          <div className="field">
            <label>場所</label>
            <select
              className="select"
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
          <div className="field">
            <label>場所メモ（未登録地。空で登録場所を優先）</label>
            <input
              className="input"
              value={state.location_note}
              onChange={(e) => setState({ ...state, location_note: e.target.value })}
              placeholder="路地裏、橋の上 など"
            />
          </div>
          <div className="field">
            <label>天候</label>
            <input
              className="input"
              value={state.weather}
              onChange={(e) => setState({ ...state, weather: e.target.value })}
            />
          </div>
        </div>

        <div className="field">
          <label>その場にいる人物</label>
          <div className="row wrap">
            {characters.map((c) => (
              <span
                key={c.id}
                className={`chip${state.present.includes(c.id) ? ' on' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => togglePresent(c.id)}
              >
                {c.avatar || '👤'} {c.name}
              </span>
            ))}
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>

      <div className="section-title">各ターンの state_delta（デバッグ）</div>
      {assistants.map((m) => (
        <div key={m.id} className="card">
          <div
            className="card-sub"
            style={{ cursor: 'pointer' }}
            onClick={() => void loadDelta(m)}
          >
            {m.content.slice(0, 60)}…
          </div>
          {deltaLogs[m.id] !== undefined ? (
            <pre className="pre-block" style={{ marginTop: 8 }}>
              {deltaLogs[m.id]}
              {'\n\n'}state_after: {JSON.stringify(m.state_after)}
            </pre>
          ) : (
            <div className="card-sub">タップして差分ログを表示</div>
          )}
        </div>
      ))}
    </main>
  );
}
