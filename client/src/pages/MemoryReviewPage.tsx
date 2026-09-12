import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { MemoryReviewStats, PlanResult, PlanRow } from '@shared/types';
import { api } from '../api';
import { Field, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

interface Review {
  world: { id: string; name: string };
  memories: { id: string }[];
  stats: MemoryReviewStats;
}

const OP_LABEL: Record<PlanRow['op'], string> = {
  disable: '注入オフ',
  enable: '注入オン',
  delete: '削除',
  update: '書き換え',
  create: '追加',
};

/**
 * メモリーの棚卸し（§10.4）。
 * 書き出し → Claude に整理案を作らせる → 貼って確認 → 適用、の往復をここで閉じる。
 */
export default function MemoryReviewPage() {
  const { id } = useParams<{ id: string }>();
  const [review, setReview] = useState<Review | null>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<PlanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api
      .get<Review>(`/worlds/${id}/memories/review`)
      .then(setReview)
      .catch((err) => toast((err as Error).message, true));
  }, [id, toast]);

  useEffect(load, [load]);

  /** 貼り付け欄が空でもファイルから読めるようにする（LorebookPage と同じ作り） */
  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      setText(await f.text());
      setResult(null);
    };
    input.click();
  };

  const send = async (path: 'preview' | 'apply') => {
    let plan: unknown;
    try {
      plan = JSON.parse(text);
    } catch {
      toast('整理案がJSONとして読めません', true);
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<PlanResult>(`/worlds/${id}/memory-plan/${path}`, plan);
      setResult(r);
      if (path === 'apply') {
        toast(
          `メモリー${r.applied?.memories ?? 0}件・ロア${r.applied?.lorebook ?? 0}件に反映しました`,
        );
        setText('');
        load();
      }
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  if (!review) return null;
  const s = review.stats;

  return (
    <>
      <TopBar
        title="メモリーの整理"
        sub={review.world.name}
        back={`/worlds/${id}`}
        actions={
          <a
            className="icon-btn accent"
            href={`/api/worlds/${id}/memories/export`}
            download
            title="書き出し"
          >
            <Icon.download />
          </a>
        }
      />
      <div className="content">
        <div className="section">
          <div className="head">
            <span className="kicker">いまの状態</span>
          </div>
          <div className="stat-grid">
            <div className="stat">
              <b>{s.total}</b>
              <span>記憶の総数</span>
            </div>
            <div className="stat">
              <b>{s.enabled}</b>
              <span>注入オン</span>
            </div>
            <div className="stat">
              <b>{s.disabled}</b>
              <span>注入オフ</span>
            </div>
            <div className="stat">
              <b>{s.chars.toLocaleString()}</b>
              <span>注入される文字数</span>
            </div>
          </div>
          {s.orphan_subject > 0 && (
            <div className="warn-list">
              <div>
                対象タグが解決できない記憶が {s.orphan_subject} 件あります。保存されていますが
                <b>一度も注入されません</b>。整理の候補です
              </div>
            </div>
          )}
          <div className="empty-note" style={{ textAlign: 'left', padding: '10px 0 0' }}>
            メモリーには専用の予算がなく、削られる順番も最後です。増えると先に短くなるのは
            <b>会話の履歴</b>のほうなので、注入される文字数を減らすのが効きます。
          </div>
        </div>

        <div className="section">
          <div className="head">
            <span className="kicker">整理案</span>
            <div className="row">
              <button className="pill sm" onClick={pickFile}>
                <Icon.upload size={14} />
                ファイル
              </button>
            </div>
          </div>
          <div className="empty-note" style={{ textAlign: 'left', paddingTop: 0 }}>
            右上のボタンで書き出したJSONをAIに読ませ、返ってきた整理案をここに貼ってください。
            書き出したJSONには整理案の書き方も入っています。
          </div>
          <Field label="整理案のJSON">
            <textarea
              className="tall mono"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setResult(null);
              }}
              placeholder='{"format": "character_chat_memory_plan", "memories": {"disable": ["…"]}}'
            />
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <button className="pill grow" disabled={!text.trim() || busy} onClick={() => void send('preview')}>
              確認する
            </button>
            <button
              className="pill primary grow"
              disabled={!result || busy}
              onClick={() => void send('apply')}
            >
              適用する
            </button>
          </div>
          {!result && text.trim() && (
            <div className="empty-note" style={{ textAlign: 'left' }}>
              先に「確認する」で中身を見てください。
            </div>
          )}
        </div>

        {result && (
          <div className="section">
            <div className="head">
              <span className="kicker">
                {result.applied ? '適用しました' : 'この整理案で起きること'}
              </span>
            </div>
            {result.warnings.length > 0 && (
              <div className="warn-list" style={{ marginBottom: 10 }}>
                {result.warnings.map((wn, i) => (
                  <div key={i}>{wn}</div>
                ))}
              </div>
            )}
            <div className="row wrap" style={{ padding: '0 0 8px' }}>
              <span className="tag">記憶 {result.stats.before.enabled} → {result.stats.after.enabled}</span>
              <span className="tag on">
                文字数 {result.stats.before.chars.toLocaleString()} →{' '}
                {result.stats.after.chars.toLocaleString()}
              </span>
            </div>
            {result.rows.map((r, i) => (
              <div key={i} className={`planrow op-${r.op}`}>
                <div className="row">
                  <span className="tag">{OP_LABEL[r.op]}</span>
                  <span className="tag mute">{r.kind === 'lore' ? 'ロア' : r.character_name}</span>
                  {r.note && <span className="tag mute">{r.note}</span>}
                </div>
                {r.title && <b>{r.title}</b>}
                <p>{r.content}</p>
              </div>
            ))}
            {result.rows.length === 0 && <div className="empty-note">変更はありません</div>}
          </div>
        )}
      </div>
    </>
  );
}
