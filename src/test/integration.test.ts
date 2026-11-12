import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl, paths } from '../shared/paths.ts';
import type { DaemonLock, SessionState } from '../shared/types.ts';
import type { HookOutput } from '../shared/hooks.ts';
import { asksForCoplan } from '../daemon/hookIngest.ts';
import { blocksText, joinBlocks, type Block, type ConfigRow } from '../shared/blocks.ts';

/**
 * End-to-end: a real daemon subprocess, a real git repository, real hook
 * payloads. This is the test that would catch a regression in the thing the
 * harness actually promises — that what the user does to the plan in the
 * browser is what Claude reads back, and that nothing ever holds a turn.
 */

const DAEMON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'main.js');

let home: string;
let repo: string;
let daemon: ChildProcess;
let lock: DaemonLock;
const sessionId = 'integration-session';

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-int-home-'));
  repo = mkdtempSync(path.join(tmpdir(), 'cc-harness-int-repo-'));
  process.env['CC_HARNESS_HOME'] = home;

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'app.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial']);
  git(['checkout', '-qb', 'feature/change']);

  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ idleShutdownMinutes: 0 }));
  // The lifecycle tests below hold a Managed build to its gates (#62): the
  // user's own default, under every repository these tests write a config for.
  writeFileSync(path.join(home, 'coplan.json'), JSON.stringify({ mode: 'managed' }));

  daemon = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, CC_HARNESS_HOME: home },
    stdio: 'ignore',
  });

  for (let i = 0; i < 80; i++) {
    await sleep(100);
    const live = readLiveLock();
    if (live) {
      lock = live;
      return;
    }
  }
  throw new Error('daemon did not start');
});

after(async () => {
  // Wait for the daemon to actually exit: it flushes session state on
  // shutdown, and removing the directory underneath it races that write.
  if (daemon && daemon.exitCode === null) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      daemon.once('exit', done);
      daemon.kill('SIGTERM');
      setTimeout(() => {
        daemon.kill('SIGKILL');
        done();
      }, 3000).unref();
    });
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/* ------------------------------------------------------------------ */

async function call<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl(lock)}${route}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${lock.token}`,
      'x-harness-session': sessionId,
      ...(init?.headers ?? {}),
    },
  });
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? await res.json() : { status: res.status, text: await res.text() }) as T;
}

const hookFor = (id: string, event: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  call<HookOutput>(`/hook/${event}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ session_id: id, cwd: repo, ...body }),
  });

const mcpFor = (id: string, tool: string, body: Record<string, unknown> = {}) =>
  call<Record<string, unknown>>(`/mcp/${tool}`, {
    method: 'POST',
    headers: { 'x-harness-session': id },
    body: JSON.stringify({ cwd: repo, ...body }),
  });

const hook = (event: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  hookFor(sessionId, event, body, headers);
const mcp = (tool: string, body: Record<string, unknown> = {}) => mcpFor(sessionId, tool, body);

const sessionFor = (id: string) =>
  call<{ session: SessionState }>(`/api/session/${id}`).then((r) => r.session);
const session = () => sessionFor(sessionId);

/* ------------------------------------------------------------------ */

const ops = (list: unknown[]) =>
  call<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${sessionId}/plan/ops`, {
    method: 'POST',
    body: JSON.stringify({ ops: list }),
  });

const PLAN = {
  title: 'Add a cache',
  summary: 'A read-through cache in front of Postgres.',
  sections: [{ title: 'Context', body: 'Reads are slow.' }],
  diagrams: [
    {
      title: 'Components',
      nodes: [
        { id: 'api', label: 'API', kind: 'service' },
        { id: 'db', label: 'Postgres', kind: 'datastore' },
      ],
      edges: [{ source: 'api', target: 'db' }],
    },
  ],
  tasks: [{ title: 'Storage', subtasks: [{ title: 'Client' }, { title: 'Invalidation' }] }, { title: 'Wire up' }],
};

test('SessionStart records the repo and branch', async () => {
  await hook('SessionStart', { start_reason: 'startup' });
  const s = await session();
  assert.ok(s.repoRoot && s.repoRoot.endsWith(path.basename(repo)));
  assert.equal(s.branch, 'feature/change');
  assert.equal(s.plan, null);
});

test('publishing returns the plan as Claude will read it, with its ids', async () => {
  const res = await mcp('publish', PLAN);
  assert.equal(res['ok'], true);
  const text = String(res['text']);
  assert.match(text, /Published "Add a cache"/);
  assert.match(text, /Tell them in chat/);
  assert.match(text, /t2 Client/);
  assert.match(text, /- API → Postgres `api → db`/);
  assert.doesNotMatch(text, /token=/, 'the auth token never reaches the transcript');
  const s = await session();
  assert.equal(s.plan?.tasks.length, 4);
});

test('no hook ever holds a turn', async () => {
  // The whole review loop used to park Claude in the Stop hook. Planning
  // never waits: the conversation is Claude's own chat.
  for (const event of ['Stop', 'UserPromptSubmit', 'SessionEnd', 'SessionStart']) {
    const started = Date.now();
    const out = await hook(event, { stop_hook_active: false, prompt: 'hi' });
    assert.notEqual(out.decision, 'block', event);
    assert.ok(Date.now() - started < 2000, `${event} answered at once`);
  }
});

test('what the user does in the browser is what Claude reads back', async () => {
  const res = await ops([
    { op: 'move_task', id: 't4', parentId: 't1', index: 0 },
    { op: 'upsert_task', parentId: 't1', title: 'Load test' },
    { op: 'comment', target: { kind: 'diagram', id: 'd1' }, text: 'where does the cache go?' },
    {
      op: 'upsert_diagram',
      id: 'd1',
      nodes: [
        { id: 'api', label: 'API', kind: 'service', x: 0, y: 0 },
        { id: 'cache', label: 'Redis', kind: 'datastore', x: 200, y: 0, notes: 'Already deployed.', taskIds: ['t2'] },
        { id: 'db', label: 'Postgres', kind: 'datastore', x: 400, y: 0 },
      ],
      edges: [
        { source: 'api', target: 'cache' },
        { source: 'cache', target: 'db' },
      ],
    },
  ]);
  assert.ok(res.plan, res.error);

  const read = String((await mcp('read', {}))['text']);
  assert.match(read, /Since you last read — what the user changed/);
  assert.match(read, /Changed t4 "Wire up": moved under "Storage"/);
  assert.match(read, /Added t5 "Load test" under "Storage"/);
  assert.match(read, /Commented on diagram "Components": where does the cache go\?/);
  // The diagram edit is reported as the design it produced, not the save.
  assert.match(read, /\*\*Diagram \[d1\] "Components"\*\*\n- Added Redis \(`cache`\) — data store\./);
  assert.match(read, /- Connected API → Redis\.\n- Connected Redis → Postgres\.\n- Disconnected API → Postgres\./);
  // Whole numbers only: the daemon's port, in the read's link, may contain the digits.
  assert.doesNotMatch(read, /x: |"x"|\b200\b/, 'no coordinates reach Claude');
  // And the architecture reads in flow order, with what was decided.
  assert.match(read, /\*\*Parts\*\*\n- \*\*API\*\* `api` — service\n- \*\*Redis\*\* `cache` — data store\n  Decisions:\n    Already deployed\.\n  Built by: \[ \] t2 Client\n- \*\*Postgres\*\* `db` — data store/);
});

test('moving boxes around is saved but is not news to Claude', async () => {
  const before = await session();
  const d = before.plan!.diagrams[0]!;
  const res = await ops([{ op: 'upsert_diagram', id: d.id, nodes: d.nodes.map((n, i) => ({ ...n, x: i * 300, y: 90 })), edges: d.edges, direction: 'TB' }]);
  assert.ok(res.plan, res.error);
  assert.equal(res.plan!.diagrams[0]!.nodes[1]!.x, 300, 'the layout is saved');
  const read = String((await mcp('read', { changes_only: true }))['text']);
  assert.match(read, /has not changed the plan/);
  const notice = await hook('UserPromptSubmit', { prompt: 'continue' });
  assert.equal(notice.hookSpecificOutput?.additionalContext, undefined);
});

test('what Claude last read stays in the daemon', async () => {
  const s = await session();
  assert.ok(s.plan);
  assert.equal('claudeBaseline' in (s.plan as object), false, 'not sent to the page');
});

test('reading once catches Claude up', async () => {
  const again = String((await mcp('read', { changes_only: true }))['text']);
  assert.match(again, /has not changed the plan/);
  const notice = await hook('UserPromptSubmit', { prompt: 'continue' });
  assert.equal(notice.hookSpecificOutput?.additionalContext, undefined, 'no notice once Claude is up to date');
});

test('the next chat message after an edit tells Claude to read the plan', async () => {
  await ops([{ op: 'upsert_task', title: 'Shard later' }]);
  const out = await hook('UserPromptSubmit', { prompt: 'ok, go on' });
  assert.match(out.hookSpecificOutput?.additionalContext ?? '', /changed the plan .* harness_plan_read/);
});

test('a republish over unread user edits is refused', async () => {
  const res = await mcp('publish', PLAN);
  assert.equal(res['ok'], false);
  assert.match(String(res['text']), /harness_plan_read first/);
  const s = await session();
  assert.ok(s.plan!.tasks.some((t) => t.title === 'Shard later'), 'nothing the user did was lost');
});

test('Claude replies to the user\'s comment in its thread', async () => {
  await mcp('read', {});
  const s = await session();
  const thread = s.plan!.threads[0]!;
  const res = await mcp('edit', { ops: [{ op: 'reply', threadId: thread.id, text: 'Between the API and Postgres.' }] });
  assert.equal(res['ok'], true, String(res['text']));
  const after = await session();
  assert.equal(after.plan!.threads[0]!.replies[0]!.author, 'claude');
  assert.equal(after.plan!.claudeReadSeq, after.plan!.seq, 'its own edits are not news to it');
});

test('a question Claude asks is shown as waiting, and cleared when answered in Claude', async () => {
  await hook('PreToolUse', {
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which TTL?', header: 'TTL', options: [{ label: '1m' }, { label: '10m' }] }] },
  });
  const asking = await session();
  assert.equal(asking.waiting?.kind, 'question');
  assert.deepEqual(asking.waiting?.questions?.[0], { question: 'Which TTL?', header: 'TTL', options: ['1m', '10m'] });
  const { sessions } = await call<{ sessions: { sessionId: string; waiting: unknown }[] }>('/api/sessions');
  assert.ok(sessions.find((x) => x.sessionId === sessionId)?.waiting, 'the rail hears about it');

  await hook('PostToolUse', { tool_name: 'AskUserQuestion' });
  assert.equal((await session()).waiting, null);
});

test('an idle reminder does not replace the question it reminds about', async () => {
  await hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Shard?', options: [] }] } });
  await hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.equal((await session()).waiting?.text, 'Shard?');
  await hook('UserPromptSubmit', { prompt: 'no' });
  assert.equal((await session()).waiting, null, 'replying in Claude clears it');
});

test('a permission prompt is waiting too', async () => {
  await hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  const s = await session();
  assert.equal(s.waiting?.kind, 'permission');
  assert.match(s.waiting?.text ?? '', /permission to use Bash/);
  await hook('PostToolUse', { tool_name: 'Bash' });
});

test('a turn that ends on a question is waiting on a reply', async () => {
  await hook('Stop', { last_assistant_message: 'Done with the plan.\n\nShould the warmer read from a replica?' });
  const s = await session();
  assert.equal(s.status, 'idle');
  assert.equal(s.waiting?.text, 'Should the warmer read from a replica?');
  await hook('Stop', { last_assistant_message: 'All done.' });
  assert.equal((await session()).waiting, null);
});

test('the session environment decides the link back to Claude', async () => {
  await hook('UserPromptSubmit', { prompt: 'x' });
  assert.equal((await session()).link, null, 'a plain local session has no documented link');
  await hook('Stop', {}, { 'x-harness-bridge-session': 'session_01Bridge', 'x-harness-entrypoint': 'cli' });
  const s = await session();
  assert.equal(s.surface, 'cli');
  assert.equal(s.link?.app, 'claude://claude.ai/code/session_01Bridge');
  await hook('Stop', {}, { 'x-harness-remote-sdk': 'https://api.anthropic.com/v1/code/sessions/cse_01Cloud' });
  assert.equal((await session()).link?.web, 'https://claude.ai/code/session_01Cloud');
});

test('task tracking moves statuses and reports them', async () => {
  await ops([{ op: 'upsert_task', title: 'Profile it' }]);
  // Done means the cycle ran: straight from todo, it is refused.
  const unreviewed = await mcp('task', { task_id: 't2', status: 'done', note: 'client added' });
  assert.equal(unreviewed['ok'], false);
  assert.match(String(unreviewed['text']), /has not been reviewed/);
  await mcp('task', { task_id: 't2', stage: 'review' });
  const res = await mcp('task', { task_id: 't2', status: 'done', verdict: 'pass', note: 'client added' });
  assert.match(String(res['text']), /"Client" is done/);
  // Where the user changed things, not how many saves it took.
  assert.match(String(res['text']), /The user has changed tasks since you last read the plan/);
  assert.doesNotMatch(String(res['text']), /time\(s\)/);
  const bad = await mcp('task', { task_id: 'nope', status: 'done' });
  assert.equal(bad['ok'], false);
  assert.match(String(bad['text']), /No task "nope"/);
});

test('a refused browser edit says why and changes nothing', async () => {
  const before = await session();
  const res = await ops([{ op: 'move_task', id: 't1', parentId: 't2', index: 0 }]);
  assert.match(res.error ?? '', /inside itself/);
  const after = await session();
  assert.equal(after.plan!.seq, before.plan!.seq);
});

test('a peek shows the plan and leaves the user\'s changes unread for the real read', async () => {
  await ops([{ op: 'upsert_task', id: 't2', title: 'Client (peeked)' }]);
  const before = (await session()).plan!.claudeReadSeq;
  const peek = String((await mcp('read', { peek: true }))['text']);
  assert.match(peek, /^\[cc-harness\] A peek/);
  assert.match(peek, /Client \(peeked\)/);
  assert.equal((await session()).plan!.claudeReadSeq, before, 'nothing marked read');
  const real = String((await mcp('read', { changes_only: true }))['text']);
  assert.match(real, /renamed from "Client"/, 'the real read still reports the change');
});

test('the plan text endpoint shows exactly what Claude reads, without counting as a read', async () => {
  await ops([{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'peek' }]);
  const res = await call<{ status: number; text: string }>(`/api/session/${sessionId}/plan/text`);
  assert.match(res.text, /# Add a cache/);
  const s = await session();
  assert.ok(s.plan!.claudeReadSeq < s.plan!.seq, 'Claude still has the comment to read');
});

test('a renamed session keeps its name', async () => {
  await call(`/api/session/${sessionId}/title`, { method: 'POST', body: JSON.stringify({ title: 'Cache work' }) });
  await hook('SessionStart', { start_reason: 'resume' });
  assert.equal((await session()).title, 'Cache work');
  const empty = await call<{ error?: string }>(`/api/session/${sessionId}/title`, { method: 'POST', body: JSON.stringify({ title: '  ' }) });
  assert.ok(empty.error);
});

test('the session list summarizes the plan', async () => {
  const { sessions } = await call<{ sessions: { sessionId: string; planTitle: string; tasks: { total: number; done: number }; planStatus: string; awaitingReview: number }[] }>('/api/sessions');
  const row = sessions.find((s) => s.sessionId === sessionId)!;
  assert.equal(row.planTitle, 'Add a cache');
  assert.equal(row.tasks.done, 1);
  // The status the list shows and filters on (#66).
  assert.equal(row.planStatus, 'planning');
  assert.equal(row.awaitingReview, 0);
});

test('only a session that used Coplan is marked for the session list', async () => {
  const engaged = async (id: string) => {
    const { sessions } = await call<{ sessions: { sessionId: string; engaged: boolean }[] }>('/api/sessions');
    return sessions.find((s) => s.sessionId === id)?.engaged;
  };
  const ids = ['engage-chat', 'engage-typed', 'engage-skill', 'engage-tool'];
  for (const id of ids) await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  try {
    // Every session with the plugin registers; a chat that never asked for a
    // plan is not one of the user's plans, nor is one that only opened the UI.
    await hookFor('engage-chat', 'UserPromptSubmit', { prompt: 'fix the flaky test' });
    await hookFor('engage-chat', 'UserPromptSubmit', { prompt: '/coplan-open' });
    await hookFor('engage-chat', 'PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'review' } });
    assert.equal(await engaged('engage-chat'), false);

    // Typing the command lists it at once, before there is any plan.
    await hookFor('engage-typed', 'UserPromptSubmit', { prompt: '/coplan:coplan add a cache' });
    assert.equal(await engaged('engage-typed'), true);
    const stamped = (await sessionFor('engage-typed')).engagedAt;
    await hookFor('engage-typed', 'UserPromptSubmit', { prompt: '/coplan again' });
    assert.equal((await sessionFor('engage-typed')).engagedAt, stamped, 'a second /coplan does not move when it began');

    // So does the agent loading the skill itself …
    await hookFor('engage-skill', 'PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'coplan:coplan' } });
    assert.equal(await engaged('engage-skill'), true);

    // … or calling one of Coplan's tools, however it got there.
    await mcpFor('engage-tool', 'read');
    assert.equal(await engaged('engage-tool'), true);

    // A session with a plan is listed whatever started it.
    assert.equal(await engaged(sessionId), true);
  } finally {
    for (const id of ids) await call(`/api/session/${id}`, { method: 'DELETE' });
  }
});

test('/coplan is read as a command, and $coplan as a Codex skill mention', () => {
  for (const prompt of ['/coplan', '/coplan add a cache', '  /coplan:coplan x', 'use $coplan to plan this', 'plan it with $coplan.']) {
    assert.ok(asksForCoplan(prompt), prompt);
  }
  for (const prompt of ['/coplan-open', '/coplan-doctor', '$coplan-open', 'see /coplan', 'src/coplan', '/coplan/x', '/coplans', 'a$coplan']) {
    assert.ok(!asksForCoplan(prompt), prompt);
  }
});

/* ------------------------------------------------------------------ *
 * The HTTP surface
 * ------------------------------------------------------------------ */

const raw = (route: string, init: RequestInit = {}) =>
  fetch(`${baseUrl(lock)}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${lock.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

test('the UI is served with a strict content policy and no referrer', async () => {
  const res = await fetch(`${baseUrl(lock)}/?token=${lock.token}`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'no inline script, ever');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', 'the token in the first URL never leaks');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('the token travels only as a header: no cookie is set, and a link or a cookie does not open the API', async () => {
  const page = await fetch(`${baseUrl(lock)}/?token=${lock.token}`);
  assert.equal(page.headers.get('set-cookie'), null, 'a cookie would go to every server on 127.0.0.1');
  assert.equal((await fetch(`${baseUrl(lock)}/`)).status, 200, 'the page itself is code, served to anyone');
  assert.equal((await fetch(`${baseUrl(lock)}/api/sessions?token=${lock.token}`)).status, 401);
  assert.equal((await fetch(`${baseUrl(lock)}/api/sessions`, { headers: { cookie: `cc_harness=${lock.token}` } })).status, 401);
  assert.equal((await fetch(`${baseUrl(lock)}/api/sessions`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await raw('/api/sessions')).status, 200);
});

test('the live stream opens on a single-use ticket', async () => {
  const { ticket } = await call<{ ticket: string }>('/api/events/ticket', { method: 'POST', body: '{}' });
  const open = (t: string) =>
    new Promise<number>((resolve) => {
      const req = http.get(`${baseUrl(lock)}/api/events?ticket=${t}`, (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
      });
      req.on('error', () => resolve(0));
    });
  assert.equal(await open(ticket), 200);
  assert.equal(await open(ticket), 401, 'spent');
  assert.equal(await open('made-up'), 401);
});

test('a foreign Host, a path out of the UI folder and a clean with no groups are all refused', async () => {
  const foreign = await new Promise<number>((resolve) => {
    http.get({ host: '127.0.0.1', port: lock.port, path: '/health', headers: { host: 'evil.example' } }, (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
  });
  assert.equal(foreign, 403, 'DNS rebinding');
  for (const p of ['/..%2fdaemon.json', '/%2e%2e/%2e%2e/etc/passwd']) assert.notEqual((await fetch(`${baseUrl(lock)}${p}`)).status, 200, p);
  assert.equal((await raw('/api/storage/clean', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await raw('/api/storage/clean', { method: 'POST', body: JSON.stringify({ groups: [] }) })).status, 400);
});

test("the daemon's files are this user's alone", { skip: process.platform === 'win32' }, () => {
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(home, 'auth.header')).mode & 0o777, 0o600);
  assert.match(readFileSync(path.join(home, 'auth.header'), 'utf8'), /^Authorization: Bearer [0-9a-f]+\n$/);
});

test('malformed input is a 400, not a 500', async () => {
  const bad = await raw(`/api/session/${sessionId}/plan/ops`, { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
  const notObject = await raw(`/api/session/${sessionId}/plan/ops`, { method: 'POST', body: '[1,2]' });
  assert.equal(notObject.status, 400);
  const badPath = await raw('/api/session/%E0%A4%A');
  assert.equal(badPath.status, 400);
});

test('an oversized body is refused', async () => {
  const res = await raw(`/api/session/${sessionId}/plan/ops`, { method: 'POST', body: JSON.stringify({ ops: [], pad: 'x'.repeat(3 * 1024 * 1024) }) }).catch(() => null);
  assert.ok(!res || res.status === 413, `expected 413, got ${res?.status}`);
});

test('a write from another origin is refused even with valid credentials', async () => {
  const res = await raw(`/api/session/${sessionId}/plan/ops`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ ops: [{ op: 'upsert_task', title: 'injected' }] }),
  });
  assert.equal(res.status, 403);
  const own = await raw(`/api/session/${sessionId}/plan/ops`, {
    method: 'POST',
    headers: { origin: baseUrl(lock) },
    body: JSON.stringify({ ops: [{ op: 'upsert_task', title: 'from the page' }] }),
  });
  assert.equal(own.status, 200, 'the page itself is allowed');
});

test('without the token, nothing is served', async () => {
  const res = await fetch(`${baseUrl(lock)}/api/sessions`);
  assert.equal(res.status, 401);
});

test('a stale diagram save is refused over HTTP and changes nothing', async () => {
  const before = (await session()).plan!.diagrams[0]!;
  await mcp('edit', { ops: [{ op: 'upsert_diagram', id: before.id, caption: 'Claude moved first' }] });
  const res = await ops([{ op: 'upsert_diagram', id: before.id, caption: 'stale', expect: before.rev }]);
  assert.match(res.error ?? '', /changed by Claude while this edit was open/);
  assert.equal((await session()).plan!.diagrams[0]!.caption, 'Claude moved first');
});

test('a batch too large to apply whole is refused, not truncated', async () => {
  const before = (await session()).plan!.tasks.length;
  const many = Array.from({ length: 201 }, (_, i) => ({ op: 'upsert_task', title: `bulk ${i}` }));
  const res = await raw(`/api/session/${sessionId}/plan/ops`, { method: 'POST', body: JSON.stringify({ ops: many }) });
  assert.equal(res.status, 400);
  const viaClaude = await mcp('edit', { ops: many });
  assert.equal(viaClaude['ok'], false);
  assert.equal((await session()).plan!.tasks.length, before, 'none of it applied');
});

/* ------------------------------------------------------------------ *
 * Submitting the plan, and following the build
 * ------------------------------------------------------------------ */

const built = 'submit-session';
const opsOn = (id: string, list: unknown[]) =>
  call<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${id}/plan/ops`, { method: 'POST', body: JSON.stringify({ ops: list }) });
const post = <T>(route: string, body: Record<string, unknown> = {}) => call<T>(route, { method: 'POST', body: JSON.stringify(body) });
type Preview = { prompt: string; trimmed: boolean; version: number; budget: number; blocks: Block[] };

test('the prompt preview is the prompt, and reading it changes nothing', async () => {
  await hookFor(built, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(built, 'publish', PLAN);
  await opsOn(built, [{ op: 'upsert_task', title: 'Load test' }]);
  const before = await sessionFor(built);
  const preview = await post<Preview>(`/api/session/${built}/plan/prompt`, { target: 'session', note: 'Start with the client.' });
  assert.match(preview.prompt, /^\[cc-harness\] Build the plan "Add a cache"/);
  assert.match(preview.prompt, /> Start with the client\./);
  assert.match(preview.prompt, /Added t\d+ "Load test"/, 'the edit Claude has not read leads');
  // Block by block, each with its source; joined, they are the prompt.
  assert.equal(blocksText(preview.blocks), preview.prompt);
  assert.ok(preview.blocks.every((b) => b.source && b.id));
  assert.equal(preview.blocks.find((b) => b.id === 'note')?.source.kind, 'note');
  assert.equal(preview.blocks.find((b) => b.id === 'changes')?.source.kind, 'changes');
  assert.equal(preview.version, before.plan!.version);
  const after = await sessionFor(built);
  assert.equal(after.plan!.version, before.plan!.version);
  assert.equal(after.plan!.submission, undefined);
});

test('confirming the design locks it, and the next message asks Claude for the task list — once', async () => {
  const preview = await post<Preview>(`/api/session/${built}/plan/design/prompt`, { note: 'Split the storage work.' });
  assert.match(preview.prompt, /^\[cc-harness\] The design is confirmed for "Add a cache"/);
  assert.equal(blocksText(preview.blocks), preview.prompt);
  assert.match(preview.prompt, /harness_tasks_publish/);
  assert.match(preview.prompt, /> Split the storage work\./);
  const res = await post<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${built}/plan/design/confirm`, {
    note: 'Split the storage work.',
    expect: preview.version,
  });
  assert.ok(res.plan, res.error);
  assert.equal(res.plan!.design?.prompt, preview.prompt);
  const { sessions } = await call<{ sessions: { sessionId: string; phase: string }[] }>('/api/sessions');
  assert.equal(sessions.find((s) => s.sessionId === built)?.phase, 'tasking');

  const redesign = await opsOn(built, [{ op: 'upsert_diagram', id: 'd1', title: 'Different' }]);
  assert.match(redesign.error ?? '', /design is confirmed/);
  const retask = await opsOn(built, [{ op: 'upsert_task', id: 't4', title: 'Wire it in' }]);
  assert.ok(retask.plan, retask.error);

  // Edited after confirming: not in the prompt, so Claude is told to read it.
  const first = await hookFor(built, 'UserPromptSubmit', { prompt: 'go' });
  const handed = String(first.hookSpecificOutput?.additionalContext ?? '');
  assert.ok(handed.startsWith(preview.prompt));
  assert.match(handed.slice(preview.prompt.length), /\[cc-harness\] The user has changed the plan "Add a cache" in the harness UI since you last read it \(tasks\)/);
  const s = await sessionFor(built);
  assert.ok(s.plan!.design!.deliveredAt);
  await mcpFor(built, 'read');
  const second = await hookFor(built, 'UserPromptSubmit', { prompt: 'and?' });
  assert.equal(second.hookSpecificOutput?.additionalContext, undefined);
});

