import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, countTasks, outline, PlanError, publishPlan, unreadByClaude } from '../shared/plan.ts';
import { renderPlan, unreadNotice } from '../daemon/render.ts';
import type { Plan, PlanInput } from '../shared/types.ts';

/**
 * The plan document: publishing, editing from either side, and the change
 * log that tells Claude what the user did since it last looked.
 */

const INPUT: PlanInput = {
  title: 'Add a cache',
  summary: 'Put a read-through cache in front of the database.',
  sections: [{ title: 'Context', body: 'Reads are slow.' }],
  diagrams: [
    {
      title: 'Components',
      nodes: [
        { id: 'api', label: 'API', kind: 'service' },
        { id: 'cache', label: 'Cache', kind: 'datastore' },
        { id: 'db', label: 'Postgres', kind: 'datastore' },
      ],
      edges: [
        { source: 'api', target: 'cache', label: 'get' },
        { source: 'cache', target: 'db', label: 'miss' },
      ],
    },
  ],
  tasks: [
    { title: 'Storage layer', subtasks: [{ title: 'Cache client' }, { title: 'Invalidation', status: 'blocked' }] },
    { title: 'Wire into API' },
  ],
  questions: [{ question: 'Which cache?', header: 'Backend', options: ['Redis', { label: 'In-memory', description: 'Lost on restart.' }] }],
};

const fresh = (): Plan => publishPlan(null, INPUT, 1000).plan;

test('publishing builds a nested task tree with readable ids', () => {
  const plan = fresh();
  assert.deepEqual(
    outline(plan).map((r) => `${r.number} ${r.task.id} ${r.task.title}`),
    ['1 t1 Storage layer', '1.1 t2 Cache client', '1.2 t3 Invalidation', '2 t4 Wire into API'],
  );
  assert.equal(plan.sections[0]!.id, 's1');
  assert.equal(plan.diagrams[0]!.id, 'd1');
  assert.equal(plan.questions[0]!.id, 'q1');
  assert.equal(plan.questions[0]!.options[1]!.description, 'Lost on restart.');
});

test('progress counts leaf tasks only', () => {
  // "Storage layer" is a heading over its two subtasks, not a third task.
  assert.deepEqual(countTasks(fresh()), { total: 3, done: 0, inProgress: 0, blocked: 1 });
});

test('publishing marks the plan read by Claude', () => {
  const plan = fresh();
  assert.equal(plan.claudeReadSeq, plan.seq);
  assert.equal(unreadByClaude(plan).length, 0);
});

test('a user edit is unread by Claude until it reads the plan', () => {
  const { plan } = applyOps(fresh(), [{ op: 'answer', id: 'q1', selected: ['Redis'], text: 'we already run it' }], 'user');
  const unread = unreadByClaude(plan);
  assert.equal(unread.length, 1);
  assert.match(unread[0]!.summary, /answered "Which cache\?": Redis — we already run it/);
  assert.match(unreadNotice(plan) ?? '', /harness_plan_read/);
});

test('Claude\'s own edits never show up as unread', () => {
  const { plan } = applyOps(fresh(), [{ op: 'upsert_task', id: 't2', status: 'done', note: 'added client' }], 'claude');
  assert.equal(unreadByClaude(plan).length, 0);
  assert.equal(unreadNotice(plan), null);
});

test('Claude editing does not swallow what the user did first', () => {
  let plan = applyOps(fresh(), [{ op: 'comment', target: { kind: 'task', id: 't4' }, text: 'do this first' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't2', status: 'in_progress' }], 'claude').plan;
  assert.equal(unreadByClaude(plan).length, 1, 'the comment is still unread');
});

