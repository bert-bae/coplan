import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'cc-harness:theme';

/** This sits next to a terminal, so it should match the terminal rather than
 *  whatever the OS happens to be set to. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (window.localStorage.getItem(KEY) as Theme) || 'system';
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const label: Record<Theme, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

  return (
    <button
      type="button"
      className="icon-btn"
      title={`Theme: ${label[theme]} — click to change`}
      onClick={() => setTheme(next[theme])}
    >
      {theme === 'dark' ? '◐' : theme === 'light' ? '○' : '◑'}
    </button>
  );
}
