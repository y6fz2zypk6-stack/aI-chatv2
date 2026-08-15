import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AlbumItem, AlbumWorld } from '@shared/types';
import { api } from '../api';
import { Modal, Row, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

/**
 * アルバム（§21.8）。世界 → 会話ごとの見出しでスナップショットを並べる。
 *
 * **この画面の目的は容量の整理。** どれを消せばどれだけ空くかが分からないと
 * 判断できないので、枚数とサイズは必ず添える。
 */

/** バイト数を読める単位に。整理の判断に使うので、MB は小数1桁まで出す */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const stamp = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function AlbumPage() {
  const [worlds, setWorlds] = useState<AlbumWorld[]>([]);
  const [open, setOpen] = useState<AlbumWorld | null>(null);
  const toast = useApp((s) => s.toast);

  const load = useCallback(async () => {
    const list = await api.get<AlbumWorld[]>('/albums').catch(() => []);
    setWorlds(list);
    // 開いている世界が空になったら一覧へ戻す（全部消したあと）
    setOpen((cur) => (cur ? (list.find((w) => w.world_id === cur.world_id) ?? null) : null));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (open) {
    return (
      <WorldAlbum
        world={open}
        onBack={() => setOpen(null)}
        onChanged={load}
        toast={toast}
      />
    );
  }

  const total = worlds.reduce((a, w) => a + w.bytes, 0);
  const count = worlds.reduce((a, w) => a + w.count, 0);

  return (
    <>
      <TopBar
        title="アルバム"
        sub={count ? `${count}枚 ・ ${sizeLabel(total)}` : undefined}
        back="/chats"
      />
      <div className="content">
        {worlds.length === 0 && (
          <div className="empty-note">
            まだスナップショットがありません。会話でAIの応答の「⋯」から「この場面を描く」で作れます
          </div>
        )}
        {worlds.map((w) => (
          <Row
            key={w.world_id}
            avatar={<Icon.camera size={18} />}
            avatarTinted
            name={w.world_name}
            desc={`${w.count}枚 ・ ${sizeLabel(w.bytes)}`}
            onClick={() => setOpen(w)}
            chevron
          />
        ))}
      </div>
    </>
  );
}

/** 世界1つ分のグリッド。会話ごとに見出しを付ける */
function WorldAlbum(props: {
  world: AlbumWorld;
  onBack: () => void;
  onChanged: () => Promise<void>;
  toast: (message: string, error?: boolean) => void;
}) {
  const [items, setItems] = useState<AlbumItem[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [full, setFull] = useState<AlbumItem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const list = await api
      .get<AlbumItem[]>(`/worlds/${props.world.world_id}/snapshots`)
      .catch(() => []);
    setItems(list);
    // 消えたものが選択に残らないようにする
    setSelected((cur) => new Set([...cur].filter((id) => list.some((x) => x.id === id))));
  }, [props.world.world_id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 会話ごとにまとめる。並びはAPI側で会話・seq順に揃えてある */
  const groups = useMemo(() => {
    const out: { chatId: string; title: string; items: AlbumItem[] }[] = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (last && last.chatId === it.chat_id) last.items.push(it);
      else out.push({ chatId: it.chat_id, title: it.chat_title || '(無題の会話)', items: [it] });
    }
    return out;
  }, [items]);

  const selectedBytes = items
    .filter((x) => selected.has(x.id))
    .reduce((a, x) => a + x.bytes, 0);

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeSelected = async () => {
    try {
      const r = await api.post<{ deleted: number }>('/snapshots/delete', {
        ids: [...selected],
      });
      props.toast(`${r.deleted}枚を削除しました`);
      setConfirming(false);
      setSelecting(false);
      setSelected(new Set());
      await load();
      await props.onChanged();
    } catch (err) {
      props.toast((err as Error).message, true);
    }
  };

  const removeOne = async (id: string) => {
    try {
      await api.del(`/snapshots/${id}`);
      setFull(null);
      await load();
      await props.onChanged();
    } catch (err) {
      props.toast((err as Error).message, true);
    }
  };

  const bytes = items.reduce((a, x) => a + x.bytes, 0);

  return (
    <>
      <TopBar
        title={props.world.world_name}
        sub={`${items.length}枚 ・ ${sizeLabel(bytes)}`}
        onBack={props.onBack}
        actions={
          <button
            className={`icon-btn${selecting ? ' accent' : ''}`}
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
            title={selecting ? '選択をやめる' : '選んで削除'}
          >
            {selecting ? <Icon.x size={15} /> : <Icon.check size={16} />}
          </button>
        }
      />
      <div className="content">
        {groups.map((g) => {
          const gb = g.items.reduce((a, x) => a + x.bytes, 0);
          return (
            <div key={g.chatId}>
              <div className="album-head">
                <span className="t">{g.title}</span>
                <span className="n">
                  {g.items.length}枚 ・ {sizeLabel(gb)}
                </span>
              </div>
              <div className="album-grid">
                {g.items.map((it) => {
                  const sel = selected.has(it.id);
                  return (
                    <button
                      key={it.id}
                      className={`album-cell${sel ? ' sel' : ''}`}
                      onClick={() => (selecting ? toggle(it.id) : setFull(it))}
                    >
                      {/* 1枚が数百KB〜数MBあるので、近づいたものだけ読む */}
                      <img
                        src={`/api/snapshots/${it.id}/image`}
                        alt={`${g.title} のスナップショット`}
                        loading="lazy"
                      />
                      {selecting && (
                        <span className="mark">{sel && <Icon.check size={13} />}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {!selecting && (
                <div style={{ padding: '8px 2px 2px' }}>
                  <button
                    className="pill sm"
                    onClick={() => navigate(`/chats/${g.chatId}`)}
                  >
                    <Icon.bubble size={13} />
                    会話を開く
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {items.length === 0 && <div className="empty-note">この世界には画像がありません</div>}

        {selecting && (
          <div className="album-bar">
            <span className="n">
              {selected.size}枚 ・ {sizeLabel(selectedBytes)}
            </span>
            <button
              className="pill sm danger"
              disabled={selected.size === 0}
              onClick={() => setConfirming(true)}
            >
              <Icon.trash size={14} />
              選んだ画像を削除
            </button>
          </div>
        )}
      </div>

      {full && (
        <Modal
          title={full.chat_title || '(無題の会話)'}
          onClose={() => setFull(null)}
          actions={
            <button className="pill sm danger" onClick={() => void removeOne(full.id)}>
              削除
            </button>
          }
        >
          <div className="album-full">
            <img src={`/api/snapshots/${full.id}/image`} alt="スナップショット" />
            <div className="meta">
              {stamp(full.created_at)} ・ {sizeLabel(full.bytes)} ・ {full.model}
              {'\n\n'}
              {full.prompt}
            </div>
          </div>
        </Modal>
      )}

      {confirming && (
        <Modal
          title={`${selected.size}枚を削除しますか？`}
          onClose={() => setConfirming(false)}
          actions={
            <button className="pill sm danger" onClick={() => void removeSelected()}>
              削除
            </button>
          }
        >
          <div className="empty-note" style={{ padding: 0, textAlign: 'left' }}>
            {sizeLabel(selectedBytes)}ぶん空きます。会話画面からも消えます。元に戻せません
          </div>
        </Modal>
      )}
    </>
  );
}
