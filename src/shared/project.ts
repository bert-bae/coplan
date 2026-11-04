import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildSettings } from './types.ts';
import { DEFAULT_BUILD_SETTINGS, cleanSettings } from './build.ts';

/**
 * A repository's own Coplan settings: `.coplan/config.json`, committed with
 * the code so everyone who builds there — people, Claude, the subagents it
 * hands tasks to — runs the same checks.
 *
 * It answers the question every agent otherwise guesses at: *what do I run
 * to know this change is good?* The answer is a list of hooks for each step
 * of a task's implement → review → refine cycle:
 *
 * - `implement` — quick checks after each implementation or refinement
 *   pass, before a task goes to review: typecheck, lint, format.
 * - `review` — the gate a task must pass before it is done: the tests.
 * - `final` — once every task is done, before the final report: the full
 *   suite, the build.
 *
 * Coplan never runs these itself. They are handed to Claude, which runs them
 * as any other command — under the user's own permission settings — or runs
 * them all at once with `coplan check <stage>`.
 */

export const HOOK_STAGES = ['implement', 'review', 'final'] as const;
export type HookStage = (typeof HOOK_STAGES)[number];

export interface CheckHook {
  /** What it is called in reports and on the board: "typecheck", "tests". */
  name: string;
  /** A shell command, run from the repository root. */
  run: string;
  /** Seconds before it is stopped. Default 600. */
  timeout?: number;
  /** Only for tasks that touch matching files (globs, e.g. `src/**`, `*.py`).
   *  A task that lists no files gets every hook. */
  paths?: string[];
  /** A failure is reported but does not hold the task back. */
  optional?: boolean;
}

export interface ProjectConfig {
  /** Where it was read from; null when the repository has none. */
  file: string | null;
  hooks: Record<HookStage, CheckHook[]>;
  /** Defaults for how a build runs; the user can change them per plan. */
  settings: BuildSettings;
  branches: {
    /** The branch work is cut from and merged back into. */
    base?: string;
    /** Put in front of every branch a plan names, e.g. `coplan/`. */
    prefix?: string;
  };
  /** What could not be read, said rather than silently ignored: a hook
   *  that is quietly dropped is a check nobody runs. */
  errors: string[];
}

export const PROJECT_CONFIG_PATH = path.join('.coplan', 'config.json');
export const DEFAULT_HOOK_TIMEOUT = 600;
const MAX_HOOKS = 20;

export function emptyProjectConfig(): ProjectConfig {
  return { file: null, hooks: { implement: [], review: [], final: [] }, settings: { ...DEFAULT_BUILD_SETTINGS }, branches: {}, errors: [] };
}

/** The repository's config, or an empty one. Never throws. */
export function loadProjectConfig(root: string | null | undefined): ProjectConfig {
  if (!root) return emptyProjectConfig();
  const file = path.join(root, PROJECT_CONFIG_PATH);
  if (!existsSync(file)) return emptyProjectConfig();
  let raw: unknown;
  try {
    // Line comments are allowed, so the file can explain itself.
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  } catch (err) {
    return { ...emptyProjectConfig(), file, errors: [`${PROJECT_CONFIG_PATH} could not be read: ${(err as Error).message}`] };
  }
  return parseProjectConfig(raw, file);
}

export function parseProjectConfig(raw: unknown, file: string | null = null): ProjectConfig {
  const config = { ...emptyProjectConfig(), file };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    config.errors.push(`${PROJECT_CONFIG_PATH} must hold an object.`);
    return config;
  }
  const rec = raw as Record<string, unknown>;

  const hooks = rec['hooks'];
  if (hooks !== undefined) {
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
      config.errors.push('"hooks" must map a stage (implement, review, final) to a list of commands.');
    } else {
      for (const [stage, list] of Object.entries(hooks as Record<string, unknown>)) {
        if (!(HOOK_STAGES as readonly string[]).includes(stage)) {
          config.errors.push(`"hooks.${stage}" is not a stage: use ${HOOK_STAGES.join(', ')}.`);
          continue;
        }
        config.hooks[stage as HookStage] = parseHooks(list, stage, config.errors);
      }
    }
  }

  if (rec['iric'] !== undefined) config.settings = cleanSettings(rec['iric'], DEFAULT_BUILD_SETTINGS);

  const branches = rec['branches'];
  if (branches && typeof branches === 'object' && !Array.isArray(branches)) {
    const b = branches as Record<string, unknown>;
    if (typeof b['base'] === 'string' && b['base'].trim()) config.branches.base = b['base'].trim();
    if (typeof b['prefix'] === 'string' && b['prefix'].trim()) config.branches.prefix = b['prefix'].trim();
  }
  return config;
}

