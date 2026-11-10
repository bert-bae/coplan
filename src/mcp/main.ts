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
import { readLiveLock, readVerifiedLock, probeLock, baseUrl, ensureHome } from '../shared/paths.ts';
import { TOOLS, DEFAULT_BUDGET_MS } from './tools.ts';
import { agentInfo, parseAgent, sessionFromEnv, workspaceFromEnv } from '../shared/agents.ts';
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

/**
 * Which agent started this server, and which of its sessions is calling.
 *
 * Each agent's MCP config sets `COPLAN_AGENT`. Claude Code names the session
 * in the environment; Codex names it on each call (see `sessionFromCall`).
 * Otherwise the daemon matches this server's parent process, then its
 * workspace, against the sessions the hooks registered. Cursor starts one
 * server per window rather than per chat, so it says which folder is open in
 * `COPLAN_WORKSPACE` and the daemon picks the chat there that was active last.
 */
const AGENT = parseAgent(process.env['COPLAN_AGENT']);
const SESSION_ID = sessionFromEnv(process.env, AGENT) ?? '';
const CLAUDE_PID = Number(process.env['CLAUDE_PID'] ?? process.ppid);
const WORKSPACE_ENV = workspaceFromEnv(process.env);
let workspace = WORKSPACE_ENV ?? process.cwd();

/* ------------------------------------------------------------------ *
 * The workspace, from the client
 * ------------------------------------------------------------------ */

/**
 * An agent whose MCP config cannot say which folder is open — Cursor, when
 * `${workspaceFolder}` is left unexpanded — may still offer MCP roots. Ask
 * for them once the session is up, and before the first tool call wait a
 * moment for the answer. Claude Code names its session, so it never asks.
 */
let rootsWanted = false;
let rootsAsked = 0;
let rootsSettled: Promise<void> = Promise.resolve();
let settleRoots: (() => void) | null = null;
const pendingRoots = new Set<string>();

function askForRoots(): void {
  const id = `coplan-roots-${++rootsAsked}`;
  pendingRoots.add(id);
  rootsSettled = new Promise<void>((resolve) => {
    settleRoots = resolve;
    setTimeout(resolve, ROOTS_WAIT_MS).unref();
  });
  send({ jsonrpc: '2.0', id, method: 'roots/list' });
}

/** The answer to `roots/list`: the first local folder is the workspace. */
function onRoots(result: unknown): void {
  const roots = (result as { roots?: unknown })?.roots;
  if (Array.isArray(roots)) {
    for (const root of roots) {
      const uri = (root as { uri?: unknown })?.uri;
      if (typeof uri !== 'string' || !uri.startsWith('file://')) continue;
      try {
        workspace = fileURLToPath(uri);
        break;
      } catch {
        /* not a local path; try the next */
      }
    }
  }
  settleRoots?.();
}

const ROOTS_WAIT_MS = 1_500;

/* ------------------------------------------------------------------ *
 * Daemon connection
 * ------------------------------------------------------------------ */

let cachedLock: DaemonLock | null = null;

async function daemon(): Promise<DaemonLock | null> {
  if (cachedLock && readLiveLock()?.pid === cachedLock.pid) return cachedLock;
  // A lock is trusted once its daemon has answered: one left by a daemon
  // that died may name a pid some other process has now.
  cachedLock = await readVerifiedLock();
  if (cachedLock) return cachedLock;
  cachedLock = await startDaemon();
  return cachedLock;
}

/** What the daemon answers a tool call: prose for the agent, or an error. */
interface DaemonReply {
  text?: string;
  ok?: boolean;
  error?: string;
}

/** Said once per server: the daemon runs another version of Coplan than
 *  this plugin — another install's, or one from before an update. */
