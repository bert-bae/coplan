import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanError, applyOps, confirmDesign, markDelivered, publishPlan, publishTasks, normalizePlan, submitPlan } from '../shared/plan.ts';
import {
  SESSION_BRANCH,
  stackStatus,
  branchPlan,
  buildSteps,
  cleanSettings,
  dependencyProblem,
  dependents,
  effectiveBranch,
  effectiveReview,
  isComplete,
  modeFor,
  planMode,
  readinessOf,
  readyTasks,
  targetOf,
  waitingOn,
} from '../shared/build.ts';
import { renderBrief, renderNext } from '../daemon/brief.ts';
import { buildPrompt, exportText, renderPlan } from '../daemon/render.ts';
import { parseProjectConfig } from '../shared/project.ts';
import type { Plan, PlanInput, PlanOp, TaskInput } from '../shared/types.ts';

/**
 * The build as a graph: what waits on what, what can start, what runs side
 * by side, where each piece lands — and the task list Claude makes from a
 * confirmed design, and each task's implement → review → refine cycle.
 */

const DESIGN: PlanInput = {
  title: 'Add a cache',
  summary: 'A read-through cache in front of Postgres.',
  diagrams: [
    {
      id: 'd1',
      title: 'Components',
      nodes: [
        { id: 'api', label: 'API', kind: 'service', description: 'Serves orders.' },
        { id: 'cache', label: 'Redis', kind: 'datastore', description: 'Hot reads.', notes: 'TTL 10m.' },
        { id: 'db', label: 'Postgres', kind: 'datastore' },
      ],
      edges: [
        { source: 'api', target: 'cache', label: 'get/set' },
        { source: 'api', target: 'db', label: 'SQL' },
      ],
    },
  ],
  tasks: [{ id: 'storage', title: 'Storage' }, { id: 'wire', title: 'Wire up' }],
};

const TASKS: TaskInput[] = [
  {
    id: 'storage',
    title: 'Storage',
    branch: 'cache/storage',
    subtasks: [
      { id: 'client', title: 'Cache client', builds: ['cache'], files: ['src/cache.ts'], detail: 'Wrap ioredis.\n\nDone when get/set round-trip.' },
      { id: 'config', title: 'Config', files: ['src/config.ts'] },
      { id: 'invalidate', title: 'Invalidation', dependsOn: ['client'], files: ['src/cache.ts'] },
    ],
  },
  { id: 'wire', title: 'Wire up', dependsOn: ['storage'], builds: ['api'], branch: 'cache/api', review: 'user' },
  { id: 'docs', title: 'Docs', review: 'skip' },
];

function tasked(): Plan {
  const plan = publishPlan(null, DESIGN, 1_000).plan;
  return publishTasks(confirmDesign(plan, { prompt: 'make the tasks' }, 1_100), { tasks: TASKS }, 1_200).plan;
}

const ids = (list: { id: string }[]) => list.map((t) => t.id);
const done = (plan: Plan, ...which: string[]) =>
  applyOps(plan, which.map((id) => ({ op: 'upsert_task' as const, id, status: 'done' as const })), 'claude', undefined, { tracking: true }).plan;

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

test('a task is ready once everything it waits on is done — its own dependencies and its parents\'', () => {
  let plan = tasked();
  assert.deepEqual(ids(readyTasks(plan)), ['client', 'config', 'docs']);
  const task = (id: string) => plan.tasks.find((t) => t.id === id)!;
  assert.equal(readinessOf(plan, task('invalidate')), 'waiting');
  assert.deepEqual(ids(waitingOn(plan, task('invalidate'))), ['client']);
  assert.deepEqual(ids(waitingOn(plan, task('wire'))), ['storage'], 'a parent stands for its subtasks');

  plan = done(plan, 'client');
  assert.deepEqual(ids(readyTasks(plan)), ['config', 'invalidate', 'docs']);
  assert.equal(isComplete(plan, 'storage'), false);
  plan = done(plan, 'config', 'invalidate');
  assert.equal(isComplete(plan, 'storage'), true, 'a parent is done when every subtask is');
  assert.deepEqual(ids(readyTasks(plan)), ['wire', 'docs']);
});

test('the build steps put side by side what does not wait on each other', () => {
  const steps = buildSteps(tasked()).map(ids);
  assert.deepEqual(steps, [['client', 'config', 'docs'], ['invalidate'], ['wire']]);
});

test('dependents are what comes after a task, through its parent too', () => {
  const plan = tasked();
  const client = plan.tasks.find((t) => t.id === 'client')!;
  assert.deepEqual(ids(dependents(plan, client)), ['invalidate', 'wire']);
  // One dropped waits on nothing: not among them (the brief's and the page's "Waiting on it", the drop's reply).
  plan.tasks.find((t) => t.id === 'wire')!.status = 'dropped';
  assert.deepEqual(ids(dependents(plan, client)), ['invalidate']);
});

test('dependencies that could never be built are refused, and say why', () => {
  const plan = tasked();
  const refuse = (tasks: TaskInput[], pattern: RegExp) => assert.throws(() => publishTasks(plan, { tasks }), (e: Error) => e instanceof PlanError && pattern.test(e.message));
  refuse([{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }], /wait on each other.*"A" → "B" → "A"|wait on each other.*"B" → "A" → "B"/);
  refuse([{ id: 'a', title: 'A', dependsOn: ['nope'] }], /depends on "nope", which is not a task/);
  refuse([{ id: 'a', title: 'A', dependsOn: ['a'] }], /cannot depend on itself/);
  refuse([{ id: 'p', title: 'P', subtasks: [{ id: 'c', title: 'C', dependsOn: ['p'] }] }], /it is part of it/);
  refuse([{ id: 'p', title: 'P', dependsOn: ['c'], subtasks: [{ id: 'c', title: 'C' }] }], /one of its own subtasks/);
  // Through a parent: Wire waits on Storage, and a storage subtask on Wire.
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'config', dependsOn: ['wire'] }], 'user'), /wait on each other/);
  assert.equal(dependencyProblem(plan), null);
});

