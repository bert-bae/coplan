import { useEffect, useState } from 'react';
import { classNames } from '../lib/format.ts';

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'cc-harness:theme';
const ORDER: Theme[] = ['system', 'light', 'dark'];
const LABEL: Record<Theme, string> = { system: 'Match the system', light: 'Light', dark: 'Dark' };
const GLYPH: Record<Theme, string> = { system: '◑', light: '☀', dark: '☾' };

/**
 * Theme selection.
 *
 * The preference has three values but the document only ever carries two:
 * `system` is resolved here and written out as an explicit
 * `data-theme="light"` or `data-theme="dark"`.
 *
 * That resolution is the whole point. The stylesheet used to define its dark
 * tokens only inside `@media (prefers-color-scheme: dark)`, so choosing Dark
 * on a machine whose OS was set to light changed the attribute and nothing
 * else — the app stayed light and the control looked broken. With one
 * attribute carrying the answer there is exactly one thing to look at, and a
 * chosen theme always wins over the OS.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStored);

  useEffect(() => {
    const media = matchDark();

    const apply = () => {
      const resolved = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme;
      document.documentElement.setAttribute('data-theme', resolved);
    };

    apply();
    try {
      window.localStorage.setItem(KEY, theme);
    } catch {
      /* private mode — the choice still holds for this tab */
    }

    // Only `system` tracks the OS; an explicit choice must survive the user
    // flipping their OS theme in another window.
    if (theme !== 'system' || !media) return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return (
    <div className="segmented" role="group" aria-label="Colour theme">
      {ORDER.map((option) => (
        <button
          key={option}
          type="button"
          className={classNames('seg', theme === option && 'is-active')}
          aria-pressed={theme === option}
          title={LABEL[option]}
          onClick={() => setTheme(option)}
        >
          <span aria-hidden="true">{GLYPH[option]}</span>
          <span className="sr-only">{LABEL[option]}</span>
        </button>
      ))}
    </div>
  );
}

function readStored(): Theme {
  try {
    const saved = window.localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  } catch {
    return 'system';
  }
}

/** jsdom and older browsers have no `matchMedia`; the app must still render. */
function matchDark(): MediaQueryList | null {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  } catch {
    return null;
  }
}
