import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ReviewMode, TaskCheck } from './types.ts';
import { DEFAULT_REVIEW, validReview } from './build.ts';
import { REVIEW_MODES } from './types.ts';
import { parseJsonc } from './jsonc.ts';
import { GAP_RULES, GAP_SEVERITIES, type GapRule, type GapSeverity } from './check.ts';
import { paths } from './paths.ts';
import type { BlockSource } from './blocks.ts';

/**
 * A repository's own Coplan settings: `.coplan/config.json`, committed with
 * the code so everyone who builds there — people, Claude, the subagents it
 * hands tasks to — runs the same checks.
 *
 * It answers the question every agent otherwise guesses at: *what do I run
 * to know this change is good?* The answer is `checks`, each task's
 * definition of done, by stage:
 *
 * - `implement` — quick checks after each change: typecheck, lint, format.
 * - `review` — what a task must pass to be done: the tests.
 * - `final` — once every task is done, before the final report: the full
 *   suite, the build.
 *
 * Coplan never runs these itself. They are handed to the harness in the
 * handoff and each brief, which runs them as any other command — under the
 * user's own permission settings — or all at once with `coplan check <stage>`.
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
  /** The hook's area (globs, e.g. `src/**`, `*.py`): it runs only when the
   *  change touches a matching file. */
  paths?: string[];
  /** A failure is reported but does not hold the task back. */
  optional?: boolean;
  /** Where it runs, from the repository root: a package of a monorepo. */
  cwd?: string;
  /** Variables set for it, on top of the environment it runs in. */
  env?: Record<string, string>;
}

/** Where a repository or a user may add words to what the agent is told. */
export const INSTRUCTION_POINTS = ['design', 'handoff', 'brief'] as const;
export type InstructionPoint = (typeof INSTRUCTION_POINTS)[number];
/** Points older versions read, and where their words go now: for one
 *  release, said with a warning. */
const OLD_POINTS: Record<string, InstructionPoint> = { build: 'handoff', review: 'brief' };

export interface ProjectConfig {
  /** Where it was read from; null when the repository has none. */
  file: string | null;
  /** The checks (`checks`, or `hooks` before 0.4), by stage. */
  hooks: Record<HookStage, CheckHook[]>;
  /** The review a task asks for when it does not say. */
  review: ReviewMode;
  branches: {
    /** The branch work is cut from and merged back into. */
    base?: string;
    /** Put in front of every branch a plan names, e.g. `coplan/`. */
    prefix?: string;
  };
  /** What the build's pull requests say: the harness opens them. */
  pullRequests: {
    /** The body to fill in for each pull request, read from its file. */
    template?: string;
    /** That file, as the config names it. */
    templateFile?: string;
  };
  /** Words added to what the agent is told, per point: the user's global
   *  ones first, then the repository's. */
  instructions: Partial<Record<InstructionPoint, string>>;
  /** Plan-check rules counted other than the default (`warn`). */
  planCheck: Partial<Record<GapRule, GapSeverity>>;
  /** The user-wide layer (`coplan.json` in Coplan's home), when there is one. */
  globalFile?: string | null;
  /** What could not be read, said rather than silently ignored: a hook
   *  that is quietly dropped is a check nobody runs. */
  errors: string[];
  /** What was read but taken differently than written, and said: text cut
   *  to its limit, a folder that is not there yet, anything amiss in the
   *  user's own layer. The checks still run. */
  warnings: string[];
  /** Every file the config was read from or looked for: while none of them
   *  changes, neither does the config. */
  sources?: string[];
  /** Which file set each setting, by key (`review`,
   *  `instructions.handoff`): the one that won, or — for instructions, which
   *  add up — each that added to it, the user's first. A key no file sets
   *  is not here: Coplan's default is used. Files in the user's home are
   *  named from `~`, the repository's from its root. */
  origins?: Record<string, string[]>;
  /** The checks themselves cannot be trusted: the file is unreadable, or
   *  `checks` (or a top-level key, often a misspelt `checks`) is wrong. Only
   *  this stops `coplan check`; an error elsewhere is said, and the checks
   *  still run. */
  checksBroken?: boolean;
}

