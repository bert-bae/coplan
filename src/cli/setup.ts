/**
 * `coplan setup` — the second half of `./setup.sh`, run once the build is in
 * place: install Coplan in the agents you pick, then walk through its
 * settings. Run `./setup.sh` again after `git pull` to update.
 *
 *   coplan setup [--yes] [--agents claude,codex,cursor|none]
 *
 * Every agent copies what it is pointed at, and the clone holds about 150 MB
 * of build-time packages, so the agents are pointed at a staged copy that
 * holds only what runs: `.plugin/` in the clone, about 5 MB. Claude Code
 * reads that folder in place; Codex and Cursor take a copy of it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, globalConfigFile, mergeConfig, type HarnessConfig } from '../shared/config.ts';
import { parseJsonc, stripJsonc } from '../shared/jsonc.ts';
import { DEFAULT_BUILD_SETTINGS, MAX_PARALLEL, MAX_ROUNDS } from '../shared/build.ts';
import { GLOBAL_PROJECT_FILE, HOOK_STAGES, PROJECT_CONFIG_PATH, PR_OPEN, PR_TOOLS, loadProjectConfig } from '../shared/project.ts';
import { REVIEW_MODES } from '../shared/types.ts';
import { AGENTS, AGENT_KINDS, type AgentKind } from '../shared/agents.ts';
import { paths, readVerifiedLock } from '../shared/paths.ts';
import { baseBranch, detectHooks, renderConfig } from './init.ts';
import { repoRootOf } from './check.ts';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0';

/** The clone this CLI was built in: `dist/cli/main.js` is two levels down. */
const CLONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The plugin and its marketplace are both named `coplan`. */
const PLUGIN_ID = 'coplan@coplan';

/** What an installed Coplan runs from, copied into the staged plugin. */
export const STAGED = ['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.mcp.json', 'bin', 'commands', 'hooks', 'mcp', 'skills', 'LICENSE', 'README.md'];
/** The build output, without its tests. */
export const STAGED_DIST = ['cli', 'daemon', 'mcp', 'ui', 'version.json'];
/** The staged plugin's note of the clone it came from, so an installed copy
 *  can say where to run `./setup.sh` again. */
export const INSTALL_FILE = 'install.json';
/** The staged plugin, in the clone. */
export const STAGE_DIR = '.plugin';

export interface RunResult {
  ok: boolean;
  /** What it printed to stdout. */
  stdout: string;
  /** stdout and stderr together, to show when it fails. */
  out: string;
}

export interface SetupIo {
  /** Ask, and return the answer. Absent: nothing is asked, and every
   *  question takes its default. */
  ask?: (question: string) => Promise<string>;
  say: (line: string) => void;
  /** Run a command, never throwing. */
  run: (command: string, args: string[]) => RunResult;
}

export interface SetupOptions {
  /** The clone: what is built, and staged from. */
  root: string;
  /** Where the staged plugin goes. */
  stage: string;
  /** The user's home, which holds Cursor's local plugins. */
  home: string;
  /** Coplan's home, which holds `config.json` and `coplan.json`. */
  coplanHome: string;
  /** The agents to install in, chosen up front (`--agents`). Unset: asked,
   *  or, with nothing asked, every agent found. */
  agents?: AgentKind[];
}

export interface SetupResult {
  /** The agents Coplan was installed in. */
  installed: AgentKind[];
  /** What went wrong, each said where it happened. */
  failed: string[];
}

/* ---------------- questions ---------------- */

const TRIES = 3;

async function answer(io: SetupIo, question: string): Promise<string | null> {
  if (!io.ask) return null;
  return (await io.ask(question)).trim();
}

export async function yesNo(io: SetupIo, question: string, dflt: boolean): Promise<boolean> {
  for (let i = 0; i < TRIES; i++) {
    const a = await answer(io, `${question} ${dflt ? '[Y/n]' : '[y/N]'} `);
    if (a === null || a === '') return dflt;
    if (/^(y|yes)$/i.test(a)) return true;
    if (/^(n|no)$/i.test(a)) return false;
    io.say('  Answer y or n.');
  }
  return dflt;
}

