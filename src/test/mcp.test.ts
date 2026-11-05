import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../mcp/tools.ts';

/**
 * The MCP server's own contract, against a stub daemon: tools are listed,
 * calls are forwarded to the right endpoint, and the daemon's prose comes back
 * verbatim. None of the tools waits on the user.
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
    // Answered like the real daemon, so the lock below is believed.
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.0.0', pid: process.pid }));
      return;
    }
    received.push(req.url ?? '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = () => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: !req.url?.includes('refuse'), text: '[cc-harness] done' }));
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
  const result = await callTool('harness_plan_read');
  assert.equal(result.isError, false);
  assert.equal(result.content[0]?.text, '[cc-harness] done');
  assert.deepEqual(received, ['/mcp/read']);
});

test('each tool forwards to its own endpoint', async () => {
  for (const [name, endpoint] of [
    ['harness_plan_publish', '/mcp/publish'],
    ['harness_plan_edit', '/mcp/edit'],
    ['harness_task_update', '/mcp/task'],
    ['harness_tasks_publish', '/mcp/tasks'],
    ['harness_task_next', '/mcp/next'],
    ['harness_task_brief', '/mcp/brief'],
  ] as const) {
    received = [];
    await callTool(name, {});
    assert.deepEqual(received, [endpoint], name);
  }
});

test('the toolset is the planning loop and nothing else', () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name).sort(),
    ['harness_branch_update', 'harness_plan_check', 'harness_plan_edit', 'harness_plan_publish', 'harness_plan_read', 'harness_task_brief', 'harness_task_next', 'harness_task_update', 'harness_tasks_publish'],
  );
  for (const tool of TOOLS) {
    assert.doesNotMatch(tool.description, /end your turn and wait|gate|harness_await/i, `${tool.name} must not ask Claude to wait`);
  }
});

test('the publish schema describes diagrams as nodes and edges', () => {
  const publish = TOOLS.find((t) => t.name === 'harness_plan_publish')!;
  const diagrams = (publish.inputSchema['properties'] as Record<string, { items: { properties: Record<string, unknown> } }>)['diagrams']!;
  assert.ok(diagrams.items.properties['nodes']);
  assert.ok(diagrams.items.properties['edges']);
});

test('an unknown tool is an error, not a silent no-op', async () => {
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, CC_HARNESS_HOME: home },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const reply = await new Promise<string>((resolve) => {
    child.stdout!.on('data', (c: Buffer) => resolve(c.toString()));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'harness_await' } })}\n`);
  });
  child.kill();
  assert.match(reply, /Unknown tool/);
});
