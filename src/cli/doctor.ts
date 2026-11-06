/**
 * `coplan doctor` — verify the wiring, not the code.
 *
 * The hook contract belongs to the Claude Code CLI, and it has changed shape
 * before. Rather than trust the docs, this replays real hook payloads against
 * a live daemon — one of them through the real relay script, as an agent
 * sends it — and asserts the observable result, so a future CLI release that
 * moves a field produces a clear failure here instead of a plan that silently
 * never reaches the browser.
 *
 * Every probe stands alone: one that throws is reported as failed and the
 * rest still run. The sessions the probes make are deleted at the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl, paths } from '../shared/paths.ts';
import { loadConfigReport } from '../shared/config.ts';
import { loadProjectConfig, PROJECT_CONFIG_PATH } from '../shared/project.ts';
import { repoRootOf } from './check.ts';
import type { DaemonLock, SessionState } from '../shared/types.ts';
import type { HookOutput } from '../shared/hooks.ts';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const DAEMON_ENTRY = path.resolve(HERE, '..', 'daemon', 'main.js');
const RELAY = path.join(PLUGIN_ROOT, 'bin', 'coplan-hook-relay.sh');
/** What the plugin needs (`engines` in package.json). */
const MIN_NODE: [number, number] = [20, 11];

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  fatal?: boolean;
}

type Record_ = (name: string, ok: boolean, detail?: string, fatal?: boolean) => void;

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];
  const record: Record_ = (name, ok, detail, fatal = false) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}), fatal });
    const mark = ok ? '✓' : fatal ? '✗' : '!';
    console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  /** One probe: whatever it throws is its failure, not the doctor's. */
  const probe = async (name: string, run: () => Promise<void> | void) => {
    try {
      await run();
    } catch (err) {
      record(name, false, (err as Error).message, true);
    }
  };

  console.log('coplan doctor\n');

  /* ---------------- static wiring ---------------- */

  for (const file of [
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    '.mcp.json',
    '.codex-plugin/plugin.json',
    'hooks/codex.json',
    'mcp/codex.json',
    '.cursor-plugin/plugin.json',
    'hooks/cursor.json',
    'mcp/cursor.json',
    'dist/daemon/main.js',
    'dist/mcp/main.js',
    'dist/ui/index.html',
    'dist/ui/app.js',
    'bin/coplan',
    'bin/coplan-hook-relay.sh',
    'skills/coplan/SKILL.md',
    'skills/coplan-build/SKILL.md',
    'skills/iric/SKILL.md',
  ]) {
    const full = path.join(PLUGIN_ROOT, file);
    record(`present: ${file}`, existsSync(full), existsSync(full) ? undefined : full, true);
  }

  // Each agent's hook file, in that agent's own event names.
  for (const [file, required, agent] of [
    ['hooks/hooks.json', ['SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit'], null],
    ['hooks/codex.json', ['SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit'], 'codex'],
    ['hooks/cursor.json', ['sessionStart', 'sessionEnd', 'stop', 'beforeSubmitPrompt'], 'cursor'],
  ] as const) {
    try {
      const hooks = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, file), 'utf8')) as { hooks?: Record<string, unknown[]> };
      const events = Object.keys(hooks.hooks ?? {});
      const missing = required.filter((e) => !events.includes(e));
      // A hook file that forgets to name its agent registers its sessions as
      // Claude's — and one that names another agent, as that agent's.
      const unnamed = events.filter((e) => relayCalls(hooks.hooks?.[e]).some((call) => call.agent !== (agent ?? 'claude')));
      record(
        `${file} registers the required events`,
        missing.length === 0 && unnamed.length === 0,
        missing.length ? `missing ${missing.join(', ')}` : unnamed.length ? `not marked ${agent ?? 'claude'}: ${unnamed.join(', ')}` : `${events.length} events`,
        true,
      );
    } catch (err) {
      record(`${file} parses`, false, (err as Error).message, true);
    }
  }

  if (existsSync(RELAY)) {
    try {
      const mode = statSync(RELAY).mode;
      record('coplan-hook-relay.sh is executable', (mode & 0o111) !== 0, `mode ${(mode & 0o777).toString(8)}`, true);
    } catch {
      record('coplan-hook-relay.sh is executable', false, undefined, true);
    }
  }

  /* ---------------- this machine ---------------- */

  checkEnvironment(record);

  /* ---------------- configuration ---------------- */

  const cwd = process.cwd();
  const root = await repoRootOf(cwd);
  const harness = loadConfigReport({ configDir: paths.configDir(), projectDir: root });
  record('the Coplan config reads cleanly', harness.errors.length === 0, harness.errors.length ? undefined : harness.files.filter(existsSync).join(', ') || 'defaults');
  for (const e of harness.errors) console.log(`    ${e}`);
  const project = loadProjectConfig(root);
  record(
    `${PROJECT_CONFIG_PATH} reads cleanly`,
    project.errors.length === 0,
    project.file ? (project.errors.length ? undefined : project.file) : 'none in this repository',
  );
  for (const e of [...project.errors, ...project.warnings]) console.log(`    ${e}`);

  /* ---------------- live daemon ---------------- */

  const lock = await ensureDaemon();
  if (!lock) {
    record('daemon reachable', false, `see ${paths.logFile()}`, true);
    return summarize(checks);
  }
  record('daemon reachable', true, baseUrl(lock));

  const http = client(lock);
  const made = new Set<string>();
  try {
    await liveProbes(http, lock, cwd, made, record, probe);
  } finally {
    // The probes' sessions are not the user's: they go, wherever the doctor stopped.
    for (const id of made) await http.purge(id).catch(() => undefined);
  }
  return summarize(checks);
}