test('a dependency can be added in the same batch as the task it names', () => {
  const plan = applyOps(
    tasked(),
    [
      { op: 'upsert_task', id: 'docs', dependsOn: ['load'] },
      { op: 'upsert_task', id: 'load', title: 'Load test' },
    ],
    'user',
  ).plan;
  assert.deepEqual(plan.tasks.find((t) => t.id === 'docs')?.dependsOn, ['load']);
});

test('removing a task frees everything that waited on it', () => {
  const plan = applyOps(tasked(), [{ op: 'remove', kind: 'task', id: 'client' }], 'user').plan;
  assert.equal(plan.tasks.find((t) => t.id === 'invalidate')?.dependsOn, undefined);
});

/* ------------------------------------------------------------------ *
 * Branches
 * ------------------------------------------------------------------ */

test('branches are inherited, and one built on another stacks on it', () => {
  const plan = tasked();
  assert.equal(effectiveBranch(plan, plan.tasks.find((t) => t.id === 'client')!), 'cache/storage');
  const { branches, unbranched } = branchPlan(plan);
  assert.deepEqual(
    branches.map((b) => [b.branch, b.base, ids(b.tasks)]),
    [
      ['cache/storage', null, ['client', 'config', 'invalidate']],
      ['cache/api', 'cache/storage', ['wire']],
    ],
  );
  assert.deepEqual(ids(unbranched), ['docs']);
  assert.match(renderPlan(plan), /- `cache\/api` from `cache\/storage` \(stacked\) — wire/);
});

test('a branch that needs two others is refused: a pull request has one base', () => {
  const twoBases = [
    { id: 'a', title: 'A', branch: 'one' },
    { id: 'b', title: 'B', branch: 'two' },
    { id: 'c', title: 'C', branch: 'three', dependsOn: ['a', 'b'] },
  ];
  assert.throws(() => publishTasks(tasked(), { tasks: twoBases }), /`three` needs work from `one` and `two`, but a pull request has one base/);
  // Made to stack, one on the other, it is a plain stack of three.
  const plan = publishTasks(tasked(), { tasks: [twoBases[0]!, { ...twoBases[1]!, dependsOn: ['a'] }, twoBases[2]!] }).plan;
  assert.deepEqual(
    branchPlan(plan).branches.map((b) => `${b.branch}<-${b.base}`),
    ['one<-null', 'two<-one', 'three<-two'],
  );
});

test('a branch built on the unbranched tasks stacks on the session branch, not on base', () => {
  const plan = publishTasks(tasked(), {
    tasks: [
      { id: 'core', title: 'Core, on the current branch' },
      { id: 'api', title: 'API', branch: 'cache/api', dependsOn: ['core'] },
    ],
  }).plan;
  const api = branchPlan(plan).branches.find((b) => b.branch === 'cache/api')!;
  assert.equal(api.base, SESSION_BRANCH);
  assert.match(renderPlan(plan), /`cache\/api` from the branch you are on, where the unbranched tasks land \(stacked\)/);
  assert.match(renderBrief(plan, plan.tasks.find((t) => t.id === 'api')!, {}), /Cut it from the branch you are on/);
});

test('branch names that are folders of each other are refused', () => {
  assert.throws(
    () => publishTasks(tasked(), { tasks: [{ id: 'a', title: 'A', branch: 'api' }, { id: 'b', title: 'B', branch: 'api/v2' }] }),
    /`api` and `api\/v2` cannot both exist in git/,
  );
});

test('submitting a plan whose tasks cannot be built is refused', () => {
  const empty = confirmDesign(publishPlan(null, { ...DESIGN, tasks: [] }).plan, { prompt: 'p' });
  assert.throws(() => submitPlan(empty, { target: 'session', prompt: 'build' }), /no tasks to build/);
  const broken = structuredClone(tasked());
  broken.tasks.find((t) => t.id === 'client')!.dependsOn = ['wire'];
  assert.throws(() => submitPlan(broken, { target: 'session', prompt: 'build' }), /cannot be built as it is/);
});

test('branches that each need the other cannot stack, and are refused', () => {
  assert.throws(
    () =>
      publishTasks(tasked(), {
        tasks: [
          { id: 'a1', title: 'A1', branch: 'one' },
          { id: 'b1', title: 'B1', branch: 'two', dependsOn: ['a1'] },
          { id: 'a2', title: 'A2', branch: 'one', dependsOn: ['b1'] },
        ],
      }),
    /Branches `one` → `two` → `one`|Branches `two` → `one` → `two`/,
  );
});

test('a branch needing one already in its stack stacks on the top of it', () => {
  const plan = publishTasks(tasked(), {
    tasks: [
      { id: 'a1', title: 'A1', branch: 'one' },
      { id: 'b1', title: 'B1', branch: 'two', dependsOn: ['a1'] },
      { id: 'c1', title: 'C1', branch: 'three', dependsOn: ['a1', 'b1'] },
    ],
  }).plan;
  const three = branchPlan(plan).branches.find((b) => b.branch === 'three')!;
  assert.deepEqual(three.needs, ['two']);
  assert.equal(three.base, 'two');
  assert.deepEqual(branchPlan(plan).branches.map((b) => b.branch), ['one', 'two', 'three']);
});

