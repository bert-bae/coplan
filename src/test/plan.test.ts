import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, confirmDesign, countTasks, markReadByClaude, normalizePlan, outline, PlanError, publishPlan, submitPlan, unreadAreas, unreadByClaude } from '../shared/plan.ts';
import { renderPlan, unreadNotice } from '../daemon/render.ts';
import { previewProposal } from '../shared/proposals.ts';
import type { Plan, PlanInput, PlanOp } from '../shared/types.ts';

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
  const { plan } = applyOps(fresh(), [{ op: 'move_task', id: 't4', parentId: 't1', index: 0 }], 'user');
  const unread = unreadByClaude(plan);
  assert.equal(unread.length, 1);
  assert.match(unread[0]!.summary, /moved "Wire into API" under "Storage layer"/);
  assert.match(unreadNotice(plan) ?? '', /harness_plan_read/);
});

test('Claude\'s own edits never show up as unread', () => {
  const { plan } = applyOps(fresh(), [{ op: 'upsert_task', id: 't2', status: 'done', note: 'added client' }], 'claude', undefined, { tracking: true });
  assert.equal(unreadByClaude(plan).length, 0);
  assert.equal(unreadNotice(plan), null);
});

test('Claude editing does not swallow what the user did first', () => {
  let plan = applyOps(fresh(), [{ op: 'comment', target: { kind: 'task', id: 't4' }, text: 'do this first' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't2', status: 'in_progress' }], 'claude', undefined, { tracking: true }).plan;
  assert.equal(unreadByClaude(plan).length, 1, 'the comment is still unread');
});

