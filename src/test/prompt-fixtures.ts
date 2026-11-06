import { applyOps, confirmDesign, markReadByClaude, publishPlan } from '../shared/plan.ts';
import { parseProjectConfig, type ProjectConfig } from '../shared/project.ts';
import type { Plan, PlanInput } from '../shared/types.ts';

/**
 * Plans and configs that put every block of every prompt on the page: the
 * golden tests hold their text byte for byte, and the source tests check
 * each block says where it comes from.
 *
 * Everything here is deterministic — fixed clocks, ids from the input — so
 * the same code renders the same bytes on every run and every machine.
 */

/** Where the instructions pointer says the user's own config lives. */
export const FIXTURE_HOME = '/coplan-home';

export const FIXTURE_BIN = '/opt/coplan/bin/coplan';
export const FIXTURE_URL = 'http://127.0.0.1:4000/s/golden';

const RICH: PlanInput = {
  title: 'Add a read-through cache',
  summary: 'Put a read-through cache in front of the orders database.\n\n# Why\nReads are slow at peak.',
  sections: [
    { id: 'context', title: 'Context', body: 'p95 read latency is 900ms at peak.\n\n## Numbers\n- 40k reads/min' },
    { id: 'risks', title: 'Risks', body: 'Stale reads after a write.' },
    { id: 'empty', title: 'Open questions', body: '' },
  ],
  diagrams: [
    {
      id: 'd1',
      title: 'Components',
      caption: 'The read path.',
      nodes: [
        { id: 'api', label: 'Orders API', kind: 'service', description: 'Serves orders.', taskIds: ['wire'] },
        { id: 'cache', label: 'Redis', kind: 'datastore', detail: 'managed', description: 'Hot orders.', notes: 'Read-through, 10m TTL.', taskIds: ['client'] },
        { id: 'db', label: 'Postgres', kind: 'datastore', description: 'Source of truth.' },
        { id: 'n1', label: 'Keep it simple', kind: 'note', description: 'No write-behind.' },
      ],
      edges: [
        { source: 'api', target: 'cache', label: 'get' },
        { source: 'cache', target: 'db', label: 'miss', dashed: true },
      ],
    },
    {
      id: 'd2',
      title: 'Invalidation',
      nodes: [{ id: 'bus', label: 'Event bus', kind: 'queue', taskIds: ['inval'] }],
      edges: [],
    },
  ],
  tasks: [
    {
      id: 'storage',
      title: 'Storage layer',
      detail: 'Everything below the API.',
      subtasks: [
        { id: 'client', title: 'Cache client', detail: 'Wrap ioredis.\n\nAcceptance: get/set with TTL.', files: ['src/cache.ts'], branch: 'cache/client', status: 'done' },
        { id: 'inval', title: 'Invalidation', dependsOn: ['client'], branch: 'cache/client', review: 'user', files: ['src/cache.ts', 'src/events.ts'] },
      ],
    },
    { id: 'wire', title: 'Wire into API', detail: 'Use the client in the orders handler.', dependsOn: ['storage'], branch: 'cache/api', status: 'in_progress', note: 'halfway' },
    { id: 'docs', title: 'Document the cache', review: 'skip' },
  ],
};

/**
 * A plan Claude has read once, that the user then changed: renamed a
 * task, edited a section, commented, answered Claude — so "since you last
 * read" and the open comments are part of every prompt.
 */
export function richPlan(): Plan {
  let plan = publishPlan(null, RICH, 1_000).plan;
  plan = applyOps(
    plan,
    [
      { op: 'comment', target: { kind: 'node', id: 'd1/cache' }, text: 'Which Redis version?' },
      { op: 'propose', title: 'Split the docs task', reason: 'Two audiences.', ops: [{ op: 'upsert_task', title: 'Runbook' }] },
    ],
    'claude',
    1_100,
  ).plan;
  markReadByClaude(plan, 1_200);
  const thread = plan.threads[0]!.id;
  plan = applyOps(
    plan,
    [
      { op: 'upsert_task', id: 'docs', title: 'Document the cache in the README' },
      { op: 'upsert_section', id: 'risks', body: 'Stale reads after a write.\nA cold cache after deploys.' },
      { op: 'reply', threadId: thread, text: 'Redis 7.' },
      { op: 'comment', target: { kind: 'task', id: 'wire' }, text: 'Keep the old path behind a flag.\nRemove it next release.' },
      { op: 'comment', target: { kind: 'plan', id: '' }, text: 'Looks good overall.' },
    ],
    'user',
    1_300,
  ).plan;
  return plan;
}

