import { useEffect, useMemo, useState } from 'react';
import { store, useApp, setGroupMembers } from '../store';
import { api, type MediaDTO } from '../api';
import { initCall } from '../socket';
import { Avatar } from './Avatar';
import { MediaImage } from './MediaImage';
import { MediaGallery } from './MediaGallery';
import { VoicePlayer } from './VoicePlayer';
import { AddMembersModal } from './AddMembersModal';
import { EditGroupModal } from './EditGroupModal';
import {
  CloseIcon,
  LockIcon,
  BanIcon,
  CheckIcon,
  ArchiveIcon,
  PhoneIcon,
  VideoIcon,
  CrownIcon,
  ExitIcon,
  PersonPlusIcon,
  PencilIcon,
  MegaphoneIcon,
  ShieldIcon,
} from './icons';
import { t, tx, useLang } from '../i18n';
import { safetyNumber } from '../crypto/e2e';
import { ensureE2EKeys } from '../crypto/ensureKeys';

function fullName(u?: { first_name?: string; last_name?: string } | null): string {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || '?';
}

export function ChatInfoPanel() {
  useLang();
  const { activeChatId, chats, messages, online, me, groupMembers, features } = useApp();
  const [blocked, setBlocked] = useState(false);
  const [archived, setArchived] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryMedia, setGalleryMedia] = useState<MediaDTO | null>(null);
  const [safetyNum, setSafetyNum] = useState<string | null>(null);
  const [prevFp, setPrevFp] = useState<string | null>(null);
  const [fpWarning, setFpWarning] = useState(false);

  const chat = chats.find((c) => c.chat.id === activeChatId);
  const peer = chat?.peer ?? null;
  const isGroup = chat ? (chat.chat.kind === 'group' || chat.chat.kind === 'channel') : false;
  const isChannel = chat?.chat.kind === 'channel';
  const isSecret = chat?.chat.kind === 'secret';
  const myRole = chat?.role ?? null;
  const canManage = myRole === 'owner' || myRole === 'admin';

  const members = activeChatId ? (groupMembers[activeChatId] ?? []) : [];

  useEffect(() => {
    setArchived(Boolean(chat?.archived));
  }, [chat?.archived]);

  useEffect(() => {
    if (!activeChatId || !isGroup) return;
    api
      .getChatInfo(activeChatId)
      .then((info) => {
        setGroupMembers(info.chat.chat.id, info.members);
        const users: Record<number, (typeof info.members)[number]['user']> = {};
        info.members.forEach((m) => {
          users[m.user.id] = m.user;
        });
        store.set({ users: { ...store.get().users, ...users } });
      })
      .catch(() => {});
  }, [activeChatId, isGroup]);

  useEffect(() => {
    if (!peer || isGroup) return;
    api
      .getBlocks()
      .then((list) => setBlocked(list.some((b) => b.id === peer.id)))
      .catch(() => {});
  }, [peer?.id, isGroup]);

  // Safety number + key change detection for secret chats
  useEffect(() => {
    if (!isSecret || !peer?.e2e_public || !me?.e2e_public) return;
    let cancelled = false;
    (async () => {
      try {
        const keys = await ensureE2EKeys(me.id);
        const sn = await safetyNumber(keys.publicJwk, peer.e2e_public!);
        if (!cancelled) setSafetyNum(sn);
        // Check key change
        const fpKey = `e2e-fp:${me.id}:${peer.id}`;
        const storedFp = localStorage.getItem(fpKey);
        if (storedFp && storedFp !== peer.e2e_fp) {
          setFpWarning(true);
          setPrevFp(storedFp);
        }
        localStorage.setItem(fpKey, peer.e2e_fp ?? '');
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [isSecret, peer?.e2e_fp, me?.id]);

  const media = useMemo(() => {
    const list = activeChatId ? (messages[activeChatId] ?? []) : [];
    return list
      .filter((m) => m.media)
      .map((m) => m.media!)
      .sort((a, b) => b.id - a.id);
  }, [activeChatId, messages]);

  if (!activeChatId || (!peer && !isGroup)) return null;
  if (!isGroup && !peer) return null;

  const close = () => store.set({ infoOpen: false });

  const toggleBlock = async () => {
    if (!peer) return;
    try {
      if (blocked) await api.removeBlock(peer.id);
      else await api.addBlock(peer.id);
      setBlocked(!blocked);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const toggleArchive = async () => {
    try {
      await api.setArchived(activeChatId, !archived);
      const chats = await api.getChats();
      store.set({ chats });
      setArchived(!archived);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const startSecret = async () => {
    if (!peer) return;
    try {
      const res = await api.createChat(peer.id, 'secret');
      const chats = await api.getChats();
      store.set({ chats, activeChatId: res.chat.id });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const leaveGroup = async () => {
    if (!activeChatId) return;
    if (!confirm(t('Leave this group?'))) return;
    try {
      await api.deleteChat(activeChatId);
      const chats = await api.getChats();
      store.set({ chats, activeChatId: null, infoOpen: false });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const removeMember = async (userId: number) => {
    if (!activeChatId) return;
    if (!confirm(t('Remove from group?'))) return;
    try {
      const res = await api.removeGroupMember(activeChatId, userId);
      if ('members' in res) setGroupMembers(res.chat.chat.id, res.members);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const promoteMember = async (userId: number, role: 'admin' | 'member') => {
    if (!activeChatId) return;
    try {
      const info = await api.promoteMember(activeChatId, userId, role);
      setGroupMembers(info.chat.chat.id, info.members);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const transferOwnership = async (userId: number) => {
    if (!activeChatId || !confirm(t('Transfer ownership to this member?'))) return;
    try {
      const info = await api.transferGroupOwnership(activeChatId, userId);
      setGroupMembers(info.chat.chat.id, info.members);
      const chats = await api.getChats();
      store.set({ chats });
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const groupAvatar = { id: chat!.chat.id, first_name: chat!.chat.title ?? '', last_name: '', photo: chat!.chat.photo ?? null };

  return (
    <aside className="info-panel">
      <div className="info-panel-head">
        <button className="icon-btn" onClick={close} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
        <b>{isGroup ? (isChannel ? t('Channel info') : t('Group info')) : t('Details')}</b>
      </div>

      {isGroup ? (
        <>
          <div className="info-avatar">
            <Avatar user={groupAvatar} size={96} />
            <b className="info-name">{chat!.chat.title || t('Group')}</b>
            <span className="muted">
              {isChannel && <MegaphoneIcon size={14} />} {tx('N members', { n: chat!.member_count ?? members.length })}
            </span>
            {myRole === 'owner' && <span className="info-role owner">{t('You are the owner')}</span>}
            {myRole === 'admin' && <span className="info-role admin">{t('You are an admin')}</span>}
          </div>

          {chat!.chat.about && (
            <div className="info-section">
              <div className="info-row">
                <span className="info-row-label">{t('About group…')}</span>
                <span className="info-row-value">{chat!.chat.about}</span>
              </div>
            </div>
          )}

          <div className="info-actions">
            {canManage && (
              <button className="info-action" onClick={() => setShowAdd(true)}>
                <PersonPlusIcon size={15} /> {t('Add members')}
              </button>
            )}
            {canManage && (
              <button className="info-action" onClick={() => setShowEdit(true)}>
                <PencilIcon size={15} /> {t('Edit info')}
              </button>
            )}
            <button className="info-action" onClick={toggleArchive}>
              <ArchiveIcon size={15} /> {archived ? t('Unarchive') : t('Archive')}
            </button>
            <button className="info-action danger" onClick={leaveGroup}>
              <ExitIcon size={15} /> {t('Leave group')}
            </button>
          </div>

          <div className="info-section">
            <b className="info-section-title">
              {t('Members')} — {members.length}
            </b>
            {members.length === 0 && <span className="muted empty">{t('No participants')}</span>}
            {members.map((m) => (
              <div key={m.user.id} className="member-row">
                <Avatar user={m.user} size={40} online={online[m.user.id]} />
                <div className="member-row-info">
                  <b>
                    {fullName(m.user)}
                    {m.user.id === me?.id && <span className="muted"> ({t('you')})</span>}
                  </b>
                  {m.role === 'owner' && (
                    <span className="member-role owner"><CrownIcon size={13} /> {t('Owner')}</span>
                  )}
                  {m.role === 'admin' && <span className="member-role admin">{t('Admin')}</span>}
                </div>
                {myRole === 'owner' && m.role !== 'owner' && m.user.id !== me?.id && (
                  <div className="member-actions">
                    <button className="icon-btn" title={t('Transfer ownership')} onClick={() => transferOwnership(m.user.id)}>
                      <CrownIcon size={15} />
                    </button>
                    {m.role === 'admin' ? (
                      <button className="icon-btn" title={t('Demote to member')} onClick={() => promoteMember(m.user.id, 'member')}>
                        <BanIcon size={15} />
                      </button>
                    ) : (
                      <button className="icon-btn" title={t('Promote to admin')} onClick={() => promoteMember(m.user.id, 'admin')}>
                        <CrownIcon size={15} />
                      </button>
                    )}
                  </div>
                )}
                {canManage && m.role !== 'owner' && m.user.id !== me?.id && (
                  <button className="icon-btn danger-text" title={t('Remove')} onClick={() => removeMember(m.user.id)}>
                    <ExitIcon size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="info-avatar">
            <Avatar user={peer} size={96} online={online[peer!.id]} />
            <b className="info-name">{fullName(peer)}</b>
            <span className="muted">@{peer!.username}</span>
            <span className={`info-status${online[peer!.id] ? ' online' : ''}`}>
              {online[peer!.id]
                ? t('online')
                : peer!.last_seen_visible === false
                  ? t('Last seen recently')
                  : t('offline')}
            </span>
          </div>

          <div className="info-actions">
            {isSecret && (
              <span className="info-chip" title={t('Secret chat — end-to-end encrypted')}>
                <LockIcon size={14} /> {t('Secret chat')}
              </span>
            )}
            {isSecret && fpWarning && (
              <div className="fp-warning">
                <ShieldIcon size={14} />
                <span>{t('Security number changed. Verify with peer.')}</span>
              </div>
            )}
            {isSecret && safetyNum && (
              <details className="safety-number-section">
                <summary><ShieldIcon size={14} /> {t('View safety number')}</summary>
                <div className="safety-number-box">
                  <SafetyNumberVisual value={safetyNum} />
                  <code className="safety-number">{safetyNum}</code>
                  <div className="safety-number-actions">
                    <button className="mini" onClick={() => {
                      navigator.clipboard.writeText(safetyNum).then(() => {}).catch(() => {});
                    }}>{t('Copy')}</button>
                    <button className="mini" onClick={() => {
                      const verifiedKey = `e2e-verified:${me!.id}:${peer!.id}`;
                      try { localStorage.setItem(verifiedKey, '1'); } catch { /* ignore */ }
                      alert(t('Peer verified'));
                    }}>{t('Verify')}</button>
                  </div>
                </div>
              </details>
            )}
            {!isSecret && peer!.e2e_public && features?.e2eSecretChats !== false && (
              <button className="info-action" onClick={startSecret}>
                <LockIcon size={15} /> {t('Start secret chat')}
              </button>
            )}
            <button className={`info-action${blocked ? ' danger' : ''}`} onClick={toggleBlock}>
              {blocked ? <CheckIcon size={15} /> : <BanIcon size={15} />} {blocked ? t('Unblock') : t('Block')}
            </button>
            <button className="info-action" onClick={toggleArchive}>
              <ArchiveIcon size={15} /> {archived ? t('Unarchive') : t('Archive')}
            </button>
          </div>

          <div className="info-section">
            <div className="info-row">
              <span className="info-row-label">{t('Phone')}</span>
              <span className={`info-row-value${peer!.phone ? '' : ' muted'}`}>
                {peer!.phone
                  ? `${peer!.phone}${peer!.phone === me?.phone ? ` (${t('you')})` : ''}`
                  : t('Hidden')}
              </span>
            </div>
            {peer!.birthday && (
              <div className="info-row">
                <span className="info-row-label">{t('Birthday')}</span>
                <span className="info-row-value">{peer!.birthday}</span>
              </div>
            )}
            {peer!.bio && (
              <div className="info-row">
                <span className="info-row-label">{t('Bio')}</span>
                <span className="info-row-value">{peer!.bio}</span>
              </div>
            )}
          </div>
        </>
      )}

      <div className="info-section info-media">
        <b className="info-section-title">{t('Shared media')}</b>
        {media.length === 0 ? (
          <span className="muted empty">{t('No media yet')}</span>
        ) : (
          <>
            <div className="info-media-grid">
              {media
                .filter((m) => m.kind === 'photo')
                .map((m) => (
                  <MediaImage key={m.id} media={m} className="info-media-thumb" onClick={() => { setGalleryMedia(m); setGalleryOpen(true); }} />
                ))}
            </div>
            <div className="info-media-audios">
              {media
                .filter((m) => m.kind === 'audio')
                .map((m) => (
                  <VoicePlayer key={m.id} media={m} />
                ))}
            </div>
            {media.length >= 5 && (
              <button className="mini" onClick={() => { setGalleryMedia(null); setGalleryOpen(true); }}>{t('View all')}</button>
            )}
          </>
        )}
      </div>

      {isGroup && (
        <div className="info-section">
          <b className="info-section-title">{t('Notifications')}</b>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['all', 'mentions', 'none'] as const).map((lv) => (
              <button
                key={lv}
                className={`mini${chat?.notify_level === lv ? ' primary' : ''}`}
                onClick={async () => {
                  if (!activeChatId) return;
                  await api.setNotifyLevel(activeChatId, lv);
                  store.set({
                    chats: (store.get().chats).map((c) =>
                      c.chat.id === activeChatId ? { ...c, notify_level: lv } : c,
                    ),
                  });
                }}
              >
                {lv === 'all' ? t('All') : lv === 'mentions' ? t('Mentions') : t('None')}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isGroup && peer!.phone && features?.calls !== false && (
        <div className="info-call">
          <button
            className="info-call-btn"
            onClick={() => {
              if (activeChatId) {
                initCall(activeChatId, 'audio');
                store.set({
                  activeCall: {
                    callId: '',
                    chatId: activeChatId,
                    callType: 'audio',
                    callerId: me!.id,
                    callerName: fullName(me),
                    direction: 'outgoing',
                    status: 'ringing',
                  },
                });
              }
            }}
            title={t('Voice call')}
          >
            <PhoneIcon size={16} />
            <span>{t('Voice call')}</span>
          </button>
          <button
            className="info-call-btn"
            onClick={() => {
              if (activeChatId) {
                initCall(activeChatId, 'video');
                store.set({
                  activeCall: {
                    callId: '',
                    chatId: activeChatId,
                    callType: 'video',
                    callerId: me!.id,
                    callerName: fullName(me),
                    direction: 'outgoing',
                    status: 'ringing',
                  },
                });
              }
            }}
            title={t('Video call')}
          >
            <VideoIcon size={16} />
            <span>{t('Video call')}</span>
          </button>
        </div>
      )}

      {showAdd && activeChatId && <AddMembersModal chatId={activeChatId} onClose={() => setShowAdd(false)} />}
      {showEdit && activeChatId && <EditGroupModal chatId={activeChatId} onClose={() => setShowEdit(false)} />}
      {galleryOpen && activeChatId && <MediaGallery chatId={activeChatId} initialMedia={galleryMedia ?? undefined} onClose={() => setGalleryOpen(false)} />}
    </aside>
  );
}

function SafetyNumberVisual({ value }: { value: string }) {
  const colors = ['#4caf50', '#2196f3', '#ff9800', '#e91e63', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b'];
  const cells: React.ReactNode[] = [];
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < 25; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    const color = colors[Math.abs(hash) % colors.length];
    cells.push(
      <div key={i} style={{ width: 20, height: 20, borderRadius: 4, background: color }} />,
    );
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4, marginBottom: 8, padding: 8, background: 'var(--bg, #fff)', borderRadius: 8 }}>
      {cells}
    </div>
  );
}
