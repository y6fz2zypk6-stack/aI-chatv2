import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useApp } from './store';
import AlbumPage from './pages/AlbumPage';
import CalendarPage from './pages/CalendarPage';
import CharacterPage from './pages/CharacterPage';
import ChatPage from './pages/ChatPage';
import ChatsPage from './pages/ChatsPage';
import EventsPage from './pages/EventsPage';
import LocationsPage from './pages/LocationsPage';
import LoginPage from './pages/LoginPage';
import LorebookPage from './pages/LorebookPage';
import MemoriesPage from './pages/MemoriesPage';
import MemoryReviewPage from './pages/MemoryReviewPage';
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
  const { authenticated, authRequired, setAuth, setAppTitle } = useApp();

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
    <>
      <Routes>
        <Route path="/" element={<ChatsPage />} />
        <Route path="/chats" element={<ChatsPage />} />
        <Route path="/chats/:id" element={<ChatPage />} />
        <Route path="/chats/:id/state" element={<StatePage />} />
        <Route path="/chats/:id/summary" element={<SummaryPage />} />
        <Route path="/worlds" element={<WorldsPage />} />
        <Route path="/worlds/:id" element={<WorldDetailPage />} />
        <Route path="/worlds/:id/lorebook" element={<LorebookPage />} />
        <Route path="/worlds/:id/locations" element={<LocationsPage />} />
        <Route path="/worlds/:id/calendar" element={<CalendarPage />} />
        <Route path="/worlds/:id/events" element={<EventsPage />} />
        <Route path="/worlds/:id/memory-review" element={<MemoryReviewPage />} />
        <Route path="/characters/:id" element={<CharacterPage />} />
        <Route path="/characters/:id/memories" element={<MemoriesPage />} />
        <Route path="/personas" element={<PersonasPage />} />
        <Route path="/album" element={<AlbumPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<div className="empty-note">ページが見つかりません</div>} />
      </Routes>
      <Toasts />
    </>
  );
}
