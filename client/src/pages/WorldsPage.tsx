import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { World } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

export default function WorldsPage() {
  const [worlds, setWorlds] = useState<World[]>([]);
  const navigate = useNavigate();
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    api.get<World[]>('/worlds').then(setWorlds).catch(() => {});
  }, []);

  const create = async () => {
    const name = prompt('新しい世界の名前は？');
    if (!name) return;
    try {
      const w = await api.post<World>('/worlds', { name });
      navigate(`/worlds/${w.id}`);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <main className="page">
      <h1 className="page-title">
        🌍 世界一覧
        <span className="spacer" />
        <button className="btn primary small" onClick={create}>
          ＋ 新しい世界
        </button>
      </h1>
      {worlds.length === 0 && <div className="empty-note">世界がまだありません</div>}
      {worlds.map((w) => (
        <div key={w.id} className="card clickable" onClick={() => navigate(`/worlds/${w.id}`)}>
          <div className="card-title">{w.name}</div>
          {w.description && <div className="card-sub">{w.description}</div>}
        </div>
      ))}
    </main>
  );
}
