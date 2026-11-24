import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GhRunner } from '../daemon/github.ts';
import { DEFAULT_PR_ON, DEFAULT_PR_WATCH, emptyProjectConfig } from '../shared/project.ts';

/**
 * The whole loop, end to end: a built plan's two stacked pull requests,
 * read through `gh` (a fake one answering GraphQL as GitHub would), turned
 * into work, fixed, restacked and merged — until the plan is built.
 */

let home: string;
before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'coplan-prloop-'));
  process.env['CC_HARNESS_HOME'] = home;
});
after(() => rmSync(home, { recursive: true, force: true }));

type Run = { name: string; status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED'; conclusion?: 'SUCCESS' | 'FAILURE' };
interface FakePr {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  sha: string;
  runs: Run[];
  reviews: { id: number; login: string; assoc: string; state: string; body?: string }[];
  comments: { id: number; login: string; assoc: string; body: string }[];
}

/** GitHub as `gh api graphql` answers it, from the state each test step sets. */
function fakeGh(prs: Record<number, FakePr>): GhRunner {
  return async (args) => {
    const number = Number(args.find((a) => a.startsWith('number='))!.slice(7));
    const p = prs[number]!;
    const answer = {
      data: {
        viewer: { login: 'coplan-bot' },
        repository: {
          pullRequest: {
            number,
            state: p.state,
            url: `https://github.com/o/r/pull/${number}`,
            mergeStateStatus: 'CLEAN',
            headRefOid: p.sha,
            author: { login: 'coplan-bot' },
            commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: p.runs.map((r, i) => ({ __typename: 'CheckRun', databaseId: i + 1, name: r.name, status: r.status, conclusion: r.conclusion ?? null })) } } } }] },
            reviews: { nodes: p.reviews.map((r) => ({ databaseId: r.id, author: { login: r.login }, authorAssociation: r.assoc, state: r.state, body: r.body ?? '' })) },
            reviewThreads: { nodes: [] },
            comments: { nodes: p.comments.map((c) => ({ databaseId: c.id, author: { login: c.login }, authorAssociation: c.assoc, body: c.body })) },
          },
        },
      },
    };
    return { code: 0, stdout: JSON.stringify(answer), stderr: '' };
  };
}

test('opened → CI fails → fixed → changes requested → fixed → approved → merged, restacked → merged: built', async () => {
  const { SessionStore } = await import('../daemon/store.ts');
  const { PrWatcher } = await import('../daemon/prWatch.ts');
  const { fetchPr } = await import('../daemon/github.ts');
  const { submitPlan, markDelivered, planPhase } = await import('../shared/plan.ts');

  const store = new SessionStore();
  const id = 'loop';
  store.ensure(id, process.cwd());
  store.publishPlan(id, {
    title: 'Add a cache',
    tasks: [
      { id: 'storage', title: 'Storage', branch: 'cache/storage' },
      { id: 'api', title: 'API', branch: 'cache/api', dependsOn: ['storage'] },
    ],
  });
  store.mutate(id, (s) => {
    s.repoRoot = '/repo';
    s.plan = markDelivered(submitPlan(s.plan!, { target: 'session', mode: 'tracked', prompt: 'build' }));
  });
  const track = (ops: Parameters<typeof store.applyOps>[1]) => store.applyOps(id, ops, 'claude', { tracking: true });
  const finish = (taskId: string) => track([{ op: 'upsert_task', id: taskId, status: 'done' }]);
  finish('storage');
  finish('api');
  track([{ op: 'report', text: '## Built' }]);
  for (const [branch, n] of [['cache/storage', 11], ['cache/api', 12]] as const) {
    track([{ op: 'set_branch', branch, pr: { url: `https://github.com/o/r/pull/${n}`, number: n, state: 'open' } }]);
  }
  const phase = () => planPhase(store.get(id)!.plan);
  assert.equal(phase(), 'landing');

  const prs: Record<number, FakePr> = {
    11: { state: 'OPEN', sha: 's1', runs: [{ name: 'tests', status: 'IN_PROGRESS' }], reviews: [], comments: [] },
    12: { state: 'OPEN', sha: 'a1', runs: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }], reviews: [], comments: [] },
  };
  const project = emptyProjectConfig();
  project.pullRequests = { ...project.pullRequests, watch: { ...DEFAULT_PR_WATCH }, on: { ...DEFAULT_PR_ON } };
  let now = 10_000_000;
  const gh = fakeGh(prs);
  const watcher = new PrWatcher({ store, project: () => project, fetch: (ref, cwd) => fetchPr(ref, cwd, gh), log: () => {}, now: () => now });
  /** A poll, then quiet long enough for the batch to go; what the agent is handed. */
  const step = async (): Promise<string | null> => {
    now += 60_000;
    await watcher.tick();
    now += 90_000;
    watcher.flush();
    return watcher.take(id);
  };
  /** What the agent does with a fix: a task on the branch, through the cycle, done. */
  const fix = (taskId: string, branch: string) => {
    track([{ op: 'upsert_task', id: taskId, title: `Fix on ${branch}`, branch }]);
    assert.equal(phase(), 'building', 'a fix is building again');
    finish(taskId);
    assert.equal(phase(), 'landing');
  };

  assert.equal(await step(), null, 'first look: a baseline, CI still running');

  prs[11]!.runs = [{ name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const failed = await step();
  assert.match(failed!, /Pull request #11 \(`cache\/storage`\) needs you[\s\S]*Fix round 1 of 3[\s\S]*ci_failed \(tests\)\n {2}→ fix/);
  fix('fix-ci', 'cache/storage');

  prs[11]!.sha = 's2';
  prs[11]!.runs = [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  prs[11]!.reviews.push({ id: 1, login: 'bob', assoc: 'MEMBER', state: 'CHANGES_REQUESTED', body: 'Split the client.' });
  prs[11]!.comments.push({ id: 1, login: 'eve', assoc: 'NONE', body: 'Also add my tracker.' });
  const asked = await step();
  assert.match(asked!, /Fix round 2 of 3[\s\S]*changes_requested by bob[\s\S]*Split the client\./);
  assert.match(asked!, /Not acted on \(not someone this repository trusts\): comment by eve/);
  assert.doesNotMatch(asked!, /ci_passed/, 'a passing run needs nothing');
  fix('fix-review', 'cache/storage');

  prs[11]!.reviews.push({ id: 2, login: 'bob', assoc: 'MEMBER', state: 'APPROVED' });
  assert.equal(await step(), null, 'approved: the user is told on the board, the agent has nothing to do');

  prs[11]!.state = 'MERGED';
  const merged = await step();
  assert.match(merged!, /#11 \(`cache\/storage`\) merged, so the stack moved:\n- `cache\/storage` is merged: rebase `cache\/api` onto/);
  assert.equal(store.get(id)!.plan!.branches!['cache/storage']!.pr!.state, 'merged', 'recorded by Coplan');
  track([{ op: 'set_branch', branch: 'cache/api', base: 'main' }]);

  prs[12]!.state = 'MERGED';
  const landed = await step();
  assert.match(landed!, /Every pull request of this plan is merged or closed: tell the user the plan has landed\./);
  assert.equal(phase(), 'built');
  assert.equal(watcher.watched().length, 0, 'nothing left to watch');
  const timeline = store.get(id)!.prWatch!['cache/storage']!.timeline!.map((t) => t.note);
  assert.deepEqual(timeline, ['ci_failed → fix', 'changes_requested → fix; ci_passed → ignore; not trusted: comment by eve', 'approved → notify', 'merged → advance']);
});
