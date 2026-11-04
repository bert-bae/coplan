import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlanError,
  applyOps,
  confirmDesign,
  isDesignLocked,
  isLocked,
  markDelivered,
  markDesignDelivered,
  normalizePlan,
  planPhase,
  publishPlan,
  reopenDesign,
  reopenPlan,
  submitPlan,
  unreadByClaude,
} from '../shared/plan.ts';
import { BUILD_MARKER, DESIGN_MARKER, PROMPT_BUDGET, buildPrompt, designPrompt, renderPlan } from '../daemon/render.ts';
import { parseProjectConfig } from '../shared/project.ts';
import type { BuildTarget, Plan, PlanInput, PlanOp } from '../shared/types.ts';

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

/** The user confirmed the design. */
function confirmed(plan = published(), note?: string): Plan {
  const { prompt, trimmed } = designPrompt(plan, { ...(note ? { note } : {}) });
  return confirmDesign(plan, { prompt, trimmed, ...(note ? { note } : {}) }, 1_500);
}

function submitted(target: BuildTarget = 'session', plan = confirmed(), note?: string): Plan {
  const { prompt, trimmed } = buildPrompt(plan, { target, ...(note ? { note } : {}) });
  return submitPlan(plan, { target, prompt, trimmed, ...(note ? { note } : {}) }, 2_000);
}

/* ------------------------------------------------------------------ *
 * The lifecycle
 * ------------------------------------------------------------------ */

test('a plan moves from planning to tasking to submitted to building to built', () => {
  let plan = published();
  assert.equal(planPhase(plan), 'planning');
  assert.equal(isLocked(plan), false);
  assert.equal(isDesignLocked(plan), false);

  plan = confirmed(plan);
  assert.equal(planPhase(plan), 'tasking');
  assert.equal(isLocked(plan), false, 'the tasks still change');
  assert.equal(isDesignLocked(plan), true);

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

test('a plan is submitted only once its design is confirmed', () => {
  const plan = published();
  assert.throws(() => submitPlan(plan, { target: 'session', prompt: 'p' }), /Confirm the design first/);
});

test('submitting moves the version, so a page never rolls back past it', () => {
  const before = confirmed();
  const after = submitted('session', before);
  assert.ok(after.version > before.version);
  assert.equal(after.seq, before.seq, 'not news in the change log: it is not a change to the plan');
});

test('a plan is submitted once', () => {
  assert.throws(() => submitPlan(submitted(), { target: 'session', prompt: 'again' }), PlanError);
});

test('delivering the prompt is Claude reading the plan', () => {
  // The user edits, then submits: Claude has not read the edit yet...
  let plan = applyOps(confirmed(), [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
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
  plan = applyOps(plan, [{ op: 'report', text: 'Built it.' }], 'claude').plan;
  const next = publishPlan(plan, { ...INPUT, title: 'Next feature' }).plan;
  assert.equal(next.title, 'Next feature');
  assert.equal(next.submission, undefined, 'the new plan is open for planning');
  assert.equal(next.design, undefined);
  assert.equal(next.report, undefined);
  assert.equal(planPhase(next), 'planning');
});

test('reopening unlocks the tasks; reopening the design unlocks the rest', () => {
  const plan = reopenPlan(markDelivered(submitted()));
  assert.equal(isLocked(plan), false);
  assert.equal(planPhase(plan), 'tasking', 'the design stays confirmed');
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_task', id: 't1', title: 'Wire it in' }], 'user'));
  assert.throws(() => applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', title: 'Renamed' }], 'user'), /design is confirmed/);
  assert.throws(() => reopenPlan(plan), /not locked/);
  assert.throws(() => reopenDesign(markDelivered(submitted())), /Reopen it first/);

  const open = reopenDesign(plan);
  assert.equal(planPhase(open), 'planning');
  assert.doesNotThrow(() => applyOps(open, [{ op: 'upsert_diagram', id: 'd1', title: 'Renamed' }], 'user'));
  assert.throws(() => reopenDesign(open), /not confirmed/);
});

/* ------------------------------------------------------------------ *
 * The confirmed design
 * ------------------------------------------------------------------ */

test('a confirmed design is locked for both sides; tasks, task links and comments still change', () => {
  const plan = confirmed();
  for (const author of ['user', 'claude'] as const) {
    const refused: PlanOp[] = [
      { op: 'upsert_diagram', id: 'd1', title: 'Renamed' },
      { op: 'upsert_diagram', title: 'Another' },
      { op: 'upsert_section', id: 's1', body: 'changed' },
      { op: 'remove', kind: 'section', id: 's1' },
      { op: 'set_meta', summary: 'A different approach.' },
      { op: 'upsert_diagram', id: 'd1', nodes: [{ id: 'api', label: 'Gateway' }, { id: 'cache', label: 'Redis' }] },
    ];
    for (const op of refused) {
      assert.throws(() => applyOps(plan, [op], author), /design is confirmed|confirmed the design/, `${author}: ${JSON.stringify(op)}`);
    }
  }
  const cache = plan.diagrams[0]!.nodes.find((n) => n.id === 'cache')!;
  const relinked = plan.diagrams[0]!.nodes.map((n) => (n.id === 'api' ? { ...n, taskIds: ['t1'] } : n));
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', nodes: relinked }], 'user'), 'linking a box to a task');
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_task', title: 'Timeouts', dependsOn: ['t1'] }], 'claude'));
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'remove', kind: 'task', id: 't1' }], 'user'));
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'comment', target: { kind: 'diagram', id: 'd1' }, text: 'why Redis?' }], 'user'));
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'set_meta', title: 'Add a Redis cache' }], 'user'), 'the title names it');
  assert.ok(cache.notes, 'the design is untouched');
  assert.throws(() => publishPlan(plan, INPUT), /confirmed the design/);
  assert.throws(() => confirmDesign(plan, { prompt: 'again' }), /already confirmed/);
});

