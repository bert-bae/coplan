/**
 * `coplan setup` — the second half of `./setup.sh`, run once the build is in
 * place: install Coplan in your agents and, if you want, adjust a few
 * settings. `--uninstall` takes it out again. Run `./setup.sh` again after
 * `git pull` to update.
 *
 *   coplan setup [--yes] [--agents claude,codex,cursor|none] [--uninstall]
 *
 * Every agent copies what it is pointed at, and the clone holds about 150 MB
 * of build-time packages, so the agents are pointed at a staged copy that
 * holds only what runs: `.plugin/` in the clone, about 5 MB. Claude Code
 * reads that folder in place; Codex and Cursor take a copy of it.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, globalConfigFile, mergeConfig } from '../shared/config.ts';
import { jsoncComments, parseJsonc } from '../shared/jsonc.ts';
import { DEFAULT_BUILD_SETTINGS, MAX_PARALLEL } from '../shared/build.ts';
import { GLOBAL_PROJECT_FILE, HOOK_STAGES, PROJECT_CONFIG_PATH, PR_OPEN, PR_TOOLS, loadProjectConfig } from '../shared/project.ts';
import { REVIEW_MODES } from '../shared/types.ts';
import { AGENTS, AGENT_KINDS, type AgentKind } from '../shared/agents.ts';
import { paths, readVerifiedLock } from '../shared/paths.ts';
import { baseBranch, detectHooks, renderConfig } from './init.ts';
import { repoRoot } from '../shared/changes.ts';

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
  /** The agents to install in, chosen up front (`--agents`). Unset: every
   *  agent found, once the user says yes. */
  agents?: AgentKind[];
}

export interface SetupResult {
  /** The agents Coplan was installed in. */
  installed: AgentKind[];
  /** The agents it could not be installed in. */
  failed: AgentKind[];
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

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Cursor". */
function names(kinds: readonly AgentKind[]): string {
  const n = kinds.map((k) => AGENTS[k].product);
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/* ---------------- the staged plugin ---------------- */

/**
 * Copy what runs into `stage`: the manifests, hooks, MCP configs, skills,
 * commands, CLI and the build, with a package.json that names Coplan (a
 * daemon restart checks it) but has nothing to install or build. Built
 * beside the old copy and swapped in, so no agent reads a half-written one.
 */
export function stagePlugin(root: string, stage: string): void {
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
}

/* ---------------- the agents ---------------- */

/** The agents this machine has. */
export function findAgents(io: SetupIo, home: string): AgentKind[] {
  const has = (command: string) => io.run(command, ['--version']).ok;
  return AGENT_KINDS.filter((kind) =>
    kind === 'claude' ? has('claude') : kind === 'codex' ? has('codex') : existsSync(path.join(home, '.cursor')) || has('cursor-agent'),
  );
}

/** Run each step in turn; at the first that fails, stop and say why. */
function steps(io: SetupIo, list: [string, string[]][]): string | null {
  for (const [command, args] of list) {
    const r = io.run(command, args);
    if (!r.ok) {
      // Without a Rust backtrace's frames, which crowd out the message.
      const lines = r.out.split('\n').filter((l) => l.trim() && !/^\s*(\d+: |at |Stack backtrace:)/.test(l));
      return [`\`${[command, ...args].join(' ')}\` failed`, ...lines.slice(-6).map((l) => l.trim())].join('\n      ');
    }
  }
  return null;
}

/**
 * Claude Code: add the staged plugin as the `coplan` marketplace (this moves
 * one added from elsewhere, such as GitHub, to it) and install from it.
 * Claude Code reads a folder marketplace's plugin in place, so a later
 * `./setup.sh` takes effect at the next session; `update` records a new
 * version, and changes nothing when there is none. Null when it worked;
 * otherwise what failed.
 */
export function installClaude(io: SetupIo, stage: string): string | null {
  return steps(io, [
    ['claude', ['plugin', 'marketplace', 'add', stage]],
    ['claude', ['plugin', 'install', PLUGIN_ID, '--scope', 'user']],
    ['claude', ['plugin', 'update', PLUGIN_ID]],
  ]);
}

/** Codex's `coplan` marketplace, from `plugin marketplace list --json`. */
function codexMarketplace(io: SetupIo): { root?: string } | null {
  const listed = io.run('codex', ['plugin', 'marketplace', 'list', '--json']);
  if (!listed.ok) return null;
  try {
    const { marketplaces = [] } = JSON.parse(listed.stdout) as { marketplaces?: { name?: string; root?: string }[] };
    return marketplaces.find((m) => m.name === 'coplan') ?? null;
  } catch {
    return null;
  }
}

/**
 * Codex: it refuses a marketplace named `coplan` from a second source, so
 * one from elsewhere (an earlier install from GitHub) is removed first. It
 * installs a copy, and `plugin add` copies again each time.
 */
export function installCodex(io: SetupIo, stage: string): string | null {
  const ours = codexMarketplace(io);
  const list: [string, string[]][] = [];
  if (ours && (!ours.root || path.resolve(ours.root) !== path.resolve(stage))) list.push(['codex', ['plugin', 'marketplace', 'remove', 'coplan']]);
  list.push(['codex', ['plugin', 'marketplace', 'add', stage]], ['codex', ['plugin', 'add', PLUGIN_ID]]);
  return steps(io, list);
}

function cursorDir(home: string): string {
  return path.join(home, '.cursor', 'plugins', 'local', 'coplan');
}

/** Whether `dir` holds Coplan's Cursor plugin, and so is Coplan's to replace. */
function isCoplan(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), 'utf8')) as { name?: unknown }).name === 'coplan';
  } catch {
    return false;
  }
}

