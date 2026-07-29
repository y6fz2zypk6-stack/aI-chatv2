import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Character } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

type CharacterDetail = Character & { memory_count: number };

export default function CharacterPage() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<CharacterDetail | null>(null);
  const [aliasText, setAliasText] = useState('');
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    if (!id) return;
    api
      .get<CharacterDetail>(`/characters/${id}`)
      .then((data) => {
        setC(data);
        setAliasText(data.aliases.join('、'));
      })
      .catch(() => {});
  }, [id]);

  if (!c) return <main className="page">読み込み中…</main>;

  const save = async () => {
    const aliases = aliasText
      .split(/[,、，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await api.put(`/characters/${c.id}`, { ...c, aliases });
      toast('保存しました');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <main className="page">
      <h1 className="page-title">
        {c.avatar || '👤'} {c.name}
        <span className="spacer" />
        <a className="btn small" href={`/api/characters/${c.id}/export`} download>
          ⤓ V2書き出し
        </a>
        <Link className="btn small" to={`/characters/${c.id}/memories`}>
          🧠 メモリー({c.memory_count})
        </Link>
      </h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to={`/worlds/${c.world_id}`}>← 世界に戻る</Link>
      </div>

      <div className="card">
        <div className="grid-2">
          <div className="field">
            <label>名前</label>
            <input
              className="input"
              value={c.name}
              onChange={(e) => setC({ ...c, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label>アイコン（絵文字）</label>
            <input
              className="input"
              value={c.avatar}
              onChange={(e) => setC({ ...c, avatar: e.target.value })}
              placeholder="🦉"
            />
          </div>
        </div>
        <div className="field">
          <label>別名（読点・カンマ区切り。話者パースと名寄せに使います）</label>
          <input
            className="input"
            value={aliasText}
            onChange={(e) => setAliasText(e.target.value)}
            placeholder="マーゴット、ケイン"
          />
        </div>
        <div className="field">
          <label>人格・設定（プロンプト本体）</label>
          <textarea
            className="textarea"
            rows={8}
            value={c.persona}
            onChange={(e) => setC({ ...c, persona: e.target.value })}
          />
        </div>
        <div className="field">
          <label>話し方・口調</label>
          <textarea
            className="textarea"
            value={c.speech_style}
            onChange={(e) => setC({ ...c, speech_style: e.target.value })}
          />
        </div>
        <div className="field">
          <label>口調例</label>
          <textarea
            className="textarea"
            value={c.example_dialogue}
            onChange={(e) => setC({ ...c, example_dialogue: e.target.value })}
          />
        </div>
        <label className="checkbox-row" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={c.is_npc_pool === 1}
            onChange={(e) => setC({ ...c, is_npc_pool: e.target.checked ? 1 : 0 })}
          />
          準レギュラー（毎回は同席しないが、関連ロア発火時に定義を注入）
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </main>
  );
}
