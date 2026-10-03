import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { chatDisplayName, type Character, type Chat, type ChatListItem, type Scenario, type World } from '@shared/types';
import { api } from '../api';
import { Avatar, HomeHead, Modal, Row, TabBar, TopBar } from '../components';
import { formatListStamp } from '../format';
import { Icon } from '../icons';
import { useApp } from '../store';

/**
 * 会話の一覧。`archived` のときはアーカイブの一覧（/chats/archive）として使い回す。
 * 通常の一覧は下部タブの最上位画面、アーカイブはその下の階層（戻るあり・タブなし）
 */
export default function ChatsPage({ archived = false }: { archived?: boolean }) {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  /** アーカイブの件数。0件なら一覧の末尾に行を出さない */
  const [archivedCount, setArchivedCount] = useState(0);
  const [starting, setStarting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const list = await api.get<ChatListItem[]>(`/chats?archived=${archived ? 1 : 0}`).catch(() => []);
    setChats(list);
    setLoaded(true);
    if (!archived) {
      // 件数だけ要る。個人用の規模なので一覧ごと引いて数える
      const arch = await api.get<ChatListItem[]>('/chats?archived=1').catch(() => []);
      setArchivedCount(arch.length);
    }
    const ws = await api.get<World[]>('/worlds').catch(() => []);
    setWorlds(ws);
    // 一覧のアイコン用に全世界のキャラをまとめて引く（個人用の規模なので十分）
    const all = await Promise.all(
      ws.map((w) => api.get<Character[]>(`/worlds/${w.id}/characters`).catch(() => [])),
    );
    setCharacters(all.flat());
  }, [archived]);

  useEffect(() => {
    void load();
  }, [load]);

  const firstChar = (c: ChatListItem) => characters.find((x) => x.id === c.participant_ids[0]);
  // 付けた名前を最優先する（§3.5）。同じキャラの会話が並ぶと見分けが付かないため
  const chatTitle = (c: ChatListItem) => chatDisplayName(c.title, firstChar(c)?.name);
  // 同じキャラの会話を見分ける手がかり。シナリオが消されていれば世界名だけ
  const where = (c: ChatListItem) =>
    c.scenario_title ? `${c.world_name} ・ ${c.scenario_title}` : c.world_name;

  const rows = chats.map((c) => {
    const ch = firstChar(c);
    return (
      <Row
        key={c.id}
        avatar={<Avatar value={ch?.avatar ?? ''} name={chatTitle(c)} />}
        avatarTinted={!ch?.avatar}
        name={chatTitle(c)}
        stamp={formatListStamp(c.updated_at)}
        meta={where(c) || undefined}
        desc={c.preview || undefined}
        onClick={() => navigate(`/chats/${c.id}`)}
      />
    );
  });

  if (archived) {
    return (
      <>
        <TopBar title="アーカイブ" back="/chats" />
        <div className="content">
          {loaded && chats.length === 0 && <div className="empty-note">アーカイブした会話はありません</div>}
          {rows}
        </div>
      </>
    );
  }

  return (
    <>
      <HomeHead title="チャット" />
      <div className="content">
        {loaded && chats.length === 0 && (
          <div className="empty-note">まだ会話がありません。右下の＋から始めましょう</div>
        )}
        {rows}
        {archivedCount > 0 && (
          <button className="archive-row" onClick={() => navigate('/chats/archive')}>
            <Icon.archive size={18} />
            <span className="lbl">アーカイブ</span>
            <span className="n">{archivedCount}件</span>
            <Icon.chevR size={14} />
          </button>
        )}
      </div>

      <button className="fab" onClick={() => setStarting(true)} aria-label="新しい会話">
        <Icon.plus />
      </button>
      <TabBar />

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
