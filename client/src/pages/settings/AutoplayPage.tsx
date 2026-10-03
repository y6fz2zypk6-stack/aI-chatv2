import { SettingRow, Stepper, Toggle } from '../../components';
import { Loading, Note, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/** オートプレイ（あなたの入力なしで場面を進める） */
export default function AutoplayPage() {
  const { settings, set } = useSettings();
  if (!settings) return <Loading title="オートプレイ" />;

  return (
    <SettingsSubPage title="オートプレイ">
      {/* 判断の子（字下げ）にしない。判断がOFFでも上限は効く */}
      <SettingRow label="1回で進める最大ターン" hint="あなたの入力なしで続ける上限">
        <Stepper value={settings.autoplay_steps} min={1} onChange={(v) => void set({ autoplay_steps: v })} />
      </SettingRow>
      <SettingRow label="区切りが良ければ止める" hint="続けるかどうかを、裏方のモデルが毎ターン判断します">
        <Toggle on={settings.autoplay_judge === 1} onChange={(v) => void set({ autoplay_judge: v ? 1 : 0 })} />
      </SettingRow>
      <Note>会話の ＋ メニューの「オートプレイ」で始めます。</Note>
    </SettingsSubPage>
  );
}
