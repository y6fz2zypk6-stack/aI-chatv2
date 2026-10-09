import { useEffect, useState } from 'react';
import {
  CURATED_MODELS,
  makeModelRef,
  type ConnectionView,
  type ModelInfo,
  type ResolvedModel,
} from '@shared/types';
import { api } from './api';

/** モデルの選択肢1つ */
export interface ModelOption {
  ref: string;
  label: string;
  /** 系列の最新版へ振り向ける名前（§6.6）。画面では「最新を自動で使う」にまとめる */
  latest?: boolean;
  /** 「いまは Opus 5.5」。一度でも答えていれば出る */
  note?: string;
}

/**
 * モデルの選択肢を接続先ごとに組む（§6.6）。
 *
 * 組み込み（`.env` の OpenRouter）は `CURATED_MODELS` をそのまま使う。先頭は「最新」の名前で、
 * 実際に答えた版が分かれば `note`（「いまは Opus 5.5」）を添える。
 * 登録した接続先は `/connections/:id/models` から引くが、**`/models` を持たない
 * サービス（ローカルの推論サーバなど）がある**ので、取れなくても選択肢が空になるだけで
 * 壊れないようにし、自由入力を必ず併設する。
 */
export interface ModelGroup {
  connection: ConnectionView;
  options: ModelOption[];
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
      // 実際に答えた版。取れなくても候補は出す（「いまは〜」が出ないだけ）
      let resolved: Record<string, ResolvedModel> = {};
      try {
        resolved = await api.get<Record<string, ResolvedModel>>('/models/resolved');
      } catch {
        resolved = {};
      }
      if (!alive) return;

      const built: ModelGroup[] = [];
      for (const c of list) {
        if (c.builtin) {
          built.push({
            connection: c,
            options: CURATED_MODELS.map((m) => ({
              ref: m.id,
              label: m.label,
              latest: m.latest,
              note: m.latest && resolved[m.id] ? `いまは ${resolved[m.id].label}` : undefined,
            })),
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

/** 候補の中から、その参照の「いまは〜」を探す（既定の行など、候補の外で出すとき用） */
export function noteOf(groups: ModelGroup[], ref: string): string | undefined {
  for (const g of groups) {
    const o = g.options.find((x) => x.ref === ref);
    if (o) return o.note;
  }
  return undefined;
}
