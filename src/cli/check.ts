/**
 * `coplan check <stage>` — run a stage's hooks from `.coplan/config.json`,
 * targeted to what changed.
 *
 * One command for an agent to run, with output it can act on: a line per
 * hook, and for each failure only the tail of what it printed. `--json`
 * prints the results in the shape `harness_task_update` takes as `checks`.
 *
 * Only the checks for what the change touched run: since the commit the
 * task began at (`--since`), or since the last commit; at `final`, since
 * the base branch. A check for an area the change did not touch does not
 * run, nothing runs when nothing changed, and `{files}` in a command is the
 * changed files in its area. `--files` names the files instead of git;
 * `--all` runs every check, as before.
 */
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import path from 'node:path';
import {
  HOOK_STAGES,
  DEFAULT_HOOK_TIMEOUT,
  PROJECT_CONFIG_PATH,
  filesInScope,
  hookCommand,
  hookScope,
  hooksForChange,
  loadProjectConfig,
  withFiles,
  type CheckHook,
  type HookStage,
} from '../shared/project.ts';
import type { CheckResult } from '../shared/types.ts';
import { changedFiles, changedSince, repoRoot, unreadWords, type ChangedFiles } from '../shared/changes.ts';
import { stdoutFailure } from './output.ts';

/** Lines of a failing hook's output shown. Enough to see the error. */
const TAIL_LINES = 40;
/** Output kept per hook while it runs; the tail is all that is shown. */
const KEEP_BYTES = 256 * 1024;

interface Options {
  stage: HookStage;
  files: string[];
  list: boolean;
  json: boolean;
  /** What the build is measured from at `final`; the repository's base
   *  branch (`branches.base`) without. */
  base?: string;
  /** The commit the task began at: its change is everything since. Without
   *  it, the change is what is not committed yet. */
  since?: string;
  /** Every check, whatever changed: the escape from targeting. */
  all: boolean;
  /** Checks the user skipped for this task (#54): not run. */
  skip: string[];
}

function parseArgs(args: string[]): Options | string {
  let stage: HookStage = 'review';
  const files: string[] = [];
  let list = false;
  let json = false;
  let base: string | undefined;
  let since: string | undefined;
  let all = false;
  const skip: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // `--flag value` or `--flag=value`. A flag with nothing after it — at
    // the end, or followed by another flag, which is left to be read as one
    // — has an empty value, which each flag refuses: a value quietly taken
    // from the next flag, or dropped, would change what runs.
    const value = (flag: string): string | null => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      if (a !== flag) return null;
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) return '';
      i++;
      return next;
    };
    let v: string | null;
    if (a === '--list') list = true;
    else if (a === '--json') json = true;
    else if (a === '--all') all = true;
    else if ((v = value('--since')) !== null) {
      if (!v.trim()) return '"--since" needs the commit the task began at.';
      since = v.trim();
    } else if ((v = value('--skip')) !== null) {
      // One check per --skip, named whole: a name may hold a space or a
      // comma ("ts tests"), so nothing splits it.
      if (!v.trim()) return '"--skip" needs the name of a check.';
      skip.push(v.trim());
    } else if ((v = value('--base')) !== null) {
      if (!v.trim()) return '"--base" needs a branch or commit.';
      base = v.trim();
    } else if ((v = value('--files')) !== null) {
      const named = v.split(',').map((f) => f.trim()).filter(Boolean);
      if (!named.length) return '"--files" needs the files, comma-separated: --files src/a.ts,src/b.ts.';
      files.push(...named);
    } else if ((HOOK_STAGES as readonly string[]).includes(a)) stage = a as HookStage;
    else return `unknown argument "${a}". Stages: ${HOOK_STAGES.join(', ')}.`;
  }
  return { stage, files, list, json, all, skip, ...(base ? { base } : {}), ...(since ? { since } : {}) };
}

