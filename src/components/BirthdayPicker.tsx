import { useMemo, useState } from 'react';
import { CheckIcon, CloseIcon, TrashIcon, CalendarIcon } from './icons';
import { t, useLang, monthNames, monthGenitive } from '../i18n';
import { useFocusTrap, useEscapeKey } from '../hooks';

export function formatBirthday(v: string | null | undefined): string {
  if (!v) return '';
  const parts = v.split('-').map(Number);
  const months = monthGenitive();
  if (v.length === 10) {
    const [y, m, d] = parts;
    return `${d} ${months[m - 1]} ${y}`;
  }
  const [m, d] = parts;
  return `${d} ${months[m - 1]}`;
}

function daysInMonth(month: number, year: number | null): number {
  if (month === 2) return year ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : 29;
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function BirthdayPicker({
  value,
  onSave,
  onRemove,
  onClose,
}: {
  value: string | null;
  onSave: (v: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const init = useMemo(() => {
    if (!value) return { month: '', day: '', year: '' };
    const parts = value.split('-').map(Number);
    if (value.length === 10) return { month: String(parts[1]), day: String(parts[2]), year: String(parts[0]) };
    return { month: String(parts[0]), day: String(parts[1]), year: '' };
  }, [value]);

  useLang();
  useEscapeKey(onClose);
  const trapRef = useFocusTrap(true);
  const MONTHS = monthNames();

  const [month, setMonth] = useState(init.month);
  const [day, setDay] = useState(init.day);
  const [year, setYear] = useState(init.year);

  const monthNum = month ? Number(month) : 0;
  const yearNum = year ? Number(year) : 0;
  const dayNum = day ? Number(day) : 0;

  const maxDay = monthNum ? daysInMonth(monthNum, yearNum || null) : 31;

  const clampDay = (d: string, m: string, y: string) => {
    if (!m || !d) return d;
    const max = daysInMonth(Number(m), y ? Number(y) : null);
    const n = Number(d);
    return n > max ? String(max) : d;
  };

  const onMonthChange = (m: string) => {
    setMonth(m);
    setDay((d) => clampDay(d, m, year));
  };

  const onYearChange = (y: string) => {
    setYear(y);
    setDay((d) => clampDay(d, month, y));
  };

  const now = new Date();
  const years = (() => {
    const currentYear = now.getFullYear();
    const list: number[] = [];
    for (let y = currentYear; y >= currentYear - 100; y--) list.push(y);
    return list;
  })();

  const save = () => {
    if (!monthNum || !dayNum) return;
    const mm = String(monthNum).padStart(2, '0');
    const dd = String(dayNum).padStart(2, '0');
    onSave(yearNum ? `${yearNum}-${mm}-${dd}` : `${mm}-${dd}`);
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('Birthday')}>
      <div className="modal birthday-modal" ref={trapRef} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close icon-btn" onClick={onClose} title={t('Close')}>
          <CloseIcon size={20} />
        </button>

        <div className="birthday-head">
          <span className="birthday-head-icon"><CalendarIcon size={22} /></span>
          <div>
            <h2>{t('Birthday')}</h2>
            <p className="muted">{t('Only day and month are required. Year is optional.')}</p>
          </div>
        </div>

        {value && (
          <button className="birthday-remove" onClick={onRemove}>
            <TrashIcon size={16} /> {t('Remove from profile')}
          </button>
        )}

        <div className="bday-pickers">
          <div className="bday-field">
            <select value={day} onChange={(e) => setDay(e.target.value)} disabled={!month}>
              <option value="">{t('Day')}</option>
              {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
                <option key={d} value={String(d)}>{d}</option>
              ))}
            </select>
          </div>

          <div className="bday-field">
            <select value={month} onChange={(e) => onMonthChange(e.target.value)}>
              <option value="">{t('Month')}</option>
              {MONTHS.map((n, i) => (
                <option key={i + 1} value={String(i + 1)}>{n}</option>
              ))}
            </select>
          </div>

          <div className="bday-field">
            <select value={year} onChange={(e) => onYearChange(e.target.value)}>
              <option value="">{t('Year')}</option>
              {years.map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        {monthNum > 0 && dayNum > 0 && (
          <div className="bday-preview">
            {yearNum > 0
              ? `${dayNum} ${MONTHS[monthNum - 1]} ${yearNum}`
              : `${dayNum} ${MONTHS[monthNum - 1]}`}
          </div>
        )}

        <div className="row-buttons">
          <button className="btn primary" onClick={save} disabled={!monthNum || !dayNum}>
            <CheckIcon size={16} /> {t('Save')}
          </button>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
        </div>
      </div>
    </div>
  );
}
