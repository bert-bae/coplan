import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, awaitingUserReview, confirmDesign, markDelivered, planPhase, planStatus, publishPlan, statusOfPhase, submitPlan } from '../shared/plan.ts';
import { PLAN_PHASES, PLAN_STATUSES, type BuildTarget, type Plan, type PlanPhase, type PlanStatus } from '../shared/types.ts';
import { PLAN_STATUS, statusDetail, statusFacts, statusWords } from '../ui/lib/status.ts';

/**
 * The four statuses a user sees (#66): every phase maps to exactly one,
 * and Review is what was built waiting on the user — the final checks and
 * report, or a task in review that asks for the user's own review.
 */

const EXPECTED: Record<PlanPhase, PlanStatus> = {
  planning: 'planning',
  tasking: 'planning',
  submitted: 'in_progress',
  building: 'in_progress',
  finalizing: 'review',
  landing: 'review',
  built: 'done',
  'handed-off': 'done',
};

test('every phase maps to one of the four statuses', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...PLAN_PHASES].sort(), 'the table covers every phase');
  for (const phase of PLAN_PHASES) {
    assert.equal(statusOfPhase(phase), EXPECTED[phase], phase);
    assert.ok(PLAN_STATUSES.includes(statusOfPhase(phase, true)), `${phase}, waiting on the user`);
  }
  // A task held for the user's review turns a build in progress into Review,
  // and changes nothing in any other phase.
  for (const phase of PLAN_PHASES) {
    assert.equal(statusOfPhase(phase, true), phase === 'submitted' || phase === 'building' ? 'review' : EXPECTED[phase], phase);
  }
  // Every status is reached, and each has its word.
  assert.deepEqual([...new Set(Object.values(EXPECTED))].sort(), [...PLAN_STATUSES].sort());
  assert.deepEqual(Object.fromEntries(PLAN_STATUSES.map((s) => [s, PLAN_STATUS[s].label])), {
    planning: 'Planning',
    in_progress: 'In progress',
    review: 'Review',
    done: 'Done',
  });
});

const INPUT = {
  title: 'Add a cache',
  tasks: [
    { id: 'client', title: 'Cache client' },
    { id: 'wire', title: 'Wire it in', review: 'user' as const },
  ],
};

function plan(): Plan {
  return publishPlan(null, INPUT).plan;
}

function building(target: BuildTarget = 'session'): Plan {
  return markDelivered(submitPlan(confirmDesign(plan(), { prompt: 'd' }), { target, prompt: 'p' }));
}

const progress = (p: Plan, id: string, fields: Record<string, unknown>) =>
  applyOps(p, [{ op: 'upsert_task', id, ...fields } as never], 'claude', undefined, { tracking: true }).plan;

test('each phase of a real plan shows its status, with its detail', () => {
  const said = (p: Plan) => statusWords(statusFacts(p, 'agent'), 'Claude');
  const designing = plan();
  assert.equal(planStatus(designing, 'agent'), 'planning');
  assert.equal(said(designing), 'Planning', 'nothing to add while designing');
  const confirmed = confirmDesign(designing, { prompt: 'd' });
  assert.equal(planPhase(confirmed), 'tasking');
  assert.equal(said(confirmed), 'Planning · design confirmed');
  const submitted = submitPlan(confirmed, { target: 'session', prompt: 'p' });
  assert.equal(said(submitted), 'In progress · waiting for Claude');
  let built = markDelivered(submitted);
  assert.equal(said(built), 'In progress · building');
  built = progress(built, 'client', { stage: 'implement' });
  assert.equal(said(built), 'In progress · on Cache client', 'the task the agent is on');
  for (const id of ['client', 'wire']) built = progress(built, id, { status: 'done' });
  assert.equal(planPhase(built), 'finalizing');
  assert.equal(said(built), 'Review · final checks and report');
  built = applyOps(built, [{ op: 'report', text: 'Built.' }], 'claude').plan;
  assert.equal(said(built), 'Done · built');
  assert.equal(said(building('elsewhere')), 'Done · exported', 'a plan exported before 0.4 still reads as it was');
  assert.equal(planStatus(null, 'agent'), 'planning', 'a session with no plan yet is planning');
});

test('a task in review that asks for the user\'s review is Review, until they answer it', () => {
  // `wire` asks for the user's review; `client` the repository's default.
  let p = building();
  p = progress(p, 'client', { stage: 'review' });
  assert.equal(planStatus(p, 'agent'), 'in_progress', 'a review the agent runs is not the user\'s');
  p = progress(p, 'client', { status: 'done' });
  p = progress(p, 'wire', { stage: 'implement' });
  assert.equal(planStatus(p, 'agent'), 'in_progress');
  p = progress(p, 'wire', { stage: 'review' });
  assert.deepEqual(awaitingUserReview(p, 'agent').map((t) => t.id), ['wire']);
  assert.equal(planStatus(p, 'agent'), 'review');
  assert.equal(statusDetail(statusFacts(p, 'agent'), 'Claude'), '1 task waits on your review');
  // The user's verdict, given: back to In progress, whichever it was.
  const passed = applyOps(p, [{ op: 'review_task', id: 'wire', verdict: 'pass' }], 'user').plan;
  assert.equal(planStatus(passed, 'agent'), 'in_progress');
  const changes = applyOps(p, [{ op: 'review_task', id: 'wire', verdict: 'changes' }], 'user').plan;
  assert.equal(planStatus(changes, 'agent'), 'in_progress');
  // A new round waits on them again.
  assert.equal(planStatus(progress(progress(changes, 'wire', { stage: 'refine' }), 'wire', { stage: 'review' }), 'agent'), 'review');
});

test("the repository's default review counts, and nothing waits on a review before the plan is submitted (#162)", () => {
  let p = building();
  p = progress(p, 'client', { stage: 'review' });
  assert.deepEqual(awaitingUserReview(p, 'user').map((t) => t.id), ['client'], "the repository's default review");
  assert.equal(planStatus(p, 'user'), 'review');
  assert.equal(statusFacts(p, 'user').awaitingReview, 1);
  assert.equal(planStatus(p, 'agent'), 'in_progress');
  // Not submitted: nothing is being built, so nothing waits on a review.
  assert.deepEqual(awaitingUserReview(plan(), 'user'), []);
});
