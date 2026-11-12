import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, confirmDesign, countTasks, descendants, MAX_CHANGES, markDelivered, markDesignDelivered, markReadByClaude, normalizePlan, outline, PlanError, proposalTouches, publishPlan, publishTasks, submitPlan, threadWaitsOn, unreadAreas, unreadByClaude } from '../shared/plan.ts';
import { renderPlan, unreadNotice } from '../daemon/render.ts';
import { roundVerdict } from '../shared/build.ts';
import { previewProposal } from '../shared/proposals.ts';
import type { DiagramNodeInput, Plan, PlanInput, PlanOp, Task } from '../shared/types.ts';

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

/** How many times `run` copies a plan (structuredClone). */
function countCopies(run: () => void): number {
  const real = globalThis.structuredClone;
  let n = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => (n++, real(value, options))) as typeof real;
  try {
    run();
  } finally {
    globalThis.structuredClone = real;
  }
  return n;
}

test('removals do not copy the plan, each one, to say what a comment left behind was on', () => {
  // On a big plan, a batch of them held the daemon close to a second.
  let plan = publishPlan(null, { title: 'x', tasks: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, title: id.toUpperCase() })) }, 1_000).plan;
  plan = applyOps(plan, ['a', 'b', 'c', 'd'].map((id) => ({ op: 'comment', target: { kind: 'task', id }, text: `on ${id}` })), 'user').plan;
  const removing = (ids: string[]) => () => applyOps(plan, ids.map((id) => ({ op: 'remove', kind: 'task', id })), 'user');
  assert.equal(countCopies(removing(['a', 'b', 'c', 'd'])), countCopies(removing(['a'])));
  // Each comment still says, by its title, what it was on.
  const after = applyOps(plan, ['a', 'b', 'c', 'd'].map((id) => ({ op: 'remove', kind: 'task', id })), 'user').plan;
  assert.deepEqual(after.threads.map((t) => t.text), ['A', 'B', 'C', 'D'].map((title) => `(on removed task "${title}") on ${title.toLowerCase()}`));
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

test("the user's reply to a resolved thread opens it again, for the agent to hear", () => {
  let plan = applyOps(fresh(), [{ op: 'comment', target: { kind: 'task', id: 't4' }, text: 'Which client?' }], 'user').plan;
  const id = plan.threads[0]!.id;
  plan = applyOps(plan, [{ op: 'resolve', threadId: id, resolved: true }], 'claude').plan;
  assert.equal(applyOps(plan, [{ op: 'reply', threadId: id, text: 'Done, thanks' }], 'claude').plan.threads[0]!.resolved, true, "the agent's leaves it as it is");
  plan = applyOps(plan, [{ op: 'reply', threadId: id, text: 'Not quite: the pooled one' }], 'user').plan;
  assert.equal(plan.threads[0]!.resolved, false);
  assert.equal(threadWaitsOn(plan.threads[0]!), 'claude');
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

test('a save made against a revision the item never reached says so, and is not saved', () => {
  // A tab holding a plan since replaced, or a client's mistake: nobody changed anything.
  const plan = applyOps(fresh(), [{ op: 'upsert_task', id: 't4', detail: 'Claude wrote this.' }], 'claude').plan;
  const ahead = (rev: number | undefined) => (rev ?? 1) + 5;
  const edits: [string, PlanOp, RegExp][] = [
    ['section', { op: 'upsert_section', id: 's1', body: 'stale', expect: ahead(plan.sections[0]!.rev) }, /^Section "[^"]+" is at revision \d+, not \d+: this edit was made against a version it never had/],
    ['diagram', { op: 'upsert_node', diagramId: plan.diagrams[0]!.id, id: 'db', label: 'stale', expect: ahead(plan.diagrams[0]!.rev) }, /^Diagram "[^"]+" is at revision \d+, not \d+/],
    ['diagram caption', { op: 'upsert_diagram', id: plan.diagrams[0]!.id, caption: 'stale', expect: ahead(plan.diagrams[0]!.rev) }, /^Diagram "[^"]+" is at revision \d+, not \d+/],
    ['task', { op: 'upsert_task', id: 't4', detail: 'stale', expect: ahead(plan.tasks.find((t) => t.id === 't4')!.rev) }, /^Task "Wire into API" is at revision 2, not 7/],
    // Nor one below any it can have.
    ['section at 0', { op: 'upsert_section', id: 's1', body: 'stale', expect: 0 }, /^Section "[^"]+" is at revision \d+, not 0/],
    ['task at 1.5', { op: 'upsert_task', id: 't4', detail: 'stale', expect: 1.5 }, /^Task "Wire into API" is at revision 2, not 1\.5/],
  ];
  for (const [what, op, said] of edits) {
    assert.throws(() => applyOps(plan, [op], 'user'), (err: Error) => said.test(err.message) && /latest version/.test(err.message) && !/changed by/.test(err.message), what);
  }
  // The agent is told to read the plan again.
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 't4', detail: 'stale', expect: 9 }], 'claude'), /is at revision 2, not 9: .*harness_plan_read/);
});