async function liveProbes(
  http: Client,
  lock: DaemonLock,
  cwd: string,
  made: Set<string>,
  record: Record_,
  probe: (name: string, run: () => Promise<void> | void) => Promise<void>,
): Promise<void> {
  await probe('the daemon is the one the lock names, and this version', async () => {
    const health = (await http.get('/health', false)) as { version?: string; pid?: number };
    if (health.pid !== lock.pid) {
      record('the daemon is the one the lock names', false, `the lock says pid ${lock.pid}, the daemon on its port is ${health.pid}: run coplan restart`, true);
      return;
    }
    record(
      'the daemon runs this version',
      health.version === VERSION,
      health.version === VERSION ? VERSION : `the daemon is ${health.version}, this plugin ${VERSION}: run coplan restart (or /coplan-restart)`,
    );
  });

  const sessionId = `doctor-${randomUUID()}`;
  made.add(sessionId);
  const hook = (event: string, body: Record<string, unknown>) =>
    http.post(`/hook/${event}`, { session_id: sessionId, cwd, hook_event_name: event, ...body }) as Promise<HookOutput>;
  const mcp = (tool: string, body: Record<string, unknown> = {}) =>
    http.post(`/mcp/${tool}`, { cwd, ...body }, { 'x-harness-session': sessionId }) as Promise<Record<string, unknown>>;
  const getSession = () => http.session(sessionId);

  /* ---------------- the relay, as an agent runs it ---------------- */

  await probe('a hook through the relay script reaches the daemon', async () => {
    const id = `doctor-relay-${randomUUID()}`;
    made.add(id);
    const run = spawnSync(RELAY, ['SessionStart'], {
      input: JSON.stringify({ session_id: id, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (run.error) throw run.error;
    const registered = (await http.session(id)) !== null;
    record(
      'a hook through the relay script reaches the daemon',
      registered,
      registered ? undefined : `the relay exited ${run.status} and the session never arrived${run.stdout ? `: ${run.stdout.slice(0, 200)}` : ''}`,
      true,
    );
  });

  await probe('SessionStart registers the session', async () => {
    await hook('SessionStart', { start_reason: 'startup' });
    record('SessionStart registers the session', (await getSession()) !== null, sessionId, true);
  });

  /* ---------------- the planning loop ---------------- */

  // Claude publishes, the user edits in the browser, Claude reads the edits
  // back. That round trip is the whole product, so it is what gets probed.
  let plan: SessionState['plan'] | undefined;
  await probe('harness_plan_publish stores the plan', async () => {
    const published = await mcp('publish', {
      title: 'doctor probe',
      summary: 'A plan written by `coplan doctor`.',
      diagrams: [{ title: 'Probe', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ source: 'a', target: 'b' }] }],
      tasks: [{ title: 'parent', subtasks: [{ title: 'child' }] }],
    });
    record('harness_plan_publish stores the plan', published['ok'] !== false, String(published['text'] ?? '').split('\n')[0], true);
    plan = (await getSession())?.plan;
    record('the task tree keeps its nesting', plan?.tasks.length === 2 && plan.tasks.some((t) => t.parentId !== null), `${plan?.tasks.length ?? 0} task(s)`, true);
  });

  const childId = plan?.tasks.find((t) => t.parentId !== null)?.id ?? '';

  await probe('edits from the browser are accepted', async () => {
    await http.post(`/api/session/${sessionId}/plan/ops`, {
      ops: [
        { op: 'upsert_task', parentId: plan?.tasks.find((t) => t.id === childId)?.parentId ?? null, title: 'doctor probe task' },
        { op: 'comment', target: { kind: 'plan', id: '' }, text: 'doctor probe comment' },
      ],
    });
    record('edits from the browser are accepted', true, undefined, true);
  });

  await probe('the next chat message tells Claude the plan changed', async () => {
    const notice = await withTimeout(hook('UserPromptSubmit', { prompt: 'doctor probe prompt' }), 10_000);
    const noticed = JSON.stringify(notice ?? {}).includes('harness_plan_read');
    record('the next chat message tells Claude the plan changed', noticed, noticed ? undefined : 'promptNotice may be off in config');
  });

  await probe('harness_plan_read reports what the user changed', async () => {
    const readText = String((await mcp('read', {}))['text'] ?? '');
    record('harness_plan_read reports what the user changed', readText.includes('doctor probe task') && readText.includes('doctor probe comment'), undefined, true);
    const reread = await mcp('read', { changes_only: true });
    record('reading moves Claude past the changes it has seen', String(reread['text'] ?? '').includes('has not changed the plan'), undefined, true);
  });

  await probe('harness_task_update tracks progress', async () => {
    // Through the cycle, as the build does: done is refused before a review.
    // The probe runs none of the repository's checks, so it finishes the way
    // a task the user accepted as it is does — which works whatever this
    // repository's .coplan/config.json requires.
    const reviewed = await mcp('task', { task_id: childId, stage: 'review' });
    const tracked = await mcp('task', { task_id: childId, status: 'done', user_approved: true, note: 'doctor probe' });
    const afterTrack = await getSession();
    record(
      'harness_task_update tracks progress',
      reviewed['ok'] !== false && tracked['ok'] !== false && afterTrack?.plan?.tasks.find((t) => t.id === childId)?.status === 'done',
      reviewed['ok'] === false ? String(reviewed['text'] ?? '') : tracked['ok'] === false ? String(tracked['text'] ?? '') : undefined,
      true,
    );
  });

  /* ---------------- waiting on the user ---------------- */

  // Questions are answered in Claude, so the harness only has to notice one
  // being asked, and notice it being answered.
  await probe('a question Claude asks is noticed', async () => {
    await hook('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'doctor probe question?', header: 'Probe', options: [{ label: 'yes' }, { label: 'no' }] }] },
    });
    const asking = await getSession();
    record('a question Claude asks is noticed', asking?.waiting?.kind === 'question', asking?.waiting?.text, true);
    await hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: {} });
    record('answering it in Claude clears it', (await getSession())?.waiting === null, undefined, true);
  });

  /* ---------------- nothing waits ---------------- */

  await probe('the Stop hook never holds a turn', async () => {
    const stopStarted = Date.now();
    const stopOut = await withTimeout(hook('Stop', { stop_hook_active: false }), 5_000);
    record(
      'the Stop hook never holds a turn',
      stopOut !== null && stopOut.decision !== 'block' && Date.now() - stopStarted < 3_000,
      stopOut?.decision === 'block' ? 'a turn would be blocked — this would affect every project' : undefined,
      true,
    );
    await hook('SessionEnd', { end_reason: 'other' });
  });

  /* ---------------- Codex and Cursor ---------------- */

  // Their hooks reach the same daemon in their own formats; each must land
  // as a session of that agent, answered in a way that agent accepts.
  const agentHook = (agent: string, event: string, body: Record<string, unknown>) => http.post(`/hook/${event}`, body, { 'x-harness-agent': agent });

  await probe('a Codex session registers as Codex', async () => {
    const thread = `doctor-codex-${randomUUID()}`;
    made.add(thread);
    const codexOut = await agentHook('codex', 'SessionStart', { session_id: thread, cwd, hook_event_name: 'SessionStart', source: 'startup' });
    const codexSession = await http.session(thread);
    record(
      'a Codex session registers as Codex',
      codexSession?.agent === 'codex' && JSON.stringify(codexOut) === '{}',
      codexSession ? `link ${codexSession.link?.app ?? 'none'}` : 'not registered',
      true,
    );
    await agentHook('codex', 'SessionEnd', { session_id: thread, cwd, hook_event_name: 'SessionEnd', reason: 'other' });
  });

  await probe('a Cursor chat registers as Cursor, from its own payload', async () => {
    const chat = `doctor-cursor-${randomUUID()}`;
    made.add(chat);
    const cursorBase = { conversation_id: chat, generation_id: 'doctor', workspace_roots: [cwd], cursor_version: 'doctor' };
    await agentHook('cursor', 'sessionStart', { ...cursorBase, hook_event_name: 'sessionStart', session_id: chat });
    const cursorOut = (await agentHook('cursor', 'beforeSubmitPrompt', { ...cursorBase, hook_event_name: 'beforeSubmitPrompt', prompt: 'doctor' })) as { continue?: boolean };
    const cursorSession = await http.session(chat);
    record(
      'a Cursor chat registers as Cursor, from its own payload',
      cursorSession?.agent === 'cursor' && cursorSession.cwd === cwd && cursorOut.continue === true,
      cursorSession ? undefined : 'not registered',
      true,
    );
    await agentHook('cursor', 'sessionEnd', { ...cursorBase, hook_event_name: 'sessionEnd', reason: 'completed' });
  });
}

