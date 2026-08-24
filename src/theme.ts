export type ThemeName = 'dark' | 'light';

const KEY = 'theme';

export function currentTheme(): ThemeName {
  const t = localStorage.getItem(KEY);
  return t === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: ThemeName) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function setTheme(theme: ThemeName) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}
