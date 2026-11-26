import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseUrl, readLiveLock, remoteLock } from '../shared/paths.ts';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { COPLAN_REMOTE: process.env['COPLAN_REMOTE'], COPLAN_TOKEN: process.env['COPLAN_TOKEN'] };
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('COPLAN_REMOTE and COPLAN_TOKEN name a remote daemon, and only both do', () => {
  withEnv({ COPLAN_REMOTE: 'https://plan.lan:8443/', COPLAN_TOKEN: 't' }, () => {
    const lock = remoteLock();
    assert.equal(baseUrl(lock!), 'https://plan.lan:8443');
    assert.equal(lock!.token, 't');
    assert.equal(readLiveLock()?.origin, 'https://plan.lan:8443');
  });
  withEnv({ COPLAN_REMOTE: 'http://plan.lan:4321', COPLAN_TOKEN: undefined }, () => assert.equal(remoteLock(), null));
  withEnv({ COPLAN_REMOTE: 'ftp://plan.lan', COPLAN_TOKEN: 't' }, () => assert.equal(remoteLock(), null));
  withEnv({ COPLAN_REMOTE: 'not a url', COPLAN_TOKEN: 't' }, () => assert.equal(remoteLock(), null));
});

test('sessions on two machines with the same folder and pid are told apart', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'cc-harness-remote-'));
  process.env['CC_HARNESS_HOME'] = home;
  try {
    const { SessionStore } = await import('../daemon/store.ts');
    const store = new SessionStore();
    store.ensure('a', '/code/app');
    store.update('a', { machine: 'desktop', claudePid: 7 });
    store.ensure('b', '/code/app');
    store.update('b', { machine: 'laptop', claudePid: 7 });
    assert.equal(store.findByCwd('/code/app', undefined, 'laptop')?.sessionId, 'b');
    assert.equal(store.findByPid(7, undefined, 'desktop')?.sessionId, 'a');
    assert.equal(store.findByCwd('/code/app'), undefined, 'a local call never lands on a remote session');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a self-hosted daemon takes each listed key, refuses others, and trusts each public address', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const home = mkdtempSync(join(tmpdir(), 'cc-harness-keys-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const daemon = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'daemon', 'main.js')], {
    env: { ...process.env, CC_HARNESS_HOME: home, COPLAN_PORT: String(port), COPLAN_TOKEN: 'k1, k2', COPLAN_SELF_HOSTED: '1', COPLAN_PUBLIC_URL: 'http://127.0.0.1:5000,http://127.0.0.1:6000' },
    stdio: 'ignore',
  });
  try {
    const call = (key: string, origin?: string) =>
      fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'GET', headers: { authorization: `Bearer ${key}`, ...(origin ? { origin } : {}) } }).then((r) => r.status);
    for (let i = 0; i < 50 && (await call('k1').catch(() => 0)) !== 200; i++) await sleep(100);
    assert.equal(await call('k1'), 200);
    assert.equal(await call('k2'), 200);
    assert.equal(await call('k3'), 401);
    const post = (origin: string) =>
      fetch(`http://127.0.0.1:${port}/api/login/ticket`, { method: 'POST', headers: { authorization: 'Bearer k1', origin, 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status);
    assert.equal(await post('http://127.0.0.1:6000'), 200);
    assert.equal(await post('http://127.0.0.1:7000'), 403);
  } finally {
    daemon.kill();
    // Gone before its folder is: it writes there as it exits.
    await new Promise((done) => (daemon.exitCode === null ? daemon.once('exit', done) : done(null)));
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
