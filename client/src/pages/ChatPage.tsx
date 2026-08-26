import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  chatDisplayName,
  CURATED_MODELS,
  modelLabel,
  splitDialogue,
  stripMarks,
  type Character,
  type Chat,
  type EventEvalRow,
  type GameTime,
  type Location,
  type Message,
  type Persona,
  type SnapshotMeta,
  type Utterance,
} from '@shared/types';
import { api, streamGenerate, type DonePayload } from '../api';
import { Avatar, Field, makeThumb, Modal, TriToggle } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

interface ResolvedFlag {
  enabled: boolean;
  from: 'chat' | 'scenario' | 'settings';
}

interface Detail {
  chat: Chat;
  /** 末尾40件だけ。それより前は「さかのぼる」で足す（§5.9） */
  messages: Message[];
  /** 会話全体の件数。「残りn件」の表示に使う */
  total: number;
  hasMore: boolean;
  gameTime: GameTime;
  flags: { events: ResolvedFlag; vars: ResolvedFlag; scenarioMissing: boolean };
  /** 画像本体は含まない。実体は /api/snapshots/:id/image（§21） */
  snapshots: SnapshotMeta[];
}

interface MemoryPreview {
  candidates: {
    character_id: string;
    character_name: string;
    subject: string;
    content: string;
    why: string;
    /** 根拠になった発言の seq。保存時に送り返し、日付はサーバが引き直す */
    at_seq: number;
    /** 「3日前」など。日付不明なら空文字 */
    game_time_label: string;
  }[];
  range: { fromSeq: number; toSeq: number; count: number } | null;
  notes: string[];
}

const FLAG_SOURCE: Record<ResolvedFlag['from'], string> = {
  chat: 'この会話で指定',
  scenario: 'シナリオの設定',
  settings: '全体設定',
};

/** 3段の解決結果を1行で示す。「継承」だけだと結果が読めないため必ず添える */
function FlagResult({ flag }: { flag: ResolvedFlag | undefined }) {
  if (!flag) return null;
  return (
    <div className={`flag-result${flag.enabled ? ' on' : ''}`}>
      いまは <b>{flag.enabled ? 'ON' : 'OFF'}</b>（{FLAG_SOURCE[flag.from]}）
    </div>
  );
}

/**
 * 一覧に出す画像のURL。**縮小版があればそちら**（§21.9）。
 * 原寸は1〜2MBあるので、並べると読み込みが一気に嵩む。
 * 未作成のもの（この機能より前に作った分）は原寸へ落ちる
 */
export const snapshotSrc = (s: SnapshotMeta): string =>
  s.thumb_bytes > 0 ? `/api/snapshots/${s.id}/thumb` : `/api/snapshots/${s.id}/image`;

/**
 * 吹き出し内: 「」で囲まれた部分がセリフ(dlg)、それ以外は地の文(act)。
 * 各セグメントを別ブロックにするので、UI側で自然に改行される。
 * 表示の際は「」そのものは消す。
 *
 * **分割の規則は `splitDialogue`（shared）にある。** スナップショットの
 * プロンプトが拾う地の文と同じ規則を使うため（§21.2）。
 */
