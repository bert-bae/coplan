/**
 * `coplan check <stage>` — run a stage's hooks from `.coplan/config.json`.
 *
 * One command for an agent to run, with output it can act on: a line per
 * hook, and for each failure only the tail of what it printed. `--json`
 * prints the results in the shape `harness_task_update` takes as `checks`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { HOOK_STAGES, DEFAULT_HOOK_TIMEOUT, PROJECT_CONFIG_PATH, hookCommand, hooksFor, loadProjectConfig, type CheckHook, type HookStage } from '../shared/project.ts';
import type { CheckResult } from '../shared/types.ts';
import { changedFiles, defaultBase, filesForStage } from '../shared/changes.ts';
import { repoRoot } from '../shared/git.ts';

/** Lines of a failing hook's output shown. Enough to see the error. */
const TAIL_LINES = 40;
/** Output kept per hook while it runs; the tail is all that is shown. */
const KEEP_BYTES = 256 * 1024;

/** The repository a folder is in — found as the daemon finds it — or the
 *  folder itself outside one. */
export async function repoRootOf(cwd: string): Promise<string> {
  return (await repoRoot(cwd)) ?? cwd;
}

interface Options {
  stage: HookStage;
  files: string[];
  /** What the change is diffed against at review and final. */
  base?: string;
  /** Match --files alone: the task's work cannot be told apart in git. */
  noDiff: boolean;
  list: boolean;
  json: boolean;
}

function parseArgs(args: string[]): Options | string {
  let stage: HookStage = 'review';
  const files: string[] = [];
  let list = false;
  let json = false;
  let noDiff = false;
  let base: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // `--flag value` or `--flag=value`. A flag with nothing after it — at
    // the end, or followed by another flag, which is left to be read as one
    // — has an empty value, which each flag refuses.
    const value = (flag: string): string | null => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      if (a !== flag) return null;
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) return '';
      i++;
      return next;
    };
    const commas = (v: string) => v.split(',').map((f) => f.trim()).filter(Boolean);
    let v: string | null;
    if (a === '--list') list = true;
    else if (a === '--json') json = true;
    else if (a === '--no-diff') noDiff = true;
    else if ((v = value('--files')) !== null) {
      if (!commas(v).length) return '"--files" needs the files, comma-separated: --files src/a.ts,src/b.ts.';
      files.push(...commas(v));
    }
    else if ((v = value('--base')) !== null) {
      if (!v || v.startsWith('-')) return `"--base${v ? ` ${v}` : ''}" needs a branch or commit.`;
      base = v;
    } else if ((HOOK_STAGES as readonly string[]).includes(a)) stage = a as HookStage;
    else return `unknown argument "${a}". Stages: ${HOOK_STAGES.join(', ')}.`;
  }
  return { stage, files, list, json, noDiff, ...(base ? { base } : {}) };
}

export async function runCheck(args: string[], cwd = process.cwd()): Promise<number> {
  const opts = parseArgs(args);
  if (typeof opts === 'string') {
    console.error(opts);
    return 2;
  }
  const root = await repoRootOf(cwd);
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
  // At review and final the change is there to read: a hook for a file the
  // task touched without listing it applies too. Only a list of files can
  // narrow the hooks, so only then is the diff read.
  let files = opts.files;
  if (opts.stage !== 'implement' && opts.files.length && !opts.noDiff) {
    const base = opts.base ?? (await defaultBase(root, config.branches.base));
    // What this checkout changed since it left the base, uncommitted work
    // included. (Where its work cannot be told apart from another task's,
    // the brief says --no-diff.)
    const changed = base ? await changedFiles(root, { base, head: 'HEAD' }) : null;
    const since = `since ${base}`;
    if (changed === null) {
      console.error(
        `coplan: could not read what changed${base ? ` ${since}` : ': no base branch found (pass --base)'}; ` +
          'the hooks are matched against --files alone.',
      );
    } else {
      files = filesForStage(opts.stage, opts.files, changed);
      const planned = new Set(hooksFor(config, opts.stage, opts.files));
      const added = hooksFor(config, opts.stage, files).filter((h) => !planned.has(h));
      if (added.length) console.error(`coplan: the change ${since} also touches files for ${added.map((h) => h.name).join(', ')}.`);
    }
  }
  const hooks = hooksFor(config, opts.stage, files);
  if (!hooks.length) {
    if (opts.json) console.log('[]');
    else console.log(`No ${opts.stage} hooks${files.length ? ' apply to these files' : ''} in ${PROJECT_CONFIG_PATH}.`);
    return 0;
  }
  if (opts.list) {
    for (const h of hooks) console.log(`${h.name}: ${hookCommand(h)}${h.optional ? '  (optional)' : ''}`);
    return 0;
  }

  const results: CheckResult[] = [];
  let failed = 0;
  for (const hook of hooks) {
    const outcome = await runHook(hook, root);
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
