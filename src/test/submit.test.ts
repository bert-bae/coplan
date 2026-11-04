import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlanError,
  applyOps,
  isLocked,
  markDelivered,
  normalizePlan,
  planPhase,
  publishPlan,
  reopenPlan,
  submitPlan,
  unreadByClaude,
} from '../shared/plan.ts';
import { BUILD_MARKER, PROMPT_BUDGET, buildPrompt, renderPlan } from '../daemon/render.ts';
import type { BuildTarget, Plan, PlanInput } from '../shared/types.ts';

/**
 * Submitting the plan: the user signs it off, Claude gets the prompt they
 * read, and from then on the plan is locked — only the build moves.
 */

const INPUT: PlanInput = {
  title: 'Add a cache',
  summary: 'Put a read-through cache in front of the database.',
  sections: [{ title: 'Context', body: 'Reads are slow.' }],
  diagrams: [
    {
      title: 'Components',
      nodes: [
        { id: 'api', label: 'API', kind: 'service', description: 'Serves orders.' },
        { id: 'cache', label: 'Redis', kind: 'datastore', taskIds: ['client'], notes: 'Read-through, 10m TTL.' },
      ],
      edges: [{ source: 'api', target: 'cache', label: 'get' }],
    },
  ],
  tasks: [
    { id: 'client', title: 'Cache client', detail: 'Wrap ioredis.', files: ['src/cache.ts'] },
    { title: 'Wire into API' },
  ],
};

const published = (): Plan => publishPlan(null, INPUT, 1_000).plan;

function submitted(target: BuildTarget = 'session', plan = published(), note?: string): Plan {
  const { prompt, trimmed } = buildPrompt(plan, { target, ...(note ? { note } : {}) });
  return submitPlan(plan, { target, prompt, trimmed, ...(note ? { note } : {}) }, 2_000);
}

/* ------------------------------------------------------------------ *
 * The lifecycle
 * ------------------------------------------------------------------ */

test('a plan moves from planning to submitted to building to built', () => {
  let plan = published();
  assert.equal(planPhase(plan), 'planning');
  assert.equal(isLocked(plan), false);

  plan = submitted('session', plan);
  assert.equal(planPhase(plan), 'submitted');
  assert.equal(isLocked(plan), true);

  plan = markDelivered(plan, 3_000);
  assert.equal(planPhase(plan), 'building');
  assert.equal(plan.submission?.deliveredAt, 3_000);

  for (const task of plan.tasks) plan = applyOps(plan, [{ op: 'upsert_task', id: task.id, status: 'done' }], 'claude').plan;
  assert.equal(planPhase(plan), 'built');
});

test('a plan handed off to be built elsewhere is locked, and never waits for delivery', () => {
  const plan = submitted('elsewhere');
  assert.equal(planPhase(plan), 'handed-off');
  assert.equal(isLocked(plan), true);
  assert.equal(markDelivered(plan).submission?.deliveredAt, null, 'markDelivered is for this session only');
});

test('submitting moves the version, so a page never rolls back past it', () => {
  const before = published();
  const after = submitted('session', before);
  assert.ok(after.version > before.version);
  assert.equal(after.seq, before.seq, 'not news in the change log: it is not a change to the plan');
});

test('a plan is submitted once', () => {
  assert.throws(() => submitPlan(submitted(), { target: 'session', prompt: 'again' }), PlanError);
});

test('delivering the prompt is Claude reading the plan', () => {
  // The user edits, then submits: Claude has not read the edit yet...
  let plan = applyOps(published(), [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
  plan = submitted('session', plan);
  assert.equal(unreadByClaude(plan).length, 1);
  // ...and the prompt that carries it counts as the read.
  plan = markDelivered(plan);
  assert.equal(unreadByClaude(plan).length, 0);
  assert.equal(plan.claudeReadSeq, plan.seq);
});

/* ------------------------------------------------------------------ *
 * The lock
 * ------------------------------------------------------------------ */

test('the user can change nothing on a submitted plan', () => {
  const plan = submitted();
  for (const op of [
    { op: 'upsert_task', id: 't2', status: 'done' },
    { op: 'upsert_diagram', id: 'd1', title: 'Renamed' },
    { op: 'comment', target: { kind: 'plan', id: '' }, text: 'hm' },
    { op: 'set_meta', title: 'x' },
  ] as const) {
    assert.throws(() => applyOps(plan, [op], 'user'), /locked\. Reopen it/);
  }
});

test('Claude can track the work on a submitted plan, and add work it discovers', () => {
  let plan = markDelivered(submitted());
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'client', status: 'in_progress' }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', parentId: 'client', title: 'Handle timeouts' }], 'claude').plan;
  assert.equal(plan.tasks.find((t) => t.id === 'client')?.status, 'in_progress');
  assert.ok(plan.tasks.some((t) => t.title === 'Handle timeouts'));
});

test('Claude cannot redesign a submitted plan, and is told what to do instead', () => {
  const plan = markDelivered(submitted());
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', title: 'Redesigned' }], 'claude'),
    (err: Error) => err instanceof PlanError && /submitted this plan/.test(err.message) && /reopen the plan in Coplan/.test(err.message) && /upsert_diagram/.test(err.message),
  );
  // All or nothing: a tracking op beside a design op is refused with it.
  assert.throws(() =>
    applyOps(plan, [{ op: 'upsert_task', id: 'client', status: 'done' }, { op: 'remove', kind: 'section', id: 's1' }], 'claude'),
  );
});

