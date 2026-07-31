import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Character, Chat, Persona, Scenario, World } from '@shared/types';
import { api } from '../api';
import { Avatar, Field, Modal, Row, TopBar, TriToggle } from '../components';
import { Icon } from '../icons';
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
  const [varsSchemaJson, setVarsSchemaJson] = useState('[]');
  const navigate = useNavigate();
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api
      .get<WorldWithUsage>(`/worlds/${id}`)
      .then((w) => {
        setWorld(w);
        setVarsSchemaJson(JSON.stringify(w.vars_schema ?? [], null, 2));
      })
      .catch(() => {});
    api.get<Character[]>(`/worlds/${id}/characters`).then(setCharacters).catch(() => {});
    api.get<Scenario[]>(`/worlds/${id}/scenarios`).then(setScenarios).catch(() => {});
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  if (!world) return <div className="empty-note">読み込み中…</div>;

  const saveWorld = async () => {
    try {
      const vars_schema = JSON.parse(varsSchemaJson || '[]');
      await api.put(`/worlds/${world.id}`, { ...world, vars_schema });
      toast('世界を保存しました');
      load();
    } catch (err) {
      toast(`保存できません: ${(err as Error).message}`, true);
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
    const s = await api.post<Scenario>(`/worlds/${world.id}/scenarios`, { title: '新しいシナリオ' });
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

  return (
    <>
      <TopBar
        title={world.name}
        back="/worlds"
        actions={
          <a className="icon-btn accent" href={`/api/worlds/${world.id}/export`} download title="書き出し">
            <Icon.download />
          </a>
        }
      />
      <div className="content">
        <div className="section">
          <Row
            avatar={<Icon.book size={19} />}
            avatarTinted
            name="ロアブック"
            desc={`${world.usage.lorebook}件`}
            onClick={() => navigate(`/worlds/${world.id}/lorebook`)}
            chevron
          />
          <Row
            avatar={<Icon.pin2 size={19} />}
            avatarTinted
            name="場所"
            desc={`${world.usage.locations}件`}
            onClick={() => navigate(`/worlds/${world.id}/locations`)}
            chevron
          />
          <Row
            avatar={<Icon.calendar size={19} />}
            avatarTinted
            name="暦・天候"
            onClick={() => navigate(`/worlds/${world.id}/calendar`)}
            chevron
          />
          <Row
            avatar={<Icon.sparkle size={19} />}
            avatarTinted
            name="イベント"
            desc={`${world.usage.events}件`}
            onClick={() => navigate(`/worlds/${world.id}/events`)}
            chevron
          />
        </div>

        <div className="section">
          <div className="head">
            <span className="kicker">Characters</span>
            <div className="row">
              <button className="pill sm" onClick={importCharacter}>
                <Icon.upload size={14} />
                V2取込
              </button>
            </div>
          </div>
          {characters.map((c) => (
            <Row
              key={c.id}
              avatar={<Avatar value={c.avatar} name={c.name} />}
              avatarTinted={!c.avatar}
              name={
                <>
                  {c.name} {c.is_npc_pool === 1 && <span className="tag mute">準レギュラー</span>}
                </>
              }
              desc={c.aliases.length ? `別名: ${c.aliases.join('、')}` : c.persona}
              onClick={() => navigate(`/characters/${c.id}`)}
              chevron
            />
          ))}
          <div className="chatrow add tappable" onClick={addCharacter}>
            <span className="av">
              <Icon.castAdd size={19} />
            </span>
            <div className="body">
              <span className="nm">キャラクターを追加</span>
            </div>
          </div>
        </div>

        <div className="section">
          <div className="head">
            <span className="kicker">Scenarios</span>
          </div>
          {scenarios.map((s) => (
            <Row
              key={s.id}
              avatar={<Icon.bubble size={19} />}
              avatarTinted
              name={s.title}
              desc={s.description}
              actions={
                <>
                  <button
                    className="icon-btn accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      void startChat(s);
                    }}
                    title="この設定で開始"
                  >
                    <Icon.play size={17} />
                  </button>
                  <button
                    className="icon-btn"
                    style={{ color: 'var(--danger)' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeScenario(s);
                    }}
                    title="削除"
                  >
                    <Icon.trash />
                  </button>
                </>
              }
              onClick={() => setEditingScenario({ ...s })}
            />
          ))}
          <div className="chatrow add tappable" onClick={addScenario}>
            <span className="av">
              <Icon.plus size={19} />
            </span>
            <div className="body">
              <span className="nm">シナリオを追加</span>
            </div>
          </div>
        </div>

        <div className="section">
          <div className="head">
            <span className="kicker">World</span>
          </div>
          <Field label="名前">
            <input value={world.name} onChange={(e) => setWorld({ ...world, name: e.target.value })} />
          </Field>
          <Field label="説明">
            <textarea
              value={world.description}
              onChange={(e) => setWorld({ ...world, description: e.target.value })}
            />
          </Field>
          <Field label="世界のシステムプロンプト（文体・世界観・許可される表現）">
            <textarea
              className="tall"
              value={world.system_prompt}
              onChange={(e) => setWorld({ ...world, system_prompt: e.target.value })}
            />
          </Field>
          <Field label="ナレーターの指示">
            <textarea
              value={world.narrator_prompt}
              onChange={(e) => setWorld({ ...world, narrator_prompt: e.target.value })}
            />
          </Field>
          <Field label="進行フラグの定義（JSON配列。物語の段階や到達済みフラグを宣言する）">
            <textarea
              className="mono tall"
              value={varsSchemaJson}
              onChange={(e) => setVarsSchemaJson(e.target.value)}
              placeholder={`[
  {
    "key": "case_phase", "type": "number", "role": "phase",
    "default": 0, "label": "事件の進行段階",
    "min": 0, "max": 4, "monotonic": true, "update_mode": "system_only",
    "phases": [
      { "value": 0, "name": "未発生", "public_state": "まだ表面化していない。",
        "private_note": "ここはプロンプトに載りません" }
    ]
  }
]`}
            />
          </Field>
        </div>
      </div>

      <div className="footbar">
        <button className="pill danger" onClick={removeWorld}>
          <Icon.trash />
          削除
        </button>
        <button className="pill primary grow" onClick={saveWorld}>
          <Icon.check />
          保存
        </button>
      </div>

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
    </>
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
    <Modal
      title="シナリオ"
      onClose={props.onClose}
      actions={
        <button className="pill sm primary" onClick={save}>
          保存
        </button>
      }
    >
      <Field label="タイトル">
        <input value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} />
      </Field>
      <Field label="状況設定（プロンプトに入ります）">
        <textarea
          value={s.description}
          onChange={(e) => setS({ ...s, description: e.target.value })}
        />
      </Field>
      <Field label="参加キャラ">
        <div className="row wrap">
          {props.characters.map((c) => (
            <span
              key={c.id}
              className={`chip${s.participant_ids.includes(c.id) ? ' on' : ''}`}
              onClick={() => toggleParticipant(c.id)}
            >
              {c.name}
            </span>
          ))}
          {props.characters.length === 0 && (
            <span className="empty-note">先にキャラクターを作成してください</span>
          )}
        </div>
      </Field>
      <Field label="既定ペルソナ">
        <div className="select-wrap">
          <select
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
      </Field>
      <Field label="冒頭の応答文（話者ラベル付き）">
        <textarea
          className="tall"
          value={s.opening}
          onChange={(e) => setS({ ...s, opening: e.target.value })}
          placeholder="ナレーター: 午後の雨が窓を叩いている。"
        />
      </Field>

      <div className="kicker">初期ステート</div>
      <div className="grid-2">
        <Field label="開始時刻（暦元期からの通算分）">
          <input
            type="number"
            value={s.initial_state.time}
            onChange={(e) =>
              setS({
                ...s,
                initial_state: { ...s.initial_state, time: parseInt(e.target.value, 10) || 0 },
              })
            }
          />
        </Field>
        <Field label="場所">
          <div className="select-wrap">
            <select
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
        </Field>
        <Field label="天候">
          <input
            value={s.initial_state.weather}
            onChange={(e) =>
              setS({ ...s, initial_state: { ...s.initial_state, weather: e.target.value } })
            }
          />
        </Field>
      </div>
      <Field label="開始時の在席キャラ">
        <div className="row wrap">
          {props.characters.map((c) => (
            <span
              key={c.id}
              className={`chip${s.initial_state.present.includes(c.id) ? ' on' : ''}`}
              onClick={() => togglePresent(c.id)}
            >
              {c.name}
            </span>
          ))}
        </div>
      </Field>
      <div className="setting">
        <div className="txt">
          <label>ナレーター</label>
          <span>情景描写を地の文として入れる</span>
        </div>
        <button
          className={`toggle${s.narrator_enabled === 1 ? ' on' : ''}`}
          onClick={() => setS({ ...s, narrator_enabled: s.narrator_enabled ? 0 : 1 })}
          role="switch"
          aria-checked={s.narrator_enabled === 1}
        >
          <span className="knob" />
        </button>
      </div>
      <Field label="条件付きイベント">
        <TriToggle
          value={s.events_enabled}
          onChange={(v) => setS({ ...s, events_enabled: v })}
          inheritedLabel="全体設定"
        />
      </Field>
      <Field label="進行フラグ">
        <TriToggle
          value={s.vars_enabled}
          onChange={(v) => setS({ ...s, vars_enabled: v })}
          inheritedLabel="全体設定"
        />
      </Field>
    </Modal>
  );
}
