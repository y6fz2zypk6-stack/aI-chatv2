import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Character, Location, LoreCategory, LorebookEntry } from '@shared/types';
import { api } from '../api';
import { Field, Modal, Row, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

const CATEGORIES: LoreCategory[] = ['世界観', '用語', '人物', '場所', 'イベント', 'その他'];
const SEASONS = ['春', '夏', '秋', '冬'];

export default function LorebookPage() {
  const { id } = useParams<{ id: string }>();
  const [entries, setEntries] = useState<LorebookEntry[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<LorebookEntry | null>(null);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState<LoreCategory | ''>('');
  const toast = useApp((s) => s.toast);

  const load = useCallback(() => {
    if (!id) return;
    api.get<LorebookEntry[]>(`/worlds/${id}/lorebook`).then(setEntries).catch(() => {});
    api.get<Character[]>(`/worlds/${id}/characters`).then(setCharacters).catch(() => {});
    api.get<Location[]>(`/worlds/${id}/locations`).then(setLocations).catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  const add = async () => {
    const e = await api.post<LorebookEntry>(`/worlds/${id}/lorebook`, { title: '新しいエントリ' });
    load();
    setEditing(e);
  };

  const importJson = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        // V2カード全体が渡された場合は character_book を取り出す
        const payload = json?.data?.character_book ?? json?.character_book ?? json;
        const r = await api.post<{ imported: number }>(`/worlds/${id}/lorebook/import`, payload);
        toast(`${r.imported}件取り込みました`);
        load();
      } catch (err) {
        toast((err as Error).message, true);
      }
    };
    input.click();
  };

  const remove = async (e: LorebookEntry) => {
    if (!confirm(`「${e.title}」を削除しますか？`)) return;
    await api.del(`/lorebook/${e.id}`);
    setEditing(null);
    load();
  };

  const filtered = entries.filter(
    (e) =>
      (!category || e.category === category) &&
      (!filter ||
        e.title.includes(filter) ||
        e.content.includes(filter) ||
        e.keys.some((k) => k.includes(filter))),
  );

  const countOf = (c: LoreCategory) => entries.filter((e) => e.category === c).length;

  return (
    <>
      <TopBar
        title="ロアブック"
        back={`/worlds/${id}`}
        actions={
          <>
            <button className="icon-btn accent" onClick={importJson} title="取り込み">
              <Icon.upload />
            </button>
            <a className="icon-btn accent" href={`/api/worlds/${id}/lorebook/export`} download title="書き出し">
              <Icon.download />
            </a>
          </>
        }
      />
      <div className="content">
        <div className="field" style={{ marginBottom: 10 }}>
          <input placeholder="検索" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {/* カテゴリフィルター */}
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <span
            className={`chip${category === '' ? ' on' : ''}`}
            onClick={() => setCategory('')}
          >
            すべて {entries.length}
          </span>
          {CATEGORIES.map((c) => (
            <span
              key={c}
              className={`chip${category === c ? ' on' : ''}`}
              onClick={() => setCategory(category === c ? '' : c)}
            >
              {c} {countOf(c)}
            </span>
          ))}
        </div>
        {filtered.map((e) => (
          <Row
            key={e.id}
            name={
              <>
                {e.title} {e.always === 1 && <span className="tag">常時</span>}
                {e.enabled === 0 && <span className="tag mute">OFF</span>}
              </>
            }
            desc={
              <>
                {e.keys.length > 0 && `${e.keys.join(' / ')}　`}
                {e.trigger_locations.length > 0 && `場所:${e.trigger_locations.length}　`}
                {e.trigger_seasons.length > 0 && `${e.trigger_seasons.join(',')}　`}
                {e.category}・優先度{e.priority}
              </>
            }
            onClick={() => setEditing({ ...e })}
            chevron
          />
        ))}
        <div className="chatrow add tappable" onClick={add}>
          <span className="av">
            <Icon.plus size={19} />
          </span>
          <div className="body">
            <span className="nm">エントリを追加</span>
          </div>
        </div>
        {filtered.length === 0 && entries.length > 0 && (
          <div className="empty-note">一致するエントリがありません</div>
        )}
      </div>

      {editing && (
        <EntryEditor
          entry={editing}
          characters={characters}
          locations={locations}
          onClose={() => setEditing(null)}
          onRemove={() => void remove(editing)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function EntryEditor(props: {
  entry: LorebookEntry;
  characters: Character[];
  locations: Location[];
  onClose: () => void;
  onRemove: () => void;
  onSaved: () => void;
}) {
  const [e, setE] = useState(props.entry);
  const [keysText, setKeysText] = useState(props.entry.keys.join('、'));
  const toast = useApp((s) => s.toast);

  const toggleIn = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const save = async () => {
    const keys = keysText
      .split(/[,、，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await api.put(`/lorebook/${e.id}`, { ...e, keys });
      toast('保存しました');
      props.onSaved();
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <Modal
      title="ロアエントリ"
      onClose={props.onClose}
      actions={
        <>
          <button className="pill sm danger" onClick={props.onRemove}>
            削除
          </button>
          <button className="pill sm primary" onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="タイトル">
          <input value={e.title} onChange={(ev) => setE({ ...e, title: ev.target.value })} />
        </Field>
        <Field label="カテゴリ">
          <div className="select-wrap">
            <select
              value={e.category}
              onChange={(ev) => setE({ ...e, category: ev.target.value as LoreCategory })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </Field>
      </div>
      <Field label="発火キーワード（読点・カンマ区切り）">
        <input
          value={keysText}
          onChange={(ev) => setKeysText(ev.target.value)}
          placeholder="港、港祭り、ハーバー"
        />
      </Field>
      <Field label="注入本文">
        <textarea
          className="tall"
          value={e.content}
          onChange={(ev) => setE({ ...e, content: ev.target.value })}
        />
      </Field>
      <div className="grid-2">
        <Field label="優先度（大きいほど優先）">
          <input
            type="number"
            value={e.priority}
            onChange={(ev) => setE({ ...e, priority: parseInt(ev.target.value, 10) || 0 })}
          />
        </Field>
        <Field label="対象キャラ（指定時はそのキャラ参加時のみ）">
          <div className="select-wrap">
            <select
              value={e.character_id ?? ''}
              onChange={(ev) => setE({ ...e, character_id: ev.target.value || null })}
            >
              <option value="">（共通）</option>
              {props.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </Field>
      </div>
      <Field label="場所トリガー（現在地が一致で発火）">
        <div className="row wrap">
          {props.locations.map((l) => (
            <span
              key={l.id}
              className={`chip${e.trigger_locations.includes(l.id) ? ' on' : ''}`}
              onClick={() => setE({ ...e, trigger_locations: toggleIn(e.trigger_locations, l.id) })}
            >
              {l.name}
            </span>
          ))}
        </div>
      </Field>
      <Field label="季節トリガー">
        <div className="row wrap">
          {SEASONS.map((sn) => (
            <span
              key={sn}
              className={`chip${e.trigger_seasons.includes(sn) ? ' on' : ''}`}
              onClick={() => setE({ ...e, trigger_seasons: toggleIn(e.trigger_seasons, sn) })}
            >
              {sn}
            </span>
          ))}
        </div>
      </Field>
      <div className="setting">
        <div className="txt">
          <label>常時注入</label>
          <span>キーワードに関係なく毎ターン載せる</span>
        </div>
        <button
          className={`toggle${e.always === 1 ? ' on' : ''}`}
          onClick={() => setE({ ...e, always: e.always ? 0 : 1 })}
          role="switch"
          aria-checked={e.always === 1}
        >
          <span className="knob" />
        </button>
      </div>
      <div className="setting">
        <div className="txt">
          <label>有効</label>
        </div>
        <button
          className={`toggle${e.enabled === 1 ? ' on' : ''}`}
          onClick={() => setE({ ...e, enabled: e.enabled ? 0 : 1 })}
          role="switch"
          aria-checked={e.enabled === 1}
        >
          <span className="knob" />
        </button>
      </div>
    </Modal>
  );
}