export async function runCheck(args: string[], cwd = process.cwd()): Promise<number> {
  const opts = parseArgs(args);
  if (typeof opts === 'string') {
    console.error(opts);
    return 2;
  }
  const root = (await repoRoot(cwd)) ?? cwd;
  const config = loadProjectConfig(root);
  // A config that cannot be read must not pass for one with nothing to run.
  // Anything else that is wrong — a template that is missing, a reviewer
  // model misspelt — is said, and the checks run: they do not depend on it.
  for (const w of [...config.errors, ...config.warnings]) console.error(`coplan: ${w}`);
  if (config.checksBroken) {
    console.error(`coplan: fix the checks in ${PROJECT_CONFIG_PATH} first; nothing was run.`);
    return 2;
  }
  if (!config.file) {
    const say = `No ${PROJECT_CONFIG_PATH} in ${root}: nothing is configured to run. \`coplan init\` writes a starting point.`;
    if (opts.json) {
      console.error(say);
      console.log('[]');
    } else console.log(say);
    return 0;
  }
  const say = (line: string) => (opts.json ? console.error(line) : console.log(line));
  // What changed decides what runs. `--files` names it; else git does —
  // since the task began, or since the last commit, or at the end since the
  // base branch. Null where nobody can say: then every check runs.
  let changed: string[] | null = null;
  let since = '';
  // A change git could not read, too large to list, or with no base to
  // measure it from is not one that touched nothing: every check runs, as
  // with --all, and it says why.
  const unread = (c: ChangedFiles) => say(`coplan: what changed cannot be told — ${unreadWords(c)} — so every check runs.`);
  if (opts.all) since = '';
  else if (opts.files.length) changed = opts.files;
  else if (opts.stage === 'final') {
    const build = await changedFiles(root, opts.base ?? config.branches.base);
    // A base given here that is not there is a mistake to say, not a reason
    // to run everything.
    if (build?.unread === 'no-base' && opts.base) {
      console.error(`coplan: "--base ${opts.base}" is not a branch or commit here.`);
      return 2;
    }
    if (build) {
      since = `since ${build.base}`;
      if (build.unread) unread(build);
      else changed = build.files;
    }
  } else {
    const task = await changedSince(root, opts.since);
    if (task) {
      since = opts.since ? `since ${opts.since.slice(0, 12)}` : 'since the last commit';
      if (task.unread) unread(task);
      else changed = task.files;
    } else if (opts.since) {
      console.error(`coplan: ${opts.since} is not a commit here: give the one the task began at, or --all.`);
      return 2;
    }
  }
  const stageHooks = config.hooks[opts.stage].filter((h) => !opts.skip.includes(h.name));
  const hooks = changed === null ? stageHooks : hooksForChange(config, opts.stage, changed).filter((h) => !opts.skip.includes(h.name));
  // A skip names one of the repository's checks, whole. One that names none
  // (a typo, or `--skip a,b` from before each check took its own flag)
  // skips nothing, and is said so rather than reported as skipped.
  const known = new Set(HOOK_STAGES.flatMap((st) => config.hooks[st].map((h) => h.name)));
  for (const name of opts.skip.filter((n) => !known.has(n))) {
    console.error(`coplan: --skip "${name}" names no check in ${PROJECT_CONFIG_PATH}, so nothing is skipped for it (one --skip per check).`);
  }
  const skippedHere = config.hooks[opts.stage].filter((h) => opts.skip.includes(h.name)).map((h) => h.name);
  if (skippedHere.length) say(`coplan: not running ${skippedHere.join(', ')} — skipped for this task.`);
  const untouched = stageHooks.filter((h) => !hooks.includes(h));
  if (untouched.length && changed !== null) {
    say(
      changed.length
        ? `coplan: not running ${untouched.map((h) => `${h.name} (${(hookScope(h) ?? []).join(', ')})`).join(', ')} — the change ${since ? `${since} ` : ''}does not touch ${untouched.length === 1 ? 'its area' : 'their areas'}.`
        : `coplan: nothing changed ${since || 'in --files'}, so no check runs. Work already committed? Pass --since <the commit the task began at>, or --all.`,
    );
  }
  if (!hooks.length) {
    if (opts.json) console.log('[]');
    else if (!stageHooks.length) console.log(`No ${opts.stage} hooks${opts.skip.length ? ' left to run' : ''} in ${PROJECT_CONFIG_PATH}.`);
    return 0;
  }
  // Each check's command, with `{files}` as the changed files in its area —
  // from the folder it runs in.
  const command = (h: CheckHook) => {
    const files = changed === null ? null : filesInScope(h, changed).map((f) => (h.cwd ? path.posix.relative(h.cwd, f) : f));
    return withFiles(h.run, files);
  };
  if (opts.list) {
    for (const h of hooks) console.log(`${h.name}: ${hookCommand({ ...h, run: command(h) })}${h.optional ? '  (optional)' : ''}`);
    return 0;
  }

  const results: CheckResult[] = [];
  let failed = 0;
  for (const hook of hooks) {
    // Output that could not be written (a full disk) ends the run before
    // the next check, rather than leave it half done. Its error is told a
    // tick after the write.
    await new Promise((r) => setImmediate(r));
    if (stdoutFailure()) return 1;
    const outcome = await runHook({ ...hook, run: command(hook) }, root);
    const secs = `${(outcome.ms / 1000).toFixed(1)}s`;
    const ok = outcome.code === 0;
    const what = outcome.timedOut ? `timed out after ${hook.timeout ?? DEFAULT_HOOK_TIMEOUT}s` : `exit ${outcome.code}`;
    if (!opts.json) console.log(`${ok ? '✓' : hook.optional ? '⚠' : '✗'} ${hook.name}  (${ok ? secs : `${what}, ${secs}`})${hook.optional && !ok ? ' — optional' : ''}`);
    if (!ok && !opts.json) {
      const tail = outcome.output.trimEnd().split('\n').slice(-TAIL_LINES);
      for (const line of tail) console.log(`    ${line}`);
    }
    if (!ok && !hook.optional) failed++;
    const lastLine = outcome.output.trimEnd().split('\n').filter((l) => l.trim()).pop()?.trim();
    results.push({ name: hook.name, ok, ...(ok ? {} : { note: `${what}${lastLine ? `: ${lastLine.slice(0, 200)}` : ''}` }) });
  }

  if (opts.json) console.log(JSON.stringify(results));
  else {
    const passed = results.filter((r) => r.ok).length;
    console.log(`${opts.stage}: ${passed} passed${failed ? `, ${failed} failed` : ''}${results.length - passed - failed ? `, ${results.length - passed - failed} optional failed` : ''}`);
  }
  return failed ? 1 : 0;
}

