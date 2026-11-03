import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, publishPlan, suggestDirection, unreadByClaude } from '../shared/plan.ts';
import { diagramChanges, diagramToMarkdown, flowOrder } from '../shared/architecture.ts';
import { renderPlan } from '../daemon/render.ts';
import type { DiagramNodeInput, Plan, PlanInput } from '../shared/types.ts';

/**
 * The translation from a diagram to words: what Claude reads about the
 * architecture, and how it learns what the user changed. Only the design
 * counts — never where boxes sit — and only where the user ended up, not
 * each step they took.
 */

const INPUT: PlanInput = {
  title: 'Orders cache',
  tasks: [{ id: 'cache-client', title: 'Cache client', status: 'in_progress' }],
  diagrams: [
    {
      title: 'Components',
      caption: 'How an order read moves through the system.',
      nodes: [
        // Written out of flow order on purpose.
        { id: 'db', label: 'Postgres', kind: 'datastore', detail: 'Primary store' },
        { id: 'cache', label: 'Redis', kind: 'datastore', detail: 'Read-through, 5 min TTL', description: 'Holds hot order reads.', notes: 'Read-through, not write-through.', taskIds: ['cache-client'] },
        { id: 'api', label: 'Orders API', kind: 'service', description: 'Owns the order lifecycle.' },
        { id: 'user', label: 'Customer', kind: 'actor' },
        { id: 'stripe', label: 'Stripe', kind: 'external' },
        { id: 'tbd', label: 'Search', kind: 'component' },
        { id: 'n1', label: 'Stale reads are fine for 5 minutes', kind: 'note' },
      ],
      edges: [
        { source: 'user', target: 'api', label: 'HTTPS' },
        { source: 'api', target: 'cache', label: 'GET order:{id}' },
        { source: 'cache', target: 'db', label: 'on miss', dashed: true },
        { source: 'api', target: 'stripe', label: 'charge', arrows: 'both' },
      ],
    },
  ],
};

const fresh = (): Plan => publishPlan(null, INPUT, 1000).plan;
const diagram = () => fresh().diagrams[0]!;

/* ------------------------------------------------------------------ *
 * The architecture, in words
 * ------------------------------------------------------------------ */

test('parts are listed in the order the flow reaches them, notes kept apart', () => {
  const { ordered, notes, isolated } = flowOrder(diagram());
  assert.deepEqual(
    ordered.map((n) => n.id),
    ['user', 'api', 'cache', 'stripe', 'db', 'tbd'],
  );
  assert.deepEqual(notes.map((n) => n.id), ['n1']);
  assert.deepEqual(isolated.map((n) => n.id), ['tbd']);
});

test('a diagram reads as an architecture: shape, parts with their story, connections', () => {
  const plan = fresh();
  const text = diagramToMarkdown(plan.diagrams[0]!, { tasks: plan.tasks });
  assert.match(text, /^### \[d1\] Components\n\nHow an order read moves through the system\./);
  assert.match(text, /Entry points: Customer\. Data stores: Redis, Postgres\. External systems: Stripe\./);
  assert.match(
    text,
    /- \*\*Redis\*\* `cache` — data store: Read-through, 5 min TTL\n  Holds hot order reads\.\n  Decisions:\n    Read-through, not write-through\.\n  Built by: \[~\] cache-client Cache client/,
  );
  assert.match(text, /- \*\*Orders API\*\* `api` — service\n  Owns the order lifecycle\./);
  assert.match(text, /_Not connected to anything yet: Search\._/);
  assert.match(text, /\*\*Connections\*\*\n- Customer → Orders API: HTTPS `user → api`/);
  assert.match(text, /- Redis → Postgres: on miss \(dashed: optional, async or future\) `cache → db`/);
  assert.match(text, /- Orders API ↔ Stripe: charge `api ↔ stripe`/);
  assert.match(text, /\*\*Notes on the diagram\*\*\n- Stale reads are fine for 5 minutes \(`n1`\)/);
});

test('the architecture never mentions where boxes sit or which way they are drawn', () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  const placed = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes.map((n, i) => ({ ...n, x: 1234 + i, y: 987 })), edges: d.edges, direction: 'TB' }], 'user').plan;
  const text = renderPlan(placed);
  assert.doesNotMatch(text, /1234|987|top to bottom|left to right/);
});

test('without ids, the same text reads as prose for people', () => {
  const text = diagramToMarkdown(diagram(), { ids: false });
  assert.match(text, /^### Components/);
  assert.match(text, /- \*\*Redis\*\* — data store/);
  assert.doesNotMatch(text, /`cache`|`api → cache`/);
});

/* ------------------------------------------------------------------ *
 * What changed: the net effect, not the steps
 * ------------------------------------------------------------------ */

/** Apply a series of canvas saves to the first diagram, as the user. */
function edit(plan: Plan, ...steps: ((nodes: DiagramNodeInput[], edges: Plan['diagrams'][number]['edges']) => void)[]): Plan {
  for (const step of steps) {
    const d = plan.diagrams[0]!;
    const nodes = structuredClone(d.nodes) as DiagramNodeInput[];
    const edges = structuredClone(d.edges);
    step(nodes, edges);
    plan = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes, edges }], 'user').plan;
  }
  return plan;
}

