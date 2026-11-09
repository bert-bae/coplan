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
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import { changedFiles, changedSince, unreadWords, type ChangedFiles } from '../shared/changes.ts';

/** Lines of a failing hook's output shown. Enough to see the error. */
const TAIL_LINES = 40;
/** Output kept per hook while it runs; the tail is all that is shown. */
const KEEP_BYTES = 256 * 1024;

export function repoRootOf(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
  } catch {
    return cwd;
  }
}

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
    if (a === '--list') list = true;
    else if (a === '--json') json = true;
    else if (a === '--all') all = true;
    else if (a === '--since') since = args[++i] || undefined;
    else if (a.startsWith('--since=')) since = a.slice(8) || undefined;
    else if (a === '--skip') skip.push(...(args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith('--skip=')) skip.push(...a.slice(7).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--base') base = args[++i] || undefined;
    else if (a.startsWith('--base=')) base = a.slice(7) || undefined;
    else if (a === '--files') files.push(...(args[++i] ?? '').split(',').map((f) => f.trim()).filter(Boolean));
    else if (a.startsWith('--files=')) files.push(...a.slice(8).split(',').map((f) => f.trim()).filter(Boolean));
    else if ((HOOK_STAGES as readonly string[]).includes(a)) stage = a as HookStage;
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
  const root = repoRootOf(cwd);
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
  if (opts.skip.length) say(`coplan: not running ${opts.skip.join(', ')} — skipped for this task.`);
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

function runHook(hook: CheckHook, cwd: string): Promise<{ code: number; output: string; ms: number; timedOut: boolean }> {
  const started = Date.now();
  // A hook whose folder is not there fails, saying so: run anywhere else it
  // could pass without checking what it is for.
  if (hook.cwd && !existsSync(path.join(cwd, hook.cwd))) {
    return Promise.resolve({ code: 1, output: `its folder ${hook.cwd} does not exist`, ms: 0, timedOut: false });
  }
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    // Its own process group, so a timeout stops everything it started — a
    // test runner's workers too — not just the shell.
    const child = spawn('sh', ['-c', hook.run], {
      cwd: hook.cwd ? path.join(cwd, hook.cwd) : cwd,
      env: { ...process.env, CI: process.env['CI'] ?? '1', ...hook.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
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
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 3000).unref();
    }, (hook.timeout ?? DEFAULT_HOOK_TIMEOUT) * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(err.message), ms: Date.now() - started, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output, ms: Date.now() - started, timedOut });
    });
  });
}
