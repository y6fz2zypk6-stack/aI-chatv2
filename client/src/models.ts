import { useCallback, useEffect, useState } from 'react';
import { parseModelRef, type ConnectionView, type ResolvedModel } from '@shared/types';
import { api } from './api';

/**
 * モデル選択のまわりの情報（§6.6）: 接続先の一覧と、「最新」の名前が実際にどの版で答えたか。
 * **どちらも取れなくても画面は壊さない。** 接続先の名前や「いまは〜」が出ないだけにする
 */
export function useModelMeta(): {
  connections: ConnectionView[];
  resolved: Record<string, ResolvedModel>;
  reload: () => void;
} {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [resolved, setResolved] = useState<Record<string, ResolvedModel>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .get<ConnectionView[]>('/connections')
      .then((list) => alive && setConnections(list))
      .catch(() => alive && setConnections([]));
    api
      .get<Record<string, ResolvedModel>>('/models/resolved')
      .then((r) => alive && setResolved(r))
      .catch(() => {
        /* 「いまは〜」が出ないだけ */
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { connections, resolved, reload };
}

/** モデル参照の接続先の表示名。組み込みは「OpenRouter（.env）」 */
export function connectionNameOf(connections: ConnectionView[], ref: string): string {
  const id = parseModelRef(ref).connectionId;
  const found = connections.find((c) => c.id === id);
  if (found) return found.name;
  return id ? '（見つからない接続先）' : 'OpenRouter（.env）';
}

/** 「OpenRouter（.env） · ~anthropic/claude-opus-latest · いまは Opus 5.5」。空の参照は空文字 */
export function describeModelRef(
  connections: ConnectionView[],
  resolved: Record<string, ResolvedModel>,
  ref: string,
): string {
  if (!ref) return '';
  const now = resolved[ref];
  return [connectionNameOf(connections, ref), parseModelRef(ref).modelId, now ? `いまは ${now.label}` : '']
    .filter(Boolean)
    .join(' · ');
}
