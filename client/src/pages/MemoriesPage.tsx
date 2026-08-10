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
          {/* いつの出来事か。生成時は「3日前」等の相対表記になる */}
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

function MemoryEditor(props: {
  memory: MemoryListItem;
  characters: Character[];
  onClose: () => void;
  onDone: () => void;
  toast: (msg: string, error?: boolean) => void;
}) {
  const [m, setM] = useState(props.memory);

  const save = async () => {
    if (!m.content.trim()) {
      props.toast('内容が空です', true);
      return;
    }
    try {
      await api.put(`/memories/${m.id}`, m);
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
