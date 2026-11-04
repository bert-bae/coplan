/**
 * `coplan doctor` — verify the wiring, not the code.
 *
 * The hook contract belongs to the Claude Code CLI, and it has changed shape
 * before. Rather than trust the docs, this replays real hook payloads against
 * a live daemon and asserts the observable result, so a future CLI release
 * that moves a field produces a clear failure here instead of a plan that
 * silently never reaches the browser.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl, paths } from '../shared/paths.ts';
import type { DaemonLock, SessionState } from '../shared/types.ts';
import type { HookOutput } from '../shared/hooks.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const DAEMON_ENTRY = path.resolve(HERE, '..', 'daemon', 'main.js');

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  fatal?: boolean;
}

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail?: string, fatal = false) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}), fatal });
    const mark = ok ? '✓' : fatal ? '✗' : '!';
    console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
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
      // A hook file that forgets to name its agent registers its sessions as Claude's.
      const unnamed = agent ? events.filter((e) => !JSON.stringify(hooks.hooks?.[e]).includes(` ${agent}"`)) : [];
      record(
        `${file} registers the required events`,
        missing.length === 0 && unnamed.length === 0,
        missing.length ? `missing ${missing.join(', ')}` : unnamed.length ? `not marked ${agent}: ${unnamed.join(', ')}` : `${events.length} events`,
        true,
      );
    } catch (err) {
      record(`${file} parses`, false, (err as Error).message, true);
    }
  }

  const relay = path.join(PLUGIN_ROOT, 'bin/coplan-hook-relay.sh');
  if (existsSync(relay)) {
    try {
      const mode = (await import('node:fs')).statSync(relay).mode;
      record('coplan-hook-relay.sh is executable', (mode & 0o111) !== 0, `mode ${(mode & 0o777).toString(8)}`, true);
    } catch {
      record('coplan-hook-relay.sh is executable', false, undefined, true);
    }
  }

  /* ---------------- live daemon ---------------- */

  const lock = await ensureDaemon();
  if (!lock) {
    record('daemon reachable', false, `see ${paths.logFile()}`, true);
    return summarize(checks);
  }
  record('daemon reachable', true, baseUrl(lock));

  const sessionId = `doctor-${randomUUID()}`;
  const cwd = process.cwd();

  const hook = async (event: string, body: Record<string, unknown>): Promise<HookOutput> => {
    const res = await fetch(`${baseUrl(lock)}/hook/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}` },
      body: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: event, ...body }),
    });
    return (await res.json()) as HookOutput;
  };

  const mcp = async (tool: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const res = await fetch(`${baseUrl(lock)}/mcp/${tool}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${lock.token}`,
        'x-harness-session': sessionId,
      },
      body: JSON.stringify({ cwd, ...body }),
    });
    return (await res.json()) as Record<string, unknown>;
  };

  const getSession = async (): Promise<SessionState | null> => {
    const res = await fetch(`${baseUrl(lock)}/api/session/${sessionId}`, {
      headers: { authorization: `Bearer ${lock.token}` },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { session: SessionState }).session;
  };

  await hook('SessionStart', { start_reason: 'startup' });
  record('SessionStart registers the session', (await getSession()) !== null, sessionId, true);

  /* ---------------- the planning loop ---------------- */

  // Claude publishes, the user edits in the browser, Claude reads the edits
  // back. That round trip is the whole product, so it is what gets probed.
  const published = await mcp('publish', {
    title: 'doctor probe',
    summary: 'A plan written by `coplan doctor`.',
    diagrams: [{ title: 'Probe', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ source: 'a', target: 'b' }] }],
    tasks: [{ title: 'parent', subtasks: [{ title: 'child' }] }],
  });
  record('harness_plan_publish stores the plan', published['ok'] !== false, String(published['text'] ?? '').split('\n')[0], true);

  const afterPublish = await getSession();
  const plan = afterPublish?.plan;
  record(
    'the task tree keeps its nesting',
    plan?.tasks.length === 2 && plan.tasks.some((t) => t.parentId !== null),
    `${plan?.tasks.length ?? 0} task(s)`,
    true,
  );

  const childTask = plan?.tasks.find((t) => t.parentId !== null)?.id;
  const opsRes = await fetch(`${baseUrl(lock)}/api/session/${sessionId}/plan/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}` },
    body: JSON.stringify({
      ops: [
        { op: 'upsert_task', parentId: childTask ? plan?.tasks.find((t) => t.id === childTask)?.parentId : null, title: 'doctor probe task' },
        { op: 'comment', target: { kind: 'plan', id: '' }, text: 'doctor probe comment' },
      ],
    }),
  });
  record('edits from the browser are accepted', opsRes.ok, opsRes.ok ? undefined : await opsRes.text(), true);

  const notice = await withTimeout(hook('UserPromptSubmit', { prompt: 'doctor probe prompt' }), 10_000);
  const noticed = JSON.stringify(notice ?? {}).includes('harness_plan_read');
  record('the next chat message tells Claude the plan changed', noticed, noticed ? undefined : 'promptNotice may be off in config');

  const read = await mcp('read', {});
  const readText = String(read['text'] ?? '');
  record(
    'harness_plan_read reports what the user changed',
    readText.includes('doctor probe task') && readText.includes('doctor probe comment'),
    undefined,
    true,
  );

  const reread = await mcp('read', { changes_only: true });
  record(
    'reading moves Claude past the changes it has seen',
    String(reread['text'] ?? '').includes('has not changed the plan'),
    undefined,
    true,
  );

  const childId = plan?.tasks.find((t) => t.parentId !== null)?.id ?? '';
  const tracked = await mcp('task', { task_id: childId, status: 'done', note: 'probe' });
  const afterTrack = await getSession();
  record(
    'harness_task_update tracks progress',
    tracked['ok'] !== false && afterTrack?.plan?.tasks.find((t) => t.id === childId)?.status === 'done',
    undefined,
    true,
  );

  /* ---------------- waiting on the user ---------------- */

  // Questions are answered in Claude, so the harness only has to notice one
  // being asked, and notice it being answered.
  await hook('PreToolUse', {
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'doctor probe question?', header: 'Probe', options: [{ label: 'yes' }, { label: 'no' }] }] },
  });
  const asking = await getSession();
  record('a question Claude asks is noticed', asking?.waiting?.kind === 'question', asking?.waiting?.text, true);
  await hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: {} });
  const answered = await getSession();
  record('answering it in Claude clears it', answered?.waiting === null, undefined, true);

  /* ---------------- nothing waits ---------------- */

  const stopStarted = Date.now();
  const stopOut = await withTimeout(hook('Stop', { stop_hook_active: false }), 5_000);
  record(
    'the Stop hook never holds a turn',
    stopOut !== null && stopOut.decision !== 'block' && Date.now() - stopStarted < 3_000,
    stopOut?.decision === 'block' ? 'a turn would be blocked — this would affect every project' : undefined,
    true,
  );

  await hook('SessionEnd', { end_reason: 'other' });

  /* ---------------- Codex and Cursor ---------------- */

  // Their hooks reach the same daemon in their own formats; each must land
  // as a session of that agent, answered in a way that agent accepts.
  const agentHook = async (agent: string, event: string, body: Record<string, unknown>): Promise<unknown> => {
    const res = await fetch(`${baseUrl(lock)}/hook/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}`, 'x-harness-agent': agent },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  const sessionOf = async (id: string): Promise<SessionState | null> => {
    const res = await fetch(`${baseUrl(lock)}/api/session/${id}`, { headers: { authorization: `Bearer ${lock.token}` } });
    return res.ok ? ((await res.json()) as { session: SessionState }).session : null;
  };

  const thread = `doctor-codex-${randomUUID()}`;
  const codexOut = await agentHook('codex', 'SessionStart', { session_id: thread, cwd, hook_event_name: 'SessionStart', source: 'startup' });
  const codexSession = await sessionOf(thread);
  record(
    'a Codex session registers as Codex',
    codexSession?.agent === 'codex' && JSON.stringify(codexOut) === '{}',
    codexSession ? `link ${codexSession.link?.app ?? 'none'}` : 'not registered',
    true,
  );
  await agentHook('codex', 'SessionEnd', { session_id: thread, cwd, hook_event_name: 'SessionEnd', reason: 'other' });

  const chat = `doctor-cursor-${randomUUID()}`;
  const cursorBase = { conversation_id: chat, generation_id: 'doctor', workspace_roots: [cwd], cursor_version: 'doctor' };
  await agentHook('cursor', 'sessionStart', { ...cursorBase, hook_event_name: 'sessionStart', session_id: chat });
  const cursorOut = (await agentHook('cursor', 'beforeSubmitPrompt', { ...cursorBase, hook_event_name: 'beforeSubmitPrompt', prompt: 'doctor' })) as {
    continue?: boolean;
  };
  const cursorSession = await sessionOf(chat);
  record(
    'a Cursor chat registers as Cursor, from its own payload',
    cursorSession?.agent === 'cursor' && cursorSession.cwd === cwd && cursorOut.continue === true,
    cursorSession ? undefined : 'not registered',
    true,
  );
  await agentHook('cursor', 'sessionEnd', { ...cursorBase, hook_event_name: 'sessionEnd', reason: 'completed' });

  return summarize(checks);
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

