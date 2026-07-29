import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Character, Memory } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

export default function MemoriesPage() {
  const { id } = useParams<{ id: string }>();
  const [character, setCharacter] = useState<Character | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api.get<Character>(`/characters/${id}`).then(setCharacter).catch(() => {});
    api.get<Memory[]>(`/characters/${id}/memories`).then(setMemories).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  const add = async () => {
    const content = prompt('記憶する事実は？');
    if (!content) return;
    await api.post(`/characters/${id}/memories`, { content });
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
    <main className="page">
      <h1 className="page-title">
        🧠 {character?.name ?? ''} のメモリー
        <span className="spacer" />
        <button className="btn primary small" onClick={add}>
          ＋ 追加
        </button>
      </h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to={`/characters/${id}`}>← キャラクターに戻る</Link>
      </div>
      {memories.length === 0 && <div className="empty-note">メモリーがありません</div>}
      {memories.map((m) => (
        <div key={m.id} className="card">
          <div className="row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, lineHeight: 1.7 }}>{m.content}</div>
              <div className="card-sub">
                {m.source === 'auto' ? '🤖 自動抽出' : '✍️ 手動'}
                {m.subject && ` ／ 対象: ${m.subject}`}
                {m.pinned === 1 && ' ／ 📌 ピン留め'}
              </div>
            </div>
            <button
              className="btn ghost small"
              title="ピン留め"
              onClick={() => update(m, { pinned: m.pinned ? 0 : 1 })}
            >
              📌
            </button>
            <button className="btn small" onClick={() => edit(m)}>
              編集
            </button>
            <button className="btn danger small" onClick={() => remove(m)}>
              削除
            </button>
          </div>
        </div>
      ))}
    </main>
  );
}
