import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SessionStore } from './store.ts';
import type { CheckRun } from '../shared/types.ts';

const MAX_OUTPUT = 40_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const running = new Map<string, ReturnType<typeof spawn>>();

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

  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    const child = spawn(check.command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    running.set(checkId, child);

    const append = (buf: Buffer) => {
      output += buf.toString('utf8');
      if (output.length > MAX_OUTPUT) output = `…\n${output.slice(-MAX_OUTPUT)}`;
      patchCheck(store, sessionId, checkId, { output });
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      output += '\n[cc-harness] timed out';
      child.kill('SIGKILL');
    }, DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(checkId);
      const status: CheckRun['status'] = code === 0 ? 'passed' : 'failed';
      const updated = patchCheck(store, sessionId, checkId, {
        status,
        exitCode: code ?? -1,
        finishedAt: Date.now(),
        output,
      });
      store.addTimeline(sessionId, 'check', `${check.command} — ${status}`, {
        label: status,
        meta: { checkId, exitCode: code },
      });
      resolve(updated);
    };

    child.on('error', (err) => {
      output += `\n[cc-harness] ${err.message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
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
  const child = running.get(checkId);
  if (!child) return false;
  child.kill('SIGTERM');
  return true;
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