test('a finished build takes no new task list: the next plan starts afresh', () => {
  let plan = tasked();
  plan = submitPlan(plan, { target: 'session', prompt: 'build' });
  plan = markDelivered(plan);
  plan = done(plan, 'client', 'config', 'invalidate', 'wire', 'docs');
  // Every task done is not yet built: the build is finished by its report.
  assert.throws(() => publishTasks(plan, { tasks: [{ title: 'More' }] }), /locked/);
  plan = applyOps(plan, [{ op: 'report', text: 'Built.' }], 'claude').plan;
  assert.throws(() => publishTasks(plan, { tasks: [{ title: 'More' }] }), /This plan is built/);
});

test('linking a task to a box through `builds` is a change like any other', () => {
  const plan = tasked();
  const { plan: next, changes } = applyOps(plan, [{ op: 'upsert_task', id: 'docs', builds: ['db'] }], 'user');
  assert.deepEqual(next.diagrams[0]!.nodes.find((n) => n.id === 'db')?.taskIds, ['docs']);
  assert.equal(changes.length, 1);
  assert.match(changes[0]!.summary, /linked "Docs" to "Postgres" in diagram "Components"/);
  assert.equal(changes[0]!.target.kind, 'diagram');
  assert.ok(next.version > plan.version);
  assert.ok(next.diagrams[0]!.rev > plan.diagrams[0]!.rev);
});

test('a branch name git would refuse is refused here', () => {
  assert.throws(() => applyOps(tasked(), [{ op: 'upsert_task', id: 'docs', branch: 'bad..name' }], 'user'), /not a usable git branch/);
  for (const bad of ['docs/.hidden', 'docs.lock/x', 'docs/', '@']) {
    assert.throws(() => applyOps(tasked(), [{ op: 'upsert_task', id: 'docs', branch: bad }], 'user'), /not a usable git branch/, bad);
  }
  // Spaces are refused, with the name it could have been — not changed quietly.
  assert.throws(() => applyOps(tasked(), [{ op: 'upsert_task', id: 'docs', branch: 'docs update' }], 'user'), /use - instead, e\.g\. "docs-update"/);
});

/* ------------------------------------------------------------------ *
 * The task list
 * ------------------------------------------------------------------ */

test('the task list replaces only the tasks, links boxes, and keeps what survives', () => {
  const base = confirmDesign(publishPlan(null, DESIGN, 1_000).plan, { prompt: 'p' }, 1_100);
  // The user linked a box to a planned task, and commented on it.
  let plan = applyOps(base, [{ op: 'comment', target: { kind: 'task', id: 'wire' }, text: 'keep it small' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'wire', status: 'in_progress' }], 'claude', undefined, { tracking: true }).plan;
  assert.throws(() => publishTasks(plan, { tasks: TASKS }), /changed 1 item/, 'unread user changes first');
  plan = { ...plan, claudeReadSeq: plan.seq };

  const next = publishTasks(plan, { tasks: TASKS }, 2_000).plan;
  assert.equal(next.summary, plan.summary);
  assert.deepEqual(next.diagrams.map((d) => d.nodes.map((n) => [n.id, n.description])), plan.diagrams.map((d) => d.nodes.map((n) => [n.id, n.description])));
  const nodes = next.diagrams[0]!.nodes;
  assert.deepEqual(nodes.find((n) => n.id === 'cache')?.taskIds, ['client']);
  assert.deepEqual(nodes.find((n) => n.id === 'api')?.taskIds, ['wire']);
  assert.equal(next.tasks.find((t) => t.id === 'wire')?.status, 'in_progress', 'status survives with the id');
  assert.ok(next.threads.some((t) => t.target.kind === 'task' && t.target.id === 'wire'), 'and its comments');
  assert.ok(next.diagrams[0]!.rev > plan.diagrams[0]!.rev, 'a canvas showing the old links reloads');
  assert.match(next.changes.at(-1)!.summary, /published the task list \(5 tasks\)/);
  assert.equal(next.claudeReadSeq, next.seq);
});

test('a box named in more than one diagram must say which', () => {
  const two: PlanInput = { ...DESIGN, diagrams: [DESIGN.diagrams![0]!, { id: 'd2', title: 'Flow', nodes: [{ id: 'api', label: 'API' }], edges: [] }] };
  const plan = confirmDesign(publishPlan(null, two).plan, { prompt: 'p' });
  assert.throws(() => publishTasks(plan, { tasks: [{ title: 'X', builds: ['api'] }] }), /"d1\/api" or "d2\/api"/);
  const ok = publishTasks(plan, { tasks: [{ id: 'x', title: 'X', builds: ['d2/api'] }] }).plan;
  assert.deepEqual(ok.diagrams[1]!.nodes[0]!.taskIds, ['x']);
  assert.throws(() => publishTasks(plan, { tasks: [{ title: 'X', builds: ['ghost'] }] }), /no box has that id/);
});

test('dependencies left out of a republish are kept; an empty list clears them', () => {
  const plan = tasked();
  const again = publishTasks(plan, { tasks: TASKS.map((t) => ({ ...t, dependsOn: undefined, subtasks: t.subtasks?.map((s) => ({ ...s, dependsOn: undefined })) })) }).plan;
  assert.deepEqual(again.tasks.find((t) => t.id === 'invalidate')?.dependsOn, ['client']);
  const cleared = publishTasks(plan, { tasks: [{ ...TASKS[1]!, dependsOn: [] }] }).plan;
  assert.equal(cleared.tasks.find((t) => t.id === 'wire')?.dependsOn, undefined);
});

