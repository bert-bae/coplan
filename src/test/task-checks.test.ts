import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, confirmDesign, markReadByClaude, normalizePlan, proposalTouches, publishPlan, publishTasks, submitPlan } from '../shared/plan.ts';
import { effectiveChecks, skippedChecks } from '../shared/build.ts';
import { previewProposal } from '../shared/proposals.ts';
import { parseProjectConfig, taskHooks } from '../shared/project.ts';
import { renderBrief, renderNext } from '../daemon/brief.ts';
import { renderPlan } from '../daemon/render.ts';
import type { Plan, PlanInput, PlanOp, Task } from '../shared/types.ts';

/**
 * Per-task checks (#54): a task can add checks of its own, and the user can
 * skip one of the repository's on it. The agent may add, and never take a
 * check away from the task it is building — a skip is the user's, set in
 * Coplan or accepted from a proposal — and every skip is said: in the
 * brief, on the board and in the report.
 */

const INPUT: PlanInput = {
  title: 'Docs and a migration',
  tasks: [{ id: 'docs', title: 'Write the docs' }, { id: 'migrate', title: 'Add the migration' }],
};

const PROJECT = parseProjectConfig({
  hooks: {
    implement: ['pnpm typecheck'],
    review: [{ name: 'tests', run: 'pnpm test' }, { name: 'lint', run: 'pnpm lint', optional: true }],
    final: [{ name: 'build', run: 'pnpm build' }],
  },
});

const fresh = (): Plan => publishPlan(null, INPUT, 1000).plan;
const task = (plan: Plan, id: string): Task => plan.tasks.find((t) => t.id === id)!;
const as = (plan: Plan, who: 'user' | 'claude', ops: PlanOp[]): Plan => {
  const next = applyOps(plan, ops, who).plan;
  // The agent has read what the user did: what is refused is the rule, not
  // an unread edit.
  if (who === 'user') markReadByClaude(next);
  return next;
};
const DB_CHECK = { name: 'db', run: 'pnpm db:check' };

test('the agent cannot skip a check on a task — not by an edit, a new task or a publish — and is told to propose it', () => {
  const plan = fresh();
  for (const ops of [
    [{ op: 'upsert_task', id: 'docs', skipChecks: ['tests'] }],
    [{ op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'tests', reason: 'docs only' }] }],
    [{ op: 'upsert_task', title: 'Another', skipChecks: ['tests'] }],
  ] as PlanOp[][]) {
    assert.throws(() => applyOps(plan, ops, 'claude'), /Only the user skips one of the repository's checks on a task[\s\S]*harness_plan_propose/);
  }
  assert.throws(
    () => publishTasks(plan, { tasks: [{ id: 'docs', title: 'Write the docs', skipChecks: ['tests'] } as never] }),
    /Only the user skips/,
  );
  assert.throws(() => publishPlan(plan, { ...INPUT, tasks: [{ id: 'docs', title: 'Docs', skipChecks: ['tests'] } as never] }), /Only the user skips/);
});

test('the user skips a check; the agent can restate it but not lift or change it, and a republish keeps it', () => {
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'tests', reason: 'docs only' }] }]);
  assert.deepEqual(task(plan, 'docs').skipChecks?.map(({ name, reason }) => ({ name, reason })), [{ name: 'tests', reason: 'docs only' }]);
  // Echoing the skip back as it is changes nothing, and is not refused.
  plan = as(plan, 'claude', [{ op: 'upsert_task', id: 'docs', note: 'n', skipChecks: [{ name: 'tests', reason: 'docs only' }] }]);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'docs', skipChecks: [] }], 'claude'), /Only the user skips/);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'docs', skipChecks: ['tests', 'lint'] }], 'claude'), /Only the user skips/);
  plan = publishPlan(plan, { ...INPUT, tasks: [{ id: 'docs', title: 'Write the docs, all of them' }, { id: 'migrate', title: 'Add the migration' }] }).plan;
  assert.equal(task(plan, 'docs').skipChecks?.[0]?.name, 'tests', 'a republish keeps the skip');
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: [] }]);
  assert.equal(task(plan, 'docs').skipChecks, undefined, 'the user lifts it');
});