test("a diagram conflict names who changed it, its links included, and tells the agent to read again", () => {
  // The user links a box; Claude, having read it, removes the task: the box's links change under the canvas.
  let plan = read(applyOps(linkedPlan(), [{ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t2'] }], 'user').plan);
  const canvas = { rev: plan.diagrams[0]!.rev, nodes: structuredClone(plan.diagrams[0]!.nodes) };
  plan = applyOps(plan, [{ op: 'remove', kind: 'task', id: 't1' }], 'claude').plan;
  assert.throws(
    () => applyOps(plan, [{ op: 'upsert_diagram', id: 'd1', nodes: canvas.nodes, edges: [], expect: canvas.rev }], 'user'),
    /Diagram "Arch" was changed by Claude while this edit was open, so it was not saved\. It now shows the latest version/,
  );
  // The user adds a box; Claude's box edit, on the revision it read, is told who, and what to do.
  const read1 = linkedPlan();
  const boxed = read(applyOps(read1, [{ op: 'upsert_node', diagramId: 'd1', id: 'c', label: 'C' }], 'user').plan);
  assert.throws(
    () => applyOps(boxed, [{ op: 'upsert_node', diagramId: 'd1', id: 'a', label: 'Gateway', expect: read1.diagrams[0]!.rev }], 'claude'),
    /Diagram "Arch" was changed by the user while this edit was open, so it was not saved\. Read the plan again \(harness_plan_read\)/,
  );
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

test("the agent's progress note is not saved over by the user's note editor from before it", () => {
  const plan = fresh();
  const opened = { rev: plan.tasks.find((t) => t.id === 't4')!.rev ?? 1, note: plan.tasks.find((t) => t.id === 't4')!.note ?? '' };
  const reported = applyOps(plan, [{ op: 'upsert_task', id: 't4', status: 'blocked', note: 'Blocked: DB creds missing' }], 'claude', undefined, { tracking: true }).plan;
  const mine: PlanOp = { op: 'upsert_task', id: 't4', note: 'my older note', noteWas: opened.note, expect: opened.rev };
  assert.throws(() => applyOps(reported, [mine], 'user'), /The note of task "Wire into API" was changed while this edit was open/);
  // Made on the note as it is now, it goes in; and the task's other editors are not held up by it.
  const ok = applyOps(reported, [{ ...mine, noteWas: 'Blocked: DB creds missing' }], 'user').plan;
  assert.equal(ok.tasks.find((t) => t.id === 't4')?.note, 'my older note');
  assert.equal(applyOps(reported, [{ op: 'upsert_task', id: 't4', title: 'Wire it in', expect: opened.rev }], 'user').plan.tasks.find((t) => t.id === 't4')?.title, 'Wire it in');
});

test('`noteWas` is the note editor\'s: the agent may not send it, in an edit or in a proposal', () => {
  const plan = fresh();
  const withWas: PlanOp = { op: 'upsert_task', id: 't4', detail: 'More', noteWas: '' };
  assert.throws(() => applyOps(plan, [withWas], 'claude'), /upsert_task does not take "noteWas"/);
  assert.throws(() => applyOps(plan, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [withWas] }], 'claude'), /upsert_task does not take "noteWas"/);
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

test('a finished task taken up again, by way of dropped too, has no verdict for its round; one dropped before it was done keeps its own', () => {
  const claude = (plan: Plan, op: PlanOp) => applyOps(plan, [op], 'claude', undefined, { tracking: true }).plan;
  let plan = fresh();
  // Done in a build, at round 1, with a pass (carried into the next plan by a republish).
  Object.assign(plan.tasks.find((t) => t.id === 't2')!, { status: 'done', round: 1, reviews: [{ round: 1, by: 'claude', verdict: 'pass', summary: 'ok', at: 1 }] });
  plan = claude(plan, { op: 'upsert_task', id: 't2', status: 'dropped' });
  // A drop undone, nothing changed: still done on its pass.
  const undone = claude(plan, { op: 'upsert_task', id: 't2', status: 'done' });
  assert.equal(roundVerdict(undone.tasks.find((t) => t.id === 't2')!, 'self')?.verdict, 'pass', 'a drop undone keeps the pass');
  plan = claude(plan, { op: 'upsert_task', id: 't2', status: 'in_progress' });
  assert.equal(roundVerdict(plan.tasks.find((t) => t.id === 't2')!, 'self'), undefined, 'no pass for the work taken up again');
  // One dropped mid-review, before it was done, keeps its verdict: the changes asked for still stand.
  let midway = fresh();
  Object.assign(midway.tasks.find((t) => t.id === 't2')!, { status: 'in_progress', stage: 'review', round: 2, reviews: [{ round: 2, by: 'claude', verdict: 'changes', summary: 'Add a timeout', at: 1 }] });
  midway = claude(midway, { op: 'upsert_task', id: 't2', status: 'dropped' });
  midway = claude(midway, { op: 'upsert_task', id: 't2', status: 'in_progress' });
  assert.equal(roundVerdict(midway.tasks.find((t) => t.id === 't2')!, 'self')?.verdict, 'changes');
  // A pass given mid-review, then dropped before done and taken up again: kept, as it was never done.
  let passed = fresh();
  Object.assign(passed.tasks.find((t) => t.id === 't2')!, { status: 'in_progress', stage: 'review', round: 2, reviews: [{ round: 2, by: 'claude', verdict: 'pass', summary: 'ok', at: 1 }] });
  passed = claude(passed, { op: 'upsert_task', id: 't2', status: 'dropped' });
  passed = claude(passed, { op: 'upsert_task', id: 't2', status: 'in_progress' });
  assert.equal(roundVerdict(passed.tasks.find((t) => t.id === 't2')!, 'self')?.verdict, 'pass');
  // Done after a "changes" then a pass, dropped and taken up again: no stale "changes" left either.
  let mixed = fresh();
  Object.assign(mixed.tasks.find((t) => t.id === 't2')!, { status: 'done', round: 1, reviews: [{ round: 1, by: 'claude', verdict: 'changes', summary: 'Add a timeout', at: 1 }, { round: 1, by: 'claude', verdict: 'pass', summary: 'ok', at: 2 }] });
  mixed = claude(mixed, { op: 'upsert_task', id: 't2', status: 'dropped' });
  mixed = claude(mixed, { op: 'upsert_task', id: 't2', status: 'in_progress' });
  assert.equal(roundVerdict(mixed.tasks.find((t) => t.id === 't2')!, 'self'), undefined);
  // Known across a republish too.
  let republished = fresh();
  Object.assign(republished.tasks.find((t) => t.id === 't2')!, { status: 'done', round: 1, reviews: [{ round: 1, by: 'claude', verdict: 'pass', summary: 'ok', at: 1 }] });
  republished = claude(republished, { op: 'upsert_task', id: 't2', status: 'dropped' });
  republished = publishTasks(republished, { tasks: SAME_TASKS.tasks! }, 2_000).plan;
  assert.equal(republished.tasks.find((t) => t.id === 't2')!.wasDone, true, 'kept by a republish');
  republished = claude(republished, { op: 'upsert_task', id: 't2', status: 'in_progress' });
  assert.equal(roundVerdict(republished.tasks.find((t) => t.id === 't2')!, 'self'), undefined);
  // Known across a restart.
  let reload = fresh();
  Object.assign(reload.tasks.find((t) => t.id === 't2')!, { status: 'done', round: 1, reviews: [{ round: 1, by: 'claude', verdict: 'pass', summary: 'ok', at: 1 }] });
  reload = normalizePlan(JSON.parse(JSON.stringify(claude(reload, { op: 'upsert_task', id: 't2', status: 'dropped' }))) as Plan & Record<string, unknown>, 'x');
  reload = claude(reload, { op: 'upsert_task', id: 't2', status: 'in_progress' });
  assert.equal(roundVerdict(reload.tasks.find((t) => t.id === 't2')!, 'self'), undefined);
});

test('a task the agent puts back to todo keeps its round across a restart, as the edit kept it', () => {
  const claude = (plan: Plan, op: PlanOp) => applyOps(plan, [op], 'claude', undefined, { tracking: true }).plan;
  let plan = claude(fresh(), { op: 'upsert_task', id: 't2', status: 'in_progress' });
  for (const stage of ['review', 'implement', 'review'] as const) plan = claude(plan, { op: 'upsert_task', id: 't2', stage });
  plan = claude(plan, { op: 'upsert_task', id: 't2', status: 'todo' });
  assert.equal(plan.tasks.find((t) => t.id === 't2')?.round, 2, 'the edit keeps it');
  const reloaded = normalizePlan(JSON.parse(JSON.stringify(plan)) as Plan & Record<string, unknown>, 'x');
  assert.equal(reloaded.tasks.find((t) => t.id === 't2')?.round, 2, 'so does a restart: its next review is round 3');
});

test('a task in review with no round (an older or hand-edited plan) is in its first, so it can be reviewed', () => {
  const plan = normalizePlan({ title: 'x', sections: [], diagrams: [], threads: [], tasks: [{ id: 't1', title: 'API', status: 'in_progress', order: 0, parentId: null, stage: 'review' }, { id: 't2', title: 'UI', status: 'todo', order: 1, parentId: null }] } as unknown as Plan & Record<string, unknown>, 'x');
  assert.equal(plan.tasks.find((t) => t.id === 't1')?.round, 1);
  assert.equal(plan.tasks.find((t) => t.id === 't2')?.round, undefined, 'not one that is not in review');
  // A stage on a task not in progress (hand-edited) is dropped, as an edit drops it.
  const stale = normalizePlan({ title: 'x', sections: [], diagrams: [], threads: [], tasks: [{ id: 't1', title: 'API', status: 'todo', order: 0, parentId: null, stage: 'review', round: 3 }, { id: 't2', title: 'UI', order: 1, parentId: null, stage: 'review' }] } as unknown as Plan & Record<string, unknown>, 'x');
  assert.equal(stale.tasks[0]!.stage, undefined);
  // Its round stays: only the user putting it back starts it over (an edit by the agent keeps it, so a
  // restart may not), or its next review would meet an old round's verdict.
  assert.equal(stale.tasks[0]!.round, 3, 'its round kept');
  assert.equal(stale.tasks[1]!.stage, undefined, 'nor one with no status of its own');
  assert.equal(stale.tasks[1]!.round, undefined);
  const blocked = normalizePlan({ title: 'x', sections: [], diagrams: [], threads: [], tasks: [{ id: 't1', title: 'API', status: 'blocked', order: 0, parentId: null, stage: 'implement' }] } as unknown as Plan & Record<string, unknown>, 'x');
  assert.equal(blocked.tasks[0]!.stage, 'implement', 'a blocked one keeps its stage');
  // A status it does not know is taken as not started.
  const odd = normalizePlan({ title: 'x', sections: [], diagrams: [], threads: [], tasks: [{ id: 't1', title: 'API', status: 'bogus', order: 0, parentId: null, stage: 'review', round: 2 }] } as unknown as Plan & Record<string, unknown>, 'x');
  assert.equal(odd.tasks[0]!.status, 'todo');
  assert.equal(odd.tasks[0]!.stage, undefined);
});

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

test("an unread change of the user's is held to however many changes come after it, the log trimmed or not", () => {
  const edited = () =>
    applyOps(linkedPlan(), [
      { op: 'upsert_task', id: 't3', detail: 'Must be accessible: a legal requirement', note: 'Creds are in the vault' },
      { op: 'move_task', id: 't4', parentId: 't1', index: 1 },
    ], 'user').plan;
  const held = (plan: Plan, why: string) => {
    assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 't3', detail: 'Claude text' }], 'claude'), UNREAD, why);
    assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 't3', status: 'blocked', note: 'Blocked' }], 'claude', undefined, { tracking: true }), /changed the note of task "UI"/, why);
    assert.throws(() => applyOps(plan, [{ op: 'remove', kind: 'task', id: 't1' }], 'claude'), /moved task "Docs"/, why);
    assert.doesNotThrow(() => applyOps(plan, [{ op: 'upsert_task', id: 't2', detail: 'Its own' }], 'claude'), why);
    assert.doesNotThrow(() => applyOps(read(plan), [{ op: 'upsert_task', id: 't3', detail: 'Claude text' }], 'claude'), `${why}: once read`);
  };
  // More than the log keeps after them: the user's own, or the agent's (its progress, its comments).
  let byUser = edited();
  for (let i = 0; i < MAX_CHANGES; i++) byUser = applyOps(byUser, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: `note ${i}` }], 'user').plan;
  held(byUser, "the user's");
  let byAgent = edited();
  for (let i = 0; i < MAX_CHANGES; i++) byAgent = applyOps(byAgent, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: `note ${i}` }], 'claude').plan;
  byAgent = applyOps(byAgent, [{ op: 'upsert_task', id: 't2', status: 'in_progress' }], 'claude', undefined, { tracking: true }).plan;
  assert.ok(byAgent.changes.some((c) => c.author === 'user' && c.target.id === 't3'), 'its change is kept in the log');
  held(byAgent, "the agent's");
  // A log an earlier build trimmed: all that Claude read is compared.
  const trimmed = edited();
  trimmed.changes = [];
  const gap = applyOps(trimmed, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'later' }], 'user').plan;
  assert.ok(gap.changes[0]!.seq > gap.claudeReadSeq + 1);
  held(gap, 'trimmed');
  // So is the rest of what Claude read: the plan's title, a section, a diagram.
  const sectioned = read(applyOps(linkedPlan(), [{ op: 'upsert_section', title: 'Context', body: 'Why' }], 'claude').plan);
  const sid = sectioned.sections[0]!.id;
  const others = applyOps(sectioned, [
    { op: 'set_meta', title: 'Theirs' },
    { op: 'upsert_section', id: sid, body: 'Why, as the user has it' },
    { op: 'upsert_node', diagramId: 'd1', id: 'a', label: 'Gateway' },
  ], 'user').plan;
  others.changes = [];
  const otherGap = applyOps(others, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'later' }], 'user').plan;
  assert.ok(otherGap.changes[0]!.seq > otherGap.claudeReadSeq + 1, 'a gap');
  for (const [what, op] of [
    ['the title', { op: 'set_meta', title: 'Mine' }],
    ['a section', { op: 'upsert_section', id: sid, body: 'Claude text' }],
    ['a diagram', { op: 'upsert_node', diagramId: 'd1', id: 'a', label: 'API' }],
  ] as [string, PlanOp][]) {
    assert.throws(() => applyOps(otherGap, [op], 'claude'), UNREAD, `trimmed: ${what}`);
    assert.doesNotThrow(() => applyOps(read(otherGap), [op], 'claude'), `trimmed: ${what}, once read`);
  }
  assert.doesNotThrow(() => applyOps(otherGap, [{ op: 'upsert_task', id: 't3', detail: 'Its own' }], 'claude'), 'trimmed: what the user left alone');
});

