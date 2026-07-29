import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { World } from '@shared/types';
import { api } from '../api';
import { Row, TopBar } from '../components';
import { Icon } from '../icons';
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
    <>
      <TopBar
        title="世界"
        back="/chats"
        actions={
          <button className="icon-btn accent" onClick={importWorld} title="取り込み">
            <Icon.upload />
          </button>
        }
      />
      <div className="content">
        {worlds.map((w) => (
          <Row
            key={w.id}
            avatar={<Icon.globe size={20} />}
            avatarTinted
            name={w.name}
            desc={w.description}
            onClick={() => navigate(`/worlds/${w.id}`)}
            chevron
          />
        ))}
        <div className="chatrow add tappable" onClick={create}>
          <span className="av">
            <Icon.plus size={20} />
          </span>
          <div className="body">
            <span className="nm">世界を追加</span>
          </div>
        </div>
        {worlds.length === 0 && <div className="empty-note">世界がまだありません</div>}
      </div>
    </>
  );
}