test('a republish is refused while the user has unread changes', () => {
  const edited = applyOps(fresh(), [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
  assert.throws(() => publishPlan(edited, INPUT), (err: unknown) => err instanceof PlanError && /harness_plan_read/.test(err.message));
});

test('a republish keeps comments and statuses on surviving ids', () => {
  let plan = applyOps(
    fresh(),
    [
      { op: 'comment', target: { kind: 'task', id: 't2' }, text: 'use the pooled client' },
      { op: 'upsert_task', id: 't2', status: 'done' },
    ],
    'user',
  ).plan;
  plan.claudeReadSeq = plan.seq; // Claude has read it

  const next = publishPlan(plan, {
    ...INPUT,
    tasks: [{ id: 't1', title: 'Storage layer', subtasks: [{ id: 't2', title: 'Cache client (pooled)' }] }],
  }).plan;

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

test('removing a task removes its subtasks and unlinks them from the diagram', () => {
  const base = fresh();
  const d = base.diagrams[0]!;
  let plan = applyOps(
    base,
    [{ op: 'upsert_diagram', id: 'd1', nodes: d.nodes.map((n) => (n.id === 'cache' ? { ...n, taskIds: ['t3', 't4'] } : n)), edges: d.edges }],
    'claude',
  ).plan;
  plan = applyOps(plan, [{ op: 'remove', kind: 'task', id: 't1' }], 'user').plan;
  assert.deepEqual(plan.tasks.map((t) => t.id), ['t4']);
  assert.deepEqual(plan.diagrams[0]!.nodes.find((n) => n.id === 'cache')?.taskIds, ['t4']);
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
      applyOps(before, [{ op: 'upsert_task', title: 'Fine' }, { op: 'remove', kind: 'task', id: 't99' }], 'user'),
    /Edit 2 \(remove\): No task "t99"/,
  );
  assert.equal(before.tasks.length, 4, 'the plan passed in is untouched');
});

test('ids are never reused, even after a delete', () => {
  let plan = applyOps(fresh(), [{ op: 'remove', kind: 'task', id: 't4' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', title: 'New' }], 'user').plan;
  assert.ok(plan.tasks.some((t) => t.id === 't5'));
  assert.ok(!plan.tasks.some((t) => t.id === 't4'));
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

test('dragging boxes saves the layout without telling Claude, and positions survive a republish', () => {
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
  assert.equal(moved.changes.length, base.changes.length, 'layout is not a change');
  assert.equal(unreadByClaude(moved).length, 0);
  assert.equal(moved.diagrams[0]!.rev, base.diagrams[0]!.rev + 1, 'but it moves the revision, so a stale save is refused');
  assert.equal(moved.diagrams[0]!.nodes[1]!.x, 200);

  const republished = publishPlan(moved, { ...INPUT, diagrams: [{ id: 'd1', ...INPUT.diagrams![0]! }] }).plan;
  assert.equal(republished.diagrams[0]!.nodes.find((n) => n.id === 'cache')?.x, 200, 'Claude did not restate it, so it stays put');
});

test('a box carries notes and the tasks that build it', () => {
  const plan = publishPlan(null, {
    title: 'x',
    tasks: [{ id: 'build-cache', title: 'Build the cache', subtasks: [{ title: 'client' }] }],
    diagrams: [
      {
        title: 'D',
        nodes: [{ id: 'cache', label: 'Cache', kind: 'datastore', notes: 'Redis, because we run it.', taskIds: ['build-cache'] }],
      },
    ],
  }).plan;
  const node = plan.diagrams[0]!.nodes[0]!;
  assert.equal(node.notes, 'Redis, because we run it.');
  assert.deepEqual(node.taskIds, ['build-cache']);
  assert.match(renderPlan(plan), /- \*\*Cache\*\* `cache` — data store\n  Decisions:\n    Redis, because we run it\.\n  Built by: \[ \] build-cache Build the cache/);
});

test('a box cannot link a task that does not exist', () => {
  assert.throws(
    () => publishPlan(null, { title: 'x', diagrams: [{ title: 'D', nodes: [{ id: 'a', label: 'A', taskIds: ['nope'] }] }] }),
    /links task "nope"/,
  );
});

test('linking a box to tasks is described for Claude', () => {
  const base = fresh();
  const d = base.diagrams[0]!;
  const { plan } = applyOps(
    base,
    [{ op: 'upsert_diagram', id: 'd1', nodes: d.nodes.map((n) => (n.id === 'cache' ? { ...n, taskIds: ['t2'], notes: 'LRU' } : n)), edges: d.edges }],
    'user',
  );
  assert.match(plan.changes.at(-1)!.summary, /edited "Cache"; changed the tasks behind "Cache"/);
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
  const plan = applyOps(fresh(), [{ op: 'upsert_task', title: 'Shard it' }], 'user').plan;
  const text = renderPlan(plan, { url: 'http://x' });
  assert.ok(text.indexOf('Since you last read') < text.indexOf('## Tasks'));
  assert.match(text, /- \[ \] t2 Cache client/);
  assert.match(text, /- \[!\] t3 Invalidation/);
  assert.match(text, /\[d1\] Components/);
  assert.match(text, /- API → Cache: get `api → cache`/);
  assert.match(text, /Added t5 "Shard it" at the top level\./);
  assert.match(text, /t5 Shard it _\(added by the user\)_/);
  assert.doesNotMatch(text, /question/i, 'questions live in Claude\'s chat, not the plan');
});

test('changes-only rendering skips the document', () => {
  const plan = applyOps(fresh(), [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'looks good' }], 'user').plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /Commented on the plan: looks good/);
  assert.match(text, /Comments waiting on you/);
  assert.doesNotMatch(text, /## Tasks/);
});

/* ------------------------------------------------------------------ *
 * Revisions: no silent lost updates
 * ------------------------------------------------------------------ */

test('a save made against an old revision is refused, naming who changed it', () => {
  let plan = fresh();
  const rev = plan.sections[0]!.rev;
  plan = applyOps(plan, [{ op: 'upsert_section', id: 's1', body: 'Claude rewrote this.' }], 'claude').plan;
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_section', id: 's1', body: 'my stale edit', expect: rev }], 'user'),
    /was changed by Claude while this edit was open/,
  );
  const ok = applyOps(plan, [{ op: 'upsert_section', id: 's1', body: 'my edit', expect: plan.sections[0]!.rev }], 'user').plan;
  assert.equal(ok.sections[0]!.body, 'my edit');
});

test('every change to a diagram moves its revision; a no-op does not', () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  const same = applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', nodes: d.nodes, edges: d.edges, expect: d.rev }], 'user').plan;
  assert.equal(same.diagrams[0]!.rev, d.rev);
  const moved = applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', nodes: d.nodes.map((n) => ({ ...n, x: 1, y: 2 })), edges: d.edges, expect: d.rev }], 'user').plan;
  assert.equal(moved.diagrams[0]!.rev, d.rev + 1);
  assert.throws(() => applyOps(moved, [{ op: 'upsert_diagram', id: 'd1', caption: 'x', expect: d.rev }], 'user'), /not saved/);
});

test('a republish moves the revision only of what it changed', () => {
  const plan = fresh();
  const next = publishPlan(plan, { ...INPUT, sections: [{ id: 's1', title: 'Context', body: 'Reads are slow.' }], diagrams: [{ id: 'd1', ...INPUT.diagrams![0]!, title: 'Renamed' }] }).plan;
  assert.equal(next.sections[0]!.rev, plan.sections[0]!.rev, 'unchanged section keeps its revision');
  assert.equal(next.diagrams[0]!.rev, plan.diagrams[0]!.rev + 1);
});

test('a plan read from disk in any older shape is normalized, not rejected', () => {
  const plan = normalizePlan({ title: 'old', sections: [{ id: 's1', title: 'x', body: 'y' }], diagrams: [{ id: 'd1', title: 'D' }] } as never, 'fallback');
  assert.equal(plan.sections[0]!.rev, 1);
  assert.deepEqual(plan.diagrams[0]!.nodes, []);
  assert.deepEqual(plan.tasks, []);
  assert.equal(plan.claudeReadAt, null);
});

test('comment threads and plan items are bounded', () => {
  let plan = fresh();
  const many = Array.from({ length: 61 }, (_, i) => ({ title: `S${i}`, body: '' }));
  assert.throws(() => publishPlan(null, { title: 'x', sections: many }), /at most 60 sections/);
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'a' }], 'user').plan;
  const replies = Array.from({ length: 200 }, () => ({ op: 'reply' as const, threadId: 'c1', text: 'r' }));
  plan = applyOps(plan, replies, 'user').plan;
  assert.throws(() => applyOps(plan, [{ op: 'reply', threadId: 'c1', text: 'one more' }], 'user'), /thread is full/);
});

test("Claude's edits are checked field by field: a misspelt field is refused, not ignored", () => {
  const plan = fresh();
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_task', id: 't2', depends_on: ['t1'] } as never], 'claude'),
    (err: Error) => err instanceof PlanError && /upsert_task does not take "depends_on"/.test(err.message) && /dependsOn/.test(err.message),
  );
  assert.throws(() => applyOps(plan, [{ op: 'rename_task', id: 't2' } as never], 'claude'), /Unknown edit "rename_task"/);
  // Still all or nothing: the good edit before the bad one is not applied.
  assert.throws(
    () => applyOps(plan, [{ op: 'set_meta', title: 'New' }, { op: 'reply', threadId: 'c1', body: 'x' } as never], 'claude'),
    /Edit 2 \(reply\): reply does not take "body"/,
  );
  const { changes } = applyOps(plan, [{ op: 'upsert_task', id: 't4', dependsOn: ['t1'] }], 'claude');
  assert.equal(changes.length, 1);
});

test('an empty edit list says what shape to use', () => {
  assert.throws(() => applyOps(fresh(), [], 'claude'), /pass them as \{ops: \[/);
});

test('a box kind, arrow style or direction that is not on the list is refused, not dropped', () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  const nodes = d.nodes.map((n) => ({ id: n.id, label: n.label }));
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: [...nodes, { id: 'q', label: 'Q', kind: 'kafka' as never }] }], 'claude'),
    /"kafka" is not a box kind: use one of component, service/,
  );
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_diagram', id: d.id, edges: [{ source: 'api', target: 'cache', arrows: 'two' as never }] }], 'claude'),
    /"two" is not an arrow style/,
  );
  assert.throws(() => applyOps(plan, [{ op: 'upsert_diagram', id: d.id, direction: 'RL' as never }], 'claude'), /"RL" is not a diagram direction/);
  // Left out, they keep what was there.
  const { plan: next } = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes }], 'claude');
  assert.equal(next.diagrams[0]!.nodes.find((n) => n.id === 'cache')!.kind, 'datastore');
});