test("the change log is bounded: the user's unread changes past four times its size go too", () => {
  const edits: PlanOp[] = Array.from({ length: MAX_CHANGES * 4 + 20 }, (_, i) => ({ op: 'upsert_task', id: 't4', detail: `take ${i}` }));
  const plan = applyOps(linkedPlan(), edits, 'user').plan;
  assert.equal(plan.changes.length, MAX_CHANGES * 4);
  assert.equal(plan.changes.at(-1)!.seq, plan.seq, 'the newest kept');
  assert.equal(plan.changes[0]!.seq, plan.seq - MAX_CHANGES * 4 + 1, 'the oldest gone');
  // What went is still held against the agent: all it read is compared.
  assert.throws(() => applyOps(plan, [{ op: 'upsert_task', id: 't4', detail: 'Claude text' }], 'claude'), UNREAD);
});

test("the agent's progress note cannot go over a note of the user's it has not read", () => {
  const report: PlanOp = { op: 'upsert_task', id: 't3', status: 'blocked', note: 'Blocked: DB creds missing' };
  const track = (plan: Plan) => applyOps(plan, [report], 'claude', undefined, { tracking: true }).plan;
  const noted = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', note: 'Creds are in the vault' }], 'user').plan;
  assert.throws(() => track(noted), /The user changed the note of task "UI" since you last read the plan/);
  assert.equal(track(read(noted)).tasks.find((t) => t.id === 't3')?.note, 'Blocked: DB creds missing', 'read first, then report');
  // Its progress alone goes through, and so does a note when what the user changed is not the note.
  assert.equal(applyOps(noted, [{ op: 'upsert_task', id: 't3', status: 'blocked' }], 'claude', undefined, { tracking: true }).plan.tasks.find((t) => t.id === 't3')?.status, 'blocked');
  const titled = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', title: 'UI, again' }], 'user').plan;
  assert.equal(track(titled).tasks.find((t) => t.id === 't3')?.note, 'Blocked: DB creds missing');
  // Nor when it says what the user wrote: nothing of theirs goes.
  const same: PlanOp = { op: 'upsert_task', id: 't3', status: 'blocked', note: 'Creds are in the vault' };
  assert.equal(applyOps(noted, [same], 'claude', undefined, { tracking: true }).plan.tasks.find((t) => t.id === 't3')?.status, 'blocked');
  // With no record of what Claude read, a note the user touched counts as changed.
  const unrecorded = structuredClone(linkedPlan());
  delete unrecorded.claudeBaseline;
  assert.throws(() => track(applyOps(unrecorded, [{ op: 'upsert_task', id: 't3', note: 'Creds are in the vault' }], 'user').plan), /changed the note of task "UI"/);
});

