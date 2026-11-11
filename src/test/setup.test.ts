import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_FILE,
  askRepositories,
  askSettings,
  chooseAgents,
  installClaude,
  installCodex,
  installCursor,
  setup,
  stagePlugin,
  Stopped,
  uninstall,
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

test('with its output failing (a full disk), setup asks nothing it cannot be seen asking: the walk stops', async () => {
  const asked: string[] = [];
  const io: SetupIo = {
    ask: async (q) => {
      asked.push(q);
      return '';
    },
    say: () => {},
    run: (): RunResult => ({ ok: true, stdout: '', out: '' }),
    unwritable: () => true,
  };
  await assert.rejects(chooseAgents(io, ['claude', 'codex']), Stopped);
  assert.deepEqual(asked, [], 'nothing asked, nothing answered blind');
  // The failure told a tick after the line said just before the question, as a failed write is.
  let failed = false;
  const late: SetupIo = { ...io, say: () => void setImmediate(() => (failed = true)), unwritable: () => failed };
  await assert.rejects(chooseAgents(late, ['claude', 'codex']), Stopped);
  assert.deepEqual(asked, [], 'nor when it is told a tick late');
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
  assert.match(help.stdout, /--uninstall/);
  const bad = spawnSync(process.execPath, [CLI, 'setup', '--agents', 'claude,vim'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown agent\(s\): vim/);
});

/* ---------------- the agents ---------------- */

test('Claude Code: the staged folder becomes the coplan marketplace, and Coplan is installed from it', () => {
  const { io, ran } = scripted(null);
  assert.equal(installClaude(io, '/c/.plugin'), null);
  assert.deepEqual(ran, [
    'claude plugin marketplace add /c/.plugin',
    'claude plugin install coplan@coplan --scope user',
    'claude plugin update coplan@coplan',
  ]);
});

test('a step that fails stops the agent, and says why without a backtrace', () => {
  const out = 'Error: no such marketplace\n\nStack backtrace:\n   0: <unknown>\n   1: <unknown>\n';
  const { io, ran } = scripted(null, { 'claude plugin install': { ok: false, stdout: '', out } });
  const error = installClaude(io, '/c/.plugin');
  assert.equal(ran.length, 2, 'nothing runs after the step that failed');
  assert.match(error!, /^`claude plugin install coplan@coplan --scope user` failed\n\s+Error: no such marketplace$/);
});

test('Codex: a coplan marketplace from elsewhere is removed first; the same one is kept', () => {
  const list = (root: string): RunResult => ({ ok: true, stdout: JSON.stringify({ marketplaces: [{ name: 'coplan', root }] }), out: '' });

  const moved = scripted(null, { 'codex plugin marketplace list': list('/home/u/.codex/.tmp/marketplaces/coplan') });
  assert.equal(installCodex(moved.io, '/c/.plugin'), null);
  assert.deepEqual(moved.ran.slice(1), [
    'codex plugin marketplace remove coplan',
    'codex plugin marketplace add /c/.plugin',
    'codex plugin add coplan@coplan',
  ]);

  const same = scripted(null, { 'codex plugin marketplace list': list('/c/.plugin') });
  assert.equal(installCodex(same.io, '/c/.plugin'), null);
  assert.deepEqual(same.ran.slice(1), ['codex plugin marketplace add /c/.plugin', 'codex plugin add coplan@coplan']);

  const unreadable = scripted(null, { 'codex plugin marketplace list': { ok: true, stdout: 'not json', out: '' } });
  assert.equal(installCodex(unreadable.io, '/c/.plugin'), null);
  assert.deepEqual(unreadable.ran.slice(1), ['codex plugin marketplace add /c/.plugin', 'codex plugin add coplan@coplan']);
});

test("Cursor: the plugin is copied to its local plugins; a folder that is not Coplan is left alone", () => {
  const home = tmp('cursor');
  const dest = path.join(home, '.cursor', 'plugins', 'local', 'coplan');
  assert.equal(installCursor(staged(), home), null);
  assert.ok(existsSync(path.join(dest, '.cursor-plugin', 'plugin.json')));
  assert.ok(existsSync(path.join(dest, 'dist', 'mcp', 'main.js')));

  // Again: the old copy is replaced.
  writeFileSync(path.join(dest, 'left-over'), 'x');
  assert.equal(installCursor(staged(), home), null);
  assert.equal(existsSync(path.join(dest, 'left-over')), false);

  const other = tmp('cursor-other');
  const theirs = path.join(other, '.cursor', 'plugins', 'local', 'coplan');
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(theirs, 'mine.txt'), 'keep');
  assert.match(installCursor(staged(), other)!, /holds something else/);
  assert.equal(readFileSync(path.join(theirs, 'mine.txt'), 'utf8'), 'keep');
});