test('a box added and deleted again leaves nothing to report', () => {
  const plan = edit(
    fresh(),
    (nodes) => void nodes.push({ id: 'n9', label: 'New component', kind: 'component', x: 10, y: 10 }),
    (nodes) => void (nodes.find((n) => n.id === 'n9')!.label = 'Rate limiter'),
    (nodes) => void nodes.splice(nodes.findIndex((n) => n.id === 'n9'), 1),
  );
  assert.ok(unreadByClaude(plan).length > 0, 'the log saw every step');
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /they cancel out/);
  assert.doesNotMatch(text, /Rate limiter|New component/);
});

test('a box renamed several times is reported once, by its final name', () => {
  const plan = edit(
    fresh(),
    (nodes) => void (nodes.find((n) => n.id === 'cache')!.label = 'Cache'),
    (nodes) => void (nodes.find((n) => n.id === 'cache')!.label = 'Redis cluster'),
    (nodes) => void (nodes.find((n) => n.id === 'cache')!.x = 500),
  );
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /- Changed Redis cluster \(`cache`\): renamed from "Redis"\./);
  assert.equal(text.match(/renamed/g)?.length, 1);
  assert.doesNotMatch(text, /"Cache"/);
});

test('edited prose is quoted in its final form when only the changes are read', () => {
  const plan = edit(fresh(), (nodes) => {
    const cache = nodes.find((n) => n.id === 'cache')!;
    cache.description = 'Holds hot order reads.\nEvicts by LRU.';
    cache.notes = '';
  });
  const brief = renderPlan(plan, { changesOnly: true });
  assert.match(brief, /Changed Redis \(`cache`\): description edited; decisions removed\.\n  Description now:\n    Holds hot order reads\.\n    Evicts by LRU\./);
  const full = renderPlan(plan);
  assert.doesNotMatch(full.slice(0, full.indexOf('## Architecture')), /Evicts by LRU/, 'the full read does not say it twice');
});

test('connections are reported by what they join: added, removed, reversed, restyled', () => {
  const before = diagram();
  const after = structuredClone(before);
  after.edges = [
    { id: 'api->user', source: 'api', target: 'user', label: 'HTTPS' },
    { id: 'api->cache', source: 'api', target: 'cache', label: 'GET/SET', dashed: true },
    { id: 'api->stripe', source: 'api', target: 'stripe', label: 'charge' },
    { id: 'api->db', source: 'api', target: 'db', label: 'SQL' },
  ];
  assert.deepEqual(diagramChanges(before, after), [
    'Connected Orders API → Postgres: SQL.',
    'Disconnected Redis → Postgres: on miss (dashed: optional, async or future).',
    'Reversed Customer → Orders API: it now runs Orders API → Customer: HTTPS.',
    'Changed Orders API → Redis: now labelled "GET/SET"; now dashed (optional, async or future).',
    'Changed Orders API → Stripe: now one way.',
  ]);
});

test('task edits are reported as where the task ended up', () => {
  let plan = fresh();
  plan = applyOps(plan, [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't1', title: 'Load tst' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't1', title: 'Load test the cache' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'move_task', id: 't1', parentId: 'cache-client', index: 0 }], 'user').plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /\*\*Tasks\*\*\n- Added t1 "Load test the cache" under "Cache client"\./);
  assert.doesNotMatch(text, /Load tst/);
});

test('Claude\'s own edits are not reported back to it', () => {
  let plan = fresh();
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'cache-client', status: 'done' }], 'claude').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /Added t1 "Load test"/);
  assert.doesNotMatch(text, /status/);
});

/* ------------------------------------------------------------------ *
 * The model behind it
 * ------------------------------------------------------------------ */

test('a description survives an edit that leaves it out, like the notes', () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  const next = applyOps(
    plan,
    [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes.map(({ description: _d, notes: _n, ...n }) => n), edges: d.edges }],
    'claude',
  ).plan;
  const cache = next.diagrams[0]!.nodes.find((n) => n.id === 'cache')!;
  assert.equal(cache.description, 'Holds hot order reads.');
  assert.equal(cache.notes, 'Read-through, not write-through.');
});

test('arrowheads are stored only when they differ from the default', () => {
  const edges = diagram().edges;
  assert.equal(edges.find((e) => e.target === 'stripe')!.arrows, 'both');
  assert.equal('arrows' in edges.find((e) => e.target === 'api')!, false);
});

test('a long, narrow flow is drawn top to bottom; a short one left to right', () => {
  const chain = (n: number) => ({
    nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}` })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` })),
  });
  assert.equal(suggestDirection(chain(3).nodes, chain(3).edges), 'LR');
  assert.equal(suggestDirection(chain(8).nodes, chain(8).edges), 'TB');
  assert.equal(suggestDirection([{ id: 'a' }], []), 'LR');
  const published = publishPlan(null, { title: 'x', diagrams: [{ title: 'D', ...chain(8) }] }).plan;
  assert.equal(published.diagrams[0]!.direction, 'TB', 'publish picks it when Claude does not');
  const asked = publishPlan(null, { title: 'x', diagrams: [{ title: 'D', direction: 'LR', ...chain(8) }] }).plan;
  assert.equal(asked.diagrams[0]!.direction, 'LR', 'and keeps what Claude asked for');
});