test('removing a task cannot take one the user just moved under it, unread', () => {
  const ids = (plan: Plan) => plan.tasks.map((t) => t.id);
  const remove: PlanOp = { op: 'remove', kind: 'task', id: 't1' };
  // The user moves UI under Routes, inside API: removing API would take it.
  const plan = applyOps(linkedPlan(), [{ op: 'move_task', id: 't3', parentId: 't2', index: 0 }], 'user').plan;
  assert.throws(() => applyOps(plan, [remove], 'claude'), /The user moved task "UI" since you last read the plan, so this edit was not applied.* Removing a task takes its subtasks/);
  assert.deepEqual(ids(applyOps(read(plan), [remove], 'claude').plan), ['t4'], 'read first, and it goes with it knowingly');
  const andMore = applyOps(plan, [{ op: 'upsert_task', id: 't4', detail: 'unrelated' }], 'user').plan;
  assert.throws(() => applyOps(andMore, [remove], 'claude'), /moved task "UI"/, 'whatever else the user changed meanwhile');
  // A move is not an edit of what moved: Claude may still edit it.
  assert.equal(applyOps(plan, [{ op: 'upsert_task', id: 't3', title: 'UI, again' }], 'claude').plan.tasks.find((t) => t.id === 't3')?.title, 'UI, again');
  // Moved back out, nothing of the user's is taken.
  const back = applyOps(plan, [{ op: 'move_task', id: 't3', parentId: null, index: 1 }], 'user').plan;
  assert.deepEqual(ids(applyOps(back, [remove], 'claude').plan), ['t3', 't4']);
  // Nor when a subtask moved out and back, or about inside what is removed: it was there when Claude read it.
  const outAndBack = applyOps(linkedPlan(), [
    { op: 'move_task', id: 't2', parentId: null, index: 0 },
    { op: 'move_task', id: 't2', parentId: 't1', index: 0 },
  ], 'user').plan;
  assert.deepEqual(ids(applyOps(outAndBack, [remove], 'claude').plan), ['t3', 't4']);
  const deeper = read(applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't5', title: 'Auth', parentId: 't1' }], 'user').plan);
  const within = applyOps(deeper, [{ op: 'move_task', id: 't2', parentId: 't5', index: 0 }], 'user').plan;
  assert.deepEqual(ids(applyOps(within, [remove], 'claude').plan), ['t3', 't4']);
});

test('the guard follows the batch: a task moved under one being removed goes with it, so it counts', () => {
  const plan = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', detail: 'the user wrote this' }], 'user').plan;
  assert.throws(
    () => applyOps(plan, [{ op: 'move_task', id: 't3', parentId: 't1', index: 0 }, { op: 'remove', kind: 'task', id: 't1' }], 'claude'),
    /Edit 2 \(remove\): The user changed task "UI" since you last read the plan.* Removing a task takes its subtasks/,
  );
});

test('a proposal is guarded as a batch is: a task its edits move under one it removes goes with it, so it counts', () => {
  const plan = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', detail: 'the user wrote this' }], 'user').plan;
  const ops: PlanOp[] = [{ op: 'move_task', id: 't3', parentId: 't1', index: 0 }, { op: 'remove', kind: 'task', id: 't1' }];
  assert.throws(() => applyOps(plan, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops }], 'claude'), /Proposed edit 2 \(remove\): The user changed task "UI" since you last read the plan/);
  assert.equal(applyOps(read(plan), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops }], 'claude').plan.proposals?.length, 1, 'read first, then propose');
  // What a proposal cannot carry is said first, as for any proposal.
  const progress: PlanOp = { op: 'upsert_task', id: 't3', detail: 'x', status: 'done' };
  assert.throws(() => applyOps(plan, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [progress] }], 'claude'), /Proposed edit 1 \(upsert_task\): .*harness_task_update/);
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

test('the unread guard does not copy the plan for each builds edit', () => {
  // Working out which links a builds would change copied the plan: on a big
  // plan, a batch of them held the daemon for half a second. Counted as
  // copies: four make no more than one edit with no builds, with nothing
  // unread or with a change of the user's elsewhere.
  const copies = (plan: Plan, ops: PlanOp[]) => countCopies(() => applyOps(plan, ops, 'claude'));
  const elsewhere = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't4', detail: 'the user wrote this' }], 'user').plan;
  const builds: PlanOp[] = ['t1', 't2', 't3', 't4'].map((id) => ({ op: 'upsert_task', id, builds: ['a'] }));
  for (const plan of [linkedPlan(), elsewhere]) assert.equal(copies(plan, builds), copies(plan, [{ op: 'upsert_task', id: 't1', title: 'API, again' }]));
});

test('handing over the build prompt is not a read of what the user did after submitting', () => {
  const proposed = applyOps(publishPlan(null, { title: 'x', tasks: [{ id: 't1', title: 'Build API' }] }, 1_000).plan, [
    { op: 'propose', title: 'Add cache', reason: 'faster', ops: [{ op: 'upsert_task', title: 'Cache' }] },
  ], 'claude').plan;
  for (const reload of [false, true]) {
    let plan = submitPlan(proposed, { target: 'session', prompt: 'build it' }, 2_000);
    // The daemon may restart between the sign-off and its delivery.
    if (reload) plan = normalizePlan(JSON.parse(JSON.stringify(plan)) as Parameters<typeof normalizePlan>[0], 'x');
    plan = applyOps(plan, [{ op: 'reject_proposal', id: 'p1', note: 'No cache: we must stay stateless' }], 'user').plan;
    plan = markDelivered(plan, 3_000);
    assert.ok(plan.submission!.deliveredAt, 'delivered');
    assert.deepEqual(unreadByClaude(plan).map((c) => c.summary), ['rejected proposal p1 "Add cache": No cache: we must stay stateless'], `reload: ${reload}`);
    assert.match(renderPlan(plan, { changesOnly: true }), /No cache: we must stay stateless/, 'the agent is shown the reason when it reads');
  }
  // A plan submitted before the sign-off's log position was recorded: by the clock.
  const legacy = submitPlan(proposed, { target: 'session', prompt: 'build it' }, 2_000);
  delete legacy.submission!.seq;
  const rejected = applyOps(legacy, [{ op: 'reject_proposal', id: 'p1', note: 'No' }], 'user', 2_500).plan;
  assert.equal(unreadByClaude(markDelivered(rejected, 3_000)).length, 1, 'a legacy submission too');
  // With nothing after the sign-off, the prompt it carried is the agent's read, as before.
  const quiet = markDelivered(submitPlan(proposed, { target: 'session', prompt: 'build it' }, 2_000), 3_000);
  assert.deepEqual(unreadByClaude(quiet), []);
  // The design's hand-over works the same way.
  const design = applyOps(confirmDesign(proposed, { prompt: 'make tasks' }, 2_000), [{ op: 'reject_proposal', id: 'p1', note: 'No' }], 'user').plan;
  assert.equal(unreadByClaude(markDesignDelivered(design, 3_000)).length, 1);
});

/* A proposal is checked on accept against everything it would change, as
 * an edit is: what the user changed since it was made makes it out of date. */

function proposing(op: PlanOp): Plan {
  return applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [op] }], 'claude').plan;
}
const accept = (plan: Plan) => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user').plan;
const STALE = /Proposal p1 is out of date/;