export const PROJECT_CONFIG_PATH = path.join('.coplan', 'config.json');
/** The user's own layer, under every repository's: in Coplan's home. */
export const GLOBAL_PROJECT_FILE = 'coplan.json';
/** Beside it: the user's own words, one file per point. */
export const INSTRUCTIONS_DIR = 'instructions';
export const DEFAULT_HOOK_TIMEOUT = 600;
export const MAX_HOOK_TIMEOUT = 3600;
export const MAX_HOOKS = 20;
export const MAX_HOOK_NAME = 60;
export const MAX_INSTRUCTIONS = 4_000;
export const MAX_TEMPLATE = 8_000;
const MAX_ENV = 20;

export const PROJECT_KEYS = ['checks', 'review', 'branches', 'pullRequests', 'instructions', 'planCheck'];
/** Keys older versions read, by where they sit: an old file still holding
 *  them loads, with a warning that they do nothing now. `hooks` is read as
 *  `checks`, and `iric.review` as `review`, for one release. */
const RETIRED_KEYS = ['runners', 'final', 'mode'];
const ALIAS_KEYS = ['hooks', 'iric'];
const RETIRED_PR_KEYS = ['watch', 'on', 'tool', 'open'];
const BRANCH_KEYS = ['base', 'prefix'];
const PR_KEYS = ['template'];
export const HOOK_KEYS = ['name', 'run', 'timeout', 'paths', 'optional', 'cwd', 'env'];

/** A key the file sets that nothing reads is most often a typo of one that
 *  is: said, so the setting the user meant is not silently lost. */
function unknownKeys(rec: Record<string, unknown>, known: string[], where: string, errors: string[], retired: string[] = [], warnings: string[] = []): void {
  for (const key of Object.keys(rec)) {
    if (retired.includes(key)) warnings.push(`${where}"${key}" is no longer read: Coplan plans and tracks, and the harness that builds decides this. Remove it.`);
    else if (!known.includes(key)) errors.push(`${where}"${key}" is not a setting Coplan reads: use ${known.join(', ')}.`);
  }
}

export function emptyProjectConfig(): ProjectConfig {
  return {
    file: null,
    hooks: { implement: [], review: [], final: [] },
    review: DEFAULT_REVIEW,
    branches: {},
    pullRequests: {},
    instructions: {},
    planCheck: {},
    errors: [],
    warnings: [],
    origins: {},
  };
}

