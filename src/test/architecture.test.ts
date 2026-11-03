import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, baselineOf, markReadByClaude, normalizePlan, publishPlan, sameContent, suggestDirection, unreadAreas, unreadByClaude } from '../shared/plan.ts';
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

/* ------------------------------------------------------------------ *
 * Review fixes: each of these was reported wrongly, or not at all
 * ------------------------------------------------------------------ */

const parallel = (): Plan =>
  publishPlan(null, {
    title: 'P',
    diagrams: [
      {
        title: 'D',
        nodes: [
          { id: 'api', label: 'API', kind: 'service' },
          { id: 'db', label: 'DB', kind: 'datastore' },
        ],
        edges: [
          { source: 'api', target: 'db', label: 'reads' },
          { source: 'api', target: 'db', label: 'writes' },
        ],
      },
    ],
  }).plan;

test('removing one of two arrows between the same boxes is a change, and reaches Claude', () => {
  const plan = parallel();
  const d = plan.diagrams[0]!;
  const { plan: next, changes } = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes, edges: d.edges.filter((e) => e.label !== 'writes'), expect: d.rev }], 'user');
  assert.equal(changes.length, 1, 'logged');
  assert.equal(next.diagrams[0]!.rev, d.rev + 1, 'and the revision moved, so a stale tab cannot save it back');
  assert.match(renderPlan(next, { changesOnly: true }), /- Disconnected API → DB: writes\./);
  assert.doesNotMatch(renderPlan(next, { changesOnly: true }), /reads/, 'the other arrow is untouched');
});

test('restyling one of two parallel arrows names that arrow', () => {
  const plan = parallel();
  const d = plan.diagrams[0]!;
  const edges = d.edges.map((e) => (e.label === 'writes' ? { ...e, dashed: true } : e));
  const next = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes, edges }], 'user').plan;
  assert.match(renderPlan(next, { changesOnly: true }), /- Changed API → DB: now dashed/);
});

test('two parallel arrows reversed are two reversals, not a reversal twice and a new arrow', () => {
  const before = parallel().diagrams[0]!;
  const after = structuredClone(before);
  after.edges = after.edges.map((e) => ({ ...e, source: e.target, target: e.source }));
  const lines = diagramChanges(before, after);
  assert.equal(lines.filter((l) => l.startsWith('Reversed')).length, 2);
  assert.equal(lines.filter((l) => l.startsWith('Connected')).length, 0);
  assert.ok(lines.some((l) => /now runs DB → API: reads/.test(l)) && lines.some((l) => /now runs DB → API: writes/.test(l)));
});

test("Claude's edits made while the user's are unread are not reported as the user's", () => {
  let plan = fresh();
  plan = applyOps(plan, [{ op: 'upsert_task', id: 'cache-client', title: 'Cache client (Redis)' }], 'user').plan;
  plan = applyOps(
    plan,
    [
      { op: 'upsert_task', id: 'cache-client', status: 'done' },
      { op: 'set_meta', title: 'Renamed by Claude' },
      { op: 'upsert_section', title: 'Claude adds a section', body: 'x' },
    ],
    'claude',
  ).plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /Changed cache-client "Cache client \(Redis\)": renamed from "Cache client"\./, 'the user\'s rename is still news');
  assert.doesNotMatch(text, /status/, 'Claude set the status itself');
  assert.doesNotMatch(text, /Renamed the plan|Claude adds a section/);
});

test("Claude's edits to a diagram the user also changed are folded in, the user's are not", () => {
  let plan = fresh();
  const d = () => plan.diagrams[0]!;
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: d().id, nodes: d().nodes.map((n) => (n.id === 'db' ? { ...n, label: 'Postgres 16' } : n)), edges: d().edges }], 'user').plan;
  plan = applyOps(
    plan,
    [{ op: 'upsert_diagram', id: d().id, nodes: [...d().nodes, { id: 'q', label: 'Queue', kind: 'queue' }], edges: [...d().edges, { source: 'api', target: 'q', label: 'enqueue' }] }],
    'claude',
  ).plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /Changed Postgres 16 \(`db`\): renamed from "Postgres"\./);
  assert.doesNotMatch(text, /Queue|enqueue/, 'Claude added those');
});

test('reordering diagrams is reported, not called a no-op', () => {
  let plan = publishPlan(null, { title: 'P', diagrams: [{ title: 'First', nodes: [] }, { title: 'Second', nodes: [] }] }).plan;
  plan = applyOps(plan, [{ op: 'move_diagram', id: plan.diagrams[1]!.id, index: 0 }], 'user').plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /Reordered the diagrams: "Second", "First"\./);
  assert.doesNotMatch(text, /cancel out/);
});