let versionNoted = false;
function versionNotice(lock: DaemonLock): string {
  if (versionNoted || !lock.version || lock.version === VERSION) return '';
  versionNoted = true;
  return (
    `\n\n[cc-harness] Coplan's daemon is v${lock.version} but this plugin is v${VERSION}, so some tools may not work as ` +
    'described. Tell the user to run /coplan-restart (or `coplan restart`) to bring the daemon up to date.'
  );
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
    // Not the stale lock the new daemon is about to replace: one that answers.
    const lock = readLiveLock();
    if (lock && (await probeLock(lock, 500)) === 'live') return lock;
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
  sessionId: string = SESSION_ID,
): Promise<CallResult> {
  const lock = await daemon();
  if (!lock) {
    return {
      ok: false,
      text:
        '[cc-harness] Could not reach or start the Coplan daemon. ' +
        'Run `coplan status` in a terminal to diagnose; the session can continue without the UI.',
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
        'x-harness-session': sessionId,
        'x-harness-agent': AGENT,
      },
      // Codex starts this server in the plugin's own folder, which says
      // nothing about the session; its thread id says everything.
      body: JSON.stringify({
        ...args,
        sessionId: sessionId || undefined,
        cwd: AGENT === 'codex' && !WORKSPACE_ENV ? undefined : workspace,
        pid: CLAUDE_PID,
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    let body: DaemonReply | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') body = parsed as DaemonReply;
    } catch {
      /* refusals (401, 403) come back as plain text */
    }
    // A failed call is never a success, whatever its body says. Most answer
    // `{ error }` (a handler that threw, a body too large); a tool the daemon
    // does not know answers prose for the agent, passed on as it is.
    if (!body || !res.ok) {
      const said =
        typeof body?.text === 'string'
          ? body.text
          : `[cc-harness] The daemon answered ${res.status}: ${typeof body?.error === 'string' ? body.error : raw.trim().slice(0, 200)}`;
      // One that failed partway may have saved what came before the failure.
      const check = res.status >= 500 ? ' It may have saved part of this call before failing: read the plan (harness_plan_read) before trying it again.' : '';
      return { ok: false, text: said + check + versionNotice(lock) };
    }
    return { ok: body.ok !== false, text: (body.text ?? JSON.stringify(body)) + versionNotice(lock) };
  } catch (err) {
    // The daemon went away under us: find (or start) it afresh next call.
    cachedLock = null;
    const aborted = (err as Error)?.name === 'AbortError';
    return {
      ok: false,
      text: aborted ? onTimeout : `[cc-harness] Daemon call failed: ${(err as Error)?.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The session a tool call comes from, when the call says. Codex puts it in
 * every `tools/call`'s `_meta` (`threadId`), and nowhere else: its MCP
 * servers get a filtered environment, and with connection sharing one server
 * can serve several threads.
 */
function sessionFromCall(params: Record<string, unknown>): string | null {
  if (AGENT !== 'codex') return null;
  const meta = params['_meta'];
  if (!meta || typeof meta !== 'object') return null;
  const record = meta as Record<string, unknown>;
  for (const key of ['threadId', 'sessionId']) {
    const value = record[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(value)) return value;
  }
  return null;
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
    case 'initialize': {
      const capabilities = (req.params?.['capabilities'] ?? {}) as Record<string, unknown>;
      rootsWanted = AGENT !== 'claude' && !WORKSPACE_ENV && Boolean(capabilities['roots']);
      respond(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'coplan', version: VERSION },
      });
      return;
    }

    case 'notifications/initialized':
    case 'initialized':
    case 'notifications/roots/list_changed':
      if (rootsWanted) askForRoots();
      return;

    case 'ping':
      respond(req.id, {});
      return;

    case 'tools/list':
      respond(req.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          // The descriptions name Claude Code's question tool; each agent is
          // told to ask with its own.
          description: t.description.replaceAll('AskUserQuestion', agentInfo(AGENT).askWith),
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
      await rootsSettled;
      const result = await callDaemon(
        tool.endpoint,
        args,
        DEFAULT_BUDGET_MS,
        '[cc-harness] The daemon did not respond in time. Call the tool again.',
        sessionFromCall(params) ?? SESSION_ID,
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
  // The client answering a request of ours (`roots/list`), not asking one.
  if (typeof req.method !== 'string') {
    const id = String(req.id ?? '');
    if (pendingRoots.delete(id)) onRoots((req as unknown as { result?: unknown }).result);
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