test('the agent adds checks to a task; only the user removes or changes one', () => {
  let plan = as(fresh(), 'claude', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }]);
  assert.deepEqual(task(plan, 'migrate').addChecks, [{ ...DB_CHECK, stage: 'review', by: 'claude' }]);
  plan = as(plan, 'claude', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK, { name: 'seed', run: 'pnpm seed', stage: 'implement' }] }]);
  assert.equal(task(plan, 'migrate').addChecks?.length, 2);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }], 'claude'), /only the user removes one/);
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', addChecks: [{ ...DB_CHECK, optional: true }, { name: 'seed', run: 'pnpm seed', stage: 'implement' }] }], 'claude'),
    /only the user changes one/,
    'making it optional weakens it',
  );
  // A republish keeps the checks it leaves out, and refuses a changed one.
  plan = publishTasks(plan, { tasks: [{ id: 'docs', title: 'Write the docs' }, { id: 'migrate', title: 'Add the migration' }] }).plan;
  assert.equal(task(plan, 'migrate').addChecks?.length, 2);
  assert.throws(() => publishTasks(plan, { tasks: [{ id: 'migrate', title: 'M', addChecks: [{ ...DB_CHECK, run: 'true' }] }] }), /only the user changes one/);
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [] }]);
  assert.equal(task(plan, 'migrate').addChecks, undefined);
});

test("a task's own checks are checked whole", () => {
  const plan = fresh();
  const refused = (check: unknown, why: RegExp) =>
    assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', addChecks: [check] } as PlanOp], 'user'), why);
  refused({ run: 'x' }, /needs a "name"/);
  refused({ name: 'x' }, /needs a "run"/);
  refused({ name: 'x', run: 'x', stage: 'final' }, /"stage" is implement or review; the final checks are the repository's/);
  refused({ name: 'x', run: 'x', paths: ['src/**'] }, /does not take "paths"/);
  refused({ name: 'x', run: 'x', timeout: 0 }, /"timeout" is a whole number of seconds/);
  refused({ name: 'x', run: 'x', cwd: '../elsewhere' }, /"cwd" is a folder inside the repository/);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK, DB_CHECK] }], 'user'), /already one of its checks/);
});

test('a skip proposed by the agent applies once the user accepts it — mid-build too, while the task is not done', () => {
  let plan = submitPlan(confirmDesign(fresh(), { prompt: 'tasks' }, 2_000), { target: 'session', prompt: 'build' }, 3_000);
  const skip: PlanOp = { op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'tests', reason: 'docs only' }] };
  plan = as(plan, 'claude', [{ op: 'propose', title: 'Skip the tests on the docs', reason: 'Nothing they test changes.', ops: [skip] }]);
  assert.equal(task(plan, 'docs').skipChecks, undefined, 'nothing until the user answers');
  plan = as(plan, 'user', [{ op: 'accept_proposal', id: 'p1' }]);
  assert.equal(task(plan, 'docs').skipChecks?.[0]?.name, 'tests');

  // The user changes the checks of a task in the build directly, too…
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }]);
  assert.equal(task(plan, 'migrate').addChecks?.[0]?.by, 'user');
  // … but nothing else of a signed-off task, and not once it is done.
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', title: 'X', addChecks: [] }], 'user'), /locked/);
  const done = structuredClone(plan);
  task(done, 'migrate').status = 'done';
  assert.throws(() => applyOps(done, [{ op: 'upsert_task', id: 'migrate', addChecks: [] }], 'user'), /locked/);
  const late = as(done, 'claude', [{ op: 'propose', title: 'Skip', reason: 'r', ops: [{ op: 'upsert_task', id: 'migrate', skipChecks: ['tests'] }] }]);
  assert.throws(() => applyOps(late, [{ op: 'accept_proposal', id: 'p2' }], 'user'), /takes only new tasks from a proposal/);
});

test('a proposal goes out of date when the skips it would change were changed first', () => {
  let plan = as(fresh(), 'claude', [{ op: 'propose', title: 'Skip', reason: 'r', ops: [{ op: 'upsert_task', id: 'docs', skipChecks: ['tests'] }] }]);
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: ['lint'] }]);
  assert.throws(() => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user'), /out of date/);
});

