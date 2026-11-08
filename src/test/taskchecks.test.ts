import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, confirmDesign, markDelivered, markReadByClaude, normalizePlan, publishPlan, submitPlan } from '../shared/plan.ts';
import { effectiveChecks } from '../shared/build.ts';
import { parseProjectConfig, taskHooks } from '../shared/project.ts';
import { renderBrief, renderNext } from '../daemon/brief.ts';
import { renderPlan } from '../daemon/render.ts';
import type { Plan } from '../shared/types.ts';

/**
 * A task's own checks (#54): a docs-only task skipping the test suite, a
 * migration adding its own check. Only the user sets them — the agent
 * proposes — and a skip is never silent.
 */

const project = parseProjectConfig(
  { hooks: { implement: ['pnpm typecheck'], review: [{ name: 'tests', run: 'pnpm test' }, { name: 'lint', run: 'pnpm lint', optional: true }] } },
  null,
);

function plan(): Plan {
  return publishPlan(null, {
    title: 'Add a migration',
    tasks: [
      { id: 'db', title: 'Database', subtasks: [{ id: 'migrate', title: 'Write the migration', files: ['db/001.sql'] }] },
      { id: 'docs', title: 'Document it', files: ['README.md'] },
    ],
  }).plan;
}

const set = (p: Plan, op: Record<string, unknown>, author: 'user' | 'claude' = 'user') => applyOps(p, [{ op: 'set_checks', ...op } as never], author).plan;

