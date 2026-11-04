import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLink } from '../shared/link.ts';

/** How the harness links back to a session so questions are answered there. */

test('a cloud session links to claude.ai, in the app and on the web', () => {
  const { surface, link } = resolveLink({ remoteSessionId: 'cse_01ABCdef' });
  assert.equal(surface, 'cloud');
  assert.deepEqual(link, {
    app: 'claude://claude.ai/code/session_01ABCdef',
    web: 'https://claude.ai/code/session_01ABCdef',
    via: 'cloud',
  });
});

test('the cloud id is read from the SDK url when it is not exposed directly', () => {
  const { link } = resolveLink({ remoteSdkUrl: 'https://api.anthropic.com/v1/code/sessions/cse_01W2BKFSP9onhS2' });
  assert.equal(link?.web, 'https://claude.ai/code/session_01W2BKFSP9onhS2');
});

test('a local session with Remote Control on gets a link too', () => {
  const { surface, link } = resolveLink({ bridgeSessionId: 'session_01XYZabc', entrypoint: 'claude-desktop' });
  assert.equal(surface, 'desktop');
  assert.equal(link?.app, 'claude://claude.ai/code/session_01XYZabc');
  assert.equal(link?.via, 'remote-control');
});

test('a local session without Remote Control gets no link rather than a guess', () => {
  assert.deepEqual(resolveLink({ entrypoint: 'cli' }), { surface: 'cli', link: null });
  assert.deepEqual(resolveLink({}), { surface: 'unknown', link: null });
});

test('ids that could break out of the url are refused', () => {
  assert.equal(resolveLink({ remoteSessionId: 'cse_x/../../evil' }).link, null);
  assert.equal(resolveLink({ bridgeSessionId: 'session_a"b' }).link, null);
});

/* ------------------------------------------------------------ agents */

test('Claude Code variables never give a Codex or Cursor session a Claude link', () => {
  // A Codex or Cursor session started from a terminal inside a Claude
  // session inherits Claude's variables; they describe the outer session.
  const inherited = { remoteSessionId: 'cse_01ABCdef', bridgeSessionId: 'session_01XYZabc', entrypoint: 'cli' };
  assert.equal(resolveLink(inherited, 'codex', '0199a213-81c0-7800-8aa1-bbab2a035a53').link?.app.startsWith('claude://'), false);
  assert.equal(resolveLink(inherited, 'cursor', 'c1').link, null);
});

test('a Codex thread opens in the Codex app, and has no web address', () => {
  const { link } = resolveLink({}, 'codex', '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.deepEqual(link, { app: 'codex://threads/0199a213-81c0-7800-8aa1-bbab2a035a53', web: null, via: 'app' });
  assert.equal(resolveLink({}, 'codex', '../../evil').link, null, 'an id that could leave the path gets no link');
});

test('a Cursor chat has no documented link, so it gets none', () => {
  assert.deepEqual(resolveLink({}, 'cursor', 'c1'), { surface: 'desktop', link: null });
});
