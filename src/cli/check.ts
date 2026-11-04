/**
 * `coplan check <stage>` — run a stage's hooks from `.coplan/config.json`.
 *
 * One command for an agent to run, with output it can act on: a line per
 * hook, and for each failure only the tail of what it printed. `--json`
 * prints the results in the shape `harness_task_update` takes as `checks`.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { HOOK_STAGES, DEFAULT_HOOK_TIMEOUT, PROJECT_CONFIG_PATH, hooksFor, loadProjectConfig, type CheckHook, type HookStage } from '../shared/project.ts';
import type { CheckResult } from '../shared/types.ts';

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
}

function parseArgs(args: string[]): Options | string {
  let stage: HookStage = 'review';
  const files: string[] = [];
  let list = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--list') list = true;
    else if (a === '--json') json = true;
    else if (a === '--files') files.push(...(args[++i] ?? '').split(',').map((f) => f.trim()).filter(Boolean));
    else if (a.startsWith('--files=')) files.push(...a.slice(8).split(',').map((f) => f.trim()).filter(Boolean));
    else if ((HOOK_STAGES as readonly string[]).includes(a)) stage = a as HookStage;
    else return `unknown argument "${a}". Stages: ${HOOK_STAGES.join(', ')}.`;
  }
  return { stage, files, list, json };
}

export async function runCheck(args: string[], cwd = process.cwd()): Promise<number> {
  const opts = parseArgs(args);
  if (typeof opts === 'string') {
    console.error(opts);
    return 2;
  }
  const root = repoRootOf(cwd);
  const config = loadProjectConfig(root);
  for (const e of config.errors) console.error(`coplan: ${e}`);
  if (config.errors.length && !config.file) return 2;
  if (!config.file) {
    console.log(`No ${PROJECT_CONFIG_PATH} in ${root}: nothing is configured to run. \`coplan init\` writes a starting point.`);
    return opts.json ? (console.log('[]'), 0) : 0;
  }
  const hooks = hooksFor(config, opts.stage, opts.files);
  if (!hooks.length) {
    if (opts.json) console.log('[]');
    else console.log(`No ${opts.stage} hooks${opts.files.length ? ' apply to these files' : ''} in ${PROJECT_CONFIG_PATH}.`);
    return 0;
  }
  if (opts.list) {
    for (const h of hooks) console.log(`${h.name}: ${h.run}${h.optional ? '  (optional)' : ''}`);
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
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn('sh', ['-c', hook.run], { cwd, env: { ...process.env, CI: process.env['CI'] ?? '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > KEEP_BYTES) output = output.slice(-KEEP_BYTES);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
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
