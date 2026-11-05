import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl } from '../shared/paths.ts';
import type { DaemonLock, SessionState } from '../shared/types.ts';
import type { HookOutput } from '../shared/hooks.ts';

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
  assert.doesNotMatch(read, /x: |"x"|200/, 'no coordinates reach Claude');
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
  const { sessions } = await call<{ sessions: { sessionId: string; planTitle: string; tasks: { total: number; done: number } }[] }>('/api/sessions');
  const row = sessions.find((s) => s.sessionId === sessionId)!;
  assert.equal(row.planTitle, 'Add a cache');
  assert.equal(row.tasks.done, 1);
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
type Preview = { prompt: string; trimmed: boolean; version: number; budget: number };

test('the prompt preview is the prompt, and reading it changes nothing', async () => {
  await hookFor(built, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(built, 'publish', PLAN);
  await opsOn(built, [{ op: 'upsert_task', title: 'Load test' }]);
  const before = await sessionFor(built);
  const preview = await post<Preview>(`/api/session/${built}/plan/prompt`, { target: 'session', note: 'Start with the client.' });
  assert.match(preview.prompt, /^\[cc-harness\] Build the plan "Add a cache"/);
  assert.match(preview.prompt, /> Start with the client\./);
  assert.match(preview.prompt, /Added t\d+ "Load test"/, 'the edit Claude has not read leads');
  assert.equal(preview.version, before.plan!.version);
  const after = await sessionFor(built);
  assert.equal(after.plan!.version, before.plan!.version);
  assert.equal(after.plan!.submission, undefined);
});

test('confirming the design locks it, and the next message asks Claude for the task list — once', async () => {
  const early = await post<{ error?: string }>(`/api/session/${built}/plan/submit`, { target: 'session' });
  assert.match(early.error ?? '', /Confirm the design first/);

  const preview = await post<Preview>(`/api/session/${built}/plan/design/prompt`, { note: 'Split the storage work.' });
  assert.match(preview.prompt, /^\[cc-harness\] The design is confirmed for "Add a cache"/);
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
  assert.match(text, /Do not start building/);
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
  assert.match(String(last['text']), /That was the last task: the plan is built/);
  const finish = String((await mcpFor(built, 'next'))['text']);
  assert.match(finish, /Every task in "Add a cache" is done/);
  assert.match(finish, /pull requests in stack order: `cache\/storage` → `cache\/api` \(onto `cache\/storage`\)/);
  assert.match(finish, /op: "report"/);
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
    const design = await post<Preview & { project: { checks: Record<string, string[]> } }>(`/api/session/${id}/plan/design/prompt`);
    assert.deepEqual(design.project.checks['review'], ['tests', 'lint']);
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

test('a submission needs to say who builds it', async () => {
  const res = await raw(`/api/session/${built}/plan/submit`, { method: 'POST', body: JSON.stringify({ target: 'mars' }) });
  assert.equal(res.status, 400);
});
