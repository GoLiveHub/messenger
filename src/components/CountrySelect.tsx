import { useEffect, useMemo, useRef, useState } from 'react';
import { COUNTRIES, type PhoneCountry } from '../phone';
import { ChevronDownIcon } from './icons';
import { t, useLang } from '../i18n';

export function CountrySelect({
  value,
  onChange,
}: {
  value: PhoneCountry;
  onChange: (c: PhoneCountry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useLang();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true;
      if (qd && c.cc.startsWith(qd)) return true;
      return false;
    });
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <div className="country-select-root" ref={rootRef}>
      <button type="button" className="country-select-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="country-flag">{value.flag}</span>
        <span className="country-trigger-name">{value.name}</span>
        <span className="country-cc">+{value.cc}</span>
        <span className={`country-caret${open ? ' up' : ''}`}>
          <ChevronDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div className="country-dropdown">
          <input
            ref={inputRef}
            className="country-search"
            placeholder={t('Search by name or code…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="country-options">
            {filtered.length === 0 && <div className="country-empty">{t('No matches')}</div>}
            {filtered.map((c) => (
              <button
                key={`${c.cc}-${c.name}`}
                type="button"
                className={`country-option${c.cc === value.cc ? ' selected' : ''}`}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <span className="country-flag">{c.flag}</span>
                <span className="country-option-name">{c.name}</span>
                <span className="country-cc">+{c.cc}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
