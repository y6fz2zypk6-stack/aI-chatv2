import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { Field, Segmented, SettingRow, Toggle } from '../../components';
import { Loading, Note, SettingsSubPage } from './parts';
import { useSettings } from './useSettings';

/** OFFにする前の画像モデルを覚えておく場所。ONに戻したときに入れ直す */
const LAST_MODEL_KEY = 'charchat.lastImageModel';

const readLast = (): string => {
  try {
    return localStorage.getItem(LAST_MODEL_KEY) ?? '';
  } catch {
    return '';
  }
};
const writeLast = (v: string) => {
  try {
    localStorage.setItem(LAST_MODEL_KEY, v);
  } catch {
    /* 保存できなくても、戻すときに手で入れ直せばよい */
  }
};

const ASPECTS: { value: string; w: number; h: number }[] = [
  { value: '16:9', w: 16, h: 9 },
  { value: '4:3', w: 4, h: 3 },
  { value: '1:1', w: 1, h: 1 },
  { value: '3:4', w: 3, h: 4 },
  { value: '9:16', w: 9, h: 16 },
];

const QUALITY_HINT: Record<string, string> = {
  low: '安く、速く描きます',
  medium: '標準',
  high: '高く、時間がかかります',
};

/**
 * スナップショット（画像生成、§21）。
 *
 * サーバ側の「使う／使わない」は `image_model` が空かどうかだけで決まる。
 * 画面ではトグルを置き、OFFにするときに今のモデル名を覚えてから空にする
 */
export default function SnapshotSettingsPage() {
  const { settings, set } = useSettings();
  /** 表示上の ON/OFF。モデル欄を空にしただけでは閉じない（打ち直している途中のため） */
  const [on, setOn] = useState<boolean | null>(null);
  const [needModel, setNeedModel] = useState(false);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const modelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (settings && on === null) setOn(settings.image_model !== '');
  }, [settings, on]);

  useEffect(() => {
    // 画像モデルの候補。取れなくても手打ちできるので、失敗は黙って無視する
    api
      .get<{ data?: { id?: string }[] }>('/images/models')
      .then((r) => setImageModels((r.data ?? []).map((m) => m.id ?? '').filter(Boolean)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (needModel) modelRef.current?.focus();
  }, [needModel]);

  if (!settings || on === null) return <Loading title="スナップショット" />;

  const toggle = (v: boolean) => {
    setOn(v);
    if (!v) {
      if (settings.image_model) writeLast(settings.image_model);
      setNeedModel(false);
      void set({ image_model: '' });
      return;
    }
    const last = readLast();
    if (last) void set({ image_model: last });
    else setNeedModel(true);
  };

  return (
    <SettingsSubPage title="スナップショット">
      <SettingRow label="スナップショットを使う" hint="AIの応答の「⋯」に「この場面を描く」が出ます">
        <Toggle on={on} onChange={toggle} />
      </SettingRow>

      {!on ? (
        <div className="empty-note">
          いまは使っていません — ONにすると、画像モデルと画風を選べます。
          <br />
          画像の生成は本文より高くつくので、最初はOFFにしてあります。
        </div>
      ) : (
        <>
          <Field label="画像モデル">
            <input
              ref={modelRef}
              value={settings.image_model}
              onChange={(e) => {
                setNeedModel(false);
                void set({ image_model: e.target.value });
              }}
              placeholder="openai/gpt-image-2"
              list="image-models"
            />
            <datalist id="image-models">
              {imageModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Note>
              {needModel && !settings.image_model
                ? '画像モデルを入れると使えるようになります'
                : '1枚ごとに課金されます。自動では作りません。'}
            </Note>
          </Field>
          <Field label="画風">
            <textarea
              value={settings.image_style_prompt}
              onChange={(e) => void set({ image_style_prompt: e.target.value })}
              placeholder="anime illustration, soft lighting, watercolor"
            />
            <Note>すべての絵の、プロンプトの先頭に付きます</Note>
          </Field>
          <Field label="既定の比率">
            <div className="aspect-pick" role="radiogroup" aria-label="既定の比率">
              {ASPECTS.map((a) => (
                <button
                  key={a.value}
                  role="radio"
                  aria-checked={settings.image_aspect_ratio === a.value}
                  onClick={() => void set({ image_aspect_ratio: a.value })}
                >
                  <span className="frame" style={{ aspectRatio: `${a.w} / ${a.h}` }} />
                  <span className="lbl">{a.value}</span>
                </button>
              ))}
            </div>
          </Field>
          <Field label="既定の品質">
            <Segmented
              label="既定の品質"
              value={settings.image_quality}
              options={[
                { value: 'low', label: '低' },
                { value: 'medium', label: '中' },
                { value: 'high', label: '高' },
              ]}
              onChange={(v) => void set({ image_quality: v })}
            />
            <Note>
              {QUALITY_HINT[settings.image_quality] ?? ''}。対応しないモデルでは無視されます
            </Note>
          </Field>
          <SettingRow label="絵に文字を描かせない" hint="看板や書類の形で、文字を描き込むのを防ぎます">
            <Toggle on={settings.image_no_text === 1} onChange={(v) => void set({ image_no_text: v ? 1 : 0 })} />
          </SettingRow>
        </>
      )}
    </SettingsSubPage>
  );
}
