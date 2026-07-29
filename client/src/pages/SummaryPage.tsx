import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Summary } from '@shared/types';
import { api } from '../api';
import { TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

export default function SummaryPage() {
  const { id } = useParams<{ id: string }>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api
      .get<Summary | null>(`/chats/${id}/summary`)
      .then((s) => {
        setSummary(s);
        setContent(s?.content ?? '');
      })
      .catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  const save = async () => {
    try {
      await api.put(`/chats/${id}/summary`, { content });
      toast('あらすじを保存しました');
      load();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ content: string | null }>(`/chats/${id}/summarize`);
      toast(r.content ? '要約を実行しました' : '要約対象がありません');
      load();
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    if (!confirm('あらすじを全て削除しますか？')) return;
    await api.del(`/chats/${id}/summary`);
    load();
  };

  return (
    <>
      <TopBar
        title="あらすじ"
        back={`/chats/${id}`}
        actions={
          <button className="icon-btn accent" onClick={runNow} disabled={busy} title="今すぐ要約">
            <Icon.refresh size={18} />
          </button>
        }
      />
      <div className="content form">
        <textarea
          className="tall"
          style={{ minHeight: '46dvh' }}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="まだあらすじがありません。会話が進むと自動で要約されます"
        />
        {summary && (
          <div className="empty-note" style={{ padding: 0 }}>
            最終更新: {new Date(summary.created_at).toLocaleString('ja-JP')}
          </div>
        )}
      </div>
      <div className="footbar">
        <button className="pill danger" onClick={removeAll}>
          <Icon.trash />
          削除
        </button>
        <button className="pill primary grow" onClick={save} disabled={busy}>
          <Icon.check />
          {busy ? '要約中…' : '保存'}
        </button>
      </div>
    </>
  );
}
