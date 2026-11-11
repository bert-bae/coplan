/**
 * `coplan` — the operator CLI.
 *
 *   coplan start|stop|restart|status|open|url|logs|doctor|check|init|setup
 *
 * Everything here is also reachable from the plugin, but a plain CLI is what
 * makes the daemon debuggable when the hook wiring is the thing that broke.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLock, readLiveLock, readLockState, readVerifiedLock, probeLock, isPidAlive, baseUrl, paths, ensureDaemon, DAEMON_ENTRY } from '../shared/paths.ts';
import { runDoctor } from './doctor.ts';
import { runCheck } from './check.ts';
import { runInit } from './init.ts';
import { runSetup } from './setup.ts';
import { AGENT_KINDS, agentInfo, sessionFromEnv } from '../shared/agents.ts';
import { openInBrowser } from '../daemon/browser.ts';
import { cleanStorage, scanStorage } from '../daemon/housekeeping.ts';
import { CLEANUP_GROUPS, type CleanupGroupId, type CleanupOutcome, type DaemonLock, type SessionSummary, type StorageReport } from '../shared/types.ts';
import { stdoutFailure, watchStdout } from './output.ts';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0';

/** What a command says, not a crash: printed without a stack. */
class Said extends Error {}

/** A daemon that holds its port but does not answer: busy, or hung. */
function notAnswering(lock: DaemonLock, within?: number): Said {
  return new Said(
    `the daemon (pid ${lock.pid}) ${within ? `did not answer within ${within / 1000} s` : 'is not answering'}: ` +
      'it may be busy; if it stays that way, run `coplan restart`',
  );
}

async function api<T>(lock: DaemonLock, route: string, init?: RequestInit, timeoutMs = 5_000): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl(lock)}${route}`, {
      ...init,
      // A hung daemon takes the connection and never answers.
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}`, ...(init?.headers ?? {}) },
    });
    text = await res.text();
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError') throw notAnswering(lock, timeoutMs);
    throw err;
  }
  // Refusals (401, 403) come back as plain text: say what they said.
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Said(`the daemon answered ${res.status}: ${text.trim().slice(0, 200)}`);
  }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    throw new Said(`the daemon answered ${res.status}: ${typeof error === 'string' ? error : text.trim().slice(0, 200)}`);
  }
  return body as T;
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
    // A lock left by a daemon that died may name a pid that is someone
    // else's process now: that is never signalled. One whose port takes the
    // connection but is slow to answer is the daemon, hung — the very one
    // to stop.
    const state = await probeLock(lock);
    if (state === 'stale') {
      releaseLock(lock.pid);
      console.log('not running (removed a lock left by a daemon that is gone)');
      return 0;
    }
    if (state === 'busy') console.log(`the daemon (pid ${lock.pid}) is not answering; stopping it anyway`);
    try {
      process.kill(lock.pid, 'SIGTERM');
    } catch (err) {
      console.error(`could not stop pid ${lock.pid}: ${(err as Error).message}`);
      return 1;
    }
    // One that answered is saving its sessions on the way out: it has time.
    // One that did not may be stuck too hard to run its SIGTERM handler at
    // all (it is JavaScript), and nothing but SIGKILL stops that.
    if (await exits(lock.pid, state === 'live' ? 15_000 : 3_000)) {
      releaseLock(lock.pid);
      console.log(`stopped pid ${lock.pid}`);
      return 0;
    }
    try {
      process.kill(lock.pid, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error(`could not stop pid ${lock.pid}: ${(err as Error).message}`);
        return 1;
      }
    }
    if (!(await exits(lock.pid, 2_000))) {
      console.error(`could not stop pid ${lock.pid}: it is still running`);
      return 1;
    }
    releaseLock(lock.pid);
    console.log(`stopped pid ${lock.pid} (it did not answer SIGTERM, so it was killed)`);
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
    const lock = (await readVerifiedLock());
    if (!lock) return commands['start']!(args);

    try {
      // From this plugin's build: the daemon may be another install's, older.
      // A hung daemon never answers: api() gives up, and it is stopped instead.
      const result = await api<{ restarting?: boolean }>(lock, '/api/daemon/restart', { method: 'POST', body: JSON.stringify({ entry: DAEMON_ENTRY }) });
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

    if ((await commands['stop']!(args)) !== 0) return 1;
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
    const found = await readLockState();
    if (found?.state === 'busy') throw notAnswering(found.lock);
    const lock = found?.lock ?? null;
    if (!lock) console.log('(no daemon running: live sessions are identified by age alone)');

    const outcome = lock
      ? await api<{ result: CleanupOutcome }>(
          lock,
          '/api/storage/clean',
          { method: 'POST', body: JSON.stringify({ groups, dryRun }) },
          // Removing many files can take a while.
          15_000,
        ).then((r) => r.result)
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
    const found = await readLockState();
    if (!found) {
      console.log('not running');
      return 0;
    }
    const { lock } = found;
    console.log(`coplan v${lock.version} on ${baseUrl(lock)} (pid ${lock.pid})`);
    if (found.state === 'busy') throw notAnswering(lock);
    if (lock.version !== VERSION) console.log(`  this plugin is v${VERSION}: run \`coplan restart\` so the daemon runs it`);
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

  /** Install in your agents and walk through the settings: what
   *  ./setup.sh runs once it has built the clone. */
  async setup(args) {
    return runSetup(args);
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

/** Whether the process is gone within `ms`. */
async function exits(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (gone(pid)) return true;
    await sleep(100);
  }
  return gone(pid);
}

/** Exited, if not yet reaped: a zombie answers signals, but it has stopped
 *  for good. Where init is slow to reap (or never does, in some containers),
 *  only Linux's process table tells. */
function gone(pid: number): boolean {
  if (!isPidAlive(pid)) return true;
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.startsWith('Z');
  } catch {
    return false;
  }
}

