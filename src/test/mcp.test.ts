import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, DEFAULT_BUDGET_MS, budgetFor, timeoutText } from '../mcp/tools.ts';
import { CHECK_RUN_BUDGET_MS } from '../shared/config.ts';

/**
 * The MCP server's own contract, against a stub daemon.
 *
 * Everything else in the suite talks to the daemon over HTTP directly, which
 * is exactly the layer that hid this: the transport budget lives here, in the
 * process Claude actually talks to, and nothing exercised it. A flat 30s
 * budget on `harness_publish_checks` — which runs the project's whole check
 * suite before it answers — aborted on any suite slower than that, told
 * Claude to call the tool again, and the retry re-ran the checks and cancelled
 * the gate the user was mid-review of, so their click came back "gate is not
 * open" and nothing moved.
 */

const MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'main.js');

let home: string;
let server: http.Server;
let port: number;
/** How long the stub daemon sits on a request before answering. */
let holdMs = 0;
let received: string[] = [];

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-mcp-'));

  server = http.createServer((req, res) => {
    received.push(req.url ?? '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = () => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, gateId: 'gate-1', text: '[cc-harness] done' }));
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
    JSON.stringify({ pid: process.pid, port, token: 'test-token', host: '127.0.0.1' }),
  );
});

after(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  holdMs = 0;
  received = [];
});

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/**
 * Drive one `tools/call` through a real MCP server process, the way the CLI
 * does — over stdio, as JSON-RPC.
 */
function callTool(name: string, args: Record<string, unknown> = {}, waitMs = 10_000): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [MCP], {
      env: { ...process.env, CC_HARNESS_HOME: home, CLAUDE_CODE_SESSION_ID: 'mcp-test' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no response within ${waitMs}ms`));
    }, waitMs);

    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: ToolResult };
        try {
          message = JSON.parse(line) as { id?: number; result?: ToolResult };
        } catch {
          continue;
        }
        if (message.id === 2 && message.result) {
          clearTimeout(timer);
          child.kill();
          resolve(message.result);
        }
      }
    });
    child.on('error', reject);

    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
    child.stdin!.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })}\n`,
    );
  });
}

/* ------------------------------------------------------------------ */

test('a tool call reaches the daemon and returns its prose verbatim', async () => {
  const result = await callTool('harness_status');
  assert.equal(result.isError, false);
  assert.equal(result.content[0]?.text, '[cc-harness] done');
  assert.deepEqual(received, ['/mcp/status']);
});

test('the budget a call gets comes from its own work, not from a flat number', () => {
  // The line that carried the bug. It was a flat 30s for everything except
  // `harness_await`, so a check suite slower than that always aborted — and
  // the retry Claude was told to make cancelled the gate the user was
  // already reading. Asserting on the decision, not on the constants: this
  // fails the moment the flat budget comes back.
  const checks = TOOLS.find((t) => t.name === 'harness_publish_checks')!;
  const diff = TOOLS.find((t) => t.name === 'harness_publish_diff')!;
  const status = TOOLS.find((t) => t.name === 'harness_status')!;

  assert.ok(
    budgetFor(checks) > DEFAULT_BUDGET_MS,
    'a call that runs the project checks cannot be held to what a status read costs',
  );
  assert.ok(
    budgetFor(checks) >= CHECK_RUN_BUDGET_MS,
    'and it has to outlast the ceiling the daemon itself enforces on the run',
  );
  assert.ok(budgetFor(diff) > DEFAULT_BUDGET_MS, 'git diff alone is allowed 30s server-side');

  // A call that only reads harness state is correctly left on the default.
  assert.equal(budgetFor(status), DEFAULT_BUDGET_MS);
});

test('a parked await still gets headroom over its own timeout', () => {
  // Otherwise the transport gives up first and the daemon's answer — which
  // has already marked the gate delivered — is thrown away.
  const await_ = TOOLS.find((t) => t.name === 'harness_await')!;
  assert.ok(budgetFor(await_, 300) > 300_000);
  assert.ok(budgetFor(await_, 'nonsense') > 0, 'a junk timeout falls back rather than producing NaN');
});

test('a slow daemon answer still reaches Claude rather than being abandoned', async () => {
  // Drives the real MCP process against a daemon that takes longer than the
  // old flat budget allowed. Held just past it, so the test proves the
  // boundary moved rather than sitting comfortably inside the old one.
  holdMs = DEFAULT_BUDGET_MS + 1_500;
  const result = await callTool('harness_publish_checks', {}, DEFAULT_BUDGET_MS + 20_000);
  assert.equal(result.isError, false, 'the daemon answered rather than the transport giving up');
  assert.equal(result.content[0]?.text, '[cc-harness] done');
});

test('a timed-out gate tool tells Claude to stop, not to run it all again', () => {
  // Retrying is what actually broke the user's click: a second run reseeds
  // the checks and opens a new gate, which cancels the one they were reading,
  // so resolving it comes back 409 "gate is not open".
  const text = timeoutText(TOOLS.find((t) => t.name === 'harness_publish_checks')!);

  assert.match(text, /still working on it/i, 'the work is not lost, and Claude is told so');
  assert.match(text, /do NOT call it again/i);
  assert.match(text, /End your turn/i);
  assert.doesNotMatch(
    text,
    /call the tool again/i,
    'the instruction that sent Claude back into the same wall',
  );
});

test('a tool with no work of its own is still told to retry on a timeout', () => {
  // For a read of harness state, retrying really is the right advice: there
  // is no half-finished run behind it to protect, and no gate to cancel.
  const text = timeoutText(TOOLS.find((t) => t.name === 'harness_status')!);
  assert.match(text, /Call the tool again/i);
});
