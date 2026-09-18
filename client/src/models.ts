import { useEffect, useState } from 'react';
import { CURATED_MODELS, makeModelRef, type ConnectionView, type ModelInfo } from '@shared/types';
import { api } from './api';

/**
 * モデルの選択肢を接続先ごとに組む（§6.6）。
 *
 * 組み込み（`.env` の OpenRouter）は `CURATED_MODELS` をそのまま使う。
 * 登録した接続先は `/connections/:id/models` から引くが、**`/models` を持たない
 * サービス（ローカルの推論サーバなど）がある**ので、取れなくても選択肢が空になるだけで
 * 壊れないようにし、自由入力を必ず併設する。
 */
export interface ModelGroup {
  connection: ConnectionView;
  options: { ref: string; label: string }[];
  /** モデル一覧を引けなかった（自由入力で指定する必要がある） */
  failed: boolean;
}

export function useModelGroups(): { groups: ModelGroup[]; connections: ConnectionView[]; reload: () => void } {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let list: ConnectionView[] = [];
      try {
        list = await api.get<ConnectionView[]>('/connections');
      } catch {
        // 接続先が引けなくても、組み込みの候補だけは出す
        list = [];
      }
      if (!alive) return;
      setConnections(list);

      const built: ModelGroup[] = [];
      for (const c of list) {
        if (c.builtin) {
          built.push({
            connection: c,
            options: CURATED_MODELS.map((m) => ({ ref: m.id, label: m.label })),
            failed: false,
          });
          continue;
        }
        try {
          const models = await api.get<ModelInfo[]>(`/connections/${c.id}/models`);
          built.push({
            connection: c,
            options: models.map((m) => ({ ref: makeModelRef(c.id, m.id), label: m.name || m.id })),
            failed: false,
          });
        } catch {
          built.push({ connection: c, options: [], failed: true });
        }
      }
      if (alive) setGroups(built);
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { groups, connections, reload: () => setTick((t) => t + 1) };
}