test('removing a node points at the edit that does it', () => {
  assert.throws(() => applyOps(fresh(), [{ op: 'remove', kind: 'node' as never, id: 'cache' }], 'claude'), /remove_node \{diagramId, id\}/);
});

/* ------------------------------------------------------------------ *
 * Claude never writes over what the user changed and it has not read
 * ------------------------------------------------------------------ */

test("Claude's edit to a diagram the user changed unread is refused, so the user's new box survives", () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  const theirs = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: [...d.nodes, { id: 'queue', label: 'Queue', kind: 'queue' }] }], 'user').plan;
  // Claude, working from what it last read, rewords a box by resending the list it knew.
  const mine = d.nodes.map((n) => (n.id === 'api' ? { ...n, description: 'Serves orders.' } : n));
  assert.throws(
    () => applyOps(theirs, [{ op: 'upsert_diagram', id: d.id, nodes: mine }], 'claude'),
    (err: Error) => /The user changed diagram "Components" since you last read/.test(err.message) && /harness_plan_read/.test(err.message),
  );
  // Once Claude has read, the same edit goes through — on top of their version.
  const read = structuredClone(theirs);
  markReadByClaude(read);
  const after = applyOps(read, [{ op: 'upsert_diagram', id: d.id, nodes: [...mine, { id: 'queue', label: 'Queue' }] }], 'claude').plan;
  assert.ok(after.diagrams[0]!.nodes.some((n) => n.id === 'queue'));
});

test('the unread guard covers tasks, sections and the summary, but not progress, comments or other items', () => {
  let plan = fresh();
  plan = applyOps(
    plan,
    [
      { op: 'upsert_task', id: 't4', detail: 'Their detail.' },
      { op: 'upsert_section', id: plan.sections[0]!.id, body: 'Their context.' },
      { op: 'comment', target: { kind: 'task', id: 't2' }, text: 'Split this?' },
    ],
    'user',
  ).plan;
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 't4', title: 'Mine' }], 'claude'), /changed task/);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_section', id: plan.sections[0]!.id, body: 'Mine.' }], 'claude'), /changed section/);
  assert.throws(() => applyOps(plan, [{ op: 'remove', kind: 'task', id: 't4' }], 'claude'), /changed task/);
  // Progress on the task they edited, a task they only commented on, and the
  // diagram they did not touch all go through.
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_task', id: 't4', status: 'in_progress', note: 'started' }], 'claude', undefined, { tracking: true }));
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_task', id: 't2', title: 'Cache client (split)' }], 'claude'));
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_diagram', id: plan.diagrams[0]!.id, caption: 'Read path' }], 'claude'));
});

test("a box's detail and a task's detail survive an edit or republish that leaves them out", () => {
  let plan = publishPlan(null, {
    ...INPUT,
    diagrams: [{ ...INPUT.diagrams![0]!, nodes: (INPUT.diagrams![0]!.nodes ?? []).map((n) => ({ ...n, detail: `${n.label} detail` })) }],
    tasks: [{ id: 'a', title: 'A', detail: 'Keep me.' }],
  }).plan;
  const d = plan.diagrams[0]!;
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes.map((n) => ({ id: n.id, label: n.label })) }], 'claude').plan;
  assert.equal(plan.diagrams[0]!.nodes.find((n) => n.id === 'cache')!.detail, 'Cache detail');
  // Sending it empty still clears it.
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes.map((n) => ({ id: n.id, label: n.label, detail: '' })) }], 'claude').plan;
  assert.equal(plan.diagrams[0]!.nodes.find((n) => n.id === 'cache')!.detail, undefined);

  plan = publishPlan(plan, { ...INPUT, diagrams: undefined, tasks: [{ id: 'a', title: 'A, renamed' }] }).plan;
  assert.equal(plan.tasks.find((t) => t.id === 'a')!.detail, 'Keep me.');
});

/* ------------------------------------------------------------------ *
 * Tasks have a revision, like sections and diagrams
 * ------------------------------------------------------------------ */

test("a user's task edit made before Claude's newer change is refused, not saved over it", () => {
  const plan = fresh();
  const opened = plan.tasks.find((t) => t.id === 't4')!.rev ?? 1;
  const claudes = applyOps(plan, [{ op: 'upsert_task', id: 't4', detail: 'Use the client from t2.' }], 'claude').plan;
  assert.equal(claudes.tasks.find((t) => t.id === 't4')!.rev, opened + 1);
  assert.throws(
    () => applyOps(claudes, [{ op: 'upsert_task', id: 't4', detail: 'My older text.', expect: opened }], 'user'),
    /Task "Wire into API" was changed by Claude while this edit was open/,
  );
  // Made against the current revision, it goes in.
  const now = claudes.tasks.find((t) => t.id === 't4')!.rev;
  assert.doesNotThrow(() => applyOps(claudes, [{ op: 'upsert_task', id: 't4', detail: 'Mine.', expect: now }], 'user'));
});

