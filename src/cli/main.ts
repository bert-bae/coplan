/**
 * `harness` — the operator CLI.
 *
 *   harness start|stop|restart|status|open|url|logs|doctor
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
import { openInBrowser } from '../daemon/browser.ts';
import type { DaemonLock, SessionSummary } from '../shared/types.ts';

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
    console.log(`cc-harness running on ${baseUrl(lock)} (pid ${lock.pid})`);
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

  async restart(args) {
    await commands['stop']!(args);
    await sleep(400);
    return commands['start']!(args);
  },

  async status() {
    const lock = readLiveLock();
    if (!lock) {
      console.log('cc-harness: not running');
      return 1;
    }
    console.log(`cc-harness v${lock.version} · pid ${lock.pid} · ${baseUrl(lock)}`);
    try {
      const { sessions } = await api<{ sessions: SessionSummary[] }>(lock, '/api/sessions');
      if (sessions.length === 0) {
        console.log('no sessions registered yet');
        return 0;
      }
      console.log('');
      for (const s of sessions) {
        const flags = [
          s.openGates ? `${s.openGates} open gate` : '',
          s.pendingFeedback ? `${s.pendingFeedback} unread` : '',
        ]
          .filter(Boolean)
          .join(', ');
        console.log(
          `  ${s.sessionId.slice(0, 8)}  ${pad(s.stage, 14)} ${pad(s.status, 8)} ` +
            `${pad(s.repoName ?? path.basename(s.cwd), 20)} ${s.branch ?? ''}${flags ? `  [${flags}]` : ''}`,
        );
      }
    } catch (err) {
      console.error(`could not query the daemon: ${(err as Error).message}`);
      return 1;
    }
    return 0;
  },

  async open(args) {
    const lock = await ensureDaemon();
    if (!lock) return 1;
    const sessionId = args[0] ?? process.env['CLAUDE_CODE_SESSION_ID'];
    const url = uiUrl(lock, sessionId);
    openInBrowser(url);
    console.log(url);
    return 0;
  },

  async url(args) {
    const lock = await ensureDaemon();
    if (!lock) return 1;
    console.log(uiUrl(lock, args[0] ?? process.env['CLAUDE_CODE_SESSION_ID']));
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

  async version() {
    console.log(VERSION);
    return 0;
  },
};

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function usage(): void {
  console.log(`cc-harness v${VERSION}

usage: harness <command>

  start      start the daemon (idempotent)
  stop       stop the daemon
  restart    stop then start
  status     show the daemon and every registered session
  open [id]  open the UI in a browser
  url  [id]  print the UI url (with auth token)
  logs       tail the daemon log
  doctor     verify the plugin wiring end to end
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
