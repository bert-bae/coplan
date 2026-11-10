import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_KEYS, INSTRUCTION_POINTS, PROJECT_KEYS, PR_OPEN, PR_TOOLS, expandBraces, globMatch, hookCommand, hooksFor, loadProjectConfig, nameFor, parseProjectConfig, pathsMatch } from '../shared/project.ts';
import { GAP_RULES, GAP_SEVERITIES } from '../shared/check.ts';
import { EXECUTION_MODES } from '../shared/types.ts';
import { detectHooks, renderConfig } from '../cli/init.ts';
import { parseJsonc } from '../shared/jsonc.ts';

/**
 * A repository's `.coplan/config.json`: the checks every task runs, so no
 * agent has to guess — read forgivingly, with every problem said out loud —
 * and `coplan check` / `coplan init`, which run and write it.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');

// A home of its own: the developer's ~/.claude/cc-harness/coplan.json (their
// own layer, read under every repository's) must not decide these tests.
// Set before anything reads it; `coplan check` and `init` inherit it.
process.env['CC_HARNESS_HOME'] = mkdtempSync(path.join(tmpdir(), 'coplan-project-home-'));

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

test('globs: {a,b} is either, nested too; an unclosed brace is literal', () => {
  assert.ok(globMatch('src/**/*.{ts,tsx}', 'src/ui/App.tsx'));
  assert.ok(globMatch('src/**/*.{ts,tsx}', 'src/a.ts'));
  assert.ok(!globMatch('src/**/*.{ts,tsx}', 'src/a.js'));
  assert.ok(globMatch('{src,lib}/**', 'lib/x.py'));
  assert.ok(globMatch('*.{c,{h,hpp}}', 'inc/a.hpp'));
  assert.ok(globMatch('a{b', 'a{b'));
  assert.deepEqual(expandBraces('x.{a,b,c}'), ['x.a', 'x.b', 'x.c']);
  assert.equal(expandBraces('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}', 10).length, 10, 'bounded');
});

test('a hook limited by a brace glob runs for the files it names — the gate is not silently skipped', () => {
  const config = parseProjectConfig({ hooks: { review: [{ name: 'tests', run: 'npm test', paths: ['src/**/*.{ts,tsx}'] }] } });
  assert.deepEqual(hooksFor(config, 'review', ['src/ui/App.tsx']).map((h) => h.name), ['tests']);
});

test('a !glob takes files back out of a hook', () => {
  assert.ok(pathsMatch(['src/**', '!src/gen/**'], 'src/a.ts'));
  assert.ok(!pathsMatch(['src/**', '!src/gen/**'], 'src/gen/a.ts'));
  assert.ok(pathsMatch(['!*.md'], 'src/a.ts'), 'only !globs: everything else');
  assert.ok(!pathsMatch(['!*.md'], 'README.md'));
});

test('unknown keys and values out of range are errors, each saying what is used instead', () => {
  const config = parseProjectConfig({
    hook: {},
    iric: { review: 'Subagent', parallel: 20, maxRounds: '4', rounds: 2 },
    branches: { base: 'main', perfix: 'x/', prefix: 3 },
    hooks: {
      review: [
        { run: 'npm test', timeout: 99999, paths: 'src/**', optional: 'yes', timout: 5 },
        { run: 'npm run e2e', timeout: 0.3 },
      ],
    },
  });
  const said = [...config.errors, ...config.warnings].join('\n');
  assert.match(said, /"hook" is not a setting Coplan reads/);
  assert.match(said, /"iric\.review" must be one of subagent, self, user, skip; "Subagent" is not, so self is used/);
  assert.match(said, /"iric\.parallel" must be a whole number from 1 to 8; 20 is not, so 8 is used/);
  assert.match(said, /"iric\.maxRounds" must be a whole number from 1 to 10; "4" is not, so 3 is used/);
  assert.deepEqual(config.settings, { review: 'self', parallel: 8, maxRounds: 3 }, 'what the errors say is what is used');
  assert.match(said, /iric\."rounds" is not a setting/);
  assert.match(said, /branches\."perfix" is not a setting/);
  assert.match(said, /"branches\.prefix" must be a branch name/);
  assert.match(said, /"hooks\.review\[0\]\.timeout" is at most 3600 seconds; 3600 is used/);
  assert.equal(config.hooks.review[0]!.timeout, 3600, 'too long is cut to the longest, not the default');
  assert.match(said, /"hooks\.review\[1\]\.timeout" must be seconds, from 1 to 3600; the default 600 is used/);
  assert.equal(config.hooks.review[1]!.timeout, undefined, 'never a 0-second timeout');
  assert.match(said, /"hooks\.review\[0\]\.paths" must be a list of globs/);
  assert.match(said, /"hooks\.review\[0\]\.optional" must be true or false/);
  assert.match(said, /hooks\.review\[0\]\."timout" is not a setting/);
  assert.deepEqual(config.branches, { base: 'main' });
});

