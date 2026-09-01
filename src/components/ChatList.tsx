import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, store } from '../store';
import { useMessengerSocket } from '../useMessengerSocket';
import { api, type User } from '../api';
import { Avatar } from './Avatar';
import { ProfileModal, CopyTag } from './ProfileModal';
import { InfoModal } from './InfoModal';
import { ContactsModal } from './ContactsModal';
import { setTheme } from '../theme';
import { t, useLang } from '../i18n';
import { clearE2EKeyCache } from '../crypto/ensureKeys';
import { clearMediaCache } from '../media';
import { cacheChat } from '../offlineDb';
import {
  MenuIcon,
  SearchIcon,
  UserIcon,
  UsersIcon,
  SettingsIcon,
  MoonIcon,
  SparklesIcon,
  StarIcon,
  BookmarkIcon,
  LogOutIcon,
  LockIcon,
  CheckCheckIcon,
  DotsIcon,
  PlusIcon,
  ArchiveIcon,
  TrashIcon,
  CheckIcon,
  MegaphoneIcon,
  PinIcon,
} from './icons';

function fullName(u?: { first_name?: string; last_name?: string } | null): string {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || '?';
}

function peersToUsers(chats: Array<{ peer?: User | null }>): Record<number, User> {
  const users: Record<number, User> = {};
  for (const c of chats) {
    if (c.peer) users[c.peer.id] = c.peer;
  }
  return users;
}

function mediaPreview(kind?: string | null): string {
  if (kind === 'photo') return t('Photo');
  if (kind === 'audio') return t('Voice message');
  if (kind === 'file') return t('File');
  return '';
}

