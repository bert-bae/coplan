import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, writeSync, closeSync, unlinkSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionStore } from './store.ts';
import { Router, json, text, readJson, serveStatic, type Ctx } from './http.ts';
import { ingestHook } from './hookIngest.ts';
import { PlanError } from '../shared/plan.ts';
import { renderPlan } from './render.ts';
import { cleanStorage, scanStorage } from './housekeeping.ts';
import { loadConfig, type HarnessConfig } from '../shared/config.ts';
import { ensureHome, paths, readLiveLock, isPidAlive, baseUrl } from '../shared/paths.ts';
import { HOOK_NOOP, type HookOutput } from '../shared/hooks.ts';
import { openInBrowser } from './browser.ts';
import type { CleanupGroupId, DaemonLock, PlanInput, PlanOp, ServerEvent, SessionState, TaskStatus } from '../shared/types.ts';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

/** Session names the user types. */
const MAX_TITLE_LENGTH = 120;
/** Edits in one request. Generous; a real reorganization is a few dozen. */
const MAX_OPS = 200;

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  ensureHome();

  const existing = readLiveLock();
  if (existing && !process.argv.includes('--force')) {
    // Another daemon owns the lock; report it and exit, so "start" is
    // idempotent from hooks, the CLI and the MCP server.
    process.stdout.write(`${JSON.stringify({ alreadyRunning: true, ...existing })}\n`);
    process.exit(0);
  }

  const config = loadConfig({ configDir: paths.configDir() });
  const store = new SessionStore();

  // A restart hands its successor the token and the port, so the browser tab
  // that asked for it reconnects by itself. Out of the environment at once.
  const inheritedToken = process.env['CC_HARNESS_TOKEN'];
  const inheritedPort = Number(process.env['CC_HARNESS_PORT'] ?? 0);
  delete process.env['CC_HARNESS_TOKEN'];
  const token = inheritedToken || randomBytes(24).toString('hex');

  const clients = { count: 0 };
  const server = http.createServer();
  const lifecycle = { restart: (): boolean => false };
  const router = buildRouter({ store, config, token, clients, lifecycle });

  server.on('request', (req, res) => {
    void handle(req, res, router, token).catch((err: unknown) => {
      log(`request error: ${(err as Error)?.message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  // SSE streams stay open indefinitely by design.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  const port = await listen(server, inheritedPort);
  const lock: DaemonLock = { pid: process.pid, port, token, version: VERSION, startedAt: Date.now(), host: '127.0.0.1' };
  writeLock(lock);
  log(`listening on ${baseUrl(lock)} (pid ${process.pid}, v${VERSION})`);
  process.stdout.write(`${JSON.stringify({ started: true, ...lock })}\n`);

  let shuttingDown = false;
  const shutdown = (signal: string, respawn = false) => {
    if (shuttingDown) {
      log(`second signal (${signal}); exiting now`);
      process.exit(0);
    }
    shuttingDown = true;
    log(`shutting down (${signal})`);
    reaper.stop();
    store.persistAll();
    server.close();
    server.closeAllConnections?.();
    try {
      if (readLiveLock()?.pid === process.pid) unlinkSync(paths.lockFile());
    } catch {
      /* ignore */
    }
    if (respawn) respawnDaemon(lock);
    // Let the last responses flush.
    setTimeout(() => process.exit(0), 150).unref();
  };

  /** Replace this daemon with one running the build on disk now. */
  lifecycle.restart = () => {
    if (shuttingDown) return false;
    log('restart requested; handing over to a fresh daemon');
    setTimeout(() => shutdown('restart', true), RESTART_DELAY_MS).unref();
    return true;
  };

  const reaper = startReaper(store);
  startIdleWatch(store, config, clients, () => shutdown('idle'));

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled: ${String(err)}`));
}

/** Grace for the restart response to flush before the socket is torn down. */
const RESTART_DELAY_MS = 120;
/** How long a successor keeps trying to claim its predecessor's port. */
const PORT_CLAIM_MS = 5_000;
/** Sessions remembered as "already opened a browser tab for". */
const MAX_TRACKED_OPENS = 200;
/** Per-project resolved configs held in memory. */
const MAX_CACHED_CONFIGS = 50;

/**
 * Bind, retrying a requested port while its previous owner lets go — keeping
 * the address is what lets an open tab reconnect after a restart — and falling
 * back to an ephemeral port rather than staying down.
 */
async function listen(server: http.Server, port: number): Promise<number> {
  const deadline = Date.now() + PORT_CLAIM_MS;
  for (;;) {
    try {
      return await bind(server, port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || port === 0) throw err;
      if (Date.now() >= deadline) {
        log(`port ${port} still busy; taking an ephemeral one`);
        return bind(server, 0);
      }
      await sleep(150);
    }
  }
}

function bind(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** Start the replacement daemon, detached, from the bundle on disk. */
function respawnDaemon(lock: DaemonLock): void {
  const entry = process.argv[1];
  if (!entry) return;
  try {
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CC_HARNESS_PORT: String(lock.port), CC_HARNESS_TOKEN: lock.token },
    });
    child.on('error', () => {
      /* this process is already exiting */
    });
    child.unref();
  } catch {
    /* the next hook starts one */
  }
}

