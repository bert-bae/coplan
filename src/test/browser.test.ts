import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openable } from '../daemon/browser.ts';

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
