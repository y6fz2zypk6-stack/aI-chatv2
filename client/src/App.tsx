import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import { api } from './api';
import { ConfirmHost } from './components';
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
import AutoplayPage from './pages/settings/AutoplayPage';
import BudgetPage from './pages/settings/BudgetPage';
import DefaultPersonaPage from './pages/settings/DefaultPersonaPage';
import EventsFlagsPage from './pages/settings/EventsFlagsPage';
import LoreSettingsPage from './pages/settings/LoreSettingsPage';
import ModelsPage from './pages/settings/ModelsPage';
import SettingsHome from './pages/settings/SettingsHome';
import SnapshotSettingsPage from './pages/settings/SnapshotSettingsPage';
import StateSettingsPage from './pages/settings/StateSettingsPage';
import SummaryMemoryPage from './pages/settings/SummaryMemoryPage';
import SummaryPolicyPage from './pages/settings/SummaryPolicyPage';
import SystemPromptPage from './pages/settings/SystemPromptPage';
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
        <ConfirmHost />
      </>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/" element={<ChatsPage />} />
        <Route path="/chats" element={<ChatsPage />} />
        <Route path="/chats/archive" element={<ChatsPage archived />} />
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
        <Route path="/settings" element={<SettingsHome />} />
        <Route path="/settings/models" element={<ModelsPage />} />
        <Route path="/settings/persona" element={<DefaultPersonaPage />} />
        <Route path="/settings/system-prompt" element={<SystemPromptPage />} />
        <Route path="/settings/state" element={<StateSettingsPage />} />
        <Route path="/settings/events" element={<EventsFlagsPage />} />
        <Route path="/settings/lorebook" element={<LoreSettingsPage />} />
        <Route path="/settings/summary" element={<SummaryMemoryPage />} />
        <Route path="/settings/summary/policy" element={<SummaryPolicyPage />} />
        <Route path="/settings/autoplay" element={<AutoplayPage />} />
        <Route path="/settings/snapshot" element={<SnapshotSettingsPage />} />
        <Route path="/settings/budget" element={<BudgetPage />} />
        <Route path="*" element={<div className="empty-note">ページが見つかりません</div>} />
      </Routes>
      <Toasts />
      <ConfirmHost />
    </>
  );
}
