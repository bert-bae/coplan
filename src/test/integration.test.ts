import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const hookFor = (id: string, event: string, body: Record<string, unknown> = {}) =>
  call<HookOutput>(`/hook/${event}`, {
    method: 'POST',
    body: JSON.stringify({ session_id: id, cwd: repo, ...body }),
  });

const mcpFor = (id: string, tool: string, body: Record<string, unknown> = {}) =>
  call<Record<string, unknown>>(`/mcp/${tool}`, {
    method: 'POST',
    headers: { 'x-harness-session': id },
    body: JSON.stringify({ cwd: repo, ...body }),
  });

const hook = (event: string, body: Record<string, unknown> = {}) => hookFor(sessionId, event, body);
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
  questions: [{ question: 'Which backend?', options: ['Redis', 'Memcached'] }],
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
  assert.match(text, /- api → db/);
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
  const before = await session();
  const q = before.plan!.questions[0]!.id;
  const res = await ops([
    { op: 'answer', id: q, selected: ['Redis'], text: 'already deployed' },
    { op: 'move_task', id: 't4', parentId: 't1', index: 0 },
    { op: 'upsert_task', parentId: 't1', title: 'Load test' },
    { op: 'comment', target: { kind: 'diagram', id: 'd1' }, text: 'where does the cache go?' },
    {
      op: 'upsert_diagram',
      id: 'd1',
      nodes: [
        { id: 'api', label: 'API', kind: 'service', x: 0, y: 0 },
        { id: 'cache', label: 'Redis', kind: 'datastore', x: 200, y: 0 },
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
  assert.match(read, /Since you last read — 5 change\(s\) by the user/);
  assert.match(read, /answered "Which backend\?": Redis — already deployed/);
  assert.match(read, /moved "Wire up" under "Storage"/);
  assert.match(read, /added task "Load test" under "Storage"/);
  assert.match(read, /commented on diagram "Components"/);
  assert.match(read, /added "Redis".*connected API → Redis/);
  assert.match(read, /- cache: "Redis" \(datastore\)/);
});

test('reading once catches Claude up', async () => {
  const again = String((await mcp('read', { changes_only: true }))['text']);
  assert.match(again, /has not changed the plan/);
  const notice = await hook('UserPromptSubmit', { prompt: 'continue' });
  assert.equal(notice.hookSpecificOutput?.additionalContext, undefined, 'no notice once Claude is up to date');
});

test('the next chat message after an edit tells Claude to read the plan', async () => {
  await ops([{ op: 'upsert_question', question: 'Should we shard?' }]);
  const out = await hook('UserPromptSubmit', { prompt: 'ok, go on' });
  assert.match(out.hookSpecificOutput?.additionalContext ?? '', /changed the plan .* harness_plan_read/);
});

test('a republish over unread user edits is refused', async () => {
  const res = await mcp('publish', PLAN);
  assert.equal(res['ok'], false);
  assert.match(String(res['text']), /harness_plan_read first/);
  const s = await session();
  assert.ok(s.plan!.questions.some((q) => q.question === 'Should we shard?'), 'nothing the user did was lost');
});

test('Claude answers the user\'s question and replies to their comment', async () => {
  await mcp('read', {});
  const s = await session();
  const asked = s.plan!.questions.find((q) => q.question === 'Should we shard?')!;
  const thread = s.plan!.threads[0]!;
  const res = await mcp('edit', {
    ops: [
      { op: 'answer', id: asked.id, text: 'Not yet — one node handles the load.' },
      { op: 'reply', threadId: thread.id, text: 'Between the API and Postgres.' },
    ],
  });
  assert.equal(res['ok'], true, String(res['text']));
  const after = await session();
  assert.equal(after.plan!.questions.find((q) => q.id === asked.id)?.answer?.by, 'claude');
  assert.equal(after.plan!.threads[0]!.replies[0]!.author, 'claude');
  assert.equal(after.plan!.claudeReadSeq, after.plan!.seq, 'its own edits are not news to it');
});

test('task tracking moves statuses and reports them', async () => {
  const res = await mcp('task', { task_id: 't2', status: 'done', note: 'client added' });
  assert.match(String(res['text']), /"Client" is done/);
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