/** Atomic claim, with recovery from a lock left behind by a dead daemon. */
function writeLock(lock: DaemonLock): void {
  const file = paths.lockFile();
  const payload = JSON.stringify(lock, null, 2);
  try {
    const fd = openSync(file, 'wx', 0o600);
    writeSync(fd, payload);
    closeSync(fd);
    return;
  } catch {
    const stale = readLiveLock();
    if (stale && stale.pid !== lock.pid && isPidAlive(stale.pid)) {
      log(`another daemon (pid ${stale.pid}) holds the lock; exiting`);
      process.exit(0);
    }
    const fd = openSync(file, 'w', 0o600);
    writeSync(fd, payload);
    closeSync(fd);
  }
}

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendFileSync(paths.logFile(), line);
  } catch {
    /* ignore */
  }
  if (process.env['CC_HARNESS_DEBUG']) process.stderr.write(line);
}

/* ------------------------------------------------------------------ *
 * Request pipeline
 * ------------------------------------------------------------------ */

async function handle(req: http.IncomingMessage, res: http.ServerResponse, router: Router, token: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  // Loopback only; a foreign Host header is what DNS rebinding looks like.
  const host = (req.headers.host ?? '').split(':')[0];
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    text(res, 403, 'forbidden');
    return;
  }

  if (url.pathname === '/health') {
    json(res, 200, { ok: true, version: VERSION, pid: process.pid });
    return;
  }

  if (!authorized(req, url, token)) {
    text(res, 401, 'unauthorized');
    return;
  }

  const match = router.match(req.method ?? 'GET', url.pathname);
  if (!match) {
    if (req.method === 'GET' && serveStatic(res, UI_DIR, url.pathname === '/' ? 'index.html' : url.pathname)) return;
    text(res, 404, 'not found');
    return;
  }
  await match.handler({ req, res, url, params: match.params });
}

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  if (req.headers.authorization === `Bearer ${token}`) return true;
  if (url.searchParams.get('token') === token) return true;
  return (req.headers.cookie ?? '').split(';').some((c) => c.trim() === `cc_harness=${token}`);
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

interface Deps {
  store: SessionStore;
  config: HarnessConfig;
  token: string;
  /** Live SSE connections, so an open browser counts as "in use". */
  clients: { count: number };
  lifecycle: { restart(): boolean };
}

