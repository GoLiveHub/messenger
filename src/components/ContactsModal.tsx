import { useApp, store } from '../store';
import { Avatar } from './Avatar';
import { api, type User } from '../api';
import { CloseIcon, UsersIcon, SearchIcon, LockIcon, MegaphoneIcon, DownloadIcon } from './icons';
import { useMemo, useRef, useState } from 'react';
import { t, useLang } from '../i18n';
import { useFocusTrap, useEscapeKey } from '../hooks';
import { NewGroupModal } from './NewGroupModal';

export function ContactsModal({ onClose }: { onClose: () => void }) {
  const { chats, online, features } = useApp();
  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Awaited<ReturnType<typeof api.searchUsers>> | null>(null);
  const [notice, setNotice] = useState('');
  const [newGroupKind, setNewGroupKind] = useState<'group' | 'channel' | null>(null);

  const contacts = useMemo(() => {
    const seen = new Map<number, { user: User; chatId: number }>();
    for (const c of chats) {
      const p = c.peer;
      if (p && !seen.has(p.id)) seen.set(p.id, { user: p, chatId: c.chat.id });
    }
    const list = [...seen.values()];
    if (!q.trim()) return list;
    const ql = q.toLowerCase();
    return list.filter(({ user }) =>
      user.username.toLowerCase().includes(ql) ||
      `${user.first_name} ${user.last_name}`.toLowerCase().includes(ql),
    );
  }, [chats, q]);

  const runSearch = async () => {
    if (!q.trim()) {
      setFound(null);
      return;
    }
    try {
      setFound(await api.searchUsers(q));
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const open = (chatId: number) => {
    store.set({ activeChatId: chatId });
    onClose();
  };

  const creatingRef = useRef(false);
  const start = async (peerId: number, kind: 'regular' | 'secret') => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setNotice('');
    try {
      const res = await api.createChat(peerId, kind);
      store.set({ chats: await api.getChats() });
      store.set({ activeChatId: res.chat.id });
      onClose();
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      creatingRef.current = false;
    }
  };

  const isContact = (id: number) => contacts.some((c) => c.user.id === id);
  const searchItems = found ? found.filter((u) => !isContact(u.id)) : [];

  const importPhoneContacts = async () => {
    try {
      // Try browser Contacts API (Chrome/Edge on Android/desktop)
      if ('contacts' in navigator && 'ContactsManager' in globalThis) {
        const props = ['name', 'tel'];
        const opts = { multiple: true };
        // @ts-expect-error Contacts API
        const raw = await navigator.contacts.select(props, opts);
        const phones = raw.flatMap((c: any) => c.tel ?? []).filter(Boolean);
        if (phones.length) {
          const res = await api.importPhoneContacts(phones);
          setNotice(t('Imported {n} contacts').replace('{n}', String(res.matched)));
          if (res.users.length) {
            store.set({ chats: await api.getChats() });
          }
          return;
        }
      }
      // Fallback: manual paste
      const input = prompt(t('Paste phone numbers (comma-separated):'));
      if (!input) return;
      const phones = input.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      if (!phones.length) return;
      const res = await api.importPhoneContacts(phones);
      setNotice(t('Imported {n} contacts').replace('{n}', String(res.matched)));
      if (res.users.length) {
        store.set({ chats: await api.getChats() });
      }
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('New message')}>
      <div className="modal contacts-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <div className="contacts-head">
          <span className="contacts-head-icon"><UsersIcon size={22} /></span>
          <h2>{t('New message')}</h2>
        </div>
        <div className="contacts-create">
          <button onClick={() => setNewGroupKind('group')} title={t('New group')}>
            <UsersIcon size={17} /> {t('New group')}
          </button>
          <button onClick={() => setNewGroupKind('channel')} title={t('New channel')}>
            <MegaphoneIcon size={17} /> {t('New channel')}
          </button>
          <button onClick={importPhoneContacts} title={t('Import contacts')}>
            <DownloadIcon size={17} /> {t('Import contacts')}
          </button>
        </div>
        <form
          className="contacts-search"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <span className="contacts-search-icon"><SearchIcon size={17} /></span>
          <input
            placeholder={t('Search users…')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!e.target.value) setFound(null);
            }}
            autoFocus
          />
        </form>
        {notice && <div className="error">{notice}</div>}
        <div className="contacts-list">
          {q.trim() && found !== null && searchItems.length === 0 && (
            <div className="muted empty">{t('No users found')}</div>
          )}
          {searchItems.map((u) => (
            <div className="contact-row" key={u.id}>
              <div className="contact-main" onClick={() => { void start(u.id, 'regular'); }}>
                <Avatar user={u} size={46} online={online[u.id]} />
                <div className="contact-info">
                  <b>{[u.first_name, u.last_name].filter(Boolean).join(' ') || t('Unknown')}</b>
                  <span className="muted">@{u.username}</span>
                </div>
              </div>
              <div className="contact-actions">
                <button onClick={() => { void start(u.id, 'regular'); }}>{t('Message')}</button>
                {u.e2e_public && features?.e2eSecretChats !== false && (
                  <button className={u.e2e_public ? '' : 'disabled'} onClick={() => { void start(u.id, 'secret'); }} title={t('Secret chat')}>
                    <LockIcon size={13} /> {t('Secret')}
                  </button>
                )}
              </div>
            </div>
          ))}
          {!q.trim() && contacts.length === 0 && (
            <div className="muted empty">{t('No contacts yet — start a chat from search.')}</div>
          )}
          {!q.trim() &&
            contacts.map(({ user, chatId }) => (
              <div className="contact-row" key={user.id} onClick={() => open(chatId)}>
                <Avatar user={user} size={46} online={online[user.id]} />
                <div className="contact-info">
                  <b>{[user.first_name, user.last_name].filter(Boolean).join(' ') || t('Unknown')}</b>
                  <span className="muted">@{user.username}</span>
                </div>
                <span className={`contact-status${online[user.id] ? ' online' : ''}`}>
                  {online[user.id] ? t('online') : t('offline')}
                </span>
              </div>
            ))}
        </div>
        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
      </div>
      {newGroupKind && <NewGroupModal kind={newGroupKind} onClose={() => setNewGroupKind(null)} />}
    </div>
  );
}
