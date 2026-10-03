import { Segmented, SettingRow, Stepper } from '../../components';
import { Loading, More, Note, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/** ロアブック（どこまで探し、どれだけ入れるか） */
export default function LoreSettingsPage() {
  const { settings, set } = useSettings();
  if (!settings) return <Loading title="ロアブック" />;
  const win = settings.lore_scan_window;

  return (
    <SettingsSubPage title="ロアブック">
      <SettingRow label="注入の予算" unit="字" hint="超えた分は、そのターンは入れません">
        <Stepper
          value={settings.lore_budget_chars}
          step={1000}
          min={1000}
          onChange={(v) => void set({ lore_budget_chars: v })}
        />
      </SettingRow>
      <SettingRow
        label="キーワードを探す範囲"
        unit="件"
        hint={`直近${win}件（${Math.floor(win / 2)}ターン）の本文から探します`}
      >
        <Stepper value={win} min={1} onChange={(v) => void set({ lore_scan_window: v })} />
      </SettingRow>
      <div className="section">
        <label className="lbl">探す回数</label>
        <Segmented
          label="探す回数"
          value={settings.lore_recursion}
          options={[1, 2, 3, 4].map((n) => ({ value: n, label: `${n}回` }))}
          onChange={(v) => void set({ lore_recursion: v })}
        />
        <Note>
          {settings.lore_recursion === 1
            ? '会話の本文からだけ探します'
            : '2回目からは、発火したロアの本文に出てくる語でも探します'}
        </Note>
      </div>
      <More summary="くわしく">
        常に入れるロアだけで予算を超えると、設定ミスとして警告が出ます。キャラクターを指定したロアは、そのキャラが参加しているときだけ判定されます。
      </More>
    </SettingsSubPage>
  );
}