test('Claude publishes the task list: linked tasks, the boxes they build, and what can start', async () => {
  const republish = await mcpFor(built, 'publish', PLAN);
  assert.equal(republish['ok'], false);
  assert.match(String(republish['text']), /confirmed the design/);

  const loop = await mcpFor(built, 'tasks', {
    tasks: [
      { id: 'a', title: 'A', dependsOn: ['b'] },
      { id: 'b', title: 'B', dependsOn: ['a'] },
    ],
  });
  assert.equal(loop['ok'], false);
  assert.match(String(loop['text']), /wait on each other/);

  const res = await mcpFor(built, 'tasks', {
    tasks: [
      {
        id: 't1',
        title: 'Storage',
        branch: 'cache/storage',
        subtasks: [
          { id: 't2', title: 'Client', builds: ['db'], files: ['src/cache.ts'], detail: 'Wrap the driver.' },
          { id: 't3', title: 'Invalidation', dependsOn: ['t2'] },
        ],
      },
      { id: 't4', title: 'Wire up', dependsOn: ['t1'], builds: ['api'], branch: 'cache/api' },
    ],
  });
  assert.equal(res['ok'], true, String(res['text']));
  const text = String(res['text']);
  assert.match(text, /Published the task list/);
  // Start when the user says so, in chat or in Coplan — never told to wait for a click (#65).
  assert.match(text, /Start building when they say so: when they tell you here to go ahead, call harness_plan_advance/);
  assert.doesNotMatch(text, /Do not start building/);
  assert.match(text, /## Build order/);
  assert.match(text, /`cache\/api` from `cache\/storage` \(stacked\)/);

  const s = await sessionFor(built);
  assert.deepEqual(s.plan!.diagrams[0]!.nodes.find((n) => n.id === 'db')?.taskIds, ['t2']);
  assert.deepEqual(s.plan!.tasks.find((t) => t.id === 't3')?.dependsOn, ['t2']);
  assert.equal(s.plan!.tasks.length, 4);

  const next = String((await mcpFor(built, 'next'))['text']);
  assert.match(next, /The plan is not submitted yet/);
  assert.match(next, /## Ready to start \(1\)\n- t2 Client/);
  assert.match(next, /t3 Invalidation — waits on t2/);
  assert.match(next, /t4 Wire up — waits on t1/);

  const brief = String((await mcpFor(built, 'brief', { task_id: 't4' }))['text']);
  assert.match(brief, /^# Task t4: Wire up/);
  assert.match(brief, /\*\*API\*\* `api` in "Components"/);
  assert.match(brief, /Cut it from `cache\/storage`/);
  assert.match(brief, /cannot start yet: it waits on t1 Storage/);
  assert.match(brief, /harness_task_update \{task_id: "t4"/);

  const early = await mcpFor(built, 'task', { task_id: 't4', status: 'in_progress' });
  assert.equal(early['ok'], false);
  assert.match(String(early['text']), /"Wire up" cannot start yet: it waits on t1 "Storage"/);
  // Blocking it first is no way round that.
  await mcpFor(built, 'task', { task_id: 't4', status: 'blocked', note: 'waiting' });
  for (const body of [{ status: 'in_progress' }, { stage: 'implement' }]) {
    const resumed = await mcpFor(built, 'task', { task_id: 't4', ...body });
    assert.equal(resumed['ok'], false, JSON.stringify(body));
  }
  await mcpFor(built, 'task', { task_id: 't4', status: 'todo' });
});

test('a task goes round implement → review → refine, and is not done while its checks fail', async () => {
  const start = await mcpFor(built, 'task', { task_id: 't2', stage: 'implement' });
  assert.equal(start['ok'], true, String(start['text']));
  assert.match(String(start['text']), /"Client" is implementing/);
  const review = await mcpFor(built, 'task', { task_id: 't2', stage: 'review', checks: [{ name: 'tests', ok: false, note: '1 failing' }] });
  assert.match(String(review['text']), /in review, round 1/);
  assert.match(String(review['text']), /Checks: 1 failed \(tests\)/);
  const early = await mcpFor(built, 'task', { task_id: 't2', status: 'done' });
  assert.equal(early['ok'], false);
  assert.match(String(early['text']), /not done: its last checks failed \(tests: 1 failing\)/);
  // A malformed report cannot wipe the failure out.
  const sloppy = await mcpFor(built, 'task', { task_id: 't2', status: 'done', checks: [{ name: 'tests', ok: 'false' }] });
  assert.equal(sloppy['ok'], false);
  assert.match(String(sloppy['text']), /`ok` true or false/);
  assert.equal((await sessionFor(built)).plan!.tasks.find((t) => t.id === 't2')?.checks?.[0]?.ok, false);
  await mcpFor(built, 'task', { task_id: 't2', stage: 'refine' });
  await mcpFor(built, 'task', { task_id: 't2', stage: 'review', checks: [{ name: 'tests', ok: true }] });
  const done = await mcpFor(built, 'task', { task_id: 't2', status: 'done', verdict: 'pass', note: 'wrapped the driver' });
  assert.equal(done['ok'], true, String(done['text']));
  assert.match(String(done['text']), /Now ready: t3 "Invalidation"/);
  const s = await sessionFor(built);
  const t2 = s.plan!.tasks.find((t) => t.id === 't2')!;
  assert.equal(t2.round, 2);
  assert.equal(t2.stage, undefined, 'done is out of the cycle');
});

test('a submission made against an older preview is refused', async () => {
  const { version } = await post<Preview>(`/api/session/${built}/plan/prompt`, { target: 'session' });
  await mcpFor(built, 'task', { task_id: 't3', status: 'in_progress' });
  const res = await post<{ error?: string }>(`/api/session/${built}/plan/submit`, { target: 'session', expect: version });
  assert.match(res.error ?? '', /changed while you were reviewing it/);
  assert.equal((await sessionFor(built)).plan!.submission, undefined);
});

test('a submission whose prompt changed since the preview is refused, even at the same version', async () => {
  // The preview quotes an edit the agent has not read …
  await opsOn(built, [{ op: 'upsert_task', id: 't4', note: 'the user wants this last' }]);
  const preview = await post<Preview & { hash: string }>(`/api/session/${built}/plan/prompt`, { target: 'session' });
  assert.match(preview.prompt, /Since you last read/);
  // … then the agent reads the plan: same version, different prompt.
  await mcpFor(built, 'read', {});
  const res = await post<{ error?: string }>(`/api/session/${built}/plan/submit`, { target: 'session', expect: preview.version, hash: preview.hash });
  assert.match(res.error ?? '', /The prompt changed since you previewed it/);
  assert.equal((await sessionFor(built)).plan!.submission, undefined);
});

test('a sign-off the hook did not hand over comes with the next harness_plan_read, for any agent', async () => {
  const id = 'handover-session';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await post(`/api/session/${id}/plan/design/confirm`);
  const read = String((await mcpFor(id, 'read', {}))['text']);
  assert.match(read, /^\[cc-harness\] The design is confirmed/);
  assert.ok((await sessionFor(id)).plan!.design!.deliveredAt);
  // Once: the next read is the plan.
  assert.doesNotMatch(String((await mcpFor(id, 'read', {}))['text']), /^\[cc-harness\] The design is confirmed/);
});

test('submitting locks the plan with exactly the previewed prompt', async () => {
  const settings = { review: 'self', parallel: 3, maxRounds: 2 };
  const preview = await post<Preview & { settings: unknown }>(`/api/session/${built}/plan/prompt`, { target: 'session', note: 'Go.', settings });
  assert.deepEqual(preview.settings, settings);
  assert.match(preview.prompt, /Review: self-review/);
  const res = await post<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${built}/plan/submit`, {
    target: 'session',
    note: 'Go.',
    expect: preview.version,
    settings,
  });
  assert.ok(res.plan, res.error);
  assert.equal(res.plan!.submission?.prompt, preview.prompt);
  assert.deepEqual(res.plan!.submission?.settings, settings);
  assert.equal(res.plan!.submission?.deliveredAt, null);

  const { sessions } = await call<{ sessions: { sessionId: string; phase: string }[] }>('/api/sessions');
  assert.equal(sessions.find((s) => s.sessionId === built)?.phase, 'submitted');

  const edit = await opsOn(built, [{ op: 'upsert_task', title: 'sneak in' }]);
  assert.match(edit.error ?? '', /locked/);
  const again = await post<{ error?: string }>(`/api/session/${built}/plan/submit`, { target: 'session' });
  assert.match(again.error ?? '', /already been submitted/);
});

test("the user's next message in Claude carries the prompt — once", async () => {
  const first = await hookFor(built, 'UserPromptSubmit', { prompt: 'go' });
  const s = await sessionFor(built);
  assert.equal(first.hookSpecificOutput?.additionalContext, s.plan!.submission!.prompt);
  assert.notEqual(first.decision, 'block', 'delivering never holds the turn');
  assert.ok(s.plan!.submission!.deliveredAt);
  assert.equal(s.plan!.claudeReadSeq, s.plan!.seq, 'the prompt is Claude reading the plan');

  const second = await hookFor(built, 'UserPromptSubmit', { prompt: 'and go on' });
  assert.equal(second.hookSpecificOutput?.additionalContext, undefined);
  const { sessions } = await call<{ sessions: { sessionId: string; phase: string }[] }>('/api/sessions');
  assert.equal(sessions.find((x) => x.sessionId === built)?.phase, 'building');
});

test('while building, Claude tracks tasks but cannot redesign', async () => {
  const redesign = await mcpFor(built, 'edit', { ops: [{ op: 'upsert_diagram', id: 'd1', title: 'Different' }] });
  assert.equal(redesign['ok'], false);
  assert.match(String(redesign['text']), /submitted this plan to be built, so it is locked/);
  const republish = await mcpFor(built, 'publish', { ...PLAN, title: 'Something else' });
  assert.equal(republish['ok'], false);
  const read = String((await mcpFor(built, 'read', {}))['text']);
  assert.match(read, /Locked for building/);
  const discovered = await mcpFor(built, 'edit', { ops: [{ op: 'upsert_task', parentId: 't1', title: 'Handle timeouts' }] });
  assert.equal(discovered['ok'], true, String(discovered['text']));
  const next = String((await mcpFor(built, 'next'))['text']);
  assert.match(next, /up to 3 at once · review: self · at most 2 review rounds/, 'the settings the user chose');
});

test('finishing the last task finishes the build, and a new plan may follow', async () => {
  const s = await sessionFor(built);
  const leaves = s.plan!.tasks.filter((t) => !s.plan!.tasks.some((c) => c.parentId === t.id));
  let last: Record<string, unknown> = {};
  // In the order they become ready: a task cannot start, or be done, while
  // it still waits on another.
  let left = leaves.filter((t) => t.status !== 'done').map((t) => t.id);
  for (let pass = 0; left.length && pass < 10; pass++) {
    for (const id of [...left]) {
      if (!(await mcpFor(built, 'task', { task_id: id, stage: 'review' }))['ok']) continue;
      last = await mcpFor(built, 'task', { task_id: id, status: 'done', verdict: 'pass', note: 'done' });
      left = left.filter((x) => x !== id);
    }
  }
  assert.deepEqual(left, []);
  assert.match(String(last['text']), /That was the last task. Finish the build/);
  const { sessions: finishing } = await call<{ sessions: { sessionId: string; phase: string }[] }>('/api/sessions');
  assert.equal(finishing.find((x) => x.sessionId === built)?.phase, 'finalizing');
  const finish = String((await mcpFor(built, 'next'))['text']);
  assert.match(finish, /Every task in "Add a cache" is done/);
  assert.match(finish, /Push each branch, in stack order: `cache\/storage` → `cache\/api` \(onto `cache\/storage`\)/);
  assert.match(finish, /Open the pull requests with `gh pr create`, each against the branch below it .*, once the user says to: ask them first/, 'by default, gh, once the user says');
  assert.match(finish, /op: "report"/);

  // The pull requests, as they are opened and merged: the stack follows.
  const pr = (body: Record<string, unknown>) => mcpFor(built, 'branch', body);
  assert.equal((await pr({ branch: 'cache/storage', pr_url: 'https://github.com/o/r/pull/11', pr_number: 11, pr_state: 'open' }))['ok'], true);
  await pr({ branch: 'cache/api', pr_url: 'https://github.com/o/r/pull/12', pr_number: 12, pr_state: 'open' });
  assert.match(String((await pr({ branch: 'nope', pr_state: 'open' }))['text']), /No task lands on `nope`/);
  const merged = String((await pr({ branch: 'cache/storage', pr_state: 'merged' }))['text']);
  assert.match(merged, /`cache\/storage` is merged: rebase `cache\/api` onto the base branch/);
  assert.match(String((await mcpFor(built, 'next'))['text']), /`cache\/api` onto `cache\/storage` \(stacked\): pull request #12 open — https:\/\/github\.com\/o\/r\/pull\/12\n {2}⚠ `cache\/storage` is merged/);
  assert.doesNotMatch(String((await pr({ branch: 'cache/api', base: 'main' }))['text']), /The stack moved/, 'restacked onto main');
  assert.equal((await sessionFor(built)).plan!.branches!['cache/api']!.pr!.number, 12);

  const report = await mcpFor(built, 'edit', { ops: [{ op: 'report', text: '## Built\n- Storage, Wire up' }] });
  assert.equal(report['ok'], true, String(report['text']));
  assert.match(String((await mcpFor(built, 'read'))['text']), /## Build report\n## Built/);
  const { sessions } = await call<{ sessions: { sessionId: string; phase: string }[] }>('/api/sessions');
  assert.equal(sessions.find((x) => x.sessionId === built)?.phase, 'built');
  const next = await mcpFor(built, 'publish', { ...PLAN, title: 'Next feature' });
  assert.equal(next['ok'], true, String(next['text']));
  assert.equal((await sessionFor(built)).plan!.submission, undefined);
});

test('a prompt the user pasted themselves is not delivered a second time', async () => {
  const id = 'paste-session';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await post(`/api/session/${id}/plan/design/confirm`);
  const { version, prompt } = await post<Preview>(`/api/session/${id}/plan/prompt`, { target: 'session' });
  await post(`/api/session/${id}/plan/submit`, { target: 'session', expect: version });
  const out = await hookFor(id, 'UserPromptSubmit', { prompt });
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
  assert.ok((await sessionFor(id)).plan!.submission!.deliveredAt, 'but it is counted as delivered');
});

test('a plan handed off elsewhere is locked but never delivered here, and can be reopened', async () => {
  const id = 'elsewhere-session';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await post(`/api/session/${id}/plan/design/confirm`);
  const preview = await post<Preview>(`/api/session/${id}/plan/prompt`, { target: 'elsewhere' });
  assert.doesNotMatch(preview.prompt, /harness_/);
  await post(`/api/session/${id}/plan/submit`, { target: 'elsewhere', expect: preview.version });
  const out = await hookFor(id, 'UserPromptSubmit', { prompt: 'hello' });
  assert.equal(out.hookSpecificOutput?.additionalContext, undefined);
  assert.equal((await sessionFor(id)).plan!.submission!.deliveredAt, null);

  const reopened = await post<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${id}/plan/reopen`);
  assert.ok(reopened.plan, reopened.error);
  assert.equal(reopened.plan!.submission, undefined);
  const edit = await opsOn(id, [{ op: 'upsert_task', title: 'after reopening' }]);
  assert.ok(edit.plan, edit.error);
  const twice = await post<{ error?: string }>(`/api/session/${id}/plan/reopen`);
  assert.match(twice.error ?? '', /not locked/);

  const design = await post<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${id}/plan/design/reopen`);
  assert.ok(design.plan, design.error);
  assert.equal(design.plan!.design, undefined);
  const redesign = await opsOn(id, [{ op: 'upsert_diagram', id: 'd1', title: 'Different' }]);
  assert.ok(redesign.plan, redesign.error);
});

test("the repository's .coplan/config.json reaches the prompts, the briefs and the done check", async () => {
  const id = 'checks-session';
  const dir = path.join(repo, '.coplan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'config.json'),
    [
      '{',
      '  // what the build runs',
      '  "hooks": {',
      '    "implement": ["npm run typecheck"],',
      '    "review": [{ "name": "tests", "run": "npm test" }, { "name": "lint", "run": "npm run lint", "optional": true }]',
      '  },',
      '  "iric": { "review": "self", "parallel": 1, "maxRounds": 2 },',
      '  "branches": { "base": "main" }',
      '}',
    ].join('\n'),
  );
  try {
    await hookFor(id, 'SessionStart', { start_reason: 'startup' });
    await mcpFor(id, 'publish', PLAN);
    const design = await post<Preview & { project: { checks: Record<string, string[]>; config: ConfigRow[] } }>(`/api/session/${id}/plan/design/prompt`);
    assert.deepEqual(design.project.checks['review'], ['tests', 'lint']);
    // Read-only in the dialog, with where each is set.
    const row = (key: string) => design.project.config.find((r) => r.key === key);
    assert.deepEqual(row('hooks.review'), { key: 'hooks.review', label: 'Review checks', value: 'tests, lint', files: ['.coplan/config.json'] });
    assert.deepEqual(row('iric.review'), { key: 'iric.review', label: 'Review, by default', value: 'self-review', files: ['.coplan/config.json'] });
    assert.equal(row('hooks.final')?.files.length, 0, 'set nowhere');
    assert.deepEqual(
      design.blocks.find((b) => b.id === 'checks:review')?.source,
      { kind: 'config', key: 'hooks.review', files: ['.coplan/config.json'] },
    );
    assert.match(design.prompt, /- review: tests `npm test`; lint `npm run lint` \(optional\)/);
    const build = await post<Preview & { settings: unknown }>(`/api/session/${id}/plan/prompt`, { target: 'session' });
    assert.deepEqual(build.settings, { review: 'self', parallel: 1, maxRounds: 2 }, "the repository's defaults");

    const brief = String((await mcpFor(id, 'brief', { task_id: 't2' }))['text']);
    assert.match(brief, /- typecheck: `npm run typecheck`/);
    assert.match(brief, /- tests: `npm test`/);
    assert.match(brief, /Review: self-review/);

    // An optional check failing does not hold a task back; a required one does.
    await mcpFor(id, 'task', { task_id: 't2', stage: 'review', checks: [{ name: 'tests', ok: true }, { name: 'lint', ok: false }] });
    const done = await mcpFor(id, 'task', { task_id: 't2', status: 'done', verdict: 'pass' });
    assert.equal(done['ok'], true, String(done['text']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repository's customizations reach the agent, and its errors and final checks hold what they say", async () => {
  const id = 'custom-session';
  const dir = path.join(repo, '.coplan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(repo, 'PR_TEMPLATE.md'), '## Summary\n\n## How it was tested\n');
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      hooks: { final: [{ name: 'suite', run: 'npm test' }, { name: 'audit', run: 'npm audit', optional: true }] },
      pullRequests: { tool: 'graphite', open: 'auto', template: 'PR_TEMPLATE.md' },
      // The reviewer's model is for a subagent's review, which is no longer the default (#63).
      iric: { review: 'subagent' },
      review: { model: 'opus' },
      final: { blocking: true },
      instructions: { design: 'Name every box after its service.', brief: 'Write the test first.', review: 'Look for unparameterised SQL.' },
      planCheck: { 'box-undescribed': 'error', 'comment-unanswered': 'off' },
    }),
  );
  try {
    await hookFor(id, 'SessionStart', { start_reason: 'startup' });
    await mcpFor(id, 'publish', PLAN);

    // The repository's own words, where the agent reads them.
    const design = await post<Preview & { project: { planCheck: Record<string, string> } }>(`/api/session/${id}/plan/design/prompt`);
    assert.match(design.prompt, /## Standing instructions[\s\S]*Name every box after its service\./);
    assert.deepEqual(design.project.planCheck, { 'box-undescribed': 'error', 'comment-unanswered': 'off' }, 'the page is told how gaps count');
    const opened = await call<{ planCheck?: Record<string, string>; projectReview?: string }>(`/api/session/${id}`);
    assert.deepEqual(opened.planCheck, { 'box-undescribed': 'error', 'comment-unanswered': 'off' }, 'and so is the canvas, which marks the boxes the check lists');
    assert.equal(opened.projectReview, 'subagent', "and the board, who reviews where the plan does not say");
    const brief = String((await mcpFor(id, 'brief', { task_id: 't2' }))['text']);
    assert.match(brief, /Write the test first\./);
    assert.match(brief, /Run the reviewer on the `opus` model\./);
    assert.match(brief, /### What the review checks here[\s\S]*Look for unparameterised SQL\./);

    // A gap the repository counts as an error holds the sign-off, and says so.
    const check = String((await mcpFor(id, 'check'))['text']);
    assert.match(check, /⛔ \(holds Confirm and Submit\) Box "API" in "Components" has no description/);
    const refused = await post<{ error?: string }>(`/api/session/${id}/plan/design/confirm`, {});
    assert.match(refused.error ?? '', /cannot be confirmed yet: this repository's plan check[\s\S]*Box "API"/);

    // The final checks hold the report until the required ones pass.
    const report = (checks?: unknown[]) => mcpFor(id, 'edit', { ops: [{ op: 'report', text: 'Built it.', ...(checks ? { checks } : {}) }] });
    const missing = await report();
    assert.equal(missing['ok'], false);
    assert.match(String(missing['text']), /holds the build report until its final checks pass[\s\S]*Not reported in `checks`: suite/);
    const failing = await report([{ name: 'suite', ok: false }]);
    assert.match(String(failing['text']), /Failing: suite\./);
    const passed = await report([{ name: 'suite', ok: true }, { name: 'audit', ok: false }]);
    assert.equal(passed['ok'], true, `an optional check does not hold it: ${String(passed['text'])}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.join(repo, 'PR_TEMPLATE.md'), { force: true });
  }
});

test('an audit proposes instead of overwriting: the user answers in Coplan, and Claude reads the answer once', async () => {
  const id = 'propose-session';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  const made = await mcpFor(id, 'propose', {
    title: 'Add a cache in front of Postgres',
    reason: 'Reads are slow (see Context).',
    ops: [
      { op: 'upsert_node', diagramId: 'd1', id: 'cache', label: 'Redis', kind: 'datastore' },
      { op: 'upsert_edge', diagramId: 'd1', from: 'api', to: 'cache', label: 'get' },
    ],
  });
  assert.equal(made['ok'], true, String(made['text']));
  assert.match(String(made['text']), /Proposed p1 "Add a cache in front of Postgres" \(2 edits\)\. Nothing has changed yet/);
  assert.ok(!(await sessionFor(id)).plan!.diagrams[0]!.nodes.some((n) => n.id === 'cache'), 'nothing changed');
  assert.match(String((await mcpFor(id, 'read', { changes_only: true }))['text']), /p1 "Add a cache in front of Postgres" — waiting on the user \(2 edits\)/);

  // Only the user answers it.
  const self = await mcpFor(id, 'edit', { ops: [{ op: 'accept_proposal', id: 'p1' }] });
  assert.equal(self['ok'], false);
  const accepted = await opsOn(id, [{ op: 'accept_proposal', id: 'p1' }]);
  assert.equal(accepted.error, undefined, accepted.error);
  assert.ok(accepted.plan!.diagrams[0]!.nodes.some((n) => n.id === 'cache' && n.label === 'Redis'));

  const read = String((await mcpFor(id, 'read', {}))['text']);
  assert.match(read, /p1 "Add a cache in front of Postgres" — \*\*accepted\*\* by the user/);
  assert.doesNotMatch(String((await mcpFor(id, 'read', {}))['text']), /accepted\*\* by the user/, 'heard once');

  // A second one, rejected with a reason.
  await mcpFor(id, 'propose', { title: 'Drop Postgres', reason: 'Simpler.', ops: [{ op: 'remove_node', diagramId: 'd1', id: 'db' }] });
  await opsOn(id, [{ op: 'reject_proposal', id: 'p2', note: 'We need durability.' }]);
  assert.match(String((await mcpFor(id, 'read', { changes_only: true }))['text']), /p2 "Drop Postgres" — \*\*rejected\*\* by the user: We need durability\./);
});

test('the build gates hold however the agent reports progress, and only the user lifts them', async () => {
  const id = 'gates-session';
  const dir = path.join(repo, '.coplan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      hooks: { review: [{ name: 'tests', run: 'npm test' }, { name: 'lint', run: 'npm run lint', optional: true }] },
      iric: { review: 'self', parallel: 1, maxRounds: 2 },
    }),
  );
  const task = (body: Record<string, unknown>) => mcpFor(id, 'task', body);
  const refused = async (body: Record<string, unknown>, why: RegExp) => {
    const res = await task(body);
    assert.equal(res['ok'], false, `expected a refusal: ${String(res['text'])}`);
    assert.match(String(res['text']), why);
  };
  try {
    await hookFor(id, 'SessionStart', { start_reason: 'startup' });
    await mcpFor(id, 'publish', PLAN);

    // Progress cannot go round harness_task_update through an edit.
    const sneak = await mcpFor(id, 'edit', { ops: [{ op: 'upsert_task', id: 't2', status: 'done' }] });
    assert.equal(sneak['ok'], false);
    assert.match(String(sneak['text']), /report progress with harness_task_update/);

    // A parent's progress is its subtasks'.
    await refused({ task_id: 't1', stage: 'implement' }, /has subtasks/);

    // Not done while it waits, not started past the parallel limit.
    await mcpFor(id, 'edit', { ops: [{ op: 'upsert_task', id: 't4', dependsOn: ['t1'] }] });
    await refused({ task_id: 't4', status: 'done', note: 'x' }, /cannot be done yet: it waits on/);
    assert.equal((await task({ task_id: 't2', stage: 'implement' }))['ok'], true);
    await refused({ task_id: 't3', stage: 'implement' }, /the user allowed 1 at once/);

    // A refine that re-runs only the typecheck does not erase the failing tests.
    await task({ task_id: 't2', stage: 'review', checks: [{ name: 'tests', ok: false, note: '1 failing' }] });
    await task({ task_id: 't2', stage: 'refine', checks: [{ name: 'typecheck', ok: true }] });
    await refused({ task_id: 't2', status: 'done', note: 'x' }, /its last checks failed \(tests: 1 failing\)/);

    // Round 2 of 2 is the last; a third needs the user, and says what they said.
    await task({ task_id: 't2', stage: 'review' });
    assert.equal((await task({ task_id: 't2', stage: 'review', checks: [{ name: 'tests', ok: false }] }))['ok'], true, 'reporting in review is the same round');
    await task({ task_id: 't2', stage: 'refine' });
    await refused({ task_id: 't2', stage: 'review' }, /the most the user allowed \(2\)/);
    // Nor can the agent start it over to get its rounds back.
    await task({ task_id: 't2', status: 'todo' });
    await task({ task_id: 't2', stage: 'implement' });
    await refused({ task_id: 't2', stage: 'review' }, /the most the user allowed \(2\)/);
    await refused({ task_id: 't2', stage: 'review', user_approved: true }, /needs a `note`/);
    const extra = await task({ task_id: 't2', stage: 'review', user_approved: true, note: 'user: one more round' });
    assert.equal(extra['ok'], true, String(extra['text']));
    // Accepting it as it is, too, is theirs to say.
    const accepted = await task({ task_id: 't2', status: 'done', user_approved: true, note: 'user accepted the flaky test' });
    assert.equal(accepted['ok'], true, String(accepted['text']));
    assert.match((await sessionFor(id)).plan!.tasks.find((t) => t.id === 't2')!.note ?? '', /approved by the user/);

    // A required review check that was never reported holds it back.
    await task({ task_id: 't3', stage: 'implement' });
    await task({ task_id: 't3', stage: 'review', checks: [{ name: 'lint', ok: true }] });
    await refused({ task_id: 't3', status: 'done', note: 'x' }, /the review checks tests were never reported/);
    await task({ task_id: 't3', checks: [{ name: 'tests', ok: true }] });
    assert.equal((await task({ task_id: 't3', status: 'done', verdict: 'pass', note: 'done' }))['ok'], true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each build gate refuses in a Managed build, and in a Tracked one is a note that says what was skipped (#62)', async () => {
  const dir = path.join(repo, '.coplan');
  const GATED = {
    title: 'Gates',
    summary: 'One task per gate.',
    tasks: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((id) => ({ id, title: id.toUpperCase(), ...(id === 'e' ? { review: 'user' as const } : {}) })),
  };
  for (const mode of ['managed', 'tracked'] as const) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ mode, hooks: { review: [{ name: 'tests', run: 'npm test' }] }, iric: { review: 'self', parallel: 1, maxRounds: 1 } }),
    );
    const id = `gate-${mode}-session`;
    const task = (body: Record<string, unknown>) => mcpFor(id, 'task', body);
    /** A gate: refused when Managed, a note when Tracked — then settled the
     *  way the user would settle it, so the next gate starts clean. */
    const gate = async (body: Record<string, unknown>, refusal: RegExp, note: RegExp) => {
      const res = await task(body);
      const text = String(res['text']);
      if (mode === 'managed') {
        assert.equal(res['ok'], false, `Managed refuses: ${text}`);
        assert.match(text, refusal);
      } else {
        assert.equal(res['ok'], true, `Tracked does not: ${text}`);
        assert.match(text, /Noted, not refused \(this build is Tracked\): /);
        assert.match(text, note);
      }
    };
    const settle = async (taskId: string) => {
      const res = await task({ task_id: taskId, status: 'done', user_approved: true, note: 'user: take it as it is' });
      assert.equal(res['ok'], true, String(res['text']));
    };
    try {
      await hookFor(id, 'SessionStart', { start_reason: 'startup' });
      await mcpFor(id, 'publish', GATED);
      await post(`/api/session/${id}/plan/design/confirm`);
      await hookFor(id, 'UserPromptSubmit', { prompt: 'go' });
      // Submit starts from the repository's mode, and the submission keeps it.
      const preview = await post<Preview & { mode: string; project: { mode: string } }>(`/api/session/${id}/plan/prompt`, {});
      assert.equal(preview.mode, mode);
      assert.equal(preview.project.mode, mode);
      assert[mode === 'tracked' ? 'doesNotMatch' : 'match'](preview.prompt, /implement → review → refine/);
      const submitted = await post<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${id}/plan/submit`, {
        mode,
        expect: preview.version,
        settings: { review: 'self', parallel: 1, maxRounds: 1 },
      });
      assert.ok(submitted.plan, submitted.error);
      assert.equal(submitted.plan!.submission?.mode, mode);
      assert.equal(submitted.plan!.submission?.settings !== undefined, mode === 'managed', "only a Managed build keeps the cycle's settings");
      await hookFor(id, 'UserPromptSubmit', { prompt: 'build it' });

      // Done before any review round.
      await task({ task_id: 'a', status: 'in_progress' });
      await gate({ task_id: 'a', status: 'done', note: 'x' }, /"A" has not been reviewed/, /it was never reviewed \(no review round was reported\)/);
      await settle('a');
      // Done while a check fails.
      await task({ task_id: 'b', stage: 'implement' });
      await task({ task_id: 'b', stage: 'review', checks: [{ name: 'tests', ok: false, note: '1 failing' }] });
      await gate({ task_id: 'b', status: 'done', verdict: 'pass', note: 'x' }, /its last checks failed \(tests: 1 failing\)/, /its last checks failed \(tests: 1 failing\)/);
      await settle('b');
      // Done with a required check never reported.
      await task({ task_id: 'c', stage: 'implement' });
      await task({ task_id: 'c', stage: 'review' });
      await gate({ task_id: 'c', status: 'done', verdict: 'pass', note: 'x' }, /the review checks tests were never reported/, /the review checks tests were never reported/);
      await settle('c');
      // Done without a passing verdict.
      await task({ task_id: 'd', stage: 'implement' });
      await task({ task_id: 'd', stage: 'review', checks: [{ name: 'tests', ok: true }] });
      await gate({ task_id: 'd', status: 'done', note: 'x' }, /no passing verdict for review round 1/, /no passing verdict for review round 1/);
      await settle('d');
      // Done on the agent's word when the user reviews it.
      await task({ task_id: 'e', stage: 'implement' });
      await task({ task_id: 'e', stage: 'review', checks: [{ name: 'tests', ok: true }] });
      await gate({ task_id: 'e', status: 'done', verdict: 'pass', note: 'x' }, /the user's to review, and they have not passed it/, /it is the user's to review, and they have not passed it/);
      await settle('e');
      // Another review round past the limit.
      await task({ task_id: 'f', stage: 'implement' });
      await task({ task_id: 'f', stage: 'review' });
      await task({ task_id: 'f', stage: 'refine' });
      await gate(
        { task_id: 'f', stage: 'review' },
        /the most the user allowed \(1\)\. Stop: .*stage "review" for another round, status "done" to accept it/,
        /this is review round 2, past the 1 the user set: say in the task's note why another round is worth it/,
      );
      await settle('f');
      // A start past the parallel limit.
      await task({ task_id: 'g', stage: 'implement' });
      await gate({ task_id: 'h', stage: 'implement' }, /the user allowed 1 at once/, /1 other task is in progress too \(g\)/);
      await settle('g');
      await settle('h');
      // Dropping work the user signed off.
      await gate({ task_id: 'i', status: 'dropped', note: 'not needed' }, /dropping it is theirs to decide/, /it was part of the plan the user submitted: tell them you dropped it/);
      // A finished task dropped and taken up again: its pass went, so done points to a new review round, which
      // the round limit does not hold against it (the last round passed).
      await task({ task_id: 'j', stage: 'implement' });
      await task({ task_id: 'j', stage: 'review', checks: [{ name: 'tests', ok: true }] });
      const passed = await task({ task_id: 'j', status: 'done', verdict: 'pass', note: 'passes' });
      assert.equal(passed['ok'], true, String(passed['text']));
      assert.equal((await task({ task_id: 'j', status: 'dropped', note: 'user: drop it', user_approved: true }))['ok'], true);
      assert.equal((await task({ task_id: 'j', status: 'in_progress' }))['ok'], true);
      await gate(
        { task_id: 'j', status: 'done', note: 'x' },
        /"J" is not in review: its last pass went when it was taken up again\. Report stage "review" \(a new round\)/,
        /not in review: its last pass went when it was taken up again/,
      );
      if (mode === 'managed') {
        const again = await task({ task_id: 'j', stage: 'review', checks: [{ name: 'tests', ok: true }] });
        assert.equal(again['ok'], true, `a new round, past the limit: ${String(again['text'])}`);
        const done = await task({ task_id: 'j', status: 'done', verdict: 'pass', note: 'passes again' });
        assert.equal(done['ok'], true, String(done['text']));
        // Dropped again and sent straight to review in one call: a new round too.
        assert.equal((await task({ task_id: 'j', status: 'dropped', note: 'user: drop it', user_approved: true }))['ok'], true);
        const oneCall = await task({ task_id: 'j', stage: 'review', checks: [{ name: 'tests', ok: true }] });
        assert.equal(oneCall['ok'], true, `taken up and reviewed in one call: ${String(oneCall['text'])}`);
        // One accepted past a failing last round (d: done on the user's word) is held to the limit taken up again,
        // and done says so, rather than point to a review the limit refuses.
        await task({ task_id: 'd', status: 'in_progress' });
        await gate({ task_id: 'd', stage: 'review' }, /the most the user allowed \(1\)/, /past the 1 the user set/);
        await gate(
          { task_id: 'd', status: 'done', note: 'x' },
          /"D" is not in review, and has had 1 review round\(s\), the most the user allowed \(1\)\. Stop: .*stage "review" for another round, status "done" to accept it/,
          /not in review/,
        );
        // Each way it points goes: blocked, then another round as the user allowed, …
        assert.equal((await task({ task_id: 'd', status: 'blocked', note: 'still fails: the retry test' }))['ok'], true);
        const allowed = await task({ task_id: 'd', stage: 'review', note: 'user: one more round', user_approved: true });
        assert.equal(allowed['ok'], true, `another round: ${String(allowed['text'])}`);
        // … and, that round asking for changes too, done as it is.
        await task({ task_id: 'd', stage: 'refine' });
        assert.equal((await task({ task_id: 'd', status: 'blocked', note: 'still fails' }))['ok'], true);
        const accepted = await task({ task_id: 'd', status: 'done', note: 'user: accept it as it is', user_approved: true });
        assert.equal(accepted['ok'], true, `accepted as it is: ${String(accepted['text'])}`);
      } else {
        // In a Tracked build the limit is the agent's to weigh, on done as on a round past it: the done goes
        // through, and the agent is asked why, not pointed to a new round.
        await task({ task_id: 'd', status: 'in_progress' });
        const noted = String((await task({ task_id: 'd', status: 'done', note: 'x' }))['text']);
        assert.match(noted, /Noted, not refused \(this build is Tracked\): marked done out of review after 1 review round\(s\), the most the user set: say in the task's note why it is right as it is/);
        assert.doesNotMatch(noted, /a new round/);
        assert.equal((await sessionFor(id)).plan!.tasks.find((t) => t.id === 'd')!.status, 'done');
      }

      const plan = (await sessionFor(id)).plan!;
      const statuses = Object.fromEntries(plan.tasks.map((t) => [t.id, t.status]));
      assert.equal(statuses['i'], mode === 'managed' ? 'todo' : 'dropped', 'a refusal changes nothing; a note does not stop the move');
      // What a Tracked build skipped stays out of the way: nothing is
      // marked as approved by the user that they did not approve.
      if (mode === 'tracked') assert.doesNotMatch(plan.tasks.find((t) => t.id === 'i')!.note ?? '', /approved by the user/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Export plan: the whole plan as Markdown, in every phase, signing nothing off and naming no Coplan tool (#62)', async () => {
  const id = 'export-session';
  const exported = async () => {
    const res = await call<{ text: string; blocks: Block[]; version: number }>(`/api/session/${id}/plan/export`);
    assert.equal(blocksText(res.blocks), res.text, 'joined, the blocks are the text');
    assert.match(res.text, /^# Add a cache\n/);
    assert.match(res.text, /## Summary\nA read-through cache in front of Postgres\./);
    assert.match(res.text, /## Architecture[\s\S]*\*\*Postgres\*\* `db`/);
    assert.match(res.text, /## Task briefs\n/);
    for (const banned of [/harness_/, /cc-harness/, /implement → review → refine/, /review round/i, /subagent/, /\breview: (user|self|skip|subagent)\b/]) {
      assert.doesNotMatch(res.text, banned);
    }
    return res;
  };
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  assert.equal((await call<{ error?: string }>(`/api/session/${id}/plan/export`)).error, 'no plan yet');
  await mcpFor(id, 'publish', PLAN);
  await opsOn(id, [{ op: 'upsert_task', id: 't2', review: 'user' }]);
  const before = await sessionFor(id);
  // Planning: nothing signed off, and looking is not the agent reading.
  const planning = await exported();
  const after = await sessionFor(id);
  assert.equal(after.plan!.version, before.plan!.version);
  assert.equal(after.plan!.claudeReadSeq, before.plan!.claudeReadSeq, 'the user\'s edit stays unread');
  assert.equal(after.plan!.design, undefined);
  // Tasking, and once submitted.
  await post(`/api/session/${id}/plan/design/confirm`);
  assert.match((await exported()).text, /- \[ \] t2 Client/);
  const preview = await post<Preview>(`/api/session/${id}/plan/prompt`, { mode: 'export' });
  assert.equal(preview.prompt, (await exported()).text, 'Submit as an Export locks exactly what Export plan copies');
  await post(`/api/session/${id}/plan/submit`, { mode: 'export', expect: preview.version });
  const locked = await sessionFor(id);
  assert.equal(locked.plan!.submission?.target, 'elsewhere');
  assert.equal(locked.plan!.submission?.mode, 'export');
  const next = String((await hookFor(id, 'UserPromptSubmit', { prompt: 'hello' })).hookSpecificOutput?.additionalContext ?? '');
  assert.doesNotMatch(next, /# Add a cache|\[cc-harness\] Build/, 'an export is never handed to this agent');
  assert.equal((await sessionFor(id)).plan!.submission?.deliveredAt, null);
  assert.equal((await exported()).text, planning.text, 'the plan reads the same in every phase');
});

test('dropping a task needs a reason; dropping or reopening one says what it means for the rest', async () => {
  const id = 'scope-session';
  const task = (body: Record<string, unknown>) => mcpFor(id, 'task', body);
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'edit', { ops: [{ op: 'upsert_task', id: 't4', dependsOn: ['t1'] }] });

  const silent = await task({ task_id: 't2', status: 'dropped' });
  assert.equal(silent['ok'], false);
  assert.match(String(silent['text']), /needs a `note`: why it is no longer needed/);
  assert.equal((await task({ task_id: 't2', status: 'dropped', note: 'the client already exists' }))['ok'], true);

  await task({ task_id: 't3', stage: 'review' });
  const done = String((await task({ task_id: 't3', status: 'done', verdict: 'pass', note: 'done' }))['text']);
  assert.match(done, /Now ready: t4 "Wire up"/, 'dropped and done, t1 holds nothing up');

  await task({ task_id: 't4', stage: 'implement' });
  const reopened = String((await task({ task_id: 't3', status: 'in_progress', stage: 'refine' }))['text']);
  assert.match(reopened, /t4 "Wire up" \(in progress\) already went ahead on this task's work/);

  // Finished again, then dropped: said then, as reopening it from dropped later has no way to know.
  await task({ task_id: 't3', stage: 'review' });
  assert.equal((await task({ task_id: 't3', status: 'done', verdict: 'pass', note: 'done again' }))['ok'], true);
  const droppedDone = String((await task({ task_id: 't3', status: 'dropped', note: 'superseded' }))['text']);
  assert.match(droppedDone, /t4 "Wire up" \(in progress\) already went ahead on this task's work: check they still hold without it/);
  assert.doesNotMatch(droppedDone, /no longer do/, 'said once, not as waiting too');

  // Taken up again by stage alone: said as well.
  const other = 'scope-session-stage';
  const otherTask = (body: Record<string, unknown>) => mcpFor(other, 'task', body);
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'publish', PLAN);
  await mcpFor(other, 'edit', { ops: [{ op: 'upsert_task', id: 't4', dependsOn: ['t1'] }] });
  await otherTask({ task_id: 't2', status: 'dropped', note: 'the client already exists' });
  await otherTask({ task_id: 't3', stage: 'review' });
  assert.equal((await otherTask({ task_id: 't3', status: 'done', verdict: 'pass', note: 'done' }))['ok'], true);
  await otherTask({ task_id: 't4', stage: 'implement' });
  const byStage = String((await otherTask({ task_id: 't3', stage: 'refine' }))['text']);
  assert.match(byStage, /t4 "Wire up" \(in progress\) already went ahead on this task's work: check they still hold once it changes/);
});

test('dropping a task does not tell a dependent that is itself dropped that it no longer waits', async () => {
  const id = 'scope-session-dropped-dependent';
  const task = (body: Record<string, unknown>) => mcpFor(id, 'task', body);
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'edit', { ops: [{ op: 'upsert_task', id: 't4', dependsOn: ['t3'] }] });
  assert.equal((await task({ task_id: 't4', status: 'dropped', note: 'not needed' }))['ok'], true);
  const reply = await task({ task_id: 't3', status: 'dropped', note: 'not needed either' });
  assert.equal(reply['ok'], true, String(reply['text']));
  assert.doesNotMatch(String(reply['text']), /t4 "Wire up"/);
});

test('a task never finished, dropped, does not tell a dependent already done that it waited on it', async () => {
  const id = 'scope-session-done-dependent';
  const task = (body: Record<string, unknown>) => mcpFor(id, 'task', body);
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await task({ task_id: 't4', stage: 'review' });
  assert.equal((await task({ task_id: 't4', status: 'done', verdict: 'pass', note: 'done' }))['ok'], true);
  // Found to build on t3 after it was done.
  const edited = await mcpFor(id, 'edit', { ops: [{ op: 'upsert_task', id: 't4', dependsOn: ['t3'] }] });
  assert.equal(edited['ok'], true, String(edited['text']));
  const reply = await task({ task_id: 't3', status: 'dropped', note: 'not needed' });
  assert.equal(reply['ok'], true, String(reply['text']));
  assert.doesNotMatch(String(reply['text']), /waited on it/);
});

test('a finished task taken up from a drop says who went ahead on its work, as one taken up from done does', async () => {
  const id = 'scope-session-from-drop';
  const task = (body: Record<string, unknown>) => mcpFor(id, 'task', body);
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'edit', { ops: [{ op: 'upsert_task', id: 't4', dependsOn: ['t1'] }] });
  await task({ task_id: 't2', status: 'dropped', note: 'the client already exists' });
  await task({ task_id: 't3', stage: 'review' });
  assert.equal((await task({ task_id: 't3', status: 'done', verdict: 'pass', note: 'done' }))['ok'], true);
  assert.equal((await task({ task_id: 't3', status: 'dropped', note: 'superseded' }))['ok'], true);
  await task({ task_id: 't4', stage: 'implement' });
  await task({ task_id: 't4', status: 'blocked', note: 'waiting on t3' });
  const reopened = await task({ task_id: 't3', status: 'in_progress' });
  assert.equal(reopened['ok'], true, String(reopened['text']));
  assert.match(String(reopened['text']), /t4 "Wire up" \(blocked\) already went ahead on this task's work: check they still hold once it changes/);
});

test("done needs the round's passing verdict — the user's own, when the user reviews it", async () => {
  const id = 'review-session';
  const task = (body: Record<string, unknown>) => mcpFor(id, 'task', body);
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'edit', { ops: [{ op: 'upsert_task', id: 't2', review: 'user' }] });

  // The agent's own review: done without a verdict, or after "changes", is refused.
  await task({ task_id: 't3', stage: 'review' });
  assert.match(String((await task({ task_id: 't3', status: 'done', note: 'x' }))['text']), /no passing verdict for review round 1/);
  await task({ task_id: 't3', verdict: 'changes', summary: 'missing a test' });
  assert.match(String((await task({ task_id: 't3', status: 'done', note: 'x' }))['text']), /no passing verdict/);
  assert.equal((await task({ task_id: 't3', status: 'done', verdict: 'pass', note: 'done' }))['ok'], true);

  // The user's review: the agent's pass does not count, theirs does.
  await task({ task_id: 't2', stage: 'review' });
  assert.match(String((await task({ task_id: 't2', status: 'done', verdict: 'pass', note: 'x' }))['text']), /the user's to review, and they have not passed it/);
  assert.match(String((await mcpFor(id, 'next'))['text']), /waiting on the user's review/);
  await opsOn(id, [{ op: 'review_task', id: 't2', verdict: 'changes', summary: 'rename the client' }]);
  assert.match(String((await mcpFor(id, 'read', { changes_only: true }))['text']), /\*\*Reviews\*\*\n- The user asked for changes to "Client" in review round 1: rename the client\./);
  await task({ task_id: 't2', stage: 'refine' });
  await task({ task_id: 't2', stage: 'review' });
  await opsOn(id, [{ op: 'review_task', id: 't2', verdict: 'pass' }]);
  assert.equal((await task({ task_id: 't2', status: 'done', note: 'renamed' }))['ok'], true);
  const reviews = (await sessionFor(id)).plan!.tasks.find((t) => t.id === 't2')!.reviews!;
  assert.deepEqual(
    reviews.map((r) => `${r.round}:${r.verdict}:${r.by}`),
    ['1:changes:user', '2:pass:user'],
    "a refused call records nothing: the agent's pass was never taken",
  );
});

test('on a submitted build: verdicts come from review, signed-off work is the user\'s to drop, and a dropped task restarts like any other', async () => {
  const id = 'submitted-review-session';
  const task = (body: Record<string, unknown>) => mcpFor(id, 'task', body);
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await post(`/api/session/${id}/plan/design/confirm`);
  await hookFor(id, 'UserPromptSubmit', { prompt: 'go' });
  await mcpFor(id, 'tasks', {
    tasks: [
      { id: 'storage', title: 'Storage', subtasks: [{ id: 'client', title: 'Client' }, { id: 'cache', title: 'Cache', review: 'user' }] },
      { id: 'wire', title: 'Wire up', dependsOn: ['storage'] },
    ],
  });
  await post(`/api/session/${id}/plan/submit`, { target: 'session', settings: { review: 'self', parallel: 1, maxRounds: 3 } });
  await hookFor(id, 'UserPromptSubmit', { prompt: 'build it' });

  // A verdict comes from a review: not from refine, to close a round that asked for changes.
  await task({ task_id: 'client', stage: 'review' });
  await task({ task_id: 'client', verdict: 'changes', summary: 'needs a test' });
  await task({ task_id: 'client', stage: 'refine' });
  assert.match(String((await task({ task_id: 'client', status: 'done', verdict: 'pass', note: 'x' }))['text']), /not in review now/);
  await task({ task_id: 'client', stage: 'review' });
  assert.equal((await task({ task_id: 'client', status: 'done', verdict: 'pass', note: 'tested' }))['ok'], true);

  // The agent's own pass on the user's task does not count, and next says it waits on them.
  await task({ task_id: 'cache', stage: 'review' });
  await task({ task_id: 'cache', verdict: 'pass' });
  assert.match(String((await mcpFor(id, 'next'))['text']), /Cache.*\n.*waiting on the user's review/);

  // Dropping signed-off work is the user's call.
  assert.match(String((await task({ task_id: 'wire', status: 'dropped', note: 'not needed' }))['text']), /dropping it is theirs to decide/);
  assert.equal((await task({ task_id: 'wire', status: 'dropped', note: 'user: drop it', user_approved: true }))['ok'], true);
  // Picked back up, it is a start: cache is in progress and the user allowed one at once.
  assert.match(String((await task({ task_id: 'wire', stage: 'implement' }))['text']), /cannot start yet/);
});

test('a submission needs to say who builds it', async () => {
  const res = await raw(`/api/session/${built}/plan/submit`, { method: 'POST', body: JSON.stringify({ target: 'mars' }) });
  assert.equal(res.status, 400);
});

/* ------------------------------------------------------------------ *
 * What the agent reads, shown in the page
 * ------------------------------------------------------------------ */

test("the page shows each task's brief exactly as harness_task_brief returns it, and the read-back as harness_plan_read does", async () => {
  const id = 'viewer-session';
  const dir = path.join(repo, '.coplan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      hooks: { implement: ['npm run typecheck'], review: [{ name: 'tests', run: 'npm test' }] },
      iric: { review: 'subagent' },
      review: { model: 'opus' },
      instructions: { brief: 'Write the test first.', review: 'Look for unparameterised SQL.' },
    }),
  );
  try {
    await hookFor(id, 'SessionStart', { start_reason: 'startup' });
    await mcpFor(id, 'publish', PLAN);
    await opsOn(id, [{ op: 'comment', target: { kind: 'node', id: 'd1/db' }, text: 'Use the replica.' }]);
    const plan = (await sessionFor(id)).plan!;
    for (const task of plan.tasks) {
      const page = await call<{ text: string; blocks: Block[]; task: { id: string } }>(`/api/session/${id}/task/${task.id}/brief`);
      const tool = String((await mcpFor(id, 'brief', { task_id: task.id }))['text']);
      assert.equal(page.text, tool, `the page and harness_task_brief give ${task.id} the same text`);
      assert.equal(joinBlocks(page.blocks), tool);
      assert.equal(page.task.id, task.id);
      assert.ok(page.blocks.every((b) => b.source && b.id));
    }
    const brief = await call<{ blocks: Block[] }>(`/api/session/${id}/task/t2/brief`);
    assert.deepEqual(brief.blocks.find((b) => b.id === 'cycle:review:model')?.source, { kind: 'config', key: 'review.model', files: ['.coplan/config.json'] });
    assert.deepEqual(brief.blocks.find((b) => b.id === 'instructions:brief')?.source, { kind: 'config', key: 'instructions.brief', files: ['.coplan/config.json'] });
    const missing = await raw(`/api/session/${id}/task/nope/brief`);
    assert.equal(missing.status, 404);

    // The read-back, as the agent would read it now — before it reads.
    const readback = await call<{ text: string; blocks: Block[] }>(`/api/session/${id}/plan/readback`);
    assert.equal(blocksText(readback.blocks), readback.text);
    assert.match(readback.text, /Use the replica\./);
    assert.ok(readback.blocks.some((b) => b.bookkeeping && /rev \d/.test(b.text)), 'revisions are marked as bookkeeping');
    assert.ok(readback.blocks.some((b) => b.bookkeeping && /reply with harness_plan_edit/.test(b.text)), 'so are reply hints');
    const read = String((await mcpFor(id, 'read'))['text']);
    assert.equal(read, readback.text, 'what the page showed is what the agent then read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening any tab of the prompt viewer does not count as the agent reading the plan', async () => {
  const id = 'look-session';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'read');
  await opsOn(id, [{ op: 'upsert_task', title: 'Load test' }]);
  const before = (await sessionFor(id)).plan!;
  assert.ok(before.seq > before.claudeReadSeq, 'the user has an edit the agent has not read');

  await call(`/api/session/${id}/plan/readback`);
  await call(`/api/session/${id}/plan/text`);
  await call(`/api/session/${id}/task/t2/brief`);
  await post(`/api/session/${id}/plan/design/prompt`);
  const confirmed = await post<Preview>(`/api/session/${id}/plan/design/prompt`, {});
  await post(`/api/session/${id}/plan/design/confirm`, { expect: confirmed.version, hash: (confirmed as Preview & { hash: string }).hash });
  await post(`/api/session/${id}/plan/prompt`, { target: 'session' });
  await call(`/api/session/${id}/plan/readback`);
  await call(`/api/session/${id}/task/t2/brief`);

  const after = (await sessionFor(id)).plan!;
  assert.equal(after.claudeReadSeq, before.claudeReadSeq, "the agent's read position stays");
  assert.equal(after.claudeReadAt, before.claudeReadAt);
  assert.equal(after.design?.deliveredAt ?? null, null, 'the confirmed design is still waiting to be handed over');
  // The agent reads it all the same, next time it reads.
  const handed = String((await mcpFor(id, 'read'))['text']);
  assert.match(handed, /^\[cc-harness\] The design is confirmed/);
});

/* ------------------------------------------------------------------ *
 * Proceeding from chat (#65)
 * ------------------------------------------------------------------ */

/**
 * A scripted session: what the user types goes through the hook as it
 * would from the agent, and what the agent does is its tool calls. The
 * agent — not the hook — reads "build it" as the go-ahead, so the hook
 * adds nothing to that message; the agent advances the plan, quoting it.
 */
test('"build it" in chat: the agent advances the plan, and it is building — locked, quoted, and handed over once (#65)', async () => {
  const id = 'chat-build';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await hookFor(id, 'UserPromptSubmit', { prompt: '/coplan add a cache' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'read');
  // The user once chose Tracked in the Submit dialog, and closed it.
  await post(`/api/session/${id}/plan/choice`, { mode: 'tracked' });
  assert.equal((await sessionFor(id)).buildChoice?.mode, 'tracked');
  const preview = await post<Preview & { mode: string }>(`/api/session/${id}/plan/prompt`, {});
  assert.equal(preview.mode, 'tracked', 'the dialog opens on what the user last chose');

  // The user, in chat. The hook reads nothing into it: deciding what it
  // means is the agent's, which reads the chat.
  const said = await hookFor(id, 'UserPromptSubmit', { prompt: 'looks good, build it' });
  assert.equal(said.hookSpecificOutput?.additionalContext, undefined);

  // The agent signs off for them — no question, no trip to the page.
  const res = await mcpFor(id, 'advance', { to: 'build', user_said: 'looks good, build it' });
  assert.equal(res['ok'], true, String(res['text']));
  const text = String(res['text']);
  assert.match(text, /^\[cc-harness\] Submitted the plan from chat, on the user's word \("looks good, build it"\): Tracked, as they last chose in Coplan\./);
  assert.ok(text.includes(preview.prompt), 'the reply carries the prompt the page would have sent');

  // Building: straight from the design, which was never confirmed.
  const s = await sessionFor(id);
  assert.equal(s.plan!.design, undefined);
  assert.equal(s.plan!.submission?.via, 'chat');
  assert.equal(s.plan!.submission?.userSaid, 'looks good, build it');
  assert.equal(s.plan!.submission?.mode, 'tracked');
  assert.equal(s.plan!.submission?.prompt, preview.prompt);
  assert.ok(s.plan!.submission?.deliveredAt, 'handed over as the reply');
  const { sessions } = await call<{ sessions: { sessionId: string; phase: string; planStatus: string }[] }>('/api/sessions');
  assert.equal(sessions.find((x) => x.sessionId === id)?.phase, 'building');
  assert.equal(sessions.find((x) => x.sessionId === id)?.planStatus, 'in_progress');

  // Locked like a submitted plan, for both sides.
  const redesign = await mcpFor(id, 'edit', { ops: [{ op: 'upsert_diagram', id: 'd1', title: 'Different' }] });
  assert.equal(redesign['ok'], false);
  assert.match(String(redesign['text']), /locked/);
  assert.match((await opsOn(id, [{ op: 'upsert_task', title: 'sneak in' }])).error ?? '', /locked/);

  // The prompt went with the reply, so the next message does not carry it again.
  const next = await hookFor(id, 'UserPromptSubmit', { prompt: 'how is it going?' });
  assert.equal(next.hookSpecificOutput?.additionalContext, undefined);
  assert.match(String((await mcpFor(id, 'read'))['text']), /Locked for building/);

  // The agent builds, with no "not submitted" note.
  const leaf = s.plan!.tasks.find((t) => t.title === 'Client')!;
  const started = await mcpFor(id, 'task', { task_id: leaf.id, status: 'in_progress' });
  assert.equal(started['ok'], true, String(started['text']));
  assert.doesNotMatch(String(started['text']), /not been submitted/);

  // Signed off once: a second go-ahead is told to build, not refused silently.
  const again = await mcpFor(id, 'advance', { to: 'build', user_said: 'build it' });
  assert.equal(again['ok'], false);
  assert.match(String(again['text']), /already submitted: build it/);
});

test('"make the task list" in chat confirms the design; with no choice made, a build takes the repository default (#65)', async () => {
  const id = 'chat-tasks';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'read');

  // Only on the user's word, quoted.
  const unquoted = await mcpFor(id, 'advance', { to: 'build' });
  assert.equal(unquoted['ok'], false);
  assert.match(String(unquoted['text']), /`user_said` needs what the user told you in chat/);
  assert.equal(String((await mcpFor(id, 'advance', { to: 'ship', user_said: 'go' }))['text']).includes('`to` is "tasks"'), true);
  assert.equal((await sessionFor(id)).plan!.submission, undefined, 'nothing was signed off');

  const design = await post<Preview>(`/api/session/${id}/plan/design/prompt`, {});
  const res = await mcpFor(id, 'advance', { to: 'tasks', user_said: 'the design is right, make the tasks' });
  assert.equal(res['ok'], true, String(res['text']));
  assert.match(String(res['text']), /^\[cc-harness\] Confirmed the design from chat, on the user's word \("the design is right, make the tasks"\)/);
  assert.ok(String(res['text']).includes(design.prompt), 'the ask Confirm would have sent');
  let s = await sessionFor(id);
  assert.equal(s.plan!.design?.via, 'chat');
  assert.equal(s.plan!.design?.userSaid, 'the design is right, make the tasks');
  assert.ok(s.plan!.design?.deliveredAt);
  assert.match((await opsOn(id, [{ op: 'upsert_diagram', id: 'd1', title: 'Different' }])).error ?? '', /design is confirmed/);
  const quiet = await hookFor(id, 'UserPromptSubmit', { prompt: 'ok' });
  assert.equal(quiet.hookSpecificOutput?.additionalContext, undefined, 'not handed over a second time');
  const twice = await mcpFor(id, 'advance', { to: 'tasks', user_said: 'again' });
  assert.match(String(twice['text']), /already confirmed: make the task list/);

  // The task list, then "build it" — with no choice made in the page, the
  // repository's default (Managed in these tests).
  await mcpFor(id, 'tasks', { tasks: [{ id: 't1', title: 'Client', detail: 'Wrap the driver.' }, { id: 't2', title: 'Wire up', dependsOn: ['t1'], detail: 'Use it.' }] });
  const build = await mcpFor(id, 'advance', { to: 'build', user_said: 'ship it' });
  assert.equal(build['ok'], true, String(build['text']));
  assert.match(String(build['text']), /: Managed, this repository's default\./);
  assert.match(String(build['text']), /\[cc-harness\] Build the plan "Add a cache"/);
  s = await sessionFor(id);
  assert.equal(s.plan!.submission?.mode, 'managed');
  assert.equal(s.plan!.submission?.userSaid, 'ship it');
  assert.ok(s.plan!.submission?.settings, "a Managed build records the settings it runs with");
});

/* ------------------------------------------------------------------ *
 * Requesting revisions from the page (#67)
 * ------------------------------------------------------------------ */

type RevisionPreview = Preview & { hash: string; threadIds: string[] };
const latest = (s: SessionState) => s.plan!.revisions?.at(-1);

test('one prompt to a message: a revision request queued with a sign-off waits for the message after', async () => {
  const id = 'one-at-a-time';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'read');
  await opsOn(id, [{ op: 'comment', target: { kind: 'node', id: 'd1/db' }, text: 'Use a read replica here.' }]);
  await post(`/api/session/${id}/plan/design/confirm`);
  const preview = await post<RevisionPreview>(`/api/session/${id}/plan/revisions/prompt`, {});
  assert.ok((await post<{ plan?: unknown; error?: string }>(`/api/session/${id}/plan/revisions`, { expect: preview.version, hash: preview.hash })).plan);
  // Each prompt is the most a hook may add at once: together they would be
  // cut to a file the agent sees only the start of.
  const first = String((await hookFor(id, 'UserPromptSubmit', { prompt: 'go' })).hookSpecificOutput?.additionalContext ?? '');
  assert.ok(first.startsWith('[cc-harness] The design is confirmed'), first.slice(0, 80));
  assert.doesNotMatch(first, /Revise the plan/);
  const second = String((await hookFor(id, 'UserPromptSubmit', { prompt: 'and the comments?' })).hookSpecificOutput?.additionalContext ?? '');
  assert.ok(second.startsWith(preview.prompt), 'the request comes with the next one');
});

test('a sign-off queued with a revision request, on a message the relay gave up on, is kept for the next message', async () => {
  const id = 'one-at-a-time-late';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  try {
    await mcpFor(id, 'publish', PLAN);
    await mcpFor(id, 'read');
    await opsOn(id, [{ op: 'comment', target: { kind: 'node', id: 'd1/db' }, text: 'Use a read replica here.' }]);
    await post(`/api/session/${id}/plan/design/confirm`);
    const preview = await post<RevisionPreview>(`/api/session/${id}/plan/revisions/prompt`, {});
    assert.ok((await post<{ plan?: unknown; error?: string }>(`/api/session/${id}/plan/revisions`, { expect: preview.version, hash: preview.hash })).plan);
    // The relay's curl had already given up when the answer was ready.
    const past = String(Math.floor(Date.now() / 1000) - 5);
    const late = await hookFor(id, 'UserPromptSubmit', { prompt: 'go' }, { 'x-harness-deadline': past });
    assert.equal(late.hookSpecificOutput?.additionalContext, undefined, 'the late answer does not carry it');
    const s = await sessionFor(id);
    assert.equal(s.plan!.design!.deliveredAt, null, 'the sign-off is not counted as delivered');
    assert.equal(latest(s)!.deliveredAt, null, 'nor the request');
    // Each in its turn, as if the late message had never been.
    const next = String((await hookFor(id, 'UserPromptSubmit', { prompt: 'go on' })).hookSpecificOutput?.additionalContext ?? '');
    assert.ok(next.startsWith('[cc-harness] The design is confirmed'), next.slice(0, 80));
    const after = String((await hookFor(id, 'UserPromptSubmit', { prompt: 'and the comments?' })).hookSpecificOutput?.additionalContext ?? '');
    assert.ok(after.startsWith(preview.prompt), 'the request comes with the one after');
  } finally {
    await call(`/api/session/${id}`, { method: 'DELETE' });
  }
});

test('a revision request is queued in the page, carried by the next message once, and answered in its threads (#67)', async () => {
  const id = 'revise-session';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'read');
  await opsOn(id, [
    { op: 'comment', target: { kind: 'node', id: 'd1/db' }, text: 'Use a read replica here.' },
    { op: 'comment', target: { kind: 'section', id: 's1' }, text: 'Say how slow.' },
  ]);
  // A comment the agent already answered is not waiting on it, and is not carried.
  const answered = (await opsOn(id, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'Name it?' }])).plan!.threads.at(-1)!;
  await mcpFor(id, 'edit', { ops: [{ op: 'reply', threadId: answered.id, text: 'Named it.' }] });

  const preview = await post<RevisionPreview>(`/api/session/${id}/plan/revisions/prompt`, { note: 'Keep it small.' });
  assert.match(preview.prompt, /^\[cc-harness\] Revise the plan "Add a cache" — the user wants you to act on their open comments\./);
  assert.match(preview.prompt, /harness_plan_propose/);
  assert.match(preview.prompt, /> Keep it small\./);
  assert.match(preview.prompt, /## Open comments \(2\)/);
  // Each comment on what it is about, named as the read-back names it.
  assert.match(preview.prompt, /\[c\d+\] on box "Postgres" \(d1\/db\) in diagram "Components" — user: Use a read replica here\./);
  assert.match(preview.prompt, /\[c\d+\] on section "Context" — user: Say how slow\./);
  assert.doesNotMatch(preview.prompt, /Name it\?/);
  assert.equal(blocksText(preview.blocks), preview.prompt);
  assert.equal(preview.threadIds.length, 2);
  const before = await sessionFor(id);
  assert.equal(before.plan!.revisions, undefined, 'reading the request changes nothing');

  const queued = await post<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${id}/plan/revisions`, {
    note: 'Keep it small.',
    expect: preview.version,
    hash: preview.hash,
  });
  assert.ok(queued.plan, queued.error);
  const req = queued.plan!.revisions!.at(-1)!;
  assert.equal(req.prompt, preview.prompt, 'what the user read is what is sent');
  assert.equal(req.deliveredAt, null, 'pending: Coplan starts no turn');

  // The user's next message — even "go" — carries it.
  const first = await hookFor(id, 'UserPromptSubmit', { prompt: 'go' });
  const delivered = String(first.hookSpecificOutput?.additionalContext ?? '');
  assert.ok(delivered.startsWith(preview.prompt), 'the request rides along with the message');
  assert.ok(latest(await sessionFor(id))?.deliveredAt, 'sent');
  // The comments are news to the agent too, so it is told to read the plan.
  assert.match(delivered.slice(preview.prompt.length), /Call harness_plan_read before acting on the plan/);
  // Once: the next message carries that line, never the request again.
  const second = await hookFor(id, 'UserPromptSubmit', { prompt: 'and?' });
  assert.doesNotMatch(String(second.hookSpecificOutput?.additionalContext ?? ''), /Revise the plan/);
  await mcpFor(id, 'read');
  assert.equal((await hookFor(id, 'UserPromptSubmit', { prompt: 'well?' })).hookSpecificOutput?.additionalContext, undefined);

  // The agent answers in each thread — one by reply, one by proposing: answered.
  const [replica, slow] = req.threadIds;
  await mcpFor(id, 'edit', { ops: [{ op: 'reply', threadId: slow, text: 'Added the p99.' }] });
  const { plan: halfway } = await sessionFor(id);
  const { revisionStatus } = await import('../shared/plan.ts');
  assert.equal(revisionStatus(halfway!, latest({ plan: halfway } as SessionState)!), 'sent', 'one of two answered');
  const proposed = await mcpFor(id, 'propose', {
    title: 'Read from a replica',
    reason: 'As asked.',
    ops: [{ op: 'upsert_node', diagramId: 'd1', id: 'db', description: 'Primary, with a read replica.' }],
  });
  assert.equal(proposed['ok'], true, String(proposed['text']));
  const { plan: done } = await sessionFor(id);
  assert.equal(revisionStatus(done!, latest({ plan: done } as SessionState)!), 'answered');
  assert.ok(replica);
});

