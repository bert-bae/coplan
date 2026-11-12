import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectConfigs, type ProjectFiles } from '../daemon/projectConfigs.ts';
import type { ProjectConfig } from '../shared/project.ts';
import type { ReviewMode } from '../shared/types.ts';

/** Repositories on a stand-in disk: each one file, its review mode, and a
 *  stamp that moves when it is edited. */
function disk() {
  const repos = new Map<string, { review: ReviewMode; stamp: number }>();
  let clock = 1_000;
  let loads = 0;
  /** A file saved at this time, or none: the read that began before it is not kept. */
  let savedAt = 0;
  const files: ProjectFiles = {
    load: (root) => {
      loads++;
      return { sources: [root], settings: { review: repos.get(root)?.review ?? 'self' } } as unknown as ProjectConfig;
    },
    stamp: (sources) => sources.map((f) => `${f}@${repos.get(f)?.stamp ?? 0}`).join(','),
    mtime: () => savedAt,
    now: () => clock++,
  };
  const edit = (root: string, review: ReviewMode) => repos.set(root, { review, stamp: (repos.get(root)?.stamp ?? 0) + 1 });
  return { files, edit, loads: () => loads, saveDuringRead: () => (savedAt = clock + 10) };
}
const told = (projects: ProjectConfigs) => {
  const out: string[] = [];
  projects.reviewChanges.add((root, review) => out.push(`${root}:${review}`));
  return out;
};

test("an edit to a repository's review mode is told once, after the read that finds it (#158)", async () => {
  const { files, edit } = disk();
  const projects = new ProjectConfigs(10, files);
  const out = told(projects);
  edit('a', 'user');
  projects.at('a');
  projects.at('a');
  edit('a', 'subagent');
  projects.at('a');
  projects.at('a');
  await Promise.resolve();
  assert.deepEqual(out, ['a:subagent']);
});

test("an open page's repository, read between many others, has its edit told whenever it comes (#163)", async () => {
  // The page's repository is read again after each other one (the settings tick, the page's own calls). Its edit is
  // tried at every point of that: each must be told.
  for (let at = 0; at < 40; at++) {
    const { files, edit } = disk();
    // (Remembering no more review modes than configs: the cache-hit read is what keeps it known.)
    const projects = new ProjectConfigs(5, files, 5);
    const out = told(projects);
    edit('page', 'user');
    projects.at('page');
    for (let i = 0; i < 40; i++) {
      edit(`r${i}`, 'self');
      projects.at(`r${i}`);
      if (i === at) edit('page', 'subagent');
      projects.at('page');
    }
    await Promise.resolve();
    assert.deepEqual(out, ['page:subagent'], `edited after ${at} others`);
  }
});

test('a read made while its file was being saved is not kept: the next one reads it again (#163)', () => {
  const { files, edit, loads, saveDuringRead } = disk();
  const projects = new ProjectConfigs(10, files);
  edit('a', 'user');
  projects.at('a');
  projects.at('a');
  assert.equal(loads(), 1, 'settled: kept, and read from the cache');
  saveDuringRead();
  edit('a', 'subagent');
  projects.at('a');
  projects.at('a');
  assert.equal(loads(), 3, 'the read during the save was not kept');
});

test('a listener that fails stops none of the others (#163)', async () => {
  const { files, edit } = disk();
  const projects = new ProjectConfigs(10, files);
  projects.reviewChanges.add(() => {
    throw new Error('a page gone');
  });
  const out = told(projects);
  edit('a', 'user');
  projects.at('a');
  edit('a', 'self');
  projects.at('a');
  await Promise.resolve();
  assert.deepEqual(out, ['a:self']);
});

test("one session-list pass over many repositories does not push out an open page's (#168)", async () => {
  const { files, edit } = disk();
  const projects = new ProjectConfigs(5, files);
  const out = told(projects);
  edit('page', 'user');
  projects.at('page');
  // The list reads 120 repositories in a row, the page's not among them.
  for (let i = 0; i < 120; i++) {
    edit(`r${i}`, 'self');
    projects.at(`r${i}`);
  }
  edit('page', 'subagent');
  projects.at('page');
  await Promise.resolve();
  assert.deepEqual(out, ['page:subagent']);
});

test('a source file that does not exist (a global instruction file never written) still lets the read be kept', () => {
  // Sources are listed whether present or not; a missing one has no mtime and must count as settled.
  let loads = 0;
  const files: ProjectFiles = {
    load: () => {
      loads++;
      return { sources: ['present', 'missing'], settings: { review: 'self' } } as unknown as ProjectConfig;
    },
    stamp: (sources) => sources.join(','),
    mtime: (file) => (file === 'present' ? 0 : undefined),
    now: () => 1_000,
  };
  const projects = new ProjectConfigs(10, files);
  projects.at('a');
  projects.at('a');
  assert.equal(loads, 1);
});

test("a listener that fails has its error logged, not swallowed (B83)", async () => {
  const { files, edit } = disk();
  const logged: string[] = [];
  const projects = new ProjectConfigs(10, files);
  projects.logError = (message) => logged.push(message);
  projects.reviewChanges.add(() => {
    throw new Error('a page gone');
  });
  const out = told(projects);
  edit('a', 'user');
  projects.at('a');
  edit('a', 'self');
  projects.at('a');
  await Promise.resolve();
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /a page gone/);
  assert.deepEqual(out, ['a:self'], 'the next listener still told');
});
