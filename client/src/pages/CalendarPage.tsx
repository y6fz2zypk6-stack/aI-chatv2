import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { CalendarConfig } from '@shared/types';
import { api } from '../api';
import { Field, Stepper, Toggle, TopBar } from '../components';
import { Icon } from '../icons';
import { useApp } from '../store';

/** 構造化された部分は個別入力、複雑なテーブルはJSONで編集する */
export default function CalendarPage() {
  const { id } = useParams<{ id: string }>();
  const [cfg, setCfg] = useState<CalendarConfig | null>(null);
  const [seasonsJson, setSeasonsJson] = useState('');
  const [sunJson, setSunJson] = useState('');
  const [weatherJson, setWeatherJson] = useState('');
  const [weekdaysText, setWeekdaysText] = useState('');
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    if (!id) return;
    api
      .get<CalendarConfig>(`/worlds/${id}/calendar`)
      .then((c) => {
        setCfg(c);
        setSeasonsJson(JSON.stringify(c.seasons, null, 2));
        setSunJson(JSON.stringify(c.sun, null, 2));
        setWeatherJson(JSON.stringify(c.weather_table, null, 2));
        setWeekdaysText(c.weekdays.join('、'));
      })
      .catch(() => {});
  }, [id]);

  if (!cfg) return <div className="empty-note">読み込み中…</div>;

  const save = async () => {
    try {
      const next = {
        ...cfg,
        seasons: JSON.parse(seasonsJson),
        sun: JSON.parse(sunJson),
        weather_table: JSON.parse(weatherJson),
        weekdays: weekdaysText
          .split(/[,、，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      setCfg(await api.put<CalendarConfig>(`/worlds/${id}/calendar`, next));
      toast('暦を保存しました');
    } catch (err) {
      toast(`保存できません: ${(err as Error).message}`, true);
    }
  };

  return (
    <>
      <TopBar title="暦・天候" back={`/worlds/${id}`} />
      <div className="content form">
        <div className="section">
          <span className="kicker">Calendar</span>
          <div className="setting">
            <div className="txt">
              <label>1年の月数</label>
            </div>
            <Stepper
              value={cfg.months_per_year}
              min={1}
              onChange={(v) => setCfg({ ...cfg, months_per_year: v })}
            />
          </div>
          <div className="setting">
            <div className="txt">
              <label>1ヶ月の日数</label>
              <span>28日なら常に第1〜第4週になる</span>
            </div>
            <Stepper
              value={cfg.days_per_month}
              min={1}
              onChange={(v) => setCfg({ ...cfg, days_per_month: v })}
            />
          </div>
          <Field label="曜日名（区切り）">
            <input value={weekdaysText} onChange={(e) => setWeekdaysText(e.target.value)} />
          </Field>
        </div>

        <div className="section">
          <span className="kicker">Last Train</span>
          <div className="setting">
            <div className="txt">
              <label>終電の行を出す</label>
              <span>鉄道が無い世界観ではオフにできます</span>
            </div>
            <Toggle
              on={cfg.last_train_enabled !== 0}
              onChange={(v) => setCfg({ ...cfg, last_train_enabled: v ? 1 : 0 })}
            />
          </div>
          {cfg.last_train_enabled !== 0 && (
            <>
              <Field label="呼び方（終電 / 最終バス / 最終転移 など）">
                <input
                  value={cfg.last_train_label}
                  onChange={(e) => setCfg({ ...cfg, last_train_label: e.target.value })}
                  placeholder="終電"
                />
              </Field>
              <div className="setting" >
                <div className="txt">
                  <label>{cfg.last_train_label || '終電'}の時刻</label>
                  <span>0時からの分。23:00 = 1380</span>
                </div>
                <Stepper
                  value={cfg.last_train_min}
                  step={30}
                  min={0}
                  max={2880}
                  onChange={(v) => setCfg({ ...cfg, last_train_min: v })}
                />
              </div>
              <div className="setting">
                <div className="txt">
                  <label>通知を出し始める（分前）</label>
                  <span>
                    この窓の中だけ「{cfg.last_train_label || '終電'}まで残り◯分」を出す
                  </span>
                </div>
                <Stepper
                  value={cfg.last_train_notice_min}
                  step={15}
                  min={0}
                  onChange={(v) => setCfg({ ...cfg, last_train_notice_min: v })}
                />
              </div>
              <Field label={`${cfg.last_train_label || '終電'}後に出す文`}>
                <input
                  value={cfg.after_last_train_text}
                  onChange={(e) => setCfg({ ...cfg, after_last_train_text: e.target.value })}
                  placeholder="終電は終了。帰りは徒歩か辻馬車になる。"
                />
              </Field>
            </>
          )}
        </div>

        <div className="section">
          <span className="kicker">Seasons</span>
          <Field label="季節名 → 月番号の配列">
            <textarea
              className="mono"
              value={seasonsJson}
              onChange={(e) => setSeasonsJson(e.target.value)}
            />
          </Field>
        </div>

        <div className="section">
          <span className="kicker">Sunrise / Sunset</span>
          <Field label="月ごとの日出・日没（未定義の月は前後から補間）">
            <textarea className="mono" value={sunJson} onChange={(e) => setSunJson(e.target.value)} />
          </Field>
        </div>

        <div className="section">
          <span className="kicker">Weather</span>
          <Field label="季節 → 天候と重み（1日1回だけ抽選）">
            <textarea
              className="mono tall"
              value={weatherJson}
              onChange={(e) => setWeatherJson(e.target.value)}
            />
          </Field>
          {/* 日付の変わり目（0:00）とは別の境界。深夜の会話中に天気が変わるのを避ける */}
          <div className="setting">
            <div className="txt">
              <label>天候を引き直す時刻</label>
              <span>
                0時からの分。240 = 朝4時。日付の変わり目ではなくこの時刻に切り替わるので、
                深夜の会話中に急に天気が変わりません。0 にすると0:00起点に戻ります
              </span>
            </div>
            <Stepper
              value={cfg.weather_rollover_min ?? 240}
              step={60}
              min={0}
              max={1380}
              onChange={(v) => setCfg({ ...cfg, weather_rollover_min: v })}
            />
          </div>
        </div>
      </div>

      <div className="footbar">
        <button className="pill primary grow" onClick={save}>
          <Icon.check />
          保存
        </button>
      </div>
    </>
  );
}
