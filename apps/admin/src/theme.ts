export type ThemeId = 'dark' | 'light';

const THEME_KEY = 'fo_admin_theme';

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'dark', label: '深色' },
  { id: 'light', label: '白色浅蓝' },
];

export function getTheme(): ThemeId {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

export function initTheme() {
  applyTheme(getTheme());
}
