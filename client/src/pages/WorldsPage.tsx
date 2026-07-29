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

  const importWorld = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        const r = await api.post<{ world: World; imported: Record<string, number> }>(
          '/worlds/import',
          json,
        );
        toast(
          `「${r.world.name}」を取り込みました（キャラ${r.imported.characters} / ロア${r.imported.lorebook} / 場所${r.imported.locations}）`,
        );
        navigate(`/worlds/${r.world.id}`);
      } catch (err) {
        toast((err as Error).message, true);
      }
    };
    input.click();
  };

  return (
    <main className="page">
      <h1 className="page-title">
        🌍 世界一覧
        <span className="spacer" />
        <button className="btn small" onClick={importWorld}>
          取込
        </button>
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