/** Remove the lock, if it is still this daemon's: never a successor's. */
function releaseLock(pid: number): void {
  if (readLock()?.pid === pid) rmSync(paths.lockFile(), { force: true });
}

/** Wait for the lock to be claimed by a process other than the one that had it. */
async function waitForNewDaemon(previousPid: number): Promise<DaemonLock | null> {
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const lock = (await readVerifiedLock());
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
  check [implement|review|final] [--since commit] [--files a,b] [--base ref] [--all] [--skip name]... [--list] [--json]
             run that stage's hooks from .coplan/config.json (default: review),
             only those for what changed: since --since, else since the last
             commit; at final, since --base. --files names the files instead,
             --all runs every hook, --skip leaves one out (once per check)
  init [--print] [--force]
             write a starting .coplan/config.json from the repository's scripts
  setup [--yes] [--agents claude,codex,cursor|none]
             install in your agents and walk through the settings
             (./setup.sh in the clone builds first, then runs this)
  version    print the version
`);
}

// Nothing left reading what this says (`coplan check 2>&1 | head`, an agent
// that closed the pipe: EPIPE; a terminal closed: EIO) is no reason to stop
// part way, before a check is stopped, say: what cannot be written is let go.
// On stderr, whatever the failure (a full disk too): it says what is going
// on, never the result. On stdout, where the report goes, any other failure
// (a full disk under `--json > report.json`) ends it, as a failure (see
// output.ts and exit): at once with no command running; a running one ends
// itself, so nothing it started is killed part way.
process.stderr.on('error', () => {});
let running = false;
watchStdout(() => {
  if (!running) exit(1);
});

/** Exits once what was said on stdout is written: a report that could not
 *  be is a failure, not an exit 0 with nothing there. A write's failure is
 *  told after its callback, so the tick after that is waited for too. A
 *  slow reader (a pager on its first page) is waited for, as any command
 *  writing to a pipe waits; one that goes away closes it (EPIPE), which
 *  ends the wait. One that keeps the pipe open and never reads it (any
 *  process holding its read end, a grandchild too) holds the CLI until it
 *  reads or goes. */
function exit(code: number): void {
  const leave = () => {
    const unwritten = stdoutFailure();
    if (unwritten) {
      console.error(`coplan: the output could not be written (${unwritten.code ?? unwritten.message}).`);
      process.exit(code === 0 ? 1 : code);
    }
    process.exit(code);
  };
  // Nothing pending: no write to wait on (a zero-length one need not call
  // back where stdout to a pipe is asynchronous, as on Windows).
  if (process.stdout.writableLength === 0) setImmediate(leave);
  else process.stdout.write('', () => setImmediate(leave));
}

const [, , command = 'status', ...rest] = process.argv;
const handler = commands[command];
if (!handler) {
  usage();
  exit(command === 'help' || command === '--help' ? 0 : 2);
} else {
  running = true;
  handler(rest)
    .finally(() => {
      running = false;
    })
    .then(exit)
    .catch((err: unknown) => {
      console.error(err instanceof Said ? `coplan: ${err.message}` : ((err as Error)?.stack ?? String(err)));
      exit(1);
    });
}
