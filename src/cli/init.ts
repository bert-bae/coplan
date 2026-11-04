/**
 * `coplan init` — write a starting `.coplan/config.json` from what the
 * repository already has: package scripts, a Makefile, the usual commands
 * of a Cargo, Go or Python project. A starting point to read and correct,
 * not a guess to trust; `/coplan-init` has Claude check it against CI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { repoRootOf } from './check.ts';
import { DEFAULT_BUILD_SETTINGS } from '../shared/build.ts';
import { PROJECT_CONFIG_PATH, type CheckHook, type HookStage } from '../shared/project.ts';

type Detected = Record<HookStage, CheckHook[]>;

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
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
      const pm = existsSync(path.join(root, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(path.join(root, 'yarn.lock'))
          ? 'yarn'
          : existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))
            ? 'bun'
            : 'npm';
      const run = (s: string) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s === 'test' && pm !== 'yarn' ? 'test' : s}`);
      const pick = (names: string[]) => names.find((n) => scripts[n]);
      const typecheck = pick(['typecheck', 'type-check', 'types', 'tsc', 'check:types']);
      const lint = pick(['lint', 'lint:check', 'eslint']);
      const format = pick(['format:check', 'fmt:check', 'prettier:check']);
      const test = pick(['test', 'test:unit', 'tests']);
      const build = pick(['build']);
      const check = pick(['check', 'verify', 'ci']);
      if (typecheck) add('implement', 'typecheck', run(typecheck));
      if (lint) add('implement', 'lint', run(lint));
      if (format) add('implement', 'format', run(format), { optional: true });
      if (test) add('review', 'tests', run(test), { timeout: 900 });
      if (check) add('final', check, run(check), { timeout: 1200 });
      else if (build) add('final', 'build', run(build));
      found.push(`package.json scripts (${pm})`);
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
    add('implement', 'cargo check', 'cargo check --all-targets');
    add('implement', 'clippy', 'cargo clippy --all-targets -- -D warnings', { optional: true });
    add('review', 'cargo test', 'cargo test', { timeout: 900 });
    add('final', 'cargo build', 'cargo build --release', { timeout: 1200 });
    found.push('Cargo.toml');
  }

  if (read('go.mod') !== null) {
    add('implement', 'go vet', 'go vet ./...');
    add('review', 'go test', 'go test ./...', { timeout: 900 });
    add('final', 'go build', 'go build ./...');
    found.push('go.mod');
  }

  const pyproject = read('pyproject.toml');
  const python = pyproject ?? read('setup.cfg') ?? read('pytest.ini') ?? read('requirements-dev.txt');
  if (python !== null) {
    const text = [pyproject, read('setup.cfg'), read('requirements-dev.txt')].filter(Boolean).join('\n');
    if (/\bruff\b/.test(text)) add('implement', 'ruff', 'ruff check .', { paths: ['*.py'] });
    if (/\bmypy\b/.test(text)) add('implement', 'mypy', 'mypy .', { paths: ['*.py'] });
    add('review', 'pytest', 'pytest -q', { timeout: 900 });
    found.push('Python project');
  }

  return { hooks, found };
}

function baseBranch(root: string): string | undefined {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return ref.replace(/^refs\/remotes\/origin\//, '') || undefined;
  } catch {
    return undefined;
  }
}

/** The file as written: commented, so it explains itself to whoever opens it. */
export function renderConfig(hooks: Detected, base: string | undefined): string {
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
  // Run a stage yourself with:  coplan check review
  "hooks": {
    "implement": ${stage('implement')},
    "review": ${stage('review')},
    "final": ${stage('final')}
  },
  // How a build runs by default; the submit dialog can change it per plan.
  //   review:    subagent | self | user | skip
  //   parallel:  how many ready tasks are built at once
  //   maxRounds: review rounds before Claude stops and asks you
  "iric": ${JSON.stringify(DEFAULT_BUILD_SETTINGS).replace(/,"/g, ', "').replace(/":/g, '": ')},
  "branches": ${JSON.stringify({ ...(base ? { base } : {}), prefix: 'coplan/' }).replace(/,"/g, ', "').replace(/":/g, '": ')}
}
`;
}

export async function runInit(args: string[], cwd = process.cwd()): Promise<number> {
  const root = repoRootOf(cwd);
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
