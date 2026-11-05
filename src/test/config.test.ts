import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigCache, DEFAULT_CONFIG, loadConfigReport, mergeConfig } from '../shared/config.ts';

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

test('what cannot be used is said, naming the file, and the layer before is used', () => {
  const errors: string[] = [];
  const cfg = mergeConfig(DEFAULT_CONFIG, { autoopen: true, idleShutdownMinutes: -5, promptNotice: 'no' }, { errors, where: 'g: ' });
  assert.deepEqual(cfg, DEFAULT_CONFIG);
  const said = errors.join('\n');
  assert.match(said, /g: "autoopen" is not a setting Coplan reads/);
  assert.match(said, /"idleShutdownMinutes" must be a whole number of minutes, 0 or more; -5 is not, so 120 is used/);
  assert.match(said, /"promptNotice" must be true or false/);
  const quiet: string[] = [];
  mergeConfig(DEFAULT_CONFIG, { gateHoldSeconds: 3 }, { errors: quiet });
  assert.deepEqual(quiet, [], 'a retired key is not an error');
});

function homes(global?: string, project?: string): { configDir: string; projectDir: string } {
  const configDir = mkdtempSync(path.join(tmpdir(), 'coplan-cfg-'));
  const projectDir = mkdtempSync(path.join(tmpdir(), 'coplan-repo-'));
  if (global !== undefined) writeFileSync(path.join(configDir, 'config.json'), global);
  if (project !== undefined) {
    mkdirSync(path.join(projectDir, '.claude'));
    writeFileSync(path.join(projectDir, '.claude', 'harness.json'), project);
  }
  return { configDir, projectDir };
}

function removeHomes(dirs: { configDir: string; projectDir: string }): void {
  rmSync(dirs.configDir, { recursive: true, force: true });
  rmSync(dirs.projectDir, { recursive: true, force: true });
}

test('a file that is not JSON is reported, not silently ignored; comments are fine', () => {
  const dirs = homes('{ "autoOpen": true, // mine\n }', '{ "promptNotice": ');
  try {
    const report = loadConfigReport(dirs);
    assert.equal(report.config.autoOpen, true, 'a comment and a trailing comma are allowed');
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]!, /harness\.json is not valid JSON, so none of it is used/);
  } finally {
    removeHomes(dirs);
  }
});

test('a repository cannot set what only the daemon-wide config may', () => {
  const dirs = homes('{ "idleShutdownMinutes": 30 }', '{ "idleShutdownMinutes": 0, "autoOpen": true }');
  try {
    const report = loadConfigReport(dirs);
    assert.equal(report.config.idleShutdownMinutes, 30);
    assert.equal(report.config.autoOpen, true);
    assert.match(report.errors.join('\n'), /"idleShutdownMinutes" can only be set in the global config/);
  } finally {
    removeHomes(dirs);
  }
});

test('the cache reads a file again once it changes, and says each problem once', () => {
  const dirs = homes('{ "autoOpen": false }');
  const said: string[] = [];
  const cache = new ConfigCache(dirs.configDir, (m) => said.push(m));
  try {
    assert.equal(cache.get(dirs.projectDir).autoOpen, false);
    const file = path.join(dirs.configDir, 'config.json');
    writeFileSync(file, '{ "autoOpen": true, "nope": 1 }');
    // A write in the same millisecond is told apart by its size; and by this.
    utimesSync(file, new Date(), new Date(Date.now() + 2000));
    assert.equal(cache.get(dirs.projectDir).autoOpen, true, 'an edit counts without a restart');
    assert.equal(cache.get().autoOpen, true);
    cache.get(dirs.projectDir);
    assert.equal(said.filter((m) => /"nope"/.test(m)).length, 1);
  } finally {
    removeHomes(dirs);
  }
});

test('the documented defaults are the defaults', () => {
  const doc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'CONFIG.md'), 'utf8');
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.match(doc, new RegExp(`^\\| \`${key}\` \\| \`${JSON.stringify(value)}\` \\|`, 'm'), `${key} is documented with its default`);
  }
  // The harness table is the first of its shape; `iric`'s comes later.
  const first = doc.slice(0, doc.indexOf('## Files'));
  const documented = [...first.matchAll(/^\| `(\w+)` \| `[^`]+` \| /gm)].map((m) => m[1]);
  assert.deepEqual(documented.sort(), Object.keys(DEFAULT_CONFIG).sort(), 'and nothing else is documented as one');
});