test("a proposal's edits are held to the revision Claude read as its own edits are", () => {
  const opened = linkedPlan().tasks.find((t) => t.id === 't3')!.rev ?? 1;
  // The user rewrote t3 after Claude's read; Claude reads again, but proposes on what it read first.
  const plan = read(applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', detail: 'Must be accessible: a legal requirement' }], 'user').plan);
  const stale: PlanOp = { op: 'upsert_task', id: 't3', detail: 'Claude text', expect: opened };
  assert.throws(() => applyOps(plan, [stale], 'claude'), /Task "UI" was changed by the user while this edit was open/);
  assert.throws(
    () => applyOps(plan, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [stale] }], 'claude'),
    /would not apply to the plan as it is: Task "UI" was changed by the user while this edit was open.*harness_plan_read/,
    'proposed, as made directly',
  );
  // Claude's own edit since is no conflict, proposed or not.
  const own = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', detail: 'Claude first' }], 'claude').plan;
  const next: PlanOp = { op: 'upsert_task', id: 't3', detail: 'Claude second', expect: opened };
  assert.doesNotThrow(() => applyOps(own, [next], 'claude'));
  const proposed = applyOps(own, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [next] }], 'claude').plan;
  assert.equal(accept(proposed).tasks.find((t) => t.id === 't3')?.detail, 'Claude second');
  // Beside an edit only the user makes (a task's checks), which the proposal is for, either side of it;
  // and several edits to one item, each on the revision that was read.
  const checks: PlanOp = { op: 'set_checks', id: 't3', skip: ['tests'] };
  for (const ops of [[next, checks], [checks, next], [next, { op: 'upsert_task', id: 't3', title: 'UI, again', expect: opened }]] as PlanOp[][]) {
    const made = applyOps(own, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops }], 'claude').plan;
    assert.equal(accept(made).tasks.find((t) => t.id === 't3')?.detail, 'Claude second', ops.map((o) => o.op).join());
  }
  const sectioned = applyOps(own, [{ op: 'upsert_section', title: 'Context', body: 'Why.' }], 'claude').plan;
  const s = sectioned.sections[0]!;
  const twice: PlanOp[] = [{ op: 'upsert_section', id: s.id, title: 'Background', expect: s.rev }, { op: 'upsert_section', id: s.id, body: 'Why, at length.', expect: s.rev }];
  assert.equal(accept(applyOps(sectioned, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: twice }], 'claude').plan).sections[0]!.body, 'Why, at length.');
  // Its edits are checked against the plan as the batch found it, not as the batch's own edits before it left it.
  const mixed = applyOps(sectioned, [{ op: 'upsert_section', id: s.id, body: 'Why, in short.', expect: s.rev }, { op: 'propose', title: 'Tidy', reason: 'simpler', ops: [{ op: 'upsert_section', id: s.id, title: 'Background', expect: s.rev }] }], 'claude').plan;
  const took = accept(mixed).sections[0]!;
  assert.deepEqual([took.title, took.body], ['Background', 'Why, in short.']);
  // A box edit made on a diagram the user has changed since is refused, proposed or not.
  const graph = linkedPlan().diagrams[0]!.rev;
  const boxed = read(applyOps(linkedPlan(), [{ op: 'upsert_node', diagramId: 'd1', id: 'c', label: 'C' }], 'user').plan);
  const relabel: PlanOp = { op: 'upsert_node', diagramId: 'd1', id: 'a', label: 'Gateway', expect: graph };
  assert.throws(() => applyOps(boxed, [relabel], 'claude'), /Diagram "Arch" was changed by the user while this edit was open/);
  assert.throws(() => applyOps(boxed, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [relabel] }], 'claude'), /would not apply.*Diagram "Arch" was changed by the user/);
});

test("a proposed task removal is out of date once the user changed what it would take", () => {
  const removal: PlanOp = { op: 'remove', kind: 'task', id: 't1' };
  const cases: [string, PlanOp][] = [
    ['a subtask they wrote on', { op: 'upsert_task', id: 't2', detail: 'Must use REST — a legal requirement' }],
    ['a subtask they added', { op: 'upsert_task', title: 'Auth', parentId: 't1' }],
    ['a dependency they added', { op: 'upsert_task', id: 't4', dependsOn: ['t2'] }],
    ['a box they linked', { op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t2'] }],
    ['a note on a subtask', { op: 'upsert_task', id: 't2', note: 'Half done: keep the router' }],
  ];
  for (const [what, edit] of cases) {
    const plan = applyOps(proposing(removal), [edit], 'user').plan;
    assert.throws(() => accept(plan), new RegExp(`${STALE.source}: what removing task t1 "API" takes`), what);
  }
  // The note on the task itself, likewise: removing it would delete the note.
  const noted = applyOps(proposing(removal), [{ op: 'upsert_task', id: 't1', note: 'Keep: the mobile app calls it' }], 'user').plan;
  assert.throws(() => accept(noted), new RegExp(`${STALE.source}: the note on task t1 "API"`));
  // A change elsewhere leaves it as it was proposed.
  const elsewhere = applyOps(proposing(removal), [{ op: 'upsert_task', id: 't3', detail: 'unrelated' }], 'user').plan;
  assert.deepEqual(accept(elsewhere).tasks.map((t) => t.id), ['t3', 't4']);
});

test('a proposed removal is out of date once the user changed what it would take of a task the proposal moves under it', () => {
  const ops: PlanOp[] = [{ op: 'move_task', id: 't3', parentId: 't1', index: 0 }, { op: 'remove', kind: 'task', id: 't1' }];
  const proposed = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops }], 'claude').plan;
  for (const [what, edit] of [
    ['a dependency on it the user added', { op: 'upsert_task', id: 't4', dependsOn: ['t3'] }],
    ['a box the user linked to it', { op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t3'] }],
  ] as [string, PlanOp][]) {
    assert.throws(() => accept(applyOps(proposed, [edit], 'user').plan), new RegExp(`${STALE.source}: what removing task t1 "API" takes`), what);
  }
  // Moved under a task the proposal adds under the one it removes, likewise.
  const viaNew: PlanOp[] = [{ op: 'upsert_task', id: 't9', title: 'Frontend', parentId: 't1' }, { op: 'move_task', id: 't3', parentId: 't9', index: 0 }, { op: 'remove', kind: 'task', id: 't1' }];
  const proposedVia = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: viaNew }], 'claude').plan;
  assert.throws(() => accept(applyOps(proposedVia, [{ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t3'] }], 'user').plan), STALE);
  assert.deepEqual(accept(proposedVia).tasks.map((t) => t.id), ['t4'], 'nothing changed since: accepted');
  // Upserted twice, the new task is placed by its first edit, as applying it is: a later parentId moves nothing.
  const twice: PlanOp[] = [viaNew[0]!, { op: 'upsert_task', id: 't9', detail: 'The screens', parentId: 't4' }, ...viaNew.slice(1)];
  const proposedTwice = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: twice }], 'claude').plan;
  assert.equal(accept(proposedTwice).tasks.some((t) => t.id === 't3'), false, 'as applied: t9, and t3 under it, go with t1');
  assert.throws(() => accept(applyOps(proposedTwice, [{ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t3'] }], 'user').plan), STALE);
  // Removed and added again, it is placed by the edit that adds it again.
  const again: PlanOp[] = [viaNew[0]!, { op: 'remove', kind: 'task', id: 't9' }, { op: 'upsert_task', id: 't9', title: 'Frontend', parentId: 't4' }, { op: 'move_task', id: 't3', parentId: 't9', index: 0 }, { op: 'remove', kind: 'task', id: 't4' }];
  const proposedAgain = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: again }], 'claude').plan;
  assert.equal(accept(proposedAgain).tasks.some((t) => t.id === 't3'), false, 'as applied: t3 goes with t4');
  assert.throws(() => accept(applyOps(proposedAgain, [{ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t3'] }], 'user').plan), STALE);
  // Its new subtasks go with it, so the proposal adding one again elsewhere places it there too: whether the
  // new task it goes with is removed itself, or goes with a task of the plan's.
  for (const [what, viaGone] of [
    ['under a new task removed', [viaNew[0]!, { op: 'upsert_task', id: 't10', title: 'Screens', parentId: 't9' }, { op: 'remove', kind: 'task', id: 't9' }, { op: 'upsert_task', id: 't10', title: 'Screens', parentId: 't4' }, { op: 'move_task', id: 't3', parentId: 't10', index: 0 }, { op: 'remove', kind: 'task', id: 't4' }]],
    ['under a task of the plan removed', [{ op: 'upsert_task', id: 't9', title: 'Frontend', parentId: 't2' }, { op: 'remove', kind: 'task', id: 't1' }, { op: 'upsert_task', id: 't9', title: 'Frontend', parentId: 't4' }, { op: 'move_task', id: 't3', parentId: 't9', index: 0 }, { op: 'remove', kind: 'task', id: 't4' }]],
  ] as [string, PlanOp[]][]) {
    const proposedGone = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: viaGone }], 'claude').plan;
    assert.equal(accept(proposedGone).tasks.some((t) => t.id === 't3'), false, `${what}: as applied, t3 goes with t4`);
    assert.throws(() => accept(applyOps(proposedGone, [{ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t3'] }], 'user').plan), STALE, what);
  }
  // A task of the plan's removed and added again is placed where the proposal adds it, as applying it is.
  for (const [what, again, moved] of [
    ['a subtask', [{ op: 'remove', kind: 'task', id: 't1' }, { op: 'upsert_task', id: 't2', title: 'Routes', parentId: 't4' }, { op: 'move_task', id: 't3', parentId: 't2', index: 0 }, { op: 'remove', kind: 'task', id: 't4' }], 't3'],
    ['a top task', [{ op: 'remove', kind: 'task', id: 't3' }, { op: 'upsert_task', id: 't3', title: 'UI', parentId: 't4' }, { op: 'move_task', id: 't2', parentId: 't3', index: 0 }, { op: 'remove', kind: 'task', id: 't4' }], 't2'],
  ] as [string, PlanOp[], string][]) {
    const proposedAgain = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: again }], 'claude').plan;
    assert.equal(accept(proposedAgain).tasks.some((t) => t.id === moved), false, `${what}: as applied, ${moved} goes with t4`);
    assert.throws(() => accept(applyOps(proposedAgain, [{ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: [moved] }], 'user').plan), STALE, what);
  }
  // Added again at the top, it is not taken by its old parent's removal: removing t1 takes t1 alone, as with t2 moved out first.
  const toTop: PlanOp[] = [{ op: 'remove', kind: 'task', id: 't2' }, { op: 'upsert_task', id: 't2', title: 'Routes' }, { op: 'remove', kind: 'task', id: 't1' }];
  const proposedTop = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: toTop }], 'claude').plan;
  assert.equal(accept(proposedTop).tasks.find((t) => t.id === 't2')?.parentId, null, 'as applied: t2 stays, at the top');
  const movedOut = applyOps(linkedPlan(), [{ op: 'move_task', id: 't2', parentId: null, index: 0 }], 'user').plan;
  assert.equal(proposalTouches(linkedPlan(), toTop)['removal:t1'], proposalTouches(movedOut, [{ op: 'remove', kind: 'task', id: 't1' }])['removal:t1']);
  // Removed twice: what the first removal takes counts as much as the second's, which sees it gone already.
  const removedTwice: PlanOp[] = [{ op: 'remove', kind: 'task', id: 't3' }, { op: 'upsert_task', id: 't3', title: 'UI' }, { op: 'remove', kind: 'task', id: 't3' }, { op: 'upsert_task', id: 't3', title: 'UI' }];
  const proposedRemovedTwice = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: removedTwice }], 'claude').plan;
  for (const [what, edits] of [
    ['a subtask added under it', [{ op: 'upsert_task', id: 'u9', title: 'Mine', parentId: 't3' }]],
    ['a task moved under it', [{ op: 'move_task', id: 't4', parentId: 't3', index: 0 }]],
  ] as [string, PlanOp[]][]) {
    const edited = applyOps(proposedRemovedTwice, edits, 'user').plan;
    assert.throws(() => accept(edited), STALE, `removed twice, ${what}`);
  }
  assert.equal(accept(proposedRemovedTwice).tasks.find((t) => t.id === 't3')?.title, 'UI', 'with nothing changed, it applies');
  // A move alone leaves the moved task's links and dependencies as they are: no reason to refuse it.
  const moved = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [ops[0]!] }], 'claude').plan;
  const linked = applyOps(moved, [{ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t3'] }], 'user').plan;
  assert.equal(accept(linked).tasks.find((t) => t.id === 't3')?.parentId, 't1');
});

test("a proposed move the user's moves since put inside itself makes the proposal out of date, not a crash", () => {
  // t3 under t2 fit when proposed; the user then moved t1 under t3, so t2 is inside t3.
  for (const [what, ops] of [
    ['a move and a removal', [{ op: 'move_task', id: 't3', parentId: 't2', index: 0 }, { op: 'remove', kind: 'task', id: 't1' }]],
    ['a move, a later edit to it, and a removal', [{ op: 'move_task', id: 't3', parentId: 't2', index: 0 }, { op: 'upsert_task', id: 't3', detail: 'Screens' }, { op: 'remove', kind: 'task', id: 't1' }]],
  ] as [string, PlanOp[]][]) {
    const proposed = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops }], 'claude').plan;
    const moved = applyOps(proposed, [{ op: 'move_task', id: 't1', parentId: 't3', index: 0 }], 'user').plan;
    assert.doesNotThrow(() => renderPlan(moved), what);
    assert.doesNotThrow(() => previewProposal(moved, moved.proposals![0]!), what);
    assert.throws(() => accept(moved), new RegExp(`${STALE.source}: where task t3 "UI" goes \\(the task it goes under is now inside it\\)`), what);
  }
  // A circle of parents, which no path should build, ends the walk under a task rather than the stack.
  const circle = { tasks: [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }] as Task[] };
  assert.deepEqual(descendants(circle, 'a').map((t) => t.id), ['b']);
});

