import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_FILE,
  askBuildDefaults,
  askRepositories,
  askSettings,
  installClaude,
  installCodex,
  installCursor,
  setup,
  stagePlugin,
  type RunResult,
  type SetupIo,
} from '../cli/setup.ts';
import { loadProjectConfig } from '../shared/project.ts';
import { parseJsonc } from '../shared/jsonc.ts';

/**
 * `./setup.sh` and `coplan setup`: the plugin staged for the agents holds
 * everything that runs and nothing that is only for building it; each agent
 * is installed with the commands it takes; and the settings walk writes only
 * what the user chose.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'main.js');

const tmp = (name: string) => mkdtempSync(path.join(tmpdir(), `coplan-setup-${name}-`));

/** An io that answers from a script and records what was said and run. */
function scripted(answers: string[] | null, results: Record<string, RunResult> = {}) {
  const said: string[] = [];
  const asked: string[] = [];
  const ran: string[] = [];
  const queue = answers ? [...answers] : null;
  const io: SetupIo = {
    say: (line) => said.push(line),
    run: (command, args) => {
      const line = [command, ...args].join(' ');
      ran.push(line);
      const hit = Object.entries(results).find(([prefix]) => line.startsWith(prefix));
      return hit ? hit[1] : { ok: true, stdout: '', out: '' };
    },
    ...(queue
      ? {
          ask: async (q: string) => {
            asked.push(q);
            const a = queue.shift();
            if (a === undefined) throw new Error(`unexpected question: ${q}`);
            return a;
          },
        }
      : {}),
  };
  return { io, said, asked, ran, left: () => queue?.length ?? 0 };
}

/* ---------------- the staged plugin ---------------- */

const staged = (() => {
  let dir: string | null = null;
  return () => {
    if (!dir) {
      dir = path.join(tmp('stage'), '.plugin');
      stagePlugin(ROOT, dir);
    }
    return dir;
  };
})();

test('the staged plugin holds what runs, and nothing only the build needs', () => {
  const stage = staged();
  for (const gone of ['node_modules', 'src', 'scripts', 'dist/test', 'pnpm-lock.yaml', 'tsconfig.json', 'setup.sh']) {
    assert.equal(existsSync(path.join(stage, gone)), false, `${gone} is not staged`);
  }
  for (const there of ['dist/cli/main.js', 'dist/daemon/main.js', 'dist/mcp/main.js', 'dist/ui/index.html', 'dist/ui/app.js', 'dist/version.json']) {
    assert.ok(existsSync(path.join(stage, there)), `${there} is staged`);
  }
  for (const bin of ['bin/coplan', 'bin/coplan-hook-relay.sh']) {
    assert.ok((statSync(path.join(stage, bin)).mode & 0o111) !== 0, `${bin} stays executable`);
  }
});

