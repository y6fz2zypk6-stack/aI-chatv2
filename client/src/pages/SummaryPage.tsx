import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Summary } from '@shared/types';
import { api } from '../api';
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
    <main className="page">
      <h1 className="page-title">
        📜 あらすじ
        <span className="spacer" />
        <button className="btn small" onClick={runNow} disabled={busy}>
          {busy ? '要約中…' : '今すぐ要約'}
        </button>
        <button className="btn danger small" onClick={removeAll}>
          削除
        </button>
      </h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to={`/chats/${id}`}>← チャットに戻る</Link>
      </div>
      <div className="card">
        <textarea
          className="textarea"
          rows={12}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="まだあらすじがありません。会話が進むと自動で要約されます"
        />
        {summary && (
          <div className="card-sub" style={{ marginTop: 6 }}>
            最終更新: {new Date(summary.created_at).toLocaleString('ja-JP')}
          </div>
        )}
        <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </main>
  );
}
