import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, confirmDesign, publishPlan, publishTasks, threadsForRevision } from '../shared/plan.ts';
import { boxUnbuilt, planGaps, type GapRule } from '../shared/check.ts';
import { renderGaps, renderPlan } from '../daemon/render.ts';
import type { Plan, PlanInput } from '../shared/types.ts';

/**
 * harness_plan_check: what a plan leaves open. Each rule is something no
 * single view shows — the diagram and the task list have to be read
 * together to see a box nobody builds.
 */

const DESIGN: PlanInput = {
  title: 'Add a cache',
  diagrams: [
    {
      id: 'd1',
      title: 'Components',
      nodes: [
        { id: 'user', label: 'Shopper', kind: 'actor' },
        { id: 'api', label: 'API', kind: 'service', description: 'Serves orders.', taskIds: ['wire'] },
        { id: 'cache', label: 'Redis', kind: 'datastore' },
      ],
      edges: [
        { source: 'user', target: 'api' },
        { source: 'api', target: 'cache' },
      ],
    },
  ],
  tasks: [{ id: 'wire', title: 'Wire up' }, { id: 'docs', title: 'Docs' }],
};

const rules = (plan: Plan) => planGaps(plan).map((g) => `${g.rule} ${g.target.kind}:${g.target.id}`);
const has = (plan: Plan, rule: GapRule, id: string) => rules(plan).some((r) => r.startsWith(`${rule} `) && r.endsWith(`:${id}`));

test('boxes and tasks that do not account for each other', () => {
  const plan = publishPlan(null, DESIGN).plan;
  assert.ok(has(plan, 'box-unbuilt', 'd1/cache'), 'nothing builds the cache');
  assert.ok(!has(plan, 'box-unbuilt', 'd1/user'), 'an actor is not something the plan builds');
  assert.ok(!has(plan, 'box-unbuilt', 'd1/api'));
  assert.ok(has(plan, 'task-builds-nothing', 'docs'));
  assert.ok(!has(plan, 'task-builds-nothing', 'wire'));
  assert.ok(has(plan, 'box-undescribed', 'd1/cache'));
  assert.ok(!has(plan, 'box-undescribed', 'd1/api'));
});

test("the canvas's \"no task\" marks exactly the boxes box-unbuilt lists", () => {
  const plan = publishPlan(null, {
    ...DESIGN,
    diagrams: [{ ...DESIGN.diagrams![0]!, nodes: [...(DESIGN.diagrams![0]!.nodes ?? []), { id: 'why', label: 'Why Redis', kind: 'note' }, { id: 'pay', label: 'Stripe', kind: 'external' }] }],
  }).plan;
  const marked = plan.diagrams.flatMap((d) => d.nodes.filter((n) => boxUnbuilt(plan, n)).map((n) => `${d.id}/${n.id}`));
  const listed = planGaps(plan).filter((g) => g.rule === 'box-unbuilt').map((g) => g.target.id);
  assert.deepEqual(marked, listed);
  assert.deepEqual(marked, ['d1/cache']);
  const d = DESIGN.diagrams![0]!;
  const untasked = publishPlan(null, { ...DESIGN, tasks: [], diagrams: [{ ...d, nodes: (d.nodes ?? []).map(({ taskIds: _t, ...n }) => n) }] }).plan;
  assert.ok(!untasked.diagrams[0]!.nodes.some((n) => boxUnbuilt(untasked, n)), 'no box is unbuilt before the plan has tasks');
});

test('once the task list is being made, every task must say what done means', () => {
  const planning = publishPlan(null, DESIGN).plan;
  assert.ok(!rules(planning).some((r) => r.startsWith('task-undetailed')), 'planned tasks may be coarse');
  const tasking = publishTasks(confirmDesign(planning, { prompt: 'p' }), {
    tasks: [
      { id: 'wire', title: 'Wire up', detail: 'Done when reads go through the cache.', builds: ['api'] },
      { id: 'docs', title: 'Docs' },
    ],
  }).plan;
  assert.ok(has(tasking, 'task-undetailed', 'docs'));
  assert.ok(!has(tasking, 'task-undetailed', 'wire'));
});

