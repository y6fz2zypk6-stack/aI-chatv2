import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Character, MemoryListItem } from '@shared/types';
import { api } from '../api';
import { Field, Modal, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

export default function MemoriesPage() {
  const { id } = useParams<{ id: string }>();
  const [character, setCharacter] = useState<Character | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [memories, setMemories] = useState<MemoryListItem[]>([]);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<MemoryListItem | null>(null);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api
      .get<Character>(`/characters/${id}`)
      .then((c) => {
        setCharacter(c);
        // 対象タグをIDではなく名前で出すために、同じ世界のキャラを引く
        api
          .get<Character[]>(`/worlds/${c.world_id}/characters`)
          .then(setCharacters)
          .catch(() => {});
      })
      .catch(() => {});
    api.get<MemoryListItem[]>(`/characters/${id}/memories`).then(setMemories).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  const nameOf = useCallback(
    (cid: string) => characters.find((c) => c.id === cid)?.name ?? cid,
    [characters],
  );

  // ピン留めは必ず注入されるので先頭にまとめる。注入しないものは末尾へ
  const [pinned, rest, off] = useMemo(() => {
    const on = memories.filter((m) => m.enabled !== 0);
    return [
      on.filter((m) => m.pinned === 1),
      on.filter((m) => m.pinned !== 1),
      memories.filter((m) => m.enabled === 0),
    ];
  }, [memories]);

  const add = async () => {
    const content = draft.trim();
    if (!content) return;
    await api.post(`/characters/${id}/memories`, { content });
    setDraft('');
    load();
  };

  const setPinned = async (m: MemoryListItem, pinned: number) => {
    await api.put(`/memories/${m.id}`, { ...m, pinned });
    load();
  };

  const row = (m: MemoryListItem) => (
    <div
      key={m.id}
      className={`memrow${m.enabled === 0 ? ' off' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => setEditing({ ...m })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing({ ...m });
        }
      }}
    >
      <button
        className={`icon-btn${m.pinned ? ' accent' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          void setPinned(m, m.pinned ? 0 : 1);
        }}
        aria-pressed={m.pinned === 1}
        title={m.pinned ? 'ピン留めを外す' : 'ピン留め'}
      >
        <Icon.pin />
      </button>
      <div className="body">
        <p className="txt">{m.content}</p>
        <div className="meta">
          <span className={`tag${m.source === 'auto' ? '' : ' mute'}`}>
            {m.source === 'auto' ? '自動抽出' : '手動'}
          </span>
          {m.enabled === 0 && <span className="tag mute">OFF</span>}
          {m.subject && <span>{nameOf(m.subject)}</span>}
          {/* いつの出来事か。注入時は「3年8月7日 / 3日前」の形になる */}
          {m.game_time_label && <span>{m.game_time_label}</span>}
        </div>
      </div>
      <span className="chev">
        <Icon.chevR size={14} />
      </span>
    </div>
  );

  return (
    <>
      <TopBar
        title="メモリー"
        sub={
          character
            ? `${character.name}・${memories.length}件${off.length ? `（うちOFF ${off.length}）` : ''}`
            : undefined
        }
        back={`/characters/${id}`}
      />
      <div className="content">
        {memories.length === 0 && (
          <div className="empty-note">
            会話をまたいで覚えておく事実を登録できます
            <br />
            設定の「自動抽出」をONにすると会話から拾われます
          </div>
        )}
        {pinned.length > 0 && (
          <>
            <span className="kicker">ピン留め</span>
            {pinned.map(row)}
          </>
        )}
        {rest.length > 0 && (
          <>
            {pinned.length > 0 && <span className="kicker">そのほか</span>}
            {rest.map(row)}
          </>
        )}
        {off.length > 0 && (
          <>
            <span className="kicker">注入しない</span>
            {off.map(row)}
          </>
        )}
      </div>
      <div className="footbar">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="記憶する事実を追加…"
        />
        <button className="send" onClick={add} disabled={!draft.trim()} aria-label="追加">
          <Icon.plus size={20} />
        </button>
      </div>

      {editing && (
        <MemoryEditor
          memory={editing}
          characters={characters}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
          toast={toast}
        />
      )}
    </>
  );
}

type DateParts = { year: number | null; month: number | null; day: number | null };
const EMPTY_DATE: DateParts = { year: null, month: null, day: null };

function MemoryEditor(props: {
  memory: MemoryListItem;
  characters: Character[];
  onClose: () => void;
  onDone: () => void;
  toast: (msg: string, error?: boolean) => void;
}) {
  const [m, setM] = useState(props.memory);
  const [date, setDate] = useState<DateParts>(props.memory.game_time_parts ?? EMPTY_DATE);
  const hasDate = date.year !== null || date.month !== null || date.day !== null;
  const dateComplete = date.year !== null && date.month !== null && date.day !== null;

  const save = async () => {
    if (!m.content.trim()) {
      props.toast('内容が空です', true);
      return;
    }
    if (hasDate && !dateComplete) {
      props.toast('日付は年・月・日をすべて入れてください（消すなら3つとも空に）', true);
      return;
    }
    try {
      // 年月日はサーバで通算分へ直してもらう。空なら日付なしに戻す
      await api.put(`/memories/${m.id}`, { ...m, game_time_parts: dateComplete ? date : null });
      props.onDone();
    } catch (err) {
      props.toast((err as Error).message, true);
    }
  };

  const remove = async () => {
    if (!confirm('このメモリーを削除しますか？')) return;
    try {
      await api.del(`/memories/${m.id}`);
      props.toast('削除しました');
      props.onDone();
    } catch (err) {
      props.toast((err as Error).message, true);
    }
  };

  return (
    <Modal
      title="メモリーを編集"
      onClose={props.onClose}
      actions={
        <>
          <button className="pill sm danger" onClick={remove}>
            削除
          </button>
          <button className="pill sm primary" onClick={save}>
            保存
          </button>
        </>
      }
    >
      <Field label="内容">
        <textarea
          className="tall"
          value={m.content}
          onChange={(e) => setM({ ...m, content: e.target.value })}
          autoFocus
        />
      </Field>
      <Field label="対象（指定するとその人物が在席のときだけ注入）">
        <div className="select-wrap">
          <select
            value={m.subject}
            onChange={(e) => setM({ ...m, subject: e.target.value })}
          >
            <option value="">（常時）</option>
            {props.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </Field>
      {/* いつの出来事か。日付だけを持ち、時刻は使わない（§10.2）。
          年月日 → 通算分の変換は暦に依存するのでサーバに任せる */}
      <Field label="日付（この出来事がいつのことか。空にすると日付なし）">
        <div className="row">
          {(
            [
              ['年', 'year'],
              ['月', 'month'],
              ['日', 'day'],
            ] as const
          ).map(([label, key]) => (
            <div key={key} className="field" style={{ flex: '1 1 0', minWidth: 0 }}>
              <label>{label}</label>
              <input
                type="number"
                min={1}
                value={date[key] === null ? '' : date[key]}
                placeholder="—"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setDate({ ...date, [key]: v === '' ? null : Math.max(1, parseInt(v, 10) || 1) });
                }}
              />
            </div>
          ))}
        </div>
        {hasDate ? (
          <button className="pill sm" style={{ marginTop: 8 }} onClick={() => setDate(EMPTY_DATE)}>
            日付なしにする
          </button>
        ) : (
          <div className="empty-note" style={{ padding: '6px 0 0', textAlign: 'left' }}>
            日付を入れると、AIへ渡すときに「3年8月7日 / 3日前」のように現在の日付と並べて載ります
          </div>
        )}
      </Field>

      <div className="setting">
        <div className="txt">
          <label>注入する</label>
          <span>OFFにすると記録は残したままAIには渡しません</span>
        </div>
        <button
          className={`toggle${m.enabled !== 0 ? ' on' : ''}`}
          onClick={() => setM({ ...m, enabled: m.enabled === 0 ? 1 : 0 })}
          role="switch"
          aria-checked={m.enabled !== 0}
        >
          <span className="knob" />
        </button>
      </div>
      <div className="setting">
        <div className="txt">
          <label>ピン留め</label>
          <span>予算が足りなくても必ず載せる</span>
        </div>
        <button
          className={`toggle${m.pinned === 1 ? ' on' : ''}`}
          onClick={() => setM({ ...m, pinned: m.pinned ? 0 : 1 })}
          role="switch"
          aria-checked={m.pinned === 1}
        >
          <span className="knob" />
        </button>
      </div>
    </Modal>
  );
}
