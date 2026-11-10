/**
 * `coplan init` — write a starting `.coplan/config.json` from what the
 * repository already has: package scripts, a Makefile, the usual commands
 * of a Cargo, Go or Python project. A starting point to read and correct,
 * not a guess to trust; `/coplan-init` has Claude check it against CI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseJsonc } from '../shared/jsonc.ts';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { repoRoot } from '../shared/changes.ts';
import { DEFAULT_BUILD_SETTINGS } from '../shared/build.ts';
import { PROJECT_CONFIG_PATH, type CheckHook, type HookStage } from '../shared/project.ts';

type Detected = Record<HookStage, CheckHook[]>;

/**
 * The areas the usual tools look at, so the checks written are targeted
 * from the start: a typecheck or a linter runs only when the change
 * touches its language. A test suite or a build is left whole — it may
 * read anything — for the repository to scope if it knows better.
 */
const TS = ['*.ts', '*.tsx', '*.mts', '*.cts', 'tsconfig*.json', 'package.json'];
const JS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts', 'package.json', 'eslint.config.*', '.eslintrc*'];
const RUST = ['*.rs', 'Cargo.toml', 'Cargo.lock'];
const GO = ['*.go', 'go.mod', 'go.sum'];
const PY = ['*.py', 'pyproject.toml'];

/** Each lockfile and the package manager that writes it, in the order they are believed. */
const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

export function detectHooks(root: string): { hooks: Detected; found: string[] } {
  const hooks: Detected = { implement: [], review: [], final: [] };
  const found: string[] = [];
  const add = (stage: HookStage, name: string, run: string, extra: Partial<CheckHook> = {}) => {
    if (!hooks[stage].some((h) => h.run === run || h.name === name)) hooks[stage].push({ name, run, ...extra });
  };
  const read = (file: string) => {
    try {
      return readFileSync(path.join(root, file), 'utf8');
    } catch {
      return null;
    }
  };

  const pkg = read('package.json');
  if (pkg) {
    try {
      // Through parseJsonc: a package.json with a byte order mark, which npm reads, is read too.
      const manifest = parseJsonc(pkg) as { scripts?: Record<string, string>; packageManager?: unknown };
      const scripts = manifest.scripts ?? {};
      // The one package.json names in `packageManager` (`pnpm@10.28.0`, the
      // field Corepack uses), whatever lockfile is there or not yet; else
      // the lockfile's; else npm.
      const named = typeof manifest.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager)?.[1] : undefined;
      const locked = LOCKFILES.find(([file]) => existsSync(path.join(root, file)));
      const pm = named ?? locked?.[1] ?? 'npm';
      const why = named ? 'packageManager' : (locked?.[0] ?? 'no lockfile');
      // Always through `run`: a script named like a command of the package
      // manager's own (yarn check, bun test, pnpm ci) runs that command
      // instead, and passes or fails without running the script.
      const run = (s: string) => `${pm} run ${s}`;
      const pick = (names: string[]) => names.find((n) => scripts[n]);
      const typecheck = pick(['typecheck', 'type-check', 'types', 'tsc', 'check:types']);
      const lint = pick(['lint', 'lint:check', 'eslint']);
      const format = pick(['format:check', 'fmt:check', 'prettier:check']);
      const test = pick(['test', 'test:unit', 'tests']);
      const build = pick(['build']);
      const check = pick(['check', 'verify', 'ci']);
      if (typecheck) add('implement', 'typecheck', run(typecheck), { paths: TS });
      if (lint) add('implement', 'lint', run(lint), { paths: JS });
      if (format) add('implement', 'format', run(format), { optional: true });
      if (test) add('review', 'tests', run(test), { timeout: 900 });
      if (check) add('final', check, run(check), { timeout: 1200 });
      else if (build) add('final', 'build', run(build));
      found.push(`package.json scripts (${pm}, from ${why})`);
    } catch {
      found.push('package.json (unreadable — skipped)');
    }
  }

  const makefile = read('Makefile') ?? read('makefile');
  if (makefile) {
    const targets = new Set([...makefile.matchAll(/^([A-Za-z][\w-]*)\s*:/gm)].map((m) => m[1]!));
    if (targets.has('lint')) add('implement', 'lint', 'make lint');
    if (targets.has('test')) add('review', 'tests', 'make test', { timeout: 900 });
    if (targets.has('check')) add('final', 'check', 'make check', { timeout: 1200 });
    else if (targets.has('build')) add('final', 'build', 'make build');
    if (targets.size) found.push('Makefile');
  }

  if (read('Cargo.toml') !== null) {
    add('implement', 'cargo check', 'cargo check --all-targets', { paths: RUST });
    add('implement', 'clippy', 'cargo clippy --all-targets -- -D warnings', { paths: RUST, optional: true });
    add('review', 'cargo test', 'cargo test', { timeout: 900, paths: RUST });
    add('final', 'cargo build', 'cargo build --release', { timeout: 1200 });
    found.push('Cargo.toml');
  }

  if (read('go.mod') !== null) {
    add('implement', 'go vet', 'go vet ./...', { paths: GO });
    add('review', 'go test', 'go test ./...', { timeout: 900, paths: GO });
    add('final', 'go build', 'go build ./...');
    found.push('go.mod');
  }

  const pyproject = read('pyproject.toml');
  const python = pyproject ?? read('setup.cfg') ?? read('pytest.ini') ?? read('requirements-dev.txt');
  if (python !== null) {
    const text = [pyproject, read('setup.cfg'), read('requirements-dev.txt')].filter(Boolean).join('\n');
    // ruff takes files: it lints only the ones the change touched.
    if (/\bruff\b/.test(text)) add('implement', 'ruff', 'ruff check {files}', { paths: ['*.py'] });
    if (/\bmypy\b/.test(text)) add('implement', 'mypy', 'mypy .', { paths: PY });
    add('review', 'pytest', 'pytest -q', { timeout: 900 });
    found.push('Python project');
  }

  return { hooks, found };
}