test('a box id two diagrams share, and branch layouts a PR stack cannot follow', () => {
  const two = publishPlan(null, {
    ...DESIGN,
    diagrams: [...DESIGN.diagrams!, { id: 'd2', title: 'Read path', nodes: [{ id: 'cache', label: 'Redis' }] }],
  }).plan;
  assert.ok(rules(two).some((r) => r.startsWith('node-id-shared')));

  // A branch built on the unbranched work stacks on the session's branch:
  // a stack can follow that, so it is not a gap.
  const confirmed = confirmDesign(publishPlan(null, DESIGN).plan, { prompt: 'p' });
  const onCurrent = publishTasks(confirmed, {
    tasks: [
      { id: 'base', title: 'Base work' },
      { id: 'd', title: 'D', branch: 'x/d', dependsOn: ['base'] },
    ],
  }).plan;
  assert.ok(!rules(onCurrent).some((r) => r.startsWith('branch-')));

  // Two bases is refused when the list is made — and still flagged in a
  // plan saved before that was enforced.
  const twoBases = [
    { id: 'a', title: 'A', branch: 'x/a' },
    { id: 'b', title: 'B', branch: 'x/b' },
    { id: 'c', title: 'C', branch: 'x/c', dependsOn: ['a', 'b'] },
  ];
  assert.throws(() => publishTasks(confirmed, { tasks: twoBases }), /needs work from `x\/a` and `x\/b`, but a pull request has one base/);
  const old = structuredClone(publishTasks(confirmed, { tasks: twoBases.map(({ dependsOn: _d, ...t }) => t) }).plan);
  old.tasks.find((t) => t.id === 'c')!.dependsOn = ['a', 'b'];
  assert.ok(rules(old).some((r) => r.startsWith('branch-two-bases')), 'x/c needs x/a and x/b');
});

test('a comment from the user nobody answered, until it is answered', () => {
  let plan = publishPlan(null, DESIGN).plan;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'node', id: 'd1/cache' }, text: 'Why Redis?' }], 'user').plan;
  assert.ok(has(plan, 'comment-unanswered', 'd1/cache'));
  const thread = plan.threads[0]!.id;
  plan = applyOps(plan, [{ op: 'reply', threadId: thread, text: 'Already in the stack.' }], 'claude').plan;
  assert.ok(!has(plan, 'comment-unanswered', 'd1/cache'));
});

test('the check and Request revisions agree on what waits on the agent, a question in a proposal too', () => {
  let plan = publishPlan(null, DESIGN).plan;
  plan = applyOps(plan, [{ op: 'propose', title: 'Add a box', reason: 'Asked for.', ops: [{ op: 'upsert_node', diagramId: 'd1', id: 'queue', label: 'Queue' }] }], 'claude').plan;
  const proposal = plan.threads.at(-1)!;
  const gaps = () => planGaps(plan).filter((g) => g.rule === 'comment-unanswered');
  assert.deepEqual([threadsForRevision(plan), gaps()], [[], []], 'the proposal as made waits on the user');
  // The user asks in the proposal's own thread, as the page lets them: now it waits on the agent.
  plan = applyOps(plan, [{ op: 'reply', threadId: proposal.id, text: 'Which queue?' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'node', id: 'd1/cache' }, text: 'Why Redis?' }], 'user').plan;
  assert.deepEqual(threadsForRevision(plan).map((t) => t.target), [proposal.target, { kind: 'node', id: 'd1/cache' }]);
  assert.deepEqual(gaps().map((g) => g.target), [proposal.target, { kind: 'node', id: 'd1/cache' }]);
  assert.match(gaps()[0]!.message, /"Which queue\?"$/, "the user's question, not the proposal it answers");
});

test('the read and the check tool say it the same way', () => {
  const plan = publishPlan(null, DESIGN).plan;
  const gaps = renderGaps(plan);
  assert.match(gaps[0]!, /^## Gaps \(\d+\) — what the plan leaves open$/);
  assert.match(renderPlan(plan), /No task builds box "Redis" in "Components"/);
  assert.match(renderGaps(plan, 1).at(-1)!, /harness_plan_check lists them all/);
  const clean = publishPlan(null, { title: 'Empty' }).plan;
  assert.deepEqual(renderGaps(clean), []);
});

test('a parent loop in a plan from disk does not hang the check', () => {
  const plan = structuredClone(publishPlan(null, DESIGN).plan);
  plan.tasks[0]!.parentId = 'docs';
  plan.tasks[1]!.parentId = 'wire';
  assert.ok(Array.isArray(planGaps(plan)));
});
