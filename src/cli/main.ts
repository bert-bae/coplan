/**
 * `coplan` — the operator CLI.
 *
 *   coplan start|stop|restart|status|open|url|logs|doctor|check|init
 *
 * Everything here is also reachable from the plugin, but a plain CLI is what
 * makes the daemon debuggable when the hook wiring is the thing that broke.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl, paths, ensureHome } from '../shared/paths.ts';
import { runDoctor } from './doctor.ts';
import { runCheck } from './check.ts';
import { runInit } from './init.ts';
import { AGENT_KINDS, agentInfo, sessionFromEnv } from '../shared/agents.ts';
import { openInBrowser } from '../daemon/browser.ts';
import { cleanStorage, scanStorage } from '../daemon/housekeeping.ts';
import { CLEANUP_GROUPS, type CleanupGroupId, type CleanupOutcome, type DaemonLock, type SessionSummary, type StorageReport } from '../shared/types.ts';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0';

const DAEMON_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'main.js');

async function ensureDaemon(): Promise<DaemonLock | null> {
  const existing = readLiveLock();
  if (existing) return existing;
  ensureHome();
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  // `spawn` reports ENOENT asynchronously, on the child's `error` event. With
  // no listener that is an unhandled `'error'`, which would take this process
  // down mid-session — so attach one even though the failure is recoverable.
  child.on('error', () => {
    /* the lock-file poll below reports the failure */
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const lock = readLiveLock();
    if (lock) return lock;
  }
  return null;
}

async function api<T>(lock: DaemonLock, route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl(lock)}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}`, ...(init?.headers ?? {}) },
  });
  return (await res.json()) as T;
}

/**
 * The session this command was run from. Claude Code and Codex name it in the
 * environment of the commands they run; otherwise — Cursor, or a terminal —
 * it is the session in this folder that was active last.
 */
async function currentSession(lock: DaemonLock): Promise<string | undefined> {
  for (const agent of AGENT_KINDS) {
    const id = sessionFromEnv(process.env, agent);
    if (id) return id;
  }
  try {
    const { sessions } = await api<{ sessions: SessionSummary[] }>(lock, '/api/sessions');
    const here = path.resolve(process.cwd());
    const at = (p: string | null) => !!p && path.resolve(p) === here;
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).find((s) => at(s.cwd) || at(s.repoRoot))?.sessionId;
  } catch {
    return undefined;
  }
}

function uiUrl(lock: DaemonLock, sessionId?: string): string {
  const base = `${baseUrl(lock)}/?token=${lock.token}`;
  return sessionId ? `${base}#/session/${sessionId}` : base;
}

