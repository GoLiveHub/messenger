import { useEffect, useMemo, useState } from 'react';
import { useApp, store } from '../store';
import { api, type User } from '../api';
import { Avatar } from './Avatar';
import { CloseIcon, SearchIcon, CheckIcon, PersonPlusIcon } from './icons';
import { t, tx, useLang } from '../i18n';
import { useFocusTrap, useEscapeKey } from '../hooks';

export function AddMembersModal({ chatId, onClose }: { chatId: number; onClose: () => void }) {
  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  const { chats, me, groupMembers } = useApp();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<User[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const existing = new Set((groupMembers[chatId] ?? []).map((m) => m.user.id));

  const contacts = useMemo(() => {
    const seen = new Map<number, User>();
    for (const c of chats) {
      if (c.peer && !seen.has(c.peer.id)) seen.set(c.peer.id, c.peer);
    }
    const ql = q.trim().toLowerCase();
    return [...seen.values()].filter(
      (u) => u.id !== me?.id && !existing.has(u.id) &&
        (!ql ||
          u.username.toLowerCase().includes(ql) ||
          `${u.first_name} ${u.last_name}`.toLowerCase().includes(ql) ||
          u.phone.replace(/\s/g, '').includes(ql)),
    );
  }, [chats, q, me?.id, existing]);

  const search = async () => {
    if (!q.trim()) {
      setFound(null);
      return;
    }
    try {
      const res = await api.searchUsers(q);
      setFound(res.filter((u) => u.id !== me?.id && !existing.has(u.id)));
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

  const add = async () => {
    if (!selected.size) return;
    setBusy(true);
    setError('');
    try {
      await api.addGroupMembers(chatId, [...selected]);
      store.set({ chats: await api.getChats() });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const candidates = q.trim() && found !== null ? found.filter((u) => !contacts.some((c) => c.id === u.id)) : [];

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('Add members')}>
      <div className="modal group-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <header className="group-head">
          <span className="group-head-icon"><PersonPlusIcon size={22} /></span>
          <h2>{t('Add members to group')}</h2>
        </header>

        <form
          className="group-search"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <span className="group-search-icon"><SearchIcon size={16} /></span>
          <input placeholder={t('Select members…')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
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
            <div className="muted empty">{t('No contacts to add')}</div>
          )}
        </div>

        <footer className="group-foot">
          {selected.size > 0 && <span className="muted">{tx('selected_count', { n: selected.size })}</span>}
          <button className="btn primary" disabled={busy || !selected.size} onClick={add}>
            {busy ? t('Sending…') : t('Add')}
          </button>
        </footer>

        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>
      </div>
    </div>
  );
}