export async function choose<T extends string>(io: SetupIo, question: string, options: readonly T[], dflt: T): Promise<T> {
  for (let i = 0; i < TRIES; i++) {
    const a = await answer(io, `${question} (${options.join('/')}) [${dflt}] `);
    if (a === null || a === '') return dflt;
    const hit = options.find((o) => o === a.toLowerCase());
    if (hit) return hit;
    io.say(`  Answer one of: ${options.join(', ')}.`);
  }
  return dflt;
}

export async function whole(io: SetupIo, question: string, min: number, max: number, dflt: number): Promise<number> {
  for (let i = 0; i < TRIES; i++) {
    const a = await answer(io, `${question} [${dflt}] `);
    if (a === null || a === '') return dflt;
    const n = Number(a);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    io.say(`  Answer a whole number from ${min} to ${max}.`);
  }
  return dflt;
}

/* ---------------- the staged plugin ---------------- */

/**
 * Copy what runs into `stage`: the manifests, hooks, MCP configs, skills,
 * commands, CLI and the build, with a package.json that names Coplan (a
 * daemon restart checks it) but has nothing to install or build. Built
 * beside the old copy and swapped in, so no agent reads a half-written one.
 */
export function stagePlugin(root: string, stage: string): { bytes: number } {
  const tmp = `${stage}.tmp`;
  const old = `${stage}.old`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(path.join(tmp, 'dist'), { recursive: true });
  for (const p of STAGED) cpSync(path.join(root, p), path.join(tmp, p), { recursive: true });
  for (const p of STAGED_DIST) cpSync(path.join(root, 'dist', p), path.join(tmp, 'dist', p), { recursive: true });

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  const keep = ['name', 'version', 'description', 'license', 'author', 'homepage', 'repository', 'type', 'engines'];
  const slim = Object.fromEntries(keep.filter((k) => k in pkg).map((k) => [k, pkg[k]]));
  writeFileSync(path.join(tmp, 'package.json'), `${JSON.stringify({ ...slim, private: true }, null, 2)}\n`);
  writeFileSync(path.join(tmp, INSTALL_FILE), `${JSON.stringify({ clone: root, version: pkg['version'] }, null, 2)}\n`);

  rmSync(old, { recursive: true, force: true });
  if (existsSync(stage)) renameSync(stage, old);
  renameSync(tmp, stage);
  rmSync(old, { recursive: true, force: true });
  return { bytes: sizeOf(stage) };
}

function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    // `parentPath` from Node 20.12; `path` before it.
    const parent = entry.parentPath ?? (entry as unknown as { path: string }).path;
    if (entry.isFile()) total += statSync(path.join(parent, entry.name)).size;
  }
  return total;
}

/* ---------------- the agents ---------------- */

/** Each agent this machine has, with what says so; null when it has not. */
export function findAgents(io: SetupIo, home: string): Record<AgentKind, string | null> {
  const version = (command: string) => {
    const r = io.run(command, ['--version']);
    return r.ok ? r.stdout.split('\n').map((l) => l.trim()).find(Boolean) ?? command : null;
  };
  const cursorDir = path.join(home, '.cursor');
  return {
    claude: version('claude'),
    codex: version('codex'),
    cursor: existsSync(cursorDir) ? cursorDir : version('cursor-agent'),
  };
}

/** Run each step in turn, saying it; stop at the first that fails. */
function steps(io: SetupIo, list: [string, string[]][], failed: string[], who: string): boolean {
  for (const [command, args] of list) {
    io.say(`  $ ${[command, ...args].join(' ')}`);
    const r = io.run(command, args);
    if (!r.ok) {
      // Without a Rust backtrace's frames, which crowd out the message.
      const lines = r.out.split('\n').filter((l) => l.trim() && !/^\s*(\d+: |at |Stack backtrace:)/.test(l));
      const tail = lines.slice(-6).map((l) => `    ${l.trim()}`).join('\n');
      if (tail) io.say(tail);
      failed.push(`${who}: \`${[command, ...args].join(' ')}\` failed`);
      return false;
    }
  }
  return true;
}

/**
 * Claude Code: add the staged plugin as the `coplan` marketplace (this moves
 * one added from elsewhere, such as GitHub, to it) and install from it.
 * Claude Code reads a folder marketplace's plugin in place, so a later
 * `./setup.sh` takes effect at the next session; `update` records a new
 * version, and changes nothing when there is none.
 */
