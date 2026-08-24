// Client-side formatting helpers. Do NOT import server modules here:
// helpers.ts pulls in node:sqlite and cannot be bundled for the browser.

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

/** "just now" / "5m ago" / "2h ago" / "yesterday" / "Mar 3" / "Mar 3, 2024" */
export function formatRelativeTime(input: string | number | Date, locale?: string): string {
  const date = input instanceof Date ? input : new Date(input);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  const lang = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (diff < MIN && diff > -MIN) return rtf.format(Math.round(diff / 1000), 'second');
  if (diff < HOUR) return rtf.format(-Math.round(diff / MIN), 'minute');
  if (diff < DAY) return rtf.format(-Math.round(diff / HOUR), 'hour');
  if (diff < WEEK) {
    if (isYesterday(date)) return formatDayName(lang);
    return rtf.format(-Math.round(diff / DAY), 'day');
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(lang, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

function isYesterday(date: Date): boolean {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return (
    date.getDate() === d.getDate() &&
    date.getMonth() === d.getMonth() &&
    date.getFullYear() === d.getFullYear()
  );
}

function formatDayName(locale: string): string {
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day');
  } catch {
    return 'yesterday';
  }
}

/** Time inside a chat bubble: "14:32" (locale-aware). */
export function formatMessageTime(input: string | number | Date, locale?: string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en'), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Call duration: 59 -> "0:59", 3675 -> "1:01:15". */
export function formatCallDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** File size: 0 -> "0 B", 1536 -> "1.5 KB", 5.3e6 -> "5.3 MB". */
export function formatFileSize(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  const formatted = new Intl.NumberFormat(locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en'), {
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
  return `${formatted} ${units[unitIndex]}`;
}

/** Compact number: 940 -> "940", 12345 -> "12.3K", 5600000 -> "5.6M". */
export function formatNumber(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return '';
  const lang = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
  if (Math.abs(value) >= 1000) {
    return new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat(lang).format(value);
}
