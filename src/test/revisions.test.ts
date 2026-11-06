import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOps,
  latestRevision,
  markRevisionDelivered,
  normalizePlan,
  pendingRevision,
  publishPlan,
  queueRevision,
  revisionProgress,
  revisionStatus,
  threadsForRevision,
  withdrawRevision,
} from '../shared/plan.ts';
import { REVISION_MARKER, revisionPrompt } from '../daemon/render.ts';
import type { Plan } from '../shared/types.ts';

/**
 * A request to revise the plan per the open comments (#67): which comments
 * it carries, one waiting at a time, sent once, and answered once each
 * comment has a reply or a proposal.
 */

function commented(): Plan {
  let plan = publishPlan(null, {
    title: 'Add a cache',
    sections: [{ id: 'ctx', title: 'Context', body: 'Reads are slow.' }],
    diagrams: [{ id: 'd1', title: 'Components', nodes: [{ id: 'db', label: 'Postgres', kind: 'datastore' }], edges: [] }],
    tasks: [{ id: 't1', title: 'Client' }],
  }).plan;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'node', id: 'd1/db' }, text: 'Use a replica.' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'section', id: 'ctx' }, text: 'How slow?' }], 'user').plan;
  // The agent's own question, answered by the user: waiting on the agent again.
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'task', id: 't1' }, text: 'ioredis or node-redis?' }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'reply', threadId: plan.threads.at(-1)!.id, text: 'ioredis.' }], 'user').plan;
  // Not waiting on the agent: one it answered, one resolved, and its own proposal.
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'Rename it?' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'reply', threadId: plan.threads.at(-1)!.id, text: 'Renamed.' }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'Done already.' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'resolve', threadId: plan.threads.at(-1)!.id, resolved: true }], 'user').plan;
  plan = applyOps(plan, [{ op: 'propose', title: 'Add a task', reason: 'Docs.', ops: [{ op: 'upsert_task', title: 'Docs' }] }], 'claude').plan;
  return plan;
}

test('a request carries every comment waiting on the agent, and nothing else', () => {
  const plan = commented();
  assert.deepEqual(threadsForRevision(plan).map((t) => t.text), ['Use a replica.', 'How slow?', 'ioredis or node-redis?']);
  const { prompt, threadIds, trimmed } = revisionPrompt(plan, { note: 'Small changes only.' });
  assert.ok(prompt.startsWith(`${REVISION_MARKER} "Add a cache"`));
  assert.equal(trimmed, false);
  assert.equal(threadIds.length, 3);
  assert.match(prompt, /## Open comments \(3\)/);
  assert.match(prompt, /on box "Postgres" \(d1\/db\) in diagram "Components" — user: Use a replica\./);
  assert.match(prompt, /— you: ioredis or node-redis\?\n {2}↳ user: ioredis\./);
  assert.match(prompt, /> Small changes only\./);
  assert.doesNotMatch(prompt, /Rename it|Done already|Add a task/);
  assert.doesNotMatch(prompt, /→ reply with/, 'how to reply is said once, in the steps');
});

test('one request waits at a time: queued again before it is sent, it is replaced', () => {
  const plan = commented();
  const ids = threadsForRevision(plan).map((t) => t.id);
  assert.throws(() => queueRevision(plan, { prompt: 'p', threadIds: [] }), /No comment is waiting on the agent/);
  let next = queueRevision(plan, { prompt: 'first', threadIds: ids }, 10);
  assert.equal(next.version, plan.version + 1);
  assert.equal(revisionStatus(next, pendingRevision(next)!), 'pending');
  next = queueRevision(next, { prompt: 'second', threadIds: ids, note: 'again' }, 20);
  assert.deepEqual(next.revisions!.map((r) => [r.id, r.prompt, r.note]), [['r2', 'second', 'again']]);
  // Sent, it stays as history; the next one is a new request.
  next = markRevisionDelivered(next, 30);
  assert.equal(pendingRevision(next), undefined);
  assert.equal(markRevisionDelivered(next, 40), next, 'sent once');
  next = queueRevision(next, { prompt: 'third', threadIds: ids }, 50);
  assert.deepEqual(next.revisions!.map((r) => r.id), ['r2', 'r3']);
  // Withdrawn before it is sent, it is gone; there is nothing to withdraw after.
  next = withdrawRevision(next);
  assert.deepEqual(next.revisions!.map((r) => r.id), ['r2']);
  assert.throws(() => withdrawRevision(next), /No revision request is waiting/);
  assert.equal(latestRevision(next)?.id, 'r2');
});

test('sent, a request is answered once each comment has a reply, a resolve or a proposal on what it is about', () => {
  const plan = commented();
  const [replica, slow, client] = threadsForRevision(plan).map((t) => t.id);
  let p = markRevisionDelivered(queueRevision(plan, { prompt: 'p', threadIds: [replica!, slow!, client!] }, 10), 100);
  const req = () => latestRevision(p)!;
  assert.deepEqual(revisionProgress(p, req()), { answered: 0, total: 3 });
  assert.equal(revisionStatus(p, req()), 'sent');
  // A reply from the user is not an answer.
  p = applyOps(p, [{ op: 'reply', threadId: slow!, text: 'Any news?' }], 'user', 150).plan;
  assert.equal(revisionProgress(p, req()).answered, 0);
  p = applyOps(p, [{ op: 'reply', threadId: slow!, text: 'p99 is 800 ms.' }], 'claude', 200).plan;
  p = applyOps(p, [{ op: 'resolve', threadId: client!, resolved: true }], 'claude', 210).plan;
  assert.deepEqual(revisionProgress(p, req()), { answered: 2, total: 3 });
  // A proposal on the box the comment is about answers it: the change is the user's to take.
  p = applyOps(p, [{ op: 'propose', title: 'Replica', reason: 'Asked for.', ops: [{ op: 'upsert_node', diagramId: 'd1', id: 'db', description: 'With a replica.' }] }], 'claude', 220).plan;
  assert.equal(revisionStatus(p, req()), 'answered');
});

test('requests survive a restart, and a damaged one is dropped', () => {
  const plan = queueRevision(markRevisionDelivered(queueRevision(commented(), { prompt: 'a', threadIds: ['c1'] }, 1), 2), { prompt: 'b', threadIds: ['c2'], note: 'n' }, 3);
  const raw = JSON.parse(JSON.stringify(plan)) as Plan & Record<string, unknown>;
  assert.deepEqual(normalizePlan(raw, 'x').revisions, plan.revisions);
  const damaged = { ...raw, revisions: [...plan.revisions!, { id: 'r9', at: 4, prompt: '', threadIds: [] }, { id: 'r8', at: 5, prompt: 'c', threadIds: ['c1'], deliveredAt: null }] };
  assert.deepEqual(normalizePlan(damaged as Plan & Record<string, unknown>, 'x').revisions!.map((r) => r.id), ['r1', 'r2'], 'one waiting at most');
});
