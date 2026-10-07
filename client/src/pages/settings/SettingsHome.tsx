import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { modelLabel, summarizeEveryMessages, type ConnectionView, type Persona } from '@shared/types';
import { api } from '../../api';
import { HomeHead, NavRow, SectionHead, TabBar } from '../../components';
import { Icon } from '../../icons';
import { useSettings } from './useSettings';

/**
 * 設定のハブ。**行は「開く」だけで、トグルや数値はここに置かない。**
 * 開かなくても全体が分かるように、各行の下に今の値を出す
 */
export default function SettingsHome() {
  const { settings: s } = useSettings();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Persona[]>('/personas').then(setPersonas).catch(() => {});
    api.get<ConnectionView[]>('/connections').then(setConnections).catch(() => {});
  }, []);

  if (!s) {
    return (
      <>
        <HomeHead title="設定" />
        <div className="content">
          <div className="empty-note">読み込み中…</div>
        </div>
        <TabBar />
      </>
    );
  }

  const n = (v: number) => v.toLocaleString();
  const onOff = (v: number) => (v === 1 ? 'ON' : 'OFF');
  const own = personas.find((p) => p.is_default === 1);
  const persona = s.active_persona_id
    ? (personas.find((p) => p.id === s.active_persona_id)?.name ?? '（見つかりません）')
    : `ペルソナ側の既定${own ? `（${own.name}）` : ''}`;
  const firstLine = s.system_prompt.split('\n').find((l) => l.trim()) ?? '（空）';
  const conn =
    connections.length === 0
      ? '—'
      : connections.length === 1
        ? connections[0].name
        : `${connections[0].name} ほか${connections.length - 1}件`;

  return (
    <>
      <HomeHead title="設定" />
      <div className="content settings-hub">
        <button className="hub-card" onClick={() => navigate('/settings/models')}>
          <span className="txt">
            <span className="ttl">モデルと接続先</span>
            <span className="line">
              <span className="k">会話</span>
              {modelLabel(s.default_model)}
            </span>
            <span className="line">
              <span className="k">裏方</span>
              {modelLabel(s.utility_model)}
            </span>
            <span className="line">
              <span className="k">接続先</span>
              {conn}
            </span>
          </span>
          <span className="chev">
            <Icon.chevR size={16} />
          </span>
        </button>

        <div className="section">
          <SectionHead>あなたと語り口</SectionHead>
          <div className="nav-list">
            <NavRow
              icon={<Icon.charFile size={18} />}
              title="既定のペルソナ"
              value={persona}
              onClick={() => navigate('/settings/persona')}
            />
            <NavRow
              icon={<Icon.scroll size={18} />}
              title="共通の指示"
              value={firstLine}
              onClick={() => navigate('/settings/system-prompt')}
            />
          </div>
        </div>

        <div className="section">
          <SectionHead>物語のしくみ</SectionHead>
          <div className="nav-list">
            <NavRow
              icon={<Icon.clock size={18} />}
              title="ステート"
              value={
                s.state_enabled !== 1
                  ? 'OFF'
                  : `ON ・ ${s.state_extraction_mode === 'separate_call' ? '別の呼び出しで読み取る' : '応答の末尾から読み取る'}`
              }
              onClick={() => navigate('/settings/state')}
            />
            <NavRow
              icon={<Icon.compass size={18} />}
              title="イベントと進行フラグ"
              value={`イベント ${onOff(s.events_enabled)} ・ 進行フラグ ${onOff(s.vars_enabled)}`}
              onClick={() => navigate('/settings/events')}
            />
            <NavRow
              icon={<Icon.sparkle size={18} />}
              title="裏の台本"
              value={
                s.director_enabled === 1
                  ? `ON ・ 応答${s.director_interval}回ごとに更新`
                  : 'OFF（シナリオ・会話ごとにONにできます）'
              }
              onClick={() => navigate('/settings/director')}
            />
            <NavRow
              icon={<Icon.book size={18} />}
              title="ロアブック"
              value={`予算 ${n(s.lore_budget_chars)}字 ・ 直近${s.lore_scan_window}件から探す`}
              onClick={() => navigate('/settings/lorebook')}
            />
          </div>
        </div>

        <div className="section">
          <SectionHead>自動で動くもの</SectionHead>
          <div className="nav-list">
            <NavRow
              icon={<Icon.brain size={18} />}
              title="あらすじとメモリー"
              value={`${s.auto_summarize === 1 ? `要約 約${summarizeEveryMessages(s.summary_interval)}件ごと` : '要約 OFF'} ・ 自動抽出 ${onOff(s.auto_extract)}`}
              onClick={() => navigate('/settings/summary')}
            />
            <NavRow
              icon={<Icon.forward size={18} />}
              title="オートプレイ"
              value={`最大${s.autoplay_steps}ターン${s.autoplay_judge === 1 ? ' ・ 区切りで止める' : ''}`}
              onClick={() => navigate('/settings/autoplay')}
            />
            <NavRow
              icon={<Icon.camera size={18} />}
              title="スナップショット"
              value={s.image_model ? `ON ・ ${s.image_model}` : 'OFF ・ 画像モデル未設定'}
              onClick={() => navigate('/settings/snapshot')}
            />
          </div>
        </div>

        <div className="section">
          <SectionHead>詳細</SectionHead>
          <div className="nav-list">
            <NavRow
              icon={<Icon.lines size={18} />}
              title="文脈の予算"
              value={`履歴${s.history_window}件 ・ 安全余白${n(s.context_safety_tokens)}トークン`}
              onClick={() => navigate('/settings/budget')}
            />
          </div>
        </div>

        <p className="hub-foot">✓ 変更はその場で保存されます</p>
      </div>
      <TabBar />
    </>
  );
}
