import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { unlinkSync, appendFileSync, existsSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionStore } from './store.ts';
import { HttpError, Router, json, text, readJson, serveStatic, type Ctx } from './http.ts';
import { ingestHook } from './hookIngest.ts';
import { hookAgent, readAgentHook, writeAgentOutput } from './agentHooks.ts';
import { agentInfo, parseAgent, type AgentKind } from '../shared/agents.ts';
import { MAX_NOTE, PlanError, cleanChecks, cleanNote, mergeChecks, planPhase, unreadAreas, validStage, validTarget } from '../shared/plan.ts';
import { PROMPT_BUDGET, buildPrompt, configRows, designPrompt, promptHash, renderGaps, renderPlan, renderTaskList, stageWords, unreadNotice } from './render.ts';
import { renderBrief, renderNext } from './brief.ts';
import { cleanSettings, dependents, effectiveReview, hasSubtasks, readyTasks, roundVerdict, stackStatus, waitingOn } from '../shared/build.ts';
import { HOOK_STAGES, hooksFor, loadProjectConfig, type ProjectConfig } from '../shared/project.ts';
import { cleanStorage, scanStorage, trimLog } from './housekeeping.ts';
import { ConfigCache, configStamp, type HarnessConfig } from '../shared/config.ts';
import { ensureHome, paths, readLiveLock, readLock, readVerifiedLock, probeLock, isPidAlive, baseUrl } from '../shared/paths.ts';
import { HOOK_NOOP, type HookOutput } from '../shared/hooks.ts';
import { openInBrowser } from './browser.ts';
import type { BuildSettings, CleanupGroupId, DaemonLock, Plan, PlanInput, PlanOp, ServerEvent, SessionState, TaskListInput, TaskStatus } from '../shared/types.ts';
import { CLEANUP_GROUPS } from '../shared/types.ts';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
/** The coplan CLI beside this build, for `coplan check` in what Claude is
 *  told. Absent from a bundle run outside the plugin. */
const COPLAN_BIN = (() => {
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'coplan');
  return existsSync(bin) ? bin : undefined;
})();

/** Session names the user types. */
const MAX_TITLE_LENGTH = 120;
/** Edits in one request. Generous; a real reorganization is a few dozen. */
const MAX_OPS = 200;

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? String(err)}`));
  ensureHome();

  // A lock whose daemon does not answer is left over from one that died;
  // its pid may belong to something else by now.
  const existing = await readVerifiedLock();
  if (existing && !process.argv.includes('--force')) {
    // Another daemon owns the lock; report it and exit, so "start" is
    // idempotent from hooks, the CLI and the MCP server.
    process.stdout.write(`${JSON.stringify({ alreadyRunning: true, ...existing })}\n`);
    process.exit(0);
  }

  const config = new ConfigCache(paths.configDir(), (message) => log(`config: ${message}`));
  const store = new SessionStore();
  store.on('event', (event: ServerEvent) => {
    if (event.type === 'persist-error') log(`could not save session ${event.sessionId}: ${event.message}`);
  });

  // A restart hands its successor the token and the port, so the browser tab
  // that asked for it reconnects by itself. Out of the environment at once.
  const inheritedToken = process.env['CC_HARNESS_TOKEN'];
  const inheritedPort = Number(process.env['CC_HARNESS_PORT'] ?? 0);
  delete process.env['CC_HARNESS_TOKEN'];
  const token = inheritedToken || randomBytes(24).toString('hex');

  const clients = { count: 0 };
  const server = http.createServer();
  const lifecycle = { restart: (_entry?: string): boolean => false };
  const router = buildRouter({ store, config, token, clients, lifecycle });

  server.on('request', (req, res) => {
    void handle(req, res, router, token).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) json(res, err.status, { error: err.message });
        else res.end();
        return;
      }
      log(`request error on ${req.method} ${req.url?.split('?')[0]}: ${(err as Error)?.stack ?? err}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  // Requests are small and local: anything slow to arrive is not a real
  // client. These bound receiving a request, not answering it, so the SSE
  // stream (received in an instant, answered for hours) is unaffected.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  const port = await listen(server, inheritedPort);
  boundPort = port;
  const lock: DaemonLock = { pid: process.pid, port, token, version: VERSION, startedAt: Date.now(), host: '127.0.0.1' };
  await claimLock(lock);
  // For the hook relay: the header as a file only this user can read.
  writeFileSync(paths.authHeader(), `Authorization: Bearer ${token}\n`, { mode: 0o600 });
  log(`listening on ${baseUrl(lock)} (pid ${process.pid}, v${VERSION})`);
  process.stdout.write(`${JSON.stringify({ started: true, ...lock })}\n`);

  let shuttingDown = false;
  const shutdown = (signal: string, respawn = false, entry?: string) => {
    if (shuttingDown) {
      log(`second signal (${signal}); exiting now`);
      process.exit(0);
    }
    shuttingDown = true;
    log(`shutting down (${signal})`);
    reaper.stop();
    lockWatch.stop();
    // A daemon that lost the lock leaves the sessions to the one that has
    // it: saving its own copies now would write over newer ones.
    if (signal !== LOST_LOCK) store.persistAll();
    server.close();
    server.closeAllConnections?.();
    try {
      if (readLiveLock()?.pid === process.pid) unlinkSync(paths.lockFile());
    } catch {
      /* ignore */
    }
    if (respawn) respawnDaemon(lock, entry);
    // Let the last responses flush.
    setTimeout(() => process.exit(0), 150).unref();
  };

  /** Replace this daemon with one running the build on disk now. */
  lifecycle.restart = (entry?: string) => {
    if (shuttingDown) return false;
    log('restart requested; handing over to a fresh daemon');
    setTimeout(() => shutdown('restart', true, entry), RESTART_DELAY_MS).unref();
    return true;
  };

  const reaper = startReaper(store);
  const lockWatch = watchLock(() => shutdown(LOST_LOCK));
  startIdleWatch(store, config, clients, () => shutdown('idle'));

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

/** The port this process listens on; the Origin check compares against it. */
let boundPort = 0;

/** Grace for the restart response to flush before the socket is torn down. */
const RESTART_DELAY_MS = 120;

/** How often a daemon checks the lock is still its own. */
const LOCK_WATCH_MS = 5_000;

/** How much a stalled live stream may hold unsent before it is dropped. */
const SSE_BUFFER_LIMIT = 1024 * 1024;
const LOST_LOCK = 'lost the lock';
/** How long a successor keeps trying to claim its predecessor's port. */
const PORT_CLAIM_MS = 5_000;
/** Sessions remembered as "already opened a browser tab for". */
const MAX_TRACKED_OPENS = 200;
/** Repositories whose config is held in memory. */
const MAX_PROJECT_CONFIGS = 50;