test('a pasted revision request is not sent twice, and one not yet sent can be replaced or withdrawn (#67)', async () => {
  const id = 'revise-paste';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'read');
  // Nothing waiting on the agent: nothing to send.
  const empty = await post<{ error?: string }>(`/api/session/${id}/plan/revisions`, {});
  assert.match(empty.error ?? '', /No comment is waiting on the agent/);

  await opsOn(id, [{ op: 'comment', target: { kind: 'task', id: 't4' }, text: 'Split this.' }]);
  const one = await post<RevisionPreview>(`/api/session/${id}/plan/revisions/prompt`, {});
  // A comment added after the preview moves the request: refused, so the user reads it again.
  await opsOn(id, [{ op: 'comment', target: { kind: 'task', id: 't1' }, text: 'Rename this.' }]);
  const stale = await post<{ error?: string }>(`/api/session/${id}/plan/revisions`, { hash: one.hash });
  assert.match(stale.error ?? '', /The plan changed while you were reading the request|The request changed since you read it/);

  const two = await post<RevisionPreview>(`/api/session/${id}/plan/revisions/prompt`, {});
  assert.equal(two.threadIds.length, 2);
  await post(`/api/session/${id}/plan/revisions`, { expect: two.version, hash: two.hash });
  // Queued again before it was sent: replaced, not stacked.
  const again = await post<RevisionPreview>(`/api/session/${id}/plan/revisions/prompt`, { note: 'Both, please.' });
  await post(`/api/session/${id}/plan/revisions`, { note: 'Both, please.', expect: again.version, hash: again.hash });
  let s = await sessionFor(id);
  assert.equal(s.plan!.revisions!.length, 1);
  assert.equal(s.plan!.revisions![0]!.id, 'r2', 'ids are never reused');

  // The user pastes it themselves: delivered, and not added a second time
  // (the one line saying the plan changed still comes: the agent has not
  // read the comments yet).
  const pasted = await hookFor(id, 'UserPromptSubmit', { prompt: `${again.prompt}\n\nthanks` });
  assert.doesNotMatch(String(pasted.hookSpecificOutput?.additionalContext ?? ''), /Revise the plan/);
  s = await sessionFor(id);
  assert.ok(latest(s)?.deliveredAt);
  const after = await hookFor(id, 'UserPromptSubmit', { prompt: 'ok' });
  assert.doesNotMatch(String(after.hookSpecificOutput?.additionalContext ?? ''), /Revise the plan/);

  // A withdrawn request is never sent.
  await opsOn(id, [{ op: 'reply', threadId: s.plan!.threads.at(-1)!.id, text: 'Still waiting.' }]);
  const three = await post<RevisionPreview>(`/api/session/${id}/plan/revisions/prompt`, {});
  await post(`/api/session/${id}/plan/revisions`, { expect: three.version, hash: three.hash });
  assert.equal(latest(await sessionFor(id))?.deliveredAt, null);
  const withdrawn = await post<{ plan?: SessionState['plan']; error?: string }>(`/api/session/${id}/plan/revisions/withdraw`, {});
  assert.ok(withdrawn.plan, withdrawn.error);
  assert.equal(withdrawn.plan!.revisions!.every((r) => r.deliveredAt !== null), true);
  const quiet = await hookFor(id, 'UserPromptSubmit', { prompt: 'hello' });
  assert.doesNotMatch(String(quiet.hookSpecificOutput?.additionalContext ?? ''), /Revise the plan/);
});