const commands: Record<string, (args: string[]) => Promise<number>> = {
  async start() {
    const lock = await ensureDaemon();
    if (!lock) {
      console.error('failed to start the daemon; see', paths.logFile());
      return 1;
    }
    console.log(`coplan running on ${baseUrl(lock)} (pid ${lock.pid})`);
    console.log(`open: ${uiUrl(lock)}`);
    return 0;
  },

  async stop() {
    const lock = readLiveLock();
    if (!lock) {
      console.log('not running');
      return 0;
    }
    try {
      process.kill(lock.pid, 'SIGTERM');
      console.log(`stopped pid ${lock.pid}`);
    } catch (err) {
      console.error(`could not stop pid ${lock.pid}: ${(err as Error).message}`);
      return 1;
    }
    return 0;
  },

  /**
   * Restart, keeping the address when there is a daemon to ask.
   *
   * The daemon hands its port and token to its own successor, so an open
   * browser tab reconnects by itself. Stopping and starting from out here
   * would move it to a fresh port and strand every tab that was watching.
   */
  async restart(args) {
    const lock = readLiveLock();
    if (!lock) return commands['start']!(args);

    try {
      const result = await api<{ restarting?: boolean }>(
        lock,
        '/api/daemon/restart',
        { method: 'POST', body: '{}' },
      );
      if (result.restarting) {
        const next = await waitForNewDaemon(lock.pid);
        if (next) {
          console.log(`coplan restarted on ${baseUrl(next)} (pid ${next.pid})`);
          return 0;
        }
        console.error('the daemon stopped but did not come back; see', paths.logFile());
        return 1;
      }
    } catch {
      // Fall through: an unreachable daemon is still one we can stop.
    }

    await commands['stop']!(args);
    await sleep(400);
    return commands['start']!(args);
  },

  /**
   * Report — and, unless asked not to, remove — the files the harness has
   * left behind.
   *
   *   coplan clean [--dry-run] [--all] [group ...]
   *
   * Recorded session history is excluded unless it is asked for by name or
   * with `--all`, which is the same default the browser panel offers: every
   * other group is unambiguously garbage, and that one is the only one whose
   * removal loses something a user might want back.
   *
   * Routed through the daemon when one is running, so that the sessions it is
   * holding are excluded by id rather than guessed at from mtimes.
   */
  async clean(args) {
    const dryRun = args.includes('--dry-run') || args.includes('-n');
    const named = args.filter((a) => !a.startsWith('-'));
    const unknown = named.filter((a) => !CLEANUP_GROUPS.includes(a as CleanupGroupId));
    if (unknown.length) {
      console.error(`unknown group(s): ${unknown.join(', ')}`);
      console.error(`known groups: ${CLEANUP_GROUPS.join(', ')}`);
      return 2;
    }

    const groups: CleanupGroupId[] = named.length
      ? (named as CleanupGroupId[])
      : args.includes('--all')
        ? [...CLEANUP_GROUPS]
        : CLEANUP_GROUPS.filter((id) => id !== 'sessions');
    const lock = readLiveLock();
    if (!lock) console.log('(no daemon running: live sessions are identified by age alone)');

    const outcome = lock
      ? await api<{ result: CleanupOutcome }>(lock, '/api/storage/clean', {
          method: 'POST',
          body: JSON.stringify({ groups, dryRun }),
        }).then((r) => r.result)
      : cleanStorage({ groups, dryRun });

    for (const group of outcome.groups) {
      if (!group.count) continue;
      console.log(
        `  ${pad(group.label, 22)} ${pad(String(group.count), 5)} ${pad(formatBytes(group.bytes), 9)}` +
          (dryRun ? ' would be removed' : ' removed'),
      );
    }
    for (const file of outcome.failed) console.error(`  could not remove ${file}`);

    if (!outcome.removed) console.log('nothing to clean up');
    else console.log(dryRun ? `would reclaim ${formatBytes(outcome.freedBytes)}` : `reclaimed ${formatBytes(outcome.freedBytes)}`);

    // Say what was deliberately left out, so the number is not read as a total.
    if (!groups.includes('sessions')) {
      const held = await heldSessionBytes(lock);
      if (held) console.log(`recorded session history not touched (${formatBytes(held)}) — add "sessions" to include it`);
    }
    return outcome.failed.length ? 1 : 0;
  },

  /** The daemon, and every session with where its plan stands. */
  async status() {
    const lock = readLiveLock();
    if (!lock) {
      console.log('not running');
      return 0;
    }
    console.log(`coplan v${lock.version} on ${baseUrl(lock)} (pid ${lock.pid})`);
    const { sessions } = await api<{ sessions: SessionSummary[] }>(lock, '/api/sessions');
    if (!sessions.length) {
      console.log('no sessions');
      return 0;
    }
    for (const s of sessions) {
      const plan = s.planTitle
        ? `"${s.planTitle}" · tasks ${s.tasks.done}/${s.tasks.total}` +
          (s.current ? ` · now: ${s.current}` : '') +
          (s.waiting ? ` · WAITING ON YOU: ${s.waiting.text}` : '') +
          (s.unreadByClaude ? ` · ${s.unreadByClaude} item(s) changed that ${agentInfo(s.agent).name} has not read` : '')
        : 'no plan yet';
      console.log(`  ${pad(s.status, 7)} ${pad(agentInfo(s.agent).name, 6)} ${pad(s.title, 28)} ${plan}`);
      console.log(`          ${s.sessionId}  ${s.cwd}`);
      if (s.link) console.log(`          open: ${s.link.app}${s.link.web ? `  (web: ${s.link.web})` : ''}`);
    }
    return 0;
  },

  async open(args) {
    const lock = await ensureDaemon();
    if (!lock) return 1;
    const url = uiUrl(lock, args[0] ?? (await currentSession(lock)));
    openInBrowser(url);
    console.log(url);
    return 0;
  },

  async url(args) {
    const lock = await ensureDaemon();
    if (!lock) return 1;
    console.log(uiUrl(lock, args[0] ?? (await currentSession(lock))));
    return 0;
  },

  async logs() {
    const file = paths.logFile();
    if (!existsSync(file)) {
      console.log('(no log yet)');
      return 0;
    }
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    console.log(lines.slice(-80).join('\n'));
    return 0;
  },

  async doctor() {
    return runDoctor();
  },

  /** Run a stage's hooks from the repository's .coplan/config.json. */
  async check(args) {
    return runCheck(args);
  },

  /** Write a starting .coplan/config.json from what the repository has. */
  async init(args) {
    return runInit(args);
  },

  async version() {
    console.log(VERSION);
    return 0;
  },
};

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How much recorded history a default `clean` deliberately left alone. */
async function heldSessionBytes(lock: DaemonLock | null): Promise<number> {
  try {
    const report = lock
      ? await api<{ report: StorageReport }>(lock, '/api/storage').then((r) => r.report)
      : scanStorage();
    return report.groups.find((g) => g.id === 'sessions')?.bytes ?? 0;
  } catch {
    return 0;
  }
}

/** Wait for the lock to be claimed by a process other than the one that had it. */
async function waitForNewDaemon(previousPid: number): Promise<DaemonLock | null> {
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const lock = readLiveLock();
    if (lock && lock.pid !== previousPid) return lock;
  }
  return null;
}

function usage(): void {
  console.log(`coplan v${VERSION}

usage: coplan <command>

  start      start the daemon (idempotent)
  stop       stop the daemon
  restart    restart the daemon in place, keeping its address
  status     show the daemon and every registered session
  clean      remove stale Coplan files (--dry-run to only list them)
             recorded session history is kept unless you pass --all or name it
             groups: sessions, partial-writes, log, lock
  open [id]  open the UI in a browser
  url  [id]  print the UI url (with auth token)
  logs       tail the daemon log
  doctor     verify the plugin wiring end to end
  check [implement|review|final] [--files a,b] [--list] [--json]
             run that stage's hooks from .coplan/config.json (default: review)
  init [--print] [--force]
             write a starting .coplan/config.json from the repository's scripts
  version    print the version
`);
}

const [, , command = 'status', ...rest] = process.argv;
const handler = commands[command];
if (!handler) {
  usage();
  process.exit(command === 'help' || command === '--help' ? 0 : 2);
}
handler(rest)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error((err as Error)?.stack ?? String(err));
    process.exit(1);
  });
