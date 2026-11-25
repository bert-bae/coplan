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
