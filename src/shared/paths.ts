import { homedir } from 'node:os';
import path from 'node:path';
import { chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import type { DaemonLock } from './types.ts';

/** Root for all harness state. Overridable so tests can run hermetically.
 *  An agent's MCP config forwards the variable as `${env:CC_HARNESS_HOME}`;
 *  one that did not expand it names no directory, so it is ignored. */
export function harnessHome(): string {
  const override = process.env.CC_HARNESS_HOME;
  return override && !override.includes('${') ? override : path.join(homedir(), '.claude', 'cc-harness');
}

export const paths = {
  home: harnessHome,
  lockFile: () => path.join(harnessHome(), 'daemon.json'),
  logFile: () => path.join(harnessHome(), 'daemon.log'),
  sessionsDir: () => path.join(harnessHome(), 'sessions'),
  sessionDir: (id: string) => path.join(harnessHome(), 'sessions', sanitizeId(id)),
  sessionState: (id: string) => path.join(harnessHome(), 'sessions', sanitizeId(id), 'state.json'),
  configDir: harnessHome,
  /** The bearer header, for the hook relay to hand curl as a file: on the
   *  command line, any local user could read the token from /proc. */
  authHeader: () => path.join(harnessHome(), 'auth.header'),
};

/** Session ids come from the CLI, but they end up in filesystem paths. */
export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

/**
 * The home and its sessions folder, readable by this user alone: they hold
 * plans, the token and the log. Tightened on an existing home too, which an
 * older build created with the default umask.
 */
export function ensureHome(): string {
  const home = harnessHome();
  for (const dir of [home, path.join(home, 'sessions')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* not ours to change (a shared override): leave it */
    }
  }
  return home;
}

export function readLock(): DaemonLock | null {
  try {
    const file = paths.lockFile();
    if (!existsSync(file)) return null;
    const lock = JSON.parse(readFileSync(file, 'utf8')) as DaemonLock;
    if (typeof lock.port !== 'number' || typeof lock.token !== 'string') return null;
    return lock;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock file is only meaningful if the process behind it still exists. */
export function readLiveLock(): DaemonLock | null {
  const lock = readLock();
  if (!lock) return null;
  return isPidAlive(lock.pid) ? lock : null;
}

export function baseUrl(lock: DaemonLock): string {
  return `http://${lock.host || '127.0.0.1'}:${lock.port}`;
}

/**
 * Whether the daemon a lock names is really there. A lock outlives a daemon
 * that crashed, was killed or went down with the machine, and its pid may
 * by now belong to some other process — which `kill -0` cannot tell apart.
 * So ask the port: the daemon answers `/health` with its pid.
 *
 * - `live`: it answered, with the lock's pid.
 * - `stale`: nothing listens there, or something else does.
 * - `busy`: it did not answer in time. Not proof it is gone, so it is
 *   neither replaced nor signalled.
 */
export async function probeLock(lock: DaemonLock, timeoutMs = 1_500): Promise<'live' | 'stale' | 'busy'> {
  try {
    const res = await fetch(`${baseUrl(lock)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'stale';
    const body = (await res.json().catch(() => null)) as { pid?: unknown } | null;
    return body?.pid === lock.pid ? 'live' : 'stale';
  } catch (err) {
    const name = (err as Error)?.name;
    return name === 'TimeoutError' || name === 'AbortError' ? 'busy' : 'stale';
  }
}

/** The lock of a daemon that is running and answering — not merely one
 *  whose pid exists. */
export async function readVerifiedLock(timeoutMs?: number): Promise<DaemonLock | null> {
  const lock = readLiveLock();
  if (!lock) return null;
  return (await probeLock(lock, timeoutMs)) === 'stale' ? null : lock;
}