/** The rich plan with its design confirmed: what the build prompt is made from. */
export function richConfirmed(): Plan {
  return confirmDesign(richPlan(), { prompt: 'p' }, 1_400);
}

/** A small plan Claude has not read yet: no branches, nothing it waits on. */
export function plainPlan(confirmed = true): Plan {
  const plan = publishPlan(
    null,
    {
      title: 'Add a cache',
      summary: 'Put a cache in front of the database.',
      sections: [{ title: 'Context', body: 'Reads are slow.' }],
      diagrams: [{ title: 'Components', nodes: [{ id: 'api', label: 'API', kind: 'service', taskIds: ['client'] }], edges: [] }],
      tasks: [{ id: 'client', title: 'Cache client', detail: 'Wrap ioredis.' }, { title: 'Wire into API' }],
    },
    1_000,
  ).plan;
  return confirmed ? confirmDesign(plan, { prompt: 'p' }, 1_400) : plan;
}

/** A plan far over the prompt budget: many boxes, many long tasks. */
export function bigPlan(): Plan {
  const long = 'A long paragraph of detail that goes on and on about the work. '.repeat(3);
  const input: PlanInput = {
    ...RICH,
    diagrams: [
      ...RICH.diagrams!,
      {
        id: 'big',
        title: 'Everything else',
        nodes: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, label: `Part ${i}`, kind: 'service', description: long })),
        edges: Array.from({ length: 19 }, (_, i) => ({ source: `p${i}`, target: `p${i + 1}` })),
      },
    ],
    tasks: [
      ...RICH.tasks!,
      ...Array.from({ length: 60 }, (_, i) => ({ id: `bulk${i}`, title: `Bulk task number ${i} with a descriptive title`, detail: long, dependsOn: i ? [`bulk${i - 1}`] : [] })),
    ],
  };
  let plan = publishPlan(null, input, 1_000).plan;
  markReadByClaude(plan, 1_200);
  plan = applyOps(
    plan,
    Array.from({ length: 40 }, (_, i) => ({ op: 'upsert_task' as const, id: `bulk${i}`, note: `user note on bulk task ${i}` })),
    'user',
    1_300,
  ).plan;
  return plan;
}

/** The rich plan with one section too long to quote: cut to fit, with
 *  room left for every task line and the build order. */
export function longPlan(): Plan {
  const plan = richConfirmed();
  plan.sections[0]!.body = 'Measured over a week of peak traffic. '.repeat(240);
  return plan;
}

const TEMPLATE = '## What\n\n## Why\n\n## Checks';

/** A repository config that sets everything a prompt can say. */
export function fullProject(longInstructions = false): ProjectConfig {
  const build = longInstructions ? `Small commits, each with a message that says why. ${'Keep the diff focused. '.repeat(90)}` : 'Small commits, each with a message that says why.';
  const project = parseProjectConfig(
    {
      hooks: {
        implement: ['pnpm typecheck', { name: 'lint', run: 'pnpm lint', paths: ['src/**'] }],
        review: [{ name: 'tests', run: 'pnpm test', env: { NODE_ENV: 'test' } }],
        final: ['pnpm check', { name: 'audit', run: 'pnpm audit', optional: true }],
      },
      iric: { review: 'subagent', parallel: 3, maxRounds: 2 },
      branches: { base: 'main', prefix: 'coplan/' },
      pullRequests: { tool: 'graphite', open: 'auto' },
      review: { model: 'opus' },
      final: { blocking: true },
      instructions: {
        design: 'Split by layer.',
        build,
        brief: 'Match the code style around you.',
        review: 'Check error handling.',
      },
    },
    null,
  );
  // A template is read from a file; here it is set as read.
  project.pullRequests.template = TEMPLATE;
  project.pullRequests.templateFile = '.github/pull_request_template.md';
  project.file = '/repo/.coplan/config.json';
  return project;
}
