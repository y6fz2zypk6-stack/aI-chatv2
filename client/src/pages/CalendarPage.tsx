import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CalendarConfig } from '@shared/types';
import { api } from '../api';
import { useApp } from '../store';

/** 構造化された部分は個別入力、複雑なテーブルはJSONエディタで編集する */
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

  if (!cfg) return <main className="page">読み込み中…</main>;

  const num = (v: string, fb: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fb;
  };

  const save = async () => {
    try {
      const seasons = JSON.parse(seasonsJson);
      const sun = JSON.parse(sunJson);
      const weather_table = JSON.parse(weatherJson);
      const weekdays = weekdaysText
        .split(/[,、，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const next = { ...cfg, seasons, sun, weather_table, weekdays };
      const saved = await api.put<CalendarConfig>(`/worlds/${id}/calendar`, next);
      setCfg(saved);
      toast('暦を保存しました');
    } catch (err) {
      toast(`保存できません: ${(err as Error).message}`, true);
    }
  };

  return (
    <main className="page">
      <h1 className="page-title">🗓 暦・天候</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to={`/worlds/${id}`}>← 世界に戻る</Link>
      </div>

      <div className="card">
        <div className="grid-2">
          <div className="field">
            <label>1年の月数</label>
            <input
              className="input"
              type="number"
              value={cfg.months_per_year}
              onChange={(e) => setCfg({ ...cfg, months_per_year: num(e.target.value, 12) })}
            />
          </div>
          <div className="field">
            <label>1ヶ月の日数</label>
            <input
              className="input"
              type="number"
              value={cfg.days_per_month}
              onChange={(e) => setCfg({ ...cfg, days_per_month: num(e.target.value, 28) })}
            />
          </div>
        </div>
        <div className="field">
          <label>曜日名（区切り）</label>
          <input
            className="input"
            value={weekdaysText}
            onChange={(e) => setWeekdaysText(e.target.value)}
          />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>終電（0時からの分。23:00 = 1380）</label>
            <input
              className="input"
              type="number"
              value={cfg.last_train_min}
              onChange={(e) => setCfg({ ...cfg, last_train_min: num(e.target.value, 1380) })}
            />
          </div>
          <div className="field">
            <label>終電の通知開始（分前）</label>
            <input
              className="input"
              type="number"
              value={cfg.last_train_notice_min}
              onChange={(e) => setCfg({ ...cfg, last_train_notice_min: num(e.target.value, 60) })}
            />
          </div>
        </div>
        <div className="field">
          <label>終電後の代替文</label>
          <input
            className="input"
            value={cfg.after_last_train_text}
            onChange={(e) => setCfg({ ...cfg, after_last_train_text: e.target.value })}
          />
        </div>
      </div>

      <div className="section-title">季節（季節名 → 月番号の配列）</div>
      <div className="card">
        <textarea
          className="textarea mono"
          rows={6}
          value={seasonsJson}
          onChange={(e) => setSeasonsJson(e.target.value)}
        />
      </div>

      <div className="section-title">日出・日没（月ごと。未定義月は線形補間）</div>
      <div className="card">
        <textarea
          className="textarea mono"
          rows={6}
          value={sunJson}
          onChange={(e) => setSunJson(e.target.value)}
        />
      </div>

      <div className="section-title">天候テーブル（季節 → 天候:重み）</div>
      <div className="card">
        <textarea
          className="textarea mono"
          rows={8}
          value={weatherJson}
          onChange={(e) => setWeatherJson(e.target.value)}
        />
      </div>

      <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={save}>
          保存
        </button>
      </div>
    </main>
  );
}
