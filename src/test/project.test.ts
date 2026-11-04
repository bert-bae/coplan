import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globMatch, hooksFor, loadProjectConfig, nameFor, parseProjectConfig } from '../shared/project.ts';
import { detectHooks } from '../cli/init.ts';

/**
 * A repository's `.coplan/config.json`: the checks every task runs, so no
 * agent has to guess — read forgivingly, with every problem said out loud —
 * and `coplan check` / `coplan init`, which run and write it.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'coplan-project-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('hooks are commands or objects, per stage, with names worked out', () => {
  const config = parseProjectConfig({
    hooks: {
      implement: ['npm run typecheck', 'make lint', { run: 'cargo clippy', optional: true }],
      review: { name: 'tests', run: 'npm test', timeout: 900, paths: ['src/**'] },
    },
    iric: { review: 'self', parallel: 4 },
    branches: { base: 'main', prefix: 'coplan/' },
  });
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.hooks.implement.map((h) => h.name), ['typecheck', 'lint', 'cargo clippy']);
  assert.equal(config.hooks.implement[2]!.optional, true);
  assert.deepEqual(config.hooks.review, [{ name: 'tests', run: 'npm test', timeout: 900, paths: ['src/**'] }]);
  assert.deepEqual(config.hooks.final, []);
  assert.deepEqual(config.settings, { review: 'self', parallel: 4, maxRounds: 3 });
  assert.deepEqual(config.branches, { base: 'main', prefix: 'coplan/' });
});

test('what cannot be read is said, never silently dropped', () => {
  const config = parseProjectConfig({ hooks: { lint: ['x'], review: [{ name: 'no command' }, 'npm test'] } });
  assert.match(config.errors.join('\n'), /"hooks\.lint" is not a stage/);
  assert.match(config.errors.join('\n'), /"hooks\.review\[0\]" needs a command/);
  assert.deepEqual(config.hooks.review.map((h) => h.run), ['npm test']);

  const dir = repo({ '.coplan/config.json': '{ "hooks": ' });
  try {
    const broken = loadProjectConfig(dir);
    assert.match(broken.errors[0] ?? '', /could not be read/);
    assert.ok(broken.file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file may explain itself with line comments', () => {
  const dir = repo({ '.coplan/config.json': '{\n  // the gate\n  "hooks": { "review": ["npm test"] }\n}\n' });
  try {
    assert.deepEqual(loadProjectConfig(dir).hooks.review.map((h) => h.name), ['test']);
    assert.equal(loadProjectConfig(path.join(dir, 'nowhere')).file, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hook limited to some files applies to tasks that touch them, and to tasks that do not say', () => {
  const config = parseProjectConfig({ hooks: { implement: ['npm run typecheck', { name: 'ruff', run: 'ruff check .', paths: ['*.py', 'tools/'] }] } });
  const names = (files?: string[]) => hooksFor(config, 'implement', files).map((h) => h.name);
  assert.deepEqual(names(['src/app.ts']), ['typecheck']);
  assert.deepEqual(names(['lib/deep/thing.py']), ['typecheck', 'ruff']);
  assert.deepEqual(names(['tools/gen.sh']), ['typecheck', 'ruff']);
  assert.deepEqual(names([]), ['typecheck', 'ruff']);
  assert.deepEqual(names(), ['typecheck', 'ruff']);
});

test('globs: ** crosses directories, * does not, a bare pattern matches names anywhere', () => {
  assert.ok(globMatch('src/**', 'src/a/b.ts'));
  assert.ok(globMatch('src/**/*.ts', 'src/b.ts'));
  assert.ok(globMatch('src/*.ts', 'src/b.ts'));
  assert.ok(!globMatch('src/*.ts', 'src/a/b.ts'));
  assert.ok(globMatch('*.md', 'docs/guide/README.md'));
  assert.ok(globMatch('./docs/', 'docs/a.md'));
  assert.ok(!globMatch('docs/', 'src/docs.ts'));
  assert.ok(globMatch('file?.txt', 'file1.txt'));
  assert.ok(!globMatch('a.b', 'aXb'), 'dots are literal');
});