const missing: RunResult = { ok: false, stdout: '', out: 'not found' };

test('agents: one question for every agent found; no to it asks about each', async () => {
  const both: ['claude', 'codex'] = ['claude', 'codex'];
  const yes = scripted(['']);
  assert.deepEqual(await chooseAgents(yes.io, both), both);
  assert.deepEqual(yes.said, ['Found Claude Code and Codex.']);
  assert.deepEqual(yes.asked, ['Install Coplan in both? [Y/n] ']);

  const some = scripted(['n', '', 'y']);
  assert.deepEqual(await chooseAgents(some.io, both), ['codex']);
  assert.equal(some.left(), 0);

  const one = scripted(['n']);
  assert.deepEqual(await chooseAgents(one.io, ['cursor']), []);
  assert.deepEqual(one.asked, ['Install Coplan in Cursor? [Y/n] ']);

  assert.deepEqual(await chooseAgents(scripted(null).io, both), both, 'with nothing asked, every agent found');

  const none = scripted([]);
  assert.deepEqual(await chooseAgents(none.io, []), []);
  assert.match(none.said[0]!, /No coding agent found/);
});

test('with nothing asked, setup installs in the agents found and writes no settings', async () => {
  const coplanHome = tmp('coplan-home');
  const { io, ran, said } = scripted(null, { 'codex --version': missing, 'cursor-agent --version': missing });
  const result = await setup({ root: ROOT, stage: path.join(tmp('clone'), '.plugin'), home: tmp('home'), coplanHome }, io);
  assert.deepEqual(result, { installed: ['claude'], failed: [] });
  assert.ok(!ran.some((l) => l.startsWith('codex plugin')), 'Codex, not found, is not installed in');
  assert.deepEqual(said, ['Found Claude Code.', '  ✓ Claude Code']);
  assert.deepEqual(readdirSync(coplanHome), [], 'no settings written');
});

test('--agents installs in exactly those, found or not', async () => {
  const { io, ran } = scripted(null, { 'claude --version': missing });
  const result = await setup({ root: ROOT, stage: path.join(tmp('clone'), '.plugin'), home: tmp('home'), coplanHome: tmp('coplan-home'), agents: ['codex'] }, io);
  assert.deepEqual(result.installed, ['codex']);
  assert.ok(!ran.some((l) => l.startsWith('claude plugin')));
});

test('settings are asked only when the user wants to adjust them, which is not the default', async () => {
  const coplanHome = tmp('coplan-home');
  const skip = scripted(['', ''], { 'codex --version': missing, 'cursor-agent --version': missing });
  await setup({ root: ROOT, stage: path.join(tmp('clone'), '.plugin'), home: tmp('home'), coplanHome }, skip.io);
  assert.deepEqual(skip.asked.slice(-1), ['Adjust settings now? The defaults are fine to start. [y/N] ']);
  assert.deepEqual(readdirSync(coplanHome), []);

  const adjust = scripted(['', 'y', 'subagent', '', '', '', '', ''], { 'codex --version': missing, 'cursor-agent --version': missing });
  await setup({ root: ROOT, stage: path.join(tmp('clone'), '.plugin'), home: tmp('home'), coplanHome }, adjust.io);
  assert.equal(adjust.left(), 0);
  assert.deepEqual(parseJsonc(readFileSync(path.join(coplanHome, 'coplan.json'), 'utf8')), { iric: { review: 'subagent' } });
  assert.ok(adjust.said.includes('  More settings: docs/CONFIG.md'));
});

test('a failed agent is said, and the others still go in', async () => {
  const { io, said } = scripted(null, { 'codex plugin add': { ok: false, stdout: '', out: 'Error: boom' }, 'cursor-agent --version': missing });
  const result = await setup({ root: ROOT, stage: path.join(tmp('clone'), '.plugin'), home: tmp('home'), coplanHome: tmp('coplan-home') }, io);
  assert.deepEqual(result, { installed: ['claude'], failed: ['codex'] });
  assert.ok(said.some((l) => /^  ✗ Codex: `codex plugin add coplan@coplan` failed\n\s+Error: boom$/.test(l)));
});

/* ---------------- settings ---------------- */