test('a build field the file was damaged in is dropped on load', () => {
  const plan = tasked();
  const raw = JSON.parse(JSON.stringify(plan));
  raw.tasks[0].dependsOn = 'client';
  raw.tasks[1].review = 'everyone';
  raw.tasks[1].checks = [{ name: 'x' }, { name: 'tests', ok: true }];
  const loaded = normalizePlan(raw, 'x');
  assert.equal(loaded.tasks[0]!.dependsOn, undefined);
  assert.equal(loaded.tasks[1]!.review, undefined);
  assert.deepEqual(loaded.tasks[1]!.checks, [{ name: 'tests', ok: true }]);
});

/* ------------------------------------------------------------------ *
 * implement → review → refine
 * ------------------------------------------------------------------ */

test('a task goes round its cycle: stages imply progress, reviews count rounds, done leaves it', () => {
  let plan = tasked();
  const step = (op: Record<string, unknown>) => (plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', ...op }], 'claude', undefined, { tracking: true }).plan);
  const client = () => plan.tasks.find((t) => t.id === 'client')!;
  step({ stage: 'implement' });
  assert.equal(client().status, 'in_progress');
  step({ stage: 'review', checks: [{ name: 'tests', ok: false, note: '1 failing' }] });
  assert.equal(client().round, 1);
  assert.deepEqual(client().checks, [{ name: 'tests', ok: false, note: '1 failing' }]);
  step({ stage: 'refine' });
  step({ stage: 'review', checks: [{ name: 'tests', ok: true }] });
  assert.equal(client().round, 2);
  step({ status: 'done', note: 'wrapped it' });
  assert.equal(client().stage, undefined);
  assert.equal(client().round, 2, 'the history stays');
  assert.match(plan.changes.map((c) => c.summary).join('\n'), /"Cache client": in review \(round 2\); checks tests ✓/);
  assert.throws(() => step({ stage: 'polish' }), /not a stage/);
});

test('going into review is a round, checks merge by name, and only the user starts a task over', () => {
  let plan = tasked();
  const step = (op: Record<string, unknown>) => (plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', ...op }], 'claude', undefined, { tracking: true }).plan);
  const client = () => plan.tasks.find((t) => t.id === 'client')!;
  step({ stage: 'review' });
  step({ stage: 'review', checks: [{ name: 'tests', ok: false }, { name: 'lint', ok: true }] });
  assert.equal(client().round, 1, 'reporting the review checks is the same round');
  step({ stage: 'refine', checks: [{ name: 'typecheck', ok: true }] });
  assert.deepEqual(
    client().checks?.map((c) => `${c.name}:${c.ok}`),
    ['tests:false', 'lint:true', 'typecheck:true'],
    'a refine that re-runs one check keeps the others',
  );
  step({ checks: [{ name: 'tests', ok: true }] });
  assert.equal(client().checks?.find((c) => c.name === 'tests')?.ok, true);
  // Claude sending it back to todo keeps its rounds: no way round the limit.
  step({ status: 'todo' });
  assert.equal(client().round, 1);
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', status: 'in_progress' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', status: 'todo' }], 'user').plan;
  assert.equal(client().round, undefined, 'the user putting it back starts it over');
  assert.equal(client().checks, undefined);
});

test("Claude's upsert_task does not report progress: that is harness_task_update's", () => {
  for (const progress of [{ status: 'done' }, { stage: 'review' }, { checks: [{ name: 'tests', ok: true }] }]) {
    assert.throws(
      () => applyOps(tasked(), [{ op: 'upsert_task', id: 'client', ...progress } as never], 'claude'),
      /report progress with harness_task_update/,
    );
  }
  assert.throws(() => applyOps(tasked(), [{ op: 'upsert_task', title: 'New', status: 'done' }], 'claude'), /A new task starts as todo/);
  // The user marks progress on the board as before.
  assert.doesNotThrow(() => applyOps(tasked(), [{ op: 'upsert_task', id: 'client', status: 'done' }], 'user'));
  // Nor does publishing again move a task that already exists.
  const republished = publishTasks(tasked(), { tasks: TASKS.map((t) => ({ ...t, status: 'done' as const })) }).plan;
  assert.equal(republished.tasks.find((t) => t.id === 'wire')!.status, 'todo');
});

test('review modes are inherited, with the build default last', () => {
  const plan = applyOps(tasked(), [{ op: 'upsert_task', id: 'storage', review: 'self' }], 'user').plan;
  const of = (id: string) => effectiveReview(plan, plan.tasks.find((t) => t.id === id)!, 'subagent');
  assert.equal(of('client'), 'self');
  assert.equal(of('wire'), 'user');
  assert.equal(of('docs'), 'skip');
  const reset = applyOps(plan, [{ op: 'upsert_task', id: 'storage', review: '' }], 'user').plan;
  assert.equal(effectiveReview(reset, reset.tasks.find((t) => t.id === 'client')!, 'subagent'), 'subagent');
});

test('settings are bounded and filled in', () => {
  assert.deepEqual(cleanSettings({ review: 'user', parallel: 50, maxRounds: -2 }), { review: 'user', parallel: 8, maxRounds: 1 });
  assert.deepEqual(cleanSettings(null), { review: 'self', parallel: 1, maxRounds: 3 }, 'no assumptions about the agent (#63)');
});

/* ------------------------------------------------------------------ *
 * What Claude reads while it builds
 * ------------------------------------------------------------------ */