function readConfigFile(file: string, label: string, errors: string[]): unknown {
  if (!existsSync(file)) return undefined;
  try {
    // Comments are allowed, so the file can explain itself.
    return parseJsonc(readFileSync(file, 'utf8'));
  } catch (err) {
    errors.push(`${label} could not be read: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * The repository's config over the user's own, or an empty one. Never throws.
 *
 * `globalDir` is Coplan's home: its `coplan.json` sets the user's defaults
 * for every repository (anything but the checks, which belong to the
 * repository), and `instructions/<point>.md` add the user's own words.
 */
export function loadProjectConfig(root: string | null | undefined, opts: { globalDir?: string | null } = {}): ProjectConfig {
  const globalDir = opts.globalDir === undefined ? paths.configDir() : opts.globalDir;
  const errors: string[] = [];
  const warnings: string[] = [];
  const layers: Layer[] = [];
  const sources: string[] = [];
  reading = sources;
  try {
    let globalFile: string | null = null;
    if (globalDir) {
      const file = path.join(globalDir, GLOBAL_PROJECT_FILE);
      sources.push(file, ...[...INSTRUCTION_POINTS, ...Object.keys(OLD_POINTS)].map((p) => path.join(globalDir, INSTRUCTIONS_DIR, `${p}.md`)));
      if (existsSync(file)) globalFile = file;
      // What is wrong with the user's own layer is said, but holds back no
      // repository's checks: they are the repository's, and run as it says.
      const raw = readConfigFile(file, file, warnings);
      if (raw !== undefined) layers.push({ ...parseLayer(raw, { label: file, base: globalDir, global: true }, warnings, warnings), from: displayPath(file) });
      const dir = path.join(globalDir, INSTRUCTIONS_DIR);
      const { words, from } = instructionFiles(dir, warnings, warnings);
      if (Object.keys(words).length) layers.push({ instructions: words, instructionsFrom: from });
    }
    let file: string | null = null;
    let broken = false;
    if (root) {
      const repoFile = path.join(root, PROJECT_CONFIG_PATH);
      sources.push(repoFile);
      if (existsSync(repoFile)) {
        file = repoFile;
        const raw = readConfigFile(repoFile, PROJECT_CONFIG_PATH, errors);
        if (raw === undefined) broken = true;
        else layers.push({ ...parseLayer(raw, { label: PROJECT_CONFIG_PATH, base: root, global: false }, errors, warnings), from: PROJECT_CONFIG_PATH });
      }
    }
    broken ||= layers.some((l) => l.checksBroken);
    return { ...combine(layers), file, globalFile, errors, warnings, sources, ...(broken ? { checksBroken: true } : {}) };
  } finally {
    reading = null;
  }
}

/** The files the load in progress has read, for `sources`. Loading is
 *  synchronous, so one at a time. */
let reading: string[] | null = null;

/** What a hook's folder is — watched like a file the config read, so the
 *  folder appearing reads the config again (and drops the warning). */
function folderAt(dir: string): 'folder' | 'file' | 'missing' {
  reading?.push(dir);
  try {
    const stat = statSync(dir, { throwIfNoEntry: false });
    return !stat ? 'missing' : stat.isDirectory() ? 'folder' : 'file';
  } catch {
    return 'missing';
  }
}

/** The repository's config from what its file holds. */
export function parseProjectConfig(raw: unknown, file: string | null = null): ProjectConfig {
  const errors: string[] = [];
  const warnings: string[] = [];
  // A config's files are named from the repository root, which holds `.coplan/`.
  const base = file ? path.dirname(path.dirname(file)) : null;
  const layer = { ...parseLayer(raw, { label: PROJECT_CONFIG_PATH, base, global: false }, errors, warnings), from: PROJECT_CONFIG_PATH };
  return { ...combine([layer]), file, errors, warnings, ...(layer.checksBroken ? { checksBroken: true } : {}) };
}

/** One file's settings, each checked, before the layers are put together. */
interface Layer {
  hooks?: Partial<Record<HookStage, CheckHook[]>>;
  review?: ReviewMode;
  branches?: ProjectConfig['branches'];
  pullRequests?: Partial<ProjectConfig['pullRequests']>;
  instructions?: ProjectConfig['instructions'];
  planCheck?: ProjectConfig['planCheck'];
  /** See ProjectConfig.checksBroken. */
  checksBroken?: boolean;
  /** The file it was read from, as origins name it. */
  from?: string;
  /** For the user's instruction files: the file each point was read from. */
  instructionsFrom?: Partial<Record<InstructionPoint, string[]>>;
}

interface LayerContext {
  /** How errors name the file. */
  label: string;
  /** Where the files it names are found; null when it is not on disk. */
  base: string | null;
  /** The user's own layer: everything but the checks. */
  global: boolean;
}

/** Later layers win key by key; instructions add up, the user's first. */
function combine(layers: Layer[]): Omit<ProjectConfig, 'file' | 'errors' | 'warnings'> {
  const out = emptyProjectConfig();
  const origins: Record<string, string[]> = {};
  for (const l of layers) {
    if (l.review) {
      out.review = l.review;
      if (l.from) origins['review'] = [l.from];
    }
    // Which file set each key: the last to set it wins, as its value does.
    const from = (section: string, rec: object | undefined, keys: readonly string[] = Object.keys(rec ?? {})) => {
      if (!l.from || !rec) return;
      for (const key of keys) if ((rec as Record<string, unknown>)[key] !== undefined) origins[`${section}.${key}`] = [l.from];
    };
    for (const stage of HOOK_STAGES) if (l.hooks?.[stage]) out.hooks[stage] = l.hooks[stage]!;
    from('checks', l.hooks);
    Object.assign(out.branches, l.branches);
    from('branches', l.branches);
    Object.assign(out.pullRequests, l.pullRequests);
    from('pullRequests', l.pullRequests, ['template']);
    Object.assign(out.planCheck, l.planCheck);
    from('planCheck', l.planCheck);
    for (const point of INSTRUCTION_POINTS) {
      const words = l.instructions?.[point];
      if (words) out.instructions[point] = out.instructions[point] ? `${out.instructions[point]}\n\n${words}` : words;
      const files = l.instructionsFrom?.[point] ?? (l.from ? [l.from] : []);
      if (words && files.length) origins[`instructions.${point}`] = [...(origins[`instructions.${point}`] ?? []), ...files];
    }
  }
  out.origins = origins;
  const { file: _f, errors: _e, warnings: _w, ...rest } = out;
  return rest;
}

/**
 * Where a setting a prompt names comes from: the files that set `key` —
 * or, for a group (`pullRequests`, `checks`), any key under it. No files:
 * nothing sets it, and Coplan's default is used.
 */
export function configSource(project: ProjectConfig, key: string): BlockSource {
  const origins = project.origins ?? {};
  const files = origins[key] ?? [...new Set(Object.entries(origins).flatMap(([k, f]) => (k.startsWith(`${key}.`) ? f : [])))];
  return { kind: 'config', key, files };
}

/** A file in the user's home, named from `~`: shorter, and the same
 *  whoever reads it. */
function displayPath(file: string): string {
  const home = homedir();
  return home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file;
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function parseLayer(raw: unknown, ctx: LayerContext, errors: string[], warnings: string[]): Layer {
  const layer: Layer = {};
  const say = (message: string) => errors.push(ctx.global ? `${ctx.label}: ${message}` : message);
  if (!isRecord(raw)) {
    say(`${ctx.global ? 'it' : PROJECT_CONFIG_PATH} must hold an object.`);
    if (!ctx.global) layer.checksBroken = true;
    return layer;
  }
  const local: string[] = [];
  const notes: string[] = [];
  // `iric.review` stands in for a `review` that is not a mode this release: said once, below.
  const iric = isRecord(raw['iric']) && typeof raw['review'] !== 'string' ? raw['iric']['review'] : undefined;
  const iricReview = validReview(iric);
  unknownKeys(Object.fromEntries(Object.entries(raw).filter(([k]) => !ALIAS_KEYS.includes(k))), PROJECT_KEYS, '', local, RETIRED_KEYS, notes);

  // `hooks` is the name `checks` had before 0.4: read for one release.
  const named = raw['checks'] !== undefined ? 'checks' : raw['hooks'] !== undefined ? 'hooks' : null;
  if (raw['hooks'] !== undefined && !ctx.global) {
    notes.push(
      named === 'checks'
        ? '"hooks" and "checks" are both set: "checks" is used. "hooks" is the old name; remove it.'
        : '"hooks" is now "checks": it is read for this release. Rename it.',
    );
  }
  const hooks = named ? raw[named] : undefined;
  if (named && hooks !== undefined) {
    if (ctx.global) {
      notes.push(`"${named}" belong to each repository (.coplan/config.json), not to every one: they are ignored here.`);
    } else if (!isRecord(hooks)) {
      local.push(`"${named}" must map a stage (implement, review, final) to a list of commands.`);
    } else {
      layer.hooks = {};
      for (const [stage, list] of Object.entries(hooks)) {
        if (!(HOOK_STAGES as readonly string[]).includes(stage)) {
          local.push(`"${named}.${stage}" is not a stage: use ${HOOK_STAGES.join(', ')}.`);
          continue;
        }
        layer.hooks[stage as HookStage] = parseHooks(list, stage, local, ctx.base, notes, named);
      }
    }
  }
  if (local.length && !ctx.global) layer.checksBroken = true;

  const section = (key: string, shape: string): Record<string, unknown> | null => {
    const v = raw[key];
    if (v === undefined) return null;
    if (!isRecord(v)) {
      local.push(`"${key}" must be an object: ${shape}.`);
      return null;
    }
    return v;
  };

  // The review a task asks for by default: `review`, or — for one release —
  // the old `iric.review`. Before 0.4 `review` was an object (`review.model`).
  const review = raw['review'];
  if (typeof review === 'string') {
    const value = validReview(review);
    if (value) layer.review = value;
    else local.push(`"review" must be one of ${REVIEW_MODES.join(', ')}; ${JSON.stringify(review)} is not, so ${DEFAULT_REVIEW} is used.`);
  } else if (isRecord(review)) {
    notes.push('"review" as an object (review.model) is no longer read: the harness picks its models. Set "review" to agent, user or none, or remove it.');
  } else if (review !== undefined) {
    local.push(`"review" must be one of ${REVIEW_MODES.join(', ')}.`);
  }
  if (iric !== undefined && !iricReview) local.push(`"iric.review" must be one of ${REVIEW_MODES.join(', ')}; ${JSON.stringify(iric)} is not, so ${DEFAULT_REVIEW} is used.`);
  if (iricReview) {
    layer.review = iricReview;
    notes.push(`"iric.review" is read as "review": "${iricReview}" for this release, and the rest of "iric" is no longer read. Set "review" instead, and remove "iric".`);
  } else if (raw['iric'] !== undefined) {
    notes.push('"iric" is no longer read: Coplan plans and tracks, and the harness that builds decides this. Remove it. Only "iric.review" is still read this release, as "review" where that is not set to a mode.');
  }

  const branches = section('branches', '{ "base", "prefix" }');
  if (branches) {
    unknownKeys(branches, BRANCH_KEYS, 'branches.', local);
    layer.branches = {};
    for (const key of BRANCH_KEYS) {
      const v = branches[key];
      if (typeof v === 'string' && v.trim()) layer.branches[key as 'base' | 'prefix'] = v.trim();
      else if (v !== undefined) local.push(`"branches.${key}" must be a branch name.`);
    }
  }

  const prs = section('pullRequests', '{ "template" }');
  if (prs) {
    unknownKeys(prs, PR_KEYS, 'pullRequests.', local, RETIRED_PR_KEYS, notes);
    layer.pullRequests = {};
    if (prs['template'] !== undefined) {
      const text = typeof prs['template'] === 'string' ? readNamedFile(prs['template'], ctx.base, 'pullRequests.template', MAX_TEMPLATE, local, notes) : null;
      if (typeof prs['template'] !== 'string') local.push('"pullRequests.template" must name a file, e.g. ".github/pull_request_template.md".');
      if (text !== null) {
        layer.pullRequests.template = text;
        // The repository's by its path in it; the user's own by where it is.
        layer.pullRequests.templateFile = ctx.global ? path.join(ctx.base!, (prs['template'] as string).trim()) : (prs['template'] as string).trim();
      }
    }
  }


  const instructions = section('instructions', `{ ${INSTRUCTION_POINTS.map((p) => `"${p}"`).join(', ')} }, each text or { "file" }`);
  if (instructions) {
    unknownKeys(instructions, [...INSTRUCTION_POINTS, ...Object.keys(OLD_POINTS)], 'instructions.', local);
    layer.instructions = {};
    // The current points first, so an old one's words come after them.
    for (const name of [...INSTRUCTION_POINTS, ...Object.keys(OLD_POINTS)]) {
      const v = instructions[name];
      if (v === undefined) continue;
      const point = OLD_POINTS[name] ?? (name as InstructionPoint);
      if (OLD_POINTS[name]) notes.push(`"instructions.${name}" is now "instructions.${point}": it is read there for this release. Rename it.`);
      const where = `instructions.${name}`;
      let text: string | null = null;
      if (typeof v === 'string') text = v.trim();
      else if (isRecord(v) && typeof v['file'] === 'string' && Object.keys(v).length === 1) text = readNamedFile(v['file'], ctx.base, where, MAX_INSTRUCTIONS, local, notes);
      else local.push(`"${where}" must be text, or { "file": "path" }.`);
      if (text) text = capped(text, `"${where}"`, notes);
      if (text) layer.instructions[point] = layer.instructions[point] ? capped(`${layer.instructions[point]}\n\n${text}`, `"instructions.${point}" and "${where}" together`, notes) : text;
    }
  }

  const planCheck = section('planCheck', `{ "<rule>": ${GAP_SEVERITIES.map((s) => `"${s}"`).join(' | ')} }`);
  if (planCheck) {
    layer.planCheck = {};
    for (const [rule, value] of Object.entries(planCheck)) {
      if (!(GAP_RULES as readonly string[]).includes(rule)) {
        local.push(`"planCheck.${rule}" is not a plan-check rule: use ${GAP_RULES.join(', ')}.`);
        continue;
      }
      const severity = oneOf(value, GAP_SEVERITIES, `planCheck.${rule}`, local);
      if (severity) layer.planCheck[rule as GapRule] = severity;
    }
  }

  for (const message of local) say(message);
  for (const message of notes) warnings.push(ctx.global ? `${ctx.label}: ${message}` : message);
  return layer;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string, errors: string[]): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly unknown[]).includes(value)) return value as T;
  errors.push(`"${where}" must be one of ${allowed.join(', ')}; ${JSON.stringify(value)} is not.`);
  return undefined;
}

/**
 * A file a config names, read — kept inside the folder the config belongs
 * to (the repository, or Coplan's home), so a committed config cannot pull
 * someone's private files into what the agent is told.
 */
function readNamedFile(name: string, base: string | null, where: string, max: number, errors: string[], warnings: string[]): string | null {
  const rel = name.trim();
  if (!base) {
    errors.push(`"${where}" names a file, but this config is not read from disk.`);
    return null;
  }
  // Both sides normalized: git names a Windows root with forward slashes,
  // and path.resolve answers with back ones.
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  if (!rel || path.isAbsolute(rel) || (full !== root && !full.startsWith(root + path.sep))) {
    errors.push(`"${where}" must name a file inside ${base}: ${JSON.stringify(name)} is not.`);
    return null;
  }
  reading?.push(full);
  try {
    // Where it really is: a link committed inside the repository may point
    // anywhere, and reading follows it.
    const realBase = realpathSync(base);
    const real = realpathSync(full);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      errors.push(`"${where}" must name a file inside ${base}: ${rel} links to one outside it.`);
      return null;
    }
    const text = readFileSync(real, 'utf8').trim();
    if (text.length > max) {
      warnings.push(`"${where}" (${rel}) is longer than ${max} characters; the rest is cut.`);
      return text.slice(0, max);
    }
    return text;
  } catch (err) {
    errors.push(`"${where}" names ${rel}, which could not be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.`);
    return null;
  }
}

/** Instructions joined past their limit are cut to it, said as one cut alone is. */
function capped(text: string, where: string, warnings: string[]): string {
  if (text.length <= MAX_INSTRUCTIONS) return text;
  warnings.push(`${where} is longer than ${MAX_INSTRUCTIONS} characters; the rest is cut.`);
  return text.slice(0, MAX_INSTRUCTIONS);
}

/** `instructions/<point>.md` in Coplan's home: the user's own words, and the files each point was read from. */
function instructionFiles(dir: string, errors: string[], warnings: string[]): { words: ProjectConfig['instructions']; from: Partial<Record<InstructionPoint, string[]>> } {
  const words: ProjectConfig['instructions'] = {};
  const from: Partial<Record<InstructionPoint, string[]>> = {};
  for (const name of [...INSTRUCTION_POINTS, ...Object.keys(OLD_POINTS)]) {
    const file = path.join(dir, `${name}.md`);
    if (!existsSync(file)) continue;
    const point = OLD_POINTS[name] ?? (name as InstructionPoint);
    if (OLD_POINTS[name]) warnings.push(`${file}: ${name}.md is now ${point}.md; it is read as that for this release. Rename it.`);
    const text = readNamedFile(`${name}.md`, dir, `${file}`, MAX_INSTRUCTIONS, errors, warnings);
    if (!text) continue;
    words[point] = words[point] ? capped(`${words[point]}\n\n${text}`, `${[...from[point]!, displayPath(file)].join(' and ')} together`, warnings) : text;
    from[point] = [...(from[point] ?? []), displayPath(file)];
  }
  return { words, from };
}

function parseHooks(list: unknown, stage: string, errors: string[], root: string | null = null, warnings: string[] = errors, key = 'checks'): CheckHook[] {
  const items = Array.isArray(list) ? list : [list];
  const out: CheckHook[] = [];
  items.slice(0, MAX_HOOKS).forEach((item, i) => {
    const hook = parseHook(item, `${key}.${stage}[${i}]`, errors, root, warnings);
    if (!hook) return;
    for (let n = 2; out.some((h) => h.name === hook.name); n++) hook.name = `${hook.name.replace(/ #\d+$/, '')} #${n}`;
    out.push(hook);
  });
  if (items.length > MAX_HOOKS) warnings.push(`"${key}.${stage}" has more than ${MAX_HOOKS} commands; the rest are ignored.`);
  return out;
}

/** One hook: a command, or `{ name, run, … }`; null, said, when it has no command. */
function parseHook(item: unknown, where: string, errors: string[], root: string | null, warnings: string[]): CheckHook | null {
  const rec = typeof item === 'string' ? { run: item } : item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
  const run = typeof rec?.['run'] === 'string' ? rec['run'].trim() : '';
  if (!rec || !run) {
    errors.push(`"${where}" needs a command: a string, or { "name", "run" }.`);
    return null;
  }
  if (typeof item !== 'string') unknownKeys(rec, HOOK_KEYS, `${where}.`, errors);
  const name = typeof rec['name'] === 'string' && rec['name'].trim() ? rec['name'].trim().slice(0, MAX_HOOK_NAME) : nameFor(run);
  const hook: CheckHook = { name, run };
  const timeout = rec['timeout'];
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 1) {
    // Too long is still long: the most allowed, said — not the default,
    // which would stop a long suite early.
    hook.timeout = Math.min(MAX_HOOK_TIMEOUT, Math.round(timeout));
    if (timeout > MAX_HOOK_TIMEOUT) warnings.push(`"${where}.timeout" is at most ${MAX_HOOK_TIMEOUT} seconds; ${MAX_HOOK_TIMEOUT} is used.`);
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
  const cwd = rec['cwd'];
  if (cwd !== undefined) {
    let at: ReturnType<typeof folderAt> | undefined;
    const rel = typeof cwd === 'string' ? cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '') : '';
    // Inside the repository: a check runs where its code is, nowhere else.
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) {
      errors.push(`"${where}.cwd" must be a folder inside the repository, e.g. "packages/api".`);
    } else if (root && (at = folderAt(path.join(root, rel))) !== 'folder') {
      // Kept: run anywhere else, it would pass without checking what it is for.
      warnings.push(
        at === 'file'
          ? `"${where}.cwd" names ${rel}, which is a file, not a folder: the hook fails until it is one.`
          : `"${where}.cwd" names ${rel}, which does not exist yet: the hook checks changes under it, so it runs once there are some — and fails while the folder is missing.`,
      );
      hook.cwd = rel;
    } else if (rel !== '.') hook.cwd = rel;
  }
  const env = rec['env'];
  if (env !== undefined) {
    const entries = env && typeof env === 'object' && !Array.isArray(env) ? Object.entries(env as Record<string, unknown>) : null;
    const good = entries?.filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') ?? [];
    if (!entries || good.length !== entries.length) errors.push(`"${where}.env" must map variable names to text, e.g. { "NODE_ENV": "test" }.`);
    if (good.length > MAX_ENV) warnings.push(`"${where}.env" sets more than ${MAX_ENV} variables; the rest are ignored.`);
    if (good.length) hook.env = Object.fromEntries(good.slice(0, MAX_ENV)) as Record<string, string>;
  }
  return hook;
}