/** Why an MCP call found no session: the agent's hooks have not reported
 *  one, and what to do about it there. */
const HOOKS_HINT: Record<AgentKind, string> = {
  claude: "This usually means Coplan's hooks have not fired; run `coplan doctor` to check the plugin wiring.",
  codex:
    "Codex has not run Coplan's hooks: it holds a plugin's hooks until you approve them. Open /hooks in Codex, " +
    'trust the Coplan hooks, then start a new session. `coplan doctor` checks the rest of the wiring.',
  cursor:
    "Cursor has not run Coplan's hooks for this chat yet. Check that the Coplan plugin is enabled, send a message " +
    'in the chat so its hooks fire, then try again. `coplan doctor` checks the rest of the wiring.',
};

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

/**
 * A path that is a Coplan daemon build: `<plugin>/dist/daemon/main.js`,
 * where `<plugin>/package.json` is Coplan's. Anything else is refused, so
 * a restart can only ever run Coplan.
 */
function daemonEntry(raw: unknown): string | null {
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) return null;
  const entry = path.resolve(raw);
  if (path.basename(entry) !== 'main.js' || path.basename(path.dirname(entry)) !== 'daemon') return null;
  const dist = path.dirname(path.dirname(entry));
  if (path.basename(dist) !== 'dist' || !existsSync(entry)) return null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(dist), 'package.json'), 'utf8')) as { name?: unknown };
    return pkg.name === 'coplan' ? entry : null;
  } catch {
    return null;
  }
}

/** Start the replacement daemon, detached, from the bundle on disk. */
function respawnDaemon(lock: DaemonLock, from?: string): void {
  const entry = from ?? process.argv[1];
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

/**
 * Claim the lock atomically. It is written whole to a file of this
 * process's own and then linked into place, which fails if a lock is
 * already there — so no reader ever sees a half-written one, and of two
 * daemons starting at once exactly one claims it. A lock already there is
 * replaced only once its daemon has been shown gone (see probeLock).
 */
async function claimLock(lock: DaemonLock): Promise<void> {
  const file = paths.lockFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock, null, 2), { mode: 0o600 });
  // process.exit skips `finally`: the temporary copy, token and all, is
  // removed before any exit as well.
  const lose = (why: string): never => {
    rmSync(tmp, { force: true });
    log(why);
    process.exit(0);
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, file);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const other = readLock();
      if (other && other.pid !== lock.pid && isPidAlive(other.pid) && (await probeLock(other)) !== 'stale') {
        lose(`another daemon (pid ${other.pid}) holds the lock; exiting`);
      }
      // Left by a daemon that is gone. Removed only if it is still the same
      // stale lock. (Two daemons can still both get here; the one whose
      // claim is then removed notices — see watchLock — and steps down.)
      const again = readLock();
      if (!again || (again.pid === other?.pid && again.startedAt === other?.startedAt)) rmSync(file, { force: true });
    }
    lose('could not claim the lock; another daemon is starting; exiting');
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Step down if the lock is no longer this daemon's. Two daemons replacing
 * the same stale lock at the same moment can both believe they claimed it;
 * the one whose claim was overwritten finds out here and shuts down, before
 * its sessions drift apart from the other's.
 */
function watchLock(onLost: () => void): { stop(): void } {
  const timer = setInterval(() => {
    const now = readLock();
    if (now && now.pid !== process.pid) {
      log(`the lock now belongs to pid ${now.pid}; stepping down`);
      clearInterval(timer);
      onLost();
    }
  }, LOCK_WATCH_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendFileSync(paths.logFile(), line, { mode: 0o600 });
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

  // A browser always says where a write comes from. The token is never sent
  // by a browser on its own (no cookie), so a cross-site write could not
  // authenticate anyway; this refuses it outright, before that question.
  // Hooks, the MCP server and the CLI send no Origin.
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(origin)) {
    text(res, 403, 'cross-origin request refused');
    return;
  }

  if (url.pathname === '/health') {
    json(res, 200, { ok: true, version: VERSION, pid: process.pid });
    return;
  }

  // The page itself is code, not data: served to anyone on loopback. What it
  // shows comes from the API, which takes the token.
  const api = /^\/(api|mcp|hook)\//.test(url.pathname);
  if (!api && (req.method === 'GET' || req.method === 'HEAD')) {
    if (serveStatic(res, UI_DIR, url.pathname === '/' ? 'index.html' : url.pathname)) return;
    if (url.pathname === '/') {
      text(res, 500, 'UI bundle missing — run pnpm build');
      return;
    }
  }

  if (!authorized(req, url, token)) {
    text(res, 401, 'unauthorized');
    return;
  }

  const match = router.match(req.method ?? 'GET', url.pathname);
  if (!match) {
    text(res, 404, 'not found');
    return;
  }
  await match.handler({ req, res, url, params: match.params });
}

function sameOrigin(origin: string): boolean {
  try {
    const { protocol, hostname, port } = new URL(origin);
    const own = String(boundPort);
    return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost') && port === own;
  } catch {
    return false;
  }
}

/**
 * Who may call the API: whoever holds the token, sent as a bearer header —
 * hooks, the MCP server, the CLI, and the page, which is handed it in its
 * link. Never a cookie: a cookie is not scoped to a port, so every other
 * server on 127.0.0.1 the browser visits would be sent it. The live stream,
 * which a browser cannot send headers on, takes a single-use ticket instead.
 */
function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ') && sameSecret(header.slice(7), token)) return true;
  if (req.method === 'GET' && url.pathname === '/api/events') return redeemTicket(url.searchParams.get('ticket'));
  return false;
}