test('the hooks a task runs: the repository less its skips, plus its own; the final checks skip nothing', () => {
  let plan = as(fresh(), 'user', [
    { op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'tests', reason: 'docs only' }] },
    { op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK, { name: 'seed', run: 'pnpm seed', stage: 'implement', optional: true }] },
  ]);
  assert.deepEqual(taskHooks(PROJECT, 'review', [], task(plan, 'docs')).map((h) => h.name), ['lint']);
  assert.deepEqual(taskHooks(PROJECT, 'review', [], task(plan, 'migrate')).map((h) => h.name), ['tests', 'lint', 'db']);
  assert.deepEqual(taskHooks(PROJECT, 'implement', [], task(plan, 'migrate')).map((h) => [h.name, h.optional ?? false]), [['typecheck', false], ['seed', true]]);
  assert.deepEqual(taskHooks(PROJECT, 'final', [], task(plan, 'docs')).map((h) => h.name), ['build']);
  plan = submitPlan(confirmDesign(plan, { prompt: 'tasks' }, 2_000), { target: 'session', prompt: 'build' }, 3_000);

  // The brief says what is skipped, by whom and why, and runs the task's own.
  const brief = renderBrief(plan, task(plan, 'docs'), { project: PROJECT, bin: '/x/coplan' });
  assert.match(brief, /\*\*Skipped on this task by the user:\*\* tests \(docs only\)\. They do not gate it/);
  assert.doesNotMatch(brief, /- tests: `pnpm test`/);
  assert.match(brief, /check review --skip=tests/);
  const migrate = renderBrief(plan, task(plan, 'migrate'), { project: PROJECT, bin: '/x/coplan' });
  assert.match(migrate, /- db: `pnpm db:check` \(this task's own\)/);
  assert.match(migrate, /- seed: `pnpm seed` \(optional\) \(this task's own\)/);
  assert.match(migrate, /run the ones set on this task \(db, seed\) as listed above/);

  // So do the plan the agent reads and the build report.
  assert.match(renderPlan(plan), /docs Write the docs[^\n]*\n\s+checks skipped by the user: tests \(docs only\)/);
  assert.match(renderPlan(plan), /own checks: db `pnpm db:check` \(review\); seed `pnpm seed` \(implement, optional\)/);
  for (const t of plan.tasks) t.status = 'done';
  assert.match(renderNext(plan, { project: PROJECT }), /Checks the user skipped on tasks — say so in the report and the summary: docs "Write the docs": tests \(docs only\)/);
  plan.report = { text: 'Built.', at: 5_000 };
  assert.match(renderPlan(plan), /## Build report\nBuilt\.\n\nChecks skipped by the user: docs "Write the docs": tests \(docs only\)/);
});

test('the agent hears that the user skipped a check, with the reason', () => {
  let plan = fresh();
  markReadByClaude(plan);
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'tests', reason: 'docs only' }] }], 'user').plan;
  assert.match(renderPlan(plan, { changesOnly: true }), /Changed docs "Write the docs": checks skipped now: tests \(docs only\) \(was none\)/);
});

test('a proposal made before tasks had checks still fits the plan it was made for', () => {
  // The fingerprint an open proposal stored before this version, for a task
  // with no checks: the same FNV-1a over the same fields as then.
  const fnv = (text: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(36);
  };
  const plan = fresh();
  const t = task(plan, 'docs');
  const stored = fnv(JSON.stringify([t.title, t.detail ?? '', t.parentId, t.dependsOn ?? [], t.branch ?? '', t.review ?? '', t.files ?? []]));
  const op: PlanOp = { op: 'upsert_task', id: 'docs', detail: 'More.' };
  assert.equal(proposalTouches(plan, [op])['task:docs'], stored);
  const made = as(plan, 'claude', [{ op: 'propose', title: 'Detail', reason: 'r', ops: [op] }]);
  made.proposals![0]!.base['task:docs'] = stored;
  assert.equal(as(made, 'user', [{ op: 'accept_proposal', id: 'p1' }]).proposals![0]!.status, 'accepted');
});