/** How long a check that is stopped gets to go, before it is killed. */
const STOP_GRACE_MS = 3000;
/** How long a check that has gone gets for its output to close: it may be
 *  held open from outside its group. */
const LET_GO_MS = 200;

function runHook(hook: CheckHook, cwd: string): Promise<{ code: number; output: string; ms: number; timedOut: boolean }> {
  const started = Date.now();
  // A hook whose folder is not there fails, saying so: run anywhere else it
  // could pass without checking what it is for.
  const dir = hook.cwd ? path.join(cwd, hook.cwd) : cwd;
  if (hook.cwd) {
    let problem: string | undefined;
    const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? String(err);
    try {
      const stat = statSync(dir, { throwIfNoEntry: false });
      if (!stat) problem = 'does not exist';
      else if (!stat.isDirectory()) problem = 'is not a folder';
    } catch (err) {
      problem = `cannot be read (${code(err)})`;
    }
    // Run in: one that cannot be entered would fail as a missing shell.
    if (!problem) {
      try {
        accessSync(dir, fsConstants.X_OK);
      } catch (err) {
        problem = `cannot be entered (${code(err)})`;
      }
    }
    if (problem) return Promise.resolve({ code: 1, output: `its folder ${hook.cwd} ${problem}`, ms: 0, timedOut: false });
  }
  // Its own process group, so a timeout stops everything it started — a
  // test runner's workers too — not just the shell. One that cannot start
  // at all fails, as one that cannot be found does, and the checks go on.
  const start = () =>
    spawn('sh', ['-c', hook.run], {
      cwd: dir,
      env: { ...process.env, CI: process.env['CI'] ?? '1', ...hook.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  let child: ReturnType<typeof start>;
  try {
    child = start();
  } catch (err) {
    return Promise.resolve({ code: 1, output: String((err as Error)?.message ?? err), ms: Date.now() - started, timedOut: false });
  }
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > KEEP_BYTES) output = output.slice(-KEEP_BYTES);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const groupAlive = () => {
      try {
        process.kill(-child.pid!, 0);
        return true;
      } catch (err) {
        // There, but not ours to signal (a member that changed user).
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    /** `then` once the check's process and the rest of its group have gone,
     *  unless `over()` first. Its shell may have exited already, with
     *  something out of its group holding its output open. */
    const afterGroup = (then: () => void, over: () => boolean) => {
      const poll = () => {
        if (over()) return;
        if (groupAlive()) setTimeout(poll, 50);
        else then();
      };
      if (child.exitCode !== null || child.signalCode !== null) poll();
      else child.once('exit', poll);
    };
    /**
     * Stop the check: SIGTERM to its group, settled once its process and the
     * rest of its group have gone. What ignores SIGTERM, a test runner's
     * worker say, is killed three seconds on, which nothing can ignore, and
     * that settles it. Not its output closing, which something it started
     * out of its group could hold open. A stop under way is joined.
     */
    let stopping: Promise<void> | undefined;
    const stop = () =>
      (stopping ??= new Promise<void>((stopped) => {
        kill('SIGTERM');
        let over = false;
        const finish = () => {
          if (over) return;
          over = true;
          clearTimeout(deadline);
          stopped();
        };
        // A moment for what was killed to have exited.
        const deadline = setTimeout(() => {
          kill('SIGKILL');
          setTimeout(finish, 100);
        }, STOP_GRACE_MS);
        // Gone, a process may still show as there until its parent reaps it:
        // past the SIGKILL, that is all the group can be.
        afterGroup(finish, () => over);
      }));
    // Over once its output has closed, or once it has gone (stopped, or
    // ended on its own): its output read to the end, or let go a moment on,
    // as it may be held open from outside its group. Interrupted, this
    // command ends instead.
    let closed = false;
    let ended: number | undefined;
    child.once('exit', () => (ended = Date.now()));
    let interrupts = 0;
    let settled = false;
    const settle = () => {
      if (settled || interrupts) return;
      settled = true;
      done();
      if (!closed) {
        // Held open from outside its group (a server started for the
        // checks after it, say): read on, unheard, and not kept open for.
        for (const out of [child.stdout, child.stderr]) {
          out.removeListener('data', keep);
          out.resume();
          (out as unknown as { unref?: () => void }).unref?.();
        }
      }
      resolve({ code: timedOut ? 124 : (child.exitCode ?? 1), output, ms: (ended ?? Date.now()) - started, timedOut });
    };
    const letGo = () => (closed ? settle() : setTimeout(settle, LET_GO_MS));
    // Ended on its own, it is over as it ended, whatever holds its output.
    afterGroup(
      () => !stopping && letGo(),
      () => settled || stopping !== undefined,
    );
    const timer = setTimeout(() => {
      // Ended in time, all of it, and its output being let go: not a timeout.
      if (ended !== undefined && !groupAlive()) return;
      timedOut = true;
      void stop().then(letGo);
    }, (hook.timeout ?? DEFAULT_HOOK_TIMEOUT) * 1000);
    // Its own group also keeps Ctrl+C (and an agent ending this command)
    // from reaching it: passed on here, so nothing is left running, and this
    // command ends as an interrupted one does once the check has gone (stop),
    // or at a second interrupt, killing what is left of it. Meanwhile the
    // checks after it are not to start.
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const interrupted = (signal: (typeof signals)[number]) => {
      const leave = () => process.exit(128 + osConstants.signals[signal]);
      if (interrupts++) {
        kill('SIGKILL');
        leave();
      }
      console.error(`coplan: interrupted; stopping "${hook.name}"`);
      clearTimeout(timer);
      void stop().then(leave);
    };
    for (const signal of signals) process.on(signal, interrupted);
    // Whatever else ends this command meanwhile (a crash, a write that
    // fails): the check's group goes with it, not left running unwatched.
    const orphaned = () => kill('SIGKILL');
    process.on('exit', orphaned);
    const done = () => {
      clearTimeout(timer);
      for (const signal of signals) process.off(signal, interrupted);
      process.off('exit', orphaned);
    };
    child.on('error', (err) => {
      done();
      resolve({ code: 127, output: String(err.message), ms: Date.now() - started, timedOut });
    });
    child.on('close', () => {
      closed = true;
      // Being stopped, it is over once stopped.
      if (!stopping) settle();
    });
  });
}
