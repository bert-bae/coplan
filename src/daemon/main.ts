import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { openSync, writeSync, closeSync, unlinkSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionStore } from './store.ts';
import { Router, json, text, readJson, serveStatic, requestSignal, type Ctx } from './http.ts';
import { ingestHook } from './hookIngest.ts';
import { TranscriptTailer } from './transcript.ts';
import { waitForGate, renderGateResult } from './gates.ts';
import { computeDiff, snapshotRound } from './git.ts';
import {
  addNote,
  createTasks,
  recordDecision,
  renderBoard,
  reconcileFiles,
  reorderTasks,
  summarizeBoard,
  tasksFromPlan,
  updateTask,
} from './tasks.ts';
import { addCheck, runAllChecks, runCheck, seedChecks, cancelCheck, cancelAllChecks } from './checks.ts';
import { cleanStorage, scanStorage } from './housekeeping.ts';
import { shutdownChildren, killAllChildren, liveChildCount, liveChildLabels } from './proc.ts';
import { clearBaseline, pruneBaselines } from './tasks.ts';
import { composeShip, executeShip } from './ship.ts';
import { loadConfig, stageInstructions, type HarnessConfig } from '../shared/config.ts';
import { excerptFor } from '../shared/diffparse.ts';
import { ensureHome, paths, readLiveLock, isPidAlive, baseUrl } from '../shared/paths.ts';
import { HOOK_NOOP, type HookOutput } from '../shared/hooks.ts';
import { openInBrowser } from './browser.ts';
import type {
  CleanupGroupId,
  DaemonLock,
  GateKind,
  GateQuestion,
  GateResult,
  Plan,
  PlanStep,
  ReviewThread,
  ServerEvent,
  SessionState,
  Stage,
  TaskStatus,
} from '../shared/types.ts';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

/** Session names the user types. Long enough for a real sentence, short
 *  enough to stay one line in the rail. */
const MAX_TITLE_LENGTH = 120;

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  ensureHome();

  const existing = readLiveLock();
  if (existing && !process.argv.includes('--force')) {
    // Another daemon owns the lock; report its address and exit quietly so
    // that "start" is idempotent from hooks, the CLI and the MCP server.
    process.stdout.write(`${JSON.stringify({ alreadyRunning: true, ...existing })}\n`);
    process.exit(0);
  }

  const baseConfig = loadConfig({ configDir: paths.configDir() });
  const store = new SessionStore({ maxTimelineEvents: baseConfig.maxTimelineEvents });
  const config = baseConfig;
  const tailers = new Map<string, TranscriptTailer>();

  // A restart hands its successor the token and the port, so the browser tab
  // that asked for the restart is still looking at the right address with a
  // cookie that still works. Take them out of the environment immediately:
  // every check and ship command the daemon runs inherits it, and this token
  // authorizes an endpoint that runs shell commands.
  const inheritedToken = process.env['CC_HARNESS_TOKEN'];
  const inheritedPort = Number(process.env['CC_HARNESS_PORT'] ?? 0);
  delete process.env['CC_HARNESS_TOKEN'];
  const token = inheritedToken || randomBytes(24).toString('hex');

  const clients = { count: 0 };
  const server = http.createServer();

  /**
   * Set once `shutdown` exists. The router is built first — it is what the
   * server needs to start — so the restart route reaches the lifecycle
   * through this rather than the other way round.
   */
  const lifecycle = {
    restart(): boolean {
      return false;
    },
  };
  const router = buildRouter({ store, config, tailers, token, clients, lifecycle });

  server.on('request', (req, res) => {
    void handle(req, res, router, token).catch((err: unknown) => {
      log(`request error: ${(err as Error)?.message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  // Long-polls hold connections open for minutes at a time by design.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  const port = await listen(server, inheritedPort);
  const lock: DaemonLock = {
    pid: process.pid,
    port,
    token,
    version: VERSION,
    startedAt: Date.now(),
    host: '127.0.0.1',
  };
  writeLock(lock);
  log(`listening on ${baseUrl(lock)} (pid ${process.pid}, v${VERSION})`);
  process.stdout.write(`${JSON.stringify({ started: true, ...lock })}\n`);

  /**
   * Release everything this process owns, in dependency order.
   *
   * Runs at most once — a second signal while the first shutdown is in flight
   * must not re-enter it — and is deliberately bounded: a shutdown that can
   * hang is a shutdown that leaves orphans behind, which is the exact failure
   * it exists to prevent.
   */
  let shuttingDown = false;
  const shutdown = (signal: string, respawn = false) => {
    if (shuttingDown) {
      // Second signal: the user is insisting. Take the fast path.
      log(`second signal (${signal}); exiting now`);
      killAllChildren();
      process.exit(0);
    }
    shuttingDown = true;
    log(`shutting down (${signal})`);

    // Children are spawned detached so they can survive a wedged shell being
    // killed — which means they also survive this process unless reaped.
    const straggling = liveChildCount();
    if (straggling) log(`terminating ${straggling} child process tree(s): ${liveChildLabels().join(', ')}`);
    cancelAllChecks();

    for (const t of tailers.values()) t.close();
    tailers.clear();
    reaper.stop();
    store.persistAll();

    // Stop accepting work, then drop the long-poll and SSE connections that
    // would otherwise hold `close` open for their full window.
    server.close();
    server.closeAllConnections?.();

    try {
      const live = readLiveLock();
      if (live?.pid === process.pid) unlinkSync(paths.lockFile());
    } catch {
      /* ignore */
    }

    const leave = () => {
      if (respawn) respawnDaemon(lock);
      process.exit(0);
    };

    void shutdownChildren(SHUTDOWN_GRACE_MS).catch(() => 0).finally(leave);

    // Backstop: never let a stuck reap keep the daemon alive indefinitely.
    setTimeout(() => {
      killAllChildren();
      leave();
    }, SHUTDOWN_GRACE_MS + 1_500).unref();
  };

  /**
   * Replace this daemon with one running the current build.
   *
   * The whole point is picking up a rebuild, so the successor is started from
   * the entry file on disk rather than from anything this process is holding
   * in memory. It inherits the port and the token, which is what lets an open
   * browser tab reconnect to it without being sent back to a dead address.
   */
  lifecycle.restart = () => {
    if (shuttingDown) return false;
    log('restart requested; handing over to a fresh daemon');
    // Let the response reach the client before the socket goes away.
    setTimeout(() => shutdown('restart', true), RESTART_DELAY_MS).unref();
    return true;
  };

  const reaper = startReaper(store, tailers);
  startIdleWatch(store, config, clients, () => shutdown('idle'));

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  // The terminal that started us going away must not leave the tree running.
  process.on('exit', () => killAllChildren());
  process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled: ${String(err)}`));
}

/** SIGTERM-to-SIGKILL window for child process trees at shutdown. */
const SHUTDOWN_GRACE_MS = 800;
/** Grace for the restart response to flush before the socket is torn down. */
const RESTART_DELAY_MS = 120;
/** How long a successor keeps trying to claim its predecessor's port. */
const PORT_CLAIM_MS = 5_000;
/** Sessions remembered as "already opened a browser tab for". */
const MAX_TRACKED_OPENS = 200;
/** Per-project resolved configs held in memory. */
const MAX_CACHED_CONFIGS = 50;

/**
 * Bind, retrying a requested port while its previous owner lets go.
 *
 * A restarting daemon asks for the port its predecessor was on, and spawns
 * before that process has finished exiting — so the first attempt often loses
 * the race by a few hundred milliseconds. Keeping the address is what makes
 * the open browser tab reconnect on its own; falling back to an ephemeral
 * port after `PORT_CLAIM_MS` is what stops that preference from being able to
 * keep the harness down.
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

/**
 * Start the replacement daemon, detached, on the way out.
 *
 * Detached and with its streams released, so it is not a child of a process
 * that is about to exit — and started from `process.argv[1]`, which is the
 * bundle on disk and therefore the newly built one.
 */
function respawnDaemon(lock: DaemonLock): void {
  const entry = process.argv[1];
  if (!entry) return;
  try {
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CC_HARNESS_PORT: String(lock.port),
        CC_HARNESS_TOKEN: lock.token,
      },
    });
    child.on('error', () => {
      /* nothing left to report to: this process is already exiting */
    });
    child.unref();
  } catch {
    /* a failed respawn leaves no daemon; the next hook starts one */
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

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  router: Router,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  // Loopback only. Reject anything that arrived with a foreign Host header,
  // which is the shape a DNS-rebinding attempt would take.
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
    // Anything unmatched falls through to the static UI bundle.
    if (req.method === 'GET' && serveStatic(res, UI_DIR, url.pathname === '/' ? 'index.html' : url.pathname)) {
      return;
    }
    text(res, 404, 'not found');
    return;
  }

  const ctx: Ctx = { req, res, url, params: match.params };
  await match.handler(ctx);
}

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  if (url.searchParams.get('token') === token) return true;
  const cookie = req.headers.cookie ?? '';
  return cookie.split(';').some((c) => c.trim() === `cc_harness=${token}`);
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