export function installClaude(io: SetupIo, stage: string, failed: string[]): boolean {
  return steps(
    io,
    [
      ['claude', ['plugin', 'marketplace', 'add', stage]],
      ['claude', ['plugin', 'install', PLUGIN_ID, '--scope', 'user']],
      ['claude', ['plugin', 'update', PLUGIN_ID]],
    ],
    failed,
    'Claude Code',
  );
}

/**
 * Codex: it refuses a marketplace named `coplan` from a second source, so
 * one from elsewhere (an earlier install from GitHub) is removed first. It
 * installs a copy, and `plugin add` copies again each time.
 */
export function installCodex(io: SetupIo, stage: string, failed: string[]): boolean {
  const listed = io.run('codex', ['plugin', 'marketplace', 'list', '--json']);
  const list: [string, string[]][] = [];
  if (listed.ok) {
    try {
      const { marketplaces = [] } = JSON.parse(listed.stdout) as { marketplaces?: { name?: string; root?: string }[] };
      const ours = marketplaces.find((m) => m.name === 'coplan');
      if (ours && (!ours.root || path.resolve(ours.root) !== path.resolve(stage))) list.push(['codex', ['plugin', 'marketplace', 'remove', 'coplan']]);
    } catch {
      /* an answer this cannot read: `add` says whether it is in the way */
    }
  }
  list.push(['codex', ['plugin', 'marketplace', 'add', stage]], ['codex', ['plugin', 'add', PLUGIN_ID]]);
  return steps(io, list, failed, 'Codex');
}

/** Cursor loads a plugin copied into its local plugins folder. One already
 *  there is replaced only when it is Coplan. */
export function installCursor(io: SetupIo, stage: string, home: string, failed: string[]): boolean {
  const dest = path.join(home, '.cursor', 'plugins', 'local', 'coplan');
  io.say(`  copying the plugin to ${dest}`);
  if (existsSync(dest)) {
    let name: unknown;
    try {
      name = (JSON.parse(readFileSync(path.join(dest, '.cursor-plugin', 'plugin.json'), 'utf8')) as { name?: unknown }).name;
    } catch {
      name = undefined;
    }
    if (name !== 'coplan') {
      io.say(`    ${dest} is there and is not Coplan: left as it is.`);
      failed.push(`Cursor: ${dest} holds something else`);
      return false;
    }
    rmSync(dest, { recursive: true, force: true });
  }
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(stage, dest, { recursive: true });
    return true;
  } catch (err) {
    io.say(`    ${(err as Error).message}`);
    failed.push(`Cursor: could not copy to ${dest}`);
    return false;
  }
}

/* ---------------- settings ---------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A config file as it stands: its object, and whether it had comments a
 *  rewrite would drop. Null when it cannot be read: then it is left alone. */
function readJsonc(file: string, io: SetupIo): { raw: Record<string, unknown>; comments: boolean } | null {
  if (!existsSync(file)) return { raw: {}, comments: false };
  try {
    const text = readFileSync(file, 'utf8');
    const raw = parseJsonc(text);
    if (!isRecord(raw)) throw new Error('it does not hold an object');
    return { raw, comments: stripJsonc(text) !== text };
  } catch (err) {
    io.say(`  ${file} cannot be read (${(err as Error).message}), so it is left as it is. Fix it by hand; docs/CONFIG.md says what goes in it.`);
    return null;
  }
}

/** Set `key` unless it is the default and the file never set it, so a file
 *  holds only what the user chose and later defaults still reach them. */
function put(obj: Record<string, unknown>, key: string, value: unknown, dflt: unknown): void {
  if (value === dflt && !(key in obj)) return;
  obj[key] = value;
}

function writeJsonc(file: string, header: string, obj: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(obj, null, 2).split('\n');
  const lines = body.length === 1 ? ['{', `  // ${header}`, '}'] : ['{', `  // ${header}`, ...body.slice(1)];
  writeFileSync(file, `${lines.join('\n')}\n`);
}