export function ChatList() {
  useLang();
  const { me, chats, online, activeChatId, folder, users, features } = useApp();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.searchUsers>> | null>(null);
  const [notice, setNotice] = useState('');
  const [showProfile, setShowProfile] = useState<User | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuChat, setMenuChat] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [chatOffset, setChatOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [serverDrafts, setServerDrafts] = useState<Record<number, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useMessengerSocket(me ? 'cookie' : '');

  const senderLabel = (uid: number) => {
    const u = users[uid];
    return u ? fullName(u) : '';
  };

  const effectsOn = me?.settings.effects !== false;
  const nightOn = me?.settings.theme === 'dark';

  useEffect(() => {
    document.body.classList.toggle('no-effects', !effectsOn);
  }, [effectsOn]);

  useEffect(() => {
    if (!me) return;
    api.getChats().then((cs) => {
      store.set({ chats: cs });
      store.set({ users: { ...store.get().users, ...peersToUsers(cs) } });
      setChatsLoaded(true);
      // Validate activeChatId against loaded chats
      const current = store.get().activeChatId;
      if (current != null && !cs.some((c) => c.chat.id === current)) {
        store.set({ activeChatId: null });
      }
      cs.forEach((c) => { cacheChat(c as unknown as Record<string, unknown>).catch(() => {}); });
    });
    api.getDrafts().then((drafts) => {
      const map: Record<number, string> = {};
      for (const d of drafts) { if (d.text) map[d.chat_id] = d.text; }
      setServerDrafts(map);
    }).catch(() => {});
  }, [me?.id]);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      setResults(await api.searchUsers(query));
    } catch {
      setResults([]);
    }
  };

  const openChat = async (peerId: number, kind: 'regular' | 'secret') => {
    setNotice('');
    try {
      const res = await api.createChat(peerId, kind);
      await store.set({ chats: await api.getChats() });
      await store.set({ activeChatId: res.chat.id });
      setQuery('');
      setResults(null);
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // Ignore errors — we clear local state regardless
    }
    clearE2EKeyCache(me?.id);
    clearMediaCache();
    store.set({ me: null, chats: [], messages: {}, activeChatId: null, online: {}, typing: {}, recording: {}, folder: 'all' });
  };

  const toggleNight = async () => {
    const t = nightOn ? 'light' : 'dark';
    const updated = await api.updateSettings({ theme: t });
    setTheme(t);
    store.set({ me: updated });
  };

  const toggleEffects = async () => {
    const v = !effectsOn;
    const updated = await api.updateSettings({ effects: v });
    store.set({ me: updated });
  };

  const refreshChats = async () => {
    const cs = await api.getChats();
    store.set({ chats: cs });
    store.set({ users: { ...store.get().users, ...peersToUsers(cs) } });
    setHasMore(true);
    setChatOffset(0);
  };

  const formatTime = (iso: string | undefined) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
  };

  const visible = useMemo(() => chats
    .filter((c) => {
      if (folder === 'private') return c.chat.kind === 'regular';
      if (folder === 'secret') return c.chat.kind === 'secret';
      if (folder === 'groups') return c.chat.kind === 'group';
      if (folder === 'channels') return c.chat.kind === 'channel';
      if (folder === 'archive') return c.archived;
      return !c.archived;
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)), [chats, folder]);

  // Infinite scroll — fetch next page from server
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && chatsLoaded) {
          const lastChat = visible[visible.length - 1];
          if (!lastChat) return;
          const beforeId = lastChat.chat.id;
          api.getChats({ limit: 30, before: beforeId }).then((next) => {
            if (next.length === 0) { setHasMore(false); return; }
            const st = store.get();
            const existing = new Set(st.chats.map((c) => c.chat.id));
            const newChats = next.filter((c) => !existing.has(c.chat.id));
            if (newChats.length > 0) {
              store.set({ chats: [...st.chats, ...newChats] });
              store.set({ users: { ...st.users, ...peersToUsers(newChats) } });
            } else {
              setHasMore(false);
            }
          }).catch(() => setHasMore(false));
        }
      },
      { root: el, threshold: 0.1 },
    );
    const sentinel = el.querySelector('.scroll-sentinel');
    if (sentinel) observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visible, hasMore, chatsLoaded]);

  const togglePin = async (chatId: number) => {
    const c = chats.find((x) => x.chat.id === chatId);
    if (!c) return;
    try {
      await api.setPinned(chatId, !c.pinned);
      await refreshChats();
    } catch (err) {
      alert((err as Error).message);
    }
    setMenuChat(null);
  };

  const toggleArchive = async (chatId: number) => {
    const c = chats.find((x) => x.chat.id === chatId);
    if (!c) return;
    try {
      await api.setArchived(chatId, !c.archived);
      await refreshChats();
    } catch (err) {
      alert((err as Error).message);
    }
    setMenuChat(null);
  };

  const deleteChatItem = async (chatId: number) => {
    setMenuChat(null);
    if (!confirm(t('Delete this chat?'))) return;
    try {
      await api.deleteChat(chatId);
      if (activeChatId === chatId) store.set({ activeChatId: null });
      await refreshChats();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const markRead = async (chatId: number) => {
    const st = store.get();
    const list = st.messages[chatId] ?? [];
    const last = [...list].reverse().find((m) => m.sender_id !== st.me?.id);
    if (last) {
      import('../socket').then(({ sendRead }) => sendRead(chatId, last.id));
    }
    store.set({ chats: st.chats.map((c) => (c.chat.id === chatId ? { ...c, unread: 0 } : c)) });
    setMenuChat(null);
  };

  return (
    <aside className="sidebar" aria-label={t('Chats')}>
      <div className="sidebar-top">
        <button className="icon-btn" onClick={() => setDrawerOpen((o) => !o)} aria-label={t('Menu')} title={t('Menu')}>
          <MenuIcon size={24} />
        </button>
        <form className="search" onSubmit={search} role="search">
          <input
            ref={searchRef}
            placeholder={t('Search by username, phone or name…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('Search by username, phone or name…')}
          />
          <button type="submit" className="icon-btn" aria-label={t('Search')} title={t('Search')}>
            <SearchIcon size={20} />
          </button>
        </form>
      </div>

      {results !== null && (
        <div className="search-results">
          {results.length === 0 && <div className="muted empty">{t('Nothing found')}</div>}
          {results.map((u) => (
            <div key={u.id} className="search-item">
              <button className="search-item-main" onClick={() => setShowProfile(u)}>
                <Avatar user={u} size={40} />
                <div className="search-item-info">
                  <b>{fullName(u)}</b>
                  <span className="muted">@{u.username}</span>
                </div>
              </button>
              <div className="search-actions">
                <button onClick={() => openChat(u.id, 'regular')}>{t('Chat')}</button>
                {features?.e2eSecretChats !== false && (
                <button
                  className={u.e2e_public ? '' : 'disabled'}
                  onClick={() => openChat(u.id, 'secret')}
                  disabled={!u.e2e_public}
                  title={t('Secret chat')}
                >
                  <LockIcon size={15} /> {t('Secret')}
                </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {notice && <div className="error">{notice}</div>}

      <div className="chat-list" ref={listRef} role="listbox" aria-label={t('Chats')}>
        {!chatsLoaded && (
          <>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={`skel-${i}`} className="chat-item-wrap">
                <div className="chat-item skeleton-item">
                  <div className="skeleton-avatar" />
                  <div className="chat-item-body">
                    <div className="chat-item-top">
                      <div className="skeleton-bar skeleton-bar-name" />
                    </div>
                    <div className="chat-item-bottom">
                      <div className="chat-item-preview">
                        <div className="skeleton-bar skeleton-bar-text" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
        {visible.map((item) => {
          const peer = item.peer;
          const isGroup = item.chat.kind === 'group' || item.chat.kind === 'channel';
          const isChannel = item.chat.kind === 'channel';
          const isActive = activeChatId === item.chat.id;
          const mine = item.last_message?.sender_id === me?.id;
          const lastMsgRead = mine && item.last_message?.read_at ? true : false;
          const preview = item.last_message
            ? (mediaPreview(item.last_message.media_kind) || item.last_message.preview || t('No messages yet'))
            : t('No messages yet');
          const displayUser = isGroup
            ? ({ id: item.chat.id, first_name: item.chat.title ?? '', last_name: '', photo: item.chat.photo ?? null })
            : peer;
          const displayName = isGroup
            ? (item.chat.title || t('Group'))
            : fullName(peer);
          const lastSender = item.last_message?.sender_id;
          const lastSenderName = isGroup && lastSender
            ? (lastSender === me?.id ? t('You') : senderLabel(lastSender))
            : '';
          return (
            <div key={item.chat.id} className="chat-item-wrap" role="option" aria-selected={isActive} aria-label={`${displayName}${item.unread > 0 ? `, ${item.unread} ${t('unread')}` : ''}`}>
              <button
                className={`chat-item ${isActive ? 'active' : ''}`}
                onClick={() => store.set({ activeChatId: item.chat.id })}
              >
                <Avatar user={displayUser} size={54} online={isGroup ? undefined : online[peer?.id as number]} />
                <div className="chat-item-body">
                  <div className="chat-item-top">
                    <b>{displayName}</b>
                    {item.pinned && <span className="pin-chip" title={t('Pinned')}><PinIcon size={13} /></span>}
                    <span className="time">{item.last_message ? formatTime(item.last_message.created_at) : ''}</span>
                  </div>
                  <div className="chat-item-bottom">
                    <div className="chat-item-preview">
                      {item.chat.kind === 'secret' && (
                        <span className="lock"><LockIcon size={13} /></span>
                      )}
                      {isChannel && <span className="lock"><MegaphoneIcon size={13} /></span>}
                      {isGroup && lastSenderName && <span className="mine-prefix">{lastSenderName}:</span>}
                      {!isGroup && mine && <span className="mine-prefix">{t('You: ')}</span>}
                      {serverDrafts[item.chat.id] ? (
                        <span className="draft-preview"><em>{t('Draft')}: {serverDrafts[item.chat.id].slice(0, 50)}</em></span>
                      ) : (
                        <span>{preview}</span>
                      )}
                    </div>
                    <span className="chat-item-status">
                      {!isActive && item.unread > 0 ? (
                        <span className="unread-badge">{item.unread}</span>
                      ) : mine && !isGroup ? (
                        <span className={`ticks-out${lastMsgRead ? ' read' : ''}`}>
                          {lastMsgRead ? <CheckCheckIcon size={16} /> : <CheckIcon size={16} />}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </div>
              </button>
              <button
                className="chat-item-menu icon-btn"
                title={t('More')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (menuChat === item.chat.id) {
                    setMenuChat(null);
                    setMenuPos(null);
                  } else {
                    // Record the trigger's screen position so the menu can be
                    // rendered in a portal (escaping the chat-list scroll
                    // container that would otherwise clip/hide it).
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const menuW = 208;
                    const left = Math.max(8, Math.min(window.innerWidth - menuW - 8, rect.right - menuW));
                    setMenuPos({ top: rect.bottom + 6, left });
                    setMenuChat(item.chat.id);
                  }
                }}
              >
                <DotsIcon size={18} />
              </button>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="muted empty">
            {folder === 'archive'
              ? t('Archive is empty')
              : folder === 'groups'
                ? t('No group chats yet')
                : folder === 'channels'
                  ? t('No channels yet')
                  : folder === 'secret'
                    ? t('No secret chats yet')
                    : t('No chats yet. Search for a user above.')}
          </div>
        )}
        {hasMore && <div className="scroll-sentinel" />}
      </div>

      <button className="fab" onClick={() => setShowContacts(true)} title={t('New message')}>
        <PlusIcon size={26} />
      </button>

      <div className="sidebar-bottom">
        <button className="me-btn" onClick={() => setShowProfile(me)} title={t('My profile')}>
          <Avatar user={me} size={48} online={online[me?.id as number]} />
        </button>
        <div className="me-info" onClick={() => setShowProfile(me)}>
          <b>{fullName(me)}</b>
          <span className="muted">@{me?.username}</span>
        </div>
        <button className="icon-btn" onClick={() => setDrawerOpen((o) => !o)} title={t('Menu')}>
          <DotsIcon size={22} />
        </button>
      </div>

      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
          <nav className="drawer">
            <header className="drawer-header">
              <Avatar user={me} size={64} />
              <b>{fullName(me)}</b>
              <CopyTag username={me?.username ?? ''} />
              {me?.phone && <span className="muted">{me.phone}</span>}
            </header>
            <div className="drawer-items">
              <button onClick={() => { setDrawerOpen(false); setShowProfile(me); }}>
                <span className="drawer-item-icon"><UserIcon size={22} /></span> {t('My profile')}
              </button>
              <button onClick={() => { setDrawerOpen(false); setShowContacts(true); }}>
                <span className="drawer-item-icon"><UsersIcon size={22} /></span> {t('Contacts')}
              </button>
              <button onClick={() => { setDrawerOpen(false); setShowSaved(true); }}>
                <span className="drawer-item-icon"><BookmarkIcon size={22} /></span> {t('Saved Messages')}
              </button>
              <button onClick={() => { setDrawerOpen(false); store.set({ settingsOpen: true }); }}>
                <span className="drawer-item-icon"><SettingsIcon size={22} /></span> {t('Settings')}
              </button>
            </div>
            <div className="drawer-divider" />
            <div className="drawer-items">
              <button className="drawer-toggle-row" onClick={toggleNight}>
                <span className="drawer-item-icon"><MoonIcon size={22} /></span>
                <span className="drawer-item-label">{t('Night mode')}</span>
                <span className={`toggle ${nightOn ? 'on' : ''}`} />
              </button>
              <button className="drawer-toggle-row" onClick={toggleEffects}>
                <span className="drawer-item-icon"><SparklesIcon size={22} /></span>
                <span className="drawer-item-label">{t('Interface effects')}</span>
                <span className={`toggle ${effectsOn ? 'on' : ''}`} />
              </button>
              <button onClick={() => { setDrawerOpen(false); setShowInfo(true); }}>
                <span className="drawer-item-icon"><StarIcon size={22} /></span> {t('Messenger features')}
              </button>
            </div>
            <div className="drawer-bottom">
              <button className="danger-text" onClick={logout}>
                <span className="drawer-item-icon"><LogOutIcon size={22} /></span> {t('Log out')}
              </button>
            </div>
          </nav>
        </>
      )}

      {showProfile && <ProfileModal user={showProfile} onClose={() => setShowProfile(null)} />}
      {showInfo && <InfoModal onClose={() => setShowInfo(false)} />}
      {showContacts && <ContactsModal onClose={() => setShowContacts(false)} />}
      {showSaved && <SavedMessagesModal onClose={() => setShowSaved(false)} />}

      {menuChat != null && menuPos && createPortal(
        (() => {
          const item = visible.find((it) => it.chat.id === menuChat);
          const isGroup = item ? (item.chat.kind === 'group' || item.chat.kind === 'channel') : false;
          return (
            <>
              <div className="overlay-catch" onClick={() => { setMenuChat(null); setMenuPos(null); }} />
              <div
                className="chat-context-menu"
                style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 2000, margin: 0 }}
              >
                {item ? (
                  <>
                    <button onClick={() => { toggleArchive(item.chat.id); setMenuChat(null); setMenuPos(null); }}>
                      <ArchiveIcon size={16} /> {item.archived ? t('Unarchive') : t('Archive')}
                    </button>
                    <button onClick={() => { togglePin(item.chat.id); setMenuChat(null); setMenuPos(null); }}>
                      <PinIcon size={16} /> {item.pinned ? t('Unpin chat') : t('Pin chat')}
                    </button>
                    {item.unread > 0 && (
                      <button onClick={() => { markRead(item.chat.id); setMenuChat(null); setMenuPos(null); }}>
                        <CheckIcon size={16} /> {t('Mark as read')}
                      </button>
                    )}
                    <button className="danger-text" onClick={() => { deleteChatItem(item.chat.id); setMenuChat(null); setMenuPos(null); }}>
                      <TrashIcon size={16} /> {isGroup ? t('Leave group') : t('Delete chat')}
                    </button>
                  </>
                ) : null}
              </div>
            </>
          );
        })(),
        document.body,
      )}
    </aside>
  );
}

function SavedMessagesModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Array<{ id: number; body: string | null; created_at: string; message_id: number | null; chat_id: number | null }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getSaved().then((r) => { setItems(r as any[]); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const remove = async (id: number) => {
    await api.removeSaved(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '95%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h3>{t('Saved Messages')}</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div style={{ overflow: 'auto', flex: 1, padding: '8px 0' }}>
          {loading && <div className="muted" style={{ padding: 16 }}>{t('Loading…')}</div>}
          {!loading && items.length === 0 && <div className="muted" style={{ padding: 16 }}>{t('No saved messages yet')}</div>}
          {items.map((item) => (
            <div key={item.id} className="search-item" style={{ alignItems: 'flex-start' }}>
              <div className="search-item-info" style={{ flex: 1 }}>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.body || t('Media')}</div>
                <span className="muted" style={{ fontSize: 12 }}>{new Date(item.created_at).toLocaleString()}</span>
              </div>
              <button className="icon-btn danger-text" onClick={() => remove(item.id)} title={t('Remove')}>✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