test("the user's own quick successive saves never conflict with each other, and progress is not a revision", () => {
  let plan = fresh();
  const opened = plan.tasks.find((t) => t.id === 't4')!.rev ?? 1;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't4', dependsOn: ['t2'], expect: opened }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't4', dependsOn: ['t2', 't3'], expect: opened }], 'user').plan;
  assert.deepEqual(plan.tasks.find((t) => t.id === 't4')!.dependsOn, ['t2', 't3']);
  const rev = plan.tasks.find((t) => t.id === 't4')!.rev;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't4', status: 'in_progress', note: 'started' }], 'claude', undefined, { tracking: true }).plan;
  assert.equal(plan.tasks.find((t) => t.id === 't4')!.rev, rev, 'a status report does not move the revision');
});

test("Claude republishing a task with new content moves its revision; unchanged tasks keep theirs", () => {
  const plan = publishPlan(null, { ...INPUT, tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }).plan;
  const next = publishPlan(plan, { ...INPUT, tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', detail: 'New.' }] }).plan;
  assert.equal(next.tasks.find((t) => t.id === 'a')!.rev ?? 1, 1);
  assert.equal(next.tasks.find((t) => t.id === 'b')!.rev, 2);
  assert.throws(() => applyOps(next, [{ op: 'upsert_task', id: 'b', title: 'B!', expect: 1 }], 'user'), /changed by Claude/);
});

/* ------------------------------------------------------------------ *
 * Comments on one box or arrow
 * ------------------------------------------------------------------ */

test('Claude can comment on one box or one arrow, and the read says which', () => {
  let plan = fresh();
  const d = plan.diagrams[0]!;
  const edge = d.edges.find((e) => e.source === 'api')!;
  plan = applyOps(
    plan,
    [
      { op: 'comment', target: { kind: 'node', id: `${d.id}/cache` }, text: 'Should this be write-through?' },
      { op: 'comment', target: { kind: 'edge', id: `${d.id}/${edge.id}` }, text: 'Batch these gets?' },
    ],
    'claude',
  ).plan;
  const text = renderPlan(plan);
  assert.match(text, /on box "Cache" \(d1\/cache\) in diagram "Components" — you: Should this be write-through\?/);
  assert.match(text, /on arrow API → Cache \(d1\/[^)]+\) in diagram "Components" — you: Batch these gets\?/);
  assert.throws(
    () => applyOps(plan, [{ op: 'comment', target: { kind: 'node', id: `${d.id}/nope` }, text: 'x' }], 'claude'),
    /Nothing to comment on at node/,
  );
});

test('a comment on a box that is removed stays, on the plan, saying what it was about', () => {
  let plan = fresh();
  const d = plan.diagrams[0]!;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'node', id: `${d.id}/db` }, text: 'Which Postgres?' }], 'user').plan;
  markReadByClaude(plan);
  plan = applyOps(
    plan,
    [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes.filter((n) => n.id !== 'db').map((n) => ({ id: n.id, label: n.label })), edges: [{ source: 'api', target: 'cache' }] }],
    'claude',
  ).plan;
  const thread = plan.threads.find((t) => t.text.includes('Which Postgres?'))!;
  assert.deepEqual(thread.target, { kind: 'plan', id: '' });
  assert.match(thread.text, /^\(on removed box "Postgres"/);
});

test('an arrow restated without its id keeps it, and so keeps its comments', () => {
  let plan = fresh();
  const d = plan.diagrams[0]!;
  const edge = d.edges.find((e) => e.source === 'api')!;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'edge', id: `${d.id}/${edge.id}` }, text: 'Batch?' }], 'user').plan;
  markReadByClaude(plan);
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, edges: [{ source: 'api', target: 'cache', label: 'get' }, { source: 'cache', target: 'db' }] }], 'claude').plan;
  assert.ok(plan.diagrams[0]!.edges.some((e) => e.id === edge.id));
  assert.equal(plan.threads.find((t) => t.text === 'Batch?')!.target.kind, 'edge');
});

test('the read gives each section, diagram and task its revision, for expect', () => {
  const text = renderPlan(fresh());
  assert.match(text, /### \[s1\] Context _\(rev 1\)_/);
  assert.match(text, /^_rev 1_$/m);
  assert.match(text, /t4 Wire into API.* · rev 1$/m);
});

/* ------------------------------------------------------------------ *
 * One box or arrow at a time
 * ------------------------------------------------------------------ */

test('upsert_node changes only the fields it gives, and nothing else in the diagram', () => {
  let plan = fresh();
  const d = plan.diagrams[0]!;
  // What the user wrote on another box must survive Claude's edit to this one.
  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: d.id, id: 'db', notes: 'Their notes.' }], 'user').plan;
  markReadByClaude(plan);
  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: d.id, id: 'cache', description: 'Holds hot reads.' }], 'claude').plan;
  const nodes = plan.diagrams[0]!.nodes;
  assert.equal(nodes.find((n) => n.id === 'cache')!.description, 'Holds hot reads.');
  assert.equal(nodes.find((n) => n.id === 'cache')!.kind, 'datastore');
  assert.equal(nodes.find((n) => n.id === 'db')!.notes, 'Their notes.');
  assert.equal(plan.diagrams[0]!.edges.length, 2);

  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: d.id, id: 'queue', label: 'Queue', kind: 'queue' }], 'claude').plan;
  assert.ok(plan.diagrams[0]!.nodes.some((n) => n.id === 'queue'));
  assert.throws(() => applyOps(plan, [{ op: 'upsert_node', diagramId: d.id, id: 'ghost' }], 'claude'), /No box "ghost".*give it a label/);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_node', diagramId: 'd9', id: 'x', label: 'X' }], 'claude'), /No diagram "d9"/);
});