function buildRouter(deps: Deps): Router {
  const { store, config, token, clients, lifecycle } = deps;
  const router = new Router();

  /** For the browser and the CLI: carries the token, which the daemon swaps
   *  for a cookie on first load. */
  const authedUrl = (sessionId?: string) => {
    const base = `http://127.0.0.1:${readLiveLock()?.port ?? 0}/?token=${token}`;
    return sessionId ? `${base}#/session/${sessionId}` : base;
  };

  /** For Claude. Token-free: anything returned to the model is written to the
   *  transcript and carried in every later context window. */
  const uiUrl = (sessionId: string) => `http://127.0.0.1:${readLiveLock()?.port ?? 0}/#/session/${sessionId}`;

  const opened = new Set<string>();
  const revealUi = (session: SessionState) => {
    if (!configFor(session).autoOpen || opened.has(session.sessionId)) return;
    opened.add(session.sessionId);
    if (opened.size > MAX_TRACKED_OPENS) opened.delete(opened.values().next().value!);
    openInBrowser(authedUrl(session.sessionId));
  };

  const configCache = new Map<string, HarnessConfig>();
  const configFor = (session: SessionState): HarnessConfig => {
    const key = session.repoRoot ?? session.cwd;
    let resolved = configCache.get(key);
    if (!resolved) {
      resolved = loadConfig({ configDir: paths.configDir(), projectDir: key });
      if (configCache.size > MAX_CACHED_CONFIGS) configCache.clear();
      configCache.set(key, resolved);
    }
    return resolved;
  };

  const residentIds = (): string[] => store.all().map((s) => s.sessionId);

  const sessionOr404 = (ctx: Ctx): SessionState | null => {
    const session = store.get(ctx.params['id'] ?? '');
    if (!session) json(ctx.res, 404, { error: 'unknown session' });
    return session ?? null;
  };

  /* --------------------------- UI bootstrap ------------------------ */

  router.get('/', (ctx) => {
    if (ctx.url.searchParams.get('token') === token) {
      ctx.res.setHeader('set-cookie', `cc_harness=${token}; Path=/; SameSite=Strict; HttpOnly`);
    }
    if (!serveStatic(ctx.res, UI_DIR, 'index.html')) text(ctx.res, 500, 'UI bundle missing — run npm run build');
  });

  /* --------------------------- Sessions ---------------------------- */

  router.get('/api/sessions', (ctx) => json(ctx.res, 200, { sessions: store.summaries(), version: VERSION }));

  router.get('/api/session/:id', (ctx) => {
    const session = sessionOr404(ctx);
    if (session) json(ctx.res, 200, { session });
  });

  router.delete('/api/session/:id', (ctx) => {
    const id = ctx.params['id'] ?? '';
    if (!store.get(id)) {
      json(ctx.res, 404, { error: 'unknown session' });
      return;
    }
    json(ctx.res, 200, { deleted: store.purge(id) });
  });

  router.post('/api/session/:id/title', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ title?: string }>(ctx.req);
    const title = (body.title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) {
      json(ctx.res, 400, { error: 'title required' });
      return;
    }
    store.update(session.sessionId, { title, titleLocked: true });
    json(ctx.res, 200, { title });
  });

  /**
   * The one write path the browser has. Every edit the user makes — typing in
   * a section, dragging a task, answering a question, leaving a comment — is
   * a batch of ops here, recorded in the change log as theirs. Nothing is sent
   * to Claude: it reads the log when the user tells it to in chat.
   */
  router.post('/api/session/:id/plan/ops', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ ops?: PlanOp[] }>(ctx.req);
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, MAX_OPS) : [];
    try {
      const { plan, changes } = store.applyOps(session.sessionId, ops, 'user');
      json(ctx.res, 200, { plan, changes });
    } catch (err) {
      if (err instanceof PlanError) json(ctx.res, 400, { error: err.message });
      else throw err;
    }
  });

  /** What Claude would see, for the "copy for Claude" affordance and for
   *  debugging. Reading it here does not move Claude's read position. */
  router.get('/api/session/:id/plan/text', (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    if (!session.plan) {
      json(ctx.res, 404, { error: 'no plan yet' });
      return;
    }
    text(ctx.res, 200, renderPlan(session.plan, { url: uiUrl(session.sessionId) }));
  });

  /* --------------------------- Maintenance ------------------------- */

  router.get('/api/storage', (ctx) => {
    json(ctx.res, 200, { report: scanStorage({ liveSessionIds: residentIds() }) });
  });

  router.post('/api/storage/clean', async (ctx) => {
    const body = await readJson<{ groups?: CleanupGroupId[]; dryRun?: boolean }>(ctx.req);
    const result = cleanStorage({
      liveSessionIds: residentIds(),
      ...(body.groups ? { groups: body.groups } : {}),
      ...(body.dryRun ? { dryRun: true } : {}),
    });
    if (!result.dryRun && result.removed) log(`housekeeping removed ${result.removed} item(s), ${result.freedBytes} bytes`);
    json(ctx.res, 200, { result, report: scanStorage({ liveSessionIds: residentIds() }) });
  });

  router.post('/api/daemon/restart', (ctx) => {
    const started = lifecycle.restart();
    json(ctx.res, started ? 200 : 409, {
      restarting: started,
      port: readLiveLock()?.port ?? null,
      ...(started ? {} : { error: 'already shutting down' }),
    });
  });

  /* --------------------------- SSE --------------------------------- */

  router.get('/api/events', (ctx) => {
    const { res } = ctx;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.count++;

    const send = (event: ServerEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'sessions', sessions: store.summaries() });
    const focus = ctx.url.searchParams.get('session');
    const focused = focus ? store.get(focus) : undefined;
    if (focused) send({ type: 'snapshot', session: focused });

    const listener = (event: ServerEvent) => {
      try {
        send(event);
      } catch {
        /* cleanup below fires */
      }
    };
    store.on('event', listener);
    const heartbeat = setInterval(() => {
      try {
        send({ type: 'ping', ts: Date.now() });
      } catch {
        /* ignore */
      }
    }, 25_000);
    heartbeat.unref?.();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clients.count = Math.max(0, clients.count - 1);
      clearInterval(heartbeat);
      store.off('event', listener);
    };
    ctx.req.on('close', cleanup);
    ctx.req.on('error', cleanup);
  });

  /* --------------------------- Hook ingest ------------------------- */

  /**
   * Opening Claude for the user, when they asked for that. The daemon runs on
   * the same machine as the session, so for a local session with Remote
   * Control this brings the desktop app up on the question; a cloud
   * session's daemon is in the cloud and has no screen to open anything on.
   */
  const openClaude = (session: SessionState) => {
    if (!session.link || session.link.via === 'cloud') return;
    if (!configFor(session).openClaudeOnQuestion) return;
    openInBrowser(session.link.app);
  };

  router.post('/hook/:event', async (ctx) => {
    const event = ctx.params['event'] ?? '';
    let output: HookOutput = HOOK_NOOP;
    try {
      const input = await readJson<Record<string, unknown>>(ctx.req);
      const session = typeof input['session_id'] === 'string' ? store.get(input['session_id']) : undefined;
      const header = (name: string) => {
        const value = ctx.req.headers[name];
        return typeof value === 'string' ? value : null;
      };
      output = await ingestHook(event, input, {
        store,
        config: session ? configFor(session) : config,
        env: {
          remoteSessionId: header('x-harness-remote-session'),
          remoteSdkUrl: header('x-harness-remote-sdk'),
          bridgeSessionId: header('x-harness-bridge-session'),
          entrypoint: header('x-harness-entrypoint'),
        },
        onWaiting: openClaude,
      });
    } catch (err) {
      // A hook must never break the session it is attached to.
      log(`hook ${event} failed: ${(err as Error)?.message}`);
      output = HOOK_NOOP;
    }
    if (!ctx.res.writableEnded) json(ctx.res, 200, output);
  });

  /* --------------------------- MCP bridge -------------------------- */

  const resolveSession = (ctx: Ctx, body: { sessionId?: string; cwd?: string; pid?: number }) => {
    const headerId = ctx.req.headers['x-harness-session'];
    const id = body.sessionId ?? (typeof headerId === 'string' && headerId ? headerId : undefined);
    let session: SessionState | null = null;
    if (id) session = store.ensure(id, body.cwd);
    else if (body.pid) session = store.findByPid(body.pid) ?? null;
    if (!session && body.cwd) session = store.findByCwd(body.cwd) ?? null;
    if (!session) return null;
    if (body.pid && session.claudePid !== body.pid) store.update(session.sessionId, { claudePid: body.pid });
    return session;
  };

  router.post('/mcp/:tool', async (ctx) => {
    const body = await readJson<Record<string, unknown>>(ctx.req);
    const session = resolveSession(ctx, body as { sessionId?: string; cwd?: string; pid?: number });
    if (!session) {
      json(ctx.res, 200, {
        ok: false,
        text:
          '[cc-harness] No session is registered yet. This usually means the harness hooks have not fired; ' +
          'run `harness doctor` to check the plugin wiring.',
      });
      return;
    }
    const id = session.sessionId;
    const url = uiUrl(id);
    const reply = (ok: boolean, message: string) => json(ctx.res, 200, { ok, text: message });

    try {
      switch (ctx.params['tool']) {
        case 'publish': {
          const { plan } = store.publishPlan(id, body as unknown as PlanInput);
          revealUi(session);
          reply(
            true,
            `[cc-harness] Published "${plan.title}" (revision ${plan.revision}). The user reviews it at ${url}\n` +
              'Tell them in chat that the plan is ready, and ask anything you need decided with ' +
              'AskUserQuestion, here in chat. Nothing in the harness waits for them: when they say they ' +
              'have reviewed it, call harness_plan_read.\n\n' +
              renderPlan(plan, { url }),
          );
          return;
        }

        case 'read': {
          if (!session.plan) {
            reply(true, `[cc-harness] No plan yet. Publish one with harness_plan_publish. UI: ${url}`);
            return;
          }
          const textOut = renderPlan(session.plan, { url, changesOnly: body['changes_only'] === true });
          store.markRead(id);
          reply(true, textOut);
          return;
        }

        case 'edit': {
          const ops = Array.isArray(body['ops']) ? (body['ops'] as PlanOp[]).slice(0, MAX_OPS) : [];
          const { changes } = store.applyOps(id, ops, 'claude');
          reply(
            true,
            changes.length
              ? `[cc-harness] Applied ${changes.length} change(s):\n${changes.map((c) => `- ${c.summary} [${c.target.kind} ${c.target.id}]`.replace(' ]', ']')).join('\n')}`
              : '[cc-harness] Nothing changed — every edit matched what was already there.',
          );
          return;
        }

        case 'task': {
          const taskId = String(body['task_id'] ?? '');
          const status = String(body['status'] ?? '') as TaskStatus;
          const note = typeof body['note'] === 'string' ? body['note'] : undefined;
          const { plan, changes } = store.applyOps(
            id,
            [{ op: 'upsert_task', id: taskId, status, ...(note !== undefined ? { note } : {}) }],
            'claude',
          );
          const task = plan.tasks.find((t) => t.id === taskId);
          const unread = plan.changes.filter((c) => c.seq > plan.claudeReadSeq && c.author === 'user').length;
          reply(
            true,
            `[cc-harness] ${task ? `"${task.title}" is ${status.replace('_', ' ')}` : 'Updated'}.` +
              (changes.length ? '' : ' (It already was.)') +
              (unread ? ` The user has changed the plan ${unread} time(s) since you last read it — call harness_plan_read.` : ''),
          );
          return;
        }

        default:
          json(ctx.res, 404, { ok: false, text: `[cc-harness] Unknown tool "${ctx.params['tool']}".` });
      }
    } catch (err) {
      if (err instanceof PlanError) reply(false, `[cc-harness] ${err.message}`);
      else throw err;
    }
  });

  return router;
}

