import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
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
let received: { url: string; auth: string | undefined; agent: string | undefined; deadline: string | undefined; body: string }[] = [];
/** Set to delay the response, to exercise the relay's timeout. */
let holdMs = 0;
let responseBody = '{"suppressOutput":true}';

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-relay-'));

  server = http.createServer((req, res) => {
    // Answered like the real daemon, so the relay believes the lock.
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.0.0', pid: process.pid }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const agent = req.headers['x-harness-agent'];
      const deadline = req.headers['x-harness-deadline'];
      received.push({ url: req.url ?? '', auth: req.headers.authorization, agent: typeof agent === 'string' ? agent : undefined, deadline: typeof deadline === 'string' ? deadline : undefined, body });
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
  extra: string[] = [],
): Promise<RelayResult> {
  return new Promise((resolve) => {
    const child = spawn(RELAY, [event, ...extra], {
      // This checkout, built, is the plugin: not whichever one the agent
      // running the tests was started from.
      env: { ...process.env, CC_HARNESS_HOME: home, CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(RELAY)), PLUGIN_ROOT: '', CURSOR_PLUGIN_ROOT: '', ...env },
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

test('it finds the daemon where the daemon keeps it, with or without HOME, and never blocks a prompt', async () => {
  // Node leaves out what is undefined: these run with the variable unset.
  const unset = undefined as unknown as string;
  // A home whose ~/.claude/cc-harness is this test's daemon home.
  const user = mkdtempSync(path.join(tmpdir(), 'cc-harness-user-'));
  mkdirSync(path.join(user, '.claude'));
  symlinkSync(home, path.join(user, '.claude', 'cc-harness'));
  // What Node answers for the user's home when HOME is unset, or nothing.
  const bins: string[] = [];
  const bin = (answer: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cc-harness-bin-'));
    bins.push(dir);
    writeFileSync(path.join(dir, 'node'), `#!/bin/sh\nprintf '%s' '${answer}'\n`);
    chmodSync(path.join(dir, 'node'), 0o755);
    return `${dir}:${process.env['PATH'] ?? ''}`;
  };
  const heard = async (env: Record<string, string>) => {
    received = [];
    const result = await relay('Stop', '{"session_id":"s1"}', env);
    assert.equal(result.code, 0);
    return received.length === 1;
  };
  try {
    assert.ok(await heard({ HOME: unset }), 'CC_HARNESS_HOME alone is enough');
    assert.ok(await heard({ HOME: unset, CC_HARNESS_HOME: unset, PATH: bin(user) }), "with HOME unset, Node's answer");
    assert.ok(await heard({ HOME: user, CC_HARNESS_HOME: '${env:CC_HARNESS_HOME}' }), 'one passed on unexpanded is no directory');
    // No home at all: nothing to find, and nothing blocked.
    for (const event of ['UserPromptSubmit', 'SessionStart', 'Stop']) {
      received = [];
      const result = await relay(event, '{"session_id":"s1"}', { HOME: unset, CC_HARNESS_HOME: unset, PATH: bin('') });
      assert.deepEqual([result, received.length], [{ stdout: '', code: 0 }, 0], event);
    }
  } finally {
    for (const dir of [user, ...bins]) rmSync(dir, { recursive: true, force: true });
  }
});

test('a huge PostToolUse sends only its session: the daemon needs to hear a tool finished, not what it said', async () => {
  received = [];
  const huge = JSON.stringify({ session_id: 's-1', tool_input: { session_id: 'not-this' }, tool_response: `"session_id":"nor-this" ${'x'.repeat(300_000)}` });
  const result = await relay('PostToolUse', huge);
  assert.equal(result.code, 0);
  assert.equal(received.length, 1, 'still heard: it is what clears a permission prompt off the board');
  assert.deepEqual(JSON.parse(received[0]!.body), { session_id: 's-1', hook_event_name: 'PostToolUse' });
  // Cursor running Claude Code's hooks: its chat is conversation_id, and
  // cursor_version is how the daemon tells it is Cursor's.
  // No session_id in it: finding that it is missing must not take the hook's time.
  const cursor = JSON.stringify({ conversation_id: 'c-9', cursor_version: '2.0.0', tool_output: `"conversation_id":"nor-this" ${'y'.repeat(300_000)}` });
  const started = Date.now();
  await relay('PostToolUse', cursor);
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started}ms of a 5s hook`);
  assert.equal(received.length, 2);
  assert.deepEqual(JSON.parse(received[1]!.body), { conversation_id: 'c-9', cursor_version: '2.0.0', hook_event_name: 'PostToolUse' });
  received = received.slice(0, 1);
  await relay('PostToolUse', '{"session_id":"s1","tool_name":"Read"}');
  assert.equal(received[1]!.body, '{"session_id":"s1","tool_name":"Read"}', 'an ordinary one goes as it is');
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

/* ------------------------------------------------------------ agents */

test('says which agent the hook came from, Claude Code by default', async () => {
  received = [];
  await relay('SessionEnd', '{"session_id":"s1"}');
  await relay('stop', '{"conversation_id":"c1"}', {}, ['cursor']);
  await relay('Stop', '{"session_id":"t1"}', {}, ['codex']);
  assert.deepEqual(
    received.map((r) => [r.url, r.agent]),
    [
      ['/hook/SessionEnd', 'claude'],
      ['/hook/stop', 'cursor'],
      ['/hook/Stop', 'codex'],
    ],
  );
});

test('an agent it does not know is sent as Claude Code, never passed through', async () => {
  received = [];
  await relay('SessionEnd', '{"session_id":"s1"}', {}, ['x"; rm -rf /']);
  assert.equal(received[0]?.agent, 'claude');
});

test('says when its curl gives up, so a daemon that answers later knows no one is reading', async () => {
  for (const [event, budget] of [['UserPromptSubmit', 4], ['SessionStart', 10]] as const) {
    received = [];
    const before = Math.floor(Date.now() / 1000);
    await relay(event, '{"session_id":"s1"}');
    const deadline = Number(received[0]?.deadline);
    assert.ok(deadline >= before + budget && deadline <= Math.floor(Date.now() / 1000) + budget, `${event}: ${received[0]?.deadline}`);
  }
});

test('a daemon that will not start is not waited on again by every message the user sends', async () => {
  const plugin = mkdtempSync(path.join(tmpdir(), 'cc-harness-crashing-'));
  const empty = mkdtempSync(path.join(tmpdir(), 'cc-harness-nostart-'));
  try {
    mkdirSync(path.join(plugin, 'dist', 'daemon'), { recursive: true });
    writeFileSync(path.join(plugin, 'dist', 'daemon', 'main.js'), 'process.exit(1);\n');
    const env = { CLAUDE_PLUGIN_ROOT: plugin, CC_HARNESS_HOME: empty };
    let started = Date.now();
    await relay('UserPromptSubmit', '{"session_id":"s1"}', env);
    assert.ok(Date.now() - started >= 4000, 'the first message waits for it to start');
    assert.ok(existsSync(path.join(empty, 'start-failed')));
    started = Date.now();
    const again = await relay('UserPromptSubmit', '{"session_id":"s1"}', env);
    assert.equal(again.code, 0);
    assert.ok(Date.now() - started < 2000, 'the next one does not');
  } finally {
    rmSync(plugin, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('the daemon starts where there is no setsid, as on macOS', async () => {
  const plugin = mkdtempSync(path.join(tmpdir(), 'cc-harness-nosetsid-plugin-'));
  const empty = mkdtempSync(path.join(tmpdir(), 'cc-harness-nosetsid-home-'));
  const bin = mkdtempSync(path.join(tmpdir(), 'cc-harness-nosetsid-bin-'));
  try {
    // A daemon that does what the real one does on start: listens, answers
    // /health with its pid, writes its lock, and takes the hook.
    mkdirSync(path.join(plugin, 'dist', 'daemon'), { recursive: true });
    writeFileSync(
      path.join(plugin, 'dist', 'daemon', 'main.js'),
      `const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const home = process.env.CC_HARNESS_HOME;
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, pid: process.pid }));
  fs.writeFileSync(path.join(home, 'hook-received'), req.url);
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ pid: process.pid, port: server.address().port, token: 't' }));
});
setTimeout(() => process.exit(0), 15000).unref();
`,
    );
    // Every command on PATH but setsid, the first of each name as PATH finds it.
    const linked = new Set<string>();
    for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name === 'setsid' || linked.has(name)) continue;
        linked.add(name);
        symlinkSync(path.join(dir, name), path.join(bin, name));
      }
    }
    const out = await relay('SessionStart', '{"session_id":"s1"}', { CLAUDE_PLUGIN_ROOT: plugin, CC_HARNESS_HOME: empty, PATH: bin });
    assert.equal(out.code, 0);
    assert.ok(existsSync(path.join(empty, 'daemon.json')), 'the daemon started');
    assert.equal(existsSync(path.join(empty, 'start-failed')), false, 'without waiting out the start timeout');
    assert.equal(readFileSync(path.join(empty, 'hook-received'), 'utf8'), '/hook/SessionStart', 'and got the hook');
    // Detached: a process group of its own, so the agent ending the hook's group leaves it running.
    const { pid } = JSON.parse(readFileSync(path.join(empty, 'daemon.json'), 'utf8')) as { pid: number };
    assert.equal(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim(), String(pid));
  } finally {
    try {
      const { pid } = JSON.parse(readFileSync(path.join(empty, 'daemon.json'), 'utf8')) as { pid: number };
      process.kill(pid);
    } catch {
      /* it never started */
    }
    for (const dir of [plugin, empty, bin]) rmSync(dir, { recursive: true, force: true });
  }
});

test('an unbuilt plugin says so at the start of a session, in each agent’s format, and nothing else', async () => {
  const unbuilt = mkdtempSync(path.join(tmpdir(), 'cc-harness-unbuilt-'));
  try {
    received = [];
    const env = { CLAUDE_PLUGIN_ROOT: unbuilt };
    const claude = JSON.parse((await relay('SessionStart', '{"session_id":"s1"}', env)).stdout);
    assert.match(claude.systemMessage, /not built - run \/coplan-setup/);
    assert.equal(claude.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(claude.hookSpecificOutput.additionalContext.includes(unbuilt), 'names where to build it');
    const codex = JSON.parse((await relay('SessionStart', '{"session_id":"t1"}', env, ['codex'])).stdout);
    assert.match(codex.hookSpecificOutput.additionalContext, /not built/);
    assert.equal(codex.systemMessage, undefined);
    const cursor = JSON.parse((await relay('sessionStart', '{"conversation_id":"c1"}', env, ['cursor'])).stdout);
    assert.match(cursor.additional_context, /not built/);
    const later = await relay('UserPromptSubmit', '{"session_id":"s1"}', env);
    assert.equal(later.stdout, '', 'once, not on every prompt');
    assert.equal(later.code, 0);
    assert.equal(received.length, 0, 'nothing reaches a daemon');
  } finally {
    rmSync(unbuilt, { recursive: true, force: true });
  }
});