test("a skipped implement check the task's files do not reach is still a check of the repository's", () => {
  const project = parseProjectConfig({ hooks: { implement: [{ name: 'sql-lint', run: 'sqlfluff lint', paths: ['db/**'] }], review: ['pnpm test'] } });
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', files: ['docs/a.md'], skipChecks: [{ name: 'sql-lint', reason: 'no SQL' }, 'typo'] }]);
  plan = submitPlan(confirmDesign(plan, { prompt: 'tasks' }, 2_000), { target: 'session', prompt: 'build' }, 3_000);
  const brief = renderBrief(plan, task(plan, 'docs'), { project });
  assert.match(brief, /Skipped on this task by the user:\*\* sql-lint \(no SQL\); typo — no check of the repository has that name\./);
});

test("a parent's own checks hold every subtask under it; a skip is only ever on a task that is built", () => {
  let plan = as(fresh(), 'claude', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }]);
  // Giving the task subtasks does not take its check away from the work.
  plan = as(plan, 'claude', [{ op: 'upsert_task', id: 'm1', parentId: 'migrate', title: 'Schema' }]);
  assert.deepEqual(effectiveChecks(plan, task(plan, 'm1')).addChecks?.map((c) => c.name), ['db']);
  assert.deepEqual(taskHooks(PROJECT, 'review', [], effectiveChecks(plan, task(plan, 'm1'))).map((h) => h.name), ['tests', 'lint', 'db']);

  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', skipChecks: ['tests'] }], 'user'), /has subtasks, so it is not built itself: skip the check on each subtask/);
  // A skip set before the task was split gates nothing now, and is not reported as if it did.
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: ['tests'] }]);
  assert.deepEqual(skippedChecks(plan).map(({ task: t }) => t.id), ['docs']);
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'd1', parentId: 'docs', title: 'Guide' }]);
  assert.deepEqual(skippedChecks(plan), []);
  assert.equal(effectiveChecks(plan, task(plan, 'd1')).skipChecks, undefined, 'new work under it does not inherit a skip');
});

test('checks stored in a broken shape are dropped on load, not left to break the board', () => {
  const plan = fresh();
  const raw = structuredClone(plan) as unknown as { tasks: Record<string, unknown>[] };
  raw.tasks[0]!['addChecks'] = { name: 'x' };
  raw.tasks[0]!['skipChecks'] = 'tests';
  raw.tasks[1]!['addChecks'] = [{ name: 'db', run: 'x', stage: 'review', by: 'claude' }, { name: 'bad' }, null];
  raw.tasks[1]!['skipChecks'] = [{ name: 'tests', reason: 'r', at: 1 }, { reason: 'no name' }, 7];
  const loaded = normalizePlan(raw as never, 'P');
  assert.equal(loaded.tasks[0]!.addChecks, undefined);
  assert.equal(loaded.tasks[0]!.skipChecks, undefined);
  assert.deepEqual(loaded.tasks[1]!.addChecks?.map((c) => c.name), ['db']);
  assert.deepEqual(loaded.tasks[1]!.skipChecks?.map((s) => s.name), ['tests']);
  assert.doesNotThrow(() => renderPlan(loaded));
});

test('the agent restates a check without the timeout or folder it has, and they are kept; the plan shows them', () => {
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [{ ...DB_CHECK, timeout: 900, cwd: 'packages/db' }] }]);
  assert.match(renderPlan(plan), /own checks: db `pnpm db:check` \(review, in packages\/db, 900s\)/);
  plan = as(plan, 'claude', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK, { name: 'seed', run: 'pnpm seed' }] }]);
  assert.deepEqual(task(plan, 'migrate').addChecks?.map((c) => [c.name, c.timeout, c.cwd]), [['db', 900, 'packages/db'], ['seed', undefined, undefined]]);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', addChecks: [{ ...DB_CHECK, timeout: 5 }, { name: 'seed', run: 'pnpm seed' }] }], 'claude'), /only the user changes one/);
  // So does a republish.
  plan = publishTasks(plan, { tasks: [{ id: 'docs', title: 'Write the docs' }, { id: 'migrate', title: 'Add the migration', addChecks: [DB_CHECK] }] }).plan;
  assert.equal(task(plan, 'migrate').addChecks?.[0]?.timeout, 900);
});

