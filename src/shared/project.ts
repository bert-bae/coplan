import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildSettings } from './types.ts';
import { DEFAULT_BUILD_SETTINGS, MAX_PARALLEL, MAX_ROUNDS, cleanSettings } from './build.ts';
import { REVIEW_MODES } from './types.ts';
import { parseJsonc } from './jsonc.ts';

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
export const MAX_HOOK_TIMEOUT = 3600;
export const MAX_HOOKS = 20;
export const MAX_HOOK_NAME = 60;

const TOP_KEYS = ['hooks', 'iric', 'branches'];
const IRIC_KEYS = ['review', 'parallel', 'maxRounds'];
const BRANCH_KEYS = ['base', 'prefix'];
const HOOK_KEYS = ['name', 'run', 'timeout', 'paths', 'optional'];

/** A key the file sets that nothing reads is most often a typo of one that
 *  is: said, so the setting the user meant is not silently lost. */
function unknownKeys(rec: Record<string, unknown>, known: string[], where: string, errors: string[]): void {
  for (const key of Object.keys(rec)) {
    if (!known.includes(key)) errors.push(`${where}"${key}" is not a setting Coplan reads: use ${known.join(', ')}.`);
  }
}

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
    // Comments are allowed, so the file can explain itself.
    raw = parseJsonc(readFileSync(file, 'utf8'));
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
  unknownKeys(rec, TOP_KEYS, '', config.errors);

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

  const iric = rec['iric'];
  if (iric !== undefined) {
    if (!iric || typeof iric !== 'object' || Array.isArray(iric)) config.errors.push('"iric" must be an object: { "review", "parallel", "maxRounds" }.');
    else {
      checkSettings(iric as Record<string, unknown>, config.errors);
      config.settings = cleanSettings(iric, DEFAULT_BUILD_SETTINGS);
    }
  }

  const branches = rec['branches'];
  if (branches !== undefined) {
    if (!branches || typeof branches !== 'object' || Array.isArray(branches)) config.errors.push('"branches" must be an object: { "base", "prefix" }.');
    else {
      const b = branches as Record<string, unknown>;
      unknownKeys(b, BRANCH_KEYS, 'branches.', config.errors);
      for (const key of BRANCH_KEYS) {
        const v = b[key];
        if (typeof v === 'string' && v.trim()) config.branches[key as 'base' | 'prefix'] = v.trim();
        else if (v !== undefined) config.errors.push(`"branches.${key}" must be a branch name.`);
      }
    }
  }
  return config;
}

/** What `cleanSettings` would quietly correct, said instead: a value it
 *  clamps or drops is not the build the file asked for. */
function checkSettings(rec: Record<string, unknown>, errors: string[]): void {
  unknownKeys(rec, IRIC_KEYS, 'iric.', errors);
  // What the build will actually use, so each error can say so.
  const used = cleanSettings(rec, DEFAULT_BUILD_SETTINGS);
  const review = rec['review'];
  if (review !== undefined && review !== used.review) {
    errors.push(`"iric.review" must be one of ${REVIEW_MODES.join(', ')}; ${JSON.stringify(review)} is not, so ${used.review} is used.`);
  }
  const whole = (key: 'parallel' | 'maxRounds', hi: number) => {
    const v = rec[key];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > hi) {
      errors.push(`"iric.${key}" must be a whole number from 1 to ${hi}; ${JSON.stringify(v)} is not, so ${used[key]} is used.`);
    }
  };
  whole('parallel', MAX_PARALLEL);
  whole('maxRounds', MAX_ROUNDS);
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
    if (typeof item !== 'string') unknownKeys(rec, HOOK_KEYS, `${where}.`, errors);
    let name = typeof rec['name'] === 'string' && rec['name'].trim() ? rec['name'].trim().slice(0, MAX_HOOK_NAME) : nameFor(run);
    for (let n = 2; out.some((h) => h.name === name); n++) name = `${name.replace(/ #\d+$/, '')} #${n}`;
    const hook: CheckHook = { name, run };
    const timeout = rec['timeout'];
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 1) {
      // Too long is still long: the most allowed, said — not the default,
      // which would stop a long suite early.
      hook.timeout = Math.min(MAX_HOOK_TIMEOUT, Math.round(timeout));
      if (timeout > MAX_HOOK_TIMEOUT) errors.push(`"${where}.timeout" is at most ${MAX_HOOK_TIMEOUT} seconds; ${MAX_HOOK_TIMEOUT} is used.`);
    } else if (timeout !== undefined) {
      errors.push(`"${where}.timeout" must be seconds, from 1 to ${MAX_HOOK_TIMEOUT}; the default ${DEFAULT_HOOK_TIMEOUT} is used.`);
    }
    const rawPaths = rec['paths'];
    const paths = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
    if (rawPaths !== undefined && (!Array.isArray(rawPaths) || paths.length !== rawPaths.length)) {
      // A hook whose limit was lost would run for every task — or, worse, a
      // limit read wrong would skip it: either way, say so.
      errors.push(`"${where}.paths" must be a list of globs, e.g. ["src/**", "*.py"].`);
    }
    if (paths.length) hook.paths = paths.map((p) => p.trim());
    if (rec['optional'] === true) hook.optional = true;
    else if (rec['optional'] !== undefined && rec['optional'] !== false) errors.push(`"${where}.optional" must be true or false.`);
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
  return config.hooks[stage].filter((h) => !h.paths?.length || !files?.length || files.some((f) => pathsMatch(h.paths!, f)));
}

/** A file is in a hook's `paths` when a glob matches it and no `!glob`
 *  takes it back out: `["src/**", "!src/gen/**"]`. Only `!globs` means
 *  everything but those. */
export function pathsMatch(paths: readonly string[], file: string): boolean {
  const take = paths.filter((p) => !p.startsWith('!'));
  const drop = paths.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  return (take.length === 0 || take.some((p) => globMatch(p, file))) && !drop.some((p) => globMatch(p, file));
}

export function hasHooks(config: ProjectConfig): boolean {
  return HOOK_STAGES.some((s) => config.hooks[s].length > 0);
}

/**
 * A small glob: `**` crosses directories, `*` and `?` do not, and `{a,b}`
 * is either. A pattern without a slash matches a file's name anywhere
 * (`*.ts`); one ending in a slash matches everything under that directory
 * (`src/`).
 */
export function globMatch(pattern: string, file: string): boolean {
  return expandBraces(pattern).some((p) => matchOne(p, file));
}

/** `src/**\/*.{ts,tsx}` → `src/**\/*.ts`, `src/**\/*.tsx`; nested braces too.
 *  An unclosed brace is left as it is, and matched literally. */
export function expandBraces(pattern: string, limit = 64): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0;
  const cuts: number[] = [];
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      close = i;
      break;
    } else if (c === ',' && depth === 1) cuts.push(i);
  }
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...cuts, close];
  const options = bounds.slice(0, -1).map((b, i) => pattern.slice(b + 1, bounds[i + 1]));
  const out: string[] = [];
  for (const option of options) {
    for (const p of expandBraces(head + option + tail, limit)) {
      if (out.length >= limit) return out;
      out.push(p);
    }
  }
  return out;
}

function matchOne(pattern: string, file: string): boolean {
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