test('hook names come from the command', () => {
  assert.equal(nameFor('npm run lint:fix'), 'lint:fix');
  assert.equal(nameFor('pnpm test'), 'test');
  assert.equal(nameFor('go test ./...'), 'go test');
  assert.equal(nameFor('./scripts/check.sh --all'), './scripts/check.sh --all');
});

/* ------------------------------------------------------------------ *
 * The CLI
 * ------------------------------------------------------------------ */

test('coplan check runs a stage, shows only what failed, and exits by the required checks', () => {
  const dir = repo({
    '.coplan/config.json': JSON.stringify({
      hooks: {
        review: [
          { name: 'passes', run: 'echo all good' },
          { name: 'fails', run: 'echo first line; echo the real error; exit 3' },
          { name: 'advisory', run: 'exit 1', optional: true },
        ],
        implement: [{ name: 'py only', run: 'exit 1', paths: ['*.py'] }],
      },
    }),
  });
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'check', ...args], { cwd: path.join(dir, '.coplan'), encoding: 'utf8' });
    const out = run('review');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /✓ passes/);
    assert.match(out.stdout, /✗ fails {2}\(exit 3/);
    assert.match(out.stdout, /    the real error/);
    assert.doesNotMatch(out.stdout, /all good/, 'a passing hook prints nothing of its own');
    assert.match(out.stdout, /⚠ advisory/);
    assert.match(out.stdout, /review: 1 passed, 1 failed, 1 optional failed/);

    const json = run('review', '--json');
    const results = JSON.parse(json.stdout.trim().split('\n').pop()!) as { name: string; ok: boolean; note?: string }[];
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [['passes', true], ['fails', false], ['advisory', false]]);
    assert.match(results[1]!.note ?? '', /exit 3: the real error/);

    const scoped = run('implement', '--files', 'src/app.ts');
    assert.equal(scoped.status, 0);
    assert.match(scoped.stdout, /No implement hooks apply to these files/);
    assert.match(run('implement', '--list').stdout, /py only: exit 1/);
    assert.equal(run('lint').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coplan check without a config says so, and how to make one', () => {
  const dir = repo({});
  try {
    const out = spawnSync(process.execPath, [CLI, 'check'], { cwd: dir, encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /No \.coplan\/config\.json.*coplan init/);
    const json = spawnSync(process.execPath, [CLI, 'check', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(json.stdout), [], 'stdout stays parseable');
    assert.match(json.stderr, /No \.coplan\/config\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a config coplan check cannot read fails, rather than passing with nothing run', () => {
  const dir = repo({ '.coplan/config.json': '{ "hooks": { "review": ["npm test"' });
  try {
    const out = spawnSync(process.execPath, [CLI, 'check', 'review', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(out.status, 2);
    assert.equal(out.stdout, '');
    assert.match(out.stderr, /could not be read[\s\S]*nothing was run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a timed-out hook is stopped with everything it started', () => {
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'hangs', run: 'sleep 20; echo done', timeout: 1 }] } }) });
  try {
    const started = Date.now();
    const out = spawnSync(process.execPath, [CLI, 'check', 'review'], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
    assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started}ms`);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /✗ hangs {2}\(timed out after 1s/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coplan init writes a commented starting point from the scripts it finds, and never over one', () => {
  const dir = repo({
    'package.json': JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'node --test', build: 'esbuild' } }),
    'pnpm-lock.yaml': '',
    'pyproject.toml': '[tool.ruff]\n',
  });
  try {
    const { hooks, found } = detectHooks(dir);
    assert.deepEqual(hooks.implement.map((h) => h.run), ['pnpm typecheck', 'pnpm lint', 'ruff check .']);
    assert.deepEqual(hooks.review.map((h) => h.run), ['pnpm test', 'pytest -q']);
    assert.deepEqual(hooks.final.map((h) => h.run), ['pnpm build']);
    assert.ok(found.some((f) => /pnpm/.test(f)));

    const first = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const text = readFileSync(path.join(dir, '.coplan', 'config.json'), 'utf8');
    assert.match(text, /\/\/ Coplan — what the build runs/);
    const config = loadProjectConfig(dir);
    assert.deepEqual(config.errors, [], 'what init writes reads back');
    assert.deepEqual(config.hooks.review.map((h) => h.name), ['tests', 'pytest']);
    assert.equal(config.branches.prefix, 'coplan/');

    const again = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