test('a republish may restate the skips a task has, and nothing else of them', () => {
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'tests', reason: 'docs only' }] }]);
  plan = publishTasks(plan, { tasks: [{ id: 'docs', title: 'Write the docs', skipChecks: [{ name: 'tests', reason: 'docs only' }] } as never, { id: 'migrate', title: 'Add the migration', skipChecks: [] } as never] }).plan;
  assert.equal(task(plan, 'docs').skipChecks?.[0]?.name, 'tests');
  assert.throws(() => publishTasks(plan, { tasks: [{ id: 'docs', title: 'Write the docs', skipChecks: [] } as never] }), /Only the user skips/);
});

test("what is set above holds: a subtask cannot stand in for it, only the user can skip it there", () => {
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'db', run: 'pnpm db:check' }, { name: 'e2e', run: 'pnpm e2e' }] }]);
  plan = as(plan, 'claude', [{ op: 'upsert_task', id: 'm1', parentId: 'migrate', title: 'Schema' }]);
  // A check of its own by the parent's name — optional, or running `true` — is refused, from either side.
  for (const who of ['claude', 'user'] as const) {
    assert.throws(
      () => applyOps(plan, [{ op: 'upsert_task', id: 'm1', addChecks: [{ name: 'db', run: 'true', optional: true }] }], who),
      /already holds the check "db" from "Add the migration", above it/,
    );
  }
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', parentId: 'm1', title: 'Columns', addChecks: [{ name: 'e2e', run: 'true' }] }], 'claude'), /already holds the check "e2e"/);
  // One made before this rule gives way to the parent's.
  const legacy = structuredClone(plan);
  task(legacy, 'm1').addChecks = [{ name: 'db', run: 'true', stage: 'review', optional: true, by: 'claude' }];
  assert.deepEqual(effectiveChecks(legacy, task(legacy, 'm1')).addChecks?.map((c) => [c.name, c.run, c.optional ?? false]), [['db', 'pnpm db:check', false], ['e2e', 'pnpm e2e', false]]);

  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'm1', skipChecks: [{ name: 'e2e', reason: 'no UI' }] }]);
  assert.deepEqual(effectiveChecks(plan, task(plan, 'm1')).addChecks?.map((c) => c.name), ['db'], 'the e2e it skips is gone');
  assert.match(renderBrief(plan, task(plan, 'm1'), { project: PROJECT }), /Skipped on this task by the user:\*\* e2e \(no UI\)\. They do not gate it/, 'an inherited check is a real one to skip');
  assert.match(renderBrief(plan, task(plan, 'm1'), { project: PROJECT }), /- db: `pnpm db:check` \(set on "Add the migration", above this task\)/);
});

test('a proposal that adds a check keeps the ones the task has: it cannot take them with it when accepted', () => {
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'perf', run: 'pnpm perf' }] }]);
  assert.throws(
    () => applyOps(plan, [{ op: 'propose', title: 'SQL lint', reason: 'r', ops: [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'lint-sql', run: 'sqlfluff' }] }] }], 'claude'),
    /has the check "perf" \(added by the user\), and only the user removes one/,
  );
  plan = as(plan, 'claude', [{ op: 'propose', title: 'SQL lint', reason: 'r', ops: [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'perf', run: 'pnpm perf' }, { name: 'lint-sql', run: 'sqlfluff' }] }] }]);
  plan = as(plan, 'user', [{ op: 'accept_proposal', id: 'p1' }]);
  assert.deepEqual(task(plan, 'migrate').addChecks?.map((c) => c.name), ['perf', 'lint-sql']);
});

test('restating a check keeps every field it leaves out', () => {
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'fmt', run: 'pnpm fmt', stage: 'implement', optional: true }] }]);
  plan = as(plan, 'claude', [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'fmt', run: 'pnpm fmt' }, DB_CHECK] }]);
  assert.deepEqual(task(plan, 'migrate').addChecks?.[0], { name: 'fmt', run: 'pnpm fmt', stage: 'implement', optional: true, by: 'user' });
  plan = publishTasks(plan, { tasks: [{ id: 'docs', title: 'Write the docs' }, { id: 'migrate', title: 'Add the migration', addChecks: [{ name: 'fmt', run: 'pnpm fmt' }] }] }, 7_000).plan;
  assert.equal(task(plan, 'migrate').addChecks?.[0]?.stage, 'implement');
});

