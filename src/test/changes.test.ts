import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changedFiles, defaultBase, filesForStage, forgetBases, hasRef, sharesBranch, taskDiffRange, taskFiles } from '../shared/changes.ts';
import { applyOps, publishPlan, publishTasks } from '../shared/plan.ts';
import type { Plan } from '../shared/types.ts';

/**
 * The files a task changed, from git: what its review checks are matched
 * against besides the files it expected to touch (#52).
 */

function repo(): { dir: string; git: (...args: string[]) => string; write: (name: string, text?: string) => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'coplan-changes-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (name: string, text = 'x\n') => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('src/a.ts');
  write('src/old.ts');
  write('README.md');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return { dir, git, write };
}

const sorted = (c: Awaited<ReturnType<typeof changedFiles>>) => (Array.isArray(c) ? [...c].sort() : c);

test('the diff only adds to the files a stage is matched against, and never at implement', () => {
  assert.deepEqual(filesForStage('implement', ['src/a.ts'], ['docs/x.md']), ['src/a.ts'], 'no diff before the work');
  assert.deepEqual(filesForStage('review', ['src/a.ts'], ['docs/x.md', 'src/a.ts']), ['src/a.ts', 'docs/x.md']);
  assert.deepEqual(filesForStage('final', ['src/a.ts'], ['docs/x.md']), ['src/a.ts', 'docs/x.md']);
  assert.deepEqual(filesForStage('review', [], ['docs/x.md']), [], 'a task that lists no files keeps every hook');
  assert.deepEqual(filesForStage('review', ['src/a.ts'], null), ['src/a.ts'], 'no diff: the expected files alone, as before');
  assert.deepEqual(filesForStage('review', ['src/a.ts'], 'all'), [], 'too many changed files to list: every hook applies');
});

