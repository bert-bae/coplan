import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanStorage, cleanStorage } from '../daemon/housekeeping.ts';
import type { CleanupGroupId, StorageReport } from '../shared/types.ts';

/**
 * Housekeeping.
 *
 * The failure mode of this module is not "left something behind" — it is
 * "removed something the user wanted", and every case here is a way that
 * could happen: a session the daemon is still holding, a session evicted from
 * memory an hour ago that is about to be resumed, a daemon that is still
 * running.
 */

let home: string;

before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-hk-home-'));
  process.env['CC_HARNESS_HOME'] = home;
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
  rmSync(path.join(home, 'daemon.log'), { force: true });
  rmSync(path.join(home, 'daemon.json'), { force: true });
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
});

const DAY = 24 * 60 * 60 * 1000;

/** A session directory, aged by backdating everything in it. */
function session(id: string, ageMs: number, bytes = 200): string {
  const dir = path.join(home, 'sessions', id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ sessionId: id, pad: 'x'.repeat(bytes) }));
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(file, when, when);
  utimesSync(dir, when, when);
  return dir;
}

function group(report: StorageReport, id: CleanupGroupId) {
  const found = report.groups.find((g) => g.id === id);
  assert.ok(found, `expected a "${id}" group in the report`);
  return found;
}

const opts = () => ({});

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

test('a session the daemon is holding is never offered up', () => {
  session('resident', 30 * DAY);
  const report = scanStorage({ ...opts(), liveSessionIds: ['resident'] });
  assert.equal(group(report, 'sessions').count, 0);

  cleanStorage({ ...opts(), liveSessionIds: ['resident'], groups: ['sessions'] });
  assert.ok(existsSync(path.join(home, 'sessions', 'resident')), 'a live session must survive a clean');
});

test('a session evicted from memory but touched recently is kept', () => {
  // The store drops ended sessions from memory after an hour and leaves them
  // on disk precisely so `--resume` can find them. Removing one the same
  // afternoon would delete the history the eviction was designed to preserve.
  session('evicted-recently', 2 * 60 * 60 * 1000);
  const report = scanStorage(opts());
  assert.equal(group(report, 'sessions').count, 0);
});

test('a session directory nothing has touched in a day is reclaimable', () => {
  const dir = session('cold', 3 * DAY, 500);
  const report = scanStorage(opts());
  assert.equal(group(report, 'sessions').count, 1);
  assert.ok(group(report, 'sessions').bytes >= 500);

  const result = cleanStorage({ ...opts(), groups: ['sessions'] });
  assert.equal(result.removed, 1);
  assert.equal(existsSync(dir), false);
});

test('age is read from the newest file, not the directory', () => {
  // A long-running session rewrites state.json in place, which never moves
  // the directory's own mtime. Judging by the directory alone would offer up
  // a session that was written to seconds ago.
  const dir = session('busy', 10 * DAY);
  const fresh = path.join(dir, 'state.json');
  const now = Date.now() / 1000;
  utimesSync(fresh, now, now);

  assert.equal(group(scanStorage(opts()), 'sessions').count, 0);
});

test('a dry run reports what would go and removes nothing', () => {
  const dir = session('cold', 3 * DAY);
  const result = cleanStorage({ ...opts(), dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(result.freedBytes > 0);
  assert.equal(existsSync(dir), true, 'a dry run must not touch the filesystem');
});

test('cleaning one group leaves the others alone', () => {
  const dir = session('cold', 3 * DAY);
  const junk = path.join(home, 'daemon.json');
  writeFileSync(junk, JSON.stringify({ pid: 0, port: 1, token: 't' }));

  const result = cleanStorage({ ...opts(), groups: ['lock'] });
  assert.equal(result.groups.length, 1);
  assert.equal(existsSync(dir), true, 'the session group was not selected');
  assert.equal(existsSync(junk), false);
});

/* ------------------------------------------------------------------ *
 * Interrupted writes
 * ------------------------------------------------------------------ */

test('an abandoned .tmp is reclaimed even inside a live session', () => {
  // The rename that finishes a persist is atomic, so a `.tmp` that is minutes
  // old belongs to a daemon that died mid-write — whether or not the session
  // it belongs to is still going.
  const dir = session('live', 60_000);
  const partial = path.join(dir, '.state.1234.tmp');
  writeFileSync(partial, '{"half":');
  age(partial, 10 * 60 * 1000);

  const report = scanStorage({ ...opts(), liveSessionIds: ['live'] });
  assert.equal(group(report, 'partial-writes').count, 1);

  cleanStorage({ ...opts(), liveSessionIds: ['live'], groups: ['partial-writes'] });
  assert.equal(existsSync(partial), false);
  assert.ok(existsSync(path.join(dir, 'state.json')), 'the real state file is untouched');
});

test('a .tmp from a write still in flight is left alone', () => {
  const dir = session('live', 60_000);
  writeFileSync(path.join(dir, '.diff.99.tmp'), 'x');
  assert.equal(group(scanStorage({ ...opts(), liveSessionIds: ['live'] }), 'partial-writes').count, 0);
});

/* ------------------------------------------------------------------ *
 * Log and lock
 * ------------------------------------------------------------------ */

test('an oversized log is trimmed to its tail, not deleted', () => {
  const file = path.join(home, 'daemon.log');
  const line = `${'x'.repeat(200)}\n`;
  writeFileSync(file, line.repeat(9000)); // ~1.8 MB
  const report = scanStorage(opts());
  assert.equal(group(report, 'log').count, 1);
  assert.ok(group(report, 'log').bytes > 0, 'only the part being dropped counts as reclaimed');

  cleanStorage({ ...opts(), groups: ['log'] });
  const after = readFileSync(file, 'utf8');
  assert.ok(existsSync(file), 'the daemon appends to this file; it must still exist');
  assert.ok(after.length < 400_000, `expected a trimmed log, got ${after.length} bytes`);
  assert.ok(after.length > 0, 'the recent entries are kept');
  assert.ok(after.startsWith('x'), 'the trim lands on a line boundary');
});

test('a log under the limit is left alone', () => {
  writeFileSync(path.join(home, 'daemon.log'), 'a few lines\n');
  assert.equal(group(scanStorage(opts()), 'log').count, 0);
});

test('a lock file is reclaimable only once its process is gone', () => {
  const file = path.join(home, 'daemon.json');
  writeFileSync(file, JSON.stringify({ pid: process.pid, port: 1, token: 't', version: '0', startedAt: 0, host: '' }));
  assert.equal(group(scanStorage(opts()), 'lock').count, 0, 'a running daemon owns its lock');

  writeFileSync(file, JSON.stringify({ pid: 0, port: 1, token: 't', version: '0', startedAt: 0, host: '' }));
  assert.equal(group(scanStorage(opts()), 'lock').count, 1);
  cleanStorage({ ...opts(), groups: ['lock'] });
  assert.equal(existsSync(file), false);
});

/* ------------------------------------------------------------------ *
 * Containment
 * ------------------------------------------------------------------ */

test('cleaning never reaches outside the harness home', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'cc-harness-hk-outside-'));
  const victim = path.join(outside, 'precious.txt');
  writeFileSync(victim, 'keep me');
  age(victim, 30 * DAY);
  try {
    const result = cleanStorage({ groups: ['sessions', 'partial-writes', 'log', 'lock'] });
    assert.equal(result.failed.length, 0);
    assert.equal(existsSync(victim), true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

/** Backdate a path so an age threshold treats it as old. */
function age(target: string, ms: number): void {
  const when = (Date.now() - ms) / 1000;
  utimesSync(target, when, when);
}