test("a proposed move to a task the user since removed or closed is out of date, not a raw error on accept", () => {
  const proposed = applyOps(linkedPlan(), [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [{ op: 'move_task', id: 't3', parentId: 't2', index: 0 }] }], 'claude').plan;
  for (const [what, edit, why] of [
    ['removed', { op: 'remove', kind: 'task', id: 't2' }, 'is gone'],
    ['done', { op: 'upsert_task', id: 't2', status: 'done' }, 'takes no subtasks now'],
  ] as [string, PlanOp, string][]) {
    const edited = applyOps(proposed, [edit], 'user').plan;
    assert.throws(() => accept(edited), new RegExp(`${STALE.source}: where task t3 "UI" goes \\(the task it goes under ${why}\\)`), what);
    // A new task the proposal adds under it, likewise.
    const adding = applyOps(linkedPlan(), [{ op: 'propose', title: 'More', reason: 'needed', ops: [{ op: 'upsert_task', id: 'n1', title: 'Paging', parentId: 't2' }] }], 'claude').plan;
    assert.throws(() => accept(applyOps(adding, [edit], 'user').plan), new RegExp(`${STALE.source}: where task n1 goes \\(the task it goes under ${why}\\)`), `adding, ${what}`);
  }
  assert.equal(accept(proposed).tasks.find((t) => t.id === 't3')?.parentId, 't2', 'unchanged, it applies');
  // Closed, with subtasks the proposal moves out first: it takes none by the time the move applies.
  const closed = applyOps(linkedPlan(), [{ op: 'upsert_task', id: 'c1', title: 'Spare', parentId: 't1' }, { op: 'upsert_task', id: 't1', status: 'done' }], 'user').plan;
  const outFirst = applyOps(closed, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [{ op: 'move_task', id: 't2', parentId: null, index: 0 }, { op: 'move_task', id: 't3', parentId: 't1', index: 0 }] }], 'claude').plan;
  assert.throws(() => accept(applyOps(outFirst, [{ op: 'remove', kind: 'task', id: 'c1' }], 'user').plan), new RegExp(`${STALE.source}: where task t3 "UI" goes \\(the task it goes under takes no subtasks now\\)`), 'by the outline');
});

test("a proposed builds is out of date once the user relinked that task's boxes", () => {
  const relink: PlanOp = { op: 'upsert_task', id: 't3', builds: ['a'] };
  const plan = applyOps(proposing(relink), [{ op: 'upsert_node', diagramId: 'd1', id: 'b', taskIds: ['t3'] }], 'user').plan;
  assert.throws(() => accept(plan), new RegExp(`${STALE.source}: the boxes task t3 "UI" builds`));
  const elsewhere = applyOps(proposing(relink), [{ op: 'upsert_node', diagramId: 'd1', id: 'b', label: 'Renamed' }], 'user').plan;
  assert.deepEqual(accept(elsewhere).diagrams[0]!.nodes.find((n) => n.id === 'a')?.taskIds, ['t3']);
});