const PROJECT = parseProjectConfig({
  hooks: {
    implement: ['npm run typecheck', { name: 'ruff', run: 'ruff check .', paths: ['*.py'] }],
    review: [{ name: 'tests', run: 'npm test' }],
    final: ['npm run check'],
  },
  branches: { base: 'main' },
});

test('the read-back marks what is ready and what waits, once the design is confirmed', () => {
  const text = renderPlan(tasked());
  assert.match(text, /- \[ \] client Cache client · ready/);
  assert.match(text, /- \[ \] invalidate Invalidation · after client · waits on client/);
  assert.match(text, /- \[ \] wire Wire up · after storage · branch `cache\/api` · review: user · waits on storage/);
  assert.match(text, /## Build order\n_Each step[^\n]*\n1\. \[ \] client Cache client; \[ \] config Config; \[ \] docs Docs\n2\. \[ \] invalidate Invalidation\n3\. \[ \] wire Wire up/);
  assert.match(text, /Design confirmed/);
});

test('what is next says what to start, how many at once, and what the rest wait on', () => {
  let plan = tasked();
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', stage: 'implement' }], 'claude', undefined, { tracking: true }).plan;
  const next = renderNext(plan, { project: PROJECT, mode: 'managed', settings: { review: 'subagent', parallel: 3, maxRounds: 3 } });
  assert.match(next, /## In progress \(1\)\n- client Cache client — implementing/);
  assert.match(next, /## Ready to start \(2\)\n- config Config · branch `cache\/storage`[^\n]*\n- docs Docs · review: skip/);
  assert.match(next, /Start up to 2 now, side by side — with subagents where your agent has them/);
  assert.match(next, /- invalidate Invalidation — waits on client/);
  assert.match(next, /- `cache\/api` from `cache\/storage` \(stacked\)/);

  const one = renderNext(plan, { mode: 'managed', settings: { review: 'self', parallel: 1, maxRounds: 3 } });
  assert.match(one, /already in progress, the most this build runs at once \(1\)/);
});

test("next warns of the round limit, but not for a finished task taken up again (its next round is its own)", () => {
  let plan = tasked();
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', stage: 'implement' }], 'claude', undefined, { tracking: true }).plan;
  const client = plan.tasks.find((t) => t.id === 'client')!;
  client.round = 3;
  const opts = { mode: 'managed' as const, settings: { review: 'self' as const, parallel: 3, maxRounds: 3 } };
  assert.match(renderNext(plan, opts), /3 of 3 review rounds used/);
  client.reopened = true;
  assert.doesNotMatch(renderNext(plan, opts), /review rounds used/);
});

test('when every task is done, next says how to finish', () => {
  const plan = done(tasked(), 'client', 'config', 'invalidate', 'wire', 'docs');
  const next = renderNext(plan, { project: PROJECT, bin: '/x/coplan' });
  assert.match(next, /Every task in "Add a cache" is done \(5\)/);
  assert.match(next, /final checks for what the build changed: check `npm run check` — `"\/x\/coplan" check final` runs those whose area the build touched since the base branch, and no others/);
  assert.match(next, /stack order: `cache\/storage` → `cache\/api` \(onto `cache\/storage`\)/);
  assert.match(next, /op: "report"/);
});

test("a task's brief is self-contained: objective, where it fits, scope, branch and checks", () => {
  const plan = tasked();
  const brief = renderBrief(plan, plan.tasks.find((t) => t.id === 'invalidate')!, { project: PROJECT, mode: 'managed', bin: '/x/coplan' });
  assert.match(brief, /^# Task invalidate: Invalidation/);
  assert.match(brief, /under "Storage"/);
  assert.match(brief, /## The plan, in short\nA read-through cache/);
  assert.match(brief, /It comes after — build on what these did:\n- \[ \] NOT DONE YET — client Cache client/);
  assert.match(brief, /Waiting on it: wire Wire up/);
  assert.match(brief, /cannot start yet: it waits on client Cache client/);
  assert.match(brief, /- client Cache client — also touches src\/cache\.ts/, 'shared files are a scope edge');
  assert.match(brief, /Commit this task's work on `cache\/storage`\. Cut it from `main` if it does not exist yet\./);
  assert.match(brief, /- typecheck: `npm run typecheck`/);
  assert.doesNotMatch(brief, /ruff/, 'a hook for other files does not apply');
  assert.match(brief, /- tests: `npm test`/);
  // Targeted by git, not by the files it planned: no --files, and how it picks.
  assert.match(brief, /"\/x\/coplan" check implement` \(or `review`\); add `--json` for the `checks` to report\. Only the checks for what the task changes run: since it began with `--since`/);
  assert.doesNotMatch(brief, /--files/);

  const wire = renderBrief(plan, plan.tasks.find((t) => t.id === 'wire')!, { project: PROJECT, mode: 'managed' });
  assert.match(wire, /\*\*API\*\* `api` in "Components" — service\n  Serves orders\.\n  Connections: API → Redis: get\/set; API → Postgres: SQL/);
  assert.match(wire, /Cut it from `cache\/storage` \(a stacked branch/);
  assert.match(wire, /Review: the user, before it is marked done \(set on this task\)/);
  assert.match(wire, /show the user the change and ask them, with AskUserQuestion/);

  const parent = renderBrief(plan, plan.tasks.find((t) => t.id === 'storage')!, { mode: 'managed' });
  assert.match(parent, /Its subtasks — build them in this order/);
  assert.match(parent, /\*\*Redis\*\* `cache`[\s\S]*Decisions:\n    TTL 10m\./, 'a parent builds what its subtasks build');
  assert.match(parent, /No checks are configured/);
});

test("a subagent's brief carries the plan's sections and every open comment on the design it builds", () => {
  const designed = publishPlan(null, { ...DESIGN, sections: [{ title: 'Out of scope', body: 'No write-through caching.' }] }, 1_000).plan;
  let plan = publishTasks(confirmDesign(designed, { prompt: 'p' }, 1_100), { tasks: TASKS }, 1_200).plan;
  plan = applyOps(
    plan,
    [
      { op: 'comment', target: { kind: 'node', id: 'd1/cache' }, text: "Don't change the TTL." },
      { op: 'comment', target: { kind: 'edge', id: 'd1/api->cache' }, text: 'Batch the gets.' },
      { op: 'comment', target: { kind: 'node', id: 'd1/db' }, text: 'Postgres 16 only.' },
    ],
    'user',
  ).plan;
  const brief = renderBrief(plan, plan.tasks.find((t) => t.id === 'client')!, {});
  assert.match(brief, /## From the plan\n\n### Out of scope\nNo write-through caching\./);
  assert.match(brief, /user _\(on box "Redis" \(d1\/cache\) in diagram "Components"\)_: Don't change the TTL\./);
  assert.match(brief, /Batch the gets\./, 'an arrow into a box it builds');
  assert.doesNotMatch(brief, /Postgres 16 only/, 'a box it does not build');

  // Every brief quotes every section, so a comment on one is in every brief.
  const s = plan.sections[0]!.id;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'section', id: s }, text: 'Also no admin API.' }], 'user').plan;
  assert.match(renderBrief(plan, plan.tasks.find((t) => t.id === 'docs')!, {}), /Also no admin API\./);
});

test('a long section is cut at a line, never inside a code block, and says where the rest is', () => {
  const body = ['Intro.', '', '```ts', ...Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`), '```', '', 'After.'].join('\n');
  const designed = publishPlan(null, { ...DESIGN, sections: [{ title: 'Context', body }] }, 1_000).plan;
  const plan = publishTasks(confirmDesign(designed, { prompt: 'p' }, 1_100), { tasks: TASKS }, 1_200).plan;
  const brief = renderBrief(plan, plan.tasks.find((t) => t.id === 'docs')!, {});
  const quoted = brief.slice(brief.indexOf('### Context'), brief.indexOf('## Your objective'));
  assert.equal((quoted.match(/^```/gm) ?? []).length % 2, 0, 'every fence it opens, it closes');
  assert.match(quoted, /harness_plan_read \{peek: true\} has all of it/);
  // A short section is quoted whole, with no note.
  const short = renderBrief(tasked(), tasked().tasks.find((t) => t.id === 'docs')!, {});
  assert.doesNotMatch(short, /more of the plan than fits/);
});

test('republishing a task list with the same builds leaves the diagram as it was', () => {
  const plan = tasked();
  const again = publishTasks(plan, { tasks: TASKS }).plan;
  assert.equal(again.diagrams[0]!.rev, plan.diagrams[0]!.rev);
});

test('a task republished with new builds builds those boxes, not those and the old ones', () => {
  const before = tasked();
  assert.ok(before.diagrams[0]!.nodes.find((n) => n.id === 'cache')!.taskIds?.includes('client'));
  const after = publishTasks(before, { tasks: TASKS.map((t) => ({ ...t, subtasks: t.subtasks?.map((s) => (s.id === 'client' ? { ...s, builds: ['db'] } : s)) })) }).plan;
  const links = (id: string) => after.diagrams[0]!.nodes.find((n) => n.id === id)!.taskIds ?? [];
  assert.ok(!links('cache').includes('client'), 'the old link is gone');
  assert.ok(links('db').includes('client'));
  assert.ok(links('api').includes('wire'), "other tasks' links stay");
});

test("a parent's brief lists its subtasks in the order they can be built, not the outline's", () => {
  // Config, second in the outline, now waits on Invalidation, which is third.
  const plan = applyOps(tasked(), [{ op: 'upsert_task', id: 'config', dependsOn: ['invalidate'] }], 'user').plan;
  const brief = renderBrief(plan, plan.tasks.find((t) => t.id === 'storage')!, {});
  const order = [...brief.matchAll(/^- \[ \] (?:NOT DONE YET — )?(\w+) /gm)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 3), ['client', 'invalidate', 'config']);
});

test('dropped work shapes no branch, and a loop through the unbranched tasks is refused', () => {
  let plan = publishTasks(tasked(), {
    tasks: [
      { id: 'a', title: 'A', branch: 'x/a' },
      { id: 'b', title: 'B', branch: 'x/b', dependsOn: ['a'] },
    ],
  }).plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'a', status: 'dropped', note: 'not needed' }], 'claude', undefined, { tracking: true }).plan;
  assert.deepEqual(branchPlan(plan).branches.map((b) => `${b.branch}<-${b.base}`), ['x/b<-null'], 'x/a is gone, and x/b no longer stacks on it');

  // api waits on an unbranched task that itself waits on api.
  assert.throws(
    () =>
      publishTasks(tasked(), {
        tasks: [
          { id: 'a1', title: 'API part one', branch: 'api' },
          { id: 'u1', title: 'Glue', dependsOn: ['a1'] },
          { id: 'a2', title: 'API part two', branch: 'api', dependsOn: ['u1'] },
        ],
      }),
    /`api` → the unbranched tasks \(the current branch\)|the unbranched tasks \(the current branch\) → `api`/,
  );
});

