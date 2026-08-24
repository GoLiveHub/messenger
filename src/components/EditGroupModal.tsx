import { useState } from 'react';
import { useApp, store } from '../store';
import { api } from '../api';
import { Avatar } from './Avatar';
import { CloseIcon, PencilIcon, ImageIcon } from './icons';
import { t, useLang } from '../i18n';
import { loadImage, resizeToDataUrl } from '../lib/image';
import { useFocusTrap, useEscapeKey } from '../hooks';

export function EditGroupModal({ chatId, onClose }: { chatId: number; onClose: () => void }) {
  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  const { chats } = useApp();
  const entry = chats.find((c) => c.chat.id === chatId);
  const isChannel = entry?.chat.kind === 'channel';
  const [title, setTitle] = useState(entry?.chat.title ?? '');
  const [about, setAbout] = useState(entry?.chat.about ?? '');
  const [photo, setPhoto] = useState<string | null>(entry?.chat.photo ?? null);
  const [username, setUsername] = useState(entry?.chat.username ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!entry) return null;

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const img = await loadImage(file);
      setPhoto(resizeToDataUrl(img, 512, 0.85));
    } catch {
      setError('Bad image');
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.editGroup(chatId, {
        title: title.trim() || (entry.chat.title ?? ''),
        about: about.trim(),
        photo,
        username: username.trim() || undefined,
      });
      store.set({ chats: await api.getChats() });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={isChannel ? t('Channel settings') : t('Group settings')}>
      <div className="modal group-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <header className="group-head">
          <span className="group-head-icon"><PencilIcon size={22} /></span>
          <h2>{isChannel ? t('Channel settings') : t('Group settings')}</h2>
        </header>

        <div className="group-create-main">
          <div className="group-avatar-wrap">
            <Avatar user={{ first_name: title || 'G', photo }} size={92} />
            <label className="avatar-camera group-avatar-cam" title={t('Group photo')}>
              <ImageIcon size={18} />
              <input type="file" accept="image/*" hidden onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          <div className="group-fields">
            <input className="group-title" placeholder={isChannel ? t('Channel name') : t('Group name')} value={title} onChange={(e) => setTitle(e.target.value)} />
            <input className="group-about" placeholder={t('About group…')} value={about} onChange={(e) => setAbout(e.target.value)} />
            <input className="group-about" placeholder={t('Username')} value={username} onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))} />
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        <footer className="group-foot">
          <button
            className="group-clear-photo"
            onClick={() => {
              setPhoto(null);
            }}
          >
            {t('Remove photo')}
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? t('Saving…') : t('Save')}
          </button>
        </footer>

        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
      </div>
    </div>
  );
}