interface Deps {
  store: SessionStore;
  config: HarnessConfig;
  tailers: Map<string, TranscriptTailer>;
  token: string;
  /** Live SSE connections, so an open browser counts as "in use". */
  clients: { count: number };
  /** Process-level actions the UI can ask for. */
  lifecycle: { restart(): boolean };
}

function buildRouter(deps: Deps): Router {
  const { store, config, tailers, token, clients, lifecycle } = deps;
  const router = new Router();

  /** For the browser and the CLI: carries the token, which the daemon
   *  immediately exchanges for a cookie. */
  const authedUrl = (sessionId?: string) => {
    const lock = readLiveLock();
    const port = lock?.port ?? 0;
    const base = `http://127.0.0.1:${port}/?token=${token}`;
    return sessionId ? `${base}#/session/${sessionId}` : base;
  };

  /** For Claude. Deliberately token-free: anything returned to the model is
   *  written to the transcript on disk and carried in every later context
   *  window, and this token authorizes running shell commands. */
  const uiUrl = (sessionId: string) => {
    const lock = readLiveLock();
    return `http://127.0.0.1:${lock?.port ?? 0}/#/session/${sessionId}`;
  };

  // The plugin is installed globally, so a browser tab per session start
  // would be noise. Open once, the first time a session actually uses the
  // harness — a stage transition, or a gate that needs an answer.
  // Bounded: session ids are unique per session, so an unbounded set here
  // would grow for the daemon's whole life. Forgetting the oldest entries only
  // risks re-opening a tab for a session nobody has touched in a long time.
  const opened = new Set<string>();
  const revealUi = (sessionId: string) => {
    if (!config.autoOpen || opened.has(sessionId)) return;
    opened.add(sessionId);
    if (opened.size > MAX_TRACKED_OPENS) {
      const oldest = opened.values().next();
      if (!oldest.done) opened.delete(oldest.value);
    }
    openInBrowser(authedUrl(sessionId));
  };

  const configCache = new Map<string, HarnessConfig>();
  const configFor = (session: SessionState): HarnessConfig => {
    const key = session.repoRoot ?? session.cwd;
    let resolved = configCache.get(key);
    if (!resolved) {
      resolved = loadConfig({ configDir: paths.configDir(), projectDir: key });
      // Keyed by repo, so this is small — but "small" is not "bounded".
      if (configCache.size > MAX_CACHED_CONFIGS) configCache.clear();
      configCache.set(key, resolved);
    }
    return resolved;
  };

  /** Sessions the daemon is holding, which housekeeping must never touch. */
  const residentIds = (): string[] => store.all().map((s) => s.sessionId);

  const sessionOr404 = (ctx: Ctx): SessionState | null => {
    const id = ctx.params['id'] ?? '';
    const session = store.get(id);
    if (!session) {
      json(ctx.res, 404, { error: 'unknown session' });
      return null;
    }
    return session;
  };

  /* --------------------------- UI bootstrap ------------------------ */

  router.get('/', (ctx) => {
    // Trade the query-string token for a cookie so deep links and the SSE
    // stream work without carrying the token through every URL.
    const provided = ctx.url.searchParams.get('token');
    if (provided === token) {
      ctx.res.setHeader('set-cookie', `cc_harness=${token}; Path=/; SameSite=Strict; HttpOnly`);
    }
    if (!serveStatic(ctx.res, UI_DIR, 'index.html')) text(ctx.res, 500, 'UI bundle missing — run npm run build');
  });

  /* --------------------------- Sessions ---------------------------- */

  router.get('/api/sessions', (ctx) => json(ctx.res, 200, { sessions: store.summaries(), version: VERSION }));

  router.get('/api/session/:id', (ctx) => {
    const session = sessionOr404(ctx);
    if (session) json(ctx.res, 200, { session, diff: store.getDiff(session.sessionId) ?? null });
  });

  /**
   * Delete a session for good.
   *
   * The transcript tailer has to go with it: it holds an open watcher and
   * would keep calling `store.ensure`, which reads state back from disk and
   * would recreate the very session the user just deleted.
   */
  router.delete('/api/session/:id', (ctx) => {
    const id = ctx.params['id'] ?? '';
    if (!store.get(id)) {
      json(ctx.res, 404, { error: 'unknown session' });
      return;
    }
    tailers.get(id)?.close();
    tailers.delete(id);
    const deleted = store.purge(id);
    json(ctx.res, 200, { deleted });
  });

  /**
   * Rename a session.
   *
   * `titleLocked` is what makes the rename stick: the transcript tailer picks
   * up the CLI's own auto-generated title and would otherwise overwrite the
   * user's within seconds.
   */
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

  router.get('/api/session/:id/diff', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const refresh = ctx.url.searchParams.get('refresh') === '1';
    let diff = store.getDiff(session.sessionId);
    if (!diff || refresh) {
      diff = await computeDiff(session.repoRoot ?? session.cwd, {
        baseRef: session.baseRef,
        startCommit: session.startCommit,
        maxFileBytes: configFor(session).maxDiffFileBytes,
      });
      store.setDiff(session.sessionId, diff);
    }
    json(ctx.res, 200, { diff });
  });

  /* --------------------------- Maintenance ------------------------- */

  /**
   * Global actions: they belong to the daemon, not to any one session, and
   * both of them are things a user previously had to leave the browser and
   * open a terminal to do.
   */

  router.get('/api/storage', (ctx) => {
    json(ctx.res, 200, { report: scanStorage({ liveSessionIds: residentIds() }) });
  });

  /**
   * Remove reclaimable files, and hand back a fresh report.
   *
   * The report is recomputed from the post-clean state rather than subtracted
   * from the one the browser was holding, so a session that came back to life
   * mid-request shows up as still occupying space instead of silently
   * disappearing from the total.
   */
  router.post('/api/storage/clean', async (ctx) => {
    const body = await readJson<{ groups?: CleanupGroupId[]; dryRun?: boolean }>(ctx.req);
    const result = cleanStorage({
      liveSessionIds: residentIds(),
      ...(body.groups ? { groups: body.groups } : {}),
      ...(body.dryRun ? { dryRun: true } : {}),
    });
    if (!result.dryRun && result.removed) {
      log(`housekeeping removed ${result.removed} item(s), ${result.freedBytes} bytes`);
    }
    json(ctx.res, 200, { result, report: scanStorage({ liveSessionIds: residentIds() }) });
  });

  /**
   * Restart the daemon in place, so a rebuilt plugin takes effect.
   *
   * Answered before the handover starts: the connection this response travels
   * on is one of the ones the shutdown is about to close.
   */
  router.post('/api/daemon/restart', (ctx) => {
    const running = liveChildLabels();
    const started = lifecycle.restart();
    json(ctx.res, started ? 200 : 409, {
      restarting: started,
      port: readLiveLock()?.port ?? null,
      // Checks and ship commands are killed by the shutdown. Say which, so
      // the UI can report what the restart interrupted rather than leaving a
      // check that simply stopped.
      interrupted: running,
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

    const send = (event: ServerEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'sessions', sessions: store.summaries() });

    const focus = ctx.url.searchParams.get('session');
    if (focus) {
      const session = store.get(focus);
      if (session) send({ type: 'snapshot', session });
    }

    const listener = (event: ServerEvent) => {
      try {
        send(event);
      } catch {
        /* the cleanup below will fire */
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

  /* --------------------------- UI actions -------------------------- */

  router.post('/api/session/:id/gate/:gateId/resolve', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{
      verdict?: GateResult['verdict'];
      comment?: string;
      steps?: PlanStep[];
      threads?: ReviewThread[];
      ship?: GateResult['ship'];
      answers?: Record<string, string>;
    }>(ctx.req);

    // A structured question answers per question id. Everything downstream
    // reads `comment`, so fold the answers into one before they get there.
    const asked = store.getGate(session.sessionId, ctx.params['gateId'] ?? '');
    const comment =
      body.comment ??
      (body.answers && asked?.kind === 'question'
        ? composeAnswerComment(asked.meta?.questions ?? [], body.answers)
        : undefined);

    const result: GateResult = {
      verdict: body.verdict ?? 'approved',
      resolvedAt: Date.now(),
      ...(comment ? { comment } : {}),
      ...(body.steps ? { steps: body.steps } : {}),
      ...(body.threads ? { threads: hydrateThreads(store, session.sessionId, body.threads) } : {}),
      ...(body.ship ? { ship: body.ship } : {}),
      ...(body.answers ? { answers: body.answers } : {}),
    };

    const gate = store.resolveGate(session.sessionId, ctx.params['gateId'] ?? '', result);
    if (!gate) {
      json(ctx.res, 409, { error: 'gate is not open' });
      return;
    }

    // An approved plan becomes the task board, so the user never has to ask
    // for it and the agent never has to spend tokens restating it.
    if (gate.kind === 'plan' && result.verdict === 'approved' && result.steps?.length) {
      tasksFromPlan(store, session.sessionId, result.steps);
    }
    // An answered question unblocks whatever task asked it, and the answer is
    // written onto that task as a decision.
    if (gate.kind === 'question' && result.comment) {
      recordDecision(store, session.sessionId, gate.id, result.comment);
    }
    json(ctx.res, 200, { gate });
  });

  router.post('/api/session/:id/feedback', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{
      text?: string;
      origin?: 'timeline' | 'plan' | 'diff' | 'checks' | 'ship';
      threads?: ReviewThread[];
    }>(ctx.req);

    if (!body.text?.trim() && !body.threads?.length) {
      json(ctx.res, 400, { error: 'empty feedback' });
      return;
    }
    const item = store.queueFeedback(session.sessionId, {
      text: body.text?.trim() ?? '',
      origin: body.origin ?? 'timeline',
      ...(body.threads ? { threads: hydrateThreads(store, session.sessionId, body.threads) } : {}),
    });
    json(ctx.res, 200, { item, delivery: session.status === 'idle' ? 'queued' : 'pending' });
  });

  router.post('/api/session/:id/threads', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ threads?: ReviewThread[] }>(ctx.req);
    const threads = hydrateThreads(store, session.sessionId, body.threads ?? []);
    store.mutate(session.sessionId, (s) => {
      const byId = new Map(s.threads.map((t) => [t.id, t]));
      for (const t of threads) byId.set(t.id, t);
      s.threads = [...byId.values()];
    });
    json(ctx.res, 200, { threads });
  });

  router.post('/api/session/:id/tasks/:taskId', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ status?: TaskStatus; title?: string; detail?: string }>(ctx.req);
    const task = updateTask(store, session.sessionId, ctx.params['taskId'] ?? '', body);
    if (!task) {
      json(ctx.res, 404, { error: 'unknown task' });
      return;
    }
    // Moving a card is a statement about the work, so tell Claude about it.
    store.queueFeedback(session.sessionId, {
      text: `The user moved "${task.title}" to ${task.status.replace('_', ' ')} on the board.`,
      origin: 'timeline',
    });
    json(ctx.res, 200, { task });
  });

  router.post('/api/session/:id/tasks/reorder', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ ids?: string[] }>(ctx.req);
    json(ctx.res, 200, { tasks: reorderTasks(store, session.sessionId, body.ids ?? []) });
  });

  router.post('/api/session/:id/thread/:threadId/reply', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ text?: string }>(ctx.req);
    const text = body.text?.trim();
    if (!text) {
      json(ctx.res, 400, { error: 'text required' });
      return;
    }
    const thread = store.addThreadReply(session.sessionId, ctx.params['threadId'] ?? '', {
      author: 'user',
      text,
    });
    if (!thread) {
      json(ctx.res, 404, { error: 'unknown thread' });
      return;
    }
    store.queueFeedback(session.sessionId, {
      text: `Reply on ${thread.file}:${thread.startLine} — ${text}`,
      origin: 'diff',
      threads: [thread],
    });
    json(ctx.res, 200, { thread });
  });

  router.post('/api/session/:id/thread/:threadId/resolve', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ resolved?: boolean }>(ctx.req);
    const thread = store.setThreadResolved(
      session.sessionId,
      ctx.params['threadId'] ?? '',
      body.resolved !== false,
    );
    if (!thread) {
      json(ctx.res, 404, { error: 'unknown thread' });
      return;
    }
    json(ctx.res, 200, { thread });
  });

  router.post('/api/session/:id/checks', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ command?: string; commands?: string[]; label?: string }>(ctx.req);
    if (body.commands) {
      json(ctx.res, 200, { checks: seedChecks(store, session.sessionId, body.commands) });
      return;
    }
    if (!body.command?.trim()) {
      json(ctx.res, 400, { error: 'command required' });
      return;
    }
    json(ctx.res, 200, { check: addCheck(store, session.sessionId, body.command.trim(), body.label) });
  });

  router.post('/api/session/:id/checks/run', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ checkId?: string }>(ctx.req);
    // Respond immediately; results stream over SSE as they arrive.
    if (body.checkId) void runCheck(store, session.sessionId, body.checkId);
    else void runAllChecks(store, session.sessionId);
    json(ctx.res, 202, { started: true });
  });

  router.post('/api/session/:id/checks/cancel', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ checkId?: string }>(ctx.req);
    json(ctx.res, 200, { cancelled: body.checkId ? cancelCheck(body.checkId) : false });
  });

  router.get('/api/session/:id/ship', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const cfg = configFor(session);
    const ship = session.ship ?? (await composeShip(session, cfg));
    json(ctx.res, 200, {
      ship,
      providers: Object.entries(cfg.ship.providers).map(([id, p]) => ({
        id,
        kind: p.kind,
        label: p.label ?? id,
      })),
    });
  });

  router.post('/api/session/:id/ship', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ ship?: SessionState['ship'] }>(ctx.req);
    const cfg = configFor(session);
    const ship = body.ship ?? session.ship ?? (await composeShip(session, cfg));
    store.mutate(session.sessionId, (s) => {
      s.ship = ship;
    });

    const outcome = await executeShip(store, session.sessionId, cfg, ship);

    // Resolve the gate here rather than in the browser, so the verdict Claude
    // receives carries what actually happened — including the directive for
    // an MCP-backed provider, which only the session can act on.
    const gate = store.activeGate(session.sessionId);
    if (gate?.kind === 'ship') {
      store.resolveGate(session.sessionId, gate.id, {
        verdict: outcome.ok ? 'approved' : 'changes_requested',
        resolvedAt: Date.now(),
        ship: {
          title: ship.title,
          body: ship.body,
          commitMessage: ship.commitMessage,
          steps: ship.steps,
          provider: ship.provider,
          branch: ship.branch,
          baseBranch: ship.baseBranch,
          ...(outcome.directive ? { directive: outcome.directive } : {}),
          outcome: {
            ok: outcome.ok,
            output: outcome.output,
            ...(outcome.url ? { url: outcome.url } : {}),
            ...(outcome.summaryPath ? { summaryPath: outcome.summaryPath } : {}),
          },
        },
      });
    }
    json(ctx.res, outcome.ok ? 200 : 400, outcome);
  });

  /* --------------------------- Hook ingest ------------------------- */

  router.post('/hook/:event', async (ctx) => {
    const event = ctx.params['event'] ?? '';
    let output: HookOutput = HOOK_NOOP;
    try {
      const input = await readJson(ctx.req);
      output = await ingestHook(event, input, {
        store,
        config,
        uiUrl: authedUrl,
        tailers,
        signal: requestSignal(ctx.req),
      });
    } catch (err) {
      // A hook must never break the session it is attached to.
      log(`hook ${event} failed: ${(err as Error)?.message}`);
      output = HOOK_NOOP;
    }
    if (!ctx.res.writableEnded) json(ctx.res, 200, output);
  });

  /* --------------------------- MCP bridge -------------------------- */

  const resolveSession = async (ctx: Ctx, body: { sessionId?: string; cwd?: string; pid?: number }) => {
    const headerId = ctx.req.headers['x-harness-session'];
    const id = body.sessionId ?? (typeof headerId === 'string' ? headerId : undefined);
    let session: SessionState | null = null;
    if (id) session = store.ensure(id, body.cwd);
    else if (body.pid) session = store.findByPid(body.pid) ?? null;
    if (!session && body.cwd) session = store.findByCwd(body.cwd) ?? null;
    if (!session) return null;
    // Remember which CLI process this session belongs to. The `SessionEnd`
    // hook is the happy path, but it does not fire when the CLI is killed or
    // crashes — and then a liveness check on this pid is the only thing that
    // tells the reaper the session's tailer can be closed.
    if (body.pid && session.claudePid !== body.pid) {
      store.update(session.sessionId, { claudePid: body.pid });
    }
    return session;
  };

  router.post('/mcp/:tool', async (ctx) => {
    const body = await readJson<Record<string, unknown>>(ctx.req);
    const session = await resolveSession(ctx, body as { sessionId?: string; cwd?: string; pid?: number });
    if (!session) {
      json(ctx.res, 200, {
        text:
          '[cc-harness] No session is registered yet. This usually means the harness hooks have not fired; ' +
          'run `harness doctor` to check the plugin wiring.',
        ok: false,
      });
      return;
    }
    const id = session.sessionId;

    switch (ctx.params['tool']) {
      case 'stage': {
        revealUi(id);
        const stage = String(body['stage'] ?? '') as Stage;
        const note = typeof body['note'] === 'string' ? body['note'] : undefined;
        store.setStage(id, stage, note);
        const custom = stageInstructions(configFor(session), stage, {
          configDir: paths.configDir(),
          projectDir: session.repoRoot,
        });
        json(ctx.res, 200, {
          ok: true,
          text: [
            `[cc-harness] Stage set to "${stage}". UI: ${uiUrl(id)}`,
            custom ? `\nProject instructions for this stage:\n${custom}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        return;
      }

      case 'plan': {
        revealUi(id);
        const plan = buildPlan(body, session.plan);
        store.mutate(id, (s) => {
          s.plan = plan;
          s.stage = 'plan_review';
        });
        const gate = store.openGate(id, 'plan', 'Review the plan');
        json(ctx.res, 200, {
          ok: true,
          gateId: gate?.id,
          text:
            `[cc-harness] Plan published (${plan.steps.length} steps) and the plan gate is open.\n` +
            `The user is reviewing it at ${uiUrl(id)}\n` +
            `Call harness_await({ gate_id: "${gate?.id}" }) now and wait for their verdict.`,
        });
        return;
      }

      case 'diff': {
        revealUi(id);
        const baseRef = typeof body['base_ref'] === 'string' ? body['base_ref'] : null;
        const round = session.reviewRound + 1;
        const previous = session.roundHistory.at(-1) ?? null;
        const diff = await computeDiff(session.repoRoot ?? session.cwd, {
          baseRef,
          startCommit: session.startCommit,
          maxFileBytes: configFor(session).maxDiffFileBytes,
          previous,
          round,
        });
        store.setDiff(id, diff);
        store.mutate(id, (s) => {
          s.baseRef = diff.baseRef;
          s.stage = 'code_review';
          s.reviewRound = round;
          s.roundHistory.push(snapshotRound(diff, round));
          if (s.roundHistory.length > 20) s.roundHistory.splice(0, s.roundHistory.length - 20);
          // Comments Claude has already been handed belong to the round that
          // just ended; this diff is its answer to them.
          for (const thread of s.threads) {
            if (thread.deliveredAt && !thread.resolved) thread.resolved = true;
          }
        });
        const gate = store.openGate(id, 'code_review', 'Review the code changes');
        const moved = diff.changedSinceLastReview?.length;
        json(ctx.res, 200, {
          ok: true,
          gateId: gate?.id,
          round,
          text:
            `[cc-harness] Diff published (round ${round}): ${diff.files.length} file(s), ` +
            `+${diff.additions}/-${diff.deletions} against ${diff.baseRef.slice(0, 12)}.` +
            (moved !== undefined ? ` ${moved} file(s) changed since the last review.` : '') +
            `\nThe user is reviewing it at ${uiUrl(id)}\n` +
            `Call harness_await({ gate_id: "${gate?.id}" }) and wait for their line comments.`,
        });
        return;
      }

      case 'checks': {
        revealUi(id);
        const commands = Array.isArray(body['commands'])
          ? (body['commands'] as unknown[]).filter((c): c is string => typeof c === 'string')
          : configFor(session).stages.verification?.checks ?? [];
        if (commands.length) seedChecks(store, id, commands);
        store.setStage(id, 'verification');

        // Run to completion before opening the gate. Asking the user to sign
        // off on a list of `pending` checks is asking them to sign off on
        // nothing, and the skills tell Claude never to do that.
        const results = body['run'] === false ? [] : await runAllChecks(store, id);
        const failed = results.filter((c) => c.status === 'failed');
        const gate = store.openGate(
          id,
          'verification',
          failed.length ? `${failed.length} check(s) failed — review` : 'Sign off on the verification results',
        );
        json(ctx.res, 200, {
          ok: true,
          gateId: gate?.id,
          failed: failed.map((c) => ({ command: c.command, exitCode: c.exitCode })),
          text: failed.length
            ? `[cc-harness] ${failed.length} of ${results.length} check(s) FAILED:\n` +
              failed.map((c) => `  ✗ ${c.command} (exit ${c.exitCode})\n${tailOf(c.output)}`).join('\n') +
              `\nFix these and call harness_publish_checks again. Do not ask the user to sign off on a red check.`
            : `[cc-harness] All ${results.length} check(s) passed. Results are at ${uiUrl(id)}\n` +
              `Call harness_await({ gate_id: "${gate?.id}" }) to wait for the user's sign-off.`,
        });
        return;
      }

      case 'ship': {
        revealUi(id);
        const shipConfig = configFor(session);
        const ship = await composeShip(session, shipConfig);
        store.mutate(id, (s) => {
          s.ship = ship;
          s.stage = 'ship';
        });
        const gate = store.openGate(id, 'ship', 'Confirm the ship');
        json(ctx.res, 200, {
          ok: true,
          gateId: gate?.id,
          ship,
          text:
            `[cc-harness] Ship stage open. Title: "${ship.title}". Provider: ${ship.provider}. ` +
            `Steps: ${ship.steps.join(' → ')}.\n` +
            `The user confirms (and can edit the title/body/provider) at ${uiUrl(id)}\n` +
            `Call harness_await({ gate_id: "${gate?.id}" }). If they pick an MCP provider, ` +
            `you will be handed a directive to perform the PR call yourself.`,
        });
        return;
      }

      case 'ask': {
        revealUi(id);
        const question = String(body['question'] ?? '').trim();
        if (!question) {
          json(ctx.res, 200, { ok: false, text: '[cc-harness] A question is required.' });
          return;
        }
        const questions = normalizeQuestions(body, question);
        const options = simpleOptions(body);
        const gate = store.openGate(id, 'question', question, {
          ...(options.length ? { options } : {}),
          ...(questions ? { questions } : {}),
        });
        json(ctx.res, 200, {
          ok: true,
          gateId: gate?.id,
          text:
            `[cc-harness] Question posted to the review UI: "${question}"\n` +
            `The user answers at ${uiUrl(id)}\n` +
            `Call harness_await({ gate_id: "${gate?.id}" }) and wait for their answer. ` +
            `Do not guess or proceed on an assumption.`,
        });
        return;
      }

      case 'await': {
        const gateId = typeof body['gate_id'] === 'string' ? body['gate_id'] : store.activeGate(id)?.id;
        if (!gateId) {
          json(ctx.res, 200, {
            ok: true,
            status: 'no_gate',
            text: '[cc-harness] No gate is open. Nothing to wait for.',
          });
          return;
        }
        const seconds = clamp(Number(body['timeout_seconds'] ?? config.awaitSeconds), 5, 600);
        const result = await waitForGate(store, id, gateId, {
          timeoutMs: seconds * 1000,
          signal: requestSignal(ctx.req),
        });
        const gate = store.getGate(id, gateId);
        if (result && gate) {
          store.markGateDelivered(id, gateId);
          json(ctx.res, 200, { ok: true, status: 'resolved', result, text: renderGateResult(gate) });
          return;
        }
        json(ctx.res, 200, {
          ok: true,
          status: 'pending',
          text:
            `[cc-harness] Still waiting on the user (${seconds}s elapsed). ` +
            `Call harness_await({ gate_id: "${gateId}" }) again. Do not start new work while a gate is open.`,
        });
        return;
      }

      case 'tasks': {
        const specs = Array.isArray(body['tasks'])
          ? (body['tasks'] as unknown[])
              .map((raw) => {
                if (typeof raw === 'string') return { title: raw };
                if (raw && typeof raw === 'object') {
                  const rec = raw as Record<string, unknown>;
                  const title = typeof rec['title'] === 'string' ? rec['title'] : '';
                  if (!title) return null;
                  return { title, ...(typeof rec['detail'] === 'string' ? { detail: rec['detail'] } : {}) };
                }
                return null;
              })
              .filter((t): t is { title: string; detail?: string } => t !== null)
          : [];

        if (specs.length === 0) {
          json(ctx.res, 200, {
            ok: true,
            board: session.tasks,
            text: `[cc-harness] Task board:\n${renderBoard(session.tasks)}`,
          });
          return;
        }
        const created = createTasks(store, id, specs, { replace: body['replace'] === true });
        json(ctx.res, 200, {
          ok: true,
          tasks: created.map((t) => ({ id: t.id, title: t.title })),
          text:
            `[cc-harness] ${created.length} task(s) on the board, visible at ${uiUrl(id)}\n` +
            created.map((t) => `  [${t.id.slice(0, 8)}] ${t.title}`).join('\n') +
            `\nStart one with harness_task_update({ task_id, status: "in_progress" }).`,
        });
        return;
      }

      case 'task_update': {
        const taskId = resolveTaskId(session.tasks, String(body['task_id'] ?? ''));
        if (!taskId) {
          json(ctx.res, 200, { ok: false, text: `[cc-harness] No task matches "${body['task_id']}".` });
          return;
        }
        const status = body['status'] as TaskStatus | undefined;
        const note = typeof body['note'] === 'string' ? body['note'].trim() : '';

        if (status === 'done' && !note) {
          // The record of what changed is the point of the board.
          json(ctx.res, 200, {
            ok: false,
            text:
              '[cc-harness] Completing a task requires `note`: one or two lines on what you actually ' +
              'changed. That record is what the user reviews against.',
          });
          return;
        }

        // Attribute anything edited since the last transition before moving on.
        await reconcileFiles(store, id);
        const updated = updateTask(store, id, taskId, status ? { status } : {});
        if (note) addNote(store, id, taskId, status === 'done' ? 'change' : 'note', note);
        await reconcileFiles(store, id);

        const after = store.get(id);
        json(ctx.res, 200, {
          ok: true,
          text:
            `[cc-harness] "${updated?.title}" → ${updated?.status}.\n` +
            summarizeBoard(after?.tasks ?? []),
        });
        return;
      }

      case 'task_note': {
        const taskId = resolveTaskId(session.tasks, String(body['task_id'] ?? ''));
        const text = String(body['text'] ?? '').trim();
        if (!taskId || !text) {
          json(ctx.res, 200, { ok: false, text: '[cc-harness] task_id and text are both required.' });
          return;
        }
        const kind = (body['kind'] as 'change' | 'decision' | 'blocker' | 'note') ?? 'change';
        addNote(store, id, taskId, kind, text);
        json(ctx.res, 200, { ok: true, text: '[cc-harness] Recorded on the task.' });
        return;
      }

      case 'task_block': {
        const taskId = resolveTaskId(session.tasks, String(body['task_id'] ?? ''));
        const question = String(body['question'] ?? '').trim();
        if (!taskId || !question) {
          json(ctx.res, 200, { ok: false, text: '[cc-harness] task_id and question are both required.' });
          return;
        }
        revealUi(id);
        await reconcileFiles(store, id);
        const options = simpleOptions(body);
        const questions = normalizeQuestions(body, question);
        const gate = store.openGate(id, 'question', question, {
          ...(options.length ? { options } : {}),
          ...(questions ? { questions } : {}),
        });
        updateTask(store, id, taskId, {
          status: 'blocked',
          blockedBy: gate?.id ?? null,
          blockedReason: question,
        });
        addNote(store, id, taskId, 'blocker', question);

        json(ctx.res, 200, {
          ok: true,
          gateId: gate?.id,
          text:
            `[cc-harness] Task blocked and the question is on the board: "${question}"\n` +
            `The user answers at ${uiUrl(id)}\n` +
            `Call harness_await({ gate_id: "${gate?.id}" }). Their answer is recorded on the task as a ` +
            `decision automatically — do not guess and carry on.`,
        });
        return;
      }

      case 'reply': {
        const threadId = String(body['thread_id'] ?? '');
        const text = String(body['text'] ?? '').trim();
        if (!threadId || !text) {
          json(ctx.res, 200, { ok: false, text: '[cc-harness] thread_id and text are both required.' });
          return;
        }
        const thread = store.addThreadReply(id, threadId, { author: 'claude', text });
        if (!thread) {
          json(ctx.res, 200, { ok: false, text: `[cc-harness] No comment thread "${threadId}".` });
          return;
        }
        if (body['resolve'] !== false) store.setThreadResolved(id, threadId, true);
        json(ctx.res, 200, {
          ok: true,
          text: `[cc-harness] Replied on ${thread.file}:${thread.startLine}.`,
        });
        return;
      }

      case 'note': {
        const note = String(body['text'] ?? '').trim();
        if (note) store.addTimeline(id, 'note', note, { label: 'claude' });
        json(ctx.res, 200, { ok: true, text: '[cc-harness] Noted.' });
        return;
      }

      case 'status': {
        json(ctx.res, 200, {
          ok: true,
          session: summarizeForModel(session),
          text: `${describeStatus(session, uiUrl(id))}\n${summarizeBoard(session.tasks)}`,
        });
        return;
      }

      default:
        json(ctx.res, 404, { ok: false, text: `[cc-harness] Unknown tool "${ctx.params['tool']}".` });
    }
  });

  return router;
}