test('a restack goes down the stack to the first branch still open', () => {
  let plan = publishTasks(tasked(), {
    tasks: [
      { id: 'a', title: 'A', branch: 'x/a' },
      { id: 'b', title: 'B', branch: 'x/b', dependsOn: ['a'] },
      { id: 'c', title: 'C', branch: 'x/c', dependsOn: ['b'] },
    ],
  }).plan;
  const record = (branch: string, state: string, base?: string) =>
    (plan = applyOps(plan, [{ op: 'set_branch', branch, pr: { state }, ...(base ? { base } : {}) }], 'claude', undefined, { tracking: true }).plan);
  record('x/a', 'open');
  record('x/b', 'merged');
  record('x/c', 'open');
  // x/b merged into x/a, which is still open: x/c goes onto x/a, not main.
  assert.match(stackStatus(plan, 'main').find((s) => s.branch === 'x/c')!.restack!, /rebase `x\/c` onto `x\/a`/);
  record('x/c', 'open', 'x/a');
  assert.equal(stackStatus(plan, 'main').find((s) => s.branch === 'x/c')!.restack, undefined);
  // Then x/a merges too: x/c goes onto main.
  record('x/a', 'merged');
  assert.match(stackStatus(plan, 'main').find((s) => s.branch === 'x/c')!.restack!, /rebase `x\/c` onto `main`/);
});

