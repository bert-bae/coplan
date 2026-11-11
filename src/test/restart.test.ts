import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl, isPidAlive } from '../shared/paths.ts';
import type { DaemonLock } from '../shared/types.ts';

/**
 * Restarting the daemon in place.
 *
 * The reason this is worth a real subprocess: the promise the feature makes is
 * that a browser tab which asked for the restart is still looking at a working
 * page afterwards. That only holds if the successor comes back on the *same*
 * port with the *same* token — everything else about the handover is invisible
 * to the person who clicked the button.
 */

const DAEMON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'main.js');

let home: string;
let daemon: ChildProcess;
let first: DaemonLock;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-restart-'));
  process.env['CC_HARNESS_HOME'] = home;
  daemon = spawn(process.execPath, [DAEMON], { env: { ...process.env, CC_HARNESS_HOME: home }, stdio: 'ignore' });

  const lock = await waitForLock(0);
  if (!lock) throw new Error('daemon did not start');
  first = lock;
});

after(async () => {
  // The successor is detached and is not `daemon`, so stop whatever holds the
  // lock now as well as the process this file spawned.
  const live = readLiveLock();
  if (live) {
    try {
      process.kill(live.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (daemon && daemon.exitCode === null) daemon.kill('SIGKILL');
  await sleep(300);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Poll until a daemon that is not `previousPid` owns the lock. */
async function waitForLock(previousPid: number, timeoutMs = 20_000): Promise<DaemonLock | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readLiveLock();
    if (lock && lock.pid !== previousPid) return lock;
    await sleep(100);
  }
  return null;
}

test('a second start finds the running daemon, says so and exits, --force or not', async () => {
  // `--force` once started a second daemon beside the first; nothing passes it.
  for (const args of [[], ['--force']]) {
    const out = await new Promise<string>((resolve, reject) => {
      // Killed if it stays: a second daemon would never exit on its own.
      const child = spawn(process.execPath, [DAEMON, ...args], { env: { ...process.env, CC_HARNESS_HOME: home }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
      let text = '';
      child.stdout!.on('data', (d: Buffer) => (text += d.toString()));
      child.on('error', reject);
      child.on('exit', () => resolve(text));
    });
    assert.deepEqual({ ...JSON.parse(out) }, { alreadyRunning: true, ...first });
  }
  assert.equal(readLiveLock()?.pid, first.pid, 'the running daemon still holds the lock');
});

test('the daemon hands its address and token to its replacement', async () => {
  const res = await fetch(`${baseUrl(first)}/api/daemon/restart`, {
    method: 'POST',
    headers: { authorization: `Bearer ${first.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { restarting: boolean };
  assert.equal(body.restarting, true);

  const second = await waitForLock(first.pid);
  assert.ok(second, 'a replacement daemon should have claimed the lock');
  assert.notEqual(second.pid, first.pid, 'it is a new process');
  assert.equal(second.port, first.port, 'an open browser tab is still pointed at a live daemon');
  assert.equal(second.token, first.token, 'and the cookie it holds still authorizes it');

  // The token has to survive the handover without being left in the
  // environment for anything the daemon starts.
  assert.equal(await tokenWorks(second), true);

  await waitUntil(() => !isPidAlive(first.pid));
  assert.equal(isPidAlive(first.pid), false, 'the outgoing daemon exits rather than lingering');
});

test('the replacement serves the API on the inherited address', async () => {
  const lock = readLiveLock();
  assert.ok(lock, 'a daemon should be running');
  const health = await fetch(`${baseUrl(lock)}/health`).then((r) => r.json() as Promise<{ pid: number }>);
  assert.equal(health.pid, lock.pid);

  const sessions = await fetch(`${baseUrl(lock)}/api/sessions`, {
    headers: { authorization: `Bearer ${lock.token}` },
  });
  assert.equal(sessions.status, 200);
});

async function tokenWorks(lock: DaemonLock): Promise<boolean> {
  const res = await fetch(`${baseUrl(lock)}/api/sessions`, {
    headers: { authorization: `Bearer ${lock.token}` },
  });
  return res.ok;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) await sleep(50);
}