test('settings: the five that matter, written only where they differ from the default', async () => {
  const home = tmp('settings');
  const { io, said, left } = scripted(['subagent', '9', '4', 'graphite', 'auto', 'y']);
  assert.deepEqual(await askSettings(io, home), [path.join(home, 'coplan.json'), path.join(home, 'config.json')]);
  assert.equal(left(), 0);
  assert.ok(said.includes('  Answer a whole number from 1 to 8.'));
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'coplan.json'), 'utf8')), {
    iric: { review: 'subagent', parallel: 4 },
    pullRequests: { tool: 'graphite', open: 'auto' },
  });
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'config.json'), 'utf8')), { autoOpen: true });
  const read = loadProjectConfig(null, { globalDir: home });
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.settings, { review: 'subagent', parallel: 4, maxRounds: 3 });
});

test('settings: taking every default writes nothing', async () => {
  const home = tmp('settings-same');
  const { io, said } = scripted(['', '', '', '', '']);
  assert.deepEqual(await askSettings(io, home), []);
  assert.deepEqual(readdirSync(home), []);
  assert.ok(said.includes('  Nothing changed.'));
});

test('settings: with no pull requests, when to open them is not asked', async () => {
  const home = tmp('settings-none');
  const { io, asked } = scripted(['', '', 'none', '']);
  await askSettings(io, home);
  assert.equal(asked.length, 4);
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'coplan.json'), 'utf8')), { pullRequests: { tool: 'none' } });
});

test('settings: the current values are the defaults, keys set before are kept, and a file with comments is kept as .bak', async () => {
  const home = tmp('settings-old');
  const before = '{\n  // mine\n  "promptNotice": false,\n  "autoOpen": true,\n}\n';
  writeFileSync(path.join(home, 'config.json'), before);
  const { io, asked, said } = scripted(['', '', '', '', 'n']);
  await askSettings(io, home);
  assert.match(asked[4]!, /\[Y\/n\]/, 'autoOpen, set to true, defaults to yes');
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'config.json'), 'utf8')), { promptNotice: false, autoOpen: false });
  assert.equal(readFileSync(path.join(home, 'config.json.bak'), 'utf8'), before);
  assert.ok(said.some((l) => /had comments, which this rewrite drops: the file as it was is .*config\.json\.bak/.test(l)));
});

test("settings: a second run keeps the .bak of the user's comments, not one of the header setup wrote", async () => {
  const home = tmp('settings-twice');
  const before = '{\n  // mine, and the reason for it\n  "autoOpen": true,\n}\n';
  writeFileSync(path.join(home, 'config.json'), before);
  await askSettings(scripted(['', '', '', '', 'n']).io, home);
  assert.equal(readFileSync(path.join(home, 'config.json.bak'), 'utf8'), before);
  // Changed again: the file holds only setup's own header now, which is not the user's to keep.
  const again = scripted(['', '', '', '', 'y']);
  await askSettings(again.io, home);
  assert.deepEqual(parseJsonc(readFileSync(path.join(home, 'config.json'), 'utf8')), { autoOpen: true });
  assert.equal(readFileSync(path.join(home, 'config.json.bak'), 'utf8'), before, 'the original is still there');
  assert.equal(again.said.some((l) => /had comments/.test(l)), false);
  // A comment the user adds after is theirs again: kept, as the file stands
  // then, beside the first copy and not over it.
  const edited = readFileSync(path.join(home, 'config.json'), 'utf8').replace('"autoOpen"', '// new note\n  "autoOpen"');
  writeFileSync(path.join(home, 'config.json'), edited);
  const third = scripted(['', '', '', '', 'n']);
  await askSettings(third.io, home);
  assert.equal(readFileSync(path.join(home, 'config.json.bak'), 'utf8'), before);
  assert.equal(readFileSync(path.join(home, 'config.json.bak.1'), 'utf8'), edited);
  assert.ok(third.said.some((l) => /the file as it was is .*config\.json\.bak\.1\)/.test(l)));
});

test("settings: setup's header is its own however the file was saved since, in either settings file", async () => {
  const home = tmp('settings-resaved');
  await askSettings(scripted(['', '2', '', '', 'y']).io, home);
  // Opened and saved again in an editor that writes CRLF, a BOM, its own indent.
  for (const name of ['coplan.json', 'config.json']) {
    const file = path.join(home, name);
    writeFileSync(file, `\uFEFF${readFileSync(file, 'utf8').replace(/\n {2}/g, '\n\t').replace(/\n/g, '\r\n')}`);
  }
  const { io, said } = scripted(['', '3', '', '', 'n']);
  await askSettings(io, home);
  assert.equal(said.some((l) => /had comments/.test(l)), false);
  assert.equal(existsSync(path.join(home, 'coplan.json.bak')), false);
  assert.equal(existsSync(path.join(home, 'config.json.bak')), false);
});

