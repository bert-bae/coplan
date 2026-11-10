import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changedFiles, changedSince, committedOn, headCommit, resolveBase, worktreeOf } from '../shared/changes.ts';

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
    // Asked for a base that is not there: only what is not committed.
    assert.equal(await resolveBase(dir, 'nope'), null);
    assert.deepEqual((await changedFiles(dir, 'nope'))?.files, ['README.md', 'new file.py']);
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
    assert.deepEqual(await committedOn(dir, began, 'coplan/api'), ['api.ts']);
    assert.equal(await committedOn(dir, began, 'no-such-branch'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
});

test('with no folder, git is not asked at all: an empty cwd would ask it about wherever the daemon runs', async () => {
  const { headCommit, changedFiles, worktreeOf } = await import('../shared/changes.ts');
  const { repoRoot, currentBranch } = await import('../daemon/git.ts');
  // This process runs inside a repository (the checkout under test), so any of these would answer if asked.
  assert.deepEqual(
    [await headCommit(''), await changedFiles(''), await worktreeOf('', 'main'), await repoRoot(''), await currentBranch('')],
    [null, null, null, null, null],
  );
});
