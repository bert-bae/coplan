import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIdle } from '../daemon/idle.ts';

/** When the daemon exits for want of anything to do (idleShutdownMinutes). */

const MIN = 60_000;
const idleMs = 120 * MIN;
const startedAt = 1_000_000;
const at = (minutes: number) => startedAt + minutes * MIN;
const none = { startedAt, clients: 0, sessions: () => [] };

test('the daemon stays up its idle time from its own start, however it was started', () => {
  // Started for a link (`coplan url`) with nothing active: the page has its idle time to be opened.
  assert.equal(isIdle(at(1), none, idleMs), false, 'a minute in');
  assert.equal(isIdle(at(119), none, idleMs), false);
  assert.equal(isIdle(at(121), none, idleMs), true, 'past it');
});

test('a page open, or a live session active within the idle time, keeps it up', () => {
  assert.equal(isIdle(at(200), { ...none, clients: 1 }, idleMs), false);
  assert.equal(isIdle(at(200), { ...none, sessions: () => [{ status: 'idle' as const, updatedAt: at(150) }] }, idleMs), false);
  assert.equal(isIdle(at(200), { ...none, sessions: () => [{ status: 'ended' as const, updatedAt: at(150) }] }, idleMs), true, 'not an ended one');
  assert.equal(isIdle(at(200), { ...none, sessions: () => [{ status: 'idle' as const, updatedAt: at(50) }] }, idleMs), true, 'nor one quiet that long');
});

test('with a page open, the sessions are not even looked at', () => {
  let asked = false;
  isIdle(at(200), { ...none, clients: 1, sessions: () => ((asked = true), []) }, idleMs);
  assert.equal(asked, false);
});
