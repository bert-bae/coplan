import { homedir } from 'node:os';
import path from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import type { DaemonLock } from './types.ts';

/** Root for all harness state. Overridable so tests can run hermetically. */
export function harnessHome(): string {
  return process.env.CC_HARNESS_HOME || path.join(homedir(), '.claude', 'cc-harness');
}

export const paths = {
  home: harnessHome,
  lockFile: () => path.join(harnessHome(), 'daemon.json'),
  logFile: () => path.join(harnessHome(), 'daemon.log'),
  sessionsDir: () => path.join(harnessHome(), 'sessions'),
  sessionDir: (id: string) => path.join(harnessHome(), 'sessions', sanitizeId(id)),
  sessionState: (id: string) => path.join(harnessHome(), 'sessions', sanitizeId(id), 'state.json'),
  sessionEvents: (id: string) => path.join(harnessHome(), 'sessions', sanitizeId(id), 'events.jsonl'),
  configDir: harnessHome,
  instructionsDir: () => path.join(harnessHome(), 'instructions'),
};

/** Session ids come from the CLI, but they end up in filesystem paths. */
export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

export function ensureHome(): string {
  const home = harnessHome();
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
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