test('a republish is refused while the user has unread changes', () => {
  const edited = applyOps(fresh(), [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
  assert.throws(() => publishPlan(edited, INPUT), (err: unknown) => err instanceof PlanError && /harness_plan_read/.test(err.message));
});

test('a republish keeps answers, comments and statuses on surviving ids', () => {
  let plan = applyOps(
    fresh(),
    [
      { op: 'answer', id: 'q1', selected: ['Redis'] },
      { op: 'comment', target: { kind: 'task', id: 't2' }, text: 'use the pooled client' },
      { op: 'upsert_task', id: 't2', status: 'done' },
    ],
    'user',
  ).plan;
  plan.claudeReadSeq = plan.seq; // Claude has read it

  const next = publishPlan(plan, {
    ...INPUT,
    tasks: [{ id: 't1', title: 'Storage layer', subtasks: [{ id: 't2', title: 'Cache client (pooled)' }] }],
    questions: [{ id: 'q1', question: 'Which cache?', options: ['Redis', 'In-memory'] }],
  }).plan;

  assert.equal(next.questions[0]!.answer?.selected[0], 'Redis');
  assert.equal(next.tasks.find((t) => t.id === 't2')?.status, 'done', 'a status Claude did not restate is kept');
  assert.equal(next.threads[0]!.target.id, 't2');
  assert.equal(next.revision, 2);
});

test('a comment on a removed item is kept, re-homed on the plan', () => {
  let plan = applyOps(fresh(), [{ op: 'comment', target: { kind: 'task', id: 't4' }, text: 'drop this?' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'remove', kind: 'task', id: 't4' }], 'user').plan;
  assert.equal(plan.threads[0]!.target.kind, 'plan');
  assert.match(plan.threads[0]!.text, /on removed task "Wire into API"/);
});

test('removing a task removes its subtasks and unlinks its questions', () => {
  let plan = applyOps(fresh(), [{ op: 'upsert_question', question: 'TTL?', taskId: 't3' }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'remove', kind: 'task', id: 't1' }], 'user').plan;
  assert.deepEqual(plan.tasks.map((t) => t.id), ['t4']);
  assert.equal(plan.questions.find((q) => q.question === 'TTL?')?.taskId, undefined);
  assert.match(plan.changes.at(-1)!.summary, /and its 2 subtask/);
});

test('moving a task re-parents it and reorders both sibling lists', () => {
  const { plan } = applyOps(fresh(), [{ op: 'move_task', id: 't4', parentId: 't1', index: 0 }], 'user');
  assert.deepEqual(
    outline(plan).map((r) => `${r.number} ${r.task.title}`),
    ['1 Storage layer', '1.1 Wire into API', '1.2 Cache client', '1.3 Invalidation'],
  );
  assert.match(plan.changes.at(-1)!.summary, /moved "Wire into API" under "Storage layer"/);
});

test('a task cannot be moved inside itself', () => {
  assert.throws(() => applyOps(fresh(), [{ op: 'move_task', id: 't1', parentId: 't2', index: 0 }], 'user'), /inside itself/);
});

test('a batch is all or nothing', () => {
  const before = fresh();
  assert.throws(
    () =>
      applyOps(before, [{ op: 'upsert_task', title: 'Fine' }, { op: 'answer', id: 'q99', text: 'nope' }], 'user'),
    /Edit 2 \(answer\): No question "q99"/,
  );
  assert.equal(before.tasks.length, 4, 'the plan passed in is untouched');
});

test('ids are never reused, even after a delete', () => {
  let plan = applyOps(fresh(), [{ op: 'remove', kind: 'task', id: 't4' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', title: 'New' }], 'user').plan;
  assert.ok(plan.tasks.some((t) => t.id === 't5'));
  assert.ok(!plan.tasks.some((t) => t.id === 't4'));
});

test('a single-choice question refuses two answers', () => {
  assert.throws(() => applyOps(fresh(), [{ op: 'answer', id: 'q1', selected: ['Redis', 'In-memory'] }], 'user'), /takes one option/);
});

test('threads: reply and resolve are logged against the item', () => {
  let plan = applyOps(fresh(), [{ op: 'comment', target: { kind: 'section', id: 's1' }, text: 'too vague' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'reply', threadId: 'c1', text: 'expanded it' }, { op: 'resolve', threadId: 'c1', resolved: true }], 'claude').plan;
  assert.equal(plan.threads[0]!.replies[0]!.author, 'claude');
  assert.equal(plan.threads[0]!.resolved, true);
});

/* ------------------------------------------------------------------ *
 * Diagrams
 * ------------------------------------------------------------------ */

test('an edge to a node that does not exist is refused, naming it', () => {
  assert.throws(
    () => publishPlan(null, { title: 'x', diagrams: [{ title: 'D', nodes: [{ id: 'a', label: 'A' }], edges: [{ source: 'a', target: 'b' }] }] }),
    /refers to node "b"/,
  );
});

test('diagram edits are described in words for Claude', () => {
  const { plan } = applyOps(
    fresh(),
    [
      {
        op: 'upsert_diagram',
        id: 'd1',
        nodes: [
          { id: 'api', label: 'API' },
          { id: 'cache', label: 'Redis' },
          { id: 'db', label: 'Postgres' },
          { id: 'queue', label: 'Jobs', kind: 'queue' },
        ],
        edges: [
          { source: 'api', target: 'cache', label: 'get' },
          { source: 'api', target: 'queue' },
        ],
      },
    ],
    'user',
  );
  const summary = plan.changes.at(-1)!.summary;
  assert.match(summary, /added "Jobs"/);
  assert.match(summary, /edited "Redis"/);
  assert.match(summary, /connected API → Jobs/);
  assert.match(summary, /disconnected Redis → Postgres|disconnected Cache → Postgres/);
});

test('dragging boxes is logged as a rearrangement, and positions survive a republish', () => {
  const base = fresh();
  const moved = applyOps(
    base,
    [
      {
        op: 'upsert_diagram',
        id: 'd1',
        nodes: base.diagrams[0]!.nodes.map((n, i) => ({ ...n, x: i * 200, y: 40 })),
        edges: base.diagrams[0]!.edges,
      },
    ],
    'user',
  ).plan;
  assert.equal(moved.changes.at(-1)!.kind, 'moved');
  assert.match(moved.changes.at(-1)!.summary, /rearranged 3 node/);

  moved.claudeReadSeq = moved.seq;
  const republished = publishPlan(moved, { ...INPUT, diagrams: [{ id: 'd1', ...INPUT.diagrams![0]! }] }).plan;
  assert.equal(republished.diagrams[0]!.nodes.find((n) => n.id === 'cache')?.x, 200, 'Claude did not restate it, so it stays put');
});

test('an edit that changes nothing logs nothing', () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  const { changes } = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes, edges: d.edges }], 'user');
  assert.equal(changes.length, 0);
});

/* ------------------------------------------------------------------ *
 * What Claude reads
 * ------------------------------------------------------------------ */

test('the rendering leads with the changes and carries every id', () => {
  const plan = applyOps(fresh(), [{ op: 'upsert_question', question: 'Should we shard?' }], 'user').plan;
  const text = renderPlan(plan, { url: 'http://x' });
  assert.ok(text.indexOf('Since you last read') < text.indexOf('## Tasks'));
  assert.match(text, /- \[ \] t2 Cache client/);
  assert.match(text, /- \[!\] t3 Invalidation/);
  assert.match(text, /\[d1\] Components/);
  assert.match(text, /- api → cache "get"/);
  assert.match(text, /\[q2\] Should we shard\? _\(asked by the user\)_/);
  assert.match(text, /UNANSWERED — answer it with harness_plan_edit/);
});

test('changes-only rendering skips the document', () => {
  const plan = applyOps(fresh(), [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'looks good' }], 'user').plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /commented on the plan: looks good/);
  assert.match(text, /Comments waiting on you/);
  assert.doesNotMatch(text, /## Tasks/);
});
