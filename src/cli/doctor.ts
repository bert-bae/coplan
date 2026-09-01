/**
 * `harness doctor` — verify the wiring, not the code.
 *
 * The hook contract belongs to the Claude Code CLI, and it has changed shape
 * before. Rather than trust the docs, this replays real hook payloads against
 * a live daemon and asserts the observable result, so a future CLI release
 * that moves a field produces a clear failure here instead of a gate that
 * silently never fires.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl, paths } from '../shared/paths.ts';
import type { DaemonLock, Gate, SessionState } from '../shared/types.ts';
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

  console.log('cc-harness doctor\n');

  /* ---------------- static wiring ---------------- */

  for (const file of [
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    '.mcp.json',
    'dist/daemon/main.js',
    'dist/mcp/main.js',
    'dist/ui/index.html',
    'dist/ui/app.js',
    'bin/hook-relay.sh',
  ]) {
    const full = path.join(PLUGIN_ROOT, file);
    record(`present: ${file}`, existsSync(full), existsSync(full) ? undefined : full, true);
  }

  try {
    const hooks = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')) as {
      hooks?: Record<string, unknown[]>;
    };
    const events = Object.keys(hooks.hooks ?? {});
    const required = ['SessionStart', 'PostToolUse', 'Stop', 'UserPromptSubmit'];
    const missing = required.filter((e) => !events.includes(e));
    record('hooks.json registers the required events', missing.length === 0, missing.join(', ') || `${events.length} events`, true);
  } catch (err) {
    record('hooks.json parses', false, (err as Error).message, true);
  }

  const relay = path.join(PLUGIN_ROOT, 'bin/hook-relay.sh');
  if (existsSync(relay)) {
    try {
      const mode = (await import('node:fs')).statSync(relay).mode;
      record('hook-relay.sh is executable', (mode & 0o111) !== 0, `mode ${(mode & 0o777).toString(8)}`, true);
    } catch {
      record('hook-relay.sh is executable', false, undefined, true);
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

  await hook('PostToolUse', {
    tool_name: 'TodoWrite',
    tool_input: {
      todos: [
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'in_progress' },
      ],
    },
  });
  const afterTodos = await getSession();
  record('PostToolUse(TodoWrite) captures the checklist', afterTodos?.todos.length === 2, `${afterTodos?.todos.length ?? 0} todos`);

  await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'example.ts') } });
  const afterEdit = await getSession();
  record('PostToolUse(Edit) records the touched file', (afterEdit?.files.length ?? 0) > 0, afterEdit?.files[0]?.path);

  /* ---------------- the gate loop ---------------- */

  const plan = await mcp('plan', {
    title: 'doctor probe',
    steps: [{ title: 'step one' }, { title: 'step two' }],
  });
  const gateId = String(plan['gateId'] ?? '');
  record('harness_publish_plan opens a gate', Boolean(gateId), gateId, true);

  if (gateId) {
    // End a turn on the open gate, resolve it from "the UI", and assert that
    // the verdict comes back on the next message. These two are the single
    // most important behaviour in the whole harness: the session is allowed to
    // stop, and nothing the user said is lost when it does.
    const stopOut = await withTimeout(hook('Stop', { stop_hook_active: false }), 10_000);
    const held = stopOut?.decision === 'block' || stopOut?.hookSpecificOutput?.decision === 'block';
    const ended = stopOut !== null && !held;
    record(
      'an open gate ends the turn instead of holding it',
      ended,
      ended
        ? undefined
        : held
          ? 'the turn was blocked — the session cannot stop at a gate'
          : 'the Stop hook never answered',
      true,
    );

    await fetch(`${baseUrl(lock)}/api/session/${sessionId}/gate/${gateId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}` },
      body: JSON.stringify({ verdict: 'changes_requested', comment: 'doctor probe feedback' }),
    });

    const resumed = await withTimeout(hook('UserPromptSubmit', { prompt: 'doctor probe prompt' }), 10_000);
    const carries = JSON.stringify(resumed ?? {}).includes('doctor probe feedback');
    record('the verdict reaches Claude with the next message', carries, carries ? undefined : 'feedback text missing', true);
  }

  /* ---------------- async injection ---------------- */

  await fetch(`${baseUrl(lock)}/api/session/${sessionId}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}` },
    body: JSON.stringify({ text: 'doctor async comment', origin: 'timeline' }),
  });
  const stopAfterFeedback = await withTimeout(hook('Stop', { stop_hook_active: false }), 10_000);
  const asyncDelivered = JSON.stringify(stopAfterFeedback ?? {}).includes('doctor async comment');
  record('queued comments are delivered at the next turn boundary', asyncDelivered, undefined, true);

  /* ---------------- non-harness sessions ---------------- */

  const idleSession = `doctor-idle-${randomUUID()}`;
  const idleRes = await fetch(`${baseUrl(lock)}/hook/Stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}` },
    body: JSON.stringify({ session_id: idleSession, cwd, stop_hook_active: false }),
  });
  const idleOut = (await idleRes.json()) as HookOutput;
  record(
    'sessions with no open gate are not held up',
    idleOut.decision !== 'block',
    idleOut.decision === 'block' ? 'a plain session would be blocked — this would affect every project' : undefined,
    true,
  );

  /* ---------------- task board ---------------- */

  const board = await mcp('tasks', { tasks: [{ title: 'doctor probe task' }] });
  const boardOk = String(board['text'] ?? '').includes('1 task(s) on the board');
  record('the task board accepts tasks', boardOk, boardOk ? undefined : String(board['text']).slice(0, 120));

  const created = (board['tasks'] as { id: string }[] | undefined) ?? [];
  const probeTask = created[0]?.id;
  if (probeTask) {
    await mcp('task_update', { task_id: probeTask, status: 'in_progress' });
    const afterStart = await getSession();
    record(
      'claiming a task moves the session to implementing',
      afterStart?.stage === 'implementing',
      afterStart?.stage,
    );

    const refused = await mcp('task_update', { task_id: probeTask, status: 'done' });
    record(
      'completing a task requires a record of what changed',
      refused['ok'] === false,
      refused['ok'] === false ? undefined : 'a task closed with no note',
    );

    const blocked = await mcp('task_block', { task_id: probeTask, question: 'doctor probe question?' });
    const blockGate = String(blocked['gateId'] ?? '');
    if (blockGate) {
      await fetch(`${baseUrl(lock)}/api/session/${sessionId}/gate/${blockGate}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}` },
        body: JSON.stringify({ verdict: 'answered', comment: 'doctor probe answer' }),
      });
      const afterAnswer = await getSession();
      const task = afterAnswer?.tasks.find((t) => t.id === probeTask);
      record(
        "a blocked task records the user's answer as a decision",
        task?.decisions.some((d) => d.answer === 'doctor probe answer') ?? false,
        task?.status,
      );
    }
  }

  /* ---------------- git ---------------- */

  const diff = await mcp('diff', {});
  record('diff engine runs git', String(diff['text'] ?? '').includes('Diff published'), String(diff['text'] ?? '').slice(0, 120));

  await hook('SessionEnd', { end_reason: 'other' });

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

export type { Gate };