/** Coplan on this machine: `config.json` in Coplan's home. */
export async function askSettings(io: SetupIo, coplanHome: string): Promise<'written' | 'unchanged' | 'unreadable'> {
  const file = globalConfigFile(coplanHome);
  const read = readJsonc(file, io);
  if (!read) return 'unreadable';
  const now: HarnessConfig = mergeConfig(DEFAULT_CONFIG, read.raw);
  const next: HarnessConfig = {
    autoOpen: await yesNo(io, '  Open the plan in your browser the first time the agent publishes one?', now.autoOpen),
    promptNotice: await yesNo(io, '  When you change the plan in the browser, add a line to your next message telling the agent to read it?', now.promptNotice),
    openClaudeOnQuestion: await yesNo(
      io,
      "  When the agent asks you something, open its session in the desktop app straight away (Claude Code with Remote Control, or the Codex app)?",
      now.openClaudeOnQuestion,
    ),
    idleShutdownMinutes: await whole(io, '  Stop the daemon after how many idle minutes (0: never)?', 0, 100_000, now.idleShutdownMinutes),
  };
  const raw = { ...read.raw };
  for (const key of Object.keys(next) as (keyof HarnessConfig)[]) put(raw, key, next[key], DEFAULT_CONFIG[key]);
  if (JSON.stringify(raw) === JSON.stringify(read.raw)) return 'unchanged';
  writeJsonc(file, "Coplan's settings on this machine. docs/CONFIG.md says what each one does.", raw);
  if (read.comments) io.say(`  (${file} had comments; they are not kept)`);
  return 'written';
}

/** Your defaults for every repository's build: `coplan.json` in Coplan's home. */
export async function askBuildDefaults(io: SetupIo, coplanHome: string): Promise<'written' | 'unchanged' | 'unreadable'> {
  const file = path.join(coplanHome, GLOBAL_PROJECT_FILE);
  const read = readJsonc(file, io);
  if (!read) return 'unreadable';
  const now = loadProjectConfig(null, { globalDir: coplanHome });
  const review = await choose(
    io,
    '  Who reviews each task: a fresh subagent, the agent itself (self), you (user), or nobody (skip: the checks only)?',
    REVIEW_MODES,
    now.settings.review,
  );
  const parallel = await whole(io, `  How many ready tasks are built at once (1-${MAX_PARALLEL})?`, 1, MAX_PARALLEL, now.settings.parallel);
  const maxRounds = await whole(io, `  How many review rounds may a task take before the agent stops and asks you (1-${MAX_ROUNDS})?`, 1, MAX_ROUNDS, now.settings.maxRounds);
  const tool = await choose(io, '  Open pull requests with gh, graphite, or none (the agent pushes the branches and you open them)?', PR_TOOLS, now.pullRequests.tool);
  const open =
    tool === 'none'
      ? now.pullRequests.open
      : await choose(io, '  Open them as soon as a branch is done (auto), once you say to (ask), or never?', PR_OPEN, now.pullRequests.open);

  const raw = { ...read.raw };
  const section = (key: string, set: (obj: Record<string, unknown>) => void) => {
    const had = isRecord(raw[key]);
    const obj = had ? { ...(raw[key] as Record<string, unknown>) } : {};
    set(obj);
    if (had || Object.keys(obj).length) raw[key] = obj;
  };
  section('iric', (o) => {
    put(o, 'review', review, DEFAULT_BUILD_SETTINGS.review);
    put(o, 'parallel', parallel, DEFAULT_BUILD_SETTINGS.parallel);
    put(o, 'maxRounds', maxRounds, DEFAULT_BUILD_SETTINGS.maxRounds);
  });
  section('pullRequests', (o) => {
    put(o, 'tool', tool, 'gh');
    put(o, 'open', open, 'ask');
  });
  if (JSON.stringify(raw) === JSON.stringify(read.raw)) return 'unchanged';
  writeJsonc(file, "Your defaults for every repository's build. A repository's .coplan/config.json overrides them; docs/CONFIG.md has the rest.", raw);
  if (read.comments) io.say(`  (${file} had comments; they are not kept)`);
  for (const w of loadProjectConfig(null, { globalDir: coplanHome }).warnings) io.say(`  ! ${w}`);
  return 'written';
}