test("a parent's check cannot take the name of one a subtask has, so it cannot stand in for it", () => {
  let plan = as(fresh(), 'claude', [{ op: 'upsert_task', id: 'm1', parentId: 'migrate', title: 'Schema' }]);
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'm1', addChecks: [DB_CHECK] }]);
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'db', run: 'true', optional: true }] }], 'claude'),
    /"Schema", under "Add the migration", has a check named "db" already/,
  );
  assert.throws(
    () => publishTasks(plan, { tasks: [{ id: 'docs', title: 'Docs' }, { id: 'migrate', title: 'M', addChecks: [{ name: 'db', run: 'true' }], subtasks: [{ id: 'm1', title: 'Schema' }] }] }),
    /has a check named "db" already/,
  );
  // One from before: the required one holds.
  const legacy = structuredClone(plan);
  task(legacy, 'migrate').addChecks = [{ name: 'db', run: 'true', stage: 'review', optional: true, by: 'claude' }];
  assert.deepEqual(effectiveChecks(legacy, task(legacy, 'm1')).addChecks?.map((c) => [c.run, c.optional ?? false]), [['pnpm db:check', false]]);
});

test("the repository's check names are refused on every path, accepting a proposal included", () => {
  const reserved = ['tests'];
  let plan = fresh();
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'docs', addChecks: [{ name: 'tests', run: 'true' }] }], 'user', 1, { reserved }), /"tests" is the name of one of the repository's checks/);
  assert.throws(() => publishTasks(plan, { tasks: [{ id: 'docs', title: 'D', addChecks: [{ name: 'tests', run: 'true' }] }] }, 1, { reserved }), /"tests" is the name/);
  // Proposed before the repository had a "tests" check, accepted after.
  plan = as(plan, 'claude', [{ op: 'propose', title: 'T', reason: 'r', ops: [{ op: 'upsert_task', id: 'docs', addChecks: [{ name: 'tests', run: 'true' }] }] }]);
  assert.throws(() => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user', 1, { reserved }), /"tests" is the name of one of the repository's checks/);
  // A check the task had before the repository took the name is restated freely.
  const had = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', addChecks: [{ name: 'tests', run: 'true' }] }]);
  assert.doesNotThrow(() => applyOps(had, [{ op: 'upsert_task', id: 'docs', addChecks: [{ name: 'tests', run: 'true' }, DB_CHECK] }], 'claude', 1, { reserved }));
});

test('a refused change to a check sends the agent to the user, not to a proposal that is refused too', () => {
  const plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }]);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 'migrate', addChecks: [] }], 'claude'), (err: Error) => /under Checks in the task's details/.test(err.message) && !/harness_plan_propose/.test(err.message));
});