test('a republish is refused until the build is finished, then starts a new plan', () => {
  let plan = markDelivered(submitted());
  assert.throws(() => publishPlan(plan, { ...INPUT, title: 'Something else' }), /submitted this plan/);
  for (const task of plan.tasks) plan = applyOps(plan, [{ op: 'upsert_task', id: task.id, status: 'done' }], 'claude').plan;
  const next = publishPlan(plan, { ...INPUT, title: 'Next feature' }).plan;
  assert.equal(next.title, 'Next feature');
  assert.equal(next.submission, undefined, 'the new plan is open for planning');
  assert.equal(planPhase(next), 'planning');
});

test('reopening unlocks the plan for both sides', () => {
  const plan = reopenPlan(markDelivered(submitted()));
  assert.equal(isLocked(plan), false);
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', title: 'Renamed' }], 'user'));
  assert.throws(() => reopenPlan(plan), /not locked/);
});

test('a submission survives a reload, and a damaged one unlocks rather than locks for good', () => {
  const plan = submitted();
  const reloaded = normalizePlan(JSON.parse(JSON.stringify(plan)), 'x');
  assert.deepEqual(reloaded.submission, plan.submission);
  const damaged = normalizePlan({ ...JSON.parse(JSON.stringify(plan)), submission: { target: 'mars', prompt: 1 } }, 'x');
  assert.equal(damaged.submission, undefined);
});

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

test('the prompt for this session says how to report progress, then gives the plan', () => {
  const { prompt, trimmed } = buildPrompt(published(), { target: 'session', note: 'Start with the client.\nLeave billing alone.' });
  assert.equal(trimmed, false);
  assert.ok(prompt.startsWith(`${BUILD_MARKER} "Add a cache"`));
  assert.match(prompt, /mark it in_progress with harness_task_update/);
  assert.match(prompt, /mark the task blocked with a note/);
  assert.match(prompt, /upsert_task with a parentId/);
  assert.match(prompt, /## From the user\n> Start with the client\.\n> Leave billing alone\./);
  // The plan itself: architecture, decisions, tasks with their ids, files and detail.
  assert.match(prompt, /## Architecture/);
  assert.match(prompt, /Read-through, 10m TTL\./);
  assert.match(prompt, /- \[ \] client Cache client\n  files: src\/cache\.ts\n  Wrap ioredis\./);
  assert.doesNotMatch(prompt, /Since you last read/, 'nothing unread, nothing to say');
});

test("the prompt leads with what the user changed that Claude has not read", () => {
  const plan = applyOps(published(), [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
  const { prompt } = buildPrompt(plan, { target: 'session' });
  assert.match(prompt, /## Since you last read — what the user changed[\s\S]*Added t\d+ "Load test" at the top level/);
  assert.ok(prompt.indexOf('Since you last read') < prompt.indexOf('## Architecture'));
});

test('the prompt for somewhere else never mentions harness tools', () => {
  const plan = applyOps(published(), [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
  const { prompt, trimmed } = buildPrompt(plan, { target: 'elsewhere' });
  assert.equal(trimmed, false);
  assert.doesNotMatch(prompt, /harness_|cc-harness/);
  assert.doesNotMatch(prompt, /added by the user|edited by the user/);
  assert.match(prompt, /^Build "Add a cache"/);
  assert.match(prompt, /- \[ \] client Cache client/);
});

test('a plan too long for one message is trimmed for this session, never for somewhere else', () => {
  const long = 'A long paragraph of detail that goes on. '.repeat(30);
  const big: PlanInput = {
    ...INPUT,
    diagrams: [
      {
        title: 'Big',
        nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: `Part ${i}`, description: long })),
        edges: [],
      },
    ],
    // Enough that even the titles alone do not fit.
    tasks: Array.from({ length: 300 }, (_, i) => ({ title: `Task number ${i}`, detail: long })),
  };
  const plan = publishPlan(null, big).plan;
  const here = buildPrompt(plan, { target: 'session' });
  assert.equal(here.trimmed, true);
  assert.ok(here.prompt.length <= PROMPT_BUDGET, `${here.prompt.length} > ${PROMPT_BUDGET}`);
  assert.ok(here.prompt.startsWith(BUILD_MARKER), 'still recognisably the build prompt');
  assert.match(here.prompt, /call harness_plan_read for them before you start/);
  assert.match(here.prompt, /Task number 0/);
  assert.match(here.prompt, /more line\(s\): harness_plan_read lists every task/);

  const there = buildPrompt(plan, { target: 'elsewhere' });
  assert.equal(there.trimmed, false);
  assert.match(there.prompt, /Task number 299/);
});

test('what Claude reads back says the plan is locked, and why', () => {
  const plan = markDelivered(submitted());
  assert.match(renderPlan(plan), /\*\*Locked for building\.\*\*/);
  assert.match(renderPlan(submitted('elsewhere')), /built outside this session/);
  assert.doesNotMatch(renderPlan(published()), /Locked/);
});