function parseHooks(list: unknown, stage: string, errors: string[]): CheckHook[] {
  const items = Array.isArray(list) ? list : [list];
  const out: CheckHook[] = [];
  items.slice(0, MAX_HOOKS).forEach((item, i) => {
    const where = `hooks.${stage}[${i}]`;
    const rec = typeof item === 'string' ? { run: item } : item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const run = typeof rec?.['run'] === 'string' ? rec['run'].trim() : '';
    if (!rec || !run) {
      errors.push(`"${where}" needs a command: a string, or { "name", "run" }.`);
      return;
    }
    let name = typeof rec['name'] === 'string' && rec['name'].trim() ? rec['name'].trim().slice(0, 60) : nameFor(run);
    for (let n = 2; out.some((h) => h.name === name); n++) name = `${name.replace(/ #\d+$/, '')} #${n}`;
    const hook: CheckHook = { name, run };
    const timeout = rec['timeout'];
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) hook.timeout = Math.min(3600, Math.round(timeout));
    const paths = Array.isArray(rec['paths']) ? rec['paths'].filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
    if (paths.length) hook.paths = paths.map((p) => p.trim());
    if (rec['optional'] === true) hook.optional = true;
    out.push(hook);
  });
  if (items.length > MAX_HOOKS) errors.push(`"hooks.${stage}" has more than ${MAX_HOOKS} commands; the rest are ignored.`);
  return out;
}

/** "npm run typecheck" → "typecheck", "npm test" → "test", "make lint" → "lint". */
export function nameFor(run: string): string {
  const words = run.trim().split(/\s+/);
  const runner = /^(npm|pnpm|yarn|bun)$/.test(words[0] ?? '');
  if (runner && words[1] === 'run' && words[2]) return words[2];
  if (runner && words[1]) return words[1];
  if (words[0] === 'make' && words[1]) return words[1];
  if ((words[0] === 'cargo' || words[0] === 'go') && words[1]) return `${words[0]} ${words[1]}`;
  return run.length > 40 ? `${run.slice(0, 39)}…` : run;
}

/**
 * The hooks of one stage that apply to a task. A hook limited by `paths`
 * applies when the task expects to touch a matching file — and always when
 * the task lists no files, since then nobody can say it does not.
 */
export function hooksFor(config: ProjectConfig, stage: HookStage, files?: readonly string[]): CheckHook[] {
  return config.hooks[stage].filter((h) => !h.paths?.length || !files?.length || files.some((f) => h.paths!.some((p) => globMatch(p, f))));
}

export function hasHooks(config: ProjectConfig): boolean {
  return HOOK_STAGES.some((s) => config.hooks[s].length > 0);
}

/**
 * A small glob: `**` crosses directories, `*` and `?` do not. A pattern
 * without a slash matches a file's name anywhere (`*.ts`); one ending in a
 * slash matches everything under that directory (`src/`).
 */
export function globMatch(pattern: string, file: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  let pat = norm(pattern.trim());
  const target = norm(file.trim());
  if (!pat) return false;
  if (pat.endsWith('/')) pat += '**';
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === '*' && pat[i + 1] === '*') {
      i++;
      if (pat[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const regex = new RegExp(`^${re}$`);
  if (regex.test(target)) return true;
  return !pat.includes('/') && regex.test(target.split('/').pop() ?? '');
}
