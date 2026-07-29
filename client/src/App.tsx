import { useEffect } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { useApp } from './store';
import CalendarPage from './pages/CalendarPage';
import CharacterPage from './pages/CharacterPage';
import ChatPage from './pages/ChatPage';
import ChatsPage from './pages/ChatsPage';
import HomePage from './pages/HomePage';
import LocationsPage from './pages/LocationsPage';
import LoginPage from './pages/LoginPage';
import LorebookPage from './pages/LorebookPage';
import MemoriesPage from './pages/MemoriesPage';
import PersonasPage from './pages/PersonasPage';
import SettingsPage from './pages/SettingsPage';
import StatePage from './pages/StatePage';
import SummaryPage from './pages/SummaryPage';
import WorldDetailPage from './pages/WorldDetailPage';
import WorldsPage from './pages/WorldsPage';

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toast-holder">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.warn ? ' warn' : ''}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const { authenticated, authRequired, setAuth, appTitle, setAppTitle } = useApp();
  const location = useLocation();
  const isChat = /^\/chats\/[^/]+$/.test(location.pathname);

  useEffect(() => {
    (async () => {
      try {
        const [session, config] = await Promise.all([
          api.get<{ authenticated: boolean; authRequired: boolean }>('/session'),
          api.get<{ appTitle: string }>('/config').catch(() => ({ appTitle: 'Character Chat' })),
        ]);
        setAuth(session.authenticated, session.authRequired);
        setAppTitle(config.appTitle);
        document.title = config.appTitle;
      } catch {
        setAuth(true, false); // API未達時はログイン画面でブロックしない
      }
    })();
  }, [setAuth, setAppTitle]);

  if (authenticated === null) {
    return <div className="empty-note" style={{ paddingTop: '40dvh' }}>読み込み中…</div>;
  }
  if (authRequired && !authenticated) {
    return (
      <>
        <LoginPage />
        <Toasts />
      </>
    );
  }

  return (
    <div className="app-shell">
      {!isChat && (
        <header className="topbar">
          <NavLink to="/" className="brand">
            🍊 {appTitle}
          </NavLink>
          <nav>
            <NavLink to="/chats">会話</NavLink>
            <NavLink to="/worlds">世界</NavLink>
            <NavLink to="/personas">ペルソナ</NavLink>
            <NavLink to="/settings">設定</NavLink>
          </nav>
        </header>
      )}
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/worlds" element={<WorldsPage />} />
        <Route path="/worlds/:id" element={<WorldDetailPage />} />
        <Route path="/worlds/:id/lorebook" element={<LorebookPage />} />
        <Route path="/worlds/:id/locations" element={<LocationsPage />} />
        <Route path="/worlds/:id/calendar" element={<CalendarPage />} />
        <Route path="/characters/:id" element={<CharacterPage />} />
        <Route path="/characters/:id/memories" element={<MemoriesPage />} />
        <Route path="/chats" element={<ChatsPage />} />
        <Route path="/chats/:id" element={<ChatPage />} />
        <Route path="/chats/:id/state" element={<StatePage />} />
        <Route path="/chats/:id/summary" element={<SummaryPage />} />
        <Route path="/personas" element={<PersonasPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<div className="page">ページが見つかりません</div>} />
      </Routes>
      <Toasts />
    </div>
  );
}
