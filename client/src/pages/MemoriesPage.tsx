import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Character, Memory } from '@shared/types';
import { api } from '../api';
import { Row, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

export default function MemoriesPage() {
  const { id } = useParams<{ id: string }>();
  const [character, setCharacter] = useState<Character | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api.get<Character>(`/characters/${id}`).then(setCharacter).catch(() => {});
    api.get<Memory[]>(`/characters/${id}/memories`).then(setMemories).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  const add = async () => {
    const content = draft.trim();
    if (!content) return;
    await api.post(`/characters/${id}/memories`, { content });
    setDraft('');
    load();
  };

  const update = async (m: Memory, patch: Partial<Memory>) => {
    await api.put(`/memories/${m.id}`, { ...m, ...patch });
    load();
  };

  const edit = async (m: Memory) => {
    const content = prompt('内容を編集', m.content);
    if (content == null) return;
    const subject = prompt('対象タグ（人物ID。空なら常時注入）', m.subject) ?? m.subject;
    await update(m, { content, subject });
  };

  const remove = async (m: Memory) => {
    if (!confirm('このメモリーを削除しますか？')) return;
    await api.del(`/memories/${m.id}`);
    load();
    toast('削除しました');
  };

  return (
    <>
      <TopBar title="メモリー" sub={character?.name} back={`/characters/${id}`} />
      <div className="content">
        {memories.length === 0 && (
          <div className="empty-note">
            会話をまたいで覚えておく事実を登録できます
            <br />
            設定の「自動抽出」をONにすると会話から拾われます
          </div>
        )}
        {memories.map((m) => (
          <Row
            key={m.id}
            name={m.content}
            desc={
              <>
                {m.source === 'auto' ? '自動抽出' : '手動'}
                {m.subject && ` / 対象: ${m.subject}`}
                {m.pinned === 1 && ' / ピン留め'}
              </>
            }
            actions={
              <>
                <button
                  className={`icon-btn${m.pinned ? ' accent' : ''}`}
                  onClick={() => void update(m, { pinned: m.pinned ? 0 : 1 })}
                  title="ピン留め"
                >
                  <Icon.pin />
                </button>
                <button className="icon-btn" onClick={() => void edit(m)} title="編集">
                  <Icon.pencil size={16} />
                </button>
                <button
                  className="icon-btn"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => void remove(m)}
                  title="削除"
                >
                  <Icon.trash size={16} />
                </button>
              </>
            }
          />
        ))}
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
    </>
  );
}
