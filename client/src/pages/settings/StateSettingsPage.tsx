import { RadioCard, RadioGroup, SettingRow, Toggle } from '../../components';
import { Loading, Note, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/** ステート（時刻・場所・天候・在席をアプリが管理する） */
export default function StateSettingsPage() {
  const { settings, set } = useSettings();
  if (!settings) return <Loading title="ステート" />;
  const on = settings.state_enabled === 1;

  return (
    <SettingsSubPage title="ステート">
      <SettingRow label="ステートを使う" hint="時刻・場所・天候・在席をアプリが管理します">
        <Toggle on={on} onChange={(v) => void set({ state_enabled: v ? 1 : 0 })} />
      </SettingRow>
      {on ? (
        <div className="section">
          <label className="lbl">変化の読み取り方</label>
          <RadioGroup label="変化の読み取り方">
            <RadioCard
              selected={settings.state_extraction_mode === 'fenced'}
              onSelect={() => void set({ state_extraction_mode: 'fenced' })}
              title="応答の末尾から"
              tag="既定"
            >
              本文と一緒に、時刻や場所の変化を末尾に書かせます。追加の呼び出しはありません
            </RadioCard>
            <RadioCard
              selected={settings.state_extraction_mode === 'separate_call'}
              onSelect={() => void set({ state_extraction_mode: 'separate_call' })}
              title="別の呼び出しで"
            >
              本文のあとで、裏方のモデルが変化を読み取ります。末尾の書き漏れが続くときに
            </RadioCard>
          </RadioGroup>
        </div>
      ) : (
        <Note>OFFのあいだは、応答から時刻や場所の変化を読み取りません。ステート編集と「場面を進める」は使えます。</Note>
      )}
    </SettingsSubPage>
  );
}
