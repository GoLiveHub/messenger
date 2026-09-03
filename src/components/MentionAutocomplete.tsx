import { useState, useEffect, useRef, useCallback } from 'react';
import { api, type User } from '../api';
import { Avatar } from './Avatar';

interface Props {
  chatId: number;
  query: string;
  onSelect: (username: string) => void;
  onClose: () => void;
}

export function MentionAutocomplete({ chatId, query, onSelect, onClose }: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const onCloseRef = useRef(onClose);
  onSelectRef.current = onSelect;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!query) { setUsers([]); return; }
    let cancelled = false;
    const searchFn = chatId
      ? fetch(`/api/chats/${chatId}/members/search?q=${encodeURIComponent(query)}`, { credentials: 'include' }).then((r) => r.json()).catch(() => [])
      : api.searchUsers(query).then((r) => r.slice(0, 8)).catch(() => []);
    searchFn.then((res) => {
      if (!cancelled) setUsers(res);
    });
    return () => { cancelled = true; };
  }, [query, chatId]);

  useEffect(() => { setSelected(0); }, [users]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, users.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter' && users[selected]) { e.preventDefault(); onSelectRef.current(users[selected].username); }
      else if (e.key === 'Escape') { onCloseRef.current(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [users.length, selected]);

  if (!users.length) return null;

  return (
    <div className="mention-autocomplete" ref={listRef}>
      {users.map((u, i) => (
        <button
          key={u.id}
          className={`mention-option${i === selected ? ' selected' : ''}`}
          onClick={() => onSelect(u.username)}
          onMouseEnter={() => setSelected(i)}
        >
          <Avatar user={u} size={28} />
          <div className="mention-option-info">
            <span className="mention-name">{[u.first_name, u.last_name].filter(Boolean).join(' ')}</span>
            <span className="mention-username">@{u.username}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