test('remove_node takes its arrows with it; arrows are added, restyled and removed one at a time', () => {
  let plan = fresh();
  const d = plan.diagrams[0]!;
  plan = applyOps(plan, [{ op: 'remove_node', diagramId: d.id, id: 'db' }], 'claude').plan;
  assert.deepEqual(plan.diagrams[0]!.edges.map((e) => `${e.source}->${e.target}`), ['api->cache']);

  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: d.id, id: 'db', label: 'Postgres', kind: 'datastore' }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'upsert_edge', diagramId: d.id, from: 'cache', to: 'db', label: 'miss' }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'upsert_edge', diagramId: d.id, id: 'cache->db', dashed: true }], 'claude').plan;
  const edge = plan.diagrams[0]!.edges.find((e) => e.id === 'cache->db')!;
  assert.equal(edge.label, 'miss', 'a restyle keeps the label');
  assert.equal(edge.dashed, true);

  plan = applyOps(plan, [{ op: 'remove_edge', diagramId: d.id, from: 'cache', to: 'db' }], 'claude').plan;
  assert.ok(!plan.diagrams[0]!.edges.some((e) => e.source === 'cache' && e.target === 'db'));
  assert.throws(() => applyOps(plan, [{ op: 'remove_edge', diagramId: d.id, from: 'cache', to: 'db' }], 'claude'), /No arrow cache → db/);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_edge', diagramId: d.id, from: 'cache', to: 'nope' }], 'claude'), /refers to node "nope"/);
});

test('box and arrow edits keep to the diagram rules: the unread guard and the design lock', () => {
  let plan = fresh();
  const d = plan.diagrams[0]!;
  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: d.id, id: 'api', label: 'Gateway' }], 'user').plan;
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_node', diagramId: d.id, id: 'cache', description: 'x' }], 'claude'),
    /The user changed diagram "Components" since you last read/,
  );
  markReadByClaude(plan);

  const confirmed = confirmDesign(plan, { prompt: 'p' });
  // Linking a box to the tasks that build it is still allowed; redesigning it is not.
  assert.doesNotThrow(() => applyOps(confirmed, [{ op: 'upsert_node', diagramId: d.id, id: 'cache', taskIds: ['t2'] }], 'claude'));
  assert.throws(() => applyOps(confirmed, [{ op: 'upsert_node', diagramId: d.id, id: 'cache', label: 'Memcached' }], 'claude'), /design/);
  assert.throws(() => applyOps(confirmed, [{ op: 'remove_node', diagramId: d.id, id: 'cache' }], 'claude'), /design/);
});

test('an arrow moved to another box keeps its label and style', () => {
  let plan = fresh();
  const d = plan.diagrams[0]!;
  plan = applyOps(plan, [{ op: 'upsert_edge', diagramId: d.id, id: 'cache->db', dashed: true }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'upsert_edge', diagramId: d.id, id: 'cache->db', from: 'api' }], 'claude').plan;
  const moved = plan.diagrams[0]!.edges.find((e) => e.id === 'cache->db')!;
  assert.equal(moved.source, 'api');
  assert.equal(moved.label, 'miss');
  assert.equal(moved.dashed, true);
});

test('several box ops on one diagram, each with the rev that was read, go through together', () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  const { plan: next } = applyOps(
    plan,
    [
      { op: 'upsert_node', diagramId: d.id, id: 'api', description: 'A.', expect: d.rev },
      { op: 'upsert_node', diagramId: d.id, id: 'cache', description: 'C.', expect: d.rev },
    ],
    'claude',
  );
  assert.equal(next.diagrams[0]!.nodes.find((n) => n.id === 'cache')!.description, 'C.');
  // A rev that is not the one read is still refused.
  assert.throws(() => applyOps(next, [{ op: 'upsert_node', diagramId: d.id, id: 'api', description: 'B.', expect: d.rev }], 'claude'), /was changed/);
});

test("upsert_task's builds says which boxes the task builds now; [] unlinks it", () => {
  let plan = fresh();
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't2', builds: ['cache'] }], 'claude').plan;
  const linked = (id: string) => plan.diagrams[0]!.nodes.find((n) => n.id === id)!.taskIds ?? [];
  assert.ok(linked('cache').includes('t2'));
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't2', builds: ['db'] }], 'claude').plan;
  assert.ok(!linked('cache').includes('t2'));
  assert.ok(linked('db').includes('t2'));
  // The same links again change nothing, so the diagram's rev stays.
  const rev = plan.diagrams[0]!.rev;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't2', builds: ['db'] }], 'claude').plan;
  assert.equal(plan.diagrams[0]!.rev, rev);
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't2', builds: [] }], 'claude').plan;
  assert.ok(!linked('db').includes('t2'));
  assert.match(plan.changes.at(-1)!.summary, /unlinked "Cache client" from "Postgres"/);
});

test("removing a task its boxes link moves the diagram's revision, so a canvas holding the old links reloads", () => {
  let plan = applyOps(fresh(), [{ op: 'upsert_task', id: 't2', builds: ['cache'] }], 'claude').plan;
  const rev = plan.diagrams[0]!.rev;
  plan = applyOps(plan, [{ op: 'remove', kind: 'task', id: 't2' }], 'user').plan;
  assert.ok(!plan.diagrams[0]!.nodes.some((n) => n.taskIds?.includes('t2')));
  assert.equal(plan.diagrams[0]!.rev, rev + 1);
  // A save made against the old revision (the canvas, unaware) is refused, not applied.
  assert.throws(() => applyOps(plan, [{ op: 'upsert_diagram', id: plan.diagrams[0]!.id, caption: 'x', expect: rev }], 'user'), /was changed/);
});

