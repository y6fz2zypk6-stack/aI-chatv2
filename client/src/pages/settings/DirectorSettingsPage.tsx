import { Field, SectionHead, SettingRow, Stepper, Toggle } from '../../components';
import { useModelGroups } from '../../models';
import { Loading, ModelSelect, More, Note, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/**
 * 裏の台本（§23）。ここは全体の既定で、シナリオ・会話で上書きできる。
 * **既定はOFF。** 台本の更新ぶんだけ呼び出しが増えるので、使う人だけが払う
 */
export default function DirectorSettingsPage() {
  const { settings, set } = useSettings();
  const { groups } = useModelGroups();
  if (!settings) return <Loading title="裏の台本" />;

  return (
    <SettingsSubPage title="裏の台本">
      <div className="section">
        <div className="cascade" aria-label="設定が効く順番">
          <span className="here">全体の既定（このページ）</span>
          <span className="sep" aria-hidden="true">›</span>
          <span>シナリオ</span>
          <span className="sep" aria-hidden="true">›</span>
          <span>会話</span>
        </div>
        <Note>右ほど優先されます。試すときは、会話の設定でその会話だけONにするのがおすすめです。</Note>
      </div>

      <div className="section">
        <SectionHead>使うかどうか</SectionHead>
        <SettingRow
          label="裏の台本を使う"
          hint="数場面ごとに、伏線・人物の思惑・次の転機を裏で書き直し、本文には短い演出指示だけを渡します"
        >
          <Toggle on={settings.director_enabled === 1} onChange={(v) => void set({ director_enabled: v ? 1 : 0 })} />
        </SettingRow>
        <More summary="くわしく">
          台本そのもの（秘密や回収予定）は本文のモデルに渡しません。渡すと先回りして明かしてしまうためです。
          本文に渡すのは「次の数場面でさりげなく入れてほしいこと」1〜3行だけで、プロンプトの末尾に載ります。
          前置きのキャッシュは崩しません。
          <br />
          OFFの会話では、台本の更新も本文への注入も一切しません（追加の料金はかかりません）。
        </More>
      </div>

      <div className="section">
        <SectionHead>更新のしかた</SectionHead>
        <Field label="台本を書くモデル">
          <ModelSelect
            value={settings.director_model}
            groups={groups}
            emptyLabel="裏方の処理と同じ"
            onChange={(v) => void set({ director_model: v })}
          />
        </Field>
        <SettingRow label="更新の間隔" unit="回" hint="応答がこの回数たまるごとに書き直します。最初の台本だけは応答2回で作ります">
          <Stepper
            value={settings.director_interval}
            min={1}
            max={30}
            onChange={(v) => void set({ director_interval: v })}
          />
        </SettingRow>
        <SettingRow label="台本の長さ" unit="字" hint="長いほど細かく覚えますが、更新1回の料金が上がります">
          <Stepper
            value={settings.director_max_chars}
            step={250}
            min={500}
            max={5000}
            onChange={(v) => void set({ director_max_chars: v })}
          />
        </SettingRow>
      </div>
    </SettingsSubPage>
  );
}