/**
 * Exit once nothing is using the daemon: no browser open and no session
 * active recently. The next hook starts a fresh one.
 */
function startIdleWatch(store: SessionStore, config: HarnessConfig, clients: { count: number }, stop: () => void): void {
  const minutes = config.idleShutdownMinutes;
  if (!minutes || minutes <= 0) return;
  const idleMs = minutes * 60_000;
  const timer = setInterval(() => {
    if (clients.count > 0) return;
    const busy = store.all().some((s) => s.status !== 'ended' && Date.now() - s.updatedAt < idleMs);
    if (busy) return;
    log(`idle for ${minutes}m with no clients; exiting`);
    stop();
  }, 60_000);
  timer.unref?.();
}

/**
 * Sessions whose CLI died without a `SessionEnd` are marked ended, and ended
 * sessions are evicted from memory after a while (their state stays on disk).
 */
const REAP_INTERVAL_MS = 5 * 60 * 1000;
const ENDED_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function startReaper(store: SessionStore): { stop(): void } {
  const timer = setInterval(() => {
    try {
      for (const s of store.all()) {
        if (s.status !== 'ended' && typeof s.claudePid === 'number' && !isPidAlive(s.claudePid)) {
          store.update(s.sessionId, { status: 'ended', endedAt: Date.now() });
        }
      }
      const dropped = store.sweep({ endedTtlMs: ENDED_SESSION_TTL_MS });
      if (dropped) log(`evicted ${dropped} session(s) from memory`);
    } catch (err) {
      log(`reaper failed: ${(err as Error)?.message}`);
    }
  }, REAP_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

void main();
