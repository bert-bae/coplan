import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, countTasks, markReadByClaude, normalizePlan, outline, PlanError, publishPlan, unreadByClaude } from '../shared/plan.ts';
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
  assert.throws(() => applyOps(fresh(), [{ op: 'remove', kind: 'node' as never, id: 'cache' }], 'claude'), /upsert_diagram \{id, nodes, edges\}/);
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
  assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_task', id: 't4', status: 'in_progress', note: 'started' }], 'claude'));
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
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't4', status: 'in_progress', note: 'started' }], 'claude').plan;
  assert.equal(plan.tasks.find((t) => t.id === 't4')!.rev, rev, 'a status report does not move the revision');
});

test("Claude republishing a task with new content moves its revision; unchanged tasks keep theirs", () => {
  const plan = publishPlan(null, { ...INPUT, tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }).plan;
  const next = publishPlan(plan, { ...INPUT, tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', detail: 'New.' }] }).plan;
  assert.equal(next.tasks.find((t) => t.id === 'a')!.rev ?? 1, 1);
  assert.equal(next.tasks.find((t) => t.id === 'b')!.rev, 2);
  assert.throws(() => applyOps(next, [{ op: 'upsert_task', id: 'b', title: 'B!', expect: 1 }], 'user'), /changed by Claude/);
});