test('every file a manifest, hook or MCP config names is in the staged plugin', () => {
  const stage = staged();
  const json = (file: string) => JSON.parse(readFileSync(path.join(stage, file), 'utf8')) as Record<string, unknown>;
  const named: string[] = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.mcp.json', 'hooks/hooks.json'];
  for (const manifest of ['.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    named.push(manifest);
    for (const key of ['skills', 'commands', 'hooks', 'mcpServers']) {
      const value = json(manifest)[key];
      if (typeof value === 'string') named.push(value);
    }
  }
  for (const file of named) assert.ok(existsSync(path.join(stage, file)), `${file} is staged`);

  // `${CLAUDE_PLUGIN_ROOT}/bin/...` and the like, in each hook and MCP file.
  const configs = ['.mcp.json', ...readdirSync(path.join(stage, 'hooks')).map((f) => `hooks/${f}`), ...readdirSync(path.join(stage, 'mcp')).map((f) => `mcp/${f}`)];
  let refs = 0;
  for (const file of configs) {
    const text = readFileSync(path.join(stage, file), 'utf8');
    for (const m of text.matchAll(/\$\{[A-Z_]*PLUGIN_ROOT\}\/([^"\s\\]+)/g)) {
      refs++;
      assert.ok(existsSync(path.join(stage, m[1]!)), `${file} names ${m[1]}, which is staged`);
    }
  }
  assert.ok(refs > 0, 'the configs name files under the plugin root');
});

test("the staged package.json names Coplan, and has nothing to install or build", () => {
  const pkg = JSON.parse(readFileSync(path.join(staged(), 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg['name'], 'coplan');
  assert.equal(pkg['version'], (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version);
  assert.equal(pkg['scripts'], undefined);
  assert.equal(pkg['devDependencies'], undefined);
  const note = JSON.parse(readFileSync(path.join(staged(), INSTALL_FILE), 'utf8')) as { clone: string };
  assert.equal(note.clone, ROOT);
});

test('staging again replaces the old copy whole', () => {
  const stage = path.join(tmp('restage'), '.plugin');
  stagePlugin(ROOT, stage);
  writeFileSync(path.join(stage, 'left-over'), 'x');
  stagePlugin(ROOT, stage);
  assert.equal(existsSync(path.join(stage, 'left-over')), false);
  assert.equal(existsSync(`${stage}.tmp`), false);
  assert.equal(existsSync(`${stage}.old`), false);
});

test('setup refuses to run from the staged copy, naming the clone', () => {
  const r = spawnSync(process.execPath, [path.join(staged(), 'dist', 'cli', 'main.js'), 'setup', '--yes'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`Run ./setup.sh in your clone: ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('setup says what it takes, and refuses an agent it does not know', () => {
  const help = spawnSync(process.execPath, [CLI, 'setup', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--agents/);
  const bad = spawnSync(process.execPath, [CLI, 'setup', '--agents', 'claude,vim'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown agent\(s\): vim/);
});

/* ---------------- the agents ---------------- */

test('Claude Code: the staged folder becomes the coplan marketplace, and Coplan is installed from it', () => {
  const { io, ran } = scripted(null);
  const failed: string[] = [];
  assert.equal(installClaude(io, '/c/.plugin', failed), true);
  assert.deepEqual(ran, [
    'claude plugin marketplace add /c/.plugin',
    'claude plugin install coplan@coplan --scope user',
    'claude plugin update coplan@coplan',
  ]);
  assert.deepEqual(failed, []);
});

test('a step that fails stops the agent, and its message is shown without a backtrace', () => {
  const out = 'Error: no such marketplace\n\nStack backtrace:\n   0: <unknown>\n   1: <unknown>\n';
  const { io, ran, said } = scripted(null, { 'claude plugin install': { ok: false, stdout: '', out } });
  const failed: string[] = [];
  assert.equal(installClaude(io, '/c/.plugin', failed), false);
  assert.equal(ran.length, 2, 'nothing runs after the step that failed');
  assert.match(failed[0]!, /Claude Code: `claude plugin install coplan@coplan --scope user` failed/);
  assert.ok(said.includes('    Error: no such marketplace'));
  assert.ok(!said.some((l) => /<unknown>|backtrace/.test(l)));
});

test('Codex: a coplan marketplace from elsewhere is removed first; the same one is kept', () => {
  const list = (root: string): RunResult => ({ ok: true, stdout: JSON.stringify({ marketplaces: [{ name: 'coplan', root }] }), out: '' });

  const moved = scripted(null, { 'codex plugin marketplace list': list('/home/u/.codex/.tmp/marketplaces/coplan') });
  assert.equal(installCodex(moved.io, '/c/.plugin', []), true);
  assert.deepEqual(moved.ran.slice(1), [
    'codex plugin marketplace remove coplan',
    'codex plugin marketplace add /c/.plugin',
    'codex plugin add coplan@coplan',
  ]);

  const same = scripted(null, { 'codex plugin marketplace list': list('/c/.plugin') });
  assert.equal(installCodex(same.io, '/c/.plugin', []), true);
  assert.deepEqual(same.ran.slice(1), ['codex plugin marketplace add /c/.plugin', 'codex plugin add coplan@coplan']);

  const unreadable = scripted(null, { 'codex plugin marketplace list': { ok: true, stdout: 'not json', out: '' } });
  assert.equal(installCodex(unreadable.io, '/c/.plugin', []), true);
  assert.deepEqual(unreadable.ran.slice(1), ['codex plugin marketplace add /c/.plugin', 'codex plugin add coplan@coplan']);
});

test("Cursor: the plugin is copied to its local plugins; a folder that is not Coplan is left alone", () => {
  const home = tmp('cursor');
  const dest = path.join(home, '.cursor', 'plugins', 'local', 'coplan');
  const failed: string[] = [];
  assert.equal(installCursor(scripted(null).io, staged(), home, failed), true);
  assert.ok(existsSync(path.join(dest, '.cursor-plugin', 'plugin.json')));
  assert.ok(existsSync(path.join(dest, 'dist', 'mcp', 'main.js')));

  // Again: the old copy is replaced.
  writeFileSync(path.join(dest, 'left-over'), 'x');
  assert.equal(installCursor(scripted(null).io, staged(), home, failed), true);
  assert.equal(existsSync(path.join(dest, 'left-over')), false);

  const other = tmp('cursor-other');
  const theirs = path.join(other, '.cursor', 'plugins', 'local', 'coplan');
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(theirs, 'mine.txt'), 'keep');
  assert.equal(installCursor(scripted(null).io, staged(), other, failed), false);
  assert.equal(readFileSync(path.join(theirs, 'mine.txt'), 'utf8'), 'keep');
  assert.match(failed.join('\n'), /holds something else/);
});

test('with nothing asked, setup installs in the agents found and writes no settings', async () => {
  const home = tmp('home');
  const coplanHome = tmp('coplan-home');
  const { io, ran, said } = scripted(null, { 'codex --version': { ok: false, stdout: '', out: 'not found' }, 'cursor-agent --version': { ok: false, stdout: '', out: '' } });
  const stage = path.join(tmp('clone'), '.plugin');
  const result = await setup({ root: ROOT, stage, home, coplanHome }, io);
  assert.deepEqual(result, { installed: ['claude'], failed: [] });
  assert.ok(!ran.some((l) => l.startsWith('codex plugin')), 'Codex, not found, is not installed in');
  assert.ok(said.some((l) => /Codex: not found/.test(l)));
  assert.deepEqual(readdirSync(coplanHome), [], 'no settings written');
});

test('--agents installs in exactly those, found or not', async () => {
  const { io, ran } = scripted(null, { 'claude --version': { ok: false, stdout: '', out: '' } });
  const result = await setup({ root: ROOT, stage: path.join(tmp('clone'), '.plugin'), home: tmp('home'), coplanHome: tmp('coplan-home'), agents: ['codex'] }, io);
  assert.deepEqual(result.installed, ['codex']);
  assert.ok(!ran.some((l) => l.startsWith('claude plugin')));
});

/* ---------------- settings ---------------- */

test('settings: only what differs from the default is written, and a wrong answer is asked again', async () => {
  const home = tmp('settings');
  const { io, said, left } = scripted(['y', 'maybe', '', '', 'lots', '30']);
  assert.equal(await askSettings(io, home), 'written');
  assert.equal(left(), 0);
  assert.ok(said.includes('  Answer y or n.'));
  assert.ok(said.includes('  Answer a whole number from 0 to 100000.'));
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'config.json'), 'utf8')), { autoOpen: true, idleShutdownMinutes: 30 });
});

test('settings: taking every default writes nothing', async () => {
  const home = tmp('settings-same');
  assert.equal(await askSettings(scripted(['', '', '', '']).io, home), 'unchanged');
  assert.equal(existsSync(path.join(home, 'config.json')), false);
});

test('settings: the current values are the defaults, keys set before are kept, and a file with comments is kept as .bak', async () => {
  const home = tmp('settings-old');
  const before = '{\n  // mine\n  "promptNotice": true,\n  "autoOpen": true,\n}\n';
  writeFileSync(path.join(home, 'config.json'), before);
  const { io, asked, said } = scripted(['', 'n', '', '']);
  assert.equal(await askSettings(io, home), 'written');
  assert.match(asked[0]!, /\[Y\/n\]/, 'autoOpen, set to true, defaults to yes');
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'config.json'), 'utf8')), { promptNotice: false, autoOpen: true });
  assert.equal(readFileSync(path.join(home, 'config.json.bak'), 'utf8'), before);
  assert.ok(said.some((l) => /had comments, which this rewrite drops: the file as it was is .*config\.json\.bak/.test(l)));
});

test('settings: a file without comments is rewritten with no copy left behind', async () => {
  const home = tmp('settings-plain');
  writeFileSync(path.join(home, 'config.json'), '{ "autoOpen": true }');
  assert.equal(await askSettings(scripted(['n', '', '', '']).io, home), 'written');
  assert.equal(existsSync(path.join(home, 'config.json.bak')), false);
});

test('settings: a file that cannot be read is left as it is', async () => {
  const home = tmp('settings-bad');
  writeFileSync(path.join(home, 'config.json'), '{ "autoOpen": ');
  const { io, said } = scripted([]);
  assert.equal(await askSettings(io, home), 'unreadable');
  assert.equal(readFileSync(path.join(home, 'config.json'), 'utf8'), '{ "autoOpen": ');
  assert.ok(said.some((l) => /cannot be read/.test(l)));
});

test('build defaults: written to coplan.json, which reads back cleanly as chosen', async () => {
  const home = tmp('defaults');
  const { io, left } = scripted(['self', '9', '4', '', 'graphite', 'auto']);
  assert.equal(await askBuildDefaults(io, home), 'written');
  assert.equal(left(), 0);
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'coplan.json'), 'utf8')), {
    iric: { review: 'self', parallel: 4 },
    pullRequests: { tool: 'graphite', open: 'auto' },
  });
  const read = loadProjectConfig(null, { globalDir: home });
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.settings, { review: 'self', parallel: 4, maxRounds: 3 });
  assert.equal(read.pullRequests.tool, 'graphite');
});

test('build defaults: with no pull requests, when to open them is not asked', async () => {
  const home = tmp('defaults-none');
  const { io, asked } = scripted(['', '', '', 'none']);
  assert.equal(await askBuildDefaults(io, home), 'written');
  assert.equal(asked.length, 4);
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'coplan.json'), 'utf8')), { pullRequests: { tool: 'none' } });
});

/* ---------------- a repository ---------------- */

function repo(files: Record<string, string>): string {
  const dir = tmp('repo');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

test("a repository's checks are written from its scripts; a folder that is not there is asked again", async () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }) });
  const { io, said } = scripted(['/no/such/folder', dir, 'y', '']);
  const written = await askRepositories(io, tmp('home'), tmp('coplan-home'));
  // git names the repository by its real path: macOS's temporary folder is
  // behind a symlink.
  assert.deepEqual(written, [path.join(realpathSync(dir), '.coplan', 'config.json')]);
  assert.ok(said.some((l) => /\/no\/such\/folder is not a folder/.test(l)));
  const config = loadProjectConfig(dir, { globalDir: null });
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.hooks.implement.map((h) => h.run), ['npm run lint']);
  assert.deepEqual(config.hooks.review.map((h) => h.run), ['npm test']);
  assert.ok('iric' in (parseJsonc(readFileSync(written[0]!, 'utf8')) as object), 'the built-in build settings, with no defaults of your own');
});

test("a repository's file leaves the build settings to yours when you have set them", async () => {
  const coplanHome = tmp('coplan-home');
  writeFileSync(path.join(coplanHome, 'coplan.json'), '{ "iric": { "review": "self" } }');
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
  const written = await askRepositories(scripted([dir, 'y', '']).io, tmp('home'), coplanHome);
  assert.ok(!('iric' in (parseJsonc(readFileSync(written[0]!, 'utf8')) as object)));
  assert.equal(loadProjectConfig(dir, { globalDir: coplanHome }).settings.review, 'self');
});

test("a relative repository path is read from where the setup was run", async () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
  const was = process.cwd();
  process.chdir(dir);
  try {
    const written = await askRepositories(scripted(['.', 'y', '']).io, tmp('home'), tmp('coplan-home'));
    assert.deepEqual(written, [path.join(realpathSync(dir), '.coplan', 'config.json')]);
  } finally {
    process.chdir(was);
  }
});

test("a repository's file that is already there is left alone", async () => {
  const dir = repo({ 'package.json': '{}' });
  mkdirSync(path.join(dir, '.coplan'));
  writeFileSync(path.join(dir, '.coplan', 'config.json'), '{ "hooks": {} }');
  const { io, said } = scripted([dir, '']);
  assert.deepEqual(await askRepositories(io, tmp('home'), tmp('coplan-home')), []);
  assert.equal(readFileSync(path.join(dir, '.coplan', 'config.json'), 'utf8'), '{ "hooks": {} }');
  assert.ok(said.some((l) => /already there: left as it is/.test(l)));
});
