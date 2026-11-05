import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, confirmDesign, publishPlan, publishTasks } from '../shared/plan.ts';
import { planGaps, type GapRule } from '../shared/check.ts';
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

  const stacked = publishTasks(confirmDesign(publishPlan(null, DESIGN).plan, { prompt: 'p' }), {
    tasks: [
      { id: 'base', title: 'Base work' },
      { id: 'a', title: 'A', branch: 'x/a' },
      { id: 'b', title: 'B', branch: 'x/b' },
      { id: 'c', title: 'C', branch: 'x/c', dependsOn: ['a', 'b'] },
      { id: 'd', title: 'D', branch: 'x/d', dependsOn: ['base'] },
    ],
  }).plan;
  assert.ok(rules(stacked).some((r) => r.startsWith('branch-two-bases')), 'x/c needs x/a and x/b');
  assert.ok(has(stacked, 'branch-on-unbranched', 'd'), 'x/d would be cut without base');
});

test('a comment from the user nobody answered, until it is answered', () => {
  let plan = publishPlan(null, DESIGN).plan;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'node', id: 'd1/cache' }, text: 'Why Redis?' }], 'user').plan;
  assert.ok(has(plan, 'comment-unanswered', 'd1/cache'));
  const thread = plan.threads[0]!.id;
  plan = applyOps(plan, [{ op: 'reply', threadId: thread, text: 'Already in the stack.' }], 'claude').plan;
  assert.ok(!has(plan, 'comment-unanswered', 'd1/cache'));
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