/**
 * A hook as one command an agent can run from the repository root: its
 * folder and variables included. A subshell, so the `cd` does not stay;
 * `env … sh -c`, so the variables reach every part of a compound command.
 */
export function hookCommand(hook: CheckHook): string {
  const vars = Object.entries(hook.env ?? {});
  const run = vars.length ? `env ${vars.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')} sh -c ${shellQuote(hook.run)}` : hook.run;
  return hook.cwd ? `(cd ${shellQuote(hook.cwd)} && ${run})` : run;
}

/** `text` as one word for `sh`: as it is when it is plain, else quoted. */
export function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
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
 * The hooks of one stage a task is expected to need, from the files it
 * plans to touch — what its brief lists before there is a change, and what
 * holds where git cannot say. A task that lists no files gets every hook,
 * since nobody can say it does not. Once there is a change, the hooks for
 * it are `hooksForChange`'s.
 */
export function hooksFor(config: ProjectConfig, stage: HookStage, files?: readonly string[]): CheckHook[] {
  return config.hooks[stage].filter((h) => {
    const scope = hookScope(h);
    return !scope || !files?.length || files.some((f) => pathsMatch(scope, f));
  });
}

/**
 * The area a hook checks: its `paths`, or — a hook run in a folder of its
 * own (`cwd`, a package of a monorepo) — everything under that folder.
 * Null for a hook that checks the whole repository.
 */