/** A repository's checks: `.coplan/config.json`, from what it already runs. */
export async function askRepositories(io: SetupIo, home: string, coplanHome: string): Promise<string[]> {
  const written: string[] = [];
  // Built-in defaults written into the repository would override the
  // user's own, which a repository's file does key by key.
  const own = readJsonc(path.join(coplanHome, GLOBAL_PROJECT_FILE), { ...io, say: () => {} })?.raw['iric'];
  const settings = !(isRecord(own) && Object.keys(own).length > 0);
  let question = "  A repository to set up checks for (its path; Enter to skip):";
  for (;;) {
    const a = await answer(io, `${question} `);
    if (!a) return written;
    question = '  Another repository (Enter to finish):';
    const dir = path.resolve(a.replace(/^~(?=$|\/)/, home));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      io.say(`  ${dir} is not a folder.`);
      continue;
    }
    const root = repoRootOf(dir);
    const file = path.join(root, PROJECT_CONFIG_PATH);
    if (existsSync(file)) {
      io.say(`  ${file} is already there: left as it is. /coplan-init in that repository reviews it against CI.`);
      continue;
    }
    const { hooks, found } = detectHooks(root);
    io.say(found.length ? `  From ${found.join(', ')}:` : '  Nothing to run was found; the file will have empty stages to fill in.');
    for (const stage of HOOK_STAGES) {
      if (hooks[stage].length) io.say(`    ${stage}: ${hooks[stage].map((h) => h.run).join(', ')}`);
    }
    if (!(await yesNo(io, `  Write ${file}?`, true))) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, renderConfig(hooks, baseBranch(root), { settings }));
    written.push(file);
    io.say(`  Wrote it${settings ? '' : ', without build settings, so your defaults hold there'}. Commit it so every build there runs the same checks; /coplan-init has the agent check it against CI.`);
  }
}

/* ---------------- the whole walk ---------------- */

export async function setup(opts: SetupOptions, io: SetupIo): Promise<SetupResult> {
  const failed: string[] = [];
  const installed: AgentKind[] = [];

  io.say('\n1. The plugin');
  const { bytes } = stagePlugin(opts.root, opts.stage);
  io.say(`  Staged what runs in ${opts.stage} (${(bytes / (1024 * 1024)).toFixed(1)} MB). Your agents install it from there.`);

  io.say('\n2. Your agents');
  const found = findAgents(io, opts.home);
  for (const kind of AGENT_KINDS) io.say(`  ${AGENTS[kind].product}: ${found[kind] ?? 'not found'}`);
  for (const kind of AGENT_KINDS) {
    const want = opts.agents ? opts.agents.includes(kind) : await yesNo(io, `  Install Coplan in ${AGENTS[kind].product}?`, found[kind] !== null);
    if (!want) continue;
    io.say(`  ${AGENTS[kind].product}:`);
    const ok =
      kind === 'claude'
        ? installClaude(io, opts.stage, failed)
        : kind === 'codex'
          ? installCodex(io, opts.stage, failed)
          : installCursor(io, opts.stage, opts.home, failed);
    if (ok) installed.push(kind);
  }
  if (!installed.length && !failed.length) io.say('  Installed in none. Run ./setup.sh again to add one.');

  if (io.ask) {
    io.say(`\n3. Your settings (${globalConfigFile(opts.coplanHome)})`);
    if (await yesNo(io, '  Go through them now?', true)) {
      const r = await askSettings(io, opts.coplanHome);
      if (r !== 'unreadable') io.say(r === 'written' ? '  Saved.' : '  Unchanged.');
    }

    io.say(`\n4. Your build defaults (${path.join(opts.coplanHome, GLOBAL_PROJECT_FILE)})`);
    io.say('  How a build runs, in every repository; the submit dialog can still change it for each plan.');
    if (await yesNo(io, '  Set them now?', existsSync(path.join(opts.coplanHome, GLOBAL_PROJECT_FILE)))) {
      const r = await askBuildDefaults(io, opts.coplanHome);
      if (r !== 'unreadable') io.say(r === 'written' ? '  Saved.' : '  Unchanged.');
    }

    io.say(`\n5. A repository's checks (${PROJECT_CONFIG_PATH})`);
    io.say('  The commands each task runs while it is built and reviewed: typecheck, lint, tests.');
    await askRepositories(io, opts.home, opts.coplanHome);
  }

  return { installed, failed };
}

/* ---------------- the command ---------------- */