/** Cursor loads a plugin copied into its local plugins folder. One already
 *  there is replaced only when it is Coplan. */
export function installCursor(stage: string, home: string): string | null {
  const dest = cursorDir(home);
  if (existsSync(dest)) {
    if (!isCoplan(dest)) return `${dest} holds something else, so it was left as it is`;
    rmSync(dest, { recursive: true, force: true });
  }
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(stage, dest, { recursive: true });
    return null;
  } catch (err) {
    return `could not copy to ${dest}: ${(err as Error).message}`;
  }
}

/** Install in the agents chosen, saying how each went. */
function install(io: SetupIo, kinds: readonly AgentKind[], opts: SetupOptions): SetupResult {
  const result: SetupResult = { installed: [], failed: [] };
  for (const kind of kinds) {
    const error =
      kind === 'claude' ? installClaude(io, opts.stage) : kind === 'codex' ? installCodex(io, opts.stage) : installCursor(opts.stage, opts.home);
    if (error) {
      io.say(`  ✗ ${AGENTS[kind].product}: ${error}`);
      result.failed.push(kind);
    } else {
      io.say(`  ✓ ${AGENTS[kind].product}`);
      result.installed.push(kind);
    }
  }
  return result;
}

/** Which agents to install in: those found, once the user says so, or the
 *  ones they pick when they do not want them all. */
export async function chooseAgents(io: SetupIo, found: AgentKind[]): Promise<AgentKind[]> {
  if (!found.length) {
    io.say('No coding agent found. Install Claude Code, Codex or Cursor, then run ./setup.sh again.');
    return [];
  }
  io.say(`Found ${names(found)}.`);
  if (await yesNo(io, `Install Coplan in ${found.length > 1 ? (found.length > 2 ? 'all three' : 'both') : names(found)}?`, true)) return found;
  if (found.length === 1) return [];
  const picked: AgentKind[] = [];
  for (const kind of found) if (await yesNo(io, `  In ${AGENTS[kind].product}?`, false)) picked.push(kind);
  return picked;
}

/* ---------------- settings ---------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What each settings file says at its top, as `save` writes it. */
const DEFAULTS_HEADER = "Your defaults for every repository's build. A repository's .coplan/config.json overrides them; docs/CONFIG.md has the rest.";
const MACHINE_HEADER = "Coplan's settings on this machine. docs/CONFIG.md says what each one does.";

/** A comment `save` wrote, not the user: known by how its headers begin,
 *  so a header reworded later is still known. */
const ownComment = (comment: string) => ["Your defaults for every repository's build.", "Coplan's settings on this machine."].some((start) => comment.startsWith(start));

/** A config file as it stands: its object, and whether it has comments of
 *  the user's that a rewrite would drop (setup's own header is not one).
 *  Null when it cannot be read: then it is left alone. */