test('settings: a trailing comma is not a comment, so no copy is kept for it', async () => {
  const home = tmp('settings-comma');
  writeFileSync(path.join(home, 'config.json'), '{\n  "autoOpen": true,\n}\n');
  const { io, said } = scripted(['', '', '', '', 'n']);
  await askSettings(io, home);
  assert.equal(said.some((l) => /had comments/.test(l)), false);
  assert.equal(existsSync(path.join(home, 'config.json.bak')), false);
});

test('settings: a file without comments is rewritten with no copy left behind', async () => {
  const home = tmp('settings-plain');
  writeFileSync(path.join(home, 'config.json'), '{ "autoOpen": true }');
  await askSettings(scripted(['', '', '', '', 'n']).io, home);
  assert.equal(existsSync(path.join(home, 'config.json.bak')), false);
});

test('settings: a file that cannot be read is left as it is, and not asked about', async () => {
  const home = tmp('settings-bad');
  writeFileSync(path.join(home, 'config.json'), '{ "autoOpen": ');
  const { io, said, asked } = scripted(['', '', '', '']);
  await askSettings(io, home);
  assert.equal(asked.length, 4, 'the build defaults only');
  assert.equal(readFileSync(path.join(home, 'config.json'), 'utf8'), '{ "autoOpen": ');
  assert.ok(said.some((l) => /cannot be read/.test(l)));
});

/* ---------------- uninstall ---------------- */

test('uninstall takes Coplan out of every agent it is in, and the staged plugin out of the clone', async () => {
  const home = tmp('home');
  const coplanHome = tmp('coplan-home');
  const stage = path.join(tmp('clone'), '.plugin');
  stagePlugin(ROOT, stage);
  assert.equal(installCursor(stage, home), null);
  const ok = (value: unknown): RunResult => ({ ok: true, stdout: JSON.stringify(value), out: '' });
  const { io, ran, said } = scripted(['n'], {
    'claude plugin list': ok([{ id: 'coplan@coplan' }]),
    'claude plugin marketplace list': ok([{ name: 'coplan' }]),
    'codex plugin list': ok({ installed: [{ pluginId: 'coplan@coplan' }] }),
    'codex plugin marketplace list': ok({ marketplaces: [{ name: 'coplan', root: stage }] }),
  });
  assert.deepEqual(await uninstall({ root: ROOT, stage, home, coplanHome }, io), []);
  for (const step of ['claude plugin uninstall coplan@coplan', 'claude plugin marketplace remove coplan', 'codex plugin remove coplan@coplan', 'codex plugin marketplace remove coplan']) {
    assert.ok(ran.includes(step), step);
  }
  assert.deepEqual(said, ['  ✓ Removed from Claude Code', '  ✓ Removed from Codex', '  ✓ Removed from Cursor']);
  assert.equal(existsSync(path.join(home, '.cursor', 'plugins', 'local', 'coplan')), false);
  assert.equal(existsSync(stage), false);
  assert.ok(existsSync(coplanHome), 'saved plans and settings stay unless the user says');
});

test('uninstall touches nothing that is not Coplan, and deletes the saved plans only when asked to', async () => {
  const home = tmp('home');
  const coplanHome = tmp('coplan-home');
  const theirs = path.join(home, '.cursor', 'plugins', 'local', 'coplan');
  mkdirSync(theirs, { recursive: true });
  const { io, ran, said } = scripted(['y'], {
    'claude plugin list': { ok: true, stdout: '[]', out: '' },
    'claude plugin marketplace list': { ok: true, stdout: '[]', out: '' },
    'codex --version': missing,
  });
  assert.deepEqual(await uninstall({ root: ROOT, stage: path.join(tmp('clone'), '.plugin'), home, coplanHome }, io), ['cursor']);
  assert.ok(!ran.some((l) => / (uninstall|remove) /.test(l)), 'nothing to remove from Claude Code');
  assert.ok(existsSync(theirs));
  assert.match(said[0]!, /Cursor: .* holds something else/);
  assert.equal(existsSync(coplanHome), false);
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
  assert.deepEqual(config.hooks.review.map((h) => h.run), ['npm run test']);
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
