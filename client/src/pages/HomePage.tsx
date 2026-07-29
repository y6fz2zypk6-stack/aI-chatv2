import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Chat, World } from '@shared/types';
import { api } from '../api';

export default function HomePage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Chat[]>('/chats?archived=0').then(setChats).catch(() => {});
    api.get<World[]>('/worlds').then(setWorlds).catch(() => {});
  }, []);

  return (
    <main className="page">
      <h1 className="page-title">🏠 ホーム</h1>

      <div className="section-title">▶ 続きから</div>
      {chats.length === 0 && (
        <div className="empty-note">
          まだ会話がありません。世界からシナリオを作って始めましょう
        </div>
      )}
      {chats.slice(0, 6).map((c) => (
        <div key={c.id} className="card clickable" onClick={() => navigate(`/chats/${c.id}`)}>
          <div className="card-title">{c.title || '(無題の会話)'}</div>
          <div className="card-sub">
            {new Date(c.updated_at).toLocaleString('ja-JP')}
          </div>
        </div>
      ))}

      <div className="section-title">🌍 世界一覧</div>
      {worlds.map((w) => (
        <div key={w.id} className="card clickable" onClick={() => navigate(`/worlds/${w.id}`)}>
          <div className="card-title">{w.name}</div>
          {w.description && <div className="card-sub">{w.description}</div>}
        </div>
      ))}
      <div style={{ marginTop: 14 }}>
        <Link to="/worlds" className="btn">
          世界を管理する
        </Link>
      </div>
    </main>
  );
}
