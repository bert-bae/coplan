import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Open a URL in the user's browser, best-effort and never blocking.
 *
 * This is only ever called from an explicit user action (`harness open`, or
 * the `autoOpen` setting, which is off by default). Opening windows the user
 * did not ask for is worse than making them click a link.
 *
 * WSL needs care. `explorer.exe <url>` is the folklore answer, but when it is
 * spawned with a Linux working directory it cannot map, it discards the
 * argument and opens a File Explorer window at the user's Documents folder
 * instead — so a "open my review UI" call turns into a random file browser.
 * `cmd.exe /c start`, launched from a drive path Windows understands, does
 * the right thing.
 */
export function openInBrowser(url: string): void {
  if (!openable(url)) return;
  const { command, args, cwd, cmd } = opener();
  // cmd.exe reads `&`, `|`, `<`, `>` and `^` as its own even inside an
  // argument: escaped, so a link cannot run anything — or be cut short.
  const arg = cmd ? url.replace(/[&|<>^]/g, '^$&') : url;
  // A failed open must never take the session with it: a missing opener
  // says so with an `error` event, anything else by throwing.
  try {
    const child = spawn(command, [...args, arg], {
      stdio: 'ignore',
      detached: true,
      ...(cwd ? { cwd } : {}),
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* not opened */
  }
}

/**
 * What may be opened: the page itself (http/https), and the desktop apps'
 * own links to a session — claude://, codex://, cursor:// — which is where
 * "answer in Claude" goes. Nothing with spaces or quotes, which no such link
 * has and an opener's command line could misread.
 */
export function openable(url: string): boolean {
  return /^(https?|claude|codex|cursor):\/\/[^\s"'`]+$/.test(url);
}

interface Opener {
  command: string;
  args: string[];
  /** Windows binaries need a working directory Windows can resolve. */
  cwd?: string;
  /** Run through cmd.exe, which needs its metacharacters escaped. */
  cmd?: boolean;
}

/** The one opener for this system. A spawn that fails says so only after
 *  it has been chosen, so each is checked for, at the path it is run from. */
function opener(): Opener {
  if (process.platform === 'darwin') return { command: 'open', args: [] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''], cmd: true };
  if (isWsl()) {
    // wslu's opener is purpose-built for this and gets it right.
    if (existsSync('/usr/bin/wslview')) return { command: '/usr/bin/wslview', args: [] };
    if (existsSync('/mnt/c/Windows/System32/cmd.exe')) return { command: '/mnt/c/Windows/System32/cmd.exe', args: ['/c', 'start', ''], cwd: '/mnt/c', cmd: true };
  }
  return { command: 'xdg-open', args: [] };
}

export function isWsl(): boolean {
  if (process.env['WSL_DISTRO_NAME']) return true;
  try {
    return existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}
