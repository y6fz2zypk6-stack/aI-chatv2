import { useCallback, useEffect, useState } from 'react';
import type { Persona } from '@shared/types';
import { api } from '../api';
import { Avatar, AvatarPicker, Field, Row, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [editing, setEditing] = useState<Persona | null>(null);
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => {});
  }, []);

  useEffect(load, [load]);

  const create = async () => {
    const p = await api.post<Persona>('/personas', {
      name: '新しいペルソナ',
      is_default: personas.length === 0 ? 1 : 0,
    });
    load();
    setEditing(p);
  };

  const save = async () => {
    if (!editing) return;
    try {
      await api.put(`/personas/${editing.id}`, editing);
      setEditing(null);
      load();
      toast('保存しました');
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  const remove = async (p: Persona) => {
    if (!confirm(`「${p.name}」を削除しますか？`)) return;
    await api.del(`/personas/${p.id}`);
    setEditing(null);
    load();
  };

  if (editing) {
    return (
      <>
        <TopBar title="ペルソナ編集" back="/personas" />
        <div className="content form">
          <div className="id-row">
            <AvatarPicker
              value={editing.avatar}
              name={editing.name}
              onChange={(avatar) => setEditing({ ...editing, avatar })}
            />
            <input
              className="id-name"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="名前"
            />
          </div>

          <Field label="アイコン（絵文字・画像URL。上の枠から画像も選べます）">
            <input
              value={editing.avatar.startsWith('data:') ? '' : editing.avatar}
              onChange={(e) => setEditing({ ...editing, avatar: e.target.value })}
              placeholder={editing.avatar.startsWith('data:') ? '画像を設定済み' : '🙂 または https://…'}
            />
          </Field>

          <Field label="説明（プロンプトに入ります）">
            <textarea
              className="tall"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </Field>

          <div className="setting">
            <div className="txt">
              <label>既定のペルソナ</label>
              <span>新しい会話で最初に選ばれる</span>
            </div>
            <button
              className={`toggle${editing.is_default === 1 ? ' on' : ''}`}
              onClick={() => setEditing({ ...editing, is_default: editing.is_default ? 0 : 1 })}
              role="switch"
              aria-checked={editing.is_default === 1}
            >
              <span className="knob" />
            </button>
          </div>
        </div>
        <div className="footbar">
          <button className="pill danger" onClick={() => remove(editing)}>
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

  return (
    <>
      <TopBar title="ペルソナ" back="/chats" />
      <div className="content">
        {personas.map((p) => (
          <Row
            key={p.id}
            avatar={<Avatar value={p.avatar} name={p.name} />}
            avatarTinted={!p.avatar}
            name={
              <>
                {p.name} {p.is_default === 1 && <span className="tag">DEFAULT</span>}
              </>
            }
            desc={p.description}
            onClick={() => setEditing({ ...p })}
            chevron
          />
        ))}
        <div className="chatrow add tappable" onClick={create}>
          <span className="av">
            <Icon.plus size={20} />
          </span>
          <div className="body">
            <span className="nm">ペルソナを追加</span>
          </div>
        </div>
        {personas.length === 0 && (
          <div className="empty-note">あなたの分身となるペルソナを作成してください</div>
        )}
      </div>
    </>
  );
}