export function hookScope(h: Pick<CheckHook, 'paths' | 'cwd'>): string[] | null {
  if (h.paths?.length) return h.paths;
  if (h.cwd) return [`${h.cwd.replace(/\/+$/, '')}/`];
  return null;
}

/** The changed files in a hook's area: every one, for a whole-repository hook. */
export function filesInScope(h: Pick<CheckHook, 'paths' | 'cwd'>, files: readonly string[]): string[] {
  const scope = hookScope(h);
  return scope ? files.filter((f) => pathsMatch(scope, f)) : [...files];
}

/**
 * The checks a change calls for at a stage: those whose area it touched.
 * A check for an area the change never came near does not run, and when
 * nothing changed, nothing does — every check is targeted.
 */
export function hooksForChange(config: ProjectConfig, stage: HookStage, changed: readonly string[]): CheckHook[] {
  return config.hooks[stage].filter((h) => filesInScope(h, changed).length > 0);
}

/** Past this many files `{files}` stands for the whole repository (`.`),
 *  rather than a command line too long for the shell. */
export const MAX_FILES_ARG = 1_000;

/**
 * A hook's command with `{files}` filled in: the changed files in its area,
 * each quoted for the shell — so `eslint {files}` lints only what changed.
 * Where the change is not known, or is too large to list, `.`: the whole
 * repository, as the command would check without it.
 */
