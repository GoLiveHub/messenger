import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { store, useApp, type FolderId } from '../store';
import { ChatIcon, UserIcon, LockIcon, ArchiveIcon, SettingsIcon, UsersIcon, MegaphoneIcon } from './icons';
import { t, useLang } from '../i18n';

const FOLDERS: Array<{ id: FolderId; icon: (p: { size?: number }) => ReactElement; label: string }> = [
  { id: 'all', icon: (p) => <ChatIcon {...p} />, label: 'All chats' },
  { id: 'private', icon: (p) => <UserIcon {...p} />, label: 'Private' },
  { id: 'groups', icon: (p) => <UsersIcon {...p} />, label: 'Groups' },
  { id: 'channels', icon: (p) => <MegaphoneIcon {...p} />, label: 'Channels' },
  { id: 'secret', icon: (p) => <LockIcon {...p} />, label: 'Secret' },
  { id: 'archive', icon: (p) => <ArchiveIcon {...p} />, label: 'Archive' },
];

function unreadForFolder(chats: ReturnType<typeof useApp>['chats'], folderId: FolderId): number {
  return chats
    .filter((c) => {
      if (folderId === 'private') return c.chat.kind === 'regular';
      if (folderId === 'secret') return c.chat.kind === 'secret';
      if (folderId === 'groups') return c.chat.kind === 'group';
      if (folderId === 'channels') return c.chat.kind === 'channel';
      if (folderId === 'archive') return c.archived;
      return !c.archived;
    })
    .reduce((sum, c) => sum + c.unread, 0);
}

export function LeftRail() {
  useLang();
  const { folder, chats } = useApp();

  const totalUnread = chats.reduce((s, c) => s + c.unread, 0);

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Messenger` : 'Messenger';
  }, [totalUnread]);

  return (
    <nav className="left-rail" aria-label={t('Chat folders')}>
      <div className="left-rail-items" role="tablist" aria-label={t('Chat folders')}>
        {FOLDERS.map((f) => {
          const unread = unreadForFolder(chats, f.id);
          return (
            <button
              key={f.id}
              role="tab"
              aria-selected={folder === f.id}
              aria-label={`${t(f.label)}${unread > 0 ? `, ${unread} ${t('unread')}` : ''}`}
              className={`rail-item${folder === f.id ? ' active' : ''}`}
              title={t(f.label)}
              onClick={() => store.set({ folder: f.id })}
            >
              <f.icon size={24} />
              {unread > 0 && <span className="rail-unread-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
            </button>
          );
        })}
      </div>
      <div className="left-rail-bottom">
        <button className="rail-item" aria-label={t('Settings')} title={t('Settings')} onClick={() => store.set({ settingsOpen: true })}>
          <SettingsIcon size={24} />
        </button>
      </div>
    </nav>
  );
}
