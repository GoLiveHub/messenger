import { useRef, useState } from 'react';
import { api, type User } from '../api';
import { store } from '../store';
import { Avatar } from './Avatar';
import { loadImage, resizeToDataUrl } from '../lib/image';
import { BirthdayPicker, formatBirthday } from './BirthdayPicker';
import { PhotoCropModal } from './PhotoCropModal';
import { t, useLang } from '../i18n';
import { useFocusTrap, useEscapeKey } from '../hooks';
import {
  CloseIcon,
  PencilIcon,
  PhoneIcon,
  GiftIcon,
  CheckIcon,
} from './icons';

export function CopyTag({ username, dark }: { username: string; dark?: boolean }) {
  const [copied, setCopied] = useState(false);
  useLang();
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(`@${username}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button className={`copy-tag${dark ? ' dark' : ''}`} onClick={copy} title={t('Copy @username')}>
      @{username}
      {copied && (
        <span className="copied-hint">
          <CheckIcon size={12} /> {t('Copied')}
        </span>
      )}
    </button>
  );
}

export function ProfileModal({ user, onClose }: { user: User; onClose: () => void }) {
  const me = store.get().me!;
  const isSelf = user.id === me.id;
  const [editing, setEditing] = useState(false);
  const trapRef = useFocusTrap(true);
  useLang();
  useEscapeKey(onClose);
  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('Profile')}>
      <div className="modal profile-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
        {editing ? (
          <ProfileEdit user={me} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <div className="profile-header">
              <div className="profile-avatar">
                <Avatar user={user} size={108} />
              </div>
              <h2>{[user.first_name, user.last_name].filter(Boolean).join(' ') || t('Unknown')}</h2>
              <CopyTag username={user.username} dark />
            </div>
            <div className="profile-info">
              {isSelf && (
                <div className="info-row">
                  <span className="info-icon"><PhoneIcon size={18} /></span>
                  <span className="info-label">{t('Phone')}</span>
                  <span className="info-value">{user.phone}</span>
                </div>
              )}
              <div className="info-row">
                <span className="info-icon"><GiftIcon size={18} /></span>
                <span className="info-label">{t('Birthday')}</span>
                <span className="info-value">{formatBirthday(user.birthday) || '—'}</span>
              </div>
              {user.bio && (
                <div className="info-row bio-row">
                  <span className="info-label">{t('Bio')}</span>
                  <span className="info-value">{user.bio}</span>
                </div>
              )}
            </div>
            {isSelf && (
              <button className="profile-edit-btn" onClick={() => setEditing(true)}>
                <PencilIcon size={16} /> {t('Edit profile')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ProfileEdit({ user, onCancel }: { user: User; onCancel: () => void }) {
  const [photo, setPhoto] = useState<string | null>(user.photo);
  const [first, setFirst] = useState(user.first_name);
  const [last, setLast] = useState(user.last_name);
  const [bio, setBio] = useState(user.bio);
  const [username, setUsername] = useState(user.username);
  const [birthday, setBirthday] = useState<string | null>(user.birthday);
  const [showBirthday, setShowBirthday] = useState(false);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useLang();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const img = await loadImage(file);
      setCropSrc(resizeToDataUrl(img, 512, 0.85));
    } catch (err) {
      setMsg((err as Error).message);
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const updated = await api.updateProfile({
        photo,
        first_name: first,
        last_name: last,
        username,
        bio,
        birthday: birthday || null,
      });
      store.set({ me: updated });
      onCancel();
    } catch (err) {
      setMsg((err as Error).message);
      setSaving(false);
    }
  };

  const removeBirthday = () => {
    setBirthday(null);
    setShowBirthday(false);
  };

  return (
    <div className="profile-edit">
      <div className="profile-edit-avatar">
        <Avatar user={{ ...user, photo }} size={96} />
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
        <button className="avatar-camera" onClick={() => fileRef.current?.click()} title={t('Change photo')}>
          <PencilIcon size={16} />
        </button>
      </div>
      <div className="form-row">
        <label>{t('First name')} <span className="required">*</span></label>
        <input
          value={first}
          onChange={(e) => setFirst(e.target.value)}
          placeholder={t('Required')}
          className={first.trim() ? '' : 'invalid'}
        />
        <span className="field-hint">{t('First name is required')}</span>
      </div>
      <div className="form-row">
        <label>{t('Last name')}</label>
        <input value={last} onChange={(e) => setLast(e.target.value)} placeholder={t('Optional')} />
        <span className="field-hint">{t('Last name is optional')}</span>
      </div>
      <div className="form-row">
        <label>{t('Bio')}</label>
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} />
      </div>
      <div className="form-row">
        <label>{t('Username')}</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="form-row">
        <label>{t('Birthday')}</label>
        <button className="birthday-field" onClick={() => setShowBirthday(true)}>
          <span className="birthday-field-icon"><GiftIcon size={16} /></span>
          <span className={formatBirthday(birthday) ? '' : 'muted'}>
            {formatBirthday(birthday) || t('Set birthday')}
          </span>
          {birthday && (
            <span
              className="birthday-clear"
              onClick={(e) => { e.stopPropagation(); removeBirthday(); }}
              title={t('Remove birthday')}
            >
              <CloseIcon size={14} />
            </span>
          )}
        </button>
      </div>
      <div className="row-buttons">
        <button className="btn primary" onClick={save} disabled={saving || !first.trim()}>
          <CheckIcon size={16} /> {saving ? t('Saving…') : t('Save')}
        </button>
        <button className="btn" onClick={onCancel}>{t('Cancel')}</button>
      </div>
      {msg && <div className="error">{msg}</div>}

      {showBirthday && (
        <BirthdayPicker
          value={birthday}
          onSave={(v) => {
            setBirthday(v);
            setShowBirthday(false);
          }}
          onRemove={removeBirthday}
          onClose={() => setShowBirthday(false)}
        />
      )}

      {cropSrc && (
        <PhotoCropModal
          src={cropSrc}
          onCrop={(dataUrl) => { setPhoto(dataUrl); setCropSrc(null); }}
          onClose={() => setCropSrc(null)}
        />
      )}
    </div>
  );
}
