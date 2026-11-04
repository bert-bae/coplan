import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanError, applyOps, confirmDesign, markDelivered, publishPlan, publishTasks, normalizePlan, submitPlan } from '../shared/plan.ts';
import {
  branchPlan,
  buildSteps,
  cleanSettings,
  dependencyProblem,
  dependents,
  effectiveBranch,
  effectiveReview,
  isComplete,
  readinessOf,
  readyTasks,
  waitingOn,
} from '../shared/build.ts';
import { renderBrief, renderNext } from '../daemon/brief.ts';
import { renderPlan } from '../daemon/render.ts';
import { parseProjectConfig } from '../shared/project.ts';
import type { Plan, PlanInput, TaskInput } from '../shared/types.ts';

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
  applyOps(plan, which.map((id) => ({ op: 'upsert_task' as const, id, status: 'done' as const })), 'claude').plan;

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

test('a branch that needs two others cannot simply stack, and says so', () => {
  const plan = publishTasks(tasked(), {
    tasks: [
      { id: 'a', title: 'A', branch: 'one' },
      { id: 'b', title: 'B', branch: 'two' },
      { id: 'c', title: 'C', branch: 'three', dependsOn: ['a', 'b'] },
    ],
  }).plan;
  const three = branchPlan(plan).branches.find((b) => b.branch === 'three')!;
  assert.equal(three.base, null);
  assert.deepEqual(three.needs.sort(), ['one', 'two']);
  assert.match(renderPlan(plan), /`three` needs `one` and `two`: merge those first/);
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
  const plan = applyOps(tasked(), [{ op: 'upsert_task', id: 'docs', branch: 'docs update' }], 'user').plan;
  assert.equal(plan.tasks.find((t) => t.id === 'docs')?.branch, 'docs-update');
});

/* ------------------------------------------------------------------ *
 * The task list
 * ------------------------------------------------------------------ */

test('the task list replaces only the tasks, links boxes, and keeps what survives', () => {
  const base = confirmDesign(publishPlan(null, DESIGN, 1_000).plan, { prompt: 'p' }, 1_100);
  // The user linked a box to a planned task, and commented on it.
  let plan = applyOps(base, [{ op: 'comment', target: { kind: 'task', id: 'wire' }, text: 'keep it small' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'wire', status: 'in_progress' }], 'claude').plan;
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
  const step = (op: Record<string, unknown>) => (plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', ...op }], 'claude').plan);
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
  assert.deepEqual(cleanSettings(null), { review: 'subagent', parallel: 2, maxRounds: 3 });
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
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', stage: 'implement' }], 'claude').plan;
  const next = renderNext(plan, { project: PROJECT, settings: { review: 'subagent', parallel: 3, maxRounds: 3 } });
  assert.match(next, /## In progress \(1\)\n- client Cache client — implementing/);
  assert.match(next, /## Ready to start \(2\)\n- config Config · branch `cache\/storage`[^\n]*\n- docs Docs · review: skip/);
  assert.match(next, /Start up to 2 now, each by its own subagent/);
  assert.match(next, /- invalidate Invalidation — waits on client/);
  assert.match(next, /- `cache\/api` from `cache\/storage` \(stacked\)/);

  const one = renderNext(plan, { settings: { review: 'self', parallel: 1, maxRounds: 3 } });
  assert.match(one, /already in progress, the most this build runs at once \(1\)/);
});

test('when every task is done, next says how to finish', () => {
  const plan = done(tasked(), 'client', 'config', 'invalidate', 'wire', 'docs');
  const next = renderNext(plan, { project: PROJECT, bin: '/x/coplan' });
  assert.match(next, /Every task in "Add a cache" is done \(5\)/);
  assert.match(next, /final checks: check `npm run check` — or all of them with `"\/x\/coplan" check final`/);
  assert.match(next, /stack order: `cache\/storage` → `cache\/api` \(onto `cache\/storage`\)/);
  assert.match(next, /op: "report"/);
});

test("a task's brief is self-contained: objective, where it fits, scope, branch and checks", () => {
  const plan = tasked();
  const brief = renderBrief(plan, plan.tasks.find((t) => t.id === 'invalidate')!, { project: PROJECT, bin: '/x/coplan' });
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
  assert.match(brief, /"\/x\/coplan" check implement --files src\/cache\.ts/);

  const wire = renderBrief(plan, plan.tasks.find((t) => t.id === 'wire')!, { project: PROJECT });
  assert.match(wire, /\*\*API\*\* `api` in "Components" — service\n  Serves orders\.\n  Connections: API → Redis: get\/set; API → Postgres: SQL/);
  assert.match(wire, /Cut it from `cache\/storage` \(a stacked branch/);
  assert.match(wire, /Review: the user, before it is marked done \(set on this task\)/);
  assert.match(wire, /show the user the change and ask them, with AskUserQuestion/);

  const parent = renderBrief(plan, plan.tasks.find((t) => t.id === 'storage')!, {});
  assert.match(parent, /Its subtasks — build them in this order/);
  assert.match(parent, /\*\*Redis\*\* `cache`[\s\S]*Decisions:\n    TTL 10m\./, 'a parent builds what its subtasks build');
  assert.match(parent, /No checks are configured/);
});