function readJsonc(file: string, io: SetupIo): { raw: Record<string, unknown>; comments: boolean } | null {
  if (!existsSync(file)) return { raw: {}, comments: false };
  try {
    const text = readFileSync(file, 'utf8');
    const raw = parseJsonc(text);
    if (!isRecord(raw)) throw new Error('it does not hold an object');
    return { raw, comments: jsoncComments(text).some((c) => !ownComment(c)) };
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

/** Set keys in the object under `key`, creating it only when it gets one. */
function section(raw: Record<string, unknown>, key: string, set: (obj: Record<string, unknown>) => void): void {
  const had = isRecord(raw[key]);
  const obj = had ? { ...(raw[key] as Record<string, unknown>) } : {};
  set(obj);
  if (had || Object.keys(obj).length) raw[key] = obj;
}

/** Write the file if it changed, keeping a copy of one whose comments the
 *  rewrite drops. Whether it was written. */
function save(file: string, header: string, before: { raw: Record<string, unknown>; comments: boolean }, raw: Record<string, unknown>, io: SetupIo): boolean {
  if (JSON.stringify(raw) === JSON.stringify(before.raw)) return false;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (before.comments) {
    // Never over an earlier copy: that may hold comments this one does not.
    let backup = `${file}.bak`;
    for (let n = 1; existsSync(backup); n++) backup = `${file}.bak.${n}`;
    copyFileSync(file, backup);
    io.say(`  (${file} had comments, which this rewrite drops: the file as it was is ${backup})`);
  }
  const body = JSON.stringify(raw, null, 2).split('\n');
  const lines = body.length === 1 ? ['{', `  // ${header}`, '}'] : ['{', `  // ${header}`, ...body.slice(1)];
  writeFileSync(file, `${lines.join('\n')}\n`);
  return true;
}

/**
 * The settings most people change, each starting from what is set now: how
 * a build runs (`coplan.json`, for every repository) and whether the plan
 * opens by itself (`config.json`). The rest are in docs/CONFIG.md. The files
 * written, if any.
 */
export async function askSettings(io: SetupIo, coplanHome: string): Promise<string[]> {
  const saved: string[] = [];

  const defaultsFile = path.join(coplanHome, GLOBAL_PROJECT_FILE);
  const defaults = readJsonc(defaultsFile, io);
  if (defaults) {
    const now = loadProjectConfig(null, { globalDir: coplanHome });
    const review = await choose(io, '  Who reviews each task: a fresh subagent, the agent itself (self), you (user), or only the checks (skip)?', REVIEW_MODES, now.settings.review);
    const parallel = await whole(io, `  How many tasks are built at once? (1-${MAX_PARALLEL})`, 1, MAX_PARALLEL, now.settings.parallel);
    const tool = await choose(io, '  Open pull requests with', PR_TOOLS, now.pullRequests.tool);
    const open = tool === 'none' ? now.pullRequests.open : await choose(io, '  Open them as each branch is done (auto), when you say (ask), or never?', PR_OPEN, now.pullRequests.open);
    const raw = { ...defaults.raw };
    section(raw, 'iric', (o) => {
      put(o, 'review', review, DEFAULT_BUILD_SETTINGS.review);
      put(o, 'parallel', parallel, DEFAULT_BUILD_SETTINGS.parallel);
    });
    section(raw, 'pullRequests', (o) => {
      put(o, 'tool', tool, 'gh');
      put(o, 'open', open, 'ask');
    });
    if (save(defaultsFile, DEFAULTS_HEADER, defaults, raw, io)) {
      saved.push(defaultsFile);
      for (const w of loadProjectConfig(null, { globalDir: coplanHome }).warnings) io.say(`  ! ${w}`);
    }
  }

  const machineFile = globalConfigFile(coplanHome);
  const machine = readJsonc(machineFile, io);
  if (machine) {
    const now = mergeConfig(DEFAULT_CONFIG, machine.raw);
    const autoOpen = await yesNo(io, '  Open the plan in your browser by itself when the agent publishes one?', now.autoOpen);
    const raw = { ...machine.raw };
    put(raw, 'autoOpen', autoOpen, DEFAULT_CONFIG.autoOpen);
    if (save(machineFile, MACHINE_HEADER, machine, raw, io)) saved.push(machineFile);
  }

  io.say(saved.length ? `  Saved to ${saved.join(' and ')}.` : '  Nothing changed.');
  return saved;
}

/** A repository's checks: `.coplan/config.json`, from what it already runs. */
export async function askRepositories(io: SetupIo, home: string, coplanHome: string): Promise<string[]> {
  const written: string[] = [];
  // Built-in defaults written into the repository would override the
  // user's own, which a repository's file does key by key.
  const own = readJsonc(path.join(coplanHome, GLOBAL_PROJECT_FILE), { ...io, say: () => {} })?.raw['iric'];
  const settings = !(isRecord(own) && Object.keys(own).length > 0);
  let question = "  Set up a repository's checks (typecheck, lint, tests)? Its path, or Enter to skip:";
  for (;;) {
    const a = await answer(io, `${question} `);
    if (!a) return written;
    question = '  Another repository? Its path, or Enter to finish:';
    const dir = path.resolve(a.replace(/^~(?=$|\/)/, home));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      io.say(`  ${dir} is not a folder.`);
      continue;
    }
    const root = (await repoRoot(dir)) ?? dir;
    const file = path.join(root, PROJECT_CONFIG_PATH);
    if (existsSync(file)) {
      io.say(`  ${file} is already there: left as it is.`);
      continue;
    }
    const { hooks, found } = detectHooks(root);
    if (!found.length) io.say('  Found nothing to run there; the file will have empty stages to fill in.');
    for (const stage of HOOK_STAGES) {
      if (hooks[stage].length) io.say(`    ${stage}: ${hooks[stage].map((h) => h.run).join(', ')}`);
    }
    if (!(await yesNo(io, `  Write ${file}?`, true))) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, renderConfig(hooks, baseBranch(root), { settings }));
    written.push(file);
    io.say('  Written. Commit it; /coplan-init in that repository checks it against your CI.');
  }
}

