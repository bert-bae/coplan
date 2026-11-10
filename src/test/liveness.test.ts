import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { baseUrl, isPidAlive, probeLock } from '../shared/paths.ts';
import type { DaemonLock } from '../shared/types.ts';

/**
 * A lock outlives the daemon that wrote it — a crash, a kill -9, a reboot —
 * and its pid may be some other process's by then. These hold that such a
 * lock is never taken for a running daemon: a new one starts over it, and
 * nothing signals the process that has the pid now.
 */

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = path.join(DIST, 'daemon', 'main.js');
const CLI = path.join(DIST, 'cli', 'main.js');

const homes: string[] = [];
const children: ChildProcess[] = [];

after(() => {
  for (const c of children) if (c.pid && isPidAlive(c.pid)) c.kill('SIGKILL');
  for (const h of homes) {
    // Stop any daemon a test started in this home.
    try {
      const lock = JSON.parse(readFileSync(path.join(h, 'daemon.json'), 'utf8')) as DaemonLock;
      if (lock.pid !== process.pid && isPidAlive(lock.pid)) process.kill(lock.pid, 'SIGKILL');
    } catch {
      /* none */
    }
    rmSync(h, { recursive: true, force: true });
  }
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** Some other long-lived process: the one a reused pid now belongs to. */
function bystander(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function home(lock: Partial<DaemonLock>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-harness-liveness-'));
  homes.push(dir);
  writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ token: 't', host: '127.0.0.1', version: '0.0.0', startedAt: 1, ...lock }));
  return dir;
}

test('the probe tells a live daemon from a stale lock and from a busy one', async () => {
  const port = await closedPort();
  assert.equal(await probeLock({ pid: process.pid, port, token: 't', host: '127.0.0.1' } as DaemonLock), 'stale', 'nothing listens');

  let pid = process.pid;
  let hold = 0;
  const server = http.createServer((req, res) => {
    setTimeout(() => res.end(JSON.stringify({ ok: true, pid })), hold).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const lock = { pid: process.pid, port: (server.address() as net.AddressInfo).port, token: 't', host: '127.0.0.1' } as DaemonLock;
  try {
    assert.equal(await probeLock(lock), 'live');
    pid = process.pid + 1;
    assert.equal(await probeLock(lock), 'stale', 'something else answers there');
    hold = 1_000;
    assert.equal(await probeLock(lock, 200), 'busy', 'slow is not gone');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a daemon starts over a lock whose pid is some other live process', async () => {
  const other = bystander();
  const dir = home({ pid: other.pid!, port: await closedPort() });
  const daemon = spawn(process.execPath, [DAEMON], { env: { ...process.env, CC_HARNESS_HOME: dir }, stdio: 'ignore' });
  children.push(daemon);
  let lock: DaemonLock | null = null;
  for (let i = 0; i < 80 && !lock; i++) {
    await sleep(100);
    const now = JSON.parse(readFileSync(path.join(dir, 'daemon.json'), 'utf8')) as DaemonLock;
    if (now.pid === daemon.pid) lock = now;
  }
  assert.ok(lock, 'the new daemon claimed the lock');
  assert.equal(await probeLock(lock), 'live');
  assert.ok(isPidAlive(other.pid!), 'the process with the old pid was left alone');
  daemon.kill('SIGTERM');
});

test('`coplan doctor` starts a daemon over a stale lock instead of probing a dead port', async () => {
  const other = bystander();
  const port = await closedPort();
  const dir = home({ pid: other.pid!, port });
  const { out } = await cli(dir, 'doctor');
  const lock = JSON.parse(readFileSync(path.join(dir, 'daemon.json'), 'utf8')) as DaemonLock;
  assert.notEqual(lock.pid, other.pid, 'a daemon of its own holds the lock');
  assert.equal(out.split('\n').find((l) => l.includes('daemon reachable')), `✓ daemon reachable — ${baseUrl(lock)}`, out);
  assert.equal(await probeLock(lock), 'live');
  assert.ok(isPidAlive(other.pid!), 'the process with the old pid was left alone');
});

test('`coplan stop` never signals a pid its daemon did not confirm', async () => {
  const other = bystander();
  const dir = home({ pid: other.pid!, port: await closedPort() });
  const out = await new Promise<string>((resolve) => {
    execFile(process.execPath, [CLI, 'stop'], { env: { ...process.env, CC_HARNESS_HOME: dir } }, (_err, stdout, stderr) => resolve(`${stdout}${stderr}`));
  });
  assert.match(out, /not running \(removed a lock left by a daemon that is gone\)/);
  await sleep(200);
  assert.ok(isPidAlive(other.pid!), 'the bystander is still running');
  assert.equal(existsSync(path.join(dir, 'daemon.json')), false);
});

/**
 * A daemon whose event loop is stuck: it holds its port (connections are
 * accepted, nothing answers) and has a SIGTERM handler that can never run.
 */
async function hungDaemon(): Promise<{ dir: string; pid: number }> {
  const dir = home({ pid: 0, port: 0 });
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const http = require('node:http'), fs = require('node:fs');
process.on('SIGTERM', () => process.exit(0));
const server = http.createServer(() => {});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'daemon.json'))}, JSON.stringify({ pid: process.pid, port: server.address().port, token: 't', host: '127.0.0.1', version: '0.0.0', startedAt: 1 }));
  for (;;) {}
});`,
    ],
    { stdio: 'ignore' },
  );
  children.push(child);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      const lock = JSON.parse(readFileSync(path.join(dir, 'daemon.json'), 'utf8')) as DaemonLock;
      if (lock.pid === child.pid) return { dir, pid: child.pid };
    } catch {
      /* caught mid-write */
    }
  }
  throw new Error('the hung daemon did not start');
}

/** The CLI as run from a terminal: no agent's session in its environment. */
function cli(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CC_HARNESS_HOME: dir };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CURSOR_CONVERSATION_ID']) delete env[key];
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, env, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

test('commands that ask a hung daemon give up, and say to restart it; the doctor does not call it reachable', async () => {
  const { dir } = await hungDaemon();
  const [status, url, clean, doctor] = await Promise.all([cli(dir, 'status'), cli(dir, 'url'), cli(dir, 'clean', '--dry-run'), cli(dir, 'doctor')]);
  for (const [name, run] of Object.entries({ status, url, clean, doctor })) {
    assert.notEqual(run.code, -1, `${name} gave up by itself, before the test's own limit:\n${run.out}`);
  }
  for (const [name, run] of Object.entries({ status, clean, doctor })) {
    assert.notEqual(run.code, 0, name);
    assert.match(run.out, /not answering.*coplan restart/, `${name}:\n${run.out}`);
    assert.doesNotMatch(run.out, /\n\s+at /, `${name} says it, with no stack trace:\n${run.out}`);
  }
  assert.match(url.out, /\?token=t/, 'the url, for when it answers again');
  assert.equal(doctor.out.split('\n').some((l) => l.startsWith('✓ daemon reachable')), false, doctor.out);
});

