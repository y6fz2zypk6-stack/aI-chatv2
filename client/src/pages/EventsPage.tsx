import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  Chat,
  EventCheck,
  EventEvalRow,
  EventKind,
  EventTrigger,
  InjectMode,
  World,
  WorldArea,
  WorldEvent,
} from '@shared/types';
import { api } from '../api';
import { Field, Modal, Row, Stepper, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

const KIND_LABEL: Record<EventKind, string> = {
  ambient: '雰囲気',
  story: '物語',
  critical: '必須',
};

const CHECK_LABEL: Record<EventCheck, string> = {
  every_turn: '毎ターン',
  on_enter: '条件を満たした瞬間',
  on_day_change: '日付が変わったとき',
  on_location_change: '場所が変わったとき',
};

const TRIGGER_LABEL: Record<EventTrigger, string> = {
  once: '一度きり',
  once_per_day: '1日1回',
  once_per_visit: '1回の滞在で1回',
  once_per_phase: 'フェーズごとに1回',
  once_per_year: '年に1回',
  cooldown: 'クールダウン',
  repeat: '制限なし',
};

const OUTCOME_LABEL: Record<EventEvalRow['outcome'], string> = {
  adopted: '採用',
  condition: '条件不一致',
  check: '判定タイミング外',
  trigger: '発火済み・待機中',
  chance: '抽選外れ',
  capped: '上限超過',
};

interface PhaseCheck {
  missing: { key: string; label: string; missing: { value: number; name: string }[] }[];
}

function describeWhen(e: WorldEvent): string {
  if (!e.when) return '条件なし';
  const parts: string[] = [];
  const walk = (c: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(c)) {
      if (k === 'all' || k === 'any') {
        for (const sub of v as Record<string, unknown>[]) walk(sub);
      } else if (k === 'not') {
        parts.push('（除外条件あり）');
      } else if (k === 'var') {
        parts.push(`${String(v)}`);
      } else if (['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'].includes(k)) {
        parts.push(`${k} ${JSON.stringify(v)}`);
      } else {
        parts.push(`${k}=${Array.isArray(v) ? v.join('/') : String(v)}`);
      }
    }
  };
  walk(e.when as unknown as Record<string, unknown>);
  return parts.join(' ') || '条件なし';
}