test('what a branch changed: committed, renamed, deleted, and not committed yet where it is checked out', async () => {
  const { dir, git, write } = repo();
  try {
    git('checkout', '-qb', 'feature');
    write('docs/guide.md');
    git('mv', 'src/old.ts', 'src/new.ts');
    git('add', '-A');
    git('commit', '-qm', 'work');
    git('rm', '-q', 'README.md');
    write('src/a.ts', 'changed\n');
    write('notes/new é "q"\t.txt');
    const all = ['README.md', 'docs/guide.md', 'notes/new é "q"\t.txt', 'src/a.ts', 'src/new.ts', 'src/old.ts'];
    assert.deepEqual(sorted(await changedFiles(dir, { base: 'main', head: 'feature' })), all, 'by branch, checked out here');
    assert.deepEqual(sorted(await changedFiles(dir, { base: 'main', head: 'HEAD' })), all, 'the checkout itself');

    // Checked out nowhere: what is committed on it alone.
    git('stash', '-u', '-q');
    git('checkout', '-q', 'main');
    write('scratch.txt');
    assert.deepEqual(sorted(await changedFiles(dir, { base: 'main', head: 'feature' })), ['docs/guide.md', 'src/new.ts', 'src/old.ts']);

    assert.equal(await changedFiles(dir, { base: 'no-such-branch', head: 'feature' }), null, 'git cannot say');
    assert.equal(await changedFiles(tmpdir(), { base: 'main', head: 'HEAD' }), null, 'not a repository');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncommitted work counts where the task's branch is checked out — a worktree of its own too", async () => {
  const { dir, git } = repo();
  const tree = mkdtempSync(path.join(tmpdir(), 'coplan-changes-tree-'));
  try {
    rmSync(tree, { recursive: true, force: true });
    git('worktree', 'add', '-q', '-b', 'feat/x', tree);
    mkdirSync(path.join(tree, 'migrations'));
    writeFileSync(path.join(tree, 'migrations', '001.sql'), 'x\n');
    assert.deepEqual(await changedFiles(dir, { base: 'main', head: 'feat/x' }), ['migrations/001.sql']);
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the base: the one the repository names, else the default branch; a ref that reads like a flag is none', async () => {
  const { dir, git } = repo();
  try {
    forgetBases();
    assert.equal(await defaultBase(dir), 'main');
    git('branch', 'develop');
    assert.equal(await defaultBase(dir, 'develop'), 'develop');
    assert.equal(await defaultBase(dir, 'trunk'), 'main', 'a named base that is not there falls back');
    assert.equal(await hasRef(dir, '--all'), false);
    assert.equal(await hasRef(dir, 'main'), true);
    git('branch', '-m', 'main', 'mainline');
    assert.equal(await defaultBase(dir, 'x'), null, 'none found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the base is whichever of the local branch and origin's is further on", async () => {
  const { dir, git, write } = repo();
  const commit = (name: string) => {
    write(name);
    git('add', '-A');
    git('commit', '-qm', name);
    return git('rev-parse', 'HEAD').trim();
  };
  try {
    const first = git('rev-parse', 'HEAD').trim();
    const ahead = commit('upstream.txt');
    git('update-ref', 'refs/remotes/origin/main', ahead);
    git('reset', '-q', '--hard', first);
    forgetBases();
    assert.equal(await defaultBase(dir), 'origin/main', 'a stale local main is not the base');
    git('reset', '-q', '--hard', ahead);
    commit('local.txt');
    forgetBases();
    assert.equal(await defaultBase(dir), 'main', 'unpushed local work: the local one');
    git('reset', '-q', '--hard', first);
    commit('other.txt');
    forgetBases();
    assert.equal(await defaultBase(dir), 'origin/main', "gone separate ways: origin's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task's diff is read only on a branch of its own: against the branch below it, or the base", async () => {
  const { dir, git } = repo();
  try {
    forgetBases();
    git('branch', 'feat/api');
    git('branch', 'feat/ui');
    git('branch', 'session-branch');
    let plan: Plan = publishPlan(null, { title: 'P', tasks: [{ id: 'base', title: 'Base' }] }, 1_000).plan;
    plan = publishTasks(
      plan,
      {
        tasks: [
          { id: 'loose', title: 'Unbranched' },
          { id: 'api', title: 'API', branch: 'feat/api' },
          { id: 'ui', title: 'UI', branch: 'feat/ui', dependsOn: ['api'] },
          { id: 'top', title: 'On the session', branch: 'feat/top', dependsOn: ['loose'] },
          { id: 'pair1', title: 'Shares', branch: 'feat/pair' },
          { id: 'pair2', title: 'Shares too', branch: 'feat/pair' },
          { id: 'p', title: 'Parent', branch: 'feat/p', subtasks: [{ id: 'p1', title: 'One' }, { id: 'p2', title: 'Two' }] },
        ],
      },
      2_000,
    ).plan;
    const t = (id: string) => plan.tasks.find((x) => x.id === id)!;
    const of = (id: string, sessionBranch: string | null = 'session-branch') => taskDiffRange(plan, t(id), { cwd: dir, sessionBranch });
    assert.deepEqual(await of('api'), { base: 'main', head: 'feat/api' });
    assert.deepEqual(await of('ui'), { base: 'feat/api', head: 'feat/ui' }, 'stacked: against the branch below');
    assert.deepEqual(await of('top'), { base: 'session-branch', head: 'feat/top' }, 'stacked on the unbranched tasks');
    assert.deepEqual(await of('top', null), { base: 'main', head: 'feat/top' }, 'session branch unknown: the base');
    // Shared: their work and its cannot be told apart.
    assert.equal(await of('loose'), null);
    assert.equal(await of('pair1'), null);
    assert.equal(sharesBranch(plan, t('p')), false, "a parent's subtasks are its own work");
    assert.equal(sharesBranch(plan, t('p1')), true, 'a subtask shares it with its sibling');
    assert.deepEqual(taskFiles(plan, t('loose')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stacked branch is diffed against where it points now, never against itself, and origin\'s copy if further on', async () => {
  const { dir, git, write } = repo();
  try {
    forgetBases();
    git('branch', 'feat/a');
    git('branch', 'feat/b');
    let plan: Plan = publishPlan(null, { title: 'P', tasks: [{ id: 'x', title: 'X' }] }, 1_000).plan;
    plan = publishTasks(plan, { tasks: [{ id: 'loose', title: 'L' }, { id: 'a', title: 'A', branch: 'feat/a' }, { id: 'b', title: 'B', branch: 'feat/b', dependsOn: ['a'] }, { id: 'top', title: 'T', branch: 'feat/top', dependsOn: ['loose'] }] }, 2_000).plan;
    const t = (id: string) => plan.tasks.find((x) => x.id === id)!;
    // A session that resumed on the task's own branch: not diffed against itself.
    git('branch', 'feat/top');
    assert.deepEqual(await taskDiffRange(plan, t('top'), { cwd: dir, sessionBranch: 'feat/top' }), { base: 'main', head: 'feat/top' });
    // origin's feat/a further on than the local one: that is the base.
    git('checkout', '-q', 'feat/a');
    write('a.txt');
    git('add', '-A');
    git('commit', '-qm', 'a');
    git('update-ref', 'refs/remotes/origin/feat/a', git('rev-parse', 'HEAD').trim());
    git('reset', '-q', '--hard', 'main');
    git('checkout', '-q', 'main');
    assert.deepEqual(await taskDiffRange(plan, t('b'), { cwd: dir }), { base: 'origin/feat/a', head: 'feat/b' });
    // Restacked onto main after feat/a merged, as the build recorded.
    plan.branches = { 'feat/b': { base: 'main', updatedAt: 3_000 } };
    assert.deepEqual(await taskDiffRange(plan, t('b'), { cwd: dir }), { base: 'main', head: 'feat/b' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a diff git cannot read between two branches that are there applies every hook', async () => {
  const { dir, git, write } = repo();
  try {
    // A branch with no history in common with main: `main...` has no merge base.
    git('checkout', '-q', '--orphan', 'feat/alone');
    git('rm', '-rq', '--cached', '.');
    write('alone.txt');
    git('add', 'alone.txt');
    git('commit', '-qm', 'alone');
    git('checkout', '-qf', 'main');
    assert.equal(await changedFiles(dir, { base: 'main', head: 'feat/alone' }), 'all');
    assert.equal(await changedFiles(dir, { base: 'main', head: 'feat/not-yet' }), null, 'a branch not made yet: nothing to read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
