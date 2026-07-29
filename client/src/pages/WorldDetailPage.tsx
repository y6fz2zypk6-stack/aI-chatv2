import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Character, Chat, Persona, Scenario, World } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

type WorldWithUsage = World & {
  usage: {
    characters: number;
    scenarios: number;
    chats: number;
    lorebook: number;
    locations: number;
    events: number;
  };
};

export default function WorldDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [world, setWorld] = useState<WorldWithUsage | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [editingScenario, setEditingScenario] = useState<Scenario | null>(null);
  const navigate = useNavigate();
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api.get<WorldWithUsage>(`/worlds/${id}`).then(setWorld).catch(() => {});
    api.get<Character[]>(`/worlds/${id}/characters`).then(setCharacters).catch(() => {});
    api.get<Scenario[]>(`/worlds/${id}/scenarios`).then(setScenarios).catch(() => {});
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  if (!world) return <main className="page">読み込み中…</main>;

  const saveWorld = async () => {
    try {
      await api.put(`/worlds/${world.id}`, world);
      toast('世界を保存しました');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const removeWorld = async () => {
    const u = world.usage;
    const msg =
      `「${world.name}」を削除しますか？以下も全て削除されます:\n` +
      `キャラ${u.characters}件 / シナリオ${u.scenarios}件 / チャット${u.chats}件 / ` +
      `ロア${u.lorebook}件 / 場所${u.locations}件 / イベント${u.events}件`;
    if (!confirm(msg)) return;
    await api.del(`/worlds/${world.id}`);
    navigate('/worlds');
  };

  const addCharacter = async () => {
    const name = prompt('キャラクター名は？');
    if (!name) return;
    const c = await api.post<Character>(`/worlds/${world.id}/characters`, { name });
    navigate(`/characters/${c.id}`);
  };

  const importCharacter = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const card = JSON.parse(await file.text());
        const result = await api.post<{ character: Character; imported_lore: number }>(
          `/worlds/${world.id}/characters/import`,
          card,
        );
        toast(`「${result.character.name}」を取り込みました（ロア${result.imported_lore}件）`);
        load();
      } catch (err) {
        toast((err as Error).message, true);
      }
    };
    input.click();
  };

  const addScenario = async () => {
    const s = await api.post<Scenario>(`/worlds/${world.id}/scenarios`, {
      title: '新しいシナリオ',
    });
    load();
    setEditingScenario(s);
  };

  const startChat = async (s: Scenario) => {
    try {
      const chat = await api.post<Chat>(`/scenarios/${s.id}/chats`);
      navigate(`/chats/${chat.id}`);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const removeScenario = async (s: Scenario) => {
    if (!confirm(`シナリオ「${s.title}」を削除しますか？（既存チャットは残ります）`)) return;
    await api.del(`/scenarios/${s.id}`);
    load();
  };

  const removeCharacter = async (c: Character) => {
    if (!confirm(`「${c.name}」を削除しますか？メモリーも削除されます`)) return;
    try {
      await api.del(`/characters/${c.id}`);
      load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <main className="page">
      <h1 className="page-title">
        🌍 {world.name}
        <span className="spacer" />
        <button className="btn danger small" onClick={removeWorld}>
          世界を削除
        </button>
      </h1>

      <div className="row wrap" style={{ marginBottom: 18 }}>
        <Link className="btn small" to={`/worlds/${world.id}/lorebook`}>
          📖 ロアブック({world.usage.lorebook})
        </Link>
        <Link className="btn small" to={`/worlds/${world.id}/locations`}>
          📍 場所({world.usage.locations})
        </Link>
        <Link className="btn small" to={`/worlds/${world.id}/calendar`}>
          🗓 暦・天候
        </Link>
        <Link className="btn small" to={`/worlds/${world.id}/events`}>
          🎉 イベント({world.usage.events})
        </Link>
        <a className="btn small" href={`/api/worlds/${world.id}/export`} download>
          ⤓ 世界を書き出し
        </a>
      </div>

      <div className="card">
        <div className="field">
          <label>名前</label>
          <input
            className="input"
            value={world.name}
            onChange={(e) => setWorld({ ...world, name: e.target.value })}
          />
        </div>
        <div className="field">
          <label>説明</label>
          <textarea
            className="textarea"
            value={world.description}
            onChange={(e) => setWorld({ ...world, description: e.target.value })}
          />
        </div>
        <div className="field">
          <label>世界のシステムプロンプト（文体・世界観・許可される表現）</label>
          <textarea
            className="textarea"
            rows={5}
            value={world.system_prompt}
            onChange={(e) => setWorld({ ...world, system_prompt: e.target.value })}
          />
        </div>
        <div className="field">
          <label>ナレーターの指示</label>
          <textarea
            className="textarea"
            value={world.narrator_prompt}
            onChange={(e) => setWorld({ ...world, narrator_prompt: e.target.value })}
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={saveWorld}>
            保存
          </button>
        </div>
      </div>

      <div className="section-title">
        👥 キャラクター
        <span className="spacer" />
        <button className="btn small" onClick={importCharacter}>
          V2カード取込
        </button>
        <button className="btn primary small" onClick={addCharacter}>
          ＋ 追加
        </button>
      </div>
      {characters.map((c) => (
        <div key={c.id} className="card clickable" onClick={() => navigate(`/characters/${c.id}`)}>
          <div className="row">
            <span style={{ fontSize: 22 }}>{c.avatar || '👤'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">
                {c.name}
                {c.is_npc_pool === 1 && <span className="chip"> 準レギュラー</span>}
              </div>
              {c.aliases.length > 0 && <div className="card-sub">別名: {c.aliases.join('、')}</div>}
            </div>
            <button
              className="btn danger small"
              onClick={(e) => {
                e.stopPropagation();
                removeCharacter(c);
              }}
            >
              削除
            </button>
          </div>
        </div>
      ))}
      {characters.length === 0 && <div className="empty-note">キャラクターがいません</div>}

      <div className="section-title">
        🎬 シナリオ
        <span className="spacer" />
        <button className="btn primary small" onClick={addScenario}>
          ＋ 追加
        </button>
      </div>
      {scenarios.map((s) => (
        <div key={s.id} className="card">
          <div className="row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">{s.title}</div>
              {s.description && <div className="card-sub">{s.description}</div>}
            </div>
            <button className="btn primary small" onClick={() => startChat(s)}>
              ▶ 開始
            </button>
            <button className="btn small" onClick={() => setEditingScenario({ ...s })}>
              編集
            </button>
            <button className="btn danger small" onClick={() => removeScenario(s)}>
              削除
            </button>
          </div>
        </div>
      ))}
      {scenarios.length === 0 && (
        <div className="empty-note">シナリオを作ると会話を開始できます</div>
      )}

      {editingScenario && (
        <ScenarioEditor
          scenario={editingScenario}
          characters={characters}
          personas={personas}
          worldId={world.id}
          onClose={() => setEditingScenario(null)}
          onSaved={() => {
            setEditingScenario(null);
            load();
          }}
        />
      )}
    </main>
  );
}

function ScenarioEditor(props: {
  scenario: Scenario;
  characters: Character[];
  personas: Persona[];
  worldId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [s, setS] = useState<Scenario>(props.scenario);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const toast = useApp((st) => st.toast);

  useEffect(() => {
    api
      .get<{ id: string; name: string }[]>(`/worlds/${props.worldId}/locations`)
      .then(setLocations)
      .catch(() => {});
  }, [props.worldId]);

  const toggleParticipant = (cid: string) => {
    const ids = s.participant_ids.includes(cid)
      ? s.participant_ids.filter((x) => x !== cid)
      : [...s.participant_ids, cid];
    setS({ ...s, participant_ids: ids });
  };

  const togglePresent = (cid: string) => {
    const cur = s.initial_state.present;
    const present = cur.includes(cid) ? cur.filter((x) => x !== cid) : [...cur, cid];
    setS({ ...s, initial_state: { ...s.initial_state, present } });
  };

  const save = async () => {
    try {
      await api.put(`/scenarios/${s.id}`, s);
      toast('シナリオを保存しました');
      props.onSaved();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>シナリオを編集</h3>
        <div className="field">
          <label>タイトル</label>
          <input
            className="input"
            value={s.title}
            onChange={(e) => setS({ ...s, title: e.target.value })}
          />
        </div>
        <div className="field">
          <label>状況設定（プロンプトに入ります）</label>
          <textarea
            className="textarea"
            value={s.description}
            onChange={(e) => setS({ ...s, description: e.target.value })}
          />
        </div>
        <div className="field">
          <label>参加キャラ</label>
          <div className="row wrap">
            {props.characters.map((c) => (
              <span
                key={c.id}
                className={`chip${s.participant_ids.includes(c.id) ? ' on' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => toggleParticipant(c.id)}
              >
                {c.avatar || '👤'} {c.name}
              </span>
            ))}
            {props.characters.length === 0 && (
              <span className="card-sub">先にキャラクターを作成してください</span>
            )}
          </div>
        </div>
        <div className="field">
          <label>既定ペルソナ</label>
          <select
            className="select"
            value={s.default_persona_id ?? ''}
            onChange={(e) => setS({ ...s, default_persona_id: e.target.value || null })}
          >
            <option value="">（全体設定に従う）</option>
            {props.personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>冒頭の応答文（話者ラベル付き。例「ナレーター: 雨の午後…」）</label>
          <textarea
            className="textarea"
            rows={5}
            value={s.opening}
            onChange={(e) => setS({ ...s, opening: e.target.value })}
          />
        </div>

        <div className="section-title" style={{ marginTop: 10 }}>
          初期ステート
        </div>
        <div className="grid-2">
          <div className="field">
            <label>開始時刻（暦元期からの通算分）</label>
            <input
              className="input"
              type="number"
              value={s.initial_state.time}
              onChange={(e) =>
                setS({
                  ...s,
                  initial_state: {
                    ...s.initial_state,
                    time: parseInt(e.target.value, 10) || 0,
                  },
                })
              }
            />
          </div>
          <div className="field">
            <label>場所</label>
            <select
              className="select"
              value={s.initial_state.location}
              onChange={(e) =>
                setS({ ...s, initial_state: { ...s.initial_state, location: e.target.value } })
              }
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
            <label>天候</label>
            <input
              className="input"
              value={s.initial_state.weather}
              onChange={(e) =>
                setS({ ...s, initial_state: { ...s.initial_state, weather: e.target.value } })
              }
            />
          </div>
        </div>
        <div className="field">
          <label>開始時の在席キャラ</label>
          <div className="row wrap">
            {props.characters.map((c) => (
              <span
                key={c.id}
                className={`chip${s.initial_state.present.includes(c.id) ? ' on' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => togglePresent(c.id)}
              >
                {c.name}
              </span>
            ))}
          </div>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={s.narrator_enabled === 1}
            onChange={(e) => setS({ ...s, narrator_enabled: e.target.checked ? 1 : 0 })}
          />
          ナレーターを有効にする
        </label>

        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={props.onClose}>
            キャンセル
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
