import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changedFiles, filesForStage, resolveBase } from '../shared/changes.ts';

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

test('review and final match the change too; implement, and a task with no files, are as before', () => {
  assert.deepEqual(filesForStage('implement', ['a.ts'], ['b.py']), ['a.ts'], 'no diff before the work is done');
  assert.deepEqual(filesForStage('review', ['a.ts'], ['b.py', 'a.ts']), ['a.ts', 'b.py']);
  assert.deepEqual(filesForStage('final', ['a.ts'], ['b.py']), ['a.ts', 'b.py']);
  // No files of its own: every hook already applies, and the diff must not narrow that.
  assert.deepEqual(filesForStage('review', [], ['b.py']), []);
  assert.deepEqual(filesForStage('review', undefined, ['b.py']), []);
  assert.deepEqual(filesForStage('review', ['a.ts'], undefined), ['a.ts']);
});
