import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Diary, DiaryIndex } from '@shared/types';
import { api } from '../api';
import { Avatar, Modal, Segmented, TopBar } from '../components';
import { formatDateTime } from '../format';
import { Icon } from '../icons';
import { ask, useApp } from '../store';

type Length = 'short' | 'normal' | 'long';

/**
 * キャラクターの日記（§22）。
 * **読み物であって記憶ではない。** ここで書いた日記は本文生成のプロンプトに載らない。
 * 1日の区切りは暦の「1日の区切り時刻」（天候の引き直しと同じ境界）
 */
export default function DiaryPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useApp((s) => s.toast);
  const [index, setIndex] = useState<DiaryIndex | null>(null);
  const [charId, setCharId] = useState<string>('');
  const [length, setLength] = useState<Length>('normal');
  const [busyDay, setBusyDay] = useState<number | null>(null);
  const [editing, setEditing] = useState<Diary | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    if (!id) return;
    api
      .get<DiaryIndex>(`/chats/${id}/diary`)
      .then((d) => {
        setIndex(d);
        // 最初は「いちばん最近の日に居合わせた最初の人」を選んでおく
        setCharId((cur) => cur || d.days[0]?.character_ids[0] || d.characters[0]?.id || '');
      })
      .catch((err) => toast((err as Error).message, true));
  }, [id, toast]);

  useEffect(load, [load]);

  const character = index?.characters.find((c) => c.id === charId);
  const days = useMemo(
    () => (index?.days ?? []).filter((d) => d.character_ids.includes(charId)),
    [index, charId],
  );
  const entryOf = (day: number) => index?.entries.find((e) => e.character_id === charId && e.day === day);

  const write = async (day: number, rewrite: boolean) => {
    if (
      rewrite &&
      !(await ask({ title: '日記を書き直してもらいますか？', body: '今の日記は上書きされます。', okLabel: '書き直す' }))
    )
      return;
    setBusyDay(day);
    try {
      await api.post<Diary>(`/chats/${id}/diary`, { character_id: charId, day, length });
      load();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusyDay(null);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api.put(`/diaries/${editing.id}`, { content: draft });
      setEditing(null);
      load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const remove = async (d: Diary) => {
    if (!(await ask({ title: 'この日記を削除しますか？', body: '元に戻せません。', okLabel: '削除する', danger: true })))
      return;
    await api.del(`/diaries/${d.id}`);
    load();
  };

  return (
    <>
      <TopBar title="日記" sub={character?.name} back={`/chats/${id}`} />
      <div className="content diary">
        {index && index.characters.length === 0 && (
          <div className="empty-note">
            まだ日記を書ける日がありません。
            <br />
            キャラクターが居合わせた場面が進むと、その日の日記を書いてもらえます。
          </div>
        )}

        {index && index.characters.length > 0 && (
          <>
            <div className="diary-people" role="tablist" aria-label="日記を書く人">
              {index.characters.map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={c.id === charId}
                  className={`diary-person${c.id === charId ? ' on' : ''}`}
                  onClick={() => setCharId(c.id)}
                >
                  <Avatar value={c.avatar} name={c.name} className="av" />
                  <span>{c.name}</span>
                </button>
              ))}
            </div>

            <div className="diary-length">
              <span>新しく書くときの長さ</span>
              <Segmented<Length>
                label="日記の長さ"
                value={length}
                onChange={setLength}
                options={[
                  { value: 'short', label: '短め' },
                  { value: 'normal', label: 'ふつう' },
                  { value: 'long', label: '長め' },
                ]}
              />
            </div>

            {days.length === 0 && (
              <div className="empty-note">{character?.name}が居合わせた日はまだありません。</div>
            )}

            {days.map((d) => {
              const entry = entryOf(d.day);
              const busy = busyDay === d.day;
              return (
                <article key={d.day} className={`diary-day${entry ? ' written' : ''}`}>
                  <header>
                    <b>{d.date_label}</b>
                    <span className="meta">{d.message_count}件の場面</span>
                  </header>
                  {entry ? (
                    <>
                      <div className="diary-paper">{entry.content}</div>
                      <div className="diary-acts">
                        <span className="meta">{formatDateTime(entry.updated_at)}</span>
                        <span className="spacer" />
                        <button className="icon-btn" title="編集" aria-label="編集" onClick={() => {
                          setEditing(entry);
                          setDraft(entry.content);
                        }}>
                          <Icon.pencil size={17} />
                        </button>
                        <button className="icon-btn" title="書き直してもらう" aria-label="書き直してもらう"
                          disabled={busy} onClick={() => write(d.day, true)}>
                          <Icon.refresh size={17} />
                        </button>
                        <button className="icon-btn" title="削除" aria-label="削除" onClick={() => remove(entry)}>
                          <Icon.trash size={17} />
                        </button>
                      </div>
                      {busy && <div className="diary-busy">書き直しています…</div>}
                    </>
                  ) : (
                    <button className="pill primary diary-write" disabled={busyDay !== null} onClick={() => write(d.day, false)}>
                      <Icon.bookOpen size={17} />
                      {busy ? `${character?.name}が書いています…` : 'この日の日記を書いてもらう'}
                    </button>
                  )}
                </article>
              );
            })}
          </>
        )}
      </div>

      {editing && (
        <Modal
          title={`${editing.date_label} の日記`}
          onClose={() => setEditing(null)}
          actions={
            <button className="pill sm primary" onClick={saveEdit}>
              保存
            </button>
          }
        >
          <textarea className="tall" style={{ minHeight: '40dvh' }} value={draft} onChange={(e) => setDraft(e.target.value)} />
        </Modal>
      )}
    </>
  );
}