/** What the hooks and the daemon need from this machine, beyond the plugin. */
function checkEnvironment(record: Record_): void {
  const atLeast = (version: string) => {
    const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
    return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  };
  const want = `${MIN_NODE[0]}.${MIN_NODE[1]}`;
  record(`Node ${want} or later runs the doctor`, atLeast(process.version), process.version, true);
  // The hooks start the daemon with whichever `node` is first on the PATH,
  // which need not be the one running this.
  const pathNode = spawnSync('node', ['--version'], { encoding: 'utf8' });
  const pathVersion = pathNode.error ? null : pathNode.stdout.trim();
  record(
    `the node on PATH is ${want} or later`,
    pathVersion !== null && atLeast(pathVersion),
    pathVersion ?? 'no node on PATH: the hooks cannot start the daemon',
    true,
  );
  const curl = spawnSync('curl', ['--version'], { encoding: 'utf8' });
  record(
    'curl is installed',
    !curl.error && curl.status === 0,
    curl.error ? 'missing: every hook would do nothing, silently' : curl.stdout.split('\n')[0]?.split(' ').slice(0, 2).join(' '),
    true,
  );
  const home = process.env['CC_HARNESS_HOME'];
  record(
    'one Coplan home for every agent',
    true,
    home
      ? `CC_HARNESS_HOME is ${home}. Cursor's MCP server cannot see it and uses ~/.claude/cc-harness: set it for every agent, or none, or the agents talk to two daemons`
      : `${paths.home()} (CC_HARNESS_HOME unset)`,
  );
}