/* ---------------- the whole walk ---------------- */

export async function setup(opts: SetupOptions, io: SetupIo): Promise<SetupResult> {
  stagePlugin(opts.root, opts.stage);
  const kinds = opts.agents ?? (await chooseAgents(io, findAgents(io, opts.home)));
  const result = install(io, kinds, opts);
  if (io.ask && (await yesNo(io, 'Adjust settings now? The defaults are fine to start.', false))) {
    await askSettings(io, opts.coplanHome);
    await askRepositories(io, opts.home, opts.coplanHome);
    io.say('  More settings: docs/CONFIG.md');
  }
  return result;
}

/**
 * Take Coplan out of every agent it is in, and the staged plugin out of the
 * clone. The saved plans and settings stay unless the user says otherwise.
 * The agents it could not be taken out of.
 */
export async function uninstall(opts: SetupOptions, io: SetupIo): Promise<AgentKind[]> {
  const failed: AgentKind[] = [];
  const done = (kind: AgentKind, error: string | null) => {
    io.say(error ? `  ✗ ${AGENTS[kind].product}: ${error}` : `  ✓ Removed from ${AGENTS[kind].product}`);
    if (error) failed.push(kind);
  };
  const json = (r: RunResult): unknown => {
    try {
      return r.ok ? JSON.parse(r.stdout) : null;
    } catch {
      return null;
    }
  };

  if (io.run('claude', ['--version']).ok) {
    const plugins = json(io.run('claude', ['plugin', 'list', '--json']));
    const markets = json(io.run('claude', ['plugin', 'marketplace', 'list', '--json']));
    const list: [string, string[]][] = [];
    if (Array.isArray(plugins) && plugins.some((p) => isRecord(p) && p['id'] === PLUGIN_ID)) list.push(['claude', ['plugin', 'uninstall', PLUGIN_ID]]);
    if (Array.isArray(markets) && markets.some((m) => isRecord(m) && m['name'] === 'coplan')) list.push(['claude', ['plugin', 'marketplace', 'remove', 'coplan']]);
    if (list.length) done('claude', steps(io, list));
  }

  if (io.run('codex', ['--version']).ok) {
    const plugins = json(io.run('codex', ['plugin', 'list', '--json']));
    const installed = isRecord(plugins) && Array.isArray(plugins['installed']) ? plugins['installed'] : [];
    const list: [string, string[]][] = [];
    if (installed.some((p) => isRecord(p) && p['pluginId'] === PLUGIN_ID)) list.push(['codex', ['plugin', 'remove', PLUGIN_ID]]);
    if (codexMarketplace(io)) list.push(['codex', ['plugin', 'marketplace', 'remove', 'coplan']]);
    if (list.length) done('codex', steps(io, list));
  }

  const cursor = cursorDir(opts.home);
  if (existsSync(cursor)) {
    if (isCoplan(cursor)) {
      rmSync(cursor, { recursive: true, force: true });
      done('cursor', null);
    } else done('cursor', `${cursor} holds something else, so it was left as it is`);
  }

  rmSync(opts.stage, { recursive: true, force: true });

  if (existsSync(opts.coplanHome) && (await yesNo(io, `Also delete your saved plans and Coplan's settings (${opts.coplanHome})?`, false))) {
    rmSync(opts.coplanHome, { recursive: true, force: true });
    io.say(`  Deleted ${opts.coplanHome}.`);
  }
  return failed;
}

/* ---------------- the command ---------------- */

interface Args {
  yes: boolean;
  uninstall: boolean;
  agents?: AgentKind[];
}