test('the user sets a task\'s checks; the agent cannot — it proposes, and the user accepts', () => {
  let p = set(plan(), { id: 'docs', skip: ['tests'] });
  assert.deepEqual(p.tasks.find((t) => t.id === 'docs')?.skipChecks, ['tests']);
  assert.match(p.changes.at(-1)!.summary, /set the checks of "Document it": skips tests/);

  assert.throws(() => set(p, { id: 'docs', skip: [] }, 'claude'), /Which checks a task runs is the user's to set[\s\S]*harness_plan_propose/);
  // Proposed, it waits for the user; accepted, it is theirs.
  p = applyOps(p, [{ op: 'propose', title: 'Check the migration', reason: 'It can lose data.', ops: [{ op: 'set_checks', id: 'migrate', add: [{ name: 'db:check', run: 'pnpm db:check' }] }] }], 'claude').plan;
  assert.equal(p.tasks.find((t) => t.id === 'migrate')?.addChecks, undefined, 'nothing changes until the user answers');
  p = applyOps(p, [{ op: 'accept_proposal', id: 'p1' }], 'user').plan;
  assert.deepEqual(p.tasks.find((t) => t.id === 'migrate')?.addChecks, [{ name: 'db:check', run: 'pnpm db:check', stage: 'review' }]);
  // [] clears; the same again changes nothing.
  p = set(p, { id: 'docs', skip: [] });
  assert.equal(p.tasks.find((t) => t.id === 'docs')?.skipChecks, undefined);
  assert.match(p.changes.at(-1)!.summary, /cleared the checks set for "Document it"/);
  assert.equal(applyOps(p, [{ op: 'set_checks', id: 'docs', skip: [] } as never], 'user').changes.length, 0);
});

test('what a task adds is whole, named and each once', () => {
  assert.throws(() => set(plan(), { id: 'docs' }), /Say what changes/);
  assert.throws(() => set(plan(), { id: 'docs', add: [{ name: 'x' }] }), /needs `run`/);
  assert.throws(() => set(plan(), { id: 'docs', add: [{ run: 'a', stage: 'final' }] }), /a stage for a task's own check/);
  assert.throws(() => set(plan(), { id: 'docs', add: [{ name: 'c', run: 'a' }, { name: 'c', run: 'b' }] }), /Two of the task's checks are called "c"/);
  assert.throws(() => set(plan(), { id: 'docs', skip: 'tests' }), /`skip` is a list/);
  const p = set(plan(), { id: 'docs', add: [{ run: 'vale docs/', stage: 'implement', optional: true }] });
  assert.deepEqual(p.tasks.find((t) => t.id === 'docs')?.addChecks, [{ name: 'vale docs/', run: 'vale docs/', stage: 'implement', optional: true }], 'named from its command');
});

test('on a submitted plan the user still sets them, and accepts a proposal to; the agent is told why not', () => {
  let p = markDelivered(submitPlan(confirmDesign(plan(), { prompt: 'd' }), { target: 'session', mode: 'managed', prompt: 'p' }));
  p = set(p, { id: 'docs', skip: ['tests'] });
  assert.deepEqual(p.tasks.find((t) => t.id === 'docs')?.skipChecks, ['tests']);
  assert.throws(() => set(p, { id: 'docs', skip: [] }, 'claude'), /Which checks a task runs is the user's to set/, 'not the lock message: the reason');
  p = applyOps(p, [{ op: 'propose', title: 'Skip lint for the migration', reason: 'SQL only.', ops: [{ op: 'set_checks', id: 'migrate', skip: ['lint'] }] }], 'claude').plan;
  p = applyOps(p, [{ op: 'accept_proposal', id: 'p1' }], 'user').plan;
  assert.deepEqual(p.tasks.find((t) => t.id === 'migrate')?.skipChecks, ['lint'], 'a build in progress takes a proposal for checks');
});

test('a subtask holds its parent\'s checks; a task\'s checks are the repository\'s, less its skips, plus its own', () => {
  let p = set(plan(), { id: 'db', skip: ['tests'], add: [{ name: 'db:check', run: 'pnpm db:check' }] });
  p = set(p, { id: 'migrate', add: [{ name: 'sqlfluff', run: 'sqlfluff lint db/', stage: 'implement' }] });
  const migrate = p.tasks.find((t) => t.id === 'migrate')!;
  const own = effectiveChecks(p, migrate);
  assert.deepEqual(own.skip, ['tests']);
  assert.deepEqual(own.add.map((c) => c.name), ['sqlfluff', 'db:check']);
  assert.deepEqual(taskHooks(project, 'review', migrate.files, own).map((h) => h.name), ['lint', 'db:check']);
  assert.deepEqual(taskHooks(project, 'implement', migrate.files, own).map((h) => h.name), ['typecheck', 'sqlfluff']);
  assert.deepEqual(taskHooks(project, 'review', [], { add: [], skip: [] }).map((h) => h.name), ['tests', 'lint'], 'nothing set: as before');
});

test('a skip is never silent: the brief, the read-back, the changes and the report say it', () => {
  let p = set(plan(), { id: 'docs', skip: ['tests'], add: [{ name: 'links', run: 'pnpm check-links' }] });
  const docs = p.tasks.find((t) => t.id === 'docs')!;
  const brief = renderBrief(p, docs, { project, mode: 'managed', bin: '/coplan' });
  assert.match(brief, /## Checks set for this task\nThe user set these; they hold for this task over the repository's:\n- It skips tests: do not run it for this task — done does not wait on it\.\n- It adds links: `pnpm check-links` at review — done waits on it/);
  assert.match(brief, /\*\*Review\.\*\*[^\n]*\n- lint: `pnpm lint` \(optional\)\n- links: `pnpm check-links`/, 'the review list leaves tests out and has links');
  assert.match(brief, /check implement --skip tests`.*It does not know the checks added for this task \(links\): run those as listed\./);
  assert.match(renderBrief(p, docs, { project, mode: 'tracked' }), /- review: lint `pnpm lint` \(optional\); links `pnpm check-links`/);
  assert.match(renderPlan(p), /t?docs Document it · skips tests; adds links \(review\)/);

  // Kept on disk.
  p = normalizePlan(JSON.parse(JSON.stringify(p)) as Plan & Record<string, unknown>, 'x');
  assert.deepEqual(p.tasks.find((t) => t.id === 'docs')?.addChecks, [{ name: 'links', run: 'pnpm check-links', stage: 'review' }], 'kept on disk');

  // The finish says which tasks skipped which checks, for the report.
  let done = p;
  for (const t of done.tasks.filter((x) => !done.tasks.some((c) => c.parentId === x.id))) {
    done = applyOps(done, [{ op: 'upsert_task', id: t.id, status: 'done' }], 'claude', undefined, { tracking: true }).plan;
  }
  assert.match(renderNext(done, { project }), /Say in it which checks were skipped, as the user set them: docs skipped tests\./);
});

test('the agent reads what the user set as a change to the task', () => {
  let p = plan();
  markReadByClaude(p);
  p = set(p, { id: 'docs', skip: ['tests'] });
  assert.match(renderPlan(p, { changesOnly: true }), /Changed docs "Document it": its checks now: skips tests\./);
});

test('a task\'s checks read from disk keep only what is whole', () => {
  const p = plan();
  const raw = JSON.parse(JSON.stringify(p));
  raw.tasks.find((t: { id: string }) => t.id === 'docs').addChecks = [{ name: 'ok', run: 'x', stage: 'review' }, { name: 'bad', stage: 'review' }, { name: 'final', run: 'y', stage: 'final' }];
  raw.tasks.find((t: { id: string }) => t.id === 'docs').skipChecks = ['tests', 3, ''];
  const back = normalizePlan(raw, 'x').tasks.find((t) => t.id === 'docs')!;
  assert.deepEqual(back.addChecks, [{ name: 'ok', run: 'x', stage: 'review' }]);
  assert.deepEqual(back.skipChecks, ['tests']);
});
