import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  Character,
  Chat,
  GameTime,
  Location,
  Message,
  Utterance,
} from '@shared/types';
import { api, streamGenerate } from '../api';
import { useApp } from '../store';

const WEATHER_ICON: Record<string, string> = {
  晴: '☀️',
  曇: '☁️',
  雨: '🌧',
  小雨: '🌦',
  霧: '🌫',
  雪: '❄️',
  みぞれ: '🌨',
};

interface Detail {
  chat: Chat;
  messages: Message[];
  gameTime: GameTime;
}

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useApp((s) => s.toast);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [editText, setEditText] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const draftKey = `draft:${id}`;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api.get<Detail>(`/chats/${id}`);
      setDetail(d);
      const [chars, locs] = await Promise.all([
        api.get<Character[]>(`/worlds/${d.chat.world_id}/characters`),
        api.get<Location[]>(`/worlds/${d.chat.world_id}/locations`),
      ]);
      setCharacters(chars);
      setLocations(locs);
    } catch (err) {
      toast((err as Error).message, true);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
    // ドラフトの復元（§3.2: 送信中のドラフトだけ localStorage に保持）
    setDraft(localStorage.getItem(`draft:${id}`) ?? '');
  }, [id, load]);

  useEffect(() => {
    localStorage.setItem(draftKey, draft);
  }, [draft, draftKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail?.messages.length, streaming]);

  const charOf = useMemo(() => {
    const map = new Map(characters.map((c) => [c.id, c]));
    return (cid?: string) => (cid ? map.get(cid) : undefined);
  }, [characters]);

  if (!detail) return <main className="page">読み込み中…</main>;
  const { chat, messages, gameTime } = detail;

  const locName =
    chat.state.location_note ||
    locations.find((l) => l.id === chat.state.location)?.name ||
    chat.state.location ||
    '—';

  // ⚠ +Xh バッジ（§8.1）: 末尾assistantで24時間超の経過があった場合
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  const bigJumpH =
    last?.role === 'assistant' && prev && last.state_after.time - prev.state_after.time > 1440
      ? Math.round((last.state_after.time - prev.state_after.time) / 60)
      : 0;

  const generate = (body: Record<string, unknown>) => {
    setBusy(true);
    setStreaming('');
    void streamGenerate(id!, body, {
      onDelta: (text) => setStreaming((s) => (s ?? '') + text),
      onDone: (p) => {
        setStreaming(null);
        setBusy(false);
        void load();
        if (p.generationStatus === 'stopped') toast('生成を停止しました（ここまでを保存）');
        if (p.fenceMissingStreak >= 3) {
          toast('⚠ ステート差分が3回連続で欠落しています。モデルの相性を確認してください', true);
        }
        for (const w of p.warnings.slice(0, 2)) toast(w);
        if (p.autoJoinSuggested.length) {
          const names = p.autoJoinSuggested
            .map((cid) => charOf(cid)?.name ?? cid)
            .join('、');
          if (confirm(`${names} が発話しました。参加者に追加しますか？`)) {
            void api
              .put(`/chats/${id}`, {
                participant_ids: [...chat.participant_ids, ...p.autoJoinSuggested],
              })
              .then(() => load());
          }
        }
      },
      onError: (message, status) => {
        setStreaming(null);
        setBusy(false);
        toast(status === 409 ? '他の端末で生成中です' : message, true);
        void load();
      },
    });
  };

  const send = () => {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft('');
    localStorage.removeItem(draftKey);
    generate({ content });
  };

  const stop = () => {
    void api.post(`/chats/${id}/stop`).catch(() => {});
  };

  const switchVariant = async (m: Message, dir: 1 | -1) => {
    const count = m.variant_count ?? 1;
    const next = (m.active_variant + dir + count) % count;
    try {
      await api.put(`/messages/${m.id}/variant`, { index: next });
      void load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const removeMessage = async (m: Message) => {
    if (!confirm('このメッセージを削除しますか？')) return;
    await api.del(`/messages/${m.id}`);
    setMenuFor(null);
    void load();
  };

  const copyMessage = (m: Message) => {
    void navigator.clipboard.writeText(m.content);
    setMenuFor(null);
    toast('コピーしました');
  };

  const startEdit = (m: Message) => {
    setEditing(m);
    setEditText(m.content);
    setMenuFor(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api.put(`/messages/${editing.id}`, { content: editText });
      setEditing(null);
      void load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const isLastAssistant = (m: Message) => m.id === last?.id && m.role === 'assistant';
  const canRetry = last?.role === 'user' && !busy;

  return (
    <div className="chat-shell">
      <header className="topbar" style={{ paddingBottom: 8 }}>
        <button className="btn ghost icon" onClick={() => navigate('/chats')}>
          ←
        </button>
        <div style={{ fontWeight: 700, fontSize: 15, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chat.title || '(無題の会話)'}
        </div>
        <button className="btn ghost icon" title="プロンプトプレビュー" onClick={() => setShowPreview(true)}>
          🔍
        </button>
        <Link className="btn ghost icon" title="あらすじ" to={`/chats/${id}/summary`}>
          📜
        </Link>
      </header>

      {/* ステートバー（§10.2）: タップでステート編集へ */}
      <div className="state-bar" onClick={() => navigate(`/chats/${id}/state`)}>
        <span>
          {gameTime.season} {gameTime.weekday} {String(gameTime.hh).padStart(2, '0')}:
          {String(gameTime.mm).padStart(2, '0')}
        </span>
        <span className="loc">{locName}</span>
        <span>{WEATHER_ICON[chat.state.weather] ?? chat.state.weather}</span>
        <span className="spacer" />
        {bigJumpH > 24 && <span className="badge-warn">⚠ +{bigJumpH}h</span>}
        <span style={{ color: 'var(--c-text-faint)' }}>✏️</span>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            charOf={charOf}
            menuOpen={menuFor === m.id}
            onToggleMenu={() => setMenuFor(menuFor === m.id ? null : m.id)}
            onDelete={() => void removeMessage(m)}
            onCopy={() => copyMessage(m)}
            onEdit={() => startEdit(m)}
            variantNav={
              isLastAssistant(m) && !busy ? (
                <span className="variant-nav">
                  {(m.variant_count ?? 1) > 1 && (
                    <>
                      <button className="btn ghost small" onClick={() => void switchVariant(m, -1)}>
                        ‹
                      </button>
                      {m.active_variant + 1}/{m.variant_count}
                      <button className="btn ghost small" onClick={() => void switchVariant(m, 1)}>
                        ›
                      </button>
                    </>
                  )}
                  <button
                    className="btn ghost small"
                    title="再生成"
                    onClick={() => generate({ regenerate: true })}
                  >
                    🔄
                  </button>
                </span>
              ) : null
            }
          />
        ))}

        {streaming !== null && (
          <div className="msg-row left">
            <div className="avatar">💭</div>
            <div className="bubble-col">
              <div className="bubble">
                {streaming || <span className="typing-dots">生成中</span>}
              </div>
            </div>
          </div>
        )}

        {canRetry && (
          <div style={{ textAlign: 'center' }}>
            <button className="btn small" onClick={() => generate({ retry: true })}>
              🔁 応答を再試行
            </button>
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="メッセージを入力…"
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        {busy ? (
          <button className="send-btn stop" onClick={stop} title="停止">
            ■
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!draft.trim()} title="送信">
            ➤
          </button>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>メッセージを編集（本文のみ。ステートは変わりません）</h3>
            <textarea
              className="textarea"
              rows={10}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setEditing(null)}>
                キャンセル
              </button>
              <button className="btn primary" onClick={() => void saveEdit()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {showPreview && <PromptPreviewModal chatId={id!} onClose={() => setShowPreview(false)} />}
    </div>
  );
}

// ---- 発話単位の描画（1発話 = 1バブル、narratorはバブルなし §10.2） ----

function MessageView(props: {
  message: Message;
  charOf: (cid?: string) => Character | undefined;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onEdit: () => void;
  variantNav: React.ReactNode;
}) {
  const { message: m } = props;
  const utterances: Utterance[] = m.utterances.length
    ? m.utterances
    : [{ speaker: m.role === 'user' ? 'user' : 'narrator', name: '', text: m.content }];

  return (
    <div>
      {utterances.map((u, i) => {
        if (u.speaker === 'narrator') {
          return (
            <div key={i} className="narrator-line">
              {u.text}
            </div>
          );
        }
        const right = u.speaker === 'user';
        const char = props.charOf(u.characterId);
        const avatar =
          u.speaker === 'npc' ? '👤' : right ? '🙂' : char?.avatar || '👤';
        return (
          <div key={i} className={`msg-row ${right ? 'right' : 'left'}`} style={{ marginBottom: 6 }}>
            <div className="avatar">{avatar}</div>
            <div className="bubble-col">
              {!right && <div className="speaker-name">{u.name}</div>}
              <div className="bubble">{u.text}</div>
            </div>
          </div>
        );
      })}
      <div className={`msg-tools${m.role === 'user' ? ' right' : ''}`} style={m.role === 'user' ? { justifyContent: 'flex-end' } : {}}>
        {props.variantNav}
        <button onClick={props.onToggleMenu}>⋯</button>
        {props.menuOpen && (
          <>
            <button onClick={props.onEdit}>編集</button>
            <button onClick={props.onCopy}>コピー</button>
            <button onClick={props.onDelete} style={{ color: 'var(--c-danger)' }}>
              削除
            </button>
          </>
        )}
        {m.generation_status === 'stopped' && <span className="chip">停止</span>}
      </div>
    </div>
  );
}

// ---- プロンプトプレビュー（§9） ----

interface PreviewData {
  system: string;
  situationBlock: string;
  lore: {
    fired: { id: string; title: string }[];
    adopted: { id: string; title: string }[];
    dropped: { id: string; title: string }[];
  };
  estimatedTokens: number;
  inputBudget: number;
  trimmed: { history: number; lore: number; memories: number };
  model: string;
}

function PromptPreviewModal(props: { chatId: string; onClose: () => void }) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<PreviewData>(`/chats/${props.chatId}/prompt-preview`)
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, [props.chatId]);

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🔍 プロンプトプレビュー</h3>
        {error && <div className="card-sub">{error}</div>}
        {!data && !error && <div className="card-sub">組み立て中…</div>}
        {data && (
          <>
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <span className="chip">モデル: {data.model}</span>
              <span className="chip">
                推定 {data.estimatedTokens.toLocaleString()} / 予算{' '}
                {data.inputBudget.toLocaleString()} tok
              </span>
              {data.trimmed.history > 0 && (
                <span className="chip">履歴削減 {data.trimmed.history}件</span>
              )}
              {data.trimmed.lore > 0 && <span className="chip">ロア削減 {data.trimmed.lore}件</span>}
              {data.trimmed.memories > 0 && (
                <span className="chip">メモリー削減 {data.trimmed.memories}件</span>
              )}
            </div>
            <div className="section-title">現在の状況ブロック</div>
            <pre className="pre-block">{data.situationBlock}</pre>
            <div className="section-title">
              ロア（発火{data.lore.fired.length} / 採用{data.lore.adopted.length} / 予算超過
              {data.lore.dropped.length}）
            </div>
            <div className="row wrap">
              {data.lore.adopted.map((l) => (
                <span key={l.id} className="chip on">
                  {l.title}
                </span>
              ))}
              {data.lore.dropped.map((l) => (
                <span key={l.id} className="chip">
                  ✂ {l.title}
                </span>
              ))}
            </div>
            <div className="section-title">system</div>
            <pre className="pre-block">{data.system}</pre>
          </>
        )}
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