interface Client {
  get(route: string, auth?: boolean): Promise<unknown>;
  post(route: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
  session(id: string): Promise<SessionState | null>;
  purge(id: string): Promise<void>;
}

/** The daemon's API, answering with JSON or throwing a message that says
 *  what came back instead: a 401, an error page, a dropped connection. */
function client(lock: DaemonLock): Client {
  const call = async (route: string, init: RequestInit = {}, auth = true): Promise<unknown> => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (auth) headers['authorization'] = `Bearer ${lock.token}`;
    const res = await fetch(`${baseUrl(lock)}${route}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${route} answered ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${route} answered with something that is not JSON: ${text.slice(0, 200)}`);
    }
  };
  return {
    get: (route, auth = true) => call(route, {}, auth),
    post: (route, body, headers = {}) =>
      call(route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    session: async (id) => {
      try {
        return ((await call(`/api/session/${encodeURIComponent(id)}`)) as { session: SessionState }).session;
      } catch {
        return null;
      }
    },
    purge: async (id) => {
      await call(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}

/**
 * Every relay call in one event's hook entries, with the agent it names.
 * Claude Code passes the relay its arguments as `args`; Codex and Cursor
 * put them in the command string. Either way the agent is the argument
 * after the event, and Claude Code when there is none.
 */
export function relayCalls(entries: unknown): { event: string; agent: string }[] {
  const out: { event: string; agent: string }[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const rec = node as { command?: unknown; args?: unknown; hooks?: unknown };
    if (typeof rec.command === 'string' && rec.command.includes('coplan-hook-relay.sh')) {
      const words = Array.isArray(rec.args)
        ? rec.args.map(String)
        : rec.command.slice(rec.command.indexOf('coplan-hook-relay.sh') + 'coplan-hook-relay.sh'.length).replace(/^"/, '').trim().split(/\s+/);
      out.push({ event: words[0] ?? '', agent: words[1] ?? 'claude' });
    }
    visit(rec.hooks);
  };
  visit(entries);
  return out;
}

function summarize(checks: Check[]): number {
  const failed = checks.filter((c) => !c.ok);
  const fatal = failed.filter((c) => c.fatal);
  console.log('');
  if (failed.length === 0) {
    console.log(`all ${checks.length} checks passed`);
    return 0;
  }
  console.log(`${failed.length} of ${checks.length} checks failed (${fatal.length} fatal)`);
  return fatal.length > 0 ? 1 : 0;
}

async function ensureDaemon(): Promise<DaemonLock | null> {
  const existing = readLiveLock();
  if (existing) return existing;
  const child = spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: 'ignore', env: process.env });
  // An unhandled child `'error'` event would crash the doctor before it could
  // report why the daemon failed to start.
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const lock = readLiveLock();
    if (lock) return lock;
  }
  return null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
