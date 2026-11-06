// The demo sessions behind the README's screenshots: four plans at
// different stages, in four throwaway repositories. It talks to a running
// daemon exactly as the hooks and the MCP server do, so what the page shows
// is what a real session would produce.
//
// Used by scripts/demo/screenshots.mjs; not part of the plugin.
import path from 'node:path';

/**
 * Seed the daemon whose lock is `lock` with the demo sessions. `repos` holds
 * the git repositories named below (orders-service, web-dashboard,
 * billing-api, public-api). Returns each session's id.
 */
export async function seed(lock, repos) {
  const base = `http://127.0.0.1:${lock.port}`;
  const auth = { authorization: `Bearer ${lock.token}`, 'content-type': 'application/json' };

  async function post(route, body, headers = {}) {
    const res = await fetch(base + route, { method: 'POST', headers: { ...auth, ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    // A seed that half works makes misleading screenshots: stop at the first refusal.
    if (!res.ok || json.ok === false || json.error) throw new Error(`${route} answered ${res.status}: ${JSON.stringify(json).slice(0, 600)}`);
    return json;
  }
  const hook = (agent, sid, cwd, event, body = {}, headers = {}) =>
    post(`/hook/${event}`, { session_id: sid, cwd, hook_event_name: event, ...body }, { 'x-harness-agent': agent, ...headers });
  const mcp = (agent, sid, cwd, tool, body) => post(`/mcp/${tool}`, { cwd, ...body }, { 'x-harness-session': sid, 'x-harness-agent': agent });
  const ops = (sid, list) => post(`/api/session/${sid}/plan/ops`, { ops: list });

  /* ---------------------------------------------------------------- *
   * 1. orders-service — submitted and mid-build (Claude Code)
   * ---------------------------------------------------------------- */
  const S1 = 'b1c7e0a2-4d1f-4b8e-9a51-3f2d6c0e9a11';
  const C1 = path.join(repos, 'orders-service');
  await hook('claude', S1, C1, 'SessionStart', { source: 'startup' }, { 'x-harness-remote-session': 'session_01Hq7YtB2xWc9LmN4pRk8sVd' });

  const ordersDesign = {
    title: 'Read-through cache for the orders API',
    summary:
      'Put a Redis read-through cache in front of `GET /orders/:id` and `GET /customers/:id/orders`. ' +
      'Writes go to Postgres as today and publish an `order.changed` event; an invalidation worker drops the ' +
      'affected keys. Target: p95 read latency under 40 ms at 3× current traffic, with no stale reads longer than 2 s.',
    sections: [
      {
        id: 'context',
        title: 'Context',
        body:
          'Order reads are 92% of API traffic and p95 is 180 ms, almost all of it in Postgres. ' +
          'The order detail page makes 3–5 of these per load. Writes are rare (≈ 40/s at peak) and already ' +
          'emit domain events through the outbox.',
      },
      {
        id: 'risks',
        title: 'Risks',
        body:
          '- **Stale reads** if an invalidation is lost — mitigated by a 5-minute TTL as a backstop.\n' +
          '- **Thundering herd** on a cold key — single-flight per key in the cache client.\n' +
          '- **Redis outage** — the client fails open to Postgres; reads get slower, not wrong.',
      },
      {
        id: 'out-of-scope',
        title: 'Out of scope',
        body: 'Caching list endpoints with filters; multi-region replication; moving writes off Postgres.',
      },
    ],
    diagrams: [
      {
        id: 'd1',
        title: 'Components',
        nodes: [
          { id: 'client', label: 'Web & mobile clients', kind: 'actor', description: 'The storefront and the mobile apps. Read order detail and history; place and amend orders.' },
          { id: 'gateway', label: 'API gateway', kind: 'service', detail: 'Envoy', description: 'Terminates TLS, authenticates the caller and routes `/orders/*` to the orders API. Unchanged by this plan.', taskIds: [] },
          {
            id: 'api', label: 'Orders API', kind: 'service', detail: 'Node · Fastify',
            description: 'Owns orders. Serves reads through the cache client and writes straight to Postgres inside a transaction that also writes the outbox row.',
            notes: '**Decided:** reads go through `OrderCache.get`, never Redis directly, so the fallback lives in one place.\n\n**Ruled out:** caching in the gateway — it cannot see per-customer authorization.',
            taskIds: ['t1', 't2'],
          },
          {
            id: 'cache', label: 'Redis cache', kind: 'datastore', detail: 'Redis 7 · 5 min TTL',
            description: 'Holds serialized order and customer-order-list payloads keyed by id. A miss loads from Postgres and fills the key; single-flight keeps a cold key from stampeding.',
            notes: '**Decided:** read-through, not write-through — writes stay simple and the worker invalidates.\n\n**TTL:** 5 minutes, as a backstop for a lost invalidation.',
            taskIds: ['t1'],
          },
          { id: 'db', label: 'Postgres', kind: 'datastore', detail: 'orders, outbox', description: 'Source of truth for orders. The outbox table carries `order.changed` events written in the same transaction as the order.' },
          { id: 'bus', label: 'Event bus', kind: 'queue', detail: 'Kafka · order.changed', description: 'Carries `order.changed` from the outbox relay to anyone who cares. The invalidation worker is a new consumer group.' },
          {
            id: 'worker', label: 'Invalidation worker', kind: 'service', detail: 'Node',
            description: 'Consumes `order.changed` and deletes the order key and the owning customer’s list key. Idempotent; lag is alerted on above 2 s.',
            taskIds: ['t3'],
          },
          { id: 'metrics', label: 'Dashboards & alerts', kind: 'external', detail: 'Grafana', description: 'Hit ratio, miss latency, invalidation lag.', taskIds: ['t4'] },
        ],
        edges: [
          { source: 'client', target: 'gateway', label: 'HTTPS' },
          { source: 'gateway', target: 'api', label: 'GET /orders/:id' },
          { source: 'api', target: 'cache', label: 'get / fill' },
          { source: 'api', target: 'db', label: 'miss · writes' },
          { source: 'db', target: 'bus', label: 'outbox relay' },
          { source: 'bus', target: 'worker', label: 'order.changed' },
          { source: 'worker', target: 'cache', label: 'DEL keys' },
          { source: 'api', target: 'metrics', label: 'hit / miss', dashed: true },
          { source: 'worker', target: 'metrics', label: 'lag', dashed: true },
        ],
      },
      {
        id: 'd2',
        title: 'A read, cold and warm',
        nodes: [
          { id: 'req', label: 'GET /orders/:id', kind: 'actor', description: 'An authenticated read.' },
          { id: 'lookup', label: 'OrderCache.get', kind: 'component', description: 'Looks the key up; on a miss takes the single-flight lock for it.', taskIds: ['t1'] },
          { id: 'hit', label: 'Hit → return', kind: 'component', description: 'Deserialize and return. ~2 ms.' },
          { id: 'load', label: 'Load from Postgres', kind: 'component', description: 'One query, then SET with the TTL.', taskIds: ['t2'] },
        ],
        edges: [
          { source: 'req', target: 'lookup' },
          { source: 'lookup', target: 'hit', label: 'hit' },
          { source: 'lookup', target: 'load', label: 'miss' },
          { source: 'load', target: 'hit', label: 'filled' },
        ],
      },
    ],
    tasks: [
      { id: 't1', title: 'Cache client with single-flight', detail: 'OrderCache: get/fill/del, fail-open to Postgres.' },
      { id: 't2', title: 'Serve order reads through the cache', detail: 'Wire both read endpoints through OrderCache.' },
      { id: 't3', title: 'Invalidation worker', detail: 'Consume order.changed; delete keys.' },
      { id: 't4', title: 'Metrics and alerts', detail: 'Hit ratio, miss latency, invalidation lag.' },
    ],
  };
  await mcp('claude', S1, C1, 'publish', ordersDesign);
  await mcp('claude', S1, C1, 'read', {});
  await post(`/api/session/${S1}/plan/design/confirm`, {});
  await hook('claude', S1, C1, 'UserPromptSubmit', { prompt: 'Design looks right — go ahead and break it down.' });
  await mcp('claude', S1, C1, 'read', {});

  const ordersTasks = [
    {
      id: 't1', title: 'Cache client with single-flight', branch: 'coplan/orders-cache-client',
      detail: '**Objective:** an `OrderCache` with `get`, `fill` and `del` over Redis.\n\n**Done when:** a cold key under 50 concurrent reads hits Postgres once; Redis down → reads still served.',
      builds: ['d1/cache', 'd2/lookup'],
      subtasks: [
        { id: 't1a', title: 'Redis connection and config', detail: 'Pool, timeouts, health check.', files: ['src/cache/redis.ts', 'src/config.ts'] },
        { id: 't1b', title: 'OrderCache get / fill / del', detail: 'Serialization, TTL, key scheme `order:v1:{id}`.', files: ['src/cache/orderCache.ts'], dependsOn: ['t1a'] },
        { id: 't1c', title: 'Single-flight per key', detail: 'One loader per cold key; the rest await it.', files: ['src/cache/singleFlight.ts'], dependsOn: ['t1b'] },
        { id: 't1d', title: 'Fail open when Redis is down', detail: 'Circuit breaker; log once per minute.', files: ['src/cache/orderCache.ts'], dependsOn: ['t1b'], review: 'user' },
      ],
    },
    {
      id: 't2', title: 'Serve order reads through the cache', branch: 'coplan/orders-cache-reads', dependsOn: ['t1'],
      detail: '**Objective:** both read endpoints go through `OrderCache`.\n\n**Done when:** responses are byte-identical to today; p95 < 40 ms in the load test.',
      builds: ['d1/api', 'd2/load'],
      subtasks: [
        { id: 't2a', title: 'GET /orders/:id via OrderCache', files: ['src/routes/orders.ts'] },
        { id: 't2b', title: 'GET /customers/:id/orders via OrderCache', files: ['src/routes/customers.ts'] },
        { id: 't2c', title: 'Load test against staging data', files: ['bench/orders.k6.js'], dependsOn: ['t2a', 't2b'] },
      ],
    },
    {
      id: 't3', title: 'Invalidation worker', branch: 'coplan/orders-cache-invalidation', dependsOn: ['t1b'],
      detail: '**Objective:** consume `order.changed` and delete the affected keys.\n\n**Done when:** a write is invisible in the cache within 2 s at p99.',
      builds: ['d1/worker'],
      subtasks: [
        { id: 't3a', title: 'Consumer group and handler', files: ['src/workers/invalidate.ts'] },
        { id: 't3b', title: 'Idempotency and retries', files: ['src/workers/invalidate.ts'], dependsOn: ['t3a'] },
      ],
    },
    { id: 't4', title: 'Metrics and alerts', dependsOn: ['t2', 't3'], detail: 'Hit ratio, miss latency and invalidation lag, with an alert on lag > 2 s.', builds: ['d1/metrics'], files: ['src/metrics.ts', 'ops/alerts.yaml'], review: 'skip' },
  ];
  await mcp('claude', S1, C1, 'tasks', { tasks: ordersTasks });
  await mcp('claude', S1, C1, 'read', {});
  await post(`/api/session/${S1}/plan/submit`, { target: 'session', settings: { review: 'subagent', parallel: 2, maxRounds: 3 } });
  await hook('claude', S1, C1, 'UserPromptSubmit', { prompt: 'go' });

  const upd = (body) => mcp('claude', S1, C1, 'task', body);
  const passChecks = [{ name: 'typecheck', ok: true }, { name: 'lint', ok: true }];
  const tests = [{ name: 'tests', ok: true }];
  async function finish(id, note) {
    await upd({ task_id: id, status: 'in_progress', stage: 'implement' });
    await upd({ task_id: id, checks: passChecks });
    await upd({ task_id: id, stage: 'review' });
    await upd({ task_id: id, checks: tests, verdict: 'pass', summary: 'Meets the brief; edge cases covered.' });
    await upd({ task_id: id, status: 'done', note });
  }
  await finish('t1a', 'ioredis pool with 200 ms command timeout and a /health probe.');
  await finish('t1b', 'OrderCache with versioned keys and a 5-minute TTL.');
  await finish('t3a', 'Consumer group `orders-cache-invalidation`; deletes order and list keys.');
  // t1c: back in review for round 2, after the first review asked for changes.
  await upd({ task_id: 't1c', status: 'in_progress', stage: 'implement' });
  await upd({ task_id: 't1c', checks: passChecks });
  await upd({ task_id: 't1c', stage: 'review' });
  await upd({ task_id: 't1c', checks: tests, verdict: 'changes', summary: 'A rejected loader leaves waiters hanging.' });
  await upd({ task_id: 't1c', stage: 'refine' });
  await upd({ task_id: 't1c', checks: passChecks });
  await upd({ task_id: 't1c', stage: 'review' });
  // t3b: implementing, with a lint failure. Two in progress: the build allows two at once.
  await upd({ task_id: 't3b', status: 'in_progress', stage: 'implement' });
  await upd({ task_id: 't3b', checks: [{ name: 'typecheck', ok: true }, { name: 'lint', ok: false, note: 'no-floating-promises in invalidate.ts:48' }] });
  await mcp('claude', S1, C1, 'branch', { branch: 'coplan/orders-cache-client', pr_url: 'https://github.com/acme/orders-service/pull/412', pr_number: 412, pr_state: 'draft' });
  await hook('claude', S1, C1, 'Stop', { stop_hook_active: false, last_assistant_message: 'Refining the single-flight fix; t3b is next in review.' });
  await hook('claude', S1, C1, 'UserPromptSubmit', { prompt: 'keep going' });

  /* ---------------------------------------------------------------- *
   * 2. web-dashboard — designing, user commented, Codex asks (Codex)
   * ---------------------------------------------------------------- */
  const S2 = '019a5c3e-7b21-7f40-a8d2-5be1c4f09e37';
  const C2 = path.join(repos, 'web-dashboard');
  await hook('codex', S2, C2, 'SessionStart', { source: 'startup' });
  await mcp('codex', S2, C2, 'publish', {
    title: 'Saved views for the analytics dashboard',
    summary: 'Let people save a dashboard’s filters, date range and layout as a named view, share it by link, and pin one as their default.',
    sections: [
      { id: 'context', title: 'Context', body: 'Today every reload resets the filters. Support gets ~30 tickets a week asking to “bookmark” a view.' },
      { id: 'risks', title: 'Risks', body: '- Shared links to views that reference deleted metrics.\n- URL length if the whole state rides in the query string.' },
    ],
    diagrams: [
      {
        id: 'd1', title: 'Saved views',
        nodes: [
          { id: 'ui', label: 'Dashboard UI', kind: 'component', detail: 'React', description: 'Renders the dashboard and the view picker. Serializes filter state into a `ViewSpec`.', taskIds: ['t2'] },
          { id: 'picker', label: 'View picker', kind: 'component', detail: 'menu + dialog', description: 'Lists my views and views shared with me; save, rename, delete, set default.', taskIds: ['t2'] },
          { id: 'api', label: 'Views API', kind: 'service', detail: 'REST · /views', description: 'CRUD for saved views, scoped to the workspace. Validates a `ViewSpec` against the current metric catalog.', taskIds: ['t1'] },
          { id: 'store', label: 'views table', kind: 'datastore', detail: 'Postgres · jsonb', description: 'One row per view: owner, workspace, name, spec (jsonb), is_default.', taskIds: ['t1'] },
          { id: 'catalog', label: 'Metric catalog', kind: 'service', description: 'Existing service; says which metrics and dimensions exist.' },
          { id: 'share', label: 'Share links', kind: 'component', detail: '/v/:slug', description: 'A short slug per view; opening it loads the view read-only unless you own it.', taskIds: ['t3'] },
        ],
        edges: [
          { source: 'ui', target: 'picker' },
          { source: 'picker', target: 'api', label: 'save / list' },
          { source: 'api', target: 'store', label: 'rows' },
          { source: 'api', target: 'catalog', label: 'validate spec' },
          { source: 'share', target: 'api', label: 'resolve slug' },
          { source: 'ui', target: 'share', label: 'copy link', dashed: true },
        ],
      },
    ],
    tasks: [
      { id: 't1', title: 'Views API and table' },
      { id: 't2', title: 'View picker in the dashboard' },
      { id: 't3', title: 'Share links' },
    ],
  });
  // The user reshapes it in the browser: adds a box, connects it, comments.
  await ops(S2, [
    { op: 'upsert_node', diagramId: 'd1', id: 'audit', label: 'Audit log', kind: 'external', detail: 'existing', description: 'Record who shared a view and when.' },
    { op: 'upsert_edge', diagramId: 'd1', from: 'api', to: 'audit', label: 'view.shared' },
    { op: 'upsert_node', diagramId: 'd1', id: 'store', notes: '**Decided (user):** keep the spec as jsonb, versioned with `spec_version`.' },
    { op: 'comment', target: { kind: 'node', id: 'd1/share' }, text: 'Should a shared link pin the date range, or follow “last 7 days”?' },
    { op: 'comment', target: { kind: 'plan', id: '' }, text: 'Default views should be per user, not per workspace.' },
  ]);
  await hook('codex', S2, C2, 'UserPromptSubmit', { prompt: 'I added an audit log box and left two comments — take a look.' });
  await mcp('codex', S2, C2, 'read', {});
  await hook('codex', S2, C2, 'PreToolUse', {
    tool_name: 'request_user_input',
    tool_input: {
      questions: [
        {
          id: 'share_range', header: 'Share links',
          question: 'Should a shared link pin the exact date range, or keep it relative (“last 7 days”)?',
          options: [
            { label: 'Keep it relative', description: 'Recipients see fresh data; matches how people use the dashboard.' },
            { label: 'Pin the range', description: 'Recipients see exactly what the sender saw.' },
          ],
        },
      ],
    },
  });

  /* ---------------------------------------------------------------- *
   * 3. billing-api — design confirmed, task list ready (Claude Code)
   * ---------------------------------------------------------------- */
  const S3 = 'e4a90d3b-61c2-4e57-b0f8-2a7d5c1e8f60';
  const C3 = path.join(repos, 'billing-api');
  await hook('claude', S3, C3, 'SessionStart', { source: 'startup' }, { 'x-harness-remote-session': 'session_01Kp3NzR6vTy2QaD8wFb5mXe' });
  await mcp('claude', S3, C3, 'publish', {
    title: 'Retry outbound webhooks with backoff',
    summary: 'Move webhook delivery off the request path into a durable queue with exponential backoff, a dead-letter queue and a replay endpoint.',
    sections: [{ id: 'context', title: 'Context', body: '4% of webhook deliveries fail on the first try and are never retried.' }],
    diagrams: [
      {
        id: 'd1', title: 'Delivery',
        nodes: [
          { id: 'events', label: 'Billing events', kind: 'service', description: 'Invoice paid, subscription changed, …', taskIds: ['t1'] },
          { id: 'queue', label: 'Delivery queue', kind: 'queue', detail: 'SQS', description: 'Durable; one message per endpoint per event.', taskIds: ['t1'] },
          { id: 'sender', label: 'Sender', kind: 'service', detail: 'worker', description: 'Signs and POSTs; on failure re-enqueues with backoff (1m → 6h, 8 tries).', taskIds: ['t2'] },
          { id: 'dlq', label: 'Dead letters', kind: 'queue', detail: 'SQS DLQ', description: 'Deliveries out of tries.', taskIds: ['t2'] },
          { id: 'replay', label: 'Replay API', kind: 'service', detail: 'POST /webhooks/replay', description: 'Re-enqueue dead letters for one endpoint.', taskIds: ['t3'] },
          { id: 'merchant', label: 'Merchant endpoint', kind: 'external', description: 'The customer’s HTTPS endpoint.' },
        ],
        edges: [
          { source: 'events', target: 'queue', label: 'enqueue' },
          { source: 'queue', target: 'sender' },
          { source: 'sender', target: 'merchant', label: 'POST (signed)' },
          { source: 'sender', target: 'dlq', label: 'out of tries' },
          { source: 'replay', target: 'queue', label: 're-enqueue' },
        ],
      },
    ],
    tasks: [
      { id: 't1', title: 'Enqueue deliveries' },
      { id: 't2', title: 'Sender with backoff and DLQ' },
      { id: 't3', title: 'Replay API' },
    ],
  });
  await mcp('claude', S3, C3, 'read', {});
  await post(`/api/session/${S3}/plan/design/confirm`, {});
  await hook('claude', S3, C3, 'UserPromptSubmit', { prompt: 'Confirmed.' });
  await mcp('claude', S3, C3, 'tasks', {
    tasks: [
      {
        id: 't1', title: 'Enqueue deliveries', branch: 'coplan/webhook-queue', builds: ['events', 'queue'],
        detail: '**Objective:** billing events enqueue one delivery per subscribed endpoint instead of POSTing inline.\n\n**Done when:** no HTTP call to a merchant remains on the request path.',
        subtasks: [
          { id: 't1a', title: 'Queue and IAM in Terraform', files: ['infra/webhooks.tf'], review: 'user' },
          { id: 't1b', title: 'Enqueue from the event publisher', files: ['src/webhooks/enqueue.ts'], dependsOn: ['t1a'] },
        ],
      },
      {
        id: 't2', title: 'Sender with backoff and DLQ', branch: 'coplan/webhook-sender', dependsOn: ['t1'], builds: ['sender', 'dlq'],
        detail: '**Objective:** a worker that signs and sends, backing off 1m → 6h over 8 tries, then dead-letters.',
        subtasks: [
          { id: 't2a', title: 'Signed POST with timeout', files: ['src/webhooks/send.ts'] },
          { id: 't2b', title: 'Backoff schedule and re-enqueue', files: ['src/webhooks/backoff.ts'] },
          { id: 't2c', title: 'Dead-letter after the last try', files: ['src/webhooks/send.ts'], dependsOn: ['t2a', 't2b'] },
        ],
      },
      { id: 't3', title: 'Replay API', branch: 'coplan/webhook-replay', dependsOn: ['t2c'], builds: ['replay'], detail: 'Admin-only endpoint that re-enqueues an endpoint’s dead letters.', files: ['src/routes/replay.ts'] },
      { id: 't4', title: 'Runbook', dependsOn: ['t3'], detail: 'How to read the DLQ and replay.', files: ['docs/runbooks/webhooks.md'], review: 'skip' },
    ],
  });

  /* ---------------------------------------------------------------- *
   * 4. public-api — built, with the report (Claude Code)
   * ---------------------------------------------------------------- */
  const S4 = '7f3e2c19-8a4b-4d6e-b1f0-c9d2e5a7b834';
  const C4 = path.join(repos, 'public-api');
  await hook('claude', S4, C4, 'SessionStart', { source: 'startup' });
  await mcp('claude', S4, C4, 'publish', {
    title: 'Per-key rate limiting for the public API',
    summary: 'Token-bucket limits per API key in Redis, enforced in middleware, with `RateLimit-*` headers and a 429 that says when to retry.',
    sections: [{ id: 'context', title: 'Context', body: 'Two customers’ batch jobs took the API down twice last month.' }],
    diagrams: [
      {
        id: 'd1', title: 'Limiter', direction: 'LR',
        nodes: [
          { id: 'mw', label: 'Rate-limit middleware', kind: 'component', description: 'Takes a token per request; sets headers; answers 429 when empty.', taskIds: ['t1'] },
          { id: 'bucket', label: 'Token buckets', kind: 'datastore', detail: 'Redis · Lua', description: 'One bucket per key and route class, refilled atomically by a Lua script.', taskIds: ['t1'] },
          { id: 'plans', label: 'Plan limits', kind: 'service', description: 'Limits per pricing plan, cached for 60 s.', taskIds: ['t2'] },
          { id: 'docs', label: 'API docs', kind: 'external', description: 'Document the headers and the 429.', taskIds: ['t3'] },
        ],
        edges: [
          { source: 'mw', target: 'bucket', label: 'take token' },
          { source: 'mw', target: 'plans', label: 'limit for key' },
        ],
      },
    ],
    tasks: [{ id: 't1', title: 'Token bucket middleware' }, { id: 't2', title: 'Limits per plan' }, { id: 't3', title: 'Docs' }],
  });
  await mcp('claude', S4, C4, 'read', {});
  await post(`/api/session/${S4}/plan/design/confirm`, {});
  await hook('claude', S4, C4, 'UserPromptSubmit', { prompt: 'ok' });
  await mcp('claude', S4, C4, 'tasks', {
    tasks: [
      { id: 't1', title: 'Token bucket middleware', branch: 'coplan/rate-limit-core', builds: ['mw', 'bucket'], detail: 'Lua script, middleware, headers.', files: ['src/middleware/rateLimit.ts', 'src/redis/bucket.lua'] },
      { id: 't2', title: 'Limits per plan', branch: 'coplan/rate-limit-plans', dependsOn: ['t1'], builds: ['plans'], detail: 'Look up the key’s plan; cache 60 s.', files: ['src/plans/limits.ts'] },
      { id: 't3', title: 'Document the headers and the 429', dependsOn: ['t1'], builds: ['docs'], detail: 'Reference page and changelog entry.', files: ['docs/rate-limits.md'], review: 'skip' },
    ],
  });
  await mcp('claude', S4, C4, 'read', {});
  await post(`/api/session/${S4}/plan/submit`, { target: 'session', settings: { review: 'subagent', parallel: 2, maxRounds: 3 } });
  await hook('claude', S4, C4, 'UserPromptSubmit', { prompt: 'go' });
  const upd4 = (body) => mcp('claude', S4, C4, 'task', body);
  for (const [id, note] of [['t1', 'Lua token bucket + middleware; RateLimit-* headers.'], ['t2', 'Limits per plan, cached 60 s.'], ['t3', 'docs/rate-limits.md and a changelog entry.']]) {
    await upd4({ task_id: id, status: 'in_progress', stage: 'implement' });
    await upd4({ task_id: id, checks: passChecks });
    await upd4({ task_id: id, stage: 'review' });
    await upd4({ task_id: id, checks: tests, verdict: 'pass', summary: 'Meets the brief.' });
    await upd4({ task_id: id, status: 'done', note });
  }
  await mcp('claude', S4, C4, 'branch', { branch: 'coplan/rate-limit-core', pr_url: 'https://github.com/acme/public-api/pull/88', pr_number: 88, pr_state: 'open' });
  await mcp('claude', S4, C4, 'branch', { branch: 'coplan/rate-limit-plans', pr_url: 'https://github.com/acme/public-api/pull/89', pr_number: 89, pr_state: 'open' });
  await mcp('claude', S4, C4, 'edit', {
    ops: [
      {
        op: 'report',
        checks: [{ name: 'check', ok: true }],
        text:
          '### Built\n' +
          '- **Token bucket middleware** — atomic Lua refill, `RateLimit-Limit/Remaining/Reset` headers, 429 with `Retry-After`.\n' +
          '- **Limits per plan** — looked up per key, cached 60 s; unknown plans get the free tier.\n' +
          '- **Docs** — `docs/rate-limits.md` and a changelog entry.\n\n' +
          '### Branches & PRs\n' +
          '1. `coplan/rate-limit-core` → `main` — [#88](https://github.com/acme/public-api/pull/88)\n' +
          '2. `coplan/rate-limit-plans` → `coplan/rate-limit-core` — [#89](https://github.com/acme/public-api/pull/89)\n\n' +
          '### Checks\n`pnpm check` passed (typecheck, lint, 412 tests).\n\n' +
          '### Changed from the plan\nRefill runs in Lua rather than with `MULTI`: one round trip, no race between read and write.\n\n' +
          '### Follow-ups\n- Burst allowance per plan is fixed at 2× — product may want it configurable.',
      },
    ],
  });
  await hook('claude', S4, C4, 'Stop', { stop_hook_active: false, last_assistant_message: 'Built. Both pull requests are open.' });

  return { S1, S2, S3, S4 };
}
