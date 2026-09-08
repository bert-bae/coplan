import { randomUUID } from 'node:crypto';
import { run, type RunHandle } from './proc.ts';
import type { SessionStore } from './store.ts';
import type { CheckRun } from '../shared/types.ts';
import { CHECK_RUN_BUDGET_MS } from '../shared/config.ts';

const MAX_OUTPUT = 40_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Handles for checks currently executing, so they can be cancelled. */
const running = new Map<string, RunHandle>();
/** The check ids belonging to each session's current run, so a second run can
 *  stop the first rather than race it. */
const runsBySession = new Map<string, Set<string>>();

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
  opts: { timeoutMs?: number } = {},
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
    timeoutMs: Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
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

/**
 * Run every registered check, in order, within one overall deadline.
 *
 * The deadline is what lets the caller promise an answer by a given time. A
 * command still running when it passes is cancelled and recorded as timed
 * out, and the ones after it are left `pending` — an honest "we ran out of
 * time here", rather than a run that silently outlives every budget above it.
 */
export async function runAllChecks(
  store: SessionStore,
  sessionId: string,
  opts: { budgetMs?: number } = {},
): Promise<CheckRun[]> {
  const session = store.get(sessionId);
  if (!session) return [];

  // A previous run for this session is over the moment a new one starts: its
  // checks are no longer in `session.checks`, so nothing would ever report or
  // cancel them, and they would go on holding ports and locks against the run
  // replacing them.
  cancelSessionRun(sessionId);

  const ids = new Set<string>();
  runsBySession.set(sessionId, ids);
  const deadline = Date.now() + (opts.budgetMs ?? CHECK_RUN_BUDGET_MS);

  const results: CheckRun[] = [];
  try {
    // Sequential: parallel test runners fight over ports and fixtures.
    for (const check of [...session.checks]) {
      // Superseded. Cancelling the command that was in flight is not enough:
      // without this the abandoned loop walks on to its next command and
      // spawns it for real, racing the run that replaced it over the very
      // ports and locks this is here to protect — and writing its results
      // over `session.checks` after the newer run has already reported.
      if (runsBySession.get(sessionId) !== ids) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      ids.add(check.id);
      const run = await runCheck(store, sessionId, check.id, { timeoutMs: remaining });
      if (run) results.push(run);
    }
  } finally {
    if (runsBySession.get(sessionId) === ids) runsBySession.delete(sessionId);
  }
  return results;
}

/** Cancel whatever run a session has in flight. Returns how many were live. */
export function cancelSessionRun(sessionId: string): number {
  const ids = runsBySession.get(sessionId);
  if (!ids) return 0;
  let stopped = 0;
  for (const id of ids) {
    if (cancelCheck(id)) stopped++;
  }
  runsBySession.delete(sessionId);
  return stopped;
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
