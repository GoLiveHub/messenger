import { lazy, Suspense, useEffect, useState } from 'react';
import { AuthPage } from './components/AuthPage';
import { ChatList } from './components/ChatList';
import { ChatWindow } from './components/ChatWindow';
import { CallWindow } from './components/CallWindow';
import { LeftRail } from './components/LeftRail';
import { InstallPrompt } from './components/InstallPrompt';
import { api } from './api';
import { store, useApp } from './store';
import { currentTheme, applyTheme } from './theme';
import { setLang, t } from './i18n';
import { clearE2EKeyCache, ensureE2EKeys } from './crypto/ensureKeys';
import { clearMediaCache } from './media';
import { registerPushNotifications } from './pushClient';

const DEFAULT_WIDTH = 408;
const MIN_WIDTH = 300;
const MAX_WIDTH = 440;

const ChatInfoPanel = lazy(() =>
  import('./components/ChatInfoPanel').then((module) => ({ default: module.ChatInfoPanel })),
);
const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((module) => ({ default: module.SettingsModal })),
);
const AdminPanel = lazy(() =>
  import('./components/AdminPanel').then((module) => ({ default: module.AdminPanel })),
);

function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem('sidebarWidth'));
    return Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export default function App() {
  const { me, settingsOpen, infoOpen, adminOpen, activeChatId, activeCall, features } = useApp();
  const [hydrated, setHydrated] = useState(false);
  const [sidebarW, setSidebarW] = useState(savedWidth);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    // Session is now maintained via HttpOnly cookies.
    // Try to load user profile using the cookie-based session.
    api
      .me()
      .then((user) => {
        applyTheme(user.settings?.theme ?? currentTheme());
        setLang(user.settings?.lang ?? 'ru');
        if (user.settings?.rtl) document.documentElement.dir = 'rtl';
        store.set({ me: user });
        void ensureE2EKeys(user.id).catch(() => {});
        void registerPushNotifications();
        // Load feature flags
        api.getFeatures().then((features) => store.set({ features })).catch(() => {});
      })
      .catch(() => {
        // No valid session cookie — user needs to log in.
        clearE2EKeyCache();
      })
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      clearE2EKeyCache();
      clearMediaCache();
      store.set({
        me: null,
        chats: [],
        messages: {},
        activeChatId: null,
        online: {},
        typing: {},
        infoOpen: false,
        settingsOpen: false,
        adminOpen: false,
      });
    };
    window.addEventListener('messenger:unauthorized', onUnauthorized);
    return () => window.removeEventListener('messenger:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    if (!me) return;
    try {
      const saved = localStorage.getItem('activeChatId');
      if (saved !== null) {
        const id = Number(saved);
        if (Number.isFinite(id) && id > 0) {
          store.set({ activeChatId: id });
        }
      }
    } catch { /* ignore */ }
  }, [me?.id]);

  useEffect(() => {
    try {
      if (activeChatId != null) {
        localStorage.setItem('activeChatId', String(activeChatId));
      } else {
        localStorage.removeItem('activeChatId');
      }
    } catch { /* ignore */ }
  }, [activeChatId]);

  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const rail = 60;
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX - rail));
      setSidebarW(w);
      try {
        localStorage.setItem('sidebarWidth', String(w));
      } catch {
        /* ignore */
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!hydrated) {
    return (
      <div className="app-loader" role="status" aria-label="Loading Messenger">
        <span className="app-loader-mark">M</span>
        <span className="app-loader-dot" />
      </div>
    );
  }
  if (!me) return <AuthPage />;

  return (
    <div className={`app${activeChatId ? ' has-active-chat' : ''}`} style={{ ['--sidebar-w' as string]: `${sidebarW}px` }}>
      {isOffline && <div className="offline-banner">{t('You are offline')}</div>}
      <LeftRail />
      <ChatList />
      <div className="resizer" onMouseDown={startResize} onDoubleClick={() => setSidebarW(DEFAULT_WIDTH)} />
      <div className="chat-area">
        <ChatWindow />
        {infoOpen && <Suspense fallback={null}><ChatInfoPanel /></Suspense>}
      </div>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal onClose={() => store.set({ settingsOpen: false })} />
        </Suspense>
      )}
      {adminOpen && me?.is_admin && (
        <Suspense fallback={null}>
          <AdminPanel onClose={() => store.set({ adminOpen: false })} />
        </Suspense>
      )}
      {features?.calls !== false && activeCall && <CallWindow />}
      <InstallPrompt />
    </div>
  );
}
