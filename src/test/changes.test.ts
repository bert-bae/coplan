import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_FILES, changedFiles, changedSince, committedOn, headCommit, resolveBase, worktreeOf } from '../shared/changes.ts';

/**
 * What a change touched, as git says (#52): what the review and final
 * checks are matched against besides the files a task planned to touch.
 */

function repo(): { dir: string; git: (...args: string[]) => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'coplan-changes-'));
  const git = (...args: string[]) => void execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'app.ts'), 'export {};\n');
  writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return { dir, git };
}

test('a change is what it committed since the base, what it has not, and its new files — not what git ignores', async () => {
  const { dir, git } = repo();
  try {
    git('checkout', '-qb', 'feature');
    writeFileSync(path.join(dir, 'committed.py'), 'x = 1\n');
    git('add', 'committed.py');
    git('commit', '-qm', 'one');
    writeFileSync(path.join(dir, 'README.md'), '# changed\n');
    writeFileSync(path.join(dir, 'new file.py'), 'y = 2\n');
    execFileSync('mkdir', ['-p', path.join(dir, 'build')]);
    writeFileSync(path.join(dir, 'build', 'out.py'), 'ignored\n');
    const out = await changedFiles(dir);
    assert.equal(out?.base, 'main', 'main, without being told');
    assert.deepEqual(out?.files, ['README.md', 'committed.py', 'new file.py']);
    // Asked for a base that is not there: the build cannot be measured.
    assert.equal(await resolveBase(dir, 'nope'), null);
    assert.equal((await changedFiles(dir, 'nope'))?.unread, 'no-base', 'a base that is not there leaves the build unmeasured, not empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a git repository there is no change to read', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coplan-nogit-'));
  try {
    assert.equal(await changedFiles(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one task's change: since the commit it began at, or else what is not committed yet (targeted checks)", async () => {
  const { dir, git } = repo();
  try {
    const began = (await headCommit(dir))!;
    assert.match(began, /^[0-9a-f]{40}$/);
    assert.deepEqual((await changedSince(dir))?.files, [], 'nothing changed since the last commit');
    writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(dir, 'new.py'), 'y = 2\n');
    assert.deepEqual((await changedSince(dir))?.files, ['app.ts', 'new.py']);
    // The task commits its work: since the last commit, nothing; since it began, all of it.
    git('add', '-A');
    git('commit', '-qm', 'the task');
    assert.deepEqual((await changedSince(dir))?.files, []);
    assert.deepEqual((await changedSince(dir, began))?.files, ['app.ts', 'new.py']);
    assert.equal(await changedSince(dir, 'not-a-commit'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task built in a worktree of its own is measured there; a branch checked out nowhere, by its commits", async () => {
  const { dir, git } = repo();
  const tree = mkdtempSync(path.join(tmpdir(), 'coplan-tree-'));
  rmSync(tree, { recursive: true, force: true });
  try {
    const began = (await headCommit(dir))!;
    git('worktree', 'add', '-q', '-b', 'coplan/api', tree);
    // As git names them: on macOS a temporary folder is /private/var/…
    assert.equal(realpathSync(String(await worktreeOf(dir, 'coplan/api'))), realpathSync(tree));
    assert.equal(realpathSync(String(await worktreeOf(dir, 'main'))), realpathSync(dir));
    assert.equal(await worktreeOf(dir, 'nowhere'), null);
    writeFileSync(path.join(tree, 'api.ts'), 'export {};\n');
    assert.deepEqual((await changedSince(tree, began))?.files, ['api.ts'], 'the worktree, not the checkout it came from');
    assert.deepEqual((await changedSince(dir, began))?.files, []);
    execFileSync('git', ['add', '-A'], { cwd: tree });
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'api'], { cwd: tree });
    git('worktree', 'remove', tree);
    assert.equal(await worktreeOf(dir, 'coplan/api'), null);
    assert.deepEqual(await committedOn(dir, began, 'coplan/api'), { files: ['api.ts'], base: began });
    assert.equal(await committedOn(dir, began, 'no-such-branch'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
});

test('a change git cannot read, or too long to list, is unread — never an empty one', async () => {
  const { dir, git } = repo();
  try {
    const began = (await headCommit(dir))!;
    git('checkout', '-qb', 'feature');
    writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
    // A broken index: git still knows the repository and the commit, but
    // cannot say what changed.
    writeFileSync(path.join(dir, '.git', 'index'), 'not an index');
    for (const out of [await changedSince(dir, began), await changedSince(dir), await changedFiles(dir)]) {
      assert.equal(out?.unread, 'git-failed');
      assert.deepEqual(out?.files, []);
    }
    rmSync(path.join(dir, '.git', 'index'));
    git('reset', '-q');

    // More files than can be told apart: unread too, not cut short quietly.
    mkdirSync(path.join(dir, 'many'));
    for (let i = 0; i <= MAX_FILES; i++) writeFileSync(path.join(dir, 'many', `f${i}.txt`), '');
    const many = await changedSince(dir, began);
    assert.equal(many?.unread, 'too-many');
    assert.equal(many?.files.length, MAX_FILES);
    rmSync(path.join(dir, 'many'), { recursive: true, force: true });
    const fine = await changedSince(dir, began);
    assert.equal(fine?.unread, undefined);
    assert.deepEqual(fine?.files, ['app.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository with no commit yet is all new — staged or not — and that is not a failure', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coplan-changes-'));
  const git = (...args: string[]) => void execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'staged.ts'), 'export {};\n');
    writeFileSync(path.join(dir, 'loose.py'), 'x = 1\n');
    git('add', 'staged.ts');
    for (const out of [await changedFiles(dir), await changedSince(dir)]) {
      assert.equal(out?.unread, undefined);
      assert.deepEqual(out?.files, ['loose.py', 'staged.ts']);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git failing to say whether a commit is there is a failure to read, never "not there"', async () => {
  const { dir, git } = repo();
  // A git that fails every `rev-parse --verify` (as a timeout would), and is
  // the real one for everything else.
  const bin = mkdtempSync(path.join(tmpdir(), 'coplan-fakegit-'));
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *--verify*) echo boom >&2; exit 128;; esac\nexec "${real}" "$@"\n`);
  chmodSync(path.join(bin, 'git'), 0o755);
  const began = (await headCommit(dir))!;
  git('branch', 'side');
  const was = process.env['PATH'];
  process.env['PATH'] = `${bin}${path.delimiter}${was ?? ''}`;
  try {
    assert.equal((await changedSince(dir, began))?.unread, 'git-failed', 'not null: the task is not taken for one outside git');
    assert.equal((await changedSince(dir))?.unread, 'git-failed', 'not a repository with no commit yet');
    assert.equal((await changedFiles(dir))?.unread, 'git-failed');
    assert.equal((await committedOn(dir, began, 'side'))?.unread, 'git-failed', 'not "no such branch"');
  } finally {
    process.env['PATH'] = was;
    rmSync(bin, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no base branch anywhere, the build is unmeasured — not just what is uncommitted', async () => {
  const { dir, git } = repo();
  try {
    git('branch', '-m', 'trunk');
    assert.equal((await changedFiles(dir))?.unread, 'no-base');
    assert.equal((await changedFiles(dir, 'trunk'))?.unread, undefined, 'named, it is found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