export function withFiles(run: string, files: readonly string[] | null): string {
  if (!run.includes('{files}')) return run;
  const list = files && files.length && files.length <= MAX_FILES_ARG ? files.map((f) => `'${(f.startsWith('-') ? `./${f}` : f).replace(/'/g, `'\\''`)}'`).join(' ') : '.';
  return run.split('{files}').join(list);
}

/**
 * One task's checks at a stage (#54): the repository's for its files,
 * less the ones the user skipped for it, plus the ones they added for it.
 * What its brief lists, what `done` waits on.
 */
export function taskHooks(
  config: ProjectConfig,
  stage: HookStage,
  files: readonly string[] | undefined,
  own: { add: readonly TaskCheck[]; skip: readonly string[] },
  /** `files` is what the change touched, so the checks are targeted to it:
   *  none for an area it did not touch, none at all when it touched nothing. */
  opts: { changed?: boolean } = {},
): CheckHook[] {
  const repo = (opts.changed ? hooksForChange(config, stage, files ?? []) : hooksFor(config, stage, files)).filter((h) => !own.skip.includes(h.name));
  const added = own.add.filter((c) => c.stage === stage && !repo.some((h) => h.name === c.name) && (!opts.changed || Boolean(files?.length)));
  return [...repo, ...added.map((c) => ({ name: c.name, run: c.run, ...(c.optional ? { optional: true } : {}) }))];
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