function parseArgs(args: string[]): Args | string {
  const out: Args = { yes: false, uninstall: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg === '--uninstall') out.uninstall = true;
    else if (arg === '--agents' || arg.startsWith('--agents=')) {
      const value = arg === '--agents' ? args[++i] : arg.slice('--agents='.length);
      if (value === undefined) return '--agents needs a list: claude,codex,cursor, or none';
      const list = value.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = list.filter((n) => n !== 'none' && !(AGENT_KINDS as readonly string[]).includes(n));
      if (bad.length) return `unknown agent(s): ${bad.join(', ')}; use claude, codex, cursor, or none`;
      out.agents = list.filter((n): n is AgentKind => n !== 'none');
    } else return `unknown option: ${arg}`;
  }
  return out;
}

const USAGE = `usage: ./setup.sh [--yes] [--agents claude,codex,cursor|none] [--uninstall]

Builds Coplan and installs it in your agents.
  --yes          ask nothing: install in every agent found
  --agents LIST  install in these agents, without asking
  --uninstall    take Coplan out of every agent, and stop its daemon`;

/** Ctrl+C, or the end of input, at a question: the walk stops there. */
export class Stopped extends Error {}

/**
 * One question, on a readline opened for it alone. Between questions the
 * terminal is left as it was, so Ctrl+C during an install stops the setup
 * as it would any command; at a question it stops it too.
 */
function askTerminal(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => {
      if (!answered) reject(new Stopped());
    });
    rl.question(question, (a) => {
      answered = true;
      rl.close();
      resolve(a);
    });
  });
}

function runCommand(command: string, args: string[]): RunResult {
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** What to do now, for the agents Coplan went into. */
function nextSteps(installed: readonly AgentKind[]): string[] {
  const lines: string[] = [];
  if (installed.includes('claude')) lines.push('  Claude Code: start a new session, then /coplan <task>');
  if (installed.includes('codex')) lines.push("  Codex: trust Coplan's hooks in /hooks, start a new thread, then $coplan <task>");
  if (installed.includes('cursor')) lines.push('  Cursor: run Developer: Reload Window, then /coplan <task>');
  return lines;
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
  const io: SetupIo = {
    say: (line) => console.log(line),
    run: runCommand,
    ...(interactive ? { ask: askTerminal } : {}),
  };
  const opts: SetupOptions = {
    root: CLONE,
    stage: path.join(CLONE, STAGE_DIR),
    home: homedir(),
    coplanHome: paths.configDir(),
    ...(parsed.agents ? { agents: parsed.agents } : {}),
  };
  const stop = (err: unknown) => {
    if (!(err instanceof Stopped)) throw err;
    console.log('\n\nStopped. What was done so far stays; run ./setup.sh again to finish.');
    return 130;
  };

  if (parsed.uninstall) {
    // The daemon first, while its CLI is still here.
    runCommand(process.execPath, [path.join(CLONE, 'dist', 'cli', 'main.js'), 'stop']);
    let failed: AgentKind[];
    try {
      failed = await uninstall(opts, io);
    } catch (err) {
      return stop(err);
    }
    if (failed.length) {
      console.log(`\nNot removed from ${names(failed)}: see above.`);
      return 1;
    }
    console.log(`\nCoplan is uninstalled. Delete this clone (${CLONE}) whenever you like.`);
    return 0;
  }

  if (!parsed.yes && !interactive) console.log('(No terminal to ask in: installing in every agent found, and leaving the settings as they are.)');
  if (!runCommand('curl', ['--version']).ok) console.log('! curl is not installed: the hooks need it to reach Coplan. Install it before you use Coplan.');
  if (!runCommand('git', ['--version']).ok) console.log('! git is not installed: sessions will not be labelled with their repository, and builds cannot land on branches.');

  let result: SetupResult;
  try {
    result = await setup(opts, io);
  } catch (err) {
    return stop(err);
  }

  // A daemon already running keeps the build it started from, whatever its
  // version says (it is the same between releases): move it to this one. It
  // hands its address on, so open tabs reconnect.
  if (await readVerifiedLock()) {
    const r = runCommand(path.join(opts.stage, 'bin', 'coplan'), ['restart']);
    console.log(r.ok ? 'Restarted the Coplan daemon on this build.' : `! Could not restart the Coplan daemon:\n${r.out.trim()}`);
  }

  const next = nextSteps(result.installed);
  if (next.length) console.log(['', 'Done. Now:', ...next].join('\n'));
  else if (!result.failed.length) console.log('\nNothing installed. Run ./setup.sh again to install Coplan in an agent.');
  console.log('\nUpdate: git pull && ./setup.sh    Remove: ./setup.sh --uninstall');
  if (result.failed.length) {
    console.log(`\nNot installed in ${names(result.failed)}: see above, then run ./setup.sh again.`);
    return 1;
  }
  return 0;
}