function parseArgs(args: string[]): { yes: boolean; agents?: AgentKind[] } | string {
  let yes = false;
  let agents: AgentKind[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--agents' || arg.startsWith('--agents=')) {
      const value = arg === '--agents' ? args[++i] : arg.slice('--agents='.length);
      if (value === undefined) return '--agents needs a list: claude,codex,cursor, or none';
      const names = value.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = names.filter((n) => n !== 'none' && !(AGENT_KINDS as readonly string[]).includes(n));
      if (bad.length) return `unknown agent(s): ${bad.join(', ')}; use claude, codex, cursor, or none`;
      agents = names.filter((n): n is AgentKind => n !== 'none');
    } else return `unknown option: ${arg}`;
  }
  return { yes, ...(agents ? { agents } : {}) };
}

const USAGE = `usage: ./setup.sh [--yes] [--agents claude,codex,cursor|none]

Builds Coplan, installs it in your agents, and walks through its settings.
  --yes          ask nothing: install in every agent found, keep the settings
  --agents LIST  install in these agents only, without asking which`;

function runCommand(command: string, args: string[]): RunResult {
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export async function runSetup(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    console.error(`${parsed}\n\n${USAGE}`);
    return 2;
  }
  // The staged copy is not a clone: it has nothing to build or stage.
  const note = path.join(CLONE, INSTALL_FILE);
  if (existsSync(note)) {
    let clone = '';
    try {
      clone = String((JSON.parse(readFileSync(note, 'utf8')) as { clone?: unknown }).clone ?? '');
    } catch {
      /* said below without it */
    }
    console.error(`This is the copy of Coplan that setup installed. Run ./setup.sh in your clone${clone ? `: ${clone}` : ''}.`);
    return 1;
  }

  const interactive = !parsed.yes && process.stdin.isTTY === true;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const io: SetupIo = {
    say: (line) => console.log(line),
    run: runCommand,
    ...(rl ? { ask: (q: string) => rl.question(q) } : {}),
  };

  console.log(`Coplan ${VERSION} setup, from ${CLONE}`);
  if (!parsed.yes && !interactive) console.log('(no terminal to ask in: every question takes its default, and the settings stay as they are)');
  if (!runCommand('curl', ['--version']).ok) console.log('! curl is not installed: the hooks need it to reach Coplan. Install it before you use Coplan.');
  if (!runCommand('git', ['--version']).ok) console.log('! git is not installed: sessions will not be labelled with their repository, and builds cannot land on branches.');

  let result: SetupResult;
  try {
    result = await setup(
      {
        root: CLONE,
        stage: path.join(CLONE, STAGE_DIR),
        home: homedir(),
        coplanHome: paths.configDir(),
        ...(parsed.agents ? { agents: parsed.agents } : {}),
      },
      io,
    );
  } finally {
    rl?.close();
  }

  // A daemon already running keeps the build it started from: move it to
  // this one. It hands its address on, so open tabs reconnect.
  const lock = await readVerifiedLock();
  if (lock && lock.version !== VERSION) {
    console.log(`\nThe running daemon is ${lock.version}; restarting it on ${VERSION}.`);
    const r = runCommand(path.join(CLONE, STAGE_DIR, 'bin', 'coplan'), ['restart']);
    console.log(r.out.trim());
    if (!r.ok) result.failed.push('restarting the daemon');
  }

  console.log('\nNext');
  const done = new Set(result.installed);
  if (done.has('claude')) console.log('  Claude Code: start a new session (or run /reload-plugins).');
  if (done.has('codex')) console.log('  Codex: open /hooks and trust the Coplan hooks, then start a new thread. Codex asks again after each update.');
  if (done.has('cursor')) console.log('  Cursor: run Developer: Reload Window.');
  if (done.size) {
    const codex = done.has('codex');
    console.log(`  Then check the wiring with /coplan-doctor${codex ? ' (in Codex, ask it to run the Coplan doctor)' : ''},`);
    console.log(`  and plan something: /coplan <task>${codex ? ' ($coplan <task> in Codex)' : ''}.`);
  }
  if (done.has('claude')) console.log(`  Keep this clone where it is: Claude Code loads Coplan from ${path.join(CLONE, STAGE_DIR)}.`);
  console.log('  To update: git pull, then ./setup.sh again.');

  if (result.failed.length) {
    console.log('\nNot done:');
    for (const f of result.failed) console.log(`  ✗ ${f}`);
    return 1;
  }
  return 0;
}
