import { useEffect, useMemo, useState } from 'react';
import { useApp, store } from '../store';
import { api, type User } from '../api';
import { Avatar } from './Avatar';
import { CloseIcon, SearchIcon, CheckIcon, MegaphoneIcon, UsersIcon, ImageIcon } from './icons';
import { t, tx, useLang } from '../i18n';
import { loadImage, resizeToDataUrl } from '../lib/image';
import { useFocusTrap, useEscapeKey } from '../hooks';
import { markChatAutoOpened } from '../useMessengerSocket';

export function NewGroupModal({ kind, onClose, onCreated }: { kind: 'group' | 'channel'; onClose: () => void; onCreated?: () => void }) {
  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  const { chats, me } = useApp();
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<User[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const contacts = useMemo(() => {
    const seen = new Map<number, User>();
    for (const c of chats) {
      if (c.peer && !seen.has(c.peer.id)) seen.set(c.peer.id, c.peer);
    }
    const list = [...seen.values()].filter((u) => u.id !== me?.id);
    const ql = q.trim().toLowerCase();
    if (!ql) return list;
    return list.filter((u) =>
      u.username.toLowerCase().includes(ql) ||
      `${u.first_name} ${u.last_name}`.toLowerCase().includes(ql) ||
      u.phone.replace(/\s/g, '').includes(ql),
    );
  }, [chats, q, me?.id]);

  const search = async () => {
    if (!q.trim()) {
      setFound(null);
      return;
    }
    try {
      setFound(await api.searchUsers(q));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (!q.trim()) setFound(null);
  }, [q]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const img = await loadImage(file);
      setPhoto(resizeToDataUrl(img, 512, 0.85));
    } catch {
      setError('Bad image');
    }
  };

  const create = async () => {
    if (!title.trim()) {
      setError(t('Group title is required'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const info = await api.createGroup({
        kind,
        title: title.trim(),
        about: about.trim(),
        photo: photo ?? undefined,
        userIds: [...selected],
      });
      markChatAutoOpened(info.chat.chat.id);
      store.set({ chats: await api.getChats(), activeChatId: info.chat.chat.id });
      onClose();
      onCreated?.();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const candidates = q.trim() && found !== null ? found.filter((u) => !contacts.some((c) => c.id === u.id)) : [];

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={kind === 'channel' ? t('New channel') : t('New group')}>
      <div className="modal group-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <header className="group-head">
          <span className="group-head-icon">{kind === 'channel' ? <MegaphoneIcon size={22} /> : <UsersIcon size={22} />}</span>
          <h2>{kind === 'channel' ? t('New channel') : t('New group')}</h2>
        </header>

        <div className="group-create-main">
          <div className="group-avatar-wrap">
            <Avatar user={{ first_name: title || (kind === 'channel' ? 'C' : 'G'), photo }} size={92} />
            <label className="avatar-camera group-avatar-cam" title={t('Group photo')}>
              <ImageIcon size={18} />
              <input type="file" accept="image/*" hidden onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          <div className="group-fields">
            <input className="group-title" placeholder={kind === 'channel' ? t('Channel name') : t('Group name')} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <input className="group-about" placeholder={t('About group…')} value={about} onChange={(e) => setAbout(e.target.value)} />
          </div>
        </div>

        <form
          className="group-search"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <span className="group-search-icon"><SearchIcon size={16} /></span>
          <input placeholder={t('Select members…')} value={q} onChange={(e) => setQ(e.target.value)} />
        </form>

        {error && <div className="error">{error}</div>}

        <div className="group-member-list">
          {candidates.map((u) => (
            <div key={u.id} className="group-member-row">
              <button className="group-member-main" onClick={() => toggle(u.id)}>
                <Avatar user={u} size={40} />
                <div className="group-member-info">
                  <b>{[u.first_name, u.last_name].filter(Boolean).join(' ') || t('Unknown')}</b>
                  <span className="muted">@{u.username}</span>
                </div>
              </button>
              <button className={`check-round${selected.has(u.id) ? ' on' : ''}`} onClick={() => toggle(u.id)}>
                {selected.has(u.id) && <CheckIcon size={16} />}
              </button>
            </div>
          ))}
          {!q.trim() &&
            contacts.map((u) => (
              <div key={u.id} className="group-member-row">
                <button className="group-member-main" onClick={() => toggle(u.id)}>
                  <Avatar user={u} size={40} />
                  <div className="group-member-info">
                    <b>{[u.first_name, u.last_name].filter(Boolean).join(' ') || t('Unknown')}</b>
                    <span className="muted">@{u.username}</span>
                  </div>
                </button>
                <button className={`check-round${selected.has(u.id) ? ' on' : ''}`} onClick={() => toggle(u.id)}>
                  {selected.has(u.id) && <CheckIcon size={16} />}
                </button>
              </div>
            ))}
          {!q.trim() && contacts.length === 0 && (
            <div className="muted empty">{t('No contacts yet — search users above to add them.')}</div>
          )}
        </div>

        <footer className="group-foot">
          {selected.size > 0 && <span className="muted">{tx('selected_count', { n: selected.size })}</span>}
          <button className="btn primary" disabled={busy || !title.trim()} onClick={create}>
            {busy ? t('Creating group…') : kind === 'channel' ? t('Create channel') : t('Create group')}
          </button>
        </footer>

        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
      </div>
    </div>
  );
}