test('comments anywhere outside strings, and trailing commas, are allowed', () => {
  const dir = repo({
    '.coplan/config.json': '{\n  "hooks": { "review": ["curl http://x/health", /* inline */ "npm test",], }, // the gate\n}\n',
  });
  try {
    const config = loadProjectConfig(dir);
    assert.deepEqual(config.errors, []);
    assert.deepEqual(config.hooks.review.map((h) => h.run), ['curl http://x/health', 'npm test'], 'a // inside a string is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.match(scoped.stdout, /not running py only \(\*\.py\) — the change does not touch its area/);
    assert.match(run('implement', '--all', '--list').stdout, /py only: exit 1/);
    assert.equal(run('lint').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coplan check runs only the checks for what changed: since the last commit, since the task began, or at the end since the base', () => {
  const dir = repo({
    '.coplan/config.json': JSON.stringify({
      hooks: {
        implement: [{ name: 'py lint', run: 'echo linted {files}', paths: ['*.py'] }],
        review: [
          { name: 'ts tests', run: 'echo ts', paths: ['*.ts'] },
          { name: 'py tests', run: 'echo py', paths: ['*.py'] },
          { name: 'whole', run: 'echo whole' },
          { name: 'api', run: 'echo api {files}', cwd: 'packages/api' },
        ],
        final: [{ name: 'docs', run: 'echo docs', paths: ['docs/'] }, { name: 'build', run: 'echo build' }],
      },
    }),
    'app.ts': 'export {};\n',
    'packages/api/index.ts': 'export {};\n',
  });
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'pipe' });
  try {
    g('checkout', '-qb', 'main');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const began = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    g('checkout', '-qb', 'feature');
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'check', ...args], { cwd: dir, encoding: 'utf8' });
    const ran = (out: { stdout: string }) => [...out.stdout.matchAll(/^[✓✗⚠] (.+?) {2}\(/gm)].map((m) => m[1]);

    // Nothing changed: nothing runs, and it says how to reach committed work.
    const idle = run('review');
    assert.equal(idle.status, 0);
    assert.deepEqual(ran(idle), []);
    assert.match(idle.stdout, /nothing changed since the last commit, so no check runs\. Work already committed\? Pass --since/);

    // A Python helper: its check and the whole-repository one; not the
    // TypeScript one, nor the package's.
    writeFileSync(path.join(dir, 'helper.py'), 'x = 1\n');
    const review = run('review');
    assert.deepEqual(ran(review), ['py tests', 'whole']);
    assert.match(review.stdout, /not running ts tests \(\*\.ts\), api \(packages\/api\/\) — the change since the last commit does not touch their areas/);
    // {files} is the changed files in the check's area, quoted.
    assert.match(run('implement', '--list').stdout, /py lint: echo linted 'helper\.py'/);
    // A package's check, run in its folder, gets its files from there.
    writeFileSync(path.join(dir, 'packages', 'api', 'index.ts'), 'export const a = 1;\n');
    assert.match(run('review', '--list').stdout, /api: \(cd packages\/api && echo api 'index\.ts'\)/);

    // Committed: since the last commit, nothing; since the task began, all of it.
    g('add', '-A');
    g('commit', '-qm', 'task');
    assert.deepEqual(ran(run('review')), []);
    assert.deepEqual(ran(run('review', '--since', began)), ['ts tests', 'py tests', 'whole', 'api']);
    assert.equal(run('review', '--since', 'nope').status, 2);
    // --files names the files instead; --all runs everything, as before.
    assert.deepEqual(ran(run('review', '--files', 'app.ts')), ['ts tests', 'whole']);
    assert.deepEqual(ran(run('review', '--all')), ['ts tests', 'py tests', 'whole', 'api']);
    assert.match(run('implement', '--all', '--list').stdout, /py lint: echo linted \./, 'not knowing the change, {files} is the whole repository');
    // The end: the build since the base branch, so docs never came near.
    const final = run('final');
    assert.deepEqual(ran(final), ['build']);
    assert.match(final.stdout, /not running docs \(docs\/\) — the change since main does not touch its area/);
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

test("a hook whose folder is a file, or that cannot start, fails, saying so, and the checks after it still run", () => {
  // And one the shell cannot be started for at all (a NUL in its command).
  const hooks = [{ name: 'api', run: 'true', cwd: 'notes.md' }, { name: 'nul', run: 'true\u0000' }, { name: 'after', run: 'true' }];
  const dir = repo({ 'notes.md': '# not a folder\n', '.coplan/config.json': JSON.stringify({ hooks: { review: hooks } }) });
  try {
    assert.match(loadProjectConfig(dir, { globalDir: null }).warnings.join('\n'), /"hooks\.review\[0\]\.cwd" names notes\.md, which is a file, not a folder/);
    const run = spawnSync(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
    assert.match(run.stdout, /✗ api[\s\S]*its folder notes\.md is not a folder/, run.stdout + run.stderr);
    assert.match(run.stdout, /✗ nul/);
    assert.match(run.stdout, /✓ after/);
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stderr, /\n\s+at /, 'no stack');
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

test('a timed-out hook is over only once what it started has gone, even what ignores SIGTERM', { skip: process.platform === 'win32' }, () => {
  // A worker that ignores SIGTERM, its output elsewhere: the hook's output closes without it.
  const hangs = "(trap '' TERM; sleep 20) >/dev/null 2>&1 & echo $! > worker; echo $$ > group; wait";
  // The next check says whether the worker is still running (a zombie has gone).
  const next = 'state=$(ps -o stat= -p "$(cat worker)"); case "$state" in ""|Z*) echo gone ;; *) echo running ;; esac > next';
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'hangs', run: hangs, timeout: 1 }, { name: 'next', run: next }] } }) });
  try {
    const out = spawnSync(process.execPath, [CLI, 'check', 'review'], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
    assert.match(out.stdout, /✗ hangs {2}\(timed out after 1s/);
    assert.equal(readFileSync(path.join(dir, 'next'), 'utf8').trim(), 'gone', 'the next check started once the worker had gone, killed');
  } finally {
    try {
      process.kill(-Number(readFileSync(path.join(dir, 'group'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hook that ends in time is not taken as timed out while its output is let go', { skip: process.platform !== 'linux' }, () => {
  // Ended 200 ms before its timeout, its output held open from outside its group: the let-go runs past the timeout.
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'quick', run: 'setsid sleep 5 & echo $! > holder; sleep 0.8; echo done', timeout: 1 }] } }) });
  try {
    const out = spawnSync(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
    assert.match(out.stdout, /✓ quick/, out.stdout);
    assert.equal(out.status, 0);
  } finally {
    try {
      process.kill(Number(readFileSync(path.join(dir, 'holder'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a timed-out hook whose output is held open from outside its group still ends', { skip: process.platform === 'win32' }, () => {
  // A helper in a group of its own, holding the hook's output open.
  const helper = `node -e "const c = require('child_process').spawn('sleep', ['20'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); require('fs').writeFileSync('helper', String(c.pid)); c.unref()"`;
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'serve', run: `${helper}; echo last words; sleep 20`, timeout: 1 }] } }) });
  try {
    const started = Date.now();
    const out = spawnSync(process.execPath, [CLI, 'check', 'review'], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`);
    assert.match(out.stdout, /✗ serve {2}\(timed out after 1s/);
    assert.match(out.stdout + out.stderr, /last words/, 'with what it said');
  } finally {
    try {
      process.kill(Number(readFileSync(path.join(dir, 'helper'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hook that ends with its output held open from outside its group is over when it ends, as it ended', { skip: process.platform === 'win32' }, () => {
  // A dev server started detached, still writing to the hook's output.
  const helper = `node -e "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => console.log(1), 50)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); require('fs').writeFileSync('helper', String(c.pid)); c.unref()"`;
  // The check after it finds the server still up: its output is not cut off under it.
  const after = 'sleep 0.5; case "$(ps -o stat= -p "$(cat helper)")" in ""|Z*) ;; *) echo up > alive ;; esac';
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'serve', run: `${helper}; echo served`, timeout: 8 }, { name: 'after', run: after }] } }) });
  try {
    const started = Date.now();
    const out = spawnSync(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /✓ serve/);
    assert.ok(Date.now() - started < 5_000, `not its timeout (${Date.now() - started}ms)`);
    assert.equal(existsSync(path.join(dir, 'alive')), true, 'the server it started was still up');
  } finally {
    try {
      process.kill(Number(readFileSync(path.join(dir, 'helper'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coplan init runs the repository's own scripts, never a package manager's command of the same name", () => {
  // yarn check is yarn's integrity check, bun test is Bun's test runner, pnpm ci is pnpm's own (unimplemented) command.
  const cases: [string, string, Record<string, string>, { implement?: string; review?: string; final?: string }][] = [
    ['yarn', 'yarn.lock', { typecheck: 'tsc', test: 'jest', check: 'tsc && jest' }, { implement: 'yarn run typecheck', review: 'yarn run test', final: 'yarn run check' }],
    ['bun', 'bun.lock', { test: 'vitest', build: 'vite build' }, { review: 'bun run test', final: 'bun run build' }],
    ['pnpm', 'pnpm-lock.yaml', { test: 'vitest', ci: 'pnpm lint && pnpm test' }, { review: 'pnpm run test', final: 'pnpm run ci' }],
    ['npm', 'package-lock.json', { test: 'mocha', verify: 'npm test' }, { review: 'npm run test', final: 'npm run verify' }],
  ];
  for (const [pm, lock, scripts, want] of cases) {
    const dir = repo({ 'package.json': JSON.stringify({ scripts }), [lock]: '' });
    try {
      const { hooks } = detectHooks(dir);
      const got = { implement: hooks.implement[0]?.run, review: hooks.review[0]?.run, final: hooks.final[0]?.run };
      assert.deepEqual(got, { implement: undefined, ...want }, pm);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("coplan init takes the package manager package.json names, before any lockfile", () => {
  const cases: [string, Record<string, string>, string][] = [
    ['named, no lockfile yet', { 'package.json': JSON.stringify({ packageManager: 'pnpm@10.28.0', scripts: { test: 'vitest' } }) }, 'pnpm run test'],
    ['named, a stray lockfile', { 'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0+sha512.abc', scripts: { test: 'jest' } }), 'pnpm-lock.yaml': '' }, 'yarn run test'],
    ['bun', { 'package.json': JSON.stringify({ packageManager: 'bun@1.1.0', scripts: { test: 'bun test' } }) }, 'bun run test'],
    ['one it does not know: the lockfile', { 'package.json': JSON.stringify({ packageManager: 'deno@2', scripts: { test: 'x' } }), 'pnpm-lock.yaml': '' }, 'pnpm run test'],
    ['not a string: the lockfile', { 'package.json': JSON.stringify({ packageManager: 7, scripts: { test: 'x' } }), 'yarn.lock': '' }, 'yarn run test'],
  ];
  for (const [what, files, want] of cases) {
    const dir = repo(files);
    try {
      assert.deepEqual(detectHooks(dir).hooks.review.map((h) => h.run), [want], what);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    assert.deepEqual(hooks.implement.map((h) => h.run), ['pnpm run typecheck', 'pnpm run lint', 'ruff check {files}']);
    // Targeted from the start: a language's tools only for that language;
    // a test suite whole, since it may read anything.
    assert.deepEqual(hooks.implement.map((h) => h.paths?.[0]), ['*.ts', '*.ts', '*.py']);
    assert.equal(hooks.review[0]!.paths, undefined);
    assert.deepEqual(hooks.review.map((h) => h.run), ['pnpm run test', 'pytest -q']);
    assert.deepEqual(hooks.final.map((h) => h.run), ['pnpm run build']);
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

/* ---------------------------------------------------- customization (#45) */

test('every key the config reads is documented, with every value it takes', () => {
  const doc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'CONFIG.md'), 'utf8');
  for (const key of PROJECT_KEYS) assert.match(doc, new RegExp(`^### \`${key}\`$`, 'm'), `a section for ${key}`);
  for (const key of HOOK_KEYS) assert.match(doc, new RegExp(`^\\| \`${key}\` \\|`, 'm'), `hook key ${key}`);
  for (const value of [...EXECUTION_MODES, ...PR_TOOLS, ...PR_OPEN, ...INSTRUCTION_POINTS, ...GAP_RULES, ...GAP_SEVERITIES]) {
    assert.ok(doc.includes(`\`${value}\``), `${value} is named`);
  }
});

test('pull requests, the reviewer, the final gate, instructions and plan-check severities are read, each checked', () => {
  const dir = repo({
    '.github/pull_request_template.md': '## What\n\n## Checks\n',
    'packages/api/.keep': '',
    'docs/review.md': 'Check every query is parameterised.',
  });
  try {
    const config = parseProjectConfig(
      {
        pullRequests: { tool: 'graphite', open: 'auto', template: '.github/pull_request_template.md' },
        review: { model: 'opus' },
        final: { blocking: true },
        instructions: { build: 'Keep commits small.', review: { file: 'docs/review.md' } },
        planCheck: { 'box-unbuilt': 'error', 'box-undescribed': 'off' },
        hooks: { review: [{ name: 'api tests', run: 'pnpm test', cwd: 'packages/api', env: { NODE_ENV: 'test' } }] },
      },
      path.join(dir, '.coplan', 'config.json'),
    );
    assert.deepEqual(config.errors, []);
    assert.equal(config.pullRequests.tool, 'graphite');
    assert.equal(config.pullRequests.open, 'auto');
    assert.match(config.pullRequests.template ?? '', /## Checks/);
    assert.equal(config.review.model, 'opus');
    assert.equal(config.final.blocking, true);
    assert.equal(config.instructions.build, 'Keep commits small.');
    assert.equal(config.instructions.review, 'Check every query is parameterised.');
    assert.deepEqual(config.planCheck, { 'box-unbuilt': 'error', 'box-undescribed': 'off' });
    assert.deepEqual(config.hooks.review[0], { name: 'api tests', run: 'pnpm test', cwd: 'packages/api', env: { NODE_ENV: 'test' } });
    assert.equal(hookCommand(config.hooks.review[0]!), "(cd packages/api && env NODE_ENV=test sh -c 'pnpm test')");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the defaults: gh, once the user says, no reviewer model, the report never held', () => {
  const config = parseProjectConfig({});
  assert.deepEqual(config.pullRequests, { tool: 'gh', open: 'ask' });
  assert.deepEqual(config.review, {});
  assert.deepEqual(config.final, { blocking: false });
  assert.deepEqual(config.instructions, {});
  assert.deepEqual(config.planCheck, {});
});

test('what a customization cannot use is said — and a file outside the repository is never read', () => {
  const dir = repo({});
  try {
    const config = parseProjectConfig(
      {
        pullRequests: { tool: 'gitlab', open: 'later', template: '../../etc/passwd' },
        review: { model: 'opus; rm -rf /' },
        final: { blocking: 'yes' },
        instructions: { build: 3, deploy: 'x', brief: { file: 'missing.md' } },
        planCheck: { 'box-unbuilt': 'fatal', 'no-such-rule': 'error' },
        hooks: { review: [{ run: 'pnpm test', cwd: '../elsewhere', env: { 'BAD NAME': 'x', OK: 1 } }] },
      },
      path.join(dir, '.coplan', 'config.json'),
    );
    const said = config.errors.join('\n');
    assert.match(said, /"pullRequests\.tool" must be one of gh, graphite, none; "gitlab" is not/);
    assert.match(said, /"pullRequests\.open" must be one of auto, ask, never/);
    assert.match(said, /"pullRequests\.template" must name a file inside/);
    assert.equal(config.pullRequests.template, undefined);
    assert.match(said, /"review\.model" must be a model name/);
    assert.match(said, /"final\.blocking" must be true or false/);
    assert.match(said, /"instructions\.build" must be text/);
    assert.match(said, /instructions\."deploy" is not a setting/);
    assert.match(said, /"instructions\.brief" names missing\.md, which could not be read/);
    assert.match(said, /"planCheck\.box-unbuilt" must be one of error, warn, off/);
    assert.match(said, /"planCheck\.no-such-rule" is not a plan-check rule/);
    assert.match(said, /"hooks\.review\[0\]\.cwd" must be a folder inside the repository/);
    assert.match(said, /"hooks\.review\[0\]\.env" must map variable names to text/);
    assert.equal(config.hooks.review[0]!.cwd, undefined, 'it runs from the root instead');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what is only taken differently than written is a warning, and the checks still run', () => {
  const dir = repo({ 'long.md': 'x'.repeat(5000) });
  try {
    const config = parseProjectConfig(
      { instructions: { build: { file: 'long.md' } }, hooks: { review: [{ run: 'npm test', cwd: 'packages/not-yet' }] } },
      path.join(dir, '.coplan', 'config.json'),
    );
    assert.deepEqual(config.errors, [], 'nothing that stops coplan check');
    assert.match(config.warnings.join('\n'), /"instructions\.build" \(long\.md\) is longer than 4000 characters; the rest is cut/);
    assert.match(config.warnings.join('\n'), /"hooks\.review\[0\]\.cwd" names packages\/not-yet, which does not exist yet/);
    assert.equal(config.instructions.build?.length, 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only what breaks the checks stops coplan check; a hook whose folder is missing fails, saying so', () => {
  const dir = repo({
    '.coplan/config.json': JSON.stringify({
      pullRequests: { template: 'missing.md' },
      review: { model: 'not a model!' },
      hooks: { review: ['true', { name: 'api', run: 'true', cwd: 'packages/api' }] },
    }),
  });
  try {
    const config = loadProjectConfig(dir);
    assert.ok(config.errors.length >= 2, 'the template and the model are errors');
    assert.equal(config.checksBroken, undefined, 'but not of the checks');
    assert.equal(config.hooks.review[1]!.cwd, 'packages/api', 'kept, so the hook cannot pass somewhere else');
    // Its folder is missing, so no change can be in it: --all runs it anyway.
    const run = spawnSync(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 1, 'ran, and the api hook failed');
    assert.match(run.stdout, /✓ true/);
    assert.match(run.stdout, /✗ api[\s\S]*its folder packages\/api does not exist/);
    assert.match(run.stderr, /missing\.md, which could not be read/);

    writeFileSync(path.join(dir, '.coplan', 'config.json'), JSON.stringify({ hook: { review: ['true'] } }));
    const typo = spawnSync(process.execPath, [CLI, 'check', 'review'], { cwd: dir, encoding: 'utf8' });
    assert.equal(typo.status, 2, 'a misspelt "hooks" is the checks themselves');
    assert.match(typo.stderr, /fix the checks in \.coplan\/config\.json first/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a template from the user's own layer is named by where it is, and a hook's folder is watched", () => {
  const home = mkdtempSync(path.join(tmpdir(), 'coplan-home-'));
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ run: 'true', cwd: 'packages/api' }] } }) });
  try {
    writeFileSync(path.join(home, 'pr.md'), '## Mine');
    writeFileSync(path.join(home, 'coplan.json'), JSON.stringify({ pullRequests: { template: 'pr.md' } }));
    const config = loadProjectConfig(dir, { globalDir: home });
    assert.equal(config.pullRequests.templateFile, path.join(home, 'pr.md'), 'not "pr.md" in the repository');
    assert.equal(config.pullRequests.template, '## Mine');
    assert.ok(config.sources?.includes(path.join(dir, 'packages', 'api')), 'its creation reads the config again');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a user's own layer that cannot be read is said, and holds back no repository's checks", () => {
  const home = mkdtempSync(path.join(tmpdir(), 'coplan-home-'));
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: ['true'] } }) });
  try {
    writeFileSync(path.join(home, 'coplan.json'), '{ "iric": { "review": "self" }, oops }');
    const config = loadProjectConfig(dir, { globalDir: home });
    assert.deepEqual(config.errors, []);
    assert.match(config.warnings.join('\n'), /coplan\.json could not be read/);
    assert.equal(config.globalFile, path.join(home, 'coplan.json'), 'named, so the user knows which file to fix');
    assert.ok(config.sources?.includes(path.join(home, 'coplan.json')) && config.sources.includes(path.join(dir, '.coplan', 'config.json')));
    const run = spawnSync(process.execPath, [CLI, 'check', 'review'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CC_HARNESS_HOME: home } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /coplan\.json could not be read/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file a config names is read only if it really is inside: a link out is refused', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'coplan-secret-'));
  const dir = repo({});
  try {
    writeFileSync(path.join(outside, 'credentials'), 'secret');
    symlinkSync(path.join(outside, 'credentials'), path.join(dir, 'pr.md'));
    const config = parseProjectConfig({ pullRequests: { template: 'pr.md' } }, path.join(dir, '.coplan', 'config.json'));
    assert.equal(config.pullRequests.template, undefined);
    assert.match(config.errors.join('\n'), /"pullRequests\.template" must name a file inside .*: pr\.md links to one outside it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the user's own layer sits under every repository's: key by key, instructions adding up, checks never", () => {
  const home = mkdtempSync(path.join(tmpdir(), 'coplan-home-'));
  const dir = repo({
    '.coplan/config.json': JSON.stringify({ iric: { parallel: 4 }, pullRequests: { open: 'never' }, instructions: { build: 'Repository words.' } }),
  });
  try {
    writeFileSync(
      path.join(home, 'coplan.json'),
      JSON.stringify({
        iric: { review: 'self', parallel: 2 },
        branches: { prefix: 'me/' },
        pullRequests: { tool: 'graphite', open: 'auto' },
        instructions: { build: 'My words.' },
        hooks: { review: ['make test'] },
      }),
    );
    mkdirSync(path.join(home, 'instructions'));
    writeFileSync(path.join(home, 'instructions', 'brief.md'), 'Write tests first.');
    const config = loadProjectConfig(dir, { globalDir: home });
    assert.deepEqual(config.settings, { review: 'self', parallel: 4, maxRounds: 3 }, 'the repository wins where both say');
    assert.equal(config.branches.prefix, 'me/');
    assert.deepEqual(config.pullRequests, { tool: 'graphite', open: 'never' });
    assert.equal(config.instructions.build, 'My words.\n\nRepository words.');
    assert.equal(config.instructions.brief, 'Write tests first.');
    assert.deepEqual(config.hooks.review, [], 'checks belong to the repository');
    assert.match(config.warnings.join('\n'), /coplan\.json: "hooks" belong to each repository/);
    assert.equal(config.globalFile, path.join(home, 'coplan.json'));
    // Without a repository config, the user's layer still counts.
    assert.equal(loadProjectConfig(path.join(dir, 'nowhere'), { globalDir: home }).pullRequests.open, 'auto');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------- execution modes (#62) */

test('the mode defaults to Tracked, to Managed where the repository sets iric, and `mode` says otherwise', () => {
  const none = loadProjectConfig(null, { globalDir: null });
  assert.equal(none.mode, 'tracked', 'neither: Tracked');
  assert.equal(none.origins?.['mode'], undefined, "Coplan's default");

  const iric = parseProjectConfig({ iric: { review: 'self' } }, '/r/.coplan/config.json');
  assert.equal(iric.mode, 'managed', 'iric opts in to the harness');
  assert.equal(iric.modeByIric, true);
  assert.deepEqual(iric.origins?.['mode'], ['.coplan/config.json']);
  assert.equal(parseProjectConfig({ iric: { review: 'self' }, mode: 'tracked' }).mode, 'tracked', 'mode wins over iric');
  for (const mode of ['export', 'tracked', 'managed'] as const) assert.equal(parseProjectConfig({ mode }).mode, mode);

  const wrong = parseProjectConfig({ mode: 'harness' });
  assert.equal(wrong.mode, 'tracked');
  assert.match(wrong.errors.join('\n'), /"mode" must be one of export, tracked, managed; "harness" is not/);
});

test("this repository's own config sets iric, so its builds are Managed by default", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const own = loadProjectConfig(root, { globalDir: null });
  assert.deepEqual(own.errors, []);
  assert.equal(own.mode, 'managed');
  assert.equal(own.modeByIric, true);
});

test("the user's own mode holds under every repository, a repository's iric or mode wins over it, and the user's own iric alone does not choose", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coplan-mode-'));
  const home = path.join(dir, 'home');
  const repoDir = (name: string, config?: unknown) => {
    const root = path.join(dir, name);
    mkdirSync(path.join(root, '.coplan'), { recursive: true });
    if (config !== undefined) writeFileSync(path.join(root, '.coplan', 'config.json'), JSON.stringify(config));
    return root;
  };
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'coplan.json'), JSON.stringify({ mode: 'managed' }));
    const mine = loadProjectConfig(repoDir('plain'), { globalDir: home });
    assert.equal(mine.mode, 'managed');
    assert.deepEqual(mine.origins?.['mode'], [path.join(home, 'coplan.json')]);
    assert.equal(loadProjectConfig(repoDir('tracked', { mode: 'tracked' }), { globalDir: home }).mode, 'tracked');

    writeFileSync(path.join(home, 'coplan.json'), JSON.stringify({ mode: 'tracked', iric: { review: 'self' } }));
    const opted = loadProjectConfig(repoDir('opted', { iric: { parallel: 3 } }), { globalDir: home });
    assert.equal(opted.mode, 'managed', "the repository's iric is more specific than the user's mode");
    assert.deepEqual(opted.settings, { review: 'self', parallel: 3, maxRounds: 3 });

    writeFileSync(path.join(home, 'coplan.json'), JSON.stringify({ iric: { review: 'self' } }));
    assert.equal(loadProjectConfig(repoDir('other'), { globalDir: home }).mode, 'tracked', 'the user\'s iric says how a Managed build runs, not that every build is Managed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coplan init opts the repository in to Managed builds, with or without iric of its own', () => {
  for (const settings of [true, false]) {
    const text = renderConfig({ implement: [], review: [], final: [] }, 'main', { settings });
    const config = parseProjectConfig(parseJsonc(text), '/r/.coplan/config.json');
    assert.deepEqual(config.errors, []);
    assert.equal(config.mode, 'managed', settings ? 'iric' : 'mode');
  }
});

test("coplan init reads a package.json saved with a byte order mark, as npm does", () => {
  const dir = repo({ 'package.json': '\uFEFF' + JSON.stringify({ scripts: { test: 'vitest' } }), 'package-lock.json': '' });
  try {
    assert.deepEqual(detectHooks(dir).hooks.review.map((h) => h.run), ['npm run test']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository's checks saved with a byte order mark still run", () => {
  const dir = repo({ '.coplan/config.json': '\uFEFF{\n  // saved by a Windows editor\n  "hooks": { "review": ["npm run test"] }\n}\n' });
  try {
    const config = loadProjectConfig(dir, { globalDir: null });
    assert.deepEqual(config.errors, []);
    assert.equal(config.checksBroken, undefined);
    assert.deepEqual(config.hooks.review.map((h) => h.run), ['npm run test']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ctrl+C on `coplan check` stops the check it is running, not only itself', { skip: process.platform === 'win32' }, async () => {
  // The check says when it has started, and which process group it is.
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'slow', run: 'echo $$ > group; touch started; sleep 4; touch marker' }] } }) });
  const cli = spawn(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '';
  cli.stderr!.on('data', (c: Buffer) => (said += c.toString()));
  try {
    for (let i = 0; i < 100 && !existsSync(path.join(dir, 'started')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(path.join(dir, 'started')), 'the check started');
    const started = Date.now();
    cli.kill('SIGINT');
    const code = await new Promise<number | null>((r) => cli.on('exit', (c) => r(c)));
    assert.equal(code, 130, 'it exits as an interrupted command does');
    assert.ok(Date.now() - started < 3500, 'promptly');
    assert.match(said, /interrupted; stopping "slow"/);
    // Past when the check would have finished: it did not.
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(existsSync(path.join(dir, 'marker')), false, 'the check was stopped with it');
  } finally {
    cli.kill('SIGKILL');
    try {
      process.kill(-Number(readFileSync(path.join(dir, 'group'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone, as it should be */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ctrl+C on `coplan check` stops what the check started that ignores SIGTERM, not only the check', { skip: process.platform === 'win32' }, async () => {
  // The shell goes at SIGTERM; a test runner's worker in its group ignores it.
  const run = "(trap '' TERM; sleep 4; touch marker) & echo $$ > group; touch started; wait";
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'workers', run }] } }) });
  const cli = spawn(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(path.join(dir, 'started')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(path.join(dir, 'started')), 'the check started');
    const started = Date.now();
    cli.kill('SIGINT');
    const code = await new Promise<number | null>((r) => cli.on('exit', (c) => r(c)));
    assert.equal(code, 130);
    assert.ok(Date.now() - started < 4500, `within the three seconds a check gets to stop (${Date.now() - started}ms)`);
    // Past when the worker would have finished: it did not.
    await new Promise((r) => setTimeout(r, 5000 - (Date.now() - started)));
    assert.equal(existsSync(path.join(dir, 'marker')), false, 'the worker was stopped too');
  } finally {
    cli.kill('SIGKILL');
    try {
      process.kill(-Number(readFileSync(path.join(dir, 'group'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone, as it should be */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ctrl+C on `coplan check` stops the check even when nothing reads its errors any more', { skip: process.platform === 'win32' }, async () => {
  // `2>&1 | head`, or an agent that closed the pipe: saying it is stopping must not end it before it has.
  const run = "(trap '' TERM; sleep 20) & echo $! > worker; echo $$ > group; touch started; wait";
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'workers', run }] } }) });
  const cli = spawn(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    for (let i = 0; i < 100 && !existsSync(path.join(dir, 'started')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(path.join(dir, 'started')), 'the check started');
    cli.stderr!.destroy();
    await new Promise((r) => setTimeout(r, 100));
    cli.kill('SIGINT');
    const code = await new Promise<number | null>((r) => cli.on('exit', (c) => r(c)));
    assert.equal(code, 130, 'it ends as an interrupted command does');
    // Having stopped the check: its worker that ignores SIGTERM too (a zombie has gone).
    const state = spawnSync('ps', ['-o', 'stat=', '-p', readFileSync(path.join(dir, 'worker'), 'utf8').trim()], { encoding: 'utf8' }).stdout.trim();
    assert.ok(state === '' || state.startsWith('Z'), `the worker is gone (${state})`);
  } finally {
    cli.kill('SIGKILL');
    try {
      process.kill(-Number(readFileSync(path.join(dir, 'group'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while an interrupted check winds down, the checks after it do not start', { skip: process.platform === 'win32' }, async () => {
  // A worker that takes a moment to stop: the check is over before it is.
  const slow = "(trap 'sleep 0.3; exit 0' TERM; while :; do sleep 0.1; done) & echo $$ > group; touch started; wait";
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'slow', run: slow }, { name: 'next', run: 'touch next' }] } }) });
  const cli = spawn(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(path.join(dir, 'started')); i++) await new Promise((r) => setTimeout(r, 100));
    cli.kill('SIGINT');
    assert.equal(await new Promise<number | null>((r) => cli.on('exit', (c) => r(c))), 130);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(path.join(dir, 'next')), false, 'the next check never ran');
  } finally {
    cli.kill('SIGKILL');
    try {
      process.kill(-Number(readFileSync(path.join(dir, 'group'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupted check that left something running out of its group cannot hold `coplan check` open', { skip: process.platform === 'win32' }, async () => {
  // A helper the check starts in a group of its own, holding the check's output open.
  const helper = `node -e "const c = require('child_process').spawn('sleep', ['20'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); require('fs').writeFileSync('helper', String(c.pid)); c.unref()"`;
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'serve', run: `${helper}; touch started; sleep 10` }] } }) });
  const cli = spawn(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(path.join(dir, 'started')); i++) await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    cli.kill('SIGINT');
    const code = await new Promise<number | null>((r) => cli.on('exit', (c) => r(c)));
    assert.equal(code, 130);
    assert.ok(Date.now() - started < 4000, `it ends without waiting for the helper (${Date.now() - started}ms)`);
  } finally {
    cli.kill('SIGKILL');
    try {
      process.kill(Number(readFileSync(path.join(dir, 'helper'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ctrl+C while a timed-out check is being stopped ends with that stop, not three seconds after', { skip: process.platform === 'win32' }, async () => {
  const run = "(trap '' TERM; sleep 20) & echo $$ > group; touch started; wait";
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'stubborn', run, timeout: 1 }] } }) });
  const cli = spawn(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(path.join(dir, 'started')); i++) await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    // Timed out at one second, killed at four: interrupted between, it ends then.
    await new Promise((r) => setTimeout(r, 2_500));
    cli.kill('SIGINT');
    assert.equal(await new Promise<number | null>((r) => cli.on('exit', (c) => r(c))), 130);
    assert.ok(Date.now() - started < 4_900, `with the stop under way (${Date.now() - started}ms)`);
  } finally {
    cli.kill('SIGKILL');
    try {
      process.kill(-Number(readFileSync(path.join(dir, 'group'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second Ctrl+C ends `coplan check` at once, even with a check that ignores the first', { skip: process.platform === 'win32' }, async () => {
  const dir = repo({ '.coplan/config.json': JSON.stringify({ hooks: { review: [{ name: 'stubborn', run: "trap '' TERM; echo $$ > group; touch started; sleep 10" }] } }) });
  const cli = spawn(process.execPath, [CLI, 'check', 'review', '--all'], { cwd: dir, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(path.join(dir, 'started')); i++) await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    cli.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    cli.kill('SIGINT');
    const code = await new Promise<number | null>((r) => cli.on('exit', (c) => r(c)));
    assert.equal(code, 130);
    assert.ok(Date.now() - started < 1500, `not the three seconds a check gets to stop (${Date.now() - started}ms)`);
  } finally {
    cli.kill('SIGKILL');
    try {
      process.kill(-Number(readFileSync(path.join(dir, 'group'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
