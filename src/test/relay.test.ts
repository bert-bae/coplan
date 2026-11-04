import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `bin/coplan-hook-relay.sh` runs on every tool call in every session, and a hook
 * that errors surfaces inside the user's terminal. It had no tests; these
 * cover the contract it has to honour, especially the failure paths where
 * printing nothing and exiting 0 is the only acceptable behaviour.
 */

const RELAY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'coplan-hook-relay.sh',
);

let home: string;
let server: http.Server;
let port: number;
let received: { url: string; auth: string | undefined; body: string }[] = [];
/** Set to delay the response, to exercise the relay's timeout. */
let holdMs = 0;
let responseBody = '{"suppressOutput":true}';

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-relay-'));

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      const send = () => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(responseBody);
      };
      if (holdMs) setTimeout(send, holdMs).unref();
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  writeFileSync(
    path.join(home, 'daemon.json'),
    JSON.stringify({ pid: process.pid, port, token: 'test-token', host: '127.0.0.1' }, null, 2),
  );
  chmodSync(RELAY, 0o755);
});

after(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

interface RelayResult {
  stdout: string;
  code: number | null;
}

function relay(
  event: string,
  payload: string,
  env: Record<string, string> = {},
): Promise<RelayResult> {
  return new Promise((resolve) => {
    const child = spawn(RELAY, [event], {
      env: { ...process.env, CC_HARNESS_HOME: home, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.on('close', (code) => resolve({ stdout, code }));
    // The relay may exit without reading its input — with no event name it
    // does so by design — and a write racing that exit fails with EPIPE.
    // That is the behaviour under test, not an error in it.
    child.stdin.on('error', () => undefined);
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/* ------------------------------------------------------------------ */

test('forwards the payload with the token and echoes the response', async () => {
  received = [];
  const payload = JSON.stringify({ session_id: 's1', cwd: '/x' });
  const result = await relay('SessionEnd', payload);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"suppressOutput":true}');
  assert.equal(received.length, 1);
  assert.equal(received[0]!.url, '/hook/SessionEnd');
  assert.equal(received[0]!.auth, 'Bearer test-token');
  assert.equal(received[0]!.body, payload, 'the payload is passed through byte for byte');
});

test('extra prompt context reaches the CLI unchanged', async () => {
  responseBody = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'read the plan' } });
  const result = await relay('UserPromptSubmit', JSON.stringify({ session_id: 's1' }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, 'read the plan');
  responseBody = '{"suppressOutput":true}';
});

test('a daemon that hangs cannot hold a turn open', async () => {
  // The Stop hook used to wait minutes on purpose. Nothing waits now, and a
  // wedged daemon must cost the session seconds at most.
  holdMs = 30_000;
  const started = Date.now();
  const result = await relay('Stop', '{"session_id":"s1"}');
  holdMs = 0;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started}ms`);
});

test('says nothing when there is no daemon', async () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'cc-harness-nodaemon-'));
  const result = await relay('SessionEnd', '{"session_id":"s1"}', { CC_HARNESS_HOME: empty });
  assert.equal(result.code, 0, 'a missing daemon must never fail the hook');
  assert.equal(result.stdout, '');
  rmSync(empty, { recursive: true, force: true });
});

test('ignores a lock file left behind by a dead daemon', async () => {
  const stale = mkdtempSync(path.join(tmpdir(), 'cc-harness-stale-'));
  writeFileSync(
    path.join(stale, 'daemon.json'),
    // A pid that cannot be running: the kernel would have to have wrapped.
    JSON.stringify({ pid: 999999999, port, token: 'test-token', host: '127.0.0.1' }),
  );
  received = [];
  const result = await relay('SessionEnd', '{"session_id":"s1"}', { CC_HARNESS_HOME: stale });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(received.length, 0, 'it does not talk to a port owned by a dead pid');
  rmSync(stale, { recursive: true, force: true });
});

test('emits nothing when the response is not hook JSON', async () => {
  responseBody = '<html>gateway error</html>';
  const result = await relay('SessionEnd', '{"session_id":"s1"}');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '', 'anything that is not JSON is safer left unsaid');
  responseBody = '{"suppressOutput":true}';
});

test('exits quietly on empty stdin', async () => {
  received = [];
  const result = await relay('SessionEnd', '');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(received.length, 0);
});

test('exits quietly with no event name', async () => {
  const result = await relay('', '{"session_id":"s1"}');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
});

test('a slow daemon does not hang a short-budget hook', async () => {
  // A slow but answering daemon still gets its answer through.
  holdMs = 300;
  const started = Date.now();
  const result = await relay('SessionEnd', '{"session_id":"s1"}');
  holdMs = 0;
  assert.equal(result.code, 0);
  assert.ok(Date.now() - started < 15_000);
});

test('a malformed lock file is treated as no daemon', async () => {
  const broken = mkdtempSync(path.join(tmpdir(), 'cc-harness-broken-'));
  writeFileSync(path.join(broken, 'daemon.json'), 'not json at all');
  const result = await relay('SessionEnd', '{"session_id":"s1"}', { CC_HARNESS_HOME: broken });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  rmSync(broken, { recursive: true, force: true });
});