test('the design prompt asks for a linked task list, and not for the build', () => {
  const plan = published();
  const project = parseProjectConfig({ branches: { base: 'main', prefix: 'coplan/' } });
  const { prompt, trimmed } = designPrompt(plan, { note: 'Land the client first.', project });
  assert.equal(trimmed, false);
  assert.ok(prompt.startsWith(`${DESIGN_MARKER} for "Add a cache"`));
  assert.match(prompt, /harness_tasks_publish/);
  assert.match(prompt, /`dependsOn`/);
  assert.match(prompt, /`builds`/);
  assert.match(prompt, /stacked pull request/);
  assert.match(prompt, /cut from `main` and named `coplan\/…`/);
  assert.match(prompt, /Do not start building/);
  assert.match(prompt, /> Land the client first\./);
  assert.match(prompt, /suggest \/coplan-init|Suggest \/coplan-init/i, 'no checks configured');
  assert.match(prompt, /Read-through, 10m TTL\./, 'the design itself follows');
});

test('edits made after confirming are not in the design prompt, so they stay unread', () => {
  let plan = confirmed();
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'use redis' }, { op: 'upsert_task', id: 't1', title: 'Wire in' }], 'user').plan;
  plan = markDesignDelivered(plan, 3_000);
  assert.equal(plan.design?.deliveredAt, 3_000);
  assert.equal(unreadByClaude(plan).length, 2, 'Claude still has them to read');
  assert.throws(() => applyOps(confirmed(), [{ op: 'upsert_diagram', id: 'd1', index: 0 }], 'user'), /design is confirmed/, 'no reordering either');
});

test('the design prompt reaching Claude is a read, and the build prompt supersedes it', () => {
  // Edited before confirming: the prompt carries it.
  let plan = confirmed(applyOps(published(), [{ op: 'upsert_task', title: 'Load test' }], 'user').plan);
  plan = markDesignDelivered(plan, 3_000);
  assert.equal(plan.design?.deliveredAt, 3_000);
  assert.equal(unreadByClaude(plan).length, 0);
  assert.equal(markDesignDelivered(plan, 4_000).design?.deliveredAt, 3_000, 'once');

  // Submitted before Claude got the design: the build prompt carries it.
  const skipped = markDelivered(submitted('session', confirmed()), 5_000);
  assert.equal(skipped.design?.deliveredAt, 5_000);
});

test('the build settings are kept with the submission, and survive a reload', () => {
  const plan = confirmed();
  const settings = { review: 'user' as const, parallel: 3, maxRounds: 2 };
  const { prompt } = buildPrompt(plan, { target: 'session', settings });
  const done = submitPlan(plan, { target: 'session', prompt, settings });
  assert.deepEqual(done.submission?.settings, settings);
  const reloaded = normalizePlan(JSON.parse(JSON.stringify(done)), 'x');
  assert.deepEqual(reloaded.submission?.settings, settings);
  assert.ok(reloaded.design, 'the design sign-off too');
  const wild = submitPlan(plan, { target: 'session', prompt, settings: { review: 'nobody' as never, parallel: 99, maxRounds: 0 } });
  assert.deepEqual(wild.submission?.settings, { review: 'subagent', parallel: 8, maxRounds: 1 });
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
  assert.match(prompt, /mark it in_progress with stage "implement" \(harness_task_update\)/);
  assert.match(prompt, /coplan-build skill/);
  assert.match(prompt, /iric skill/);
  assert.match(prompt, /harness_task_next/);
  assert.match(prompt, /harness_task_brief/);
  assert.match(prompt, /Review: an independent reviewer/);
  assert.match(prompt, /up to 2 at once/);
  assert.match(prompt, /mark the task blocked with a note/);
  assert.match(prompt, /upsert_task with a parentId/);
  assert.match(prompt, /op: "report"/);
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

test('the prompt carries the settings the user chose and the repository\'s checks', () => {
  const project = parseProjectConfig({
    hooks: { implement: ['npm run typecheck'], review: [{ name: 'tests', run: 'npm test', optional: false }], final: ['npm run check'] },
  });
  const { prompt } = buildPrompt(published(), { target: 'session', settings: { review: 'user', parallel: 1, maxRounds: 4 }, project, bin: '/opt/coplan/bin/coplan' });
  assert.match(prompt, /Review: the user, before it is marked done/);
  assert.match(prompt, /build them one at a time/);
  assert.match(prompt, /After 4 review rounds without passing, stop and ask the user/);
  assert.match(prompt, /- implement: typecheck `npm run typecheck`/);
  assert.match(prompt, /- review: tests `npm test`/);
  assert.match(prompt, /"\/opt\/coplan\/bin\/coplan" check <stage>/);
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