/* ------------------------------------------------------------ proposals */

const WRITE_THROUGH: PlanOp = {
  op: 'propose',
  title: 'Make the cache write-through',
  reason: 'Reads after a write would otherwise see stale data for up to the TTL.',
  ops: [
    { op: 'upsert_node', diagramId: 'd1', id: 'cache', description: 'Write-through: every write updates it.' },
    { op: 'upsert_edge', diagramId: 'd1', from: 'api', to: 'db', label: 'write' },
  ],
};

test('a proposal changes nothing until the user accepts it, and its reasoning is a comment on what it changes', () => {
  const before = fresh();
  const { plan } = applyOps(before, [WRITE_THROUGH], 'claude');
  const p = plan.proposals![0]!;
  assert.equal(p.id, 'p1');
  assert.equal(p.status, 'open');
  assert.deepEqual(plan.diagrams, before.diagrams, 'the design is untouched');
  const thread = plan.threads.find((t) => t.id === p.threadId)!;
  assert.deepEqual(thread.target, { kind: 'node', id: 'd1/cache' });
  assert.match(thread.text, /^Proposal p1: Make the cache write-through\n\nReads after a write/);
  assert.match(plan.changes.at(-1)!.summary, /proposed p1 "Make the cache write-through" \(2 edits\)/);
});

test('accepting a proposal applies its edits as the user’s, settles its thread, and Claude hears of it', () => {
  let plan = applyOps(fresh(), [WRITE_THROUGH], 'claude').plan;
  plan = applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user').plan;
  const d = plan.diagrams[0]!;
  assert.equal(d.nodes.find((n) => n.id === 'cache')!.description, 'Write-through: every write updates it.');
  assert.ok(d.edges.some((e) => e.source === 'api' && e.target === 'db' && e.label === 'write'), 'both edits, though each moves the diagram');
  assert.equal(plan.proposals![0]!.status, 'accepted');
  const thread = plan.threads.find((t) => t.id === plan.proposals![0]!.threadId)!;
  assert.ok(thread.resolved);
  assert.equal(thread.replies.at(-1)!.text, 'Accepted.');
  const unread = unreadByClaude(plan).map((c) => c.summary);
  assert.ok(unread.some((s) => /accepted proposal p1/.test(s)), 'the outcome is unread by Claude');
  assert.equal(d.updatedBy, 'user', 'the change is the user’s');
  assert.throws(() => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user'), /already accepted/);
});

test('rejecting says why; Claude cannot accept or reject, and the user cannot propose', () => {
  let plan = applyOps(fresh(), [WRITE_THROUGH], 'claude').plan;
  assert.throws(() => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'claude'), /Only the user accepts/);
  assert.throws(() => applyOps(plan, [{ op: 'reject_proposal', id: 'p1' }], 'claude'), /Only the user rejects/);
  assert.throws(() => applyOps(plan, [WRITE_THROUGH], 'user'), /make yours directly/);
  plan = applyOps(plan, [{ op: 'reject_proposal', id: 'p1', note: 'Writes are rare here.' }], 'user').plan;
  assert.equal(plan.proposals![0]!.status, 'rejected');
  assert.equal(plan.proposals![0]!.note, 'Writes are rare here.');
  assert.match(plan.changes.at(-1)!.summary, /rejected proposal p1 "Make the cache write-through": Writes are rare here\./);
  assert.equal(plan.diagrams[0]!.nodes.find((n) => n.id === 'cache')!.description, undefined);
  // Claude may take back its own.
  plan = applyOps(plan, [{ ...WRITE_THROUGH, title: 'Again' } as PlanOp], 'claude').plan;
  plan = applyOps(plan, [{ op: 'withdraw_proposal', id: 'p2' }], 'claude').plan;
  assert.equal(plan.proposals![1]!.status, 'withdrawn');
});

test('a proposal made for a plan that has since moved cannot be accepted, and says what moved', () => {
  let plan = applyOps(fresh(), [WRITE_THROUGH], 'claude').plan;
  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: 'd1', id: 'db', label: 'Primary DB' }], 'user').plan;
  assert.throws(() => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user'), /p1 is out of date: diagram "Components" changed since it was made/);
  assert.equal(plan.proposals![0]!.status, 'open', 'it can still be rejected');
});

test('a proposal that would not apply, or carries what a proposal cannot, is refused when made', () => {
  const plan = fresh();
  assert.throws(
    () => applyOps(plan, [{ op: 'propose', title: 'x', reason: 'y', ops: [{ op: 'remove_node', diagramId: 'd1', id: 'nope' }] }], 'claude'),
    /would not apply to the plan as it is/,
  );
  assert.throws(
    () => applyOps(plan, [{ op: 'propose', title: 'x', reason: 'y', ops: [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'hi' }] }], 'claude'),
    /carries edits to the plan's content .*not comment/,
  );
  assert.throws(() => applyOps(plan, [{ op: 'propose', title: 'x', reason: 'y', ops: [{ op: 'upsert_task', id: 't2', status: 'done' }] }], 'claude'), /harness_task_update/);
  assert.throws(() => applyOps(plan, [{ op: 'propose', title: 'x', reason: '', ops: [WRITE_THROUGH.ops[0]!] } as PlanOp], 'claude'), /needs a reason/);
});

