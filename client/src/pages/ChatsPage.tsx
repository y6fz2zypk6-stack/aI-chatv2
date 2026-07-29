import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Character, Chat, Scenario, World } from '@shared/types';
import { api } from '../api';
import { Avatar, HomeHead, Modal, Row } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

export default function ChatsPage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();
  const toast = useApp((s) => s.toast);

  const load = useCallback(async () => {
    const list = await api.get<Chat[]>(`/chats?archived=${showArchived ? 1 : 0}`).catch(() => []);
    setChats(list);
    const ws = await api.get<World[]>('/worlds').catch(() => []);
    setWorlds(ws);
    // 一覧のアイコン用に全世界のキャラをまとめて引く（個人用の規模なので十分）
    const all = await Promise.all(
      ws.map((w) => api.get<Character[]>(`/worlds/${w.id}/characters`).catch(() => [])),
    );
    setCharacters(all.flat());
  }, [showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const firstChar = (c: Chat) => characters.find((x) => x.id === c.participant_ids[0]);
  const chatTitle = (c: Chat) => firstChar(c)?.name || c.title || '(無題の会話)';
  const stamp = (t: number) => {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const archive = async (c: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.put(`/chats/${c.id}`, { archived: c.archived ? 0 : 1 });
    void load();
  };

  const remove = async (c: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`「${chatTitle(c)}」を削除しますか？メッセージも全て消えます`)) return;
    try {
      await api.del(`/chats/${c.id}`);
      void load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <>
      <HomeHead
        title="チャット"
        actions={
          <>
            <button
              className="icon-btn"
              onClick={() => setShowArchived(!showArchived)}
              title={showArchived ? '通常の会話' : 'アーカイブ'}
            >
              <Icon.archive />
            </button>
            <button className="icon-btn" onClick={() => navigate('/worlds')} title="世界">
              <Icon.bookOpen />
            </button>
            <button className="icon-btn" onClick={() => navigate('/personas')} title="ペルソナ">
              <Icon.charFile />
            </button>
            <button className="icon-btn" onClick={() => navigate('/settings')} title="設定">
              <Icon.gear />
            </button>
          </>
        }
      />
      <div className="content">
        {chats.length === 0 && (
          <div className="empty-note">
            {showArchived
              ? 'アーカイブした会話はありません'
              : 'まだ会話がありません。右下の＋から始めましょう'}
          </div>
        )}
        {chats.map((c) => {
          const ch = firstChar(c);
          return (
            <Row
              key={c.id}
              avatar={<Avatar value={ch?.avatar ?? ''} name={chatTitle(c)} />}
              avatarTinted={!ch?.avatar}
              name={chatTitle(c)}
              stamp={stamp(c.updated_at)}
              desc={
                c.scenario_id === null
                  ? '（削除済みシナリオ）'
                  : worlds.find((w) => w.id === c.world_id)?.name
              }
              onClick={() => navigate(`/chats/${c.id}`)}
              actions={
                <>
                  <button className="icon-btn" onClick={(e) => archive(c, e)} title="アーカイブ">
                    <Icon.archive />
                  </button>
                  <button
                    className="icon-btn"
                    style={{ color: 'var(--danger)' }}
                    onClick={(e) => remove(c, e)}
                    title="削除"
                  >
                    <Icon.trash />
                  </button>
                </>
              }
            />
          );
        })}
      </div>

      <button className="fab" onClick={() => setStarting(true)} aria-label="新しい会話">
        <Icon.plus />
      </button>

      {starting && (
        <StartChatModal
          worlds={worlds}
          onClose={() => setStarting(false)}
          onStarted={(chatId) => navigate(`/chats/${chatId}`)}
        />
      )}
    </>
  );
}

/** シナリオを選んで新しい会話を始める */
function StartChatModal(props: {
  worlds: World[];
  onClose: () => void;
  onStarted: (chatId: string) => void;
}) {
  const [scenarios, setScenarios] = useState<{ world: World; items: Scenario[] }[]>([]);
  const toast = useApp((s) => s.toast);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const out = await Promise.all(
        props.worlds.map(async (world) => ({
          world,
          items: await api.get<Scenario[]>(`/worlds/${world.id}/scenarios`).catch(() => []),
        })),
      );
      setScenarios(out.filter((x) => x.items.length));
    })();
  }, [props.worlds]);

  const start = async (s: Scenario) => {
    try {
      const chat = await api.post<Chat>(`/scenarios/${s.id}/chats`);
      props.onStarted(chat.id);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <Modal title="シナリオを選ぶ" onClose={props.onClose}>
      {scenarios.length === 0 && (
        <div className="empty-note">
          シナリオがありません。世界を開いてシナリオを作成してください
          <div style={{ marginTop: 12 }}>
            <button className="pill sm primary" onClick={() => navigate('/worlds')}>
              世界へ
            </button>
          </div>
        </div>
      )}
      {scenarios.map(({ world, items }) => (
        <div className="section" key={world.id}>
          <div className="kicker">{world.name}</div>
          {items.map((s) => (
            <Row
              key={s.id}
              name={s.title}
              desc={s.description}
              onClick={() => void start(s)}
              chevron
            />
          ))}
        </div>
      ))}
    </Modal>
  );
}
