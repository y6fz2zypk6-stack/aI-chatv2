import { create } from 'zustand';

interface Toast {
  id: number;
  text: string;
  warn?: boolean;
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
}

let toastSeq = 0;

export const useApp = create<AppStore>((set) => ({
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
}));
