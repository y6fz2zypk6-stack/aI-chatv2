import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Character } from '@shared/types';
import { api } from '../api';
import { AvatarPicker, Field, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

type CharacterDetail = Character & { memory_count: number };

export default function CharacterPage() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<CharacterDetail | null>(null);
  const [aliasText, setAliasText] = useState('');
  const navigate = useNavigate();
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

  if (!c) return <div className="empty-note">読み込み中…</div>;

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

  const remove = async () => {
    if (!confirm(`「${c.name}」を削除しますか？メモリーも削除されます`)) return;
    try {
      await api.del(`/characters/${c.id}`);
      navigate(`/worlds/${c.world_id}`);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <>
      <TopBar
        title="キャラクター編集"
        back={`/worlds/${c.world_id}`}
        actions={
          <>
            <button
              className="icon-btn accent"
              onClick={() => navigate(`/characters/${c.id}/memories`)}
              title={`メモリー（${c.memory_count}）`}
            >
              <Icon.brain />
            </button>
            <a className="icon-btn accent" href={`/api/characters/${c.id}/export`} download title="V2書き出し">
              <Icon.download />
            </a>
          </>
        }
      />
      <div className="content form">
        <div className="id-row">
          <AvatarPicker
            value={c.avatar}
            name={c.name}
            onChange={(avatar) => setC({ ...c, avatar })}
          />
          <input
            className="id-name"
            value={c.name}
            onChange={(e) => setC({ ...c, name: e.target.value })}
            placeholder="名前"
          />
        </div>

        <Field label="アイコン（絵文字・画像URL。上の枠から画像も選べます）">
          <input
            value={c.avatar.startsWith('data:') ? '' : c.avatar}
            onChange={(e) => setC({ ...c, avatar: e.target.value })}
            placeholder={c.avatar.startsWith('data:') ? '画像を設定済み' : '🕯 または https://…'}
          />
        </Field>

        <Field label="別名（読点・カンマ区切り。話者パースと名寄せに使います）">
          <input
            value={aliasText}
            onChange={(e) => setAliasText(e.target.value)}
            placeholder="マーゴット、ケイン"
          />
        </Field>

        <Field label="ペルソナ（性格・背景）">
          <textarea
            className="tall"
            value={c.persona}
            onChange={(e) => setC({ ...c, persona: e.target.value })}
          />
        </Field>

        <Field label="話し方・口調">
          <textarea
            value={c.speech_style}
            onChange={(e) => setC({ ...c, speech_style: e.target.value })}
            placeholder="丁寧語。感情が動くと語尾が短くなる"
          />
        </Field>

        <Field label="口調例（応答と同じ「話者名: 」の形で書くと真似やすくなります）">
          <textarea
            value={c.example_dialogue}
            onChange={(e) => setC({ ...c, example_dialogue: e.target.value })}
            placeholder={`${c.name}: 本を閉じ、薄紫の瞳が入口へ向く。\n「おや。……濡れましたね」`}
          />
        </Field>

        {/* イベント条件（present_has など）やメモリーの対象指定はIDで書くので、
            チャットのプロンプト確認まで行かなくても拾えるようにする */}
        <Field label="キャラクターID（イベント条件などで使います。タップでコピー）">
          <button
            className="id-copy"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(c.id);
                toast('IDをコピーしました');
              } catch {
                toast('コピーできませんでした。長押しで選択してください', true);
              }
            }}
          >
            <span className="mono">{c.id}</span>
            <Icon.copy size={15} />
          </button>
        </Field>

        <div className="setting">
          <div className="txt">
            <label>準レギュラー</label>
            <span>毎回は同席しないが、関連ロアが発火したターンだけ定義を注入する</span>
          </div>
          <button
            className={`toggle${c.is_npc_pool === 1 ? ' on' : ''}`}
            onClick={() => setC({ ...c, is_npc_pool: c.is_npc_pool ? 0 : 1 })}
            role="switch"
            aria-checked={c.is_npc_pool === 1}
          >
            <span className="knob" />
          </button>
        </div>
      </div>

      <div className="footbar">
        <button className="pill danger" onClick={remove}>
          <Icon.trash />
          削除
        </button>
        <button className="pill primary grow" onClick={save}>
          <Icon.check />
          保存
        </button>
      </div>
    </>
  );
}