/** Compared in constant time, so the answer's timing says nothing of it. */
function sameSecret(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Tickets for the live stream: short-lived, each good once. */
const tickets = new Map<string, number>();
const TICKET_MS = 60_000;

function issueTicket(): string {
  const now = Date.now();
  for (const [t, expires] of tickets) if (expires < now) tickets.delete(t);
  const ticket = randomBytes(18).toString('hex');
  tickets.set(ticket, now + TICKET_MS);
  return ticket;
}

function redeemTicket(ticket: string | null): boolean {
  if (!ticket) return false;
  const expires = tickets.get(ticket);
  tickets.delete(ticket);
  return expires !== undefined && expires >= Date.now();
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

interface Deps {
  store: SessionStore;
  config: ConfigCache;
  token: string;
  /** Live SSE connections, so an open browser counts as "in use". */
  clients: { count: number };
  lifecycle: { restart(entry?: string): boolean };
}

function buildRouter(deps: Deps): Router {
  const { store, config, token, clients, lifecycle } = deps;
  const router = new Router();

  /** For the browser and the CLI: carries the token, which the page keeps
   *  (`src/ui/lib/api.ts`) and takes out of the address bar. */
  const authedUrl = (sessionId?: string) => {
    const base = `http://127.0.0.1:${readLiveLock()?.port ?? 0}/?token=${token}`;
    return sessionId ? `${base}#/session/${encodeURIComponent(sessionId)}` : base;
  };

  /** For Claude. Token-free: anything returned to the model is written to the
   *  transcript and carried in every later context window. */
  const uiUrl = (sessionId: string) => `http://127.0.0.1:${readLiveLock()?.port ?? 0}/#/session/${encodeURIComponent(sessionId)}`;

  const opened = new Set<string>();
  const revealUi = (session: SessionState) => {
    if (!configFor(session).autoOpen || opened.has(session.sessionId)) return;
    opened.add(session.sessionId);
    if (opened.size > MAX_TRACKED_OPENS) opened.delete(opened.values().next().value!);
    openInBrowser(authedUrl(session.sessionId));
  };

  const configFor = (session: SessionState): HarnessConfig => config.get(session.repoRoot ?? session.cwd);

  /** The repository's `.coplan/config.json` over the user's own layer. Read
   *  again as soon as any file it came from changes — an edit counts at
   *  once — and otherwise kept: a stat per file, not a read and a parse of
   *  every one, on each call. */
  const projects = new Map<string, { stamp: string; config: ProjectConfig }>();
  const projectFor = (session: SessionState): ProjectConfig => {
    const root = session.repoRoot ?? session.cwd;
    const hit = projects.get(root);
    if (hit && hit.config.sources && configStamp(hit.config.sources) === hit.stamp) return hit.config;
    const started = Date.now();
    const config = loadProjectConfig(root);
    if (projects.size >= MAX_PROJECT_CONFIGS) projects.clear();
    // A file saved while it was being read may have been read half old: if
    // any changed since the load began, nothing is kept, and the next call
    // reads it again.
    const sources = config.sources ?? [];
    const settled = !sources.some((f) => {
      try {
        return statSync(f).mtimeMs >= started - 1;
      } catch {
        return false;
      }
    });
    if (settled) projects.set(root, { stamp: configStamp(sources), config });
    else projects.delete(root);
    return config;
  };

  /** Settings as the page sent them, over the repository's defaults. */
  const settingsFrom = (raw: unknown, project: ProjectConfig): BuildSettings =>
    raw && typeof raw === 'object' ? cleanSettings(raw, project.settings) : project.settings;

  /** What the review dialogs show beside the prompt: the defaults and the
   *  checks this repository has, so the user sees what the build will run. */
  const projectSummary = (project: ProjectConfig, point: 'design' | 'build') => ({
    file: project.file,
    config: configRows(project, point),
    defaults: project.settings,
    checks: Object.fromEntries(HOOK_STAGES.map((stage) => [stage, project.hooks[stage].map((h) => h.name)])),
    errors: [...project.errors, ...project.warnings],
    planCheck: project.planCheck,
  });

  const residentIds = (): string[] => store.all().map((s) => s.sessionId);

  const sessionOr404 = (ctx: Ctx): SessionState | null => {
    const session = store.get(ctx.params['id'] ?? '');
    if (!session) json(ctx.res, 404, { error: 'unknown session' });
    return session ?? null;
  };

  /* --------------------------- UI bootstrap ------------------------ */

  /** A ticket for the live stream, which a browser opens without headers. */
  router.post('/api/events/ticket', (ctx) => json(ctx.res, 200, { ticket: issueTicket() }));

  /* --------------------------- Sessions ---------------------------- */

  router.get('/api/sessions', (ctx) => json(ctx.res, 200, { sessions: store.summaries(), version: VERSION }));

  router.get('/api/session/:id', (ctx) => {
    const session = sessionOr404(ctx);
    if (session) json(ctx.res, 200, { session: forBrowser(session) });
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
    const ops = Array.isArray(body.ops) ? body.ops : [];
    if (ops.length > MAX_OPS) throw new HttpError(400, `At most ${MAX_OPS} edits per request.`);
    try {
      const { plan, changes } = store.applyOps(session.sessionId, ops, 'user');
      json(ctx.res, 200, { plan: forBrowser(plan), changes });
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
    text(ctx.res, 200, renderPlan(session.plan, { url: uiUrl(session.sessionId), planCheck: projectFor(session).planCheck }));
  });

  /**
   * The prompt Claude would be given if the plan were submitted now — for
   * the user to read before they do. Changes nothing.
   */
  router.post('/api/session/:id/plan/prompt', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ note?: unknown; target?: unknown; settings?: unknown }>(ctx.req);
    if (!session.plan) {
      json(ctx.res, 404, { error: 'no plan yet' });
      return;
    }
    const target = validTarget(body.target) ?? 'session';
    const note = cleanNote(body.note);
    const project = projectFor(session);
    const settings = settingsFrom(body.settings, project);
    const { prompt, trimmed, blocks } = buildPrompt(session.plan, { target, agent: session.agent, settings, project, ...(COPLAN_BIN ? { bin: COPLAN_BIN } : {}), ...(note ? { note } : {}) });
    json(ctx.res, 200, {
      prompt,
      hash: promptHash(prompt),
      trimmed,
      blocks,
      version: session.plan.version,
      budget: PROMPT_BUDGET,
      maxNote: MAX_NOTE,
      settings,
      project: projectSummary(project, 'build'),
    });
  });

  /** The prompt the agent would be given if the design were confirmed now. */
  router.post('/api/session/:id/plan/design/prompt', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ note?: unknown }>(ctx.req);
    if (!session.plan) {
      json(ctx.res, 404, { error: 'no plan yet' });
      return;
    }
    const note = cleanNote(body.note);
    const project = projectFor(session);
    const { prompt, trimmed, blocks } = designPrompt(session.plan, { agent: session.agent, project, ...(COPLAN_BIN ? { bin: COPLAN_BIN } : {}), ...(note ? { note } : {}) });
    json(ctx.res, 200, {
      prompt,
      hash: promptHash(prompt),
      trimmed,
      blocks,
      version: session.plan.version,
      budget: PROMPT_BUDGET,
      maxNote: MAX_NOTE,
      project: projectSummary(project, 'design'),
    });
  });

  /**
   * The user confirms the design. It is locked from here, and the agent gets
   * the ask for a task list with their next message in its chat (or, in
   * Cursor, when they paste it or its next harness_plan_read).
   */
  router.post('/api/session/:id/plan/design/confirm', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ note?: unknown; expect?: unknown; hash?: unknown }>(ctx.req);
    const note = cleanNote(body.note);
    try {
      const plan = store.confirmDesign(session.sessionId, {
        project: projectFor(session),
        ...(COPLAN_BIN ? { bin: COPLAN_BIN } : {}),
        ...(note ? { note } : {}),
        ...(typeof body.expect === 'number' ? { expect: body.expect } : {}),
        ...(typeof body.hash === 'string' ? { hash: body.hash } : {}),
      });
      log(`design confirmed for ${session.sessionId}`);
      json(ctx.res, 200, { plan: forBrowser(plan) });
    } catch (err) {
      if (err instanceof PlanError) json(ctx.res, 409, { error: err.message });
      else throw err;
    }
  });

  /** Unlock a confirmed design. */
  router.post('/api/session/:id/plan/design/reopen', (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    try {
      json(ctx.res, 200, { plan: forBrowser(store.reopenDesign(session.sessionId)) });
    } catch (err) {
      if (err instanceof PlanError) json(ctx.res, 409, { error: err.message });
      else throw err;
    }
  });

  /**
   * The user signs the plan off. It is locked from here: Claude gets the
   * prompt they previewed with their next message in its chat, and the page
   * follows the build on the task board.
   */
  router.post('/api/session/:id/plan/submit', async (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    const body = await readJson<{ note?: unknown; target?: unknown; expect?: unknown; settings?: unknown; hash?: unknown }>(ctx.req);
    const target = validTarget(body.target);
    if (!target) throw new HttpError(400, 'Say who builds it: "session" or "elsewhere".');
    const note = cleanNote(body.note);
    const project = projectFor(session);
    try {
      const plan = store.submit(session.sessionId, {
        target,
        project,
        settings: settingsFrom(body.settings, project),
        ...(COPLAN_BIN ? { bin: COPLAN_BIN } : {}),
        ...(note ? { note } : {}),
        ...(typeof body.expect === 'number' ? { expect: body.expect } : {}),
        ...(typeof body.hash === 'string' ? { hash: body.hash } : {}),
      });
      log(`plan submitted for ${session.sessionId} (${target})`);
      json(ctx.res, 200, { plan: forBrowser(plan) });
    } catch (err) {
      if (err instanceof PlanError) json(ctx.res, 409, { error: err.message });
      else throw err;
    }
  });

  /** Unlock a submitted plan, so it can be changed again. */
  router.post('/api/session/:id/plan/reopen', (ctx) => {
    const session = sessionOr404(ctx);
    if (!session) return;
    try {
      json(ctx.res, 200, { plan: forBrowser(store.reopen(session.sessionId)) });
    } catch (err) {
      if (err instanceof PlanError) json(ctx.res, 409, { error: err.message });
      else throw err;
    }
  });

  /* --------------------------- Maintenance ------------------------- */

  router.get('/api/storage', (ctx) => {
    json(ctx.res, 200, { report: scanStorage({ liveSessionIds: residentIds() }) });
  });

  router.post('/api/storage/clean', async (ctx) => {
    const body = await readJson<{ groups?: CleanupGroupId[]; dryRun?: boolean }>(ctx.req);
    // Named, every time: no groups would mean all of them — session history
    // included — and that is never a default.
    const known = new Set<string>(CLEANUP_GROUPS);
    if (!Array.isArray(body.groups) || !body.groups.length || body.groups.some((g) => !known.has(g))) {
      throw new HttpError(400, `Name the groups to clean: ${[...known].join(', ')}.`);
    }
    const result = cleanStorage({
      liveSessionIds: residentIds(),
      groups: body.groups,
      ...(body.dryRun ? { dryRun: true } : {}),
    });
    if (!result.dryRun && result.removed) log(`housekeeping removed ${result.removed} item(s), ${result.freedBytes} bytes`);
    json(ctx.res, 200, { result, report: scanStorage({ liveSessionIds: residentIds() }) });
  });

  /**
   * Restart — from `entry` when the caller names its own build. The Claude
   * Code, Codex and Cursor installs share one daemon: restarting from the
   * plugin that was just updated must run that plugin's code, not this
   * daemon's older copy.
   */
  router.post('/api/daemon/restart', async (ctx) => {
    const body = await readJson<{ entry?: unknown }>(ctx.req);
    const entry = body.entry === undefined ? undefined : daemonEntry(body.entry);
    if (body.entry !== undefined && !entry) throw new HttpError(400, '`entry` is not a Coplan daemon build (…/dist/daemon/main.js).');
    const started = lifecycle.restart(entry ?? undefined);
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

    const send = (event: ServerEvent) => {
      // A tab that stopped reading (a laptop asleep with the socket open)
      // would buffer a whole plan per edit without end. Past a megabyte it
      // is let go: it opens the stream again, and a snapshot catches it up.
      if (res.writableLength > SSE_BUFFER_LIMIT) {
        res.destroy();
        return;
      }
      res.write(`data: ${JSON.stringify(forBrowser(event))}\n\n`);
    };
    send({ type: 'sessions', sessions: store.summaries() });
    const focus = ctx.url.searchParams.get('session');
    const focused = focus ? store.get(focus) : undefined;
    if (focused) send({ type: 'snapshot', session: focused });

    // Only the session this page shows. The page reconnects with a new
    // `session` when the user switches, so nothing it needs is filtered out,
    // and a busy session elsewhere no longer streams its whole plan to every
    // open tab on each keystroke.
    const listener = (event: ServerEvent) => {
      if (event.type === 'snapshot' && event.session.sessionId !== focus) return;
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
    const raw = ctx.params['event'] ?? '';
    const header = (name: string) => {
      const value = ctx.req.headers[name];
      return typeof value === 'string' ? value : null;
    };
    // The relay says which agent the hook came from; Claude Code when it
    // does not (an older relay, or the doctor).
    let agent = parseAgent(header('x-harness-agent'));
    let output: HookOutput = HOOK_NOOP;
    // A prompt this hook hands over, so it can be taken back if the answer
    // never reaches the agent.
    let handed: { id: string; prior: Plan; version: number } | null = null;
    // Listened for from the start: the relay may give up while the hook is
    // still being handled, and a 'close' already past cannot be heard later.
    const takeBack = () => {
      if (!handed || ctx.res.writableFinished) return;
      const { id, prior, version } = handed;
      handed = null;
      if (store.undeliver(id, prior, version)) log(`prompt for ${id} did not reach the agent; kept to deliver again`);
    };
    ctx.res.once('close', takeBack);
    try {
      const body = await readJson<Record<string, unknown>>(ctx.req);
      agent = hookAgent(agent, body);
      const { event, input } = readAgentHook(agent, raw, body);
      const session = typeof input.session_id === 'string' ? store.get(input.session_id) : undefined;
      const prior = session?.plan && store.pending(session.sessionId) ? session.plan : null;
      if (event) {
        output = await ingestHook(event, input, {
          store,
          agent,
          config: session ? configFor(session) : config.get(),
          env: agent !== 'claude' ? {} : {
            remoteSessionId: header('x-harness-remote-session'),
            remoteSdkUrl: header('x-harness-remote-sdk'),
            bridgeSessionId: header('x-harness-bridge-session'),
            entrypoint: header('x-harness-entrypoint'),
          },
          onWaiting: openClaude,
        });
      }
      const after = session ? store.get(session.sessionId)?.plan : undefined;
      if (prior && after && !store.pending(session!.sessionId)) handed = { id: session!.sessionId, prior, version: after.version };
    } catch (err) {
      // A hook must never break the session it is attached to.
      log(`hook ${agent}/${raw} failed: ${(err as Error)?.message}`);
      output = HOOK_NOOP;
    }
    // The relay gave up (its curl timed out) or the connection dropped before
    // the answer was out: the agent never got the prompt. Taken back, so the
    // next hook — or harness_plan_read — hands it over.
    if (ctx.res.destroyed || ctx.req.socket.destroyed) takeBack();
    if (!ctx.res.writableEnded) json(ctx.res, 200, writeAgentOutput(agent, raw, output));
  });

  /* --------------------------- MCP bridge -------------------------- */

  const resolveSession = (ctx: Ctx, body: { sessionId?: string; cwd?: string; pid?: number }) => {
    const headerId = ctx.req.headers['x-harness-session'];
    const id = body.sessionId ?? (typeof headerId === 'string' && headerId ? headerId : undefined);
    const agentHeader = ctx.req.headers['x-harness-agent'];
    const agent = parseAgent(typeof agentHeader === 'string' ? agentHeader : undefined);
    let session: SessionState | null = null;
    if (id) session = store.ensure(id, body.cwd, agent);
    else if (agent === 'claude') {
      // One `claude` process is one session, so its pid names it.
      if (body.pid) session = store.findByPid(body.pid) ?? null;
      if (!session && body.cwd) session = store.findByCwd(body.cwd, agent) ?? null;
    } else {
      // One Cursor process serves every chat in every window, and one Codex
      // app every thread: the folder says more than the pid. In that folder,
      // the chat that was active last is the one calling.
      if (body.cwd) session = store.findByCwd(body.cwd, agent) ?? null;
      if (!session && body.pid) session = store.findByPid(body.pid, agent) ?? null;
    }
    // A server that names the wrong agent — Cursor running the Claude Code
    // plugin's config — still finds the chat in its folder.
    if (!session && body.cwd) session = store.findByCwd(body.cwd) ?? null;
    if (!session) return null;
    if (body.pid && session.claudePid !== body.pid) store.update(session.sessionId, { claudePid: body.pid });
    return session;
  };

  /**
   * `harness_task_update`: a status, a step of the iric cycle, the checks
   * run — answered with what it means for the build. Two moves are refused,
   * because the board would then say something untrue: starting a task that
   * still waits on another, and finishing one whose checks last failed.
   */
  const updateTask = (session: SessionState, body: Record<string, unknown>): string => {
    const before = session.plan;
    const taskId = String(body['task_id'] ?? '');
    if (!before) throw new PlanError(`No task "${taskId}": there is no plan yet. Publish one with harness_plan_publish.`);
    const task = before.tasks.find((t) => t.id === taskId);
    if (!task) throw new PlanError(`No task "${taskId}".`);
    const status = typeof body['status'] === 'string' && body['status'] ? (body['status'] as TaskStatus) : undefined;
    const stage = typeof body['stage'] === 'string' && body['stage'] ? body['stage'] : undefined;
    if (stage !== undefined && !validStage(stage)) throw new PlanError(`"${stage}" is not a stage: implement, review or refine.`);
    // Every check reported must be whole: a malformed one dropped quietly
    // would erase the failure it was meant to report.
    const rawChecks = body['checks'];
    const cleaned = rawChecks === undefined ? undefined : cleanChecks(rawChecks);
    if (rawChecks !== undefined && (!cleaned || cleaned.length !== Math.min((rawChecks as unknown[]).length, 40))) {
      throw new PlanError('`checks` is a list of {name, ok, note?}, with `ok` true or false.');
    }
    const checks = cleaned?.length ? cleaned : undefined;
    const note = typeof body['note'] === 'string' ? body['note'] : undefined;
    const verdict = body['verdict'] === undefined ? undefined : body['verdict'] === 'pass' || body['verdict'] === 'changes' ? (body['verdict'] as 'pass' | 'changes') : null;
    if (verdict === null) throw new PlanError('`verdict` is "pass" or "changes".');
    const summary = typeof body['summary'] === 'string' ? body['summary'] : undefined;
    // A verdict is the outcome of a review, so it is given while the task is in
    // one — not from refine, after it asked for changes, to close the round.
    if (verdict && !(task.status === 'in_progress' && task.stage === 'review') && stage !== 'review') {
      throw new PlanError(`A verdict is given in review: "${task.title}" is not in review now. Report stage "review" (a new round) and give the verdict there.`);
    }
    if (!status && !stage && !checks && !verdict && note === undefined) throw new PlanError('Say what changed: a status, a stage, checks, a verdict or a note.');
    const approved = body['user_approved'] === true;
    if (approved && !note?.trim()) {
      throw new PlanError('`user_approved` needs a `note` saying what the user told you in chat.');
    }
    // Dropping work is a decision someone will want the reason for.
    if (status === 'dropped' && !note?.trim()) {
      throw new PlanError(`Dropping "${task.title}" needs a \`note\`: why it is no longer needed (and who said so).`);
    }
    // Work the user signed off is theirs to drop: the agent asks.
    if (status === 'dropped' && before.submission && !task.addedInBuild && !approved) {
      throw new PlanError(
        `"${task.title}" is part of the plan the user submitted, so dropping it is theirs to decide: ask them with ` +
          `${agentInfo(session.agent).askWith}. If they agree, call again with user_approved: true and their words in the note.`,
      );
    }
    const project = projectFor(session);
    const settings = before.submission?.settings ?? project.settings;

    // A parent's progress is its subtasks': a status set on it would say
    // something the board never shows.
    if ((status || stage || checks) && hasSubtasks(before, task.id)) {
      throw new PlanError(
        `"${task.title}" has subtasks, so its progress is theirs: report on each subtask instead (harness_task_next lists them).`,
      );
    }

    // Starting includes resuming a task that was blocked before it began.
    // Picking a dropped task back up is starting it, with every check that brings.
    const idle = task.status === 'todo' || task.status === 'blocked' || task.status === 'dropped';
    const starting = idle && (status === 'in_progress' || (stage !== undefined && status !== 'done' && status !== 'blocked'));
    const waits = waitingOn(before, task);
    const waitWords = () => waits.map((t) => `${t.id} "${t.title}" (${t.status.replace('_', ' ')})`).join(', ');
    if ((starting || status === 'done') && waits.length) {
      throw new PlanError(
        `"${task.title}" cannot ${status === 'done' ? 'be done' : 'start'} yet: it waits on ${waitWords()}. ` +
          'Start a task that is ready instead — harness_task_next lists them. If the dependency is wrong, change it with ' +
          'harness_plan_edit {ops: [{op: "upsert_task", id, dependsOn: [...]}]} and tell the user why.',
      );
    }
    if (starting && !approved) {
      const busy = before.tasks.filter((t) => t.status === 'in_progress' && t.id !== task.id && !hasSubtasks(before, t.id));
      if (busy.length >= settings.parallel) {
        throw new PlanError(
          `"${task.title}" cannot start yet: ${busy.length} task(s) are in progress (${busy.map((t) => t.id).join(', ')}), ` +
            `and the user allowed ${settings.parallel} at once. Finish one first.`,
        );
      }
    }

    // The round limit is the user's: past it, stop and ask them.
    if (stage === 'review' && task.stage !== 'review' && (task.round ?? 0) >= settings.maxRounds && !approved) {
      throw new PlanError(
        `"${task.title}" has had ${task.round} review round(s), the most the user allowed (${settings.maxRounds}). Stop: mark it ` +
          'blocked with a note on what still fails, and ask the user — another round, accept it as it is, or take it over. ' +
          'If they say to go on, call again with user_approved: true and their answer in the note.',
      );
    }

    if (status === 'done' && !approved) {
      // Done means the cycle ran: it went to review at least once, …
      if (!task.round) {
        throw new PlanError(
          `"${task.title}" has not been reviewed: take it through its cycle first — stage "review" (every review mode, ` +
            '"skip" included, reports one), then done once it passes.',
        );
      }
      // … and every check that gates it passed when it was last run.
      const optional = new Set(HOOK_STAGES.flatMap((st) => project.hooks[st].filter((h) => h.optional).map((h) => h.name)));
      const latest = mergeChecks(task.checks, checks ?? []);
      const failing = latest.filter((c) => !c.ok && !optional.has(c.name));
      const missing = hooksFor(project, 'review', task.files)
        .filter((h) => !h.optional && !latest.some((c) => c.name === h.name))
        .map((h) => h.name);
      if (failing.length || missing.length) {
        throw new PlanError(
          `"${task.title}" is not done: ` +
            [
              failing.length ? `its last checks failed (${failing.map((c) => `${c.name}${c.note ? `: ${c.note}` : ''}`).join('; ')})` : '',
              missing.length ? `the review checks ${missing.join(', ')} were never reported` : '',
            ]
              .filter(Boolean)
              .join(', and ') +
            '. Run them, refine until they pass, and report them with `checks`. If a failure has nothing to do with this ' +
            'task, mark it blocked with a note saying so and ask the user; if they accept it as it is, call again with ' +
            'user_approved: true and their answer in the note.',
        );
      }
      // … and its last review round passed — by whoever the user said reviews it.
      const mode = effectiveReview(before, task, settings.review);
      if (mode !== 'skip') {
        // The verdict in this call, if any, is the round's latest — and only
        // counts for a task the user reviews when it is theirs, which on
        // this path (not user_approved) it is not.
        const last = verdict ? (mode === 'user' ? roundVerdict(task, mode) : { verdict }) : roundVerdict(task, mode);
        const passed = last?.verdict === 'pass';
        if (!passed) {
          throw new PlanError(
            mode === 'user'
              ? `"${task.title}" is the user's to review, and they have not passed it: show them the change and ask with ` +
                  `${agentInfo(session.agent).askWith}. They can approve it on the board in Coplan; if they approve it in chat, call ` +
                  'again with verdict "pass", user_approved: true and their words in the note.'
              : `"${task.title}" has no passing verdict for review round ${task.round}: report the review's outcome — ` +
                  'verdict "pass" (with this call is fine), or "changes" and refine.',
          );
        }
      }
    }

    const readyBefore = new Set(readyTasks(before).map((t) => t.id));
    const progress: PlanOp = {
      op: 'upsert_task',
      id: taskId,
      ...(status ? { status } : {}),
      ...(stage ? { stage: stage as NonNullable<ReturnType<typeof validStage>> } : {}),
      ...(checks ? { checks } : {}),
      ...(note !== undefined ? { note: approved ? `${note} (approved by the user)` : note } : {}),
    };
    const review: PlanOp[] = verdict
      ? [{ op: 'review_task', id: taskId, verdict, ...(summary ? { summary } : {}), ...(approved ? { userApproved: true } : {}) }]
      : [];
    // The verdict belongs to the review the task is in: given with a move
    // into review, after it; otherwise before the rest (done ends the review).
    const { plan, changes } = store.applyOps(session.sessionId, stage ? [progress, ...review] : [...review, progress], 'claude', {
      tracking: true,
    });
    const now = plan.tasks.find((t) => t.id === taskId)!;
    const out: string[] = [];
    const state = now.status === 'in_progress' && now.stage ? stageWords(now) : now.status.replace('_', ' ');
    out.push(`[cc-harness] "${now.title}" is ${state}.${changes.length ? '' : ' (It already was.)'}`);
    if (starting && !plan.submission) {
      out.push('The plan has not been submitted: build only if the user told you to start without submitting.');
    }
    if (checks?.length) {
      const failed = checks.filter((c) => !c.ok);
      out.push(failed.length ? `Checks: ${failed.length} failed (${failed.map((c) => c.name).join(', ')}) — refine before review passes.` : `Checks: all ${checks.length} passed.`);
    }
    if (now.stage === 'review' && stage === 'review') {
      if ((now.round ?? 0) >= settings.maxRounds) {
        out.push(`This is review round ${now.round} of the ${settings.maxRounds} the user allowed: if it does not pass, stop and ask the user.`);
      }
      if (effectiveReview(plan, now, settings.review) === 'user') {
        out.push(`This task's review is the user's: show them the change and ask with ${agentInfo(session.agent).askWith} before marking it done.`);
      }
    }
    // The tasks that wait on this one: what dropping or reopening it means
    // for them is worth saying out loud.
    const waiting = dependents(plan, now);
    if (status === 'dropped' && changes.length && waiting.length) {
      out.push(
        `${waiting.map((t) => `${t.id} "${t.title}"`).join(', ')} waited on it and no longer do${waiting.length === 1 ? 'es' : ''}: ` +
          'check they do not need its work, and tell the user.',
      );
    }
    if (task.status === 'done' && status && status !== 'done' && status !== 'dropped') {
      const built = waiting.filter((t) => t.status !== 'todo');
      if (built.length) {
        out.push(
          `${built.map((t) => `${t.id} "${t.title}" (${t.status.replace('_', ' ')})`).join(', ')} already went ahead on this task's work: ` +
            'check they still hold once it changes.',
        );
      }
    }
    if ((status === 'done' || status === 'dropped') && changes.length) {
      if (planPhase(plan) === 'finalizing' || planPhase(plan) === 'built') {
        out.push('That was the last task. Finish the build — final checks, pull requests, then the report; harness_task_next says how.');
      } else {
        const fresh = readyTasks(plan).filter((t) => !readyBefore.has(t.id));
        if (fresh.length) out.push(`Now ready: ${fresh.map((t) => `${t.id} "${t.title}"`).join(', ')}.`);
        const ready = readyTasks(plan);
        if (!fresh.length && ready.length) out.push(`Ready to start: ${ready.slice(0, 6).map((t) => t.id).join(', ')}${ready.length > 6 ? ', …' : ''}.`);
        if (!ready.length) out.push('Nothing else is ready yet — harness_task_next says what the rest wait on.');
      }
    }
    const areas = unreadAreas(plan);
    if (areas.length) out.push(`The user has changed ${areas.join(', ')} since you last read the plan — call harness_plan_read.`);
    return out.join(' ');
  };

  router.post('/mcp/:tool', async (ctx) => {
    const body = await readJson<Record<string, unknown>>(ctx.req);
    const session = resolveSession(ctx, body as { sessionId?: string; cwd?: string; pid?: number });
    if (!session) {
      const agentHeader = ctx.req.headers['x-harness-agent'];
      json(ctx.res, 200, {
        ok: false,
        text: `[cc-harness] No session is registered yet. ${HOOKS_HINT[parseAgent(typeof agentHeader === 'string' ? agentHeader : undefined)]}`,
      });
      return;
    }
    const id = session.sessionId;
    // An agent calling Coplan's tools is using Coplan, however it got there.
    store.engage(id);
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
              `${agentInfo(session.agent).askWith}, here in chat. Nothing in Coplan waits for them: when they say they ` +
              'have reviewed it, call harness_plan_read.\n\n' +
              renderPlan(plan, { url, planCheck: projectFor(session).planCheck }),
          );
          return;
        }

        case 'read': {
          if (!session.plan) {
            reply(true, `[cc-harness] No plan yet. Publish one with harness_plan_publish. UI: ${url}`);
            return;
          }
          // A peek is a look, not a read: an auditing subagent sees the plan
          // as it stands, and the user's changes stay unread — and the
          // sign-off undelivered — for the agent that has to act on them.
          if (body['peek'] === true) {
            reply(
              true,
              '[cc-harness] A peek: the user\'s changes below stay unread, for your next harness_plan_read.\n\n' +
                renderPlan(session.plan, { url, changesOnly: body['changes_only'] === true, planCheck: projectFor(session).planCheck }),
            );
            return;
          }
          // A sign-off not yet handed over comes with the first read after
          // it: the ask for a task list once the design is confirmed, the
          // build prompt once the plan is submitted. That is how Cursor gets
          // it (no hook can add it to the user's message), and how any agent
          // gets one whose hook did not get through. Delivering it counts as
          // the read — except for edits made after the design was confirmed,
          // which are not in its prompt and stay unread.
          const handed = store.deliver(id);
          if (handed) {
            const later = store.get(id)?.plan;
            const notice = later ? unreadNotice(later) : null;
            reply(true, notice ? `${handed.prompt}\n\n${notice}` : handed.prompt);
            return;
          }
          const textOut = renderPlan(session.plan, { url, changesOnly: body['changes_only'] === true, planCheck: projectFor(session).planCheck });
          store.markRead(id);
          reply(true, textOut);
          return;
        }

        case 'edit': {
          const ops = Array.isArray(body['ops']) ? (body['ops'] as PlanOp[]) : [];
          // All or nothing: a batch that cannot be applied whole is refused.
          if (ops.length > MAX_OPS) throw new PlanError(`At most ${MAX_OPS} edits per call; split the change.`);
          const project = projectFor(session);
          for (const op of ops) if (op && op.op === 'report') refuseUnfinishedFinal(op.checks, project);
          const { plan, changes } = store.applyOps(id, ops, 'claude');
          const notice = unreadNotice(plan);
          reply(
            true,
            (changes.length
              ? `[cc-harness] Applied ${changes.length} change(s):\n${changes.map((c) => `- ${c.summary} [${c.target.kind} ${c.target.id}]`.replace(' ]', ']')).join('\n')}`
              : '[cc-harness] Nothing changed — every edit matched what was already there.') + (notice ? `\n\n${notice}` : ''),
          );
          return;
        }

        case 'propose': {
          const proposal = { op: 'propose', title: body['title'], reason: body['reason'], ops: body['ops'] } as unknown as PlanOp;
          const { plan } = store.applyOps(id, [proposal], 'claude');
          const p = plan.proposals!.at(-1)!;
          revealUi(session);
          reply(
            true,
            `[cc-harness] Proposed ${p.id} "${p.title}" (${p.ops.length} edit${p.ops.length === 1 ? '' : 's'}). Nothing has changed yet: ` +
              `the user sees it in Coplan (${url}) beside what it changes, with Accept and Reject. Tell them in chat what you propose and why. ` +
              'You hear their answer the next time you read the plan (harness_plan_read); until then, work from the plan as it is. ' +
              `Take it back with harness_plan_edit {ops: [{op: "withdraw_proposal", id: "${p.id}"}]}.`,
          );
          return;
        }

        case 'tasks': {
          const { plan } = store.publishTasks(id, { tasks: body['tasks'] } as unknown as TaskListInput);
          revealUi(session);
          const phase = planPhase(plan);
          reply(
            true,
            `[cc-harness] Published the task list for "${plan.title}". The user reviews it at ${url}\n` +
              (phase === 'tasking'
                ? 'Tell them in chat that the task list is ready to review, and ask anything you need decided with ' +
                  `${agentInfo(session.agent).askWith}. Do not start building: they submit the plan from Coplan when the tasks are right, ` +
                  (agentInfo(session.agent).promptContext
                    ? 'and the build prompt comes with their next message.\n\n'
                    : 'and paste the build prompt here (or ask you to build, and harness_plan_read hands it to you).\n\n')
                : 'Tell them in chat that the tasks are updated.\n\n') +
              renderTaskList(plan, projectFor(session).branches.base) +
              // What the list leaves open, while it is still cheap to fix.
              ((gaps) => (gaps.length ? `\n\n${gaps.join('\n')}\n\nFix these, or say why in chat, before they review it.` : ''))(renderGaps(plan, 20, projectFor(session).planCheck)),
          );
          return;
        }

        case 'branch': {
          if (!session.plan) {
            reply(true, `[cc-harness] No plan yet. Publish one with harness_plan_publish. UI: ${url}`);
            return;
          }
          const has = (k: string) => body[k] !== undefined && body[k] !== null && body[k] !== '';
          if (has('pr_url') || has('pr_number')) {
            if (!has('pr_state') && !session.plan.branches?.[String(body['branch'] ?? '')]?.pr) {
              throw new PlanError('Say where the pull request stands: pr_state draft, open, merged or closed.');
            }
          }
          const pr =
            has('pr_state') || has('pr_url') || has('pr_number')
              ? {
                  state: String(body['pr_state'] ?? session.plan.branches?.[String(body['branch'] ?? '')]?.pr?.state ?? ''),
                  ...(has('pr_url') ? { url: String(body['pr_url']) } : {}),
                  ...(typeof body['pr_number'] === 'number' ? { number: body['pr_number'] } : {}),
                }
              : undefined;
          if (!pr && !has('base')) throw new PlanError('Say what changed: the pull request (pr_url, pr_number, pr_state) or its base.');
          const { plan } = store.applyOps(
            id,
            [{ op: 'set_branch', branch: String(body['branch'] ?? ''), ...(pr ? { pr } : {}), ...(has('base') ? { base: String(body['base']) } : {}) }],
            'claude',
            { tracking: true },
          );
          const stack = stackStatus(plan, projectFor(session).branches.base);
          const now = stack.find((s) => s.branch === String(body['branch']));
          const restacks = stack.filter((s) => s.restack).map((s) => `- ${s.restack}`);
          reply(
            true,
            `[cc-harness] Recorded \`${now?.branch ?? body['branch']}\`${now?.state?.pr ? `: pull request${now.state.pr.number ? ` #${now.state.pr.number}` : ''} ${now.state.pr.state}` : ''}${now?.state?.base ? `, onto \`${now.state.base}\`` : ''}.` +
              (restacks.length ? `\n\nThe stack moved:\n${restacks.join('\n')}` : ''),
          );
          return;
        }

        case 'check': {
          if (!session.plan) {
            reply(true, `[cc-harness] No plan yet. Publish one with harness_plan_publish. UI: ${url}`);
            return;
          }
          const gaps = renderGaps(session.plan, Infinity, projectFor(session).planCheck);
          reply(
            true,
            gaps.length
              ? `[cc-harness] ${gaps.join('\n')}\n\nFix each with harness_plan_edit, or tell the user in chat why it stays.`
              : '[cc-harness] No gaps: every box is built by a task and described, every task builds a box, and nothing is waiting on an answer.',
          );
          return;
        }

        case 'next': {
          if (!session.plan) {
            reply(true, `[cc-harness] No plan yet. Publish one with harness_plan_publish. UI: ${url}`);
            return;
          }
          reply(true, renderNext(session.plan, { agent: session.agent, project: projectFor(session), ...(COPLAN_BIN ? { bin: COPLAN_BIN } : {}) }));
          return;
        }

        case 'brief': {
          const plan = session.plan;
          if (!plan) throw new PlanError('No plan yet. Publish one with harness_plan_publish.');
          const taskId = String(body['task_id'] ?? '');
          const task = plan.tasks.find((t) => t.id === taskId);
          if (!task) throw new PlanError(`No task "${taskId}". harness_task_next lists the tasks that are ready.`);
          reply(true, renderBrief(plan, task, { agent: session.agent, project: projectFor(session), ...(COPLAN_BIN ? { bin: COPLAN_BIN } : {}) }));
          return;
        }

        case 'task': {
          reply(true, updateTask(session, body));
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
 * Where the repository says the final checks hold the report
 * (`final.blocking`), a report must carry each required one, passing: the
 * plan is not built while the checks that say so fail.
 */
function refuseUnfinishedFinal(checks: unknown, project: ProjectConfig): void {
  if (!project.final.blocking) return;
  const required = project.hooks.final.filter((h) => !h.optional).map((h) => h.name);
  if (!required.length) return;
  const reported = new Map(
    (Array.isArray(checks) ? checks : [])
      .filter((c): c is { name: string; ok: unknown } => Boolean(c) && typeof (c as { name?: unknown }).name === 'string')
      .map((c) => [c.name, c.ok === true]),
  );
  const missing = required.filter((n) => !reported.has(n));
  const failing = required.filter((n) => reported.get(n) === false);
  if (!missing.length && !failing.length) return;
  throw new PlanError(
    'This repository holds the build report until its final checks pass (final.blocking in .coplan/config.json). ' +
      [failing.length ? `Failing: ${failing.join(', ')}.` : '', missing.length ? `Not reported in \`checks\`: ${missing.join(', ')}.` : ''].filter(Boolean).join(' ') +
      ' Fix what fails and run them again, or ask the user how to finish.',
  );
}