/** The branch the repository's remote calls its default, when it says. */
export function baseBranch(root: string): string | undefined {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return ref.replace(/^refs\/remotes\/origin\//, '') || undefined;
  } catch {
    return undefined;
  }
}

const SETTINGS = `  // How a Managed build runs. Setting it makes builds here Managed by default
  // (implement → review → refine, held to the checks); Submit can change it.
  //   review:    subagent | self | user | skip
  //   parallel:  how many ready tasks are built at once
  //   maxRounds: review rounds before Claude stops and asks you
  "iric": ${JSON.stringify(DEFAULT_BUILD_SETTINGS).replace(/,"/g, ', "').replace(/":/g, '": ')},
`;

/** Without `iric`, the file still opts the repository in to Managed builds,
 *  as `iric` does — with the user's own settings for them. */
const MANAGED = `  // Builds here are Managed by default: implement → review → refine, held
  // to the checks above. "tracked" leaves how to the agent; Submit can change it.
  "mode": "managed",
`;

/**
 * The file as written: commented, so it explains itself to whoever opens it.
 * `settings: false` leaves `iric` out, so the user's own defaults
 * (`coplan.json`) hold here rather than being overridden by the built-in ones.
 */
export function renderConfig(hooks: Detected, base: string | undefined, opts: { settings?: boolean } = {}): string {
  const hook = (h: CheckHook) => {
    const rest = { ...(h.timeout ? { timeout: h.timeout } : {}), ...(h.paths ? { paths: h.paths } : {}), ...(h.optional ? { optional: true } : {}) };
    return `      ${JSON.stringify({ name: h.name, run: h.run, ...rest }).replace(/,"/g, ', "').replace(/":/g, '": ')}`;
  };
  const stage = (s: HookStage) => (hooks[s].length ? `[\n${hooks[s].map(hook).join(',\n')}\n    ]` : '[]');
  return `{
  // Coplan — what the build runs, so no agent has to guess.
  // Each task goes through implement → review → refine:
  //   implement: quick checks after every implementation or refinement pass
  //   review:    the gate a task must pass before it is done
  //   final:     once every task is done, before the final report
  // A hook is a command (run from the repository root), or
  //   { "name", "run", "timeout" (seconds), "paths" (globs), "optional" }.
  // Checks are targeted: each runs only when the change touches its area —
  // its "paths", or the folder in "cwd" — and "{files}" in a command is the
  // changed files in that area. One with neither runs on any change.
  // Run a stage yourself with:  coplan check review
  "hooks": {
    "implement": ${stage('implement')},
    "review": ${stage('review')},
    "final": ${stage('final')}
  },
${opts.settings === false ? MANAGED : SETTINGS}  "branches": ${JSON.stringify({ ...(base ? { base } : {}), prefix: 'coplan/' }).replace(/,"/g, ', "').replace(/":/g, '": ')}
}
`;
}

export async function runInit(args: string[], cwd = process.cwd()): Promise<number> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const file = path.join(root, PROJECT_CONFIG_PATH);
  const print = args.includes('--print');
  const { hooks, found } = detectHooks(root);
  const text = renderConfig(hooks, baseBranch(root));
  if (print) {
    process.stdout.write(text);
    return 0;
  }
  if (existsSync(file) && !args.includes('--force')) {
    console.error(`${PROJECT_CONFIG_PATH} already exists. Use --print to see what would be detected, or --force to overwrite it.`);
    return 1;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote ${path.relative(cwd, file) || file}`);
  console.log(found.length ? `from: ${found.join(', ')}` : 'found nothing to run — fill in the hooks by hand');
  console.log('read it over: these are guesses from file names, and CI may run more.');
  return 0;
}