/**
 * Exit once nothing is using the daemon.
 *
 * It starts on demand from a hook and never had a reason to stop, so a week of
 * work would leave a row of idle daemons behind. A session or an open browser
 * keeps it alive; anything else lets it go, and the next hook starts a fresh one.
 */
function startIdleWatch(
  store: SessionStore,
  config: HarnessConfig,
  clients: { count: number },
  stop: () => void,
): void {
  const minutes = config.idleShutdownMinutes;
  if (!minutes || minutes <= 0) return;
  const idleMs = minutes * 60_000;

  const timer = setInterval(() => {
    if (clients.count > 0) return;
    // Never exit out from under a check or a ship command still running: the
    // shutdown would kill the tree the user is waiting on.
    if (liveChildCount() > 0) return;
    const sessions = store.all();
    const busy = sessions.some((s) => s.status !== 'ended' && Date.now() - s.updatedAt < idleMs);
    if (busy) return;
    if (sessions.some((s) => s.gates.some((g) => g.status === 'open'))) return;
    log(`idle for ${minutes}m with no clients; exiting`);
    stop();
  }, 60_000);
  timer.unref?.();
}

/**
 * Periodic cleanup of per-session resources the hooks did not get to.
 *
 * `SessionEnd` closes a session's transcript tailer and drops its file
 * baseline, and that covers the normal case. It does not fire when the CLI is
 * SIGKILLed, crashes, or the machine sleeps through it — and a leaked tailer
 * is a 700ms interval plus an `fs.watch` descriptor held for the rest of the
 * daemon's life, while a leaked baseline retains a fingerprint of every dirty
 * file in the repo. Over a daemon that runs for weeks, that is the leak.
 *
 * A session is considered gone when the store has forgotten it, the hook
 * marked it ended, the CLI process behind it is no longer alive, or nothing
 * has touched it in `STALE_SESSION_MS` (the tailer itself refreshes
 * `updatedAt` whenever the transcript grows, so silence means silence).
 */