/**
 * Exit once nothing is using the daemon: no browser open and no session
 * active recently. The next hook starts a fresh one. The setting is read
 * each minute, so changing `idleShutdownMinutes` needs no restart.
 */
function startIdleWatch(store: SessionStore, config: ConfigCache, clients: { count: number }, stop: () => void): void {
  const timer = setInterval(() => {
    const minutes = config.get().idleShutdownMinutes;
    if (!minutes || minutes <= 0) return;
    const idleMs = minutes * 60_000;
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
      // The log is appended to for the daemon's whole life: past its limit,
      // its newest part is kept and the rest let go.
      const freed = trimLog();
      if (freed) log(`trimmed the log by ${freed} bytes`);
    } catch (err) {
      log(`reaper failed: ${(err as Error)?.message}`);
    }
  }, REAP_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// A daemon that fails to start is spawned with no terminal: the log is the
// only place the reason can go.
main().catch((err: unknown) => {
  log(`failed to start: ${(err as Error)?.stack ?? String(err)}`);
  process.exit(1);
});

/**
 * What Claude last read is kept beside the plan so "since you last read" can
 * be a true difference, but the page has no use for it — leave it out rather
 * than send every plan twice on every save.
 */
function forBrowser<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if ('claudeBaseline' in value) {
    const { claudeBaseline: _omit, ...plan } = value as Record<string, unknown>;
    return plan as T;
  }
  if ('plan' in value && (value as { plan: unknown }).plan) {
    return { ...value, plan: forBrowser((value as { plan: unknown }).plan) } as T;
  }
  if ('session' in value && (value as { session: unknown }).session) {
    return { ...value, session: forBrowser((value as { session: unknown }).session) } as T;
  }
  return value;
}