test('the brief quotes a skipped check whose name has a space, and says nothing is configured only when nothing is', () => {
  const project = parseProjectConfig({ hooks: { review: ['go test ./...'] } });
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', files: ['a.go'], skipChecks: ['go test'] }]);
  plan = submitPlan(confirmDesign(plan, { prompt: 'tasks' }, 2_000), { target: 'session', prompt: 'build' }, 3_000);
  assert.match(renderBrief(plan, task(plan, 'docs'), { project, bin: '/x/coplan' }), /check review --files a\.go '--skip=go test'`/);
  const bare = as(fresh(), 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }]);
  const brief = renderBrief(bare, task(bare, 'migrate'), { project: parseProjectConfig({}) });
  assert.match(brief, /- db: `pnpm db:check` \(this task's own\)/);
  assert.doesNotMatch(brief, /No checks are configured|Work out what to run/);
});

test("a check taken away takes its last result with it, so its failure no longer holds the task", () => {
  let plan = as(fresh(), 'claude', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }]);
  task(plan, 'migrate').checks = [{ name: 'db', ok: false, note: 'drift' }, { name: 'tests', ok: true }];
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [] }]);
  assert.deepEqual(task(plan, 'migrate').checks, [{ name: 'tests', ok: true }]);
  // Changed, too: a pass of the old command is not a pass of the new one.
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'db', run: 'true' }] }]);
  task(plan, 'migrate').checks = [{ name: 'db', ok: true }];
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }]);
  assert.equal(task(plan, 'migrate').checks, undefined);
});

test('the command in the brief is quoted whole, and says why git is not read where it is not', () => {
  const project = parseProjectConfig({ hooks: { review: ['pnpm test', { name: 'docs', run: 'x', paths: ['docs/**'] }] } });
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', files: ['notes/my file.md'] }]);
  plan = submitPlan(confirmDesign(plan, { prompt: 'tasks' }, 2_000), { target: 'session', prompt: 'build' }, 3_000);
  const quoted = renderBrief(plan, task(plan, 'docs'), { project, bin: '/x/coplan', diffBase: 'feat;touch pwned' });
  assert.match(quoted, /check review --files 'notes\/my file\.md' --base 'feat;touch pwned'`/);
  const shared = renderBrief(plan, task(plan, 'docs'), { project, bin: '/x/coplan', diffUnread: 'shared' });
  assert.match(shared, /check review --files 'notes\/my file\.md' --no-diff`/);
  assert.match(shared, /this task shares its branch with other tasks, so what it changed is not read from git/);
  // Said as it is: no base to compare with is not another task's doing.
  const nobase = renderBrief(plan, task(plan, 'docs'), { project, bin: '/x/coplan', diffUnread: 'no-base' });
  assert.match(nobase, /no base branch was found to compare with \(set `branches.base`/);
  assert.doesNotMatch(nobase, /--no-diff|shares its branch/);
});

test("a skip left on a task since given subtasks is said for what it is, and a republish may restate skips in any order", () => {
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'lint', reason: 'generated' }, { name: 'tests', reason: 'docs only' }] }]);
  // Restated in another order, without the reasons: nothing changes.
  plan = publishTasks(plan, { tasks: [{ id: 'docs', title: 'Write the docs', skipChecks: ['tests', 'lint'] } as never, { id: 'migrate', title: 'Add the migration' }] }).plan;
  assert.deepEqual(task(plan, 'docs').skipChecks?.map((s) => [s.name, s.reason]), [['lint', 'generated'], ['tests', 'docs only']]);
  assert.throws(() => publishTasks(plan, { tasks: [{ id: 'docs', title: 'D', skipChecks: [{ name: 'tests', reason: 'other' }, 'lint'] } as never] }), /Only the user skips/);
  plan = as(plan, 'claude', [{ op: 'upsert_task', id: 'd1', parentId: 'docs', title: 'Guide' }]);
  assert.match(renderPlan(plan), /a skip left from before it had subtasks, which gates nothing: lint \(generated\), tests \(docs only\)/);
  assert.doesNotMatch(renderPlan(plan), /checks skipped by the user: lint/);
  // The user clears it.
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: [] }]);
  assert.equal(task(plan, 'docs').skipChecks, undefined);
});

test('outside a repository the brief says so, and that the checks a change could add are the agent\'s to run; a "--" name is passed whole', () => {
  const project = parseProjectConfig({ hooks: { review: ['pnpm test', { name: 'docs', run: 'x', paths: ['docs/**'] }, { name: '--ci', run: 'ci' }] } });
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', files: ['src/a.ts'], skipChecks: ['--ci'] }]);
  plan = submitPlan(confirmDesign(plan, { prompt: 'tasks' }, 2_000), { target: 'session', prompt: 'build' }, 3_000);
  const brief = renderBrief(plan, task(plan, 'docs'), { project, bin: '/x/coplan', diffUnread: 'no-repo' });
  assert.match(brief, /this folder is not a git repository, so what the task changed is not read: run them yourself/);
  assert.match(brief, /check review --files src\/a\.ts --no-diff --skip=--ci`/);
});

