import type { SessionState } from '../shared/types.ts';

/**
 * Whether the daemon has nothing to stay up for: no browser open, and
 * neither it nor any live session active within `idleMs`. Its own start
 * counts: one started for a link (`coplan start`, `coplan url`) with
 * nothing active gives the page the idle time to be opened. `sessions` is
 * asked for only when nothing else has answered.
 */
export function isIdle(
  now: number,
  daemon: { startedAt: number; clients: number; sessions: () => readonly Pick<SessionState, 'status' | 'updatedAt'>[] },
  idleMs: number,
): boolean {
  if (daemon.clients > 0 || now - daemon.startedAt < idleMs) return false;
  return !daemon.sessions().some((s) => s.status !== 'ended' && now - s.updatedAt < idleMs);
}