function BubbleText({ text }: { text: string }) {
  const parts = splitDialogue(text);
  // 「」だけの発話など、分割して何も残らなかったときは元の文をそのまま出す
  if (!parts.length) parts.push({ dlg: true, text: stripMarks(text).trim() });
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={p.dlg ? 'dlg' : 'act'}>
          {p.text}
        </span>
      ))}
    </>
  );
}

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useApp((s) => s.toast);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [defaultModel, setDefaultModel] = useState('');
  /** 画像モデルが設定されているときだけスナップショットの入口を出す（§21） */
  const [imageEnabled, setImageEnabled] = useState(false);
  /** スナップショットを作る対象のメッセージ */
  const [snapshotFor, setSnapshotFor] = useState<Message | null>(null);
  /** 原寸で見ているスナップショット（一覧は縮小版なので、拡大の逃げ道を用意する） */
  const [viewing, setViewing] = useState<SnapshotMeta | null>(null);
  /** 「さかのぼる」を実行中。二重に押されないようにする */
  const [olderBusy, setOlderBusy] = useState(false);
  /** 会話の名前を変える（§3.5） */
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoplaying, setAutoplaying] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [editText, setEditText] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showChatSettings, setShowChatSettings] = useState(false);
  const [memPreview, setMemPreview] = useState<MemoryPreview | null>(null);
  const [memLoading, setMemLoading] = useState(false);
  const [memSaving, setMemSaving] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const autoplayCancel = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftKey = `draft:${id}`;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api.get<Detail>(`/chats/${id}`);
      setDetail(d);
      const [chars, locs, config] = await Promise.all([
        api.get<Character[]>(`/worlds/${d.chat.world_id}/characters`),
        api.get<Location[]>(`/worlds/${d.chat.world_id}/locations`),
        api.get<{ defaultModel: string; imageEnabled: boolean }>('/config'),
      ]);
      setCharacters(chars);
      setLocations(locs);
      setDefaultModel(config.defaultModel);
      setImageEnabled(!!config.imageEnabled);
      if (d.chat.persona_id) {
        const personas = await api.get<Persona[]>('/personas');
        setPersona(personas.find((p) => p.id === d.chat.persona_id) ?? null);
      }
    } catch (err) {
      toast((err as Error).message, true);
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
    setDraft(localStorage.getItem(`draft:${id}`) ?? '');
  }, [id, load]);

  useEffect(() => {
    localStorage.setItem(draftKey, draft);
  }, [draft, draftKey]);

  /**
   * 末尾へ寄せる。**依存は「末尾のID」で、件数ではない。**
   * 件数にすると「さかのぼる」で古い分を足しただけで一番下へ飛んでしまう
   */
  const lastId = detail?.messages[detail.messages.length - 1]?.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, streaming]);

  /**
   * 古い分を足したときの、足す直前の高さ。
   * **描画のあとに差分を戻さないと、読んでいた場所を見失う。**
   * `requestAnimationFrame` ではReactの反映前に走ることがあるので、
   * DOM更新後・描画前に必ず走る `useLayoutEffect` で調整する
   */
  const keepScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && keepScroll.current !== null) {
      el.scrollTop += el.scrollHeight - keepScroll.current;
      keepScroll.current = null;
    }
  }, [detail?.messages.length]);

  /** それより前を40件足す */
  const loadOlder = async () => {
    const el = scrollRef.current;
    const first = detail?.messages[0];
    if (!first || olderBusy) return;
    setOlderBusy(true);
    try {
      const r = await api.get<{ messages: Message[]; hasMore: boolean }>(
        `/chats/${id}/messages?before_seq=${first.seq}`,
      );
      keepScroll.current = el?.scrollHeight ?? 0;
      setDetail((d) =>
        d ? { ...d, messages: [...r.messages, ...d.messages], hasMore: r.hasMore } : d,
      );
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setOlderBusy(false);
    }
  };

  const charOf = useMemo(() => {
    const map = new Map(characters.map((c) => [c.id, c]));
    return (cid?: string) => (cid ? map.get(cid) : undefined);
  }, [characters]);

  if (!detail) return <div className="empty-note">読み込み中…</div>;
  const { chat, messages, gameTime } = detail;

  const locName =
    chat.state.location_note ||
    locations.find((l) => l.id === chat.state.location)?.name ||
    chat.state.location ||
    '—';

  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  const bigJumpH =
    last?.role === 'assistant' && prev && last.state_after.time - prev.state_after.time > 1440
      ? Math.round((last.state_after.time - prev.state_after.time) / 60)
      : 0;

  const titleName = chatDisplayName(chat.title, charOf(chat.participant_ids[0])?.name);

  const generate = (body: Record<string, unknown>): Promise<DonePayload | null> => {
    setBusy(true);
    setStreaming('');
    setSheetOpen(false);
    return new Promise((resolve) => {
      void streamGenerate(id!, body, {
        onDelta: (text) => setStreaming((s) => (s ?? '') + text),
        onDone: (p) => {
          setStreaming(null);
          setBusy(false);
          void load();
          if (p.generationStatus === 'stopped') toast('生成を停止しました（ここまでを保存）');
          if (p.fenceMissingStreak >= 3) {
            toast('ステート差分が3回連続で欠落しています。モデルの相性を確認してください', true);
          }
          for (const e of p.firedEvents) toast(`イベント発生: ${e}`);
          for (const w of p.warnings.slice(0, 2)) toast(w);
          if (p.autoJoinSuggested.length) {
            const names = p.autoJoinSuggested.map((cid) => charOf(cid)?.name ?? cid).join('、');
            if (confirm(`${names} が発話しました。参加者に追加しますか？`)) {
              void api
                .put(`/chats/${id}`, {
                  participant_ids: [...chat.participant_ids, ...p.autoJoinSuggested],
                })
                .then(() => load());
            }
          }
          resolve(p);
        },
        onError: (message, status) => {
          setStreaming(null);
          setBusy(false);
          toast(status === 409 ? '他の端末で生成中です' : message, true);
          void load();
          resolve(null);
        },
        // 裏で走った要約・抽出の結果。done のあとに届くので、resolve は待たせない
        onNotice: (n) => toast(n.message, !n.ok),
      });
    });
  };

  /**
   * プレビューで見た候補をそのまま保存する。
   * 抽出をやり直さないので、コールを二重に払わず、見たものと保存されるものが一致する。
   */
  const saveCandidates = async () => {
    if (!memPreview?.range) return;
    setMemSaving(true);
    try {
      const r = await api.post<{ added: number; message: string }>(`/chats/${id}/extract/commit`, {
        candidates: memPreview.candidates.map((c) => ({
          character_id: c.character_id,
          subject: c.subject,
          content: c.content,
          at_seq: c.at_seq,
        })),
        toSeq: memPreview.range.toSeq,
      });
      toast(r.message);
      setMemPreview(null);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setMemSaving(false);
    }
  };

  /** 参加キャラの加除。0人にすると誰の定義も渡らなくなるので、最後の1人は外させない */
  const toggleParticipant = async (cid: string) => {
    const cur = chat.participant_ids;
    const next = cur.includes(cid) ? cur.filter((x) => x !== cid) : [...cur, cid];
    if (next.length === 0) {
      toast('参加キャラを0人にはできません', true);
      return;
    }
    try {
      await api.put(`/chats/${id}`, { participant_ids: next });
      toast(cur.includes(cid) ? '参加キャラから外しました' : '参加キャラに加えました');
      await load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const send = () => {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft('');
    localStorage.removeItem(draftKey);
    void generate({ content });
  };

  const stop = () => {
    autoplayCancel.current = true;
    void api.post(`/chats/${id}/stop`).catch(() => {});
  };

  // 誤操作を避けるため、削除・アーカイブは一覧ではなくこの会話を開いた状態からのみ行う
  const toggleArchive = async () => {
    const next = chat.archived ? 0 : 1;
    setSheetOpen(false);
    try {
      await api.put(`/chats/${id}`, { archived: next });
      if (next) {
        // アーカイブすると通常の一覧から外れるので、一覧へ戻す
        toast('アーカイブしました');
        navigate('/chats');
      } else {
        toast('アーカイブから戻しました');
        await load();
      }
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const removeChat = async () => {
    if (!confirm(`「${titleName}」を削除しますか？メッセージも全て消えます`)) return;
    setSheetOpen(false);
    try {
      await api.del(`/chats/${id}`);
      navigate('/chats');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const runAutoplay = async () => {
    if (busy || autoplaying) return;
    setAutoplaying(true);
    autoplayCancel.current = false;
    try {
      const settings = await api.get<{ autoplay_steps: number }>('/settings');
      for (let i = 0; i < Math.max(1, settings.autoplay_steps); i++) {
        if (autoplayCancel.current) break;
        const p = await generate({ autoContinue: true });
        if (!p || p.generationStatus === 'stopped' || p.autoplayShouldStop) {
          if (p?.autoplayShouldStop) toast('区切りが良いためオートプレイを停止しました');
          break;
        }
      }
    } finally {
      setAutoplaying(false);
    }
  };

  // ‹›で候補を移動。末尾で「次へ」なら再生成（参照アプリと同じ挙動）
  const switchVariant = async (m: Message, dir: 1 | -1) => {
    const count = m.variant_count ?? 1;
    const next = m.active_variant + dir;
    if (next < 0) return;
    if (next >= count) {
      void generate({ regenerate: true });
      return;
    }
    try {
      await api.put(`/messages/${m.id}/variant`, { index: next });
      void load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const pickModel = async (modelId: string) => {
    setModelMenu(false);
    try {
      await api.put(`/chats/${id}`, { model: modelId });
      toast(`モデル: ${modelLabel(modelId || defaultModel)}`);
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

  const fork = async (m: Message) => {
    setMenuFor(null);
    if (!confirm('このメッセージまでを新しいチャットに分岐しますか？')) return;
    try {
      const c = await api.post<Chat>(`/chats/${id}/fork`, { message_id: m.id });
      toast('分岐しました');
      navigate(`/chats/${c.id}`);
    } catch (err) {
      toast((err as Error).message, true);
    }
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

  const effModel = chat.model || defaultModel;
  const canRetry = last?.role === 'user' && !busy;

  return (
    <div className="chat-shell" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header className="topbar">
        <button className="icon-btn" onClick={() => navigate('/chats')} aria-label="戻る">
          <Icon.back />
        </button>
        <div className="title">
          <b>{titleName}</b>
          <span className="sub">{chat.narrator_enabled ? 'narrator on' : 'narrator off'}</span>
        </div>
        <button className="model-pill" onClick={() => setModelMenu(true)}>
          <span className="lbl">{modelLabel(effModel)}</span>
          <Icon.chevD />
        </button>
      </header>

      {/* ステートバー（§10.2）: タップでステート編集へ */}
      <div className="state-bar" onClick={() => navigate(`/chats/${id}/state`)}>
        {/* 日付・曜日・時刻。季節はプロンプトの「現在の状況」側に出るのでここでは省く */}
        <span>
          {gameTime.month}/{gameTime.day} {gameTime.weekday}{' '}
          {String(gameTime.hh).padStart(2, '0')}:{String(gameTime.mm).padStart(2, '0')}
        </span>
        <span className="loc">{locName}</span>
        <span>{chat.state.weather}</span>
        <span className="spacer" />
        {bigJumpH > 24 && <span className="tag">+{bigJumpH}H</span>}
        {/* 時間を進める。ステート編集と違い、天候の抽選とイベント判定が走る */}
        <button
          className="icon-btn"
          title="場面を進める"
          onClick={(e) => {
            e.stopPropagation();
            setAdvanceOpen(true);
          }}
        >
          <Icon.clock size={14} />
        </button>
        <Icon.pencil size={14} />
      </div>

      <div className="content" ref={scrollRef} style={{ padding: '14px 0' }}>
        <div className="messages">
          {/* 初回は末尾40件だけ読む（§5.9）。画像付きの長い会話を一度に読まないため */}
          {detail.hasMore && (
            <div className="load-older">
              <button className="pill sm" disabled={olderBusy} onClick={() => void loadOlder()}>
                {olderBusy
                  ? '読み込み中…'
                  : `さかのぼる（残り${detail.total - messages.length}件）`}
              </button>
            </div>
          )}
          {messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              isLast={m.id === last?.id}
              busy={busy}
              charOf={charOf}
              persona={persona}
              menuOpen={menuFor === m.id}
              onToggleMenu={() => setMenuFor(menuFor === m.id ? null : m.id)}
              onDelete={() => void removeMessage(m)}
              onCopy={() => {
                void navigator.clipboard.writeText(m.content);
                setMenuFor(null);
                toast('コピーしました');
              }}
              onEdit={() => {
                setEditing(m);
                setEditText(m.content);
                setMenuFor(null);
              }}
              onFork={() => void fork(m)}
              onRegenerate={() => void generate({ regenerate: true })}
              onSwitchVariant={(dir) => void switchVariant(m, dir)}
              snapshots={(detail.snapshots ?? []).filter((s) => s.message_id === m.id)}
              canSnapshot={imageEnabled}
              onSnapshot={() => {
                setSnapshotFor(m);
                setMenuFor(null);
              }}
              onDeleteSnapshot={async (sid) => {
                if (!confirm('このスナップショットを削除しますか？')) return;
                try {
                  await api.del(`/snapshots/${sid}`);
                  await load();
                } catch (err) {
                  toast((err as Error).message, true);
                }
              }}
              // 一覧は縮小版なので、細部を見たいときの逃げ道を必ず用意する（§21.9）
              onOpenSnapshot={setViewing}
            />
          ))}

          {streaming !== null && (
            <div className="turn-row char">
              <div className="turn-body">
                <span className="turn-av">
                  <Icon.sparkle size={16} />
                </span>
                <div className="turn-col">
                  <div className="bubble">
                    <span className="dlg">
                      {streaming}
                      <span className="caret" />
                    </span>
                  </div>
                </div>
              </div>
              <div className="msg-side" />
            </div>
          )}

          {canRetry && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button className="pill sm" onClick={() => void generate({ retry: true })}>
                <Icon.refresh />
                応答を再試行
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={`composer${sheetOpen ? ' sheet-open' : ''}`}>
        <button
          className={`plus${sheetOpen ? ' open' : ''}`}
          onClick={() => setSheetOpen(!sheetOpen)}
          aria-label="メニュー"
        >
          <Icon.plus />
        </button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="メッセージを入力…"
          rows={1}
          style={{ height: Math.min(160, 44 + (draft.split('\n').length - 1) * 22) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        {busy ? (
          <button className="send stop" onClick={stop} aria-label="停止">
            <Icon.square size={15} />
          </button>
        ) : (
          <button className="send" onClick={send} disabled={!draft.trim()} aria-label="送信">
            <Icon.send />
          </button>
        )}
      </div>

      {sheetOpen && (
        <div className="sheet">
          <button
            className="srow"
            onClick={() => void runAutoplay()}
            disabled={autoplaying || last?.role !== 'assistant'}
          >
            <span className="ic">
              <Icon.forward />
            </span>
            <span className="txt">
              <b>オートプレイ</b>
              <span>ユーザー入力なしで場面を進める</span>
            </span>
          </button>
          <button className="srow" onClick={() => { setSheetOpen(false); navigate(`/chats/${id}/summary`); }}>
            <span className="ic">
              <Icon.scroll />
            </span>
            <span className="txt">
              <b>あらすじ</b>
              <span>これまでの出来事を確認・編集</span>
            </span>
            <span className="chev">
              <Icon.chevR size={13} />
            </span>
          </button>
          <button className="srow" onClick={() => { setSheetOpen(false); setShowPreview(true); }}>
            <span className="ic">
              <Icon.search />
            </span>
            <span className="txt">
              <b>プロンプトを確認</b>
              <span>組み立て結果とロアの発火状況</span>
            </span>
          </button>
          <button
            className="srow"
            onClick={() => {
              setSheetOpen(false);
              setMemLoading(true);
              setMemPreview(null);
              void api
                .post<MemoryPreview>(`/chats/${id}/extract-preview`)
                .then(setMemPreview)
                .catch((err) => toast((err as Error).message, true))
                .finally(() => setMemLoading(false));
            }}
          >
            <span className="ic">
              <Icon.brain size={19} />
            </span>
            <span className="txt">
              <b>メモリー候補を確認</b>
              <span>保存せずに、抽出される内容と理由を見る</span>
            </span>
          </button>
          <button
            className="srow"
            onClick={() => {
              setSheetOpen(false);
              setRenameText(chat.title);
              setRenaming(true);
            }}
          >
            <span className="ic">
              <Icon.pencil />
            </span>
            <span className="txt">
              <b>会話の名前を変える</b>
              <span>一覧とアルバムでの呼び名</span>
            </span>
          </button>
          <button className="srow" onClick={() => { setSheetOpen(false); setShowChatSettings(true); }}>
            <span className="ic">
              <Icon.gear />
            </span>
            <span className="txt">
              <b>この会話の設定</b>
              <span>イベントと進行フラグの有効・無効</span>
            </span>
          </button>
          <a className="srow" href={`/api/chats/${id}/export`} download onClick={() => setSheetOpen(false)}>
            <span className="ic">
              <Icon.download />
            </span>
            <span className="txt">
              <b>会話を書き出す</b>
              <span>候補を含むJSON</span>
            </span>
          </a>
          <button className="srow" onClick={() => void toggleArchive()}>
            <span className="ic">
              <Icon.archive />
            </span>
            <span className="txt">
              <b>{chat.archived ? 'アーカイブから戻す' : 'アーカイブする'}</b>
              <span>{chat.archived ? '通常の一覧に表示する' : '一覧から隠す（消えません）'}</span>
            </span>
          </button>
          <button className="srow danger" onClick={() => void removeChat()}>
            <span className="ic">
              <Icon.trash />
            </span>
            <span className="txt">
              <b>この会話を削除する</b>
              <span>メッセージも全て消えます。元に戻せません</span>
            </span>
          </button>
        </div>
      )}

      {(memLoading || memPreview) && (
        <Modal
          title="メモリー候補"
          onClose={() => { setMemPreview(null); setMemLoading(false); }}
          actions={
            memPreview?.range && memPreview.candidates.length > 0 ? (
              <button className="pill sm primary" disabled={memSaving} onClick={() => void saveCandidates()}>
                {memSaving ? '保存中…' : `${memPreview.candidates.length}件を保存`}
              </button>
            ) : undefined
          }
        >
          {memLoading && <div className="empty-note">抽出中…</div>}
          {memPreview && (
            <>
              <div className="empty-note" style={{ padding: 0, textAlign: 'left' }}>
                {memPreview.range
                  ? `未抽出の ${memPreview.range.count} 件（seq ${memPreview.range.fromSeq}〜${memPreview.range.toSeq}）が対象です。保存すると、ここまでを抽出済みにします。`
                  : '対象がありません。'}
              </div>
              {memPreview.candidates.length === 0 && memPreview.range && (
                <div className="empty-note">保存に値する内容はありませんでした</div>
              )}
              {memPreview.candidates.map((c, i) => (
                <div key={i} className="mem-cand">
                  <div className="head">
                    <span className="tag mute">{c.character_name}</span>
                    {c.subject && <span className="tag">対象: {charOf(c.subject)?.name ?? c.subject}</span>}
                    {c.game_time_label && <span className="tag mute">{c.game_time_label}</span>}
                  </div>
                  <p className="txt">{c.content}</p>
                  {c.why && <p className="why">{c.why}</p>}
                </div>
              ))}
              {memPreview.notes.map((n, i) => (
                <div key={`n${i}`} className="empty-note" style={{ padding: 0, textAlign: 'left' }}>
                  {n}
                </div>
              ))}
            </>
          )}
        </Modal>
      )}

      {showChatSettings && (
        <Modal title="この会話の設定" onClose={() => setShowChatSettings(false)}>
          {/* シナリオの参加キャラは会話を作った時点でコピーされるので、
              あとから足したい／外したいときはここで直す（§4.6・§15.2） */}
          <Field label="参加キャラ（タップで加除）">
            <div className="row wrap">
              {characters.map((c) => {
                const on = chat.participant_ids.includes(c.id);
                return (
                  <span
                    key={c.id}
                    className={`chip${on ? ' on' : ''}`}
                    onClick={() => void toggleParticipant(c.id)}
                  >
                    {c.name}
                    {c.is_npc_pool === 1 && !on && '（準レギュラー）'}
                  </span>
                );
              })}
              {characters.length === 0 && <span className="empty-note">キャラクターがいません</span>}
            </div>
          </Field>
          <div className="empty-note" style={{ padding: 0, textAlign: 'left' }}>
            参加キャラの定義は毎ターン必ず渡します。準レギュラーは、
            <b>対象キャラを指定したロアが発火したターンだけ</b>渡します。
            出ずっぱりになった相手はここで参加キャラに加えてください。
          </div>

          <Field label="条件付きイベント">
            <TriToggle
              value={chat.events_enabled}
              onChange={(v) => void api.put(`/chats/${id}`, { events_enabled: v }).then(load)}
              inheritedLabel="シナリオ / 全体設定"
            />
            <FlagResult flag={detail.flags?.events} />
          </Field>
          <Field label="進行フラグ">
            <TriToggle
              value={chat.vars_enabled}
              onChange={(v) => void api.put(`/chats/${id}`, { vars_enabled: v }).then(load)}
              inheritedLabel="シナリオ / 全体設定"
            />
            <FlagResult flag={detail.flags?.vars} />
          </Field>
          <div className="empty-note" style={{ padding: 0, textAlign: 'left' }}>
            「継承」は シナリオ → 全体設定 の順に見ます。
            {detail.flags?.scenarioMissing && ' このチャットのシナリオは削除済みのため、全体設定を見ています。'}
            <br />
            オフにしても、これまでに記録した進行フラグと発火履歴は残ります
          </div>
        </Modal>
      )}

      {modelMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setModelMenu(false)} />
          <div className="model-menu" style={{ right: 12, top: 'calc(60px + env(safe-area-inset-top))' }}>
            <button className={`mrow${!chat.model ? ' active' : ''}`} onClick={() => void pickModel('')}>
              既定（{modelLabel(defaultModel)}）
              {!chat.model && (
                <span className="ck">
                  <Icon.check size={16} />
                </span>
              )}
            </button>
            {CURATED_MODELS.map((m) => (
              <button
                key={m.id}
                className={`mrow${chat.model === m.id ? ' active' : ''}`}
                onClick={() => void pickModel(m.id)}
              >
                {m.label}
                {chat.model === m.id && (
                  <span className="ck">
                    <Icon.check size={16} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>メッセージを編集</h3>
            <p className="empty-note" style={{ padding: 0, textAlign: 'left' }}>
              本文のみ修正します。ステートは変わりません
            </p>
            <textarea
              className="tall"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
            <div className="acts">
              <button className="pill sm" onClick={() => setEditing(null)}>
                キャンセル
              </button>
              <button className="pill sm primary" onClick={() => void saveEdit()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {showPreview && <PromptPreviewModal chatId={id!} onClose={() => setShowPreview(false)} />}

      {snapshotFor && (
        <SnapshotModal
          message={snapshotFor}
          onClose={() => setSnapshotFor(null)}
          onDone={() => {
            setSnapshotFor(null);
            void load();
          }}
          toast={toast}
        />
      )}

      {renaming && (
        <Modal
          title="会話の名前"
          onClose={() => setRenaming(false)}
          actions={
            <button
              className="pill sm primary"
              onClick={async () => {
                try {
                  await api.put(`/chats/${id}`, { title: renameText.trim() });
                  setRenaming(false);
                  await load();
                } catch (err) {
                  toast((err as Error).message, true);
                }
              }}
            >
              保存
            </button>
          }
        >
          <Field label="名前">
            <input
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              placeholder={charOf(chat.participant_ids[0])?.name ?? '会話'}
              autoFocus
            />
            <div className="empty-note" style={{ padding: '6px 0 0', textAlign: 'left' }}>
              空にすると、参加しているキャラクターの名前で表示されます
            </div>
          </Field>
        </Modal>
      )}

      {viewing && (
        <Modal title="スナップショット" onClose={() => setViewing(null)}>
          <div className="album-full">
            {/* ここだけ原寸。一覧は縮小版（§21.9） */}
            <img src={`/api/snapshots/${viewing.id}/image`} alt="スナップショット（原寸）" />
          </div>
        </Modal>
      )}

      {advanceOpen && (
        <AdvanceModal
          chatId={id!}
          gameTime={gameTime}
          locations={locations}
          onClose={() => setAdvanceOpen(false)}
          onDone={(msg) => {
            setAdvanceOpen(false);
            toast(msg);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---- 場面を進める（§8.8）----

interface AdvanceResult {
  gameTime: GameTime;
  dayChanged: boolean;
  weather: string;
  firedEvents: string[];
  warnings: string[];
  eventsEnabled: boolean;
}

/**
 * ステート編集との違いは「遷移として扱うかどうか」。
 * こちらは生成ターンと同じ経路を通るので、日付が変われば天候が引き直され、
 * イベントの判定も走る。LLMは呼ばない。
 */
function AdvanceModal(props: {
  chatId: string;
  gameTime: GameTime;
  locations: Location[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [gt, setGt] = useState<GameTime>({ ...props.gameTime });
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<AdvanceResult>(`/chats/${props.chatId}/advance`, {
        ...body,
        ...(location ? { location } : {}),
      });
      const hhmm = `${String(r.gameTime.hh).padStart(2, '0')}:${String(r.gameTime.mm).padStart(2, '0')}`;
      const parts = [`${r.gameTime.month}月${r.gameTime.day}日 ${hhmm} へ進めました`];
      // 日付が変わったときだけ天候を引き直すので、変わったときだけ知らせる
      if (r.dayChanged) parts.push(`天気は「${r.weather}」`);
      if (r.firedEvents.length) parts.push(`イベント: ${r.firedEvents.join('・')}`);
      props.onDone(parts.join(' ／ '));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // クイックは相対分で送る。暦（1か月の日数など）はサーバが持っているので、
  // 桁上がりの計算をクライアントでは行わない
  const minOfDay = props.gameTime.hh * 60 + props.gameTime.mm;
  const quick: [string, number][] = [
    ['+30分', 30],
    ['+1時間', 60],
    ['+3時間', 180],
    ['翌朝 8:00', 1440 - minOfDay + 8 * 60],
    ['翌日の同じ時刻', 1440],
  ];

  const num = (v: string, fb: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fb;
  };

  return (
    <Modal title="場面を進める" onClose={props.onClose}>
      <div className="empty-note" style={{ padding: 0, textAlign: 'left' }}>
        ステート編集と違い、日付が変われば天候を引き直し、イベントの判定も行います。
        会話の生成（AIの呼び出し）はしません。
      </div>

      <span className="kicker">クイック</span>
      <div className="row wrap">
        {quick.map(([label, minutes]) => (
          <button
            key={label}
            className="pill sm"
            disabled={busy}
            onClick={() => void run({ minutes })}
          >
            {label}
          </button>
        ))}
      </div>

      <span className="kicker">日時を指定</span>
      {/* 5つを1行に収める。折り返すと年月日と時分の区切りが読み取りづらくなる */}
      <div className="row">
        {(
          [
            ['年', 'year', 1],
            ['月', 'month', 1],
            ['日', 'day', 1],
            ['時', 'hh', 0],
            ['分', 'mm', 0],
          ] as const
        ).map(([label, key, min]) => (
          <div key={key} className="field" style={{ flex: "1 1 0", minWidth: 0 }}>
            <label>{label}</label>
            <input
              type="number"
              min={min}
              value={gt[key]}
              onChange={(e) => setGt({ ...gt, [key]: num(e.target.value, gt[key]) })}
            />
          </div>
        ))}
      </div>

      <Field label="場所（変えるときだけ選ぶ）">
        <div className="select-wrap">
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">（変えない）</option>
            {props.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      </Field>

      {error && <div className="empty-note err">{error}</div>}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button
          className="pill sm primary"
          disabled={busy}
          onClick={() =>
            void run({ game_time: { year: gt.year, month: gt.month, day: gt.day, hh: gt.hh, mm: gt.mm } })
          }
        >
          この日時へ進める
        </button>
      </div>
    </Modal>
  );
}

// ---- 発話単位の描画（1発話 = 1バブル、narratorはハート付きの独立行） ----

function MessageView(props: {
  message: Message;
  isLast: boolean;
  busy: boolean;
  charOf: (cid?: string) => Character | undefined;
  persona: Persona | null;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onFork: () => void;
  onRegenerate: () => void;
  onSwitchVariant: (dir: 1 | -1) => void;
  snapshots: SnapshotMeta[];
  canSnapshot: boolean;
  onSnapshot: () => void;
  onDeleteSnapshot: (id: string) => void;
  onOpenSnapshot: (s: SnapshotMeta) => void;
}) {
  const { message: m } = props;
  const utterances: Utterance[] = m.utterances.length
    ? m.utterances
    : [{ speaker: m.role === 'user' ? 'user' : 'narrator', name: '', text: m.content }];
  const count = m.variant_count ?? 1;
  const showSwipe = props.isLast && m.role === 'assistant' && !props.busy;

  // 操作列は最後の行にだけ付ける（1メッセージ＝複数吹き出しでも操作は1つ）。
  // それ以外の行にも空の列を置き、全ての吹き出し幅を揃える
  const side = (
    <div className="msg-side">
      {showSwipe && (
        <div className="swipe">
          <button
            onClick={() => props.onSwitchVariant(-1)}
            disabled={m.active_variant === 0}
            aria-label="前の候補"
          >
            <Icon.chevL />
          </button>
          {m.active_variant + 1}/{count}
          <button onClick={() => props.onSwitchVariant(1)} aria-label="次の候補／再生成">
            <Icon.chevR size={11} />
          </button>
        </div>
      )}
      <button
        className={`msgmenu${props.menuOpen ? ' on' : ''}`}
        onClick={props.onToggleMenu}
        aria-label="操作"
      >
        <Icon.dots />
      </button>
    </div>
  );
  const emptySide = <div className="msg-side" />;

  // 場面転換マーカーは吹き出しではなく区切り線として出す。
  // 生成された応答ではないので、再生成・分岐・編集は出さず、取り消しだけ置く
  if (m.kind === 'scene_break') {
    return (
      <div className="scene-break">
        <span className="rule" />
        {/* 本文の先頭のダッシュは履歴でモデルに読ませるためのもの。線と重なるので表示では外す */}
        <span className="txt">{m.content.replace(/^[―—–-]+\s*/, '')}</span>
        <button className="icon-btn" onClick={props.onDelete} title="この場面転換を取り消す">
          <Icon.trash size={14} />
        </button>
        <span className="rule" />
      </div>
    );
  }

  return (
    <div className="msg">
      {utterances.map((u, i) => {
        const isLastUtterance = i === utterances.length - 1;
        const rowSide = isLastUtterance ? side : emptySide;

        if (u.speaker === 'narrator') {
          return (
            <div key={i} className="narr-row">
              <div className="narr-gutter">
                <span className="narr-heart">
                  <Icon.heart />
                </span>
              </div>
              <div className="narr-text">{stripMarks(u.text.trim())}</div>
              {rowSide}
            </div>
          );
        }

        const isUser = u.speaker === 'user';
        // その場限りの脇役（`NPC[名前]:`）。登録された人物ではないのでアバターを持たない
        const isMob = u.speaker === 'npc';
        const char = props.charOf(u.characterId);
        const avatarValue = isUser ? (props.persona?.avatar ?? '') : (char?.avatar ?? '');
        const rowClass = isUser ? 'user' : isMob ? 'mob' : 'char';

        return (
          <div key={i} className={`turn-row ${rowClass}`}>
            <div className="turn-body">
              <Avatar
                className="turn-av"
                value={avatarValue}
                name={u.name}
                // 一度きりの相手なので頭文字は手がかりにならない。人型で「登録された人物ではない」と示す
                fallback={isMob ? <Icon.person size={18} /> : undefined}
              />
              <div className="turn-col">
                <span className="turn-name">{u.name}</span>
                <div className="bubble">
                  <BubbleText text={u.text} />
                </div>
              </div>
            </div>
            {rowSide}
          </div>
        );
      })}

      {props.snapshots.length > 0 && (
        <div className="snapshots">
          {props.snapshots.map((s) => (
            <figure key={s.id}>
              {/* 画像はJSONに載せていないので、実体はこのエンドポイントから取る（§21）。
                  一覧では縮小版を使う。未作成（thumb_bytes=0）なら原寸へ落ちる（§21.9） */}
              <img
                src={snapshotSrc(s)}
                alt="この場面のスナップショット"
                loading="lazy"
                onClick={() => props.onOpenSnapshot(s)}
              />
              <button
                className="icon-btn"
                onClick={() => props.onDeleteSnapshot(s.id)}
                title="このスナップショットを削除"
              >
                <Icon.trash size={14} />
              </button>
            </figure>
          ))}
        </div>
      )}

      {props.menuOpen && (
        <>
          <div className="menu-backdrop" onClick={props.onToggleMenu} />
          <div className="popover" style={{ right: 14, marginTop: -6, position: 'relative', width: '100%' }}>
            {showSwipe && (
              <button className="prow" onClick={props.onRegenerate}>
                <span className="ic">
                  <Icon.refresh size={17} />
                </span>
                <span>再生成する</span>
              </button>
            )}
            <button className="prow" onClick={props.onEdit}>
              <span className="ic">
                <Icon.pencil size={17} />
              </span>
              <span>編集する</span>
            </button>
            <button className="prow" onClick={props.onCopy}>
              <span className="ic">
                <Icon.copy size={17} />
              </span>
              <span>コピーする</span>
            </button>
            {/* スナップショットは「その瞬間」の絵なので、AIの応答にだけ出す（§21） */}
            {props.canSnapshot && m.role === 'assistant' && (
              <button className="prow" onClick={props.onSnapshot}>
                <span className="ic">
                  <Icon.camera size={17} />
                </span>
                <span>この場面を描く</span>
              </button>
            )}
            <button className="prow" onClick={props.onFork}>
              <span className="ic">
                <Icon.fork size={17} />
              </span>
              <span>ここから分岐する</span>
            </button>
            <button className="prow danger" onClick={props.onDelete}>
              <span className="ic">
                <Icon.trash size={17} />
              </span>
              <span>削除する</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- スナップショット（§21） ----

interface SnapshotPreview {
  prompt: string;
  warnings: string[];
  /** 何を参照として送るか。`from` は参照専用の画像かアバターか（§21.4） */
  references: { label: string; from: 'reference' | 'avatar' }[];
  model: string;
  aspect_ratio: string;
  quality: string;
}

const ASPECTS = ['16:9', '4:3', '1:1', '3:4', '9:16'];
const QUALITIES: { value: string; label: string }[] = [
  { value: 'low', label: '低（安い・速い）' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高（高い・遅い）' },
];

/**
 * 生成する前にプロンプトを見せて直せるようにする（§21）。
 * プレビューは組み立てるだけなので課金しない。生成ボタンを押して初めて課金される。
 */
function SnapshotModal(props: {
  message: Message;
  onClose: () => void;
  onDone: () => void;
  toast: (msg: string, error?: boolean) => void;
}) {
  const [preview, setPreview] = useState<SnapshotPreview | null>(null);
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [quality, setQuality] = useState('medium');
  const [useRefs, setUseRefs] = useState(true);
  const [includePersona, setIncludePersona] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 中身に合わせて高さを変える。見出しを入れたぶん既定でも10行前後になり、
   * 固定の高さだと**組み立てた結果の全体が見えないまま直すことになる**。
   * 画面の半分弱で頭打ちにして、モーダルごと画面外へ伸びないようにする。
   */
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.45))}px`;
  }, [prompt]);

  // ペルソナの有無で組み立てが変わるので、切り替えたら引き直す
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setFailed('');
    api
      .post<SnapshotPreview>(
        `/messages/${props.message.id}/snapshot/preview?include_persona=${includePersona ? 1 : 0}`,
      )
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setPrompt(p.prompt);
        setAspect(p.aspect_ratio);
        setQuality(p.quality);
      })
      .catch((err: Error) => {
        if (alive) setFailed(err.message);
      });
    return () => {
      alive = false;
    };
  }, [props.message.id, includePersona]);

  const run = async () => {
    if (!prompt.trim()) {
      props.toast('プロンプトが空です', true);
      return;
    }
    setBusy(true);
    try {
      const meta = await api.post<SnapshotMeta>(`/messages/${props.message.id}/snapshot`, {
        prompt,
        aspect_ratio: aspect,
        quality,
        references: useRefs,
        include_persona: includePersona,
      });
      await makeThumb(meta.id);
      props.toast('スナップショットを作りました');
      props.onDone();
    } catch (err) {
      props.toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="この場面を描く"
      onClose={props.onClose}
      actions={
        <button className="pill sm primary" onClick={() => void run()} disabled={busy || !preview}>
          {busy ? '生成中…' : '生成する'}
        </button>
      }
    >
      {failed && <div className="empty-note">{failed}</div>}
      {!preview && !failed && <div className="empty-note">組み立て中…</div>}
      {preview && (
        <>
          {preview.warnings.map((wmsg, i) => (
            <div key={i} className="empty-note" style={{ padding: '0 0 8px', textAlign: 'left' }}>
              {wmsg}
            </div>
          ))}

          <Field label="プロンプト（送る前に直せます）">
            <textarea
              ref={promptRef}
              className="tall"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>

          <div className="grid-2">
            <Field label="比率">
              <div className="select-wrap">
                <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                  {ASPECTS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label="品質">
              <div className="select-wrap">
                <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                  {QUALITIES.map((q) => (
                    <option key={q.value} value={q.value}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </div>

          <div className="setting">
            <div className="txt">
              <label>参照画像を使う</label>
              <span>
                {preview.references.length
                  ? `${preview.references
                      .map((r) => `${r.label}（${r.from === 'reference' ? '参照画像' : 'アバター'}）`)
                      .join('、')}を渡して見た目を揃えます`
                  : '参照できる画像がありません'}
              </span>
            </div>
            <button
              className={`toggle${useRefs && preview.references.length ? ' on' : ''}`}
              onClick={() => setUseRefs(!useRefs)}
              disabled={preview.references.length === 0}
              role="switch"
              aria-checked={useRefs && preview.references.length > 0}
            >
              <span className="knob" />
            </button>
          </div>

          <div className="setting">
            <div className="txt">
              <label>自分（ペルソナ）も描く</label>
              <span>一人称視点なら不要なことが多いので既定はOFFです</span>
            </div>
            <button
              className={`toggle${includePersona ? ' on' : ''}`}
              onClick={() => setIncludePersona(!includePersona)}
              role="switch"
              aria-checked={includePersona}
            >
              <span className="knob" />
            </button>
          </div>

          <div className="empty-note" style={{ padding: '4px 0 0', textAlign: 'left' }}>
            モデル: {preview.model} ／ 生成すると課金されます
          </div>
        </>
      )}
    </Modal>
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
  varsBlock: string;
  varsEnabled: boolean;
  eventsEnabled: boolean;
  eventRows: EventEvalRow[];
}

const EVENT_OUTCOME: Record<EventEvalRow['outcome'], string> = {
  adopted: '採用',
  condition: '条件不一致',
  check: 'タイミング外',
  trigger: '発火済み',
  chance: '抽選外れ',
  capped: '上限超過',
};

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
        <h3>プロンプトの確認</h3>
        {error && <div className="empty-note">{error}</div>}
        {!data && !error && <div className="empty-note">組み立て中…</div>}
        {data && (
          <>
            <div className="row wrap">
              <span className="tag mute">{modelLabel(data.model)}</span>
              <span className="tag mute">
                {data.estimatedTokens.toLocaleString()} / {data.inputBudget.toLocaleString()} TOK
              </span>
              {data.trimmed.history > 0 && <span className="tag">履歴 −{data.trimmed.history}</span>}
              {data.trimmed.lore > 0 && <span className="tag">ロア −{data.trimmed.lore}</span>}
              {data.trimmed.memories > 0 && (
                <span className="tag">メモリー −{data.trimmed.memories}</span>
              )}
            </div>
            <div className="kicker">現在の状況</div>
            <pre className="pre-block">{data.situationBlock}</pre>
            {data.varsEnabled && data.varsBlock && (
              <>
                <div className="kicker">進行状況</div>
                <pre className="pre-block">{data.varsBlock}</pre>
              </>
            )}
            {data.eventsEnabled && data.eventRows.length > 0 && (
              <>
                <div className="kicker">イベント判定</div>
                <div className="row wrap">
                  {data.eventRows.map((r) => (
                    <span key={r.id} className={`chip${r.outcome === 'adopted' ? ' on' : ''}`}>
                      {r.title}: {EVENT_OUTCOME[r.outcome]}
                    </span>
                  ))}
                </div>
              </>
            )}
            <div className="kicker">
              ロア 発火{data.lore.fired.length} / 採用{data.lore.adopted.length} / 予算超過
              {data.lore.dropped.length}
            </div>
            <div className="row wrap">
              {data.lore.adopted.map((l) => (
                <span key={l.id} className="chip on">
                  {l.title}
                </span>
              ))}
              {data.lore.dropped.map((l) => (
                <span key={l.id} className="chip">
                  {l.title}
                </span>
              ))}
            </div>
            <div className="kicker">system</div>
            <pre className="pre-block">{data.system}</pre>
          </>
        )}
        <div className="acts">
          <button className="pill sm" onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
