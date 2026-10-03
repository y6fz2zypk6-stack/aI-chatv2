import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '@shared/types';
import { api } from '../../api';
import { useApp } from '../../store';

/**
 * 設定の読み書き（各サブページで共通）。
 *
 * **変更は即座に保存する**（分割前と同じ挙動）。画面の値を先に変えてから `PUT /settings` し、
 * 失敗したらトーストで知らせる。長文の欄は打つたびに保存しないよう、`setLocal` で画面だけ
 * 変えておき、離れたときに `set` で保存する。
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    api.get<Settings>('/settings').then(setSettings).catch((err) => toast((err as Error).message, true));
  }, [toast]);

  const set = useCallback(
    async (patch: Partial<Settings>) => {
      setSettings((cur) => (cur ? { ...cur, ...patch } : cur));
      try {
        await api.put('/settings', patch);
      } catch (err) {
        toast((err as Error).message, true);
      }
    },
    [toast],
  );

  /** 画面の値だけ変える（保存しない） */
  const setLocal = useCallback((patch: Partial<Settings>) => {
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur));
  }, []);

  return { settings, set, setLocal };
}