test("a proposed note is out of date once the user rewrote that task's note", () => {
  const noted: PlanOp = { op: 'upsert_task', id: 't3', note: 'Claude note' };
  const plan = applyOps(proposing(noted), [{ op: 'upsert_task', id: 't3', note: 'User note' }], 'user').plan;
  assert.throws(() => accept(plan), new RegExp(`${STALE.source}: the note on task t3 "UI"`));
  // A task gone is named once, not again for its note: with none,
  const gone0 = applyOps(proposing(noted), [{ op: 'remove', kind: 'task', id: 't3' }], 'user').plan;
  assert.throws(() => accept(gone0), new RegExp(`${STALE.source}: task t3 changed since`));
  // and with one (its print changed too).
  const withNote = read(applyOps(linkedPlan(), [{ op: 'upsert_task', id: 't3', note: 'User note' }], 'user').plan);
  const proposedOnNote = applyOps(withNote, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [noted] }], 'claude').plan;
  const gone = applyOps(proposedOnNote, [{ op: 'remove', kind: 'task', id: 't3' }], 'user').plan;
  assert.throws(() => accept(gone), (err: Error) => new RegExp(`${STALE.source}: task t3 changed since`).test(err.message) && !/the note on/.test(err.message));
  // A proposal that leaves the note alone is not held up by it.
  const titled = applyOps(proposing({ op: 'upsert_task', id: 't3', title: 'Screens' }), [{ op: 'upsert_task', id: 't3', note: 'User note' }], 'user').plan;
  assert.equal(accept(titled).tasks.find((t) => t.id === 't3')?.note, 'User note');
});

test('a proposal that would overwrite box links is out of date once the user linked them since; an order alone is no change', () => {
  // Box a's tasks set anew, and box b removed: both would undo a link the user made after.
  for (const [what, op, edit] of [
    ["box a's tasks", { op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t3'] }, { op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t1'] }],
    ['box b, removed', { op: 'remove_node', diagramId: 'd1', id: 'b' }, { op: 'upsert_node', diagramId: 'd1', id: 'b', taskIds: ['t4'] }],
  ] as [string, PlanOp, PlanOp][]) {
    const plan = applyOps(proposing(op), [edit], 'user').plan;
    assert.throws(() => accept(plan), /Proposal p1 is out of date: the tasks linked to box "[AB]" in diagram "Arch"/, what);
  }
  // So would the whole diagram, removed with them.
  const gone = applyOps(proposing({ op: 'remove', kind: 'diagram', id: 'd1' }), [{ op: 'upsert_node', diagramId: 'd1', id: 'b', taskIds: ['t4'] }], 'user').plan;
  assert.throws(() => accept(gone), /Proposal p1 is out of date: the task links in diagram "Arch"/);
  // A link made in another diagram leaves it as proposed.
  let other = applyOps(linkedPlan(), [{ op: 'upsert_diagram', title: 'Data', nodes: [{ id: 'x', label: 'X' }], edges: [] }], 'claude').plan;
  const data = other.diagrams[1]!.id;
  other = applyOps(other, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [{ op: 'remove', kind: 'diagram', id: 'd1' }] }], 'claude').plan;
  other = applyOps(other, [{ op: 'upsert_node', diagramId: data, id: 'x', taskIds: ['t4'] }], 'user').plan;
  assert.deepEqual(accept(other).diagrams.map((d) => d.id), [data]);
  // A link somewhere else in the diagram does not hold up a proposal about box a.
  const elsewhere = applyOps(proposing({ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t3'] }), [{ op: 'upsert_node', diagramId: 'd1', id: 'b', taskIds: ['t4'] }], 'user').plan;
  assert.deepEqual(accept(elsewhere).diagrams[0]!.nodes.find((n) => n.id === 'a')?.taskIds, ['t3']);
  // Diagrams reordered, with the task linked in both: its builds still fits.
  let two = publishPlan(linkedPlan(), { title: 'x', tasks: [{ id: 't3', title: 'UI' }], diagrams: [
    { id: 'd1', title: 'Arch', nodes: [{ id: 'a', label: 'A', taskIds: ['t3'] }], edges: [] },
    { id: 'd2', title: 'Data', nodes: [{ id: 'x', label: 'X', taskIds: ['t3'] }], edges: [] },
  ] }, 2_000).plan;
  two = applyOps(two, [{ op: 'propose', title: 'Tidy', reason: 'simpler', ops: [{ op: 'upsert_task', id: 't3', builds: ['d2/x'] }] }], 'claude').plan;
  two = applyOps(two, [{ op: 'move_diagram', id: 'd2', index: 0 }], 'user').plan;
  assert.deepEqual(accept(two).diagrams.map((d) => [d.id, d.nodes[0]!.taskIds ?? []]), [['d2', ['t3']], ['d1', []]]);
});

test('a proposed removal over an edit of the task itself says so once; one made by an older Coplan is out of date', () => {
  const plan = applyOps(proposing({ op: 'remove', kind: 'task', id: 't1' }), [{ op: 'upsert_task', id: 't1', detail: 'mine' }], 'user').plan;
  assert.throws(() => accept(plan), /out of date: task t1 "API" changed since it was made/);
  // Made before the footprint was recorded: it cannot be checked in full.
  const old = proposing({ op: 'remove', kind: 'task', id: 't1' });
  delete (old.proposals![0]!.base as Record<string, unknown>)['removal:t1'];
  assert.throws(() => accept(old), /out of date: everything it would change \(it was made before Coplan recorded that\)/);
});

/* A task already started or finished cannot become a parent, however the
 * subtask would get under it: its progress (stage, rounds, checks) would go. */

test('no task is moved, or published, under a task already started or finished', () => {
  const base = applyOps(publishPlan(null, { title: 'x', tasks: [{ id: 't1', title: 'Auth' }, { id: 't2', title: 'Tokens' }, { id: 't3', title: 'UI' }] }, 1_000).plan, [{ op: 'upsert_task', id: 't1', status: 'done' }], 'user').plan;
  assert.throws(() => applyOps(base, [{ op: 'move_task', id: 't2', parentId: 't1', index: 0 }], 'user'), /"Auth" is already done, so it cannot take subtasks: move "Tokens" beside it/);
  assert.equal(countTasks(base).done, 1, 'the finished work still counts');
  // Dropped work is not worth depending on: no such advice for it.
  const dropped = applyOps(base, [{ op: 'upsert_task', id: 't3', status: 'dropped', note: 'not needed' }], 'user').plan;
  assert.throws(() => applyOps(dropped, [{ op: 'upsert_task', parentId: 't3', title: 'More' }], 'user'), (err: Error) => /already dropped/.test(err.message) && !/depending on/.test(err.message));
  // Under a task not started yet, a move is fine.
  assert.equal(applyOps(base, [{ op: 'move_task', id: 't2', parentId: 't3', index: 0 }], 'user').plan.tasks.find((t) => t.id === 't2')?.parentId, 't3');
  // A republish that nests new work under it is refused the same way.
  assert.throws(
    () => publishPlan(read(base), { title: 'x', tasks: [{ id: 't1', title: 'Auth', subtasks: [{ title: 'Refresh' }] }, { id: 't2', title: 'Tokens' }, { id: 't3', title: 'UI' }] }, 2_000),
    /"Auth" is already done, so it cannot take subtasks: list the work beside t1 instead, giving any new task an id of its own, depending on t1 if it builds on it\./,
  );
});

test("a republish that drops a task the user linked to a box drops the link, not the publish", () => {
  const input = (tasks: PlanInput['tasks'], nodes: DiagramNodeInput[] = [{ id: 'a', label: 'A' }]) => ({ title: 'x', tasks, diagrams: [{ id: 'd1', title: 'Arch', nodes, edges: [] }] });
  let plan = publishPlan(null, input([{ id: 't1', title: 'one' }, { id: 't2', title: 'two' }]), 1_000).plan;
  plan = read(applyOps(plan, [{ op: 'upsert_node', diagramId: 'd1', id: 'a', taskIds: ['t1', 't2'] }], 'user').plan);
  // The agent read it, and republishes without t2: the box keeps only what is still in the plan.
  const after = publishPlan(plan, input([{ id: 't1', title: 'one' }]), 2_000).plan;
  assert.deepEqual(after.diagrams[0]!.nodes[0]!.taskIds, ['t1']);
  assert.ok(after.diagrams[0]!.rev > plan.diagrams[0]!.rev, 'a new revision, so an open canvas reloads rather than saving the old links back');
  // A link it writes itself to a task that is not there is still a mistake to report.
  assert.throws(() => publishPlan(plan, input([{ id: 't1', title: 'one' }], [{ id: 'a', label: 'A', taskIds: ['t9'] }]), 2_000), /node "a" links task "t9", which is not in the plan/);
});

test("a save of a diagram's graph is refused for a graph changed since it was based, not for a title or caption", () => {
  let plan = fresh();
  const d = () => plan.diagrams[0]!;
  const id = d().id;
  const base = d().rev;
  const moved = (x: number): PlanOp => ({ op: 'upsert_diagram', id, nodes: d().nodes.map((n) => (n.id === 'api' ? { ...n, x, y: 40 } : n)), edges: d().edges, expect: base });
  // The user renames the diagram while a box is being dragged: the drag's save still lands.
  plan = applyOps(plan, [{ op: 'upsert_diagram', id, title: 'Renamed', caption: 'Meanwhile' }], 'claude').plan;
  plan = applyOps(plan, [moved(120)], 'user').plan;
  assert.deepEqual([d().title, d().caption, d().nodes.find((n) => n.id === 'api')?.x], ['Renamed', 'Meanwhile', 120]);
  // Boxes Claude moved since are a conflict, as is a title edited against a stale revision.
  const graphBase = d().rev;
  plan = applyOps(plan, [{ op: 'upsert_diagram', id, nodes: d().nodes.map((n) => (n.id === 'db' ? { ...n, x: 300, y: 80 } : n)), edges: d().edges }], 'claude').plan;
  assert.throws(() => applyOps(plan, [{ op: 'upsert_diagram', id, nodes: d().nodes, edges: d().edges, expect: graphBase }], 'user'), PlanError);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_diagram', id, title: 'Again', expect: graphBase }], 'user'), PlanError);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_node', diagramId: id, id: 'api', label: 'API 2', expect: graphBase }], 'user'), PlanError, 'a box edit too');
});

