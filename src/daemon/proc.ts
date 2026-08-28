import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Child-process supervision for everything the daemon shells out to.
 *
 * The daemon runs commands it did not write — the user's test suite, `gh pr
 * create` — through a shell, and it outlives the session that started it. That
 * combination is how a dev tool ends up with a fleet of orphaned `vitest`
 * workers still holding a port an hour after the terminal was closed. Three
 * properties prevent it, and every spawn in the daemon goes through here so
 * that none of them can be forgotten at a call site:
 *
 *  1. **Process groups.** `spawn(cmd, { shell: true })` runs `sh -c cmd`, so
 *     `child.kill()` signals the shell and nothing else — the test runner it
 *     forked survives, reparented to init. Every child is spawned `detached`
 *     into its own process group and signalled with `kill(-pgid)`, which
 *     reaches the whole tree.
 *
 *  2. **Settle on `exit`, not `close`.** `close` waits for the stdio pipes to
 *     close, and an orphaned grandchild inherits them — so after killing a
 *     wedged shell, `close` may never arrive and the awaiting promise never
 *     settles. `exit` always fires. The pipes get a short grace period to
 *     flush and are then destroyed, releasing the fds regardless.
 *
 *  3. **A registry.** Every live child is tracked so shutdown can reap the
 *     lot. Nothing the daemon started is allowed to survive it.
 */

const FLUSH_GRACE_MS = 250;
/** Between SIGTERM and SIGKILL. Enough for a test runner to tear down. */
const KILL_ESCALATION_MS = 4_000;

export interface RunOptions {
  cwd: string;
  /** Hard wall clock. The tree is killed when it expires. */
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Streamed stdout+stderr, already decoded. */
  onOutput?: (chunk: string) => void;
  /** Cap on retained output; the head is dropped when it is exceeded. */
  maxOutput?: number;
  /** Shown in the shutdown log when a straggler has to be killed. */
  label?: string;
}

export interface RunResult {
  ok: boolean;
  /** -1 when the process was signalled rather than exiting normally. */
  code: number;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  /** Set when `cancel()` (or shutdown) killed it. */
  cancelled: boolean;
}

export interface RunHandle {
  readonly result: Promise<RunResult>;
  /** Terminate the whole process group, escalating to SIGKILL. */
  cancel(): void;
}

interface Entry {
  child: ChildProcess;
  label: string;
  kill: (reason: 'cancel' | 'timeout' | 'shutdown') => void;
}

const live = new Set<Entry>();

/** How many supervised children are still running. For diagnostics and tests. */
export function liveChildCount(): number {
  return live.size;
}

/**
 * Signal a whole process group.
 *
 * `detached: true` makes the child its own group leader, so its pgid equals
 * its pid and `kill(-pid)` reaches every descendant. If the group is already
 * gone (ESRCH) or the platform has no such concept, fall back to the direct
 * child so the common case still works.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Run a command under a shell, supervised.
 *
 * Commands come from the user's own config, so a shell is deliberate — this is
 * the same trust level as a `package.json` script.
 */
export function run(command: string, opts: RunOptions): RunHandle {
  const maxOutput = opts.maxOutput ?? Number.POSITIVE_INFINITY;

  let settled = false;
  let output = '';
  let timedOut = false;
  let cancelled = false;
  let escalation: NodeJS.Timeout | null = null;
  let flush: NodeJS.Timeout | null = null;
  // Declared up front so `settle` can clear it from any path, including one
  // that fires before the timer below has been assigned.
  let timer: NodeJS.Timeout | null = null;

  let resolveResult!: (value: RunResult) => void;
  const result = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });

  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    // A new process group, so the whole tree can be signalled at once.
    detached: process.platform !== 'win32',
    // stdin is /dev/null on purpose. The default is a pipe the daemon never
    // writes to and never closes, so a command that prompts for a password
    // blocks forever on a read that can never be answered.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ?? process.env,
  });

  const entry: Entry = { child, label: opts.label ?? command, kill: () => {} };

  /** SIGTERM the tree, then SIGKILL it if that was not enough. */
  const terminate = (reason: 'cancel' | 'timeout' | 'shutdown'): void => {
    if (settled) return;
    if (reason === 'timeout') timedOut = true;
    else cancelled = true;
    signalTree(child, 'SIGTERM');
    if (escalation) return;
    escalation = setTimeout(() => {
      escalation = null;
      signalTree(child, 'SIGKILL');
      // A tree that survives SIGKILL is not something a dev tool can fix, and
      // waiting on it would hold the caller open forever. Settle regardless.
      settle(-1, 'SIGKILL');
    }, KILL_ESCALATION_MS);
    escalation.unref?.();
  };
  entry.kill = terminate;

  const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    if (escalation) clearTimeout(escalation);
    if (flush) clearTimeout(flush);
    if (timer) clearTimeout(timer);
    live.delete(entry);
    // Release the pipe fds even if a surviving grandchild still holds the
    // write end — otherwise the read end leaks for the daemon's lifetime.
    child.stdout?.removeAllListeners('data');
    child.stderr?.removeAllListeners('data');
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolveResult({
      ok: code === 0 && !timedOut && !cancelled,
      code: code ?? -1,
      signal,
      output,
      timedOut,
      cancelled,
    });
  };

  const append = (buf: Buffer): void => {
    const chunk = buf.toString('utf8');
    output += chunk;
    if (output.length > maxOutput) output = `…\n${output.slice(-maxOutput)}`;
    opts.onOutput?.(output);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  // A broken pipe after the tree is killed is expected, not an error.
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  timer = setTimeout(() => terminate('timeout'), opts.timeoutMs);
  timer.unref?.();

  child.on('error', (err) => {
    output += `\n[cc-harness] ${err.message}`;
    settle(-1, null);
  });

  child.on('exit', (code, signal) => {
    // Give the pipes a beat to flush what is already buffered, but never wait
    // on them: an orphan holding the write end would stall this forever.
    if (flush) clearTimeout(flush);
    flush = setTimeout(() => settle(code, signal), FLUSH_GRACE_MS);
    flush.unref?.();
  });

  // Both pipes closed and the child is gone: nothing left to wait for.
  child.on('close', (code, signal) => settle(code, signal));

  live.add(entry);
  return { result, cancel: () => terminate('cancel') };
}

/**
 * Reap every supervised child, gracefully then forcibly.
 *
 * Because children are spawned `detached`, they do **not** die with the
 * daemon — killing them is mandatory, not a courtesy. SIGTERM first so a test
 * runner gets to tear its own workers down, then SIGKILL to the whole group
 * for anything still standing. Resolves once the grace period has elapsed and
 * the final signal has been sent, so shutdown can safely exit afterwards.
 */
export async function shutdownChildren(graceMs = 800): Promise<number> {
  const entries = [...live];
  if (entries.length === 0) return 0;

  for (const entry of entries) signalTree(entry.child, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && entries.some((e) => e.child.exitCode === null && e.child.signalCode === null)) {
    await new Promise((r) => {
      const t = setTimeout(r, 50);
      t.unref?.();
    });
  }

  for (const entry of entries) signalTree(entry.child, 'SIGKILL');
  live.clear();
  return entries.length;
}

/** Synchronous last resort, for exit paths that cannot await. */
export function killAllChildren(): number {
  const entries = [...live];
  for (const entry of entries) signalTree(entry.child, 'SIGKILL');
  live.clear();
  return entries.length;
}

/** Labels of the children still running, for the shutdown log. */
export function liveChildLabels(): string[] {
  return [...live].map((e) => e.label);
}

export const _internals = { signalTree, KILL_ESCALATION_MS, FLUSH_GRACE_MS };
