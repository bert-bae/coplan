import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, mergeConfig } from '../shared/config.ts';

test('known keys override', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { autoOpen: true, idleShutdownMinutes: 5 });
  assert.equal(cfg.autoOpen, true);
  assert.equal(cfg.idleShutdownMinutes, 5);
  assert.equal(cfg.promptNotice, true);
});

test('keys from the old review loop are ignored rather than carried along', () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { gateHoldSeconds: 300, ship: { provider: 'gh' } }) as unknown as Record<string, unknown>;
  assert.equal(cfg['gateHoldSeconds'], undefined);
  assert.equal(cfg['ship'], undefined);
});

test('a value of the wrong type is ignored', () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { promptNotice: 'no' }).promptNotice, true);
});

test('merging does not mutate the defaults', () => {
  mergeConfig(DEFAULT_CONFIG, { autoOpen: true });
  assert.equal(DEFAULT_CONFIG.autoOpen, false);
});

test('garbage input is ignored rather than throwing', () => {
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, 'nonsense'), DEFAULT_CONFIG);
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, null), DEFAULT_CONFIG);
});