test('once the design is confirmed a design proposal can be made, but accepting it needs the design reopened', () => {
  let plan = confirmDesign(fresh(), { prompt: 'tasks please' }, 2_000);
  plan = applyOps(plan, [WRITE_THROUGH], 'claude').plan;
  assert.throws(() => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user'), /design/i);
  // A task proposal fits the confirmed design.
  plan = applyOps(plan, [{ op: 'propose', title: 'Load test', reason: 'Prove it.', ops: [{ op: 'upsert_task', title: 'Load test' }] }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'accept_proposal', id: 'p2' }], 'user').plan;
  assert.ok(plan.tasks.some((t) => t.title === 'Load test'));
});

test("moving boxes, linking tasks or a task's progress does not put a proposal out of date; what it changes does", () => {
  let plan = applyOps(fresh(), [WRITE_THROUGH], 'claude').plan;
  const d = plan.diagrams[0]!;
  // The user drags every box, and links one to a task: layout and links, not the design.
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', nodes: d.nodes.map((n) => ({ ...n, x: (n.x ?? 0) + 40, y: (n.y ?? 0) + 10 })), edges: d.edges }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: 'd1', id: 'api', taskIds: ['t4'] }], 'user').plan;
  assert.equal(applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user').plan.proposals![0]!.status, 'accepted');
});

test("a proposal's `expect` checks it when made, and does not refuse the accept after a harmless move", () => {
  const rev = fresh().diagrams[0]!.rev;
  let plan = applyOps(fresh(), [{ ...WRITE_THROUGH, ops: WRITE_THROUGH.ops.map((o) => ({ ...o, expect: rev })) } as PlanOp], 'claude').plan;
  assert.ok(plan.proposals![0]!.ops.every((o) => !('expect' in o)), 'kept without it');
  const d = plan.diagrams[0]!;
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', nodes: d.nodes.map((n) => ({ ...n, x: (n.x ?? 0) + 5 })), edges: d.edges }], 'user').plan;
  assert.equal(applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user').plan.proposals![0]!.status, 'accepted');
  // A stale `expect` is caught when the proposal is made.
  assert.throws(() => applyOps(plan, [{ ...WRITE_THROUGH, ops: [{ ...WRITE_THROUGH.ops[0]!, expect: rev - 1 }] } as PlanOp], 'claude'), /would not apply/);
});

test('mid-build, an accepted proposal may add a task, never re-scope one the user signed off', () => {
  let plan = submitPlan(confirmDesign(fresh(), { prompt: 'tasks' }, 2_000), { target: 'session', prompt: 'build' }, 3_000);
  plan = applyOps(plan, [{ op: 'propose', title: 'Rescope', reason: 'Bigger.', ops: [{ op: 'upsert_task', id: 't4', title: 'Rewrite the API', branch: 'other' }] }], 'claude').plan;
  assert.throws(() => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user'), /takes only new tasks from a proposal\. Reopen the plan/);
  plan = applyOps(plan, [{ op: 'propose', title: 'Load test', reason: 'Prove it.', ops: [{ op: 'upsert_task', title: 'Load test' }] }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'accept_proposal', id: 'p2' }], 'user').plan;
  assert.ok(plan.tasks.some((t) => t.title === 'Load test'));
  assert.equal(plan.tasks.find((t) => t.id === 't4')!.title, 'Wire into API', 'the signed-off task as it was');
});

test('Claude is told the user answered a proposal, not that they edited the summary', () => {
  let plan = applyOps(fresh(), [{ op: 'propose', title: 'Load test', reason: 'Prove it.', ops: [{ op: 'upsert_task', title: 'Load test' }] }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user').plan;
  const areas = unreadAreas(plan);
  assert.ok(areas.includes('your proposals'));
  assert.ok(areas.includes('tasks'), 'and what it changed');
  assert.ok(!areas.includes('the summary'));
});

test('a proposal is held to the comment-thread limit, and an answer Claude has not heard is never trimmed away', () => {
  let plan = fresh();
  plan.threads = Array.from({ length: 500 }, (_, i) => ({ id: `c${i + 1}`, target: { kind: 'plan' as const, id: '' }, author: 'user' as const, text: 'x', ts: 1, resolved: true, replies: [] }));
  assert.throws(() => applyOps(plan, [WRITE_THROUGH], 'claude'), /at most 500 comment threads/);

  plan = applyOps(fresh(), [WRITE_THROUGH], 'claude').plan;
  plan = applyOps(plan, [{ op: 'reject_proposal', id: 'p1', note: 'No.' }], 'user').plan;
  // Fill past the limit with proposals Claude withdraws itself.
  plan.proposals!.push(...Array.from({ length: 70 }, (_, i) => ({ ...plan.proposals![0]!, id: `p${i + 2}`, status: 'withdrawn' as const, resolvedSeq: 0 })));
  plan = applyOps(plan, [{ op: 'propose', title: 'One more', reason: 'r', ops: [{ op: 'upsert_task', title: 'More' }] }], 'claude').plan;
  assert.ok(plan.proposals!.some((p) => p.id === 'p1' && p.status === 'rejected'), 'the unheard rejection is kept');
});

test("a proposal's preview says Accept is held once the design is signed off, not what it said before", () => {
  const plan = applyOps(fresh(), [WRITE_THROUGH], 'claude').plan;
  assert.equal(previewProposal(plan, plan.proposals![0]!).blocker, null);
  const confirmed = confirmDesign(plan, { prompt: 'tasks' }, 9_000);
  const after = previewProposal(confirmed, confirmed.proposals![0]!);
  assert.match(after.blocker ?? '', /design/i, 'not the cached answer from before the sign-off');
  assert.ok(after.after, 'still shown, as it would be once the design is reopened');
});

test('publishing the plan anew withdraws what was proposed for the old one, saying so', () => {
  let plan = applyOps(fresh(), [WRITE_THROUGH], 'claude').plan;
  plan = publishPlan(plan, INPUT, 5_000).plan;
  assert.equal(plan.proposals![0]!.status, 'withdrawn');
  assert.equal(plan.threads.find((t) => t.id === plan.proposals![0]!.threadId)?.replies.at(-1)?.text, 'Withdrawn: the plan was published anew.');
});

test('a proposal cannot be built on a change of the user’s that Claude has not read', () => {
  const plan = applyOps(fresh(), [{ op: 'upsert_node', diagramId: 'd1', id: 'cache', label: 'Memcached' }], 'user').plan;
  assert.throws(() => applyOps(plan, [WRITE_THROUGH], 'claude'), /The user changed .* since you last read the plan/);
  const read = structuredClone(plan);
  markReadByClaude(read);
  assert.equal(applyOps(read, [WRITE_THROUGH], 'claude').plan.proposals?.length, 1, 'read first, then propose');
});

test('proposals survive a reload; one that lost its edits does not', () => {
  const plan = applyOps(fresh(), [WRITE_THROUGH], 'claude').plan;
  const raw = JSON.parse(JSON.stringify(plan)) as Plan;
  assert.equal(normalizePlan(raw as unknown as Parameters<typeof normalizePlan>[0], 'x').proposals?.length, 1);
  (raw.proposals![0] as unknown as Record<string, unknown>)['ops'] = 'gone';
  assert.equal(normalizePlan(raw as unknown as Parameters<typeof normalizePlan>[0], 'x').proposals, undefined);
});

/* An edit of Claude's is refused when it would overwrite a change of the
 * user's it has not read: every item it changes counts, not only the one it names. */

function linkedPlan(): Plan {
  return publishPlan(null, {
    title: 'x',
    tasks: [{ id: 't1', title: 'API', subtasks: [{ id: 't2', title: 'Routes' }] }, { id: 't3', title: 'UI' }, { id: 't4', title: 'Docs' }],
    diagrams: [{ id: 'd1', title: 'Arch', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] }],
  }, 1_000).plan;
}
const UNREAD = /The user changed .* since you last read the plan, so this edit was not applied/;
const read = (plan: Plan) => {
  const next = structuredClone(plan);
  markReadByClaude(next);
  return next;
};

test("a task's builds cannot drop a box link the user just made, unread", () => {
  const plan = applyOps(linkedPlan(), [{ op: 'upsert_node', diagramId: 'd1', id: 'b', taskIds: ['t3'] }], 'user').plan;
  // Replacing t3's links with box a would take away the user's link to b.
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 't3', builds: ['a'] }], 'claude'), UNREAD);
  const after = applyOps(read(plan), [{ op: 'upsert_task', id: 't3', builds: ['a'] }], 'claude').plan;
  assert.deepEqual(after.diagrams[0]!.nodes.map((n) => [n.id, n.taskIds ?? []]), [['a', ['t3']], ['b', []]], 'read first, then relink');
});