/* ------------------------------------------------------------------ *
 * How the repository opens pull requests (#45)
 * ------------------------------------------------------------------ */

test('long standing instructions are cut to fit the prompt, saying where the rest is; the brief carries them whole', () => {
  const long = 'Keep every commit small and say why. '.repeat(100);
  const custom = { ...parseProjectConfig({}), instructions: { build: long, brief: long } };
  const submitted = submitPlan(tasked(), { target: 'session', prompt: 'build it' }, 1_300);
  const prompt = buildPrompt(submitted, { target: 'session', project: custom }).prompt;
  assert.ok(prompt.length < long.length + 4_000, 'not the whole text');
  assert.match(prompt, /Cut to fit here: the whole text is `instructions\.build`/);
  const brief = renderBrief(submitted, submitted.tasks.find((t) => t.id === 'client')!, { project: custom });
  assert.ok(brief.includes(long.trim()), 'the brief has it all');
});

test('the build is told how pull requests are opened, and each is due with the template when its branch is done', () => {
  const custom = { ...parseProjectConfig({ pullRequests: { tool: 'graphite', open: 'auto' } }), pullRequests: { tool: 'graphite' as const, open: 'auto' as const, template: '## Summary', templateFile: 'PR.md' } };
  const submitted = submitPlan(tasked(), { target: 'session', prompt: 'build it', settings: { review: 'subagent', parallel: 2, maxRounds: 3 } }, 1_300);
  const prompt = buildPrompt(submitted, { target: 'session', project: custom }).prompt;
  assert.match(prompt, /Open the pull requests with Graphite: track each branch on the one below it \(`gt track`\), and open the stack with `gt submit --stack`, as soon as a branch's tasks are done\./);
  assert.match(prompt, /template \(PR\.md\), which harness_task_next shows when one is due/);

  // cache/storage is done: its pull request is due, with the template.
  let plan = done(markDelivered(submitted, 1_400), 'client', 'config', 'invalidate');
  let next = renderNext(plan, { project: custom });
  assert.match(next, /## Ready for a pull request \(1\)\n- `cache\/storage`: every task on it is done\./);
  assert.match(next, /~~~~markdown\n## Summary\n~~~~/);
  // Once it is recorded, it is no longer due.
  plan = applyOps(plan, [{ op: 'set_branch', branch: 'cache/storage', pr: { state: 'open', number: 1 } }], 'claude', undefined, { tracking: true }).plan;
  next = renderNext(plan, { project: custom });
  assert.doesNotMatch(next, /Ready for a pull request/);

  // Elsewhere is an export (#62): the plan alone, with no instructions on
  // how pull requests are opened and no template to fill in.
  const dotted = { ...custom, pullRequests: { ...custom.pullRequests, templateFile: '.github/pull_request_template.md' } };
  const outside = buildPrompt(submitted, { target: 'elsewhere', project: dotted }).prompt;
  assert.doesNotMatch(outside, /harness_|pull request template|gt submit|## Summary\n~~~~/);

  // A stacked branch is not due before the one it stacks on has its pull request.
  const stacked = done(markDelivered(submitted, 1_400), 'wire');
  assert.doesNotMatch(renderNext(stacked, { project: custom }), /Ready for a pull request/, 'cache/api waits for cache/storage');

  // Never: no pull requests at all, said where the build ends.
  const never = parseProjectConfig({ pullRequests: { open: 'never' } });
  assert.match(buildPrompt(submitted, { target: 'session', project: never }).prompt, /Do not open pull requests: push the branches/);
  assert.doesNotMatch(renderNext(done(plan, 'wire', 'docs'), { project: never }), /gh pr create/);
});

/* ------------------------------------------------------------------ *
 * Execution modes (#62)
 * ------------------------------------------------------------------ */

test('a plan is built in the mode it was submitted with; one submitted before modes was Managed here, Export elsewhere', () => {
  const plan = tasked();
  assert.equal(planMode(plan, 'tracked'), 'tracked', "before it is submitted: the repository's default");
  assert.equal(planMode(submitPlan(plan, { target: 'session', prompt: 'p' }, 1_300), 'tracked'), 'managed');
  assert.equal(planMode(submitPlan(plan, { target: 'elsewhere', prompt: 'p' }, 1_300), 'managed'), 'export');
  assert.equal(planMode(submitPlan(plan, { target: 'session', mode: 'tracked', prompt: 'p' }, 1_300), 'managed'), 'tracked');
  // A target and a mode say the same thing two ways: Export is elsewhere.
  assert.equal(modeFor('elsewhere', 'managed', 'tracked'), 'export');
  assert.equal(modeFor('session', 'export', 'managed'), 'managed', 'this session is never an export');
  assert.equal(modeFor('session', undefined, 'export'), 'tracked');
  assert.equal(modeFor(undefined, undefined, 'export'), 'export');
  assert.equal(targetOf('export'), 'elsewhere');
  assert.equal(targetOf('tracked'), 'session');
});

test('a Tracked build prompt has no implement → review → refine: no review mode, no rounds, no parallel limit, no subagents', () => {
  const { prompt } = buildPrompt(tasked(), { target: 'session', project: PROJECT });
  assert.equal(PROJECT.mode, 'tracked', 'no iric, no mode: Tracked');
  assert.match(prompt, /The build is Tracked: how you build and check each task is yours to decide/);
  assert.match(prompt, /harness_task_update as you go: status "in_progress" when you start it, "done"/);
  assert.match(prompt, /- review: tests `npm test`/, "the repository's checks are still there to run");
  for (const banned of [/implement → review → refine/, /iric/, /Review: /, /review rounds?/, /at once/, /subagent/, /worktree/]) assert.doesNotMatch(prompt, banned);
  // Managed, the same plan and config: today's prompt.
  const managed = buildPrompt(tasked(), { target: 'session', project: PROJECT, mode: 'managed' }).prompt;
  assert.match(managed, /take each task through the iric skill — implement → review → refine/);
});

test("in a Tracked build, what is next and a task's brief carry no cycle, no limit and no subagent", () => {
  let plan = tasked();
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', status: 'in_progress' }], 'claude', undefined, { tracking: true }).plan;
  const next = renderNext(plan, { project: PROJECT });
  assert.match(next, /Tracked: how each task is built and checked is yours to decide/);
  assert.match(next, /## Ready to start \(2\)/);
  assert.match(next, /start them in whatever order, and as many at once, as suits you/);
  assert.match(next, /harness_task_update \{task_id, status: "in_progress"\}, and mark it "done"/);
  for (const banned of [/iric/, /review round/, /subagent/, /worktree/, /up to \d+ at once/]) assert.doesNotMatch(next, banned);

  const brief = renderBrief(plan, plan.tasks.find((t) => t.id === 'wire')!, { project: PROJECT });
  assert.match(brief, /## Checks\nThe repository's checks for the files this task expects to touch — they run only for what it really changes:\n- implement: typecheck `npm run typecheck`/);
  assert.match(brief, /status: "in_progress" \| "done" \| "blocked"/);
  for (const banned of [/## The cycle/, /Review: /, /review round/, /subagent that did not write/, /each through its own cycle/]) assert.doesNotMatch(brief, banned);
});

test('a dependency whose work was dropped is settled in both briefs, as the board says', () => {
  let plan = publishPlan(null, { title: 'x', tasks: [
    { id: 't1', title: 'Cache layer', subtasks: [{ id: 't2', title: 'Redis client' }, { id: 't3', title: 'Memcached fallback' }] },
    { id: 't4', title: 'API', dependsOn: ['t1'] },
  ] }, 1_000).plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't2', status: 'done' }, { op: 'upsert_task', id: 't3', status: 'dropped', note: 'not needed' }], 'user').plan;
  const api = plan.tasks.find((t) => t.id === 't4')!;
  assert.equal(readinessOf(plan, api), 'ready');
  const brief = renderBrief(plan, api, {});
  assert.match(brief, /- \[x\] t1 Cache layer/);
  assert.doesNotMatch(brief, /NOT DONE YET/);
  assert.match(exportText(plan), /- \[x\] t1 Cache layer/, 'the exported brief agrees');
  // In t1's own brief, the dropped subtask is marked as the plan marks it, not as work to do.
  assert.match(renderBrief(plan, plan.tasks.find((t) => t.id === 't1')!, {}), /- \[-\] t3 Memcached fallback — dropped: not needed/);

  // All of a dependency dropped (a leaf, or every subtask): settled, with nothing to build on.
  for (const [what, ops] of [
    ['a leaf', [{ op: 'upsert_task', id: 't1', status: 'dropped', note: 'replaced by a vendor library' }]],
    ['every subtask', [{ op: 'upsert_task', id: 't2', status: 'dropped', note: 'x' }, { op: 'upsert_task', id: 't3', status: 'dropped', note: 'x' }]],
  ] as [string, PlanOp[]][]) {
    let p2 = publishPlan(null, { title: 'x', tasks: what === 'a leaf'
      ? [{ id: 't1', title: 'Cache layer' }, { id: 't4', title: 'API', dependsOn: ['t1'] }]
      : [{ id: 't1', title: 'Cache layer', subtasks: [{ id: 't2', title: 'Redis client' }, { id: 't3', title: 'Memcached fallback' }] }, { id: 't4', title: 'API', dependsOn: ['t1'] }] }, 1_000).plan;
    p2 = applyOps(p2, ops, 'user').plan;
    const t4 = p2.tasks.find((t) => t.id === 't4')!;
    assert.equal(readinessOf(p2, t4), 'ready', what);
    assert.match(renderBrief(p2, t4, {}), /- \[-\] t1 Cache layer — dropped: there is nothing of it to build on/, what);
    assert.match(exportText(p2), /- \[-\] t1 Cache layer \(dropped: nothing of it to build on\)/, what);
  }
});
