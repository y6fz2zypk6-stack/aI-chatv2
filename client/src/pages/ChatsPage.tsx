import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Chat, World } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

export default function ChatsPage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const navigate = useNavigate();
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    api
      .get<Chat[]>(`/chats?archived=${showArchived ? 1 : 0}`)
      .then(setChats)
      .catch(() => {});
  }, [showArchived]);

  useEffect(() => {
    load();
    api.get<World[]>('/worlds').then(setWorlds).catch(() => {});
  }, [load]);

  const worldName = (id: string) => worlds.find((w) => w.id === id)?.name ?? '';

  const archive = async (c: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.put(`/chats/${c.id}`, { archived: c.archived ? 0 : 1 });
    load();
  };

  const remove = async (c: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`「${c.title || '(無題)'}」を削除しますか？メッセージも全て消えます`)) return;
    try {
      await api.del(`/chats/${c.id}`);
      load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <main className="page">
      <h1 className="page-title">
        💬 会話一覧
        <span className="spacer" />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          アーカイブ
        </label>
      </h1>
      {chats.length === 0 && <div className="empty-note">会話がありません</div>}
      {chats.map((c) => (
        <div key={c.id} className="card clickable" onClick={() => navigate(`/chats/${c.id}`)}>
          <div className="row">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="card-title">{c.title || '(無題の会話)'}</div>
              <div className="card-sub">
                {worldName(c.world_id)}
                {c.scenario_id === null && ' ／ （削除済みシナリオ）'} ／{' '}
                {new Date(c.updated_at).toLocaleString('ja-JP')}
              </div>
            </div>
            <button className="btn ghost small" onClick={(e) => archive(c, e)}>
              {c.archived ? '戻す' : '📦'}
            </button>
            <button className="btn danger small" onClick={(e) => remove(c, e)}>
              削除
            </button>
          </div>
        </div>
      ))}
    </main>
  );
}