/** INPUT with the ids its tasks were published under: a republish of it
 *  changes only what a test changes. */
const SAME_TASKS: PlanInput = {
  ...INPUT,
  tasks: [
    { id: 't1', title: 'Storage layer', subtasks: [{ id: 't2', title: 'Cache client' }, { id: 't3', title: 'Invalidation', status: 'blocked' }] },
    { id: 't4', title: 'Wire into API' },
  ],
};
/** A canvas save of d1's boxes, made against revision `expect`. */
const graphSave = (plan: Plan, nodes: DiagramNodeInput[], expect: number): PlanOp => ({ op: 'upsert_diagram', id: 'd1', nodes, edges: plan.diagrams[0]!.edges, expect });
/** A save refused for a change made since its base. */
const CHANGED = /was changed by Claude while this edit was open/;

test("a canvas save is refused for a graph Claude republished since it was based, and not for a republish that left the graph alone", () => {
  let plan = fresh();
  const d = () => plan.diagrams[0]!;
  const dragged = (keep = (_: string) => true) => d().nodes.filter((n) => keep(n.id)).map((n) => (n.id === 'api' ? { ...n, x: 10, y: 10 } : n));
  // Republished with the same boxes and a new title: a drag based before it still lands.
  let base = d().rev;
  const graphRev = d().graphRev;
  plan = publishPlan(plan, { ...SAME_TASKS, diagrams: [{ ...INPUT.diagrams![0]!, id: 'd1', title: 'Parts' }] }, 2_000).plan;
  assert.ok(d().rev > base, 'the diagram moved on');
  assert.equal(d().graphRev, graphRev, 'its graph did not');
  plan = applyOps(plan, [graphSave(plan, dragged(), base)], 'user').plan;
  assert.deepEqual([d().title, d().nodes.find((n) => n.id === 'api')?.x], ['Parts', 10], 'the drag landed, and the title stayed');
  // Republished with a box added: a drag based before it would drop the box.
  base = d().rev;
  const withQueue = { ...INPUT.diagrams![0]!, id: 'd1', nodes: [...d().nodes, { id: 'queue', label: 'Queue', kind: 'queue' as const }] };
  plan = publishPlan(plan, { ...SAME_TASKS, diagrams: [withQueue] }, 3_000).plan;
  assert.throws(() => applyOps(plan, [graphSave(plan, dragged((id) => id !== 'queue'), base)], 'user'), CHANGED);
});

test('a republish keeps a kept task\'s review history with its round, and a blocked task\'s stage', () => {
  const plan = fresh();
  const t4 = plan.tasks.find((t) => t.id === 't4')!;
  Object.assign(t4, { status: 'blocked', stage: 'review', round: 2, reviews: [{ round: 1, by: 'user', verdict: 'changes', summary: 'Add a timeout', at: 1_000 }] });
  const next = publishTasks(plan, { tasks: SAME_TASKS.tasks! }, 2_000).plan;
  const kept = next.tasks.find((t) => t.id === 't4')!;
  assert.deepEqual(kept.reviews, t4.reviews, 'its review history');
  assert.equal(kept.round, 2);
  assert.equal(kept.stage, 'review', 'its stage, blocked in it');
});

test("a canvas save is refused for links Claude's task list changed since it was based", () => {
  let plan = fresh();
  const base = plan.diagrams[0]!.rev;
  const before = structuredClone(plan.diagrams[0]!.nodes);
  // The task list says t4 builds the API: the API box's links change under the canvas.
  plan = publishTasks(plan, { tasks: SAME_TASKS.tasks!.map((t) => (t.id === 't4' ? { ...t, builds: ['api'] } : t)) }, 2_000).plan;
  assert.deepEqual(plan.diagrams[0]!.nodes.find((n) => n.id === 'api')?.taskIds, ['t4']);
  assert.throws(() => applyOps(plan, [graphSave(plan, before, base)], 'user'), CHANGED, 'it would unlink t4');
});

test('a save against a revision the diagram has not reached is refused', () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  // Refused as stale today, in words that blame a change nobody made (row B34).
  assert.throws(() => applyOps(plan, [graphSave(plan, d.nodes, d.rev + 5)], 'user'), PlanError);
  assert.throws(() => applyOps(plan, [{ op: 'upsert_node', diagramId: 'd1', id: 'api', label: 'API 2', expect: d.rev + 5 }], 'user'), PlanError);
});

test("a proposal that restates a diagram's boxes is out of date once the user links a task to one", () => {
  let plan = fresh();
  const d = plan.diagrams[0]!;
  const restated = d.nodes.map((n) => (n.id === 'cache' ? { ...n, label: 'Redis' } : n));
  plan = applyOps(plan, [{ op: 'propose', title: 'Name the cache', reason: 'It is Redis.', ops: [{ op: 'upsert_diagram', id: 'd1', nodes: restated, edges: d.edges }] }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'upsert_node', diagramId: 'd1', id: 'api', taskIds: ['t4'] }], 'user').plan;
  // Accepting would put back the boxes as restated, without that link.
  assert.throws(() => applyOps(plan, [{ op: 'accept_proposal', id: 'p1' }], 'user'), /p1 is out of date: the task links in diagram "Components"/);
});
