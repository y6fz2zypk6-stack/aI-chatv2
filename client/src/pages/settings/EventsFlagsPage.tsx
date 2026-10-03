import { SectionHead, SettingRow, Stepper, Toggle } from '../../components';
import { Loading, Note, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/** イベントと進行フラグ。ここは全体の既定で、シナリオ・会話で上書きできる */
export default function EventsFlagsPage() {
  const { settings, set } = useSettings();
  if (!settings) return <Loading title="イベントと進行フラグ" />;

  return (
    <SettingsSubPage title="イベントと進行フラグ">
      <div className="section">
        <div className="cascade" aria-label="設定が効く順番">
          <span className="here">全体の既定（このページ）</span>
          <span className="sep" aria-hidden="true">›</span>
          <span>シナリオ</span>
          <span className="sep" aria-hidden="true">›</span>
          <span>会話</span>
        </div>
        <Note>右ほど優先されます。シナリオや会話が「継承」のままなら、ここの値が使われます。</Note>
      </div>

      <div className="section">
        <SectionHead>条件付きイベント</SectionHead>
        <SettingRow label="条件付きイベントを使う" hint="条件を満たすと、次の応答に出来事を一文差し込みます">
          <Toggle on={settings.events_enabled === 1} onChange={(v) => void set({ events_enabled: v ? 1 : 0 })} />
        </SettingRow>
        {/* 全体OFFでも隠さない。シナリオや会話でONにしたときに効くため */}
        <SettingRow label="1ターンの上限" unit="件" hint="演出指示は、上限に関わらず1件まで">
          <Stepper
            value={settings.event_max_per_turn}
            min={1}
            max={5}
            onChange={(v) => void set({ event_max_per_turn: v })}
          />
        </SettingRow>
      </div>

      <div className="section">
        <SectionHead>進行フラグ</SectionHead>
        <SettingRow label="進行フラグを使う" hint="物語の段階や「もう会った」をアプリが覚えておきます">
          <Toggle on={settings.vars_enabled === 1} onChange={(v) => void set({ vars_enabled: v ? 1 : 0 })} />
        </SettingRow>
        <Note>使う世界だけ、シナリオ側でONにするのがおすすめです。</Note>
      </div>
    </SettingsSubPage>
  );
}