test('a damaged baseline is dropped on load, and the read falls back to the log', () => {
  let plan = applyOps(fresh(), [{ op: 'upsert_task', title: 'Load test' }], 'user').plan;
  const raw = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  raw['claudeBaseline'] = { title: 'P', summary: '' }; // no sections, diagrams or tasks
  plan = normalizePlan(raw as Plan & Record<string, unknown>, 'x');
  assert.equal(plan.claudeBaseline, undefined);
  assert.match(renderPlan(plan), /added task "Load test"/);
});

test('renaming the plan is "the plan\'s title", not "the summary"', () => {
  const renamed = applyOps(fresh(), [{ op: 'set_meta', title: 'Better name' }], 'user').plan;
  assert.deepEqual(unreadAreas(renamed), ["the plan's title"]);
  const summarised = applyOps(fresh(), [{ op: 'set_meta', summary: 'New summary' }], 'user').plan;
  assert.deepEqual(unreadAreas(summarised), ['the summary']);
});

test('an arrow keeps the label and style the user gave it when Claude rewires around it', () => {
  let plan = fresh();
  const d = () => plan.diagrams[0]!;
  const styled = d().edges.map((e) => (e.target === 'cache' ? { ...e, arrows: 'both', dashed: true } : e));
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: d().id, nodes: d().nodes, edges: styled }], 'user').plan;
  plan = publishPlanAfterRead(plan);
  // Claude rewrites the edges from the read, without restating their style.
  const bare = d().edges.map(({ source, target }) => ({ source, target }));
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: d().id, edges: bare }], 'claude').plan;
  const cache = d().edges.find((e) => e.target === 'cache')!;
  assert.equal(cache.arrows, 'both');
  assert.equal(cache.dashed, true);
  assert.equal(cache.label, 'GET order:{id}');
  // Saying it is how to change it.
  plan = applyOps(plan, [{ op: 'upsert_diagram', id: d().id, edges: d().edges.map((e) => ({ ...e, label: '', arrows: 'end', dashed: false })) }], 'user').plan;
  const cleared = d().edges.find((e) => e.target === 'cache')!;
  assert.deepEqual([cleared.label, cleared.arrows, cleared.dashed], [undefined, undefined, undefined]);
});

/** Claude reads (catching up), as the daemon does after a read. */
function publishPlanAfterRead(plan: Plan): Plan {
  const next = structuredClone(plan);
  markReadByClaude(next);
  return next;
}

test('a layout save moves the version but logs nothing', () => {
  const plan = fresh();
  const d = plan.diagrams[0]!;
  const next = applyOps(plan, [{ op: 'upsert_diagram', id: d.id, nodes: d.nodes.map((n) => ({ ...n, x: 5, y: 5 })), edges: d.edges }], 'user').plan;
  assert.equal(next.seq, plan.seq);
  assert.equal(next.version, plan.version + 1);
});

/* ------------------------------------------------------------------ *
 * Second review: folding Claude's edits must not disturb the user's
 * ------------------------------------------------------------------ */

const sections = (): Plan =>
  publishPlan(null, { title: 'P', sections: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }], tasks: [{ title: 'T', note: 'n' }] }).plan;

test('edits that cancel out still say so after Claude has edited around them', () => {
  let plan = sections();
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't1', title: 'T2' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_task', id: 't1', title: 'T' }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_section', title: 'C', body: 'c', index: 0 }, { op: 'upsert_task', id: 't1', detail: 'd' }], 'claude').plan;
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /they cancel out/);
  assert.doesNotMatch(text, /edited the title/, 'not the step-by-step log');
});

test("a section Claude inserts goes where Claude put it, and the user's reorder is still reported", () => {
  let plan = sections();
  plan = applyOps(plan, [{ op: 'move_section', id: 's2', index: 0 }], 'user').plan;
  plan = applyOps(plan, [{ op: 'upsert_section', title: 'C', body: 'c', index: 0 }], 'claude').plan;
  assert.deepEqual(plan.claudeBaseline!.sections.map((s) => s.title), ['C', 'A', 'B'], 'C first, A and B as Claude last read them');
  const text = renderPlan(plan, { changesOnly: true });
  assert.match(text, /Reordered the sections: "C", "B", "A"\./);
  assert.doesNotMatch(text, /Added \[s3\]/, 'Claude added that one');
});

test('content is compared without regard to field order or the order arrows are listed in', () => {
  const plan = parallel();
  const a = baselineOf(plan);
  const b = structuredClone(a);
  b.diagrams[0]!.edges.reverse();
  b.tasks = b.tasks.map((t) => Object.fromEntries(Object.entries(t).reverse()) as typeof t);
  assert.ok(sameContent(a, b));
  b.diagrams[0]!.edges[0]!.label = 'other';
  assert.ok(!sameContent(a, b));
});