test("removing a task cannot take a subtask, a dependency or a box link the user just changed, unread", () => {
  const cases: [string, PlanOp][] = [
    ['a subtask the user wrote on', { op: 'upsert_task', id: 't2', detail: 'Must use REST — a legal requirement' }],
    ['a dependency the user added', { op: 'upsert_task', id: 't4', dependsOn: ['t2'] }],
    ['a box the user linked', { op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t2'] }],
  ];
  for (const [what, edit] of cases) {
    const plan = applyOps(linkedPlan(), [edit], 'user').plan;
    assert.throws(() => applyOps(plan, [{ op: 'remove', kind: 'task', id: 't1' }], 'claude'), UNREAD, what);
    assert.deepEqual(applyOps(read(plan), [{ op: 'remove', kind: 'task', id: 't1' }], 'claude').plan.tasks.map((t) => t.id), ['t3', 't4'], `${what}: read first, then remove`);
  }
  // A change elsewhere does not hold it up.
  const elsewhere = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', detail: 'unrelated' }], 'user').plan;
  assert.deepEqual(applyOps(elsewhere, [{ op: 'remove', kind: 'task', id: 't1' }], 'claude').plan.tasks.map((t) => t.id), ['t3', 't4']);
});

test('the guard follows the batch: a task moved under one being removed goes with it, so it counts', () => {
  const plan = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', detail: 'the user wrote this' }], 'user').plan;
  assert.throws(
    () => applyOps(plan, [{ op: 'move_task', id: 't3', parentId: 't1', index: 0 }, { op: 'remove', kind: 'task', id: 't1' }], 'claude'),
    /Edit 2 \(remove\): The user changed task "UI" since you last read the plan.* Removing a task takes its subtasks/,
  );
});

test("builds is held to the links it would really change: an unlink undone counts, a restated link does not", () => {
  // The user unlinks t3 from b; builds naming b again (however it is spelt) would undo that.
  let plan = applyOps(linkedPlan(), [{ op: 'upsert_node', diagramId: 'd1', id: 'b', taskIds: ['t3'] }], 'user').plan;
  plan = read(plan);
  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: 'd1', id: 'b', taskIds: [] }], 'user').plan;
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 't3', builds: [' b'] }], 'claude'), /which of that diagram's boxes link it/);
  // An unrelated change in the diagram does not hold up builds that change no link there.
  let other = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', builds: ['a'] }], 'claude').plan;
  other = applyOps(other, [{ op: 'upsert_node', diagramId: 'd1', id: 'b', label: 'Renamed' }], 'user').plan;
  const after = applyOps(other, [{ op: 'upsert_task', id: 't3', title: 'UI, again', builds: ['a'] }], 'claude').plan;
  assert.equal(after.tasks.find((t) => t.id === 't3')?.title, 'UI, again');
});
