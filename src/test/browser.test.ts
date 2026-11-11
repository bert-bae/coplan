import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isWsl, openInBrowser, openable } from '../daemon/browser.ts';

/**
 * What the daemon may hand to the system's opener. "Answer in Claude" opens
 * the desktop app's own link to the session, so those schemes must pass —
 * and nothing that could be read as more than one argument may.
 */

test("the page and the agents' own session links can be opened", () => {
  for (const url of [
    'http://127.0.0.1:4321/?token=abc#/session/s1',
    'https://claude.ai/code/session_01',
    'claude://claude.ai/code/session_01Bridge',
    'codex://threads/019a-thread',
    'cursor://anysphere.cursor-agent/chat/1',
  ]) {
    assert.ok(openable(url), url);
  }
});

test('anything else, or anything a command line could split, is not', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'claude://x y', 'https://a.b/"&calc', "codex://x'y", 'ftp://host/']) {
    assert.ok(!openable(url), url);
  }
});

// Only where xdg-open is the opener: elsewhere this would open a real window.
test('on Linux the link goes to xdg-open', { skip: process.platform !== 'linux' || isWsl() }, async () => {
  const bin = mkdtempSync(path.join(tmpdir(), 'coplan-opener-'));
  const said = path.join(bin, 'said');
  writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s' "$*" > "${said}"\n`);
  chmodSync(path.join(bin, 'xdg-open'), 0o755);
  const before = process.env['PATH'];
  process.env['PATH'] = `${bin}:${before ?? ''}`;
  try {
    openInBrowser('http://127.0.0.1:4321/#/session/s1');
    for (let i = 0; i < 50 && !(existsSync(said) && readFileSync(said, 'utf8')); i++) await sleep(100);
    assert.equal(readFileSync(said, 'utf8'), 'http://127.0.0.1:4321/#/session/s1');
  } finally {
    if (before === undefined) delete process.env['PATH'];
    else process.env['PATH'] = before;
    rmSync(bin, { recursive: true, force: true });
  }
});