test("a command says the daemon's error, not a crash on the answer it took for data", async () => {
  // Healthy to the probe, failing every request: as a daemon whose handler throws.
  const dir = home({ pid: 0, port: 0 });
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const http = require('node:http'), fs = require('node:fs');
const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 500, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/health' ? { pid: process.pid } : { error: 'internal error' }));
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'daemon.json'))}, JSON.stringify({ pid: process.pid, port: server.address().port, token: 't', host: '127.0.0.1', version: '0.0.0', startedAt: 1 }));
});`,
    ],
    { stdio: 'ignore' },
  );
  children.push(child);
  for (let i = 0; i < 50 && !existsSync(path.join(dir, 'daemon.json')); i++) await sleep(100);
  await sleep(100);
  const { code, out } = await cli(dir, 'status');
  assert.equal(code, 1, out);
  assert.match(out, /the daemon answered 500: internal error/, out);
  assert.doesNotMatch(out, /TypeError|\n\s+at /, out);
  child.kill('SIGKILL');
});

test('`coplan stop` stops a daemon that is hung, and says how', async () => {
  const { dir, pid } = await hungDaemon();
  const { code, out } = await cli(dir, 'stop');
  assert.equal(code, 0, out);
  await sleep(200);
  assert.equal(isPidAlive(pid), false, `the hung daemon is gone:\n${out}`);
  assert.match(out, /did not answer SIGTERM, so it was killed/);
  assert.equal(existsSync(path.join(dir, 'daemon.json')), false, 'and its lock with it');
});

test('`coplan restart` replaces a daemon that is hung, instead of hanging with it', async () => {
  const { dir, pid } = await hungDaemon();
  const started = Date.now();
  const { code, out } = await cli(dir, 'restart');
  assert.equal(code, 0, out);
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms`);
  await sleep(200);
  assert.equal(isPidAlive(pid), false, `the hung daemon is gone:\n${out}`);
  const next = JSON.parse(readFileSync(path.join(dir, 'daemon.json'), 'utf8')) as DaemonLock;
  assert.notEqual(next.pid, pid);
  assert.equal(await probeLock(next), 'live', 'and a new one answers');
});
