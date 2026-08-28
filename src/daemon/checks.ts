import { randomUUID } from 'node:crypto';
import { run, type RunHandle } from './proc.ts';
import type { SessionStore } from './store.ts';
import type { CheckRun } from '../shared/types.ts';

const MAX_OUTPUT = 40_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Handles for checks currently executing, so they can be cancelled. */
const running = new Map<string, RunHandle>();

/** Register the configured verification commands without running them. */
export function seedChecks(store: SessionStore, sessionId: string, commands: string[]): CheckRun[] {
  const runs: CheckRun[] = commands.map((command) => ({
    id: randomUUID(),
    command,
    status: 'pending',
    output: '',
  }));
  store.mutate(sessionId, (s) => {
    s.checks = runs;
  });
  return runs;
}

export function addCheck(store: SessionStore, sessionId: string, command: string, label?: string): CheckRun {
  const run: CheckRun = { id: randomUUID(), command, status: 'pending', output: '', ...(label ? { label } : {}) };
  store.mutate(sessionId, (s) => {
    s.checks.push(run);
  });
  return run;
}

/**
 * Run one check, streaming its output to the UI as it goes.
 *
 * Commands come from the user's own config, so they run through a shell on
 * purpose — this is the same trust level as a package.json script.
 */
export async function runCheck(
  store: SessionStore,
  sessionId: string,
  checkId: string,
): Promise<CheckRun | undefined> {
  const session = store.get(sessionId);
  const check = session?.checks.find((c) => c.id === checkId);
  if (!session || !check) return undefined;
  if (check.status === 'running') return check;

  const cwd = session.repoRoot ?? session.cwd;
  const started = Date.now();

  patchCheck(store, sessionId, checkId, { status: 'running', startedAt: started, output: '' });

  const handle = run(check.command, {
    cwd,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
    label: `check: ${check.command}`,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    onOutput: (output) => patchCheck(store, sessionId, checkId, { output }),
  });
  running.set(checkId, handle);

  let outcome;
  try {
    outcome = await handle.result;
  } finally {
    // Always, on every path — a stale handle here would let `cancelCheck`
    // signal a pid that has since been recycled.
    running.delete(checkId);
  }

  const note = outcome.timedOut
    ? '\n[cc-harness] timed out'
    : outcome.cancelled
      ? '\n[cc-harness] cancelled'
      : '';
  const status: CheckRun['status'] = outcome.ok ? 'passed' : 'failed';
  const updated = patchCheck(store, sessionId, checkId, {
    status,
    exitCode: outcome.code,
    finishedAt: Date.now(),
    output: outcome.output + note,
  });
  store.addTimeline(sessionId, 'check', `${check.command} — ${status}`, {
    label: status,
    meta: { checkId, exitCode: outcome.code },
  });
  return updated;
}

export async function runAllChecks(store: SessionStore, sessionId: string): Promise<CheckRun[]> {
  const session = store.get(sessionId);
  if (!session) return [];
  const results: CheckRun[] = [];
  // Sequential: parallel test runners fight over ports and fixtures.
  for (const check of [...session.checks]) {
    const run = await runCheck(store, sessionId, check.id);
    if (run) results.push(run);
  }
  return results;
}

export function cancelCheck(checkId: string): boolean {
  const handle = running.get(checkId);
  if (!handle) return false;
  // Terminates the whole process group and escalates to SIGKILL on its own.
  handle.cancel();
  return true;
}

/** Cancel everything in flight. Used on daemon shutdown. */
export function cancelAllChecks(): number {
  const handles = [...running.values()];
  for (const handle of handles) handle.cancel();
  return handles.length;
}

function patchCheck(
  store: SessionStore,
  sessionId: string,
  checkId: string,
  patch: Partial<CheckRun>,
): CheckRun | undefined {
  let updated: CheckRun | undefined;
  const session = store.get(sessionId);
  if (!session) return undefined;
  const check = session.checks.find((c) => c.id === checkId);
  if (!check) return undefined;
  Object.assign(check, patch);
  updated = check;
  store.emitEvent({ type: 'check', sessionId, check });
  store.emitEvent({ type: 'state', sessionId, patch: { checks: session.checks } });
  return updated;
}

/** A one-line verdict for the ship stage. */
export function checksSummary(checks: CheckRun[]): { ok: boolean; text: string } {
  if (checks.length === 0) return { ok: true, text: 'no checks configured' };
  const failed = checks.filter((c) => c.status === 'failed');
  const pending = checks.filter((c) => c.status === 'pending' || c.status === 'running');
  if (failed.length) return { ok: false, text: `${failed.length} check(s) failing` };
  if (pending.length) return { ok: false, text: `${pending.length} check(s) not run` };
  return { ok: true, text: `${checks.length} check(s) passing` };
}