test('in Cursor, the request is pasted or picked up by harness_plan_read — once (#67)', async () => {
  const id = 'revise-cursor';
  const cursor = { 'x-harness-agent': 'cursor' };
  await hookFor(id, 'sessionStart', { conversation_id: id, workspace_roots: [repo] }, cursor);
  await mcpFor(id, 'publish', PLAN);
  await mcpFor(id, 'read');
  await opsOn(id, [{ op: 'comment', target: { kind: 'plan', id: '' }, text: 'Shorter summary.' }]);
  const preview = await post<RevisionPreview>(`/api/session/${id}/plan/revisions/prompt`, {});
  await post(`/api/session/${id}/plan/revisions`, { expect: preview.version, hash: preview.hash });
  // Cursor's hook cannot add to a prompt: a message that does not hold the request leaves it waiting.
  await hookFor(id, 'beforeSubmitPrompt', { conversation_id: id, prompt: 'revise per my comments' }, cursor);
  assert.equal(latest(await sessionFor(id))?.deliveredAt, null);
  // The agent reads the plan: the request comes first, then the plan, and only once.
  const read = String((await mcpFor(id, 'read'))['text']);
  assert.ok(read.startsWith(preview.prompt));
  assert.match(read, /# Add a cache/);
  assert.ok(latest(await sessionFor(id))?.deliveredAt);
  assert.doesNotMatch(String((await mcpFor(id, 'read'))['text']), /Revise the plan/);
});

/* ------------------------------------------------------------------ *
 * Checks for what the change touched (#52)
 * ------------------------------------------------------------------ */

test("done waits on the checks for what the task changed since it began — not for files it only planned to touch (#52, targeted checks)", async () => {
  const other = mkdtempSync(path.join(tmpdir(), 'cc-harness-int-diff-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: other, stdio: 'pipe' });
  try {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    mkdirSync(path.join(other, '.coplan'), { recursive: true });
    writeFileSync(
      path.join(other, '.coplan', 'config.json'),
      JSON.stringify({
        hooks: {
          review: [
            { name: 'ts tests', run: 'true', paths: ['*.ts'] },
            { name: 'py tests', run: 'true', paths: ['*.py'] },
            { name: 'md lint', run: 'true', paths: ['*.md'] },
          ],
        },
      }),
    );
    writeFileSync(path.join(other, 'app.ts'), 'export {};\n');
    writeFileSync(path.join(other, 'README.md'), '# hi\n');
    g('add', '-A');
    g('commit', '-qm', 'initial');
    // Work from before the task began is not the task's change.
    writeFileSync(path.join(other, 'README.md'), '# changed before\n');
    g('commit', '-qam', 'earlier work');
    const began = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: other, encoding: 'utf8' }).trim();

    const id = 'diff-session';
    await call(`/hook/SessionStart`, { method: 'POST', body: JSON.stringify({ session_id: id, cwd: other, start_reason: 'startup' }) });
    const task = (body: Record<string, unknown>) =>
      call<Record<string, unknown>>('/mcp/task', { method: 'POST', headers: { 'x-harness-session': id }, body: JSON.stringify({ cwd: other, task_id: 'app', ...body }) });
    await call('/mcp/publish', {
      method: 'POST',
      headers: { 'x-harness-session': id },
      // It plans to touch README.md too — and never will.
      body: JSON.stringify({ cwd: other, title: 'Wire the app', tasks: [{ id: 'app', title: 'Wire the app', files: ['app.ts', 'README.md'] }] }),
    });
    // Starting, it records where its change begins, and says how to check it.
    const started = await task({ status: 'in_progress', stage: 'implement' });
    assert.match(String(started['text']), new RegExp(`Its checks run for what it changes, from this commit on: \`.*check implement --since ${began.slice(0, 12)}\``));
    assert.equal((await sessionFor(id)).plan!.tasks.find((t) => t.id === 'app')?.startCommit, began);

    // It edits its file, writes a Python helper, and commits the work.
    writeFileSync(path.join(other, 'app.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(other, 'helper.py'), 'x = 1\n');
    g('add', '-A');
    g('commit', '-qm', 'the task');
    await task({ stage: 'review' });
    await task({ verdict: 'pass', checks: [{ name: 'ts tests', ok: true }] });
    const refused = await task({ status: 'done', note: 'wired' });
    assert.equal(refused['ok'], false);
    assert.match(String(refused['text']), new RegExp(`the review checks py tests \\(for helper\\.py\\) were never reported — \`.*check review --since ${began.slice(0, 12)}\` runs exactly these`));
    assert.doesNotMatch(String(refused['text']), /md lint/, 'README.md was planned, and touched only before the task began: no check for it');
    // The user skips a check for it: the command the gate gives skips it too,
    // quoted, so it runs exactly what done waits on.
    const skipped = await opsOn(id, [{ op: 'set_checks', id: 'app', skip: ['ts tests'] }]);
    assert.ok(skipped.plan, skipped.error);
    assert.match(String((await task({ status: 'done', note: 'wired' }))['text']), /check review --since [0-9a-f]{12} '--skip=ts tests'` runs exactly these/);

    await task({ checks: [{ name: 'py tests', ok: true }] });
    // Git cannot read the change (its index is broken): that is never
    // "nothing changed", which would ask for no checks — every one applies.
    const index = path.join(other, '.git', 'index');
    const saved = readFileSync(index);
    writeFileSync(index, 'not an index');
    try {
      const unread = await task({ status: 'done', note: 'wired' });
      assert.equal(unread['ok'], false);
      assert.match(String(unread['text']), /what it changed cannot be told — git could not read it \(it failed or took too long\) — so every review check applies, and md lint was never reported/);
    } finally {
      writeFileSync(index, saved);
    }
    const done = await task({ status: 'done', note: 'wired' });
    assert.equal(done['ok'], true, String(done['text']));
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

/** The `config-errors` events a page's live stream for `session` receives,
 *  as they come; `close` ends the stream. */
async function settingsStream(session: string): Promise<{ events: string[][]; files: string[][]; reviews: string[]; lists: { n: number }; close: () => void }> {
  const events: string[][] = [];
  const reviews: string[] = [];
  const lists = { n: 0 };
  const files: string[][] = [];
  const { ticket } = await call<{ ticket: string }>('/api/events/ticket', { method: 'POST', body: '{}' });
  let req: http.ClientRequest | undefined;
  await new Promise<void>((resolve, reject) => {
    req = http.get(`${baseUrl(lock)}/api/events?ticket=${ticket}&session=${session}`, (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          if (!frame.startsWith('data: ')) continue;
          const event = JSON.parse(frame.slice(6)) as { type: string; errors?: string[]; files?: string[]; projectReview?: string };
          if (event.type === 'snapshot') reviews.push(String(event.projectReview));
          if (event.type === 'sessions') lists.n++;
          if (event.type === 'config-errors') {
            events.push(event.errors!);
            files.push(event.files!);
          }
        }
      });
      resolve();
    });
    req.on('error', reject);
  });
  return { events, files, reviews, lists, close: () => req?.destroy() };
}

test('a page opened on a session that cannot be saved is told, though the failure was heard before it opened', async () => {
  const id = 'unsaved-before-page';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  // Its temp file's name taken by a folder: every save of it fails (EISDIR).
  const blocker = path.join(paths.sessionDir(id), `.state.${lock.pid}.tmp`);
  mkdirSync(blocker, { recursive: true });
  try {
    await hookFor(id, 'UserPromptSubmit', { prompt: 'hello' });
    // The save, debounced, fails with no page open: only the daemon's log hears it. Then a page opens.
    const opened = async (): Promise<string[]> => {
      const told: string[] = [];
      const { ticket } = await call<{ ticket: string }>('/api/events/ticket', { method: 'POST', body: '{}' });
      const req = http.get(`${baseUrl(lock)}/api/events?ticket=${ticket}&session=${id}`, (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            if (!frame.startsWith('data: ')) continue;
            const event = JSON.parse(frame.slice(6)) as { type: string; sessionId?: string; message?: string };
            if (event.type === 'persist-error') told.push(`${event.sessionId}:${event.message}`);
          }
        });
      });
      await sleep(300);
      req.destroy();
      return told;
    };
    let told: string[] = [];
    for (let i = 0; i < 20 && !told.length; i++) told = await opened();
    assert.deepEqual(told, [`${id}:EISDIR`]);
  } finally {
    rmSync(blocker, { recursive: true, force: true });
  }
});

test("a mistake in the harness config reaches the page: when it opens, and as soon as it is made or fixed (#52)", async () => {
  const id = 'config-errors';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  const file = path.join(repo, '.claude', 'harness.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ promptNotice: 'sometimes', idleShutdownMinutes: 5 }));
  const page = await settingsStream(id);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 50 && !ok(); i++) await sleep(50);
    assert.ok(ok(), JSON.stringify(page.events));
  };
  try {
    // Opening the page: its repository's file is read, and each mistake said.
    await until(() => page.events.length > 0);
    const first = page.events[0]!;
    assert.equal(first.length, 2);
    assert.match(first.join('\n'), /harness\.json: "promptNotice" must be true or false/);
    assert.match(first.join('\n'), /harness\.json: "idleShutdownMinutes" can only be set in the global config/);
    assert.ok(page.files[0]!.some((f) => f.endsWith(path.join('.claude', 'harness.json'))), 'it says which files it speaks for');
    // Its plan comes with who reviews where the plan does not say.
    assert.ok(page.reviews.length > 0 && page.reviews.every((r) => r === 'self'), JSON.stringify(page.reviews));

    // A page that asked for a session the daemon did not hold yet watches
    // its repository once the session arrives.
    const early = await settingsStream('config-late');
    try {
      for (let i = 0; i < 50 && !early.events.length; i++) await sleep(50);
      assert.deepEqual(early.events[0], [], 'only the global file, until it knows the session');
      await hookFor('config-late', 'SessionStart', { start_reason: 'startup' });
      for (let i = 0; i < 50 && early.events.length < 2; i++) await sleep(50);
      assert.match((early.events[1] ?? []).join('\n'), /harness\.json: "promptNotice" must be true or false/);
    } finally {
      early.close();
    }

    // A page for a session in another repository is not told of it.
    const other = mkdtempSync(path.join(tmpdir(), 'cc-harness-other-repo-'));
    try {
      await hookFor('config-elsewhere', 'SessionStart', { start_reason: 'startup', cwd: other });
      const there = await settingsStream('config-elsewhere');
      for (let i = 0; i < 50 && !there.events.length; i++) await sleep(50);
      there.close();
      assert.deepEqual(there.events[0], []);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }

    // Fixed: the next time the daemon reads it, the open page hears.
    writeFileSync(file, JSON.stringify({ promptNotice: false }));
    utimesSync(file, new Date(), new Date(Date.now() + 2000));
    await hookFor(id, 'UserPromptSubmit', { prompt: 'hello' });
    await until(() => page.events.at(-1)?.length === 0);
  } finally {
    page.close();
    rmSync(file, { force: true });
  }
});

test("the user's own edits are judged by the repository's review mode, as the daemon's gates are (#150)", async () => {
  const other = mkdtempSync(path.join(tmpdir(), 'cc-harness-int-skip-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other, stdio: 'pipe' });
    mkdirSync(path.join(other, '.coplan'), { recursive: true });
    writeFileSync(path.join(other, '.coplan', 'config.json'), JSON.stringify({ iric: { review: 'skip' } }));
    const id = 'user-edit-review-mode';
    const at = (route: string, body: Record<string, unknown>) =>
      call<Record<string, unknown>>(route, { method: 'POST', headers: { 'x-harness-session': id }, body: JSON.stringify({ cwd: other, ...body }) });
    await call('/hook/SessionStart', { method: 'POST', body: JSON.stringify({ session_id: id, cwd: other, start_reason: 'startup' }) });
    await at('/mcp/publish', { title: 'One task', tasks: [{ id: 't1', title: 'Build it' }] });
    await at('/mcp/read', {});
    for (const body of [{ stage: 'review' }, { status: 'done', note: 'passes its checks' }]) {
      const res = await at('/mcp/task', { task_id: 't1', ...body });
      assert.equal(res['ok'], true, String(res['text']));
    }
    // Taken up again by the user on the board: under `skip`, closed done is passed, so its next round is its own.
    const { plan, error } = await opsOn(id, [{ op: 'upsert_task', id: 't1', status: 'in_progress' }]);
    assert.ok(plan, error);
    assert.equal(plan.tasks.find((t) => t.id === 't1')!.reopened, true, "the repository's mode, not the default (self, with no verdict: not passed)");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("a change to the repository's review mode reaches its open page, with no edit to the plan (#158)", async () => {
  const other = mkdtempSync(path.join(tmpdir(), 'cc-harness-int-review-'));
  const file = path.join(other, '.coplan', 'config.json');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other, stdio: 'pipe' });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ iric: { review: 'user' } }));
    const id = 'review-mode-change';
    await call('/hook/SessionStart', { method: 'POST', body: JSON.stringify({ session_id: id, cwd: other, start_reason: 'startup' }) });
    const page = await settingsStream(id);
    try {
      for (let i = 0; i < 50 && !page.reviews.length; i++) await sleep(50);
      assert.deepEqual(page.reviews, ['user'], 'the repository says, not the default');
      // Changed: the next time the daemon reads it (its timer, or any call that needs it), the page hears.
      // (Dated a moment back: a read that finds it settled keeps it.)
      const listsBefore = page.lists.n;
      writeFileSync(file, JSON.stringify({ iric: { review: 'subagent' } }));
      utimesSync(file, new Date(), new Date(Date.now() - 1000));
      await call(`/api/session/${id}`);
      for (let i = 0; i < 50 && page.reviews.at(-1) !== 'subagent'; i++) await sleep(50);
      assert.equal(page.reviews.at(-1), 'subagent', JSON.stringify(page.reviews));
      // The session list too, which says what waits on the user by it.
      for (let i = 0; i < 50 && page.lists.n === listsBefore; i++) await sleep(50);
      assert.ok(page.lists.n > listsBefore, 'the list is sent again');
      // Read again unchanged: nothing more is sent.
      const sent = page.reviews.length;
      await call(`/api/session/${id}`);
      await sleep(200);
      assert.equal(page.reviews.length, sent);
      // Dated ahead (clock skew): never kept, so read on each call, but told once, and the daemon answers at once.
      writeFileSync(file, JSON.stringify({ iric: { review: 'self' } }));
      utimesSync(file, new Date(), new Date(Date.now() + 60_000));
      const started = Date.now();
      await call(`/api/session/${id}`);
      await call(`/api/session/${id}`);
      for (let i = 0; i < 50 && page.reviews.at(-1) !== 'self'; i++) await sleep(50);
      assert.ok(Date.now() - started < 2000, `answered in ${Date.now() - started} ms`);
      assert.deepEqual(page.reviews.slice(sent), ['self'], 'told once');
    } finally {
      page.close();
    }
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * A task's own checks (#54)
 * ------------------------------------------------------------------ */

test('a task\'s own checks: the agent proposes, the user sets, and done follows them — skips not waited on, additions waited on (#54)', async () => {
  const other = mkdtempSync(path.join(tmpdir(), 'cc-harness-int-own-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: other, stdio: 'pipe' });
  try {
    g('init', '-q', '-b', 'main');
    mkdirSync(path.join(other, '.coplan'), { recursive: true });
    writeFileSync(path.join(other, '.coplan', 'config.json'), JSON.stringify({ hooks: { review: [{ name: 'tests', run: 'pnpm test' }] } }));
    const id = 'own-checks';
    const at = (route: string, body: Record<string, unknown>) =>
      call<Record<string, unknown>>(route, { method: 'POST', headers: { 'x-harness-session': id }, body: JSON.stringify({ cwd: other, ...body }) });
    await call('/hook/SessionStart', { method: 'POST', body: JSON.stringify({ session_id: id, cwd: other, start_reason: 'startup' }) });
    await at('/mcp/publish', { title: 'Docs and a migration', tasks: [{ id: 'docs', title: 'Document it' }, { id: 'migrate', title: 'Migrate' }] });
    await at('/mcp/read', {});

    // The agent cannot set them…
    const direct = await at('/mcp/edit', { ops: [{ op: 'set_checks', id: 'docs', skip: ['tests'] }] });
    assert.equal(direct['ok'], false);
    assert.match(String(direct['text']), /Which checks a task runs is the user's to set/);
    // …it proposes, and the user accepts in the page.
    const proposed = await at('/mcp/propose', { title: 'Docs skip the tests', reason: 'Prose only.', ops: [{ op: 'set_checks', id: 'docs', skip: ['tests'] }] });
    assert.equal(proposed['ok'], true, String(proposed['text']));
    const accepted = await opsOn(id, [{ op: 'accept_proposal', id: 'p1' }]);
    assert.ok(accepted.plan, accepted.error);
    // The user adds one of their own to the migration, from the page.
    const added = await opsOn(id, [{ op: 'set_checks', id: 'migrate', add: [{ name: 'db:check', run: 'pnpm db:check' }] }]);
    assert.ok(added.plan, added.error);

    const task = (body: Record<string, unknown>) => at('/mcp/task', body);
    // docs: its skipped check is neither waited on, nor held against it when it fails.
    await task({ task_id: 'docs', stage: 'review' });
    await task({ task_id: 'docs', verdict: 'pass', checks: [{ name: 'tests', ok: false, note: 'unrelated flake' }] });
    const docsDone = await task({ task_id: 'docs', status: 'done', note: 'documented' });
    assert.equal(docsDone['ok'], true, String(docsDone['text']));

    // migrate: done waits on the check the user added.
    await task({ task_id: 'migrate', stage: 'review' });
    await task({ task_id: 'migrate', verdict: 'pass', checks: [{ name: 'tests', ok: true }] });
    const early = await task({ task_id: 'migrate', status: 'done', note: 'migrated' });
    assert.equal(early['ok'], false);
    assert.match(String(early['text']), /the review checks db:check were never reported/);
    await task({ task_id: 'migrate', checks: [{ name: 'db:check', ok: true }] });
    assert.equal((await task({ task_id: 'migrate', status: 'done', note: 'migrated' }))['ok'], true);

    // The brief says it; the read-back shows it.
    const brief = String((await at('/mcp/brief', { task_id: 'docs' }))['text']);
    assert.match(brief, /- It skips tests: do not run it for this task/);
    assert.match(String((await at("/mcp/read", {}))["text"]), /docs Document it · checks tests ✗ · skips tests/);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test('every route about a session answers a session the daemon does not know with a 404', async () => {
  const routes: [string, string][] = [
    ['GET', ''], ['POST', 'title'], ['POST', 'plan/ops'], ['GET', 'plan/text'], ['GET', 'plan/readback'], ['GET', 'task/t1/brief'],
    ['POST', 'plan/prompt'], ['GET', 'plan/export'], ['POST', 'plan/design/prompt'], ['POST', 'plan/design/confirm'], ['POST', 'plan/design/reopen'],
    ['POST', 'plan/revisions/prompt'], ['POST', 'plan/revisions'], ['POST', 'plan/revisions/withdraw'], ['POST', 'plan/choice'], ['POST', 'plan/submit'], ['POST', 'plan/reopen'],
    ['DELETE', ''],
  ];
  // Every one the daemon serves: a route added later is in this list or fails here.
  const main = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'daemon', 'main.ts'), 'utf8');
  const served = [...main.matchAll(/router\.(get|post|delete)\('\/api\/session\/:id(?:\/([^']*))?'/g)].map((m) => `${m[1]!.toUpperCase()} ${(m[2] ?? '').replace(':taskId', 't1')}`);
  assert.deepEqual(routes.map(([method, route]) => `${method} ${route}`).sort(), served.sort());
  for (const [method, route] of routes) {
    const res = await raw(`/api/session/no-such-session${route ? `/${route}` : ''}`, method === 'POST' ? { method, body: '{}' } : { method });
    assert.deepEqual({ status: res.status, body: await res.json() }, { status: 404, body: { error: 'unknown session' } }, `${method} ${route}`);
  }
});

test('a refused sign-off is a 409 with the reason, a look at no plan a 404, a refused edit a 400', async () => {
  const id = 'refusals';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  const send = async (method: string, route: string, body?: Record<string, unknown>) => {
    const res = await raw(`/api/session/${id}/${route}`, body ? { method, body: JSON.stringify(body) } : { method });
    const json = (res.headers.get('content-type') ?? '').includes('json');
    return { status: res.status, body: (json ? await res.json() : { text: await res.text() }) as { error?: string } };
  };
  const post = (route: string, body: Record<string, unknown> = {}) => send('POST', `plan/${route}`, body);
  try {
    // No plan yet: every sign-off is refused, in the store's own words.
    const signOffs: [string, Record<string, unknown>, string][] = [
      ['design/confirm', {}, 'There is no plan to confirm yet.'],
      ['design/reopen', {}, 'There is no plan.'],
      ['revisions', {}, 'There is no plan to revise yet.'],
      ['revisions/withdraw', {}, 'There is no plan.'],
      ['submit', { target: 'session' }, 'There is no plan to submit yet.'],
      ['reopen', {}, 'There is no plan.'],
    ];
    for (const [route, body, reason] of signOffs) {
      assert.deepEqual(await post(route, body), { status: 409, body: { error: reason } }, route);
    }

    // And every look at a plan that is not there is a 404.
    const looks: [string, string][] = [['GET', 'plan/text'], ['GET', 'plan/readback'], ['POST', 'plan/prompt'], ['GET', 'plan/export'], ['POST', 'plan/design/prompt'], ['POST', 'plan/revisions/prompt'], ['GET', 'task/t1/brief']];
    for (const [method, route] of looks) {
      assert.deepEqual(await send(method, route, method === 'POST' ? {} : undefined), { status: 404, body: { error: 'no plan yet' } }, route);
    }

    // With a plan: a sign-off over a version the user never saw is refused
    // the same way, and the plan is left as it was.
    const published = await mcpFor(id, 'publish', PLAN);
    assert.equal(published['ok'], true, String(published['text']));
    const before = (await sessionFor(id)).plan!;
    const stale: [string, Record<string, unknown>, RegExp][] = [
      ['submit', { target: 'session' }, /^The plan changed while you were reviewing it\. .* then submit again\.$/],
      ['design/confirm', {}, /^The plan changed while you were reviewing it\. .* then confirm again\.$/],
      ['revisions', {}, /^The plan changed while you were reading the request\./],
    ];
    for (const [route, body, reason] of stale) {
      const res = await post(route, { ...body, expect: before.version - 1 });
      assert.equal(res.status, 409, route);
      assert.match(res.body.error ?? '', reason, route);
    }

    // An edit the plan refuses is the user's to fix: a 400, not a 409.
    assert.deepEqual(await post('ops', { ops: [{ op: 'remove', kind: 'task', id: 'nope' }] }), { status: 400, body: { error: 'No task "nope".' } });
    const after = (await sessionFor(id)).plan!;
    assert.equal(after.version, before.version, 'nothing refused changed the plan');
    assert.equal(after.submission ?? null, null);
    assert.equal(after.design ?? null, null, 'no design was confirmed');
    assert.deepEqual(after.revisions ?? [], [], 'no revision was queued');
  } finally {
    await call(`/api/session/${id}`, { method: 'DELETE' });
  }
});

test('a prompt the relay gave up on while the daemon was busy is kept for the next message', { skip: process.platform === 'win32' }, async () => {
  const id = 'late-relay';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  try {
    const published = await mcpFor(id, 'publish', PLAN);
    assert.equal(published['ok'], true, String(published['text']));
    assert.equal((await raw(`/api/session/${id}/plan/submit`, { method: 'POST', body: JSON.stringify({ target: 'session' }) })).status, 200);
    // The relay's curl gives up a second from now, and the daemon is busy
    // (paused) past that: by the time it answers, no one is reading.
    const deadline = Math.floor(Date.now() / 1000) + 1;
    daemon.kill('SIGSTOP');
    const late = hookFor(id, 'UserPromptSubmit', { prompt: 'go' }, { 'x-harness-deadline': String(deadline) });
    await sleep(2_200);
    daemon.kill('SIGCONT');
    const answer = await late;
    assert.equal(answer.hookSpecificOutput?.additionalContext, undefined, 'the late answer does not carry it');
    assert.equal((await sessionFor(id)).plan!.submission!.deliveredAt, null, 'so it is not counted as delivered');
    // The next message, answered in time (a second or two to spare), carries it.
    const next = await hookFor(id, 'UserPromptSubmit', { prompt: 'go on' }, { 'x-harness-deadline': String(Math.floor(Date.now() / 1000) + 2) });
    const s = await sessionFor(id);
    assert.equal(next.hookSpecificOutput?.additionalContext, s.plan!.submission!.prompt);
    assert.ok(s.plan!.submission!.deliveredAt);
  } finally {
    daemon.kill('SIGCONT');
    await call(`/api/session/${id}`, { method: 'DELETE' });
  }
});

test('in Cursor a pasted prompt stays delivered, however late the hook is: the paste reached the agent', async () => {
  const id = 'late-relay-cursor';
  const cursor = { 'x-harness-agent': 'cursor' };
  await hookFor(id, 'sessionStart', { conversation_id: id, workspace_roots: [repo] }, cursor);
  try {
    assert.equal((await mcpFor(id, 'publish', PLAN))['ok'], true);
    assert.equal((await raw(`/api/session/${id}/plan/submit`, { method: 'POST', body: JSON.stringify({ target: 'session' }) })).status, 200);
    const prompt = (await sessionFor(id)).plan!.submission!.prompt;
    const past = String(Math.floor(Date.now() / 1000) - 5);
    await hookFor(id, 'beforeSubmitPrompt', { conversation_id: id, prompt }, { ...cursor, 'x-harness-deadline': past });
    assert.ok((await sessionFor(id)).plan!.submission!.deliveredAt, 'not taken back, so not sent again');
  } finally {
    await call(`/api/session/${id}`, { method: 'DELETE' });
  }
});

test('a prompt the user pasted into a late message stays delivered: it reached the agent with the message', async () => {
  const id = 'late-relay-pasted';
  await hookFor(id, 'SessionStart', { start_reason: 'startup' });
  try {
    assert.equal((await mcpFor(id, 'publish', PLAN))['ok'], true);
    assert.equal((await raw(`/api/session/${id}/plan/submit`, { method: 'POST', body: JSON.stringify({ target: 'session' }) })).status, 200);
    const prompt = (await sessionFor(id)).plan!.submission!.prompt;
    await hookFor(id, 'UserPromptSubmit', { prompt }, { 'x-harness-deadline': String(Math.floor(Date.now() / 1000) - 5) });
    assert.ok((await sessionFor(id)).plan!.submission!.deliveredAt, 'not taken back, so not sent again');
    const next = await hookFor(id, 'UserPromptSubmit', { prompt: 'go on' });
    assert.doesNotMatch(String(next.hookSpecificOutput?.additionalContext ?? ''), /Build the plan/);
  } finally {
    await call(`/api/session/${id}`, { method: 'DELETE' });
  }
});

test("a session first seen through a tool call with no folder (Codex, its hooks untrusted) guesses no repository: not the daemon's", async () => {
  const id = 'codex-thread-no-folder';
  // Codex's MCP server sends no cwd: the daemon's own folder is some other session's repository.
  const res = await call<Record<string, unknown>>('/mcp/read', { method: 'POST', headers: { 'x-harness-session': id, 'x-harness-agent': 'codex' }, body: '{}' });
  assert.ok(res['text'] !== undefined, JSON.stringify(res));
  try {
    const { session, projectChecks } = await call<{ session: SessionState; projectChecks: { implement: string[]; review: string[] } }>(`/api/session/${id}`);
    assert.equal(session.cwd, '', 'no folder until a hook says which');
    assert.equal(session.repoRoot, null);
    assert.equal(session.title, id.slice(0, 8), 'named by its id, not after another repository');
    assert.deepEqual(projectChecks, { implement: [], review: [] }, "and no repository's checks");
    // A SessionStart that names no folder guesses none either.
    await call(`/hook/SessionStart`, { method: 'POST', headers: { 'x-harness-agent': 'codex' }, body: JSON.stringify({ session_id: id, start_reason: 'startup' }) });
    assert.equal((await sessionFor(id)).cwd, '');
    // Its first hook that says where it is (trusted mid-thread: not a SessionStart) names it.
    await hookFor(id, 'UserPromptSubmit', { prompt: 'go' }, { 'x-harness-agent': 'codex' });
    const named = await sessionFor(id);
    assert.equal(named.cwd, repo);
    assert.equal(named.title, path.basename(repo));
  } finally {
    await call(`/api/session/${id}`, { method: 'DELETE' });
  }
});