export default function EventsPage() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [editing, setEditing] = useState<WorldEvent | null>(null);
  const [phaseCheck, setPhaseCheck] = useState<PhaseCheck | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evalRows, setEvalRows] = useState<EventEvalRow[] | null>(null);
  const [areas, setAreas] = useState<WorldArea[]>([]);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api.get<WorldEvent[]>(`/worlds/${id}/events`).then(setEvents).catch(() => {});
    api.get<PhaseCheck>(`/worlds/${id}/events/phase-check`).then(setPhaseCheck).catch(() => {});
    api.get<World>(`/worlds/${id}`).then((w) => setAreas(w.areas)).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  const add = async () => {
    const e = await api.post<WorldEvent>(`/worlds/${id}/events`, { title: '新しいイベント' });
    load();
    setEditing(e);
  };

  const remove = async (e: WorldEvent) => {
    if (!confirm(`「${e.title}」を削除しますか？`)) return;
    await api.del(`/events/${e.id}`);
    setEditing(null);
    load();
  };

  // 現在のチャットで条件式を評価する（§9.1）。これが無いと条件のデバッグができない
  const evaluate = async () => {
    setEvaluating(true);
    try {
      const chats = await api.get<Chat[]>(`/chats?world_id=${id}&archived=0`);
      if (!chats.length) {
        toast('この世界にチャットがありません', true);
        return;
      }
      const r = await api.post<{ rows: EventEvalRow[] }>(`/worlds/${id}/events/evaluate`, {
        chat_id: chats[0].id,
      });
      setEvalRows(r.rows);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <>
      <TopBar
        title="イベント"
        back={`/worlds/${id}`}
        actions={
          <button className="icon-btn accent" onClick={evaluate} disabled={evaluating} title="最新のチャットで評価">
            <Icon.compass />
          </button>
        }
      />
      <div className="content">
        {phaseCheck?.missing.map((m) => (
          <div key={m.key} className="note-warn" style={{ marginBottom: 10 }}>
            <b>{m.label}</b> の遷移イベントがありません:{' '}
            {m.missing.map((x) => `${x.value}「${x.name}」`).join(' / ')}
            <div style={{ marginTop: 4 }}>
              システム専用のフェーズ変数はモデルが進められません。この値へ進める
              <strong>必須イベント</strong>（set_vars で set）を用意してください。
            </div>
          </div>
        ))}

        {events.map((e) => (
          <Row
            key={e.id}
            name={
              <>
                {e.title} <span className="tag mute">{KIND_LABEL[e.kind]}</span>
                {e.chance < 1 && <span className="tag">{Math.round(e.chance * 100)}%</span>}
                {e.inject_mode === 'instruction' && <span className="tag mute">演出指示</span>}
                {e.enabled === 0 && <span className="tag mute">OFF</span>}
              </>
            }
            desc={
              <>
                {describeWhen(e)}
                <br />
                {CHECK_LABEL[e.check]}・{TRIGGER_LABEL[e.trigger]}
                {e.trigger === 'cooldown' && `（${e.cooldown_days}日）`}・優先度{e.priority}
                {e.inject && ` ／ 「${e.inject.slice(0, 26)}…」`}
              </>
            }
            onClick={() => setEditing({ ...e })}
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
            例: 晴れた夜に3割で夜市、雨の港で手掛かりとの接触
          </div>
        )}
      </div>

      {evalRows && (
        <Modal title="最新のチャットで評価" onClose={() => setEvalRows(null)}>
          {evalRows.length === 0 && <div className="empty-note">有効なイベントがありません</div>}
          {evalRows.map((r) => (
            <Row
              key={r.id}
              name={
                <>
                  {r.title}{' '}
                  <span className={`tag${r.outcome === 'adopted' ? ' on' : ' mute'}`}>
                    {OUTCOME_LABEL[r.outcome]}
                  </span>
                </>
              }
              desc={r.detail}
            />
          ))}
        </Modal>
      )}

      {editing && (
        <EventEditor
          event={editing}
          areas={areas}
          onClose={() => setEditing(null)}
          onRemove={() => void remove(editing)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function EventEditor(props: {
  event: WorldEvent;
  areas: WorldArea[];
  onClose: () => void;
  onRemove: () => void;
  onSaved: () => void;
}) {
  const [e, setE] = useState(props.event);
  const [whenJson, setWhenJson] = useState(JSON.stringify(props.event.when ?? {}, null, 2));
  const [varsJson, setVarsJson] = useState(JSON.stringify(props.event.set_vars ?? [], null, 2));
  const toast = useApp((s) => s.toast);

  const save = async () => {
    try {
      const when = JSON.parse(whenJson || '{}');
      const set_vars = JSON.parse(varsJson || '[]');
      // 条件式はサーバで検証される。誤りは400、書けるが効かない書き方は warnings で返る
      const saved = await api.put<WorldEvent & { warnings?: string[] }>(`/events/${e.id}`, {
        ...e,
        when,
        set_vars,
      });
      if (saved.warnings?.length) toast(saved.warnings.join('\n'), true);
      else toast('保存しました');
      props.onSaved();
    } catch (err) {
      toast(`保存できません: ${(err as Error).message}`, true);
    }
  };

  return (
    <Modal
      title="イベント"
      onClose={props.onClose}
      actions={
        <>
          <button className="pill sm danger" onClick={props.onRemove}>
            削除
          </button>
          <button className="pill sm primary" onClick={save}>
            保存
          </button>
        </>
      }
    >
      <Field label="タイトル（管理用）">
        <input value={e.title} onChange={(ev) => setE({ ...e, title: ev.target.value })} />
      </Field>

      <div className="grid-2">
        <Field label="種別">
          <div className="select-wrap">
            <select value={e.kind} onChange={(ev) => setE({ ...e, kind: ev.target.value as EventKind })}>
              <option value="ambient">雰囲気（世界の揺らぎ。確率を使ってよい）</option>
              <option value="story">物語（手掛かり・接触）</option>
              <option value="critical">必須（フェーズ遷移・決着）</option>
            </select>
          </div>
        </Field>
        <Field label="注入モード">
          <div className="select-wrap">
            <select
              value={e.inject_mode}
              onChange={(ev) => setE({ ...e, inject_mode: ev.target.value as InjectMode })}
            >
              <option value="fact">事実（発生中の出来事として置く）</option>
              <option value="instruction">演出指示（出し方をモデルへ指示）</option>
            </select>
          </div>
        </Field>
      </div>

      <Field label="注入する一文">
        <textarea
          value={e.inject}
          onChange={(ev) => setE({ ...e, inject: ev.target.value })}
          placeholder="中央広場に夜市が出ている。屋台の灯りが遠くに見える。"
        />
      </Field>

      <Field label="条件（JSON。season / month / week / weekday / time_after / time_before / location / location_area / weather / present_has / present_lacks / var）">
        <textarea
          className="mono"
          value={whenJson}
          onChange={(ev) => setWhenJson(ev.target.value)}
          placeholder={'{ "all": [ { "weather": ["晴"] }, { "time_after": "19:00" } ] }'}
        />
      </Field>
      {props.areas.length > 0 && (
        <div className="empty-note" style={{ textAlign: 'left', margin: '-4px 0 0' }}>
          location_area に使えるID:{' '}
          {props.areas.map((a) => `${a.id}（${a.name}）`).join(' / ')}
        </div>
      )}

      <div className="grid-2">
        <Field label="判定タイミング">
          <div className="select-wrap">
            <select value={e.check} onChange={(ev) => setE({ ...e, check: ev.target.value as EventCheck })}>
              <option value="every_turn">毎ターン</option>
              <option value="on_enter">条件を満たした瞬間だけ（推奨）</option>
              <option value="on_day_change">日付が変わったとき</option>
              <option value="on_location_change">場所が変わったとき</option>
            </select>
          </div>
        </Field>
        <Field label="再発制御">
          <div className="select-wrap">
            <select
              value={e.trigger}
              onChange={(ev) => setE({ ...e, trigger: ev.target.value as EventTrigger })}
            >
              <option value="once">一度きり</option>
              <option value="once_per_day">1日1回</option>
              <option value="once_per_visit">1回の滞在で1回</option>
              <option value="once_per_phase">フェーズごとに1回</option>
              <option value="once_per_year">年に1回</option>
              <option value="cooldown">クールダウン（日数）</option>
              <option value="repeat">制限なし</option>
            </select>
          </div>
        </Field>
      </div>

      {e.trigger === 'once_per_phase' && (
        <Field label="参照するフェーズ変数のキー">
          <input
            value={e.trigger_var}
            onChange={(ev) => setE({ ...e, trigger_var: ev.target.value })}
            placeholder="case_ash_phase"
          />
        </Field>
      )}
      {e.trigger === 'cooldown' && (
        <div className="setting">
          <div className="txt">
            <label>クールダウン（ゲーム内日数）</label>
          </div>
          <Stepper value={e.cooldown_days} min={0} onChange={(v) => setE({ ...e, cooldown_days: v })} />
        </div>
      )}

      <div className="setting">
        <div className="txt">
          <label>発生確率</label>
          <span>
            {Math.round(e.chance * 100)}%。
            {e.chance < 1 && e.check === 'every_turn'
              ? '毎ターン判定と確率の組み合わせは、条件が続く限り必ず発生します。判定タイミングを変えてください'
              : '物語に必須のイベントは100%にしてください'}
          </span>
        </div>
        <Stepper
          value={Math.round(e.chance * 100)}
          step={10}
          min={0}
          max={100}
          onChange={(v) => setE({ ...e, chance: v / 100 })}
        />
      </div>

      <div className="setting">
        <div className="txt">
          <label>優先度</label>
          <span>同時に条件を満たしたとき、大きい方から採用する</span>
        </div>
        <Stepper value={e.priority} step={10} min={-100} onChange={(v) => setE({ ...e, priority: v })} />
      </div>

      <Field label="発火時に進める進行フラグ（JSON配列。op は set / add）">
        <textarea
          className="mono"
          value={varsJson}
          onChange={(ev) => setVarsJson(ev.target.value)}
          placeholder={'[ { "key": "case_ash_phase", "op": "set", "value": 2 } ]'}
        />
      </Field>

      <div className="setting">
        <div className="txt">
          <label>有効</label>
        </div>
        <button
          className={`toggle${e.enabled === 1 ? ' on' : ''}`}
          onClick={() => setE({ ...e, enabled: e.enabled ? 0 : 1 })}
          role="switch"
          aria-checked={e.enabled === 1}
        >
          <span className="knob" />
        </button>
      </div>
    </Modal>
  );
}
