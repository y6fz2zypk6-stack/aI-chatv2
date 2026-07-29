import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Character, Location, LoreCategory, LorebookEntry } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

const CATEGORIES: LoreCategory[] = ['世界観', '人物', '用語', 'イベント', 'その他'];
const SEASONS = ['春', '夏', '秋', '冬'];

export default function LorebookPage() {
  const { id } = useParams<{ id: string }>();
  const [entries, setEntries] = useState<LorebookEntry[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<LorebookEntry | null>(null);
  const [filter, setFilter] = useState('');
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

  const exportJson = () => {
    window.open(`/api/worlds/${id}/lorebook/export`, '_blank');
  };

  const remove = async (e: LorebookEntry) => {
    if (!confirm(`「${e.title}」を削除しますか？`)) return;
    await api.del(`/lorebook/${e.id}`);
    load();
  };

  const toggleEnabled = async (e: LorebookEntry) => {
    await api.put(`/lorebook/${e.id}`, { enabled: e.enabled ? 0 : 1 });
    load();
  };

  const filtered = entries.filter(
    (e) =>
      !filter ||
      e.title.includes(filter) ||
      e.content.includes(filter) ||
      e.keys.some((k) => k.includes(filter)),
  );

  return (
    <main className="page">
      <h1 className="page-title">
        📖 ロアブック
        <span className="spacer" />
        <button className="btn small" onClick={exportJson}>
          書出
        </button>
        <button className="btn small" onClick={importJson}>
          取込
        </button>
        <button className="btn primary small" onClick={add}>
          ＋ 追加
        </button>
      </h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to={`/worlds/${id}`}>← 世界に戻る</Link>
        <span className="spacer" />
        <input
          className="input"
          style={{ maxWidth: 200 }}
          placeholder="検索"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {filtered.map((e) => (
        <div key={e.id} className="card">
          <div className="row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="card-title">
                {e.title}
                <span className="chip" style={{ marginLeft: 6 }}>
                  {e.category}
                </span>
                {e.always === 1 && <span className="chip on"> 常時</span>}
                {e.enabled === 0 && <span className="chip"> 無効</span>}
              </div>
              <div className="card-sub">
                {e.keys.length > 0 && `🔑 ${e.keys.join(' / ')}`}
                {e.trigger_locations.length > 0 && ` 📍${e.trigger_locations.join(',')}`}
                {e.trigger_seasons.length > 0 && ` 🍂${e.trigger_seasons.join(',')}`}
                {e.character_id &&
                  ` 👤${characters.find((c) => c.id === e.character_id)?.name ?? e.character_id}`}
                {` ／ 優先度${e.priority}`}
              </div>
            </div>
            <button className="btn ghost small" onClick={() => toggleEnabled(e)}>
              {e.enabled ? 'ON' : 'OFF'}
            </button>
            <button className="btn small" onClick={() => setEditing({ ...e })}>
              編集
            </button>
            <button className="btn danger small" onClick={() => remove(e)}>
              削除
            </button>
          </div>
        </div>
      ))}
      {filtered.length === 0 && <div className="empty-note">エントリがありません</div>}

      {editing && (
        <EntryEditor
          entry={editing}
          characters={characters}
          locations={locations}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </main>
  );
}

function EntryEditor(props: {
  entry: LorebookEntry;
  characters: Character[];
  locations: Location[];
  onClose: () => void;
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
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <h3>ロアエントリを編集</h3>
        <div className="grid-2">
          <div className="field">
            <label>タイトル</label>
            <input
              className="input"
              value={e.title}
              onChange={(ev) => setE({ ...e, title: ev.target.value })}
            />
          </div>
          <div className="field">
            <label>カテゴリ</label>
            <select
              className="select"
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
        </div>
        <div className="field">
          <label>発火キーワード（読点・カンマ区切り）</label>
          <input
            className="input"
            value={keysText}
            onChange={(ev) => setKeysText(ev.target.value)}
            placeholder="港、港祭り、ハーバー"
          />
        </div>
        <div className="field">
          <label>注入本文</label>
          <textarea
            className="textarea"
            rows={7}
            value={e.content}
            onChange={(ev) => setE({ ...e, content: ev.target.value })}
          />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>優先度（大きいほど優先）</label>
            <input
              className="input"
              type="number"
              value={e.priority}
              onChange={(ev) => setE({ ...e, priority: parseInt(ev.target.value, 10) || 0 })}
            />
          </div>
          <div className="field">
            <label>対象キャラ（指定時はそのキャラ参加時のみ）</label>
            <select
              className="select"
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
        </div>
        <div className="field">
          <label>場所トリガー（現在地が一致で発火）</label>
          <div className="row wrap">
            {props.locations.map((l) => (
              <span
                key={l.id}
                className={`chip${e.trigger_locations.includes(l.id) ? ' on' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() =>
                  setE({ ...e, trigger_locations: toggleIn(e.trigger_locations, l.id) })
                }
              >
                {l.name}
              </span>
            ))}
          </div>
        </div>
        <div className="field">
          <label>季節トリガー</label>
          <div className="row wrap">
            {SEASONS.map((sn) => (
              <span
                key={sn}
                className={`chip${e.trigger_seasons.includes(sn) ? ' on' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => setE({ ...e, trigger_seasons: toggleIn(e.trigger_seasons, sn) })}
              >
                {sn}
              </span>
            ))}
          </div>
        </div>
        <div className="row wrap">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={e.always === 1}
              onChange={(ev) => setE({ ...e, always: ev.target.checked ? 1 : 0 })}
            />
            常時注入（always）
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={e.enabled === 1}
              onChange={(ev) => setE({ ...e, enabled: ev.target.checked ? 1 : 0 })}
            />
            有効
          </label>
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={props.onClose}>
            キャンセル
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
