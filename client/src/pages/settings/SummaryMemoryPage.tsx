import { useNavigate } from 'react-router-dom';
import { modelLabel, summarizeEveryMessages } from '@shared/types';
import { NavRow, SectionHead, SettingRow, Stepper, Toggle } from '../../components';
import { Icon } from '../../icons';
import { Box, Loading, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/**
 * あらすじとメモリー。
 *
 * **自動要約がOFFでも「きっかけ」「目安」「方針」を隠さない。** 自動抽出
 * （memory.ts の maybeExtract）は summary_interval を使い、「今すぐ要約」は目安と方針を
 * 使い続けるため。分割前の画面は隠していて、効いている値が見えなかった
 */
export default function SummaryMemoryPage() {
  const { settings, set } = useSettings();
  const navigate = useNavigate();
  if (!settings) return <Loading title="あらすじとメモリー" />;

  const interval = settings.summary_interval;
  const every = summarizeEveryMessages(interval);
  const retain = interval - every;

  return (
    <SettingsSubPage title="あらすじとメモリー">
      <div className="section">
        <SectionHead>あらすじ</SectionHead>
        <SettingRow label="自動で要約する" hint="OFFでも、あらすじ画面の「今すぐ要約」は使えます">
          <Toggle on={settings.auto_summarize === 1} onChange={(v) => void set({ auto_summarize: v ? 1 : 0 })} />
        </SettingRow>
        <SettingRow label="要約のきっかけ" unit="件" hint="まだ要約していないメッセージが、この件数たまったとき">
          <Stepper value={interval} step={2} min={4} onChange={(v) => void set({ summary_interval: v })} />
        </SettingRow>
        {settings.auto_summarize === 1 && (
          <Box>
            直近の{retain}件は生のまま残すので、実際は約{every}件（{Math.round(every / 2)}ターン）ごとに要約します
          </Box>
        )}
        <SettingRow label="あらすじの長さの目安" unit="字" hint="1回の要約で書く文字数">
          <Stepper
            value={settings.summary_max_chars}
            step={100}
            min={100}
            onChange={(v) => void set({ summary_max_chars: v })}
          />
        </SettingRow>
        <NavRow
          icon={<Icon.scroll size={18} />}
          title="要約の方針"
          value="何を残し、何を落とし、どう書くか"
          onClick={() => navigate('/settings/summary/policy')}
        />
      </div>

      <div className="section">
        <SectionHead>メモリー</SectionHead>
        <SettingRow label="会話から候補を自動で拾う" hint="「要約のきっかけ」と同じ件数ごとに動きます">
          <Toggle on={settings.auto_extract === 1} onChange={(v) => void set({ auto_extract: v ? 1 : 0 })} />
        </SettingRow>
      </div>

      <Box>
        要約と抽出は「裏方の処理」のモデル（{modelLabel(settings.utility_model)}）が行います。
        <button className="inline-link" onClick={() => navigate('/settings/models')}>
          変更
        </button>
      </Box>
    </SettingsSubPage>
  );
}