const REAP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_SESSION_MS = 6 * 60 * 60 * 1000;
/** Ended sessions are dropped from memory this long after they finished. */
const ENDED_SESSION_TTL_MS = 60 * 60 * 1000;

interface Reaper {
  stop(): void;
  /** Exposed for tests and for `shutdown` to run one final pass. */
  runOnce(now?: number): number;
}

function startReaper(store: SessionStore, tailers: Map<string, TranscriptTailer>): Reaper {
  const runOnce = (now = Date.now()): number => {
    let closed = 0;
    for (const [sessionId, tailer] of tailers) {
      const session = store.get(sessionId);
      const dead =
        !session ||
        session.status === 'ended' ||
        (typeof session.claudePid === 'number' && !isPidAlive(session.claudePid)) ||
        now - session.updatedAt > STALE_SESSION_MS;
      if (!dead) continue;
      tailer.close();
      tailers.delete(sessionId);
      clearBaseline(sessionId);
      closed++;
    }
    // Baselines outlive their tailer when a session is attributed files but
    // never tailed, so sweep them against the store as well.
    pruneBaselines((id) => {
      const session = store.get(id);
      return Boolean(session && session.status !== 'ended' && now - session.updatedAt <= STALE_SESSION_MS);
    });

    const dropped = store.sweep({ endedTtlMs: ENDED_SESSION_TTL_MS, now });
    if (closed || dropped) log(`reaped ${closed} tailer(s), evicted ${dropped} session(s)`);
    return closed + dropped;
  };

  const timer = setInterval(() => {
    try {
      runOnce();
    } catch (err) {
      log(`reaper failed: ${(err as Error)?.message}`);
    }
  }, REAP_INTERVAL_MS);
  timer.unref?.();

  return { stop: () => clearInterval(timer), runOnce };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Last few lines of check output, for the model's failure summary. */
function tailOf(output: string, lines = 12): string {
  return output
    .split('\n')
    .filter(Boolean)
    .slice(-lines)
    .map((l) => `    ${l}`)
    .join('\n');
}

/** Accept a full id or the 8-character prefix the model is shown. */
function resolveTaskId(tasks: { id: string }[], candidate: string): string | null {
  if (!candidate) return null;
  const exact = tasks.find((t) => t.id === candidate);
  if (exact) return exact.id;
  const matches = tasks.filter((t) => t.id.startsWith(candidate));
  return matches.length === 1 ? matches[0]!.id : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function buildPlan(body: Record<string, unknown>, previous: Plan | null): Plan {
  const rawSteps = Array.isArray(body['steps']) ? body['steps'] : [];
  const steps: PlanStep[] = rawSteps
    .map((raw, i): PlanStep | null => {
      if (typeof raw === 'string') return { id: `s${i + 1}`, title: raw, status: 'pending' };
      if (raw && typeof raw === 'object') {
        const rec = raw as Record<string, unknown>;
        const title = typeof rec['title'] === 'string' ? rec['title'] : String(rec['step'] ?? '');
        if (!title) return null;
        return {
          id: typeof rec['id'] === 'string' ? rec['id'] : `s${i + 1}`,
          title,
          status: 'pending',
          ...(typeof rec['detail'] === 'string' ? { detail: rec['detail'] } : {}),
        };
      }
      return null;
    })
    .filter((s): s is PlanStep => s !== null);

  return {
    title: typeof body['title'] === 'string' && body['title'] ? body['title'] : (previous?.title ?? 'Plan'),
    ...(typeof body['summary'] === 'string' ? { summary: body['summary'] } : {}),
    ...(typeof body['markdown'] === 'string' ? { markdown: body['markdown'] } : {}),
    steps,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ *
 * Questions
 * ------------------------------------------------------------------ */

/** Caps taken from the CLI's own question UI: past these a choice stops
 *  being a choice. */
const MAX_OPTIONS = 6;
const MAX_QUESTIONS = 4;

/** The flat `options: string[]` form, kept because it is the cheapest thing
 *  the model can write and most questions need nothing more. */
function simpleOptions(body: Record<string, unknown>): string[] {
  const raw = Array.isArray(body['options']) ? (body['options'] as unknown[]) : [];
  return raw
    .map((o) => {
      if (typeof o === 'string') return o;
      if (o && typeof o === 'object') return String((o as Record<string, unknown>)['label'] ?? '');
      return '';
    })
    .filter((o) => o.trim())
    .slice(0, MAX_OPTIONS);
}

/**
 * Normalize whatever the model sent into the structured form the UI renders.
 *
 * Returns `undefined` for the plain `question` + `options: string[]` case so
 * the UI keeps its one-click fast path; anything richer — option
 * descriptions, multi-select, more than one question — becomes a `questions`
 * array the UI renders as a form.
 */
function normalizeQuestions(body: Record<string, unknown>, fallback: string): GateQuestion[] | undefined {
  const raw = Array.isArray(body['questions']) ? (body['questions'] as unknown[]) : null;

  if (!raw) {
    // A flat options list is only "structured" if an option carries a
    // description; otherwise the simple form renders it better.
    const opts = Array.isArray(body['options']) ? (body['options'] as unknown[]) : [];
    const rich = opts.some((o) => Boolean(o) && typeof o === 'object');
    const multi = body['multi_select'] === true || body['multiSelect'] === true;
    if (!rich && !multi) return undefined;
    return [
      {
        id: 'q1',
        question: fallback,
        ...(multi ? { multiSelect: true } : {}),
        options: toOptions(opts),
      },
    ];
  }

  const questions = raw
    .map((entry, i): GateQuestion | null => {
      if (typeof entry === 'string') return { id: `q${i + 1}`, question: entry, options: [] };
      if (!entry || typeof entry !== 'object') return null;
      const rec = entry as Record<string, unknown>;
      const question = String(rec['question'] ?? rec['text'] ?? '').trim();
      if (!question) return null;
      const header = String(rec['header'] ?? '').trim();
      const multi = rec['multiSelect'] === true || rec['multi_select'] === true;
      return {
        id: typeof rec['id'] === 'string' && rec['id'] ? rec['id'] : `q${i + 1}`,
        question,
        ...(header ? { header } : {}),
        ...(multi ? { multiSelect: true } : {}),
        options: toOptions(Array.isArray(rec['options']) ? (rec['options'] as unknown[]) : []),
      };
    })
    .filter((q): q is GateQuestion => q !== null)
    .slice(0, MAX_QUESTIONS);

  return questions.length ? questions : undefined;
}

function toOptions(raw: unknown[]): GateQuestion['options'] {
  return raw
    .map((o) => {
      if (typeof o === 'string') return { label: o };
      if (!o || typeof o !== 'object') return null;
      const rec = o as Record<string, unknown>;
      const label = String(rec['label'] ?? rec['value'] ?? rec['title'] ?? '').trim();
      if (!label) return null;
      const description = String(rec['description'] ?? rec['detail'] ?? '').trim();
      return { label, ...(description ? { description } : {}) };
    })
    .filter((o): o is { label: string; description?: string } => o !== null)
    .slice(0, MAX_OPTIONS);
}

/**
 * Collapse per-question answers into the single block of prose the model
 * reads.
 *
 * The rest of the pipeline — `renderGateResult`, and `recordDecision`, which
 * writes the answer onto the task that asked — only understands `comment`, so
 * a structured answer has to reduce to one here or it would be dropped.
 */
function composeAnswerComment(questions: GateQuestion[], answers: Record<string, string>): string {
  const lines: string[] = [];
  const many = questions.length > 1;
  for (const q of questions) {
    const answer = (answers[q.id] ?? '').trim();
    if (!answer) continue;
    lines.push(many ? `${q.header ? `[${q.header}] ` : ''}${q.question}\n→ ${answer}` : answer);
  }
  // An answer keyed to a question the gate no longer carries still counts.
  for (const [key, value] of Object.entries(answers)) {
    if (!questions.some((q) => q.id === key) && value.trim()) lines.push(value.trim());
  }
  return lines.join('\n\n');
}

/** Fill in ids, timestamps and the source excerpt the user selected. */
function hydrateThreads(store: SessionStore, sessionId: string, threads: ReviewThread[]): ReviewThread[] {
  const diff = store.getDiff(sessionId);
  const round = store.get(sessionId)?.reviewRound ?? 1;
  return threads.map((t) => {
    const file = diff?.files.find((f) => f.path === t.file);
    return {
      ...t,
      id: t.id || randomUUID(),
      createdAt: t.createdAt || Date.now(),
      resolved: t.resolved ?? false,
      round: t.round ?? round,
      excerpt: t.excerpt || (file ? excerptFor(file, t.side, t.startLine, t.endLine) : undefined),
    };
  });
}

function summarizeForModel(session: SessionState) {
  return {
    stage: session.stage,
    status: session.status,
    branch: session.branch,
    todos: session.todos,
    filesTouched: session.files.map((f) => f.path),
    openGate: session.gates.find((g) => g.status === 'open')?.id ?? null,
    pendingFeedback: session.pendingFeedback.length,
    unresolvedThreads: session.threads.filter((t) => !t.resolved).length,
  };
}

function describeStatus(session: SessionState, url: string): string {
  const done = session.todos.filter((t) => t.status === 'completed').length;
  const lines = [
    `[cc-harness] stage=${session.stage} status=${session.status} branch=${session.branch ?? 'n/a'}`,
    `todos: ${done}/${session.todos.length} complete · files touched: ${session.files.length}`,
  ];
  const gate = session.gates.find((g) => g.status === 'open');
  if (gate) lines.push(`OPEN GATE (${gate.kind}): ${gate.id} — the user has not responded yet.`);
  if (session.pendingFeedback.length) lines.push(`${session.pendingFeedback.length} unread comment(s).`);
  lines.push(`UI: ${url}`);
  return lines.join('\n');
}

void main();

export type { GateKind };
