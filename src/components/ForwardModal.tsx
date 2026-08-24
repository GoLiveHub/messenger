import { useState } from 'react';
import type { MediaDTO } from '../api';
import { useApp } from '../store';
import { api } from '../api';
import { sendMessage } from '../socket';
import { useFocusTrap, useEscapeKey } from '../hooks';
import { Avatar } from './Avatar';
import { CloseIcon, ForwardIcon, UsersIcon, MegaphoneIcon, LockIcon } from './icons';
import { t, useLang } from '../i18n';

export interface ForwardTarget {
  chatId: number;
  messageId: number;
  text: string;
  media: MediaDTO | null;
  senderId: number;
  senderName: string;
}

export function ForwardModal({ forward, onClose }: { forward: ForwardTarget; onClose: () => void }) {
  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  const { chats, online } = useApp();
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState('');

  const targets = chats.filter((c) => {
    if (c.chat.id === forward.chatId) return false;
    if (c.chat.kind === 'regular') return true;
    if (c.chat.kind === 'group') return true;
    if (c.chat.kind === 'channel') return c.role === 'owner' || c.role === 'admin';
    return false;
  });

  const doForward = async (targetId: number) => {
    setSending(targetId);
    setError('');
    try {
      if (forward.media) {
        const { media } = await api.forwardMedia(forward.media.id, targetId);
        await sendMessage({ chatId: targetId, text: forward.text || undefined, mediaId: media.id, forwardMessageId: forward.messageId });
      } else {
        await sendMessage({ chatId: targetId, text: forward.text, forwardMessageId: forward.messageId });
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(null);
    }
  };

  const label = (c: (typeof chats)[number]) => {
    if (c.chat.kind === 'group') return t('Group');
    if (c.chat.kind === 'channel') return t('Channel');
    if (c.chat.kind === 'secret') return t('Secret chat');
    return '@' + (c.peer?.username ?? '');
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('Forward to')}>
      <div className="modal forward-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <div className="forward-head">
          <span className="forward-head-icon"><ForwardIcon size={22} /></span>
          <h2>{t('Forward to')}</h2>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="forward-list">
          {targets.length === 0 && <div className="muted empty">{t('No chats to forward to')}</div>}
          {targets.map((c) => (
            <button
              key={c.chat.id}
              className="forward-row"
              disabled={sending === c.chat.id}
              onClick={() => doForward(c.chat.id)}
            >
              {c.chat.kind === 'group' || c.chat.kind === 'channel' ? (
                <span className="forward-avatar-wrap">
                  <span className="forward-avatar-icon">
                    {c.chat.kind === 'channel' ? <MegaphoneIcon size={22} /> : <UsersIcon size={22} />}
                  </span>
                  <Avatar
                    user={{ first_name: c.chat.title ?? '', last_name: '', photo: c.chat.photo ?? null }}
                    size={44}
                  />
                </span>
              ) : (
                <Avatar user={c.peer} size={44} online={online[c.peer?.id as number]} />
              )}
              <div className="forward-info">
                <b>
                  {c.chat.kind === 'group' || c.chat.kind === 'channel'
                    ? (c.chat.title || t('Group'))
                    : ([c.peer!.first_name, c.peer!.last_name].filter(Boolean).join(' ') || '?')}
                </b>
                <span className="muted">
                  {c.chat.kind === 'secret' && <LockIcon size={13} />} {label(c)}
                </span>
              </div>
              {sending === c.chat.id && <span className="muted">{t('Sending…')}</span>}
            </button>
          ))}
        </div>
        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
      </div>
    </div>
  );
}