test("a finished task's checks no longer change, and the user can clear a skip's reason", () => {
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'tests', reason: 'docs only' }] }]);
  plan = as(plan, 'user', [{ op: 'upsert_task', id: 'docs', skipChecks: [{ name: 'tests' }] }]);
  assert.equal(task(plan, 'docs').skipChecks?.[0]?.reason, undefined, "the user's list is the list");
  const done = structuredClone(plan);
  task(done, 'migrate').status = 'done';
  assert.throws(() => applyOps(done, [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK] }], 'claude'), /"Add the migration" is done: its checks no longer change/);
});

test('a proposal preview refuses what accepting refuses: a check named like one of the repository\'s', () => {
  const plan = as(fresh(), 'claude', [{ op: 'propose', title: 'T', reason: 'r', ops: [{ op: 'upsert_task', id: 'docs', addChecks: [{ name: 'typecheck', run: 'tsc' }] }] }]);
  const p = plan.proposals![0]!;
  assert.equal(previewProposal(plan, p).blocker, null);
  assert.match(previewProposal(plan, p, { reserved: ['typecheck'] }).blocker ?? '', /"typecheck" is the name of one of the repository's checks/);
});

test("the brief names the check that holds: a task's own required one over an optional one above it", () => {
  const legacy = as(fresh(), 'claude', [{ op: 'upsert_task', id: 'm1', parentId: 'migrate', title: 'Schema' }]);
  task(legacy, 'migrate').addChecks = [{ name: 'db', run: 'true', stage: 'review', optional: true, by: 'claude' }];
  task(legacy, 'm1').addChecks = [{ ...DB_CHECK, stage: 'review', by: 'user' }];
  const brief = renderBrief(legacy, task(legacy, 'm1'), { project: PROJECT });
  assert.match(brief, /- db: `pnpm db:check` \(this task's own\)/);
});

test('round ten: the brief offers the command for checks the diff adds, says when the branch is the base, and a skip of an inherited check leaves the own one', () => {
  const project = parseProjectConfig({ hooks: { review: [{ name: 'api', run: 'pnpm api', paths: ['src/api/**'] }] } });
  let plan = as(fresh(), 'user', [{ op: 'upsert_task', id: 'docs', files: ['docs/x.md'] }]);
  plan = submitPlan(confirmDesign(plan, { prompt: 'tasks' }, 2_000), { target: 'session', prompt: 'build' }, 3_000);
  const viaDiff = renderBrief(plan, task(plan, 'docs'), { project, bin: '/x/coplan', diffBase: 'main', changed: ['src/api/y.ts'] });
  assert.match(viaDiff, /- api: `pnpm api`/);
  assert.match(viaDiff, /check review --files docs\/x\.md --base main`/, 'the command, though no check matches the files it listed');
  const isBase = renderBrief(plan, task(plan, 'docs'), { project, bin: '/x/coplan', diffUnread: 'is-base' });
  assert.match(isBase, /this task's branch is the base branch itself, so there is nothing to compare it with/);
  assert.doesNotMatch(isBase, /set `branches.base`/);

  const legacy = as(fresh(), 'claude', [{ op: 'upsert_task', id: 'm1', parentId: 'migrate', title: 'Schema' }]);
  task(legacy, 'migrate').addChecks = [{ name: 'db', run: 'true', stage: 'review', optional: true, by: 'claude' }];
  task(legacy, 'm1').addChecks = [{ ...DB_CHECK, stage: 'review', by: 'user' }];
  task(legacy, 'm1').skipChecks = [{ name: 'db', at: 1 }];
  assert.deepEqual(effectiveChecks(legacy, task(legacy, 'm1')).addChecks?.map((c) => [c.run, c.optional ?? false]), [['pnpm db:check', false]], 'its own required db still holds');

  // Restating a finished task's checks in another order is not a change.
  const done = as(fresh(), 'user', [{ op: 'upsert_task', id: 'migrate', addChecks: [DB_CHECK, { name: 'seed', run: 'pnpm seed' }] }]);
  task(done, 'migrate').status = 'done';
  assert.doesNotThrow(() => applyOps(done, [{ op: 'upsert_task', id: 'migrate', addChecks: [{ name: 'seed', run: 'pnpm seed' }, DB_CHECK] }], 'claude'));
});
