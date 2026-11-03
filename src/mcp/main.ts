/**
 * The harness MCP server.
 *
 * It is deliberately thin: every tool forwards to the daemon over loopback
 * HTTP and returns the daemon's prose verbatim. Keeping the logic in the
 * daemon means the model's context only ever carries short status strings,
 * and it means one shared state machine across every concurrent session.
 */
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl, ensureHome } from '../shared/paths.ts';
import { TOOLS, DEFAULT_BUDGET_MS } from './tools.ts';
import type { DaemonLock } from '../shared/types.ts';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0';

const PROTOCOL_VERSION = '2024-11-05';
const DAEMON_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'main.js');

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const SESSION_ID = process.env['CLAUDE_CODE_SESSION_ID'] ?? '';
const CLAUDE_PID = Number(process.env['CLAUDE_PID'] ?? process.ppid);

/* ------------------------------------------------------------------ *
 * Daemon connection
 * ------------------------------------------------------------------ */

let cachedLock: DaemonLock | null = null;

async function daemon(): Promise<DaemonLock | null> {
  if (cachedLock && readLiveLock()?.pid === cachedLock.pid) return cachedLock;
  cachedLock = readLiveLock();
  if (cachedLock) return cachedLock;
  cachedLock = await startDaemon();
  return cachedLock;
}

/** Start the daemon detached, so it outlives the session that spawned it. */
async function startDaemon(): Promise<DaemonLock | null> {
  ensureHome();
  try {
    const child = spawn(process.execPath, [DAEMON_ENTRY], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    // `spawn` reports ENOENT asynchronously, on the child's `error` event. With
    // no listener that is an unhandled `'error'`, which would take this process
    // down mid-session — so attach one even though the failure is recoverable.
    child.on('error', () => {
      /* the lock-file poll below reports the failure */
    });
    child.unref();
  } catch {
    return null;
  }
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const lock = readLiveLock();
    if (lock) return lock;
  }
  return null;
}

interface CallResult {
  ok: boolean;
  text: string;
}

async function callDaemon(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  onTimeout: string,
): Promise<CallResult> {
  const lock = await daemon();
  if (!lock) {
    return {
      ok: false,
      text:
        '[cc-harness] Could not reach or start the harness daemon. ' +
        'Run `harness status` in a terminal to diagnose; the session can continue without the UI.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(lock)}/mcp/${tool}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${lock.token}`,
        'x-harness-session': SESSION_ID,
      },
      body: JSON.stringify({ ...args, sessionId: SESSION_ID || undefined, cwd: process.cwd(), pid: CLAUDE_PID }),
      signal: controller.signal,
    });
    const body = (await res.json()) as { text?: string; ok?: boolean };
    return { ok: body.ok !== false, text: body.text ?? JSON.stringify(body) };
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    return {
      ok: false,
      text: aborted ? onTimeout : `[cc-harness] Daemon call failed: ${(err as Error)?.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * JSON-RPC plumbing
 * ------------------------------------------------------------------ */

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number | string | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id: number | string | null | undefined, code: number, message: string): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case 'initialize':
      respond(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cc-harness', version: VERSION },
      });
      return;

    case 'notifications/initialized':
    case 'initialized':
      return;

    case 'ping':
      respond(req.id, {});
      return;

    case 'tools/list':
      respond(req.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;

    case 'tools/call': {
      const params = req.params ?? {};
      const name = String(params['name'] ?? '');
      const args = (params['arguments'] ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        respondError(req.id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const result = await callDaemon(
        tool.endpoint,
        args,
        DEFAULT_BUDGET_MS,
        '[cc-harness] The daemon did not respond in time. Call the tool again.',
      );
      respond(req.id, {
        content: [{ type: 'text', text: result.text }],
        isError: !result.ok,
      });
      return;
    }

    default:
      // Unknown methods are ignored for notifications and rejected for calls.
      if (req.id !== undefined && req.id !== null) {
        respondError(req.id, -32601, `Method not found: ${req.method}`);
      }
  }
}

/** In-flight requests are tracked so that stdin closing mid-call does not
 *  drop a write before its answer has been sent back. */
let inFlight = 0;
let stdinClosed = false;

function maybeExit(): void {
  if (stdinClosed && inFlight === 0) process.exit(0);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    return;
  }
  inFlight++;
  void handleRequest(req)
    .catch((err: unknown) => {
      respondError(req.id, -32603, `Internal error: ${(err as Error)?.message}`);
    })
    .finally(() => {
      inFlight--;
      maybeExit();
    });
});

rl.on('close', () => {
  stdinClosed = true;
  maybeExit();
  // Never linger indefinitely if a daemon call is wedged.
  setTimeout(() => process.exit(0), 30_000).unref();
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
