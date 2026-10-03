import { create } from 'zustand';

interface Toast {
  id: number;
  text: string;
  warn?: boolean;
}

/** 確認ダイアログの内容。ブラウザ標準の confirm() の代わりに使う */
export interface ConfirmOpts {
  title: string;
  body?: string;
  /** 実行ボタンの文言（「削除する」など。「OK」にはしない） */
  okLabel: string;
  /** 既定は「キャンセル」 */
  cancelLabel?: string;
  /** 取り消せない操作。実行ボタンを赤地にする */
  danger?: boolean;
}

interface PendingConfirm {
  opts: ConfirmOpts;
  resolve: (ok: boolean) => void;
}

interface AppStore {
  authenticated: boolean | null;
  authRequired: boolean;
  appTitle: string;
  setAuth: (authenticated: boolean, authRequired: boolean) => void;
  setAppTitle: (title: string) => void;
  toasts: Toast[];
  toast: (text: string, warn?: boolean) => void;
  dismissToast: (id: number) => void;
  /** いま開いている確認ダイアログ。`ConfirmHost` が描く */
  pendingConfirm: PendingConfirm | null;
  ask: (opts: ConfirmOpts) => Promise<boolean>;
  /** ダイアログを閉じて、押された結果を呼び出し元へ返す */
  answerConfirm: (ok: boolean) => void;
}

let toastSeq = 0;

export const useApp = create<AppStore>((set, get) => ({
  authenticated: null,
  authRequired: false,
  appTitle: 'Character Chat',
  setAuth: (authenticated, authRequired) => set({ authenticated, authRequired }),
  setAppTitle: (appTitle) => set({ appTitle }),
  toasts: [],
  toast: (text, warn) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, warn }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  pendingConfirm: null,
  ask: (opts) =>
    new Promise<boolean>((resolve) => {
      // すでに開いているものがあれば、押されなかった（キャンセル）ものとして閉じる
      get().pendingConfirm?.resolve(false);
      set({ pendingConfirm: { opts, resolve } });
    }),
  answerConfirm: (ok) => {
    const cur = get().pendingConfirm;
    if (!cur) return;
    set({ pendingConfirm: null });
    cur.resolve(ok);
  },
}));

/**
 * 確認を取る。**`true` なら実行してよい。** 画面の部品の外（イベントハンドラ）からも呼べるように、
 * フックを通さない形で出している。
 *
 *   if (!(await ask({ title: '「ミナ」を削除しますか？', okLabel: '削除する', danger: true }))) return;
 */
export const ask = (opts: ConfirmOpts): Promise<boolean> => useApp.getState().ask(opts);
