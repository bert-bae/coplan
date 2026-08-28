import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl } from '../shared/paths.ts';
import type { DaemonLock, DiffPayload, SessionState } from '../shared/types.ts';
import type { HookOutput } from '../shared/hooks.ts';

/**
 * End-to-end: a real daemon subprocess, a real git repository, real hook
 * payloads. This is the test that would catch a regression in the thing the
 * harness actually promises — that what the user does in the browser reaches
 * the session.
 */

const DAEMON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'main.js');

let home: string;
let repo: string;
let daemon: ChildProcess;
let lock: DaemonLock;
const sessionId = 'integration-session';
let transcript: string;

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

  transcript = path.join(home, 'transcript.jsonl');
  writeFileSync(transcript, '');

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
  return (await res.json()) as T;
}

const hookFor = (id: string, event: string, body: Record<string, unknown> = {}) =>
  call<HookOutput>(`/hook/${event}`, {
    method: 'POST',
    body: JSON.stringify({ session_id: id, cwd: repo, transcript_path: transcript, ...body }),
  });

const mcpFor = (id: string, tool: string, body: Record<string, unknown> = {}) =>
  call<Record<string, unknown>>(`/mcp/${tool}`, {
    method: 'POST',
    headers: { 'x-harness-session': id },
    body: JSON.stringify({ cwd: repo, ...body }),
  });

const hook = (event: string, body: Record<string, unknown> = {}) => hookFor(sessionId, event, body);
const mcp = (tool: string, body: Record<string, unknown> = {}) => mcpFor(sessionId, tool, body);

const session = () => call<{ session: SessionState }>(`/api/session/${sessionId}`).then((r) => r.session);

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(75);
  }
  throw new Error('condition never became true');
}

/* ------------------------------------------------------------------ */

test('SessionStart records the repo, branch and start commit', async () => {
  await hook('SessionStart', { start_reason: 'startup' });
  const s = await session();
  assert.equal(s.repoRoot, repo);
  assert.equal(s.branch, 'feature/change');
  assert.match(s.startCommit ?? '', /^[0-9a-f]{40}$/);
});

test('the transcript tailer turns session output into timeline entries', async () => {
  appendFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'considering the approach' },
          { type: 'text', text: 'I will add a subtract function.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: `${repo}/app.ts` } },
        ],
      },
    }) + '\n',
  );

  const found = await until(async () => {
    const s = await session();
    return s.timeline.find((e) => e.text.includes('add a subtract function'));
  });
  assert.equal(found.kind, 'assistant');

  const s = await session();
  assert.ok(s.timeline.some((e) => e.kind === 'thinking'), 'reasoning is captured separately');
  assert.ok(s.timeline.some((e) => e.kind === 'tool' && e.label === 'Edit'), 'tool calls are captured');
});

test('tool-result user entries are not mistaken for user prompts', async () => {
  appendFileSync(
    transcript,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    }) + '\n',
  );
  await sleep(300);
  const s = await session();
  assert.equal(s.timeline.filter((e) => e.kind === 'user').length, 0);
});

test('the plan gate parks the Stop hook and returns the edited plan', async () => {
  const plan = await mcp('plan', {
    title: 'Add a subtract function',
    summary: 'Mirror add().',
    steps: [{ title: 'Write subtract' }, { title: 'Add a test' }, { title: 'Update the docs' }],
  });
  const gateId = String(plan['gateId']);
  assert.ok(gateId);

  // Claude ends its turn; the Stop hook holds it open.
  const parked = hook('Stop', { stop_hook_active: false });
  await until(async () => (await session()).status === 'waiting');

  // The user edits the plan in the UI and approves it.
  await call(`/api/session/${sessionId}/gate/${gateId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      verdict: 'approved',
      comment: 'Drop the docs step.',
      steps: [
        { id: 's1', title: 'Write subtract' },
        { id: 's2', title: 'Add a test' },
        { id: 's3', title: 'Update the docs', status: 'dropped' },
      ],
    }),
  });

  const out = await parked;
  assert.equal(out.decision, 'block', 'the turn is resumed rather than ended');
  assert.match(out.reason ?? '', /approved at the plan gate/);
  assert.match(out.reason ?? '', /Drop the docs step/);
  assert.match(out.reason ?? '', /Approved plan \(2 steps\)/);

  const s = await session();
  assert.equal(s.plan?.steps.length, 3);
  assert.equal(s.plan?.steps[2]?.status, 'dropped');
});

test('a verdict given before the turn ends is still delivered', async () => {
  // The user is faster than Claude: they answer while the turn is still
  // running, so no waiter is parked when the answer lands. The next Stop must
  // still hand the verdict over rather than dropping it.
  const other = 'integration-race';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  const plan = await mcpFor(other, 'plan', { title: 'Race', steps: [{ title: 'only step' }] });
  const gateId = String(plan['gateId']);

  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'approved', comment: 'Answered early.' }),
  });

  const out = await hookFor(other, 'Stop', { stop_hook_active: false });
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /Answered early/);

  // …and exactly once: a second Stop must not replay it.
  const again = await hookFor(other, 'Stop', { stop_hook_active: true });
  assert.notEqual(again.decision, 'block');
});

test('a verdict already delivered by harness_await is not replayed at Stop', async () => {
  const other = 'integration-no-replay';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  const plan = await mcpFor(other, 'plan', { title: 'No replay', steps: [{ title: 'only step' }] });
  const gateId = String(plan['gateId']);

  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'approved', comment: 'Seen by await.' }),
  });

  const awaited = await mcpFor(other, 'await', { gate_id: gateId, timeout_seconds: 5 });
  assert.equal(awaited['status'], 'resolved');
  assert.match(String(awaited['text']), /Seen by await/);

  const out = await hookFor(other, 'Stop', { stop_hook_active: false });
  assert.notEqual(out.decision, 'block', 'the same verdict is not delivered twice');
});

test('a question opens a gate the UI can answer', async () => {
  const other = 'integration-question';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  const asked = await mcpFor(other, 'ask', {
    question: 'Map or plain object?',
    options: ['Map', 'Plain object'],
  });
  const gateId = String(asked['gateId']);
  assert.ok(gateId);
  assert.match(String(asked['text']), /Question posted/);

  const state = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  const gate = state.gates.find((g) => g.id === gateId)!;
  assert.equal(gate.kind, 'question');
  assert.deepEqual(gate.meta?.options, ['Map', 'Plain object']);

  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'answered', comment: 'Map' }),
  });
  const out = await hookFor(other, 'Stop', { stop_hook_active: false });
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /answered at the question gate/);
  assert.match(out.reason ?? '', /Map/);
});

test('a superseded gate stops holding the turn', async () => {
  const other = 'integration-superseded';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'plan', { title: 'First', steps: [{ title: 'a' }] });

  const parked = hookFor(other, 'Stop', { stop_hook_active: false });
  await until(async () => {
    const s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
    return s.status === 'waiting';
  });

  // Publishing a new plan cancels the old gate. Nothing will ever resolve it,
  // so the parked hook must be released rather than held for its full window.
  await mcpFor(other, 'plan', { title: 'Second', steps: [{ title: 'b' }] });

  const out = await withTimeout(parked, 8000);
  assert.ok(out, 'the parked Stop hook returned rather than hanging');
});

test('the verification gate opens only after the checks have finished', async () => {
  const other = 'integration-checks';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  const result = await mcpFor(other, 'checks', { commands: ['exit 0', 'exit 7'] });

  // The call itself waits for the run, so the state is final by the time it
  // returns — the user is never asked to sign off on `pending`.
  const state = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.ok(state.checks.every((c) => c.status === 'passed' || c.status === 'failed'));
  assert.match(String(result['text']), /1 of 2 check\(s\) FAILED/);
  assert.match(String(result['text']), /exit 7/);
  assert.match(String(result['text']), /Do not ask the user to sign off on a red check/);
});

test('ship refuses to commit onto the default branch', async () => {
  const other = 'integration-onmain';
  const mainRepo = mkdtempSync(path.join(tmpdir(), 'cc-harness-main-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: mainRepo });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: mainRepo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: mainRepo });
  writeFileSync(path.join(mainRepo, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: mainRepo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: mainRepo });
  writeFileSync(path.join(mainRepo, 'a.txt'), 'two\n');

  await call(`/hook/SessionStart`, {
    method: 'POST',
    body: JSON.stringify({ session_id: other, cwd: mainRepo, start_reason: 'startup' }),
  });

  const outcome = await call<{ ok: boolean; output: string }>(`/api/session/${other}/ship`, {
    method: 'POST',
    body: JSON.stringify({
      ship: {
        title: 't',
        body: 'b',
        commitMessage: 'c',
        branch: 'main',
        baseBranch: 'main',
        steps: ['commit'],
        provider: 'none',
      },
    }),
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /refusing to commit to "main"/);
  rmSync(mainRepo, { recursive: true, force: true });
});

test('a repo-local config supplies its own checks', async () => {
  const other = 'integration-projectconfig';
  const cfgRepo = mkdtempSync(path.join(tmpdir(), 'cc-harness-cfg-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: cfgRepo });
  mkdirSync(path.join(cfgRepo, '.claude'), { recursive: true });
  writeFileSync(
    path.join(cfgRepo, '.claude', 'harness.json'),
    JSON.stringify({ stages: { verification: { checks: ['echo from-project-config'] } } }),
  );

  await call(`/hook/SessionStart`, {
    method: 'POST',
    body: JSON.stringify({ session_id: other, cwd: cfgRepo, start_reason: 'startup' }),
  });
  await call(`/mcp/checks`, {
    method: 'POST',
    headers: { 'x-harness-session': other },
    body: JSON.stringify({ cwd: cfgRepo }),
  });

  const state = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.equal(state.checks.length, 1, 'the project config was read');
  assert.equal(state.checks[0]!.command, 'echo from-project-config');
  assert.match(state.checks[0]!.output, /from-project-config/);
  rmSync(cfgRepo, { recursive: true, force: true });
});

test('publishing a new diff closes out the previous review round', async () => {
  const other = 'integration-rounds';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'diff', {});

  const gate = await call<{ session: SessionState }>(`/api/session/${other}`)
    .then((r) => r.session.gates.find((g) => g.status === 'open')!);
  await call(`/api/session/${other}/gate/${gate.id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      verdict: 'changes_requested',
      threads: [
        { id: '', file: 'app.ts', side: 'new', startLine: 1, endLine: 1, body: 'round one', createdAt: 0, resolved: false },
      ],
    }),
  });
  await hookFor(other, 'Stop', { stop_hook_active: false });

  await mcpFor(other, 'diff', {});
  const after = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.equal(after.reviewRound, 2);
  assert.equal(after.threads[0]!.resolved, true, 'delivered comments close out when Claude republishes');
  assert.equal(after.threads[0]!.round, 1);
});

test('approving a plan fills the task board', async () => {
  const other = 'integration-board';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  const plan = await mcpFor(other, 'plan', {
    title: 'Board test',
    steps: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
  });
  await call(`/api/session/${other}/gate/${String(plan['gateId'])}/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      verdict: 'approved',
      steps: [
        { id: 's1', title: 'One' },
        { id: 's2', title: 'Two' },
        { id: 's3', title: 'Three', status: 'dropped' },
      ],
    }),
  });

  const s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.equal(s.tasks.length, 2, 'dropped steps do not become tasks');
  assert.ok(s.tasks.every((t) => t.status === 'todo'));
  assert.deepEqual(s.tasks.map((t) => t.title), ['One', 'Two']);
});

test('files edited are attributed to the task in progress', async () => {
  const other = 'integration-attribute';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'tasks', { tasks: [{ title: 'First' }, { title: 'Second' }] });

  let s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  const [first, second] = s.tasks;

  await mcpFor(other, 'task_update', { task_id: first!.id, status: 'in_progress' });
  await hookFor(other, 'PostToolUse', {
    tool_name: 'Edit',
    tool_input: { file_path: path.join(repo, 'app.ts') },
  });

  await mcpFor(other, 'task_update', { task_id: second!.id, status: 'in_progress' });
  await hookFor(other, 'PostToolUse', {
    tool_name: 'Write',
    tool_input: { file_path: path.join(repo, 'other.ts') },
  });

  s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.deepEqual(s.tasks.find((t) => t.id === first!.id)!.files, ['app.ts']);
  assert.deepEqual(s.tasks.find((t) => t.id === second!.id)!.files, ['other.ts']);
  assert.equal(
    s.tasks.filter((t) => t.status === 'in_progress').length,
    1,
    'starting a task stands the previous one down',
  );
});

test('files changed through the shell are still attributed to the task', async () => {
  // Attribution cannot depend on Edit/Write tool events: a heredoc, `sed` or a
  // formatter changes files with no tool call to hang them on.
  const other = 'integration-shelledit';
  const shellRepo = mkdtempSync(path.join(tmpdir(), 'cc-harness-shell-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: shellRepo });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: shellRepo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: shellRepo });
  writeFileSync(path.join(shellRepo, 'seed.ts'), 'export const seed = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: shellRepo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: shellRepo });

  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    call<HookOutput>(`/hook/${event}`, {
      method: 'POST',
      body: JSON.stringify({ session_id: other, cwd: shellRepo, ...extra }),
    });
  const mcp = (tool: string, extra: Record<string, unknown> = {}) =>
    call<Record<string, unknown>>(`/mcp/${tool}`, {
      method: 'POST',
      headers: { 'x-harness-session': other },
      body: JSON.stringify({ cwd: shellRepo, ...extra }),
    });

  await hook('SessionStart', { start_reason: 'startup' });
  await mcp('tasks', { tasks: [{ title: 'Shell task' }] });
  const before = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  const task = before.tasks[0]!;

  await mcp('task_update', { task_id: task.id, status: 'in_progress' });

  // No Edit/Write event — the file just changes on disk.
  writeFileSync(path.join(shellRepo, 'seed.ts'), 'export const seed = 2;\n');
  writeFileSync(path.join(shellRepo, 'brand-new.ts'), 'export const fresh = true;\n');

  await mcp('task_update', { task_id: task.id, status: 'done', note: 'did it with sed' });

  const after = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.deepEqual(after.tasks[0]!.files.sort(), ['brand-new.ts', 'seed.ts']);
  rmSync(shellRepo, { recursive: true, force: true });
});

test('claiming a task moves the session into the implementing stage', async () => {
  const other = 'integration-autostage';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'plan', { title: 'Stage test', steps: [{ title: 'One' }] });
  let s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.equal(s.stage, 'plan_review');

  await mcpFor(other, 'tasks', { tasks: [{ title: 'Do the thing' }] });
  s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  await mcpFor(other, 'task_update', { task_id: s.tasks[0]!.id, status: 'in_progress' });

  s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.equal(s.stage, 'implementing', 'the stage follows the board, not a separate tool call');
});

test('completing a task requires a record of what changed', async () => {
  const other = 'integration-taskdone';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'tasks', { tasks: [{ title: 'Only' }] });
  const s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  const task = s.tasks[0]!;

  const refused = await mcpFor(other, 'task_update', { task_id: task.id, status: 'done' });
  assert.equal(refused['ok'], false);
  assert.match(String(refused['text']), /requires `note`/);

  const accepted = await mcpFor(other, 'task_update', {
    task_id: task.id.slice(0, 8),
    status: 'done',
    note: 'Added the helper and wired it in.',
  });
  assert.equal(accepted['ok'], true, 'the short id prefix is accepted');

  const after = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.equal(after.tasks[0]!.status, 'done');
  assert.match(after.tasks[0]!.notes.at(-1)!.text, /Added the helper/);
});

test('blocking a task asks the user and records their answer as a decision', async () => {
  const other = 'integration-block';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'tasks', { tasks: [{ title: 'Needs a decision' }] });
  let s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  const task = s.tasks[0]!;

  const blocked = await mcpFor(other, 'task_block', {
    task_id: task.id,
    question: 'Map or plain object?',
    options: ['Map', 'Plain object'],
  });
  const gateId = String(blocked['gateId']);

  s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  assert.equal(s.tasks[0]!.status, 'blocked');
  assert.equal(s.tasks[0]!.blockedBy, gateId);

  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'answered', comment: 'Map' }),
  });

  s = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  const after = s.tasks[0]!;
  assert.equal(after.status, 'in_progress', 'answering unblocks the task');
  assert.equal(after.decisions.length, 1);
  assert.equal(after.decisions[0]!.answer, 'Map');
  assert.match(after.decisions[0]!.question, /Map or plain object/);
  assert.ok(after.notes.some((n) => n.kind === 'decision'));
});

test('a second round marks only what actually moved', async () => {
  const other = 'integration-rounds2';
  const roundRepo = mkdtempSync(path.join(tmpdir(), 'cc-harness-rounds-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: roundRepo });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: roundRepo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: roundRepo });
  writeFileSync(path.join(roundRepo, 'stable.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(roundRepo, 'moving.ts'), 'export const b = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: roundRepo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: roundRepo });
  writeFileSync(path.join(roundRepo, 'stable.ts'), 'export const a = 2;\n');
  writeFileSync(path.join(roundRepo, 'moving.ts'), 'export const b = 2;\n');

  await call(`/hook/SessionStart`, {
    method: 'POST',
    body: JSON.stringify({ session_id: other, cwd: roundRepo, start_reason: 'startup' }),
  });
  const first = await call<Record<string, unknown>>(`/mcp/diff`, {
    method: 'POST',
    headers: { 'x-harness-session': other },
    body: JSON.stringify({ cwd: roundRepo }),
  });
  assert.equal(first['round'], 1);

  // Only one of the two files changes between rounds.
  writeFileSync(path.join(roundRepo, 'moving.ts'), 'export const b = 3;\n');
  await call(`/mcp/diff`, {
    method: 'POST',
    headers: { 'x-harness-session': other },
    body: JSON.stringify({ cwd: roundRepo }),
  });

  const { diff } = await call<{ diff: DiffPayload }>(`/api/session/${other}/diff`);
  assert.equal(diff.round, 2);
  assert.equal(diff.previousRound, 1);
  assert.deepEqual(diff.changedSinceLastReview, ['moving.ts']);
  assert.equal(diff.files.find((f) => f.path === 'stable.ts')!.changedSinceLastReview, false);
  assert.equal(diff.files.find((f) => f.path === 'moving.ts')!.changedSinceLastReview, true);
  rmSync(roundRepo, { recursive: true, force: true });
});

test('Claude can reply to a comment in its thread', async () => {
  const other = 'integration-reply';
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'diff', {});
  const gate = await call<{ session: SessionState }>(`/api/session/${other}`)
    .then((r) => r.session.gates.find((g) => g.status === 'open')!);

  await call(`/api/session/${other}/gate/${gate.id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      verdict: 'changes_requested',
      threads: [
        { id: '', file: 'app.ts', side: 'new', startLine: 1, endLine: 1, body: 'why?', createdAt: 0, resolved: false },
      ],
    }),
  });
  const withThread = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  const threadId = withThread.threads[0]!.id;

  const replied = await mcpFor(other, 'reply', { thread_id: threadId, text: 'Because of X.' });
  assert.equal(replied['ok'], true);

  const after = await call<{ session: SessionState }>(`/api/session/${other}`).then((r) => r.session);
  const thread = after.threads[0]!;
  assert.equal(thread.replies?.length, 1);
  assert.equal(thread.replies![0]!.author, 'claude');
  assert.equal(thread.replies![0]!.text, 'Because of X.');
  assert.equal(thread.resolved, true, 'replying resolves the thread by default');
});

test('the diff is persisted, so a daemon restart does not empty the review', async () => {
  // It used to live only in an in-memory Map: a restart left the session
  // intact but the Review tab blank.
  const other = 'integration-diffpersist';
  // Earlier tests may have left the tree clean; make sure there is a change.
  writeFileSync(path.join(repo, 'persisted.ts'), 'export const persisted = true;\n');
  await hookFor(other, 'SessionStart', { start_reason: 'startup' });
  await mcpFor(other, 'diff', {});

  const served = await call<{ diff: DiffPayload }>(`/api/session/${other}/diff`);
  assert.ok(served.diff.files.length > 0);

  const onDisk = JSON.parse(
    readFileSync(path.join(home, 'sessions', other, 'diff.json'), 'utf8'),
  ) as DiffPayload;
  assert.equal(onDisk.files.length, served.diff.files.length);
  assert.equal(onDisk.baseRef, served.diff.baseRef);
  rmSync(path.join(repo, 'persisted.ts'), { force: true });
});

test('the diff engine sees uncommitted and untracked work', async () => {
  writeFileSync(
    path.join(repo, 'app.ts'),
    'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function subtract(a: number, b: number) {\n  return a - b;\n}\n',
  );
  writeFileSync(path.join(repo, 'app.test.ts'), 'import { subtract } from "./app";\nsubtract(2, 1);\n');

  const published = await mcp('diff', {});
  assert.match(String(published['text']), /Diff published \(round \d+\): 2 file\(s\)/);

  const { diff } = await call<{ diff: DiffPayload }>(`/api/session/${sessionId}/diff`);
  const app = diff.files.find((f) => f.path === 'app.ts');
  const test = diff.files.find((f) => f.path === 'app.test.ts');
  assert.ok(app, 'the modified file is present');
  assert.equal(test?.status, 'added', 'the untracked file is present as an addition');
  assert.ok((app?.additions ?? 0) >= 4);
});

test('a line comment reaches the session with the source the user selected', async () => {
  const s = await session();
  const gate = s.gates.find((g) => g.status === 'open' && g.kind === 'code_review');
  assert.ok(gate, 'publishing the diff opened the review gate');

  const parked = hook('Stop', { stop_hook_active: false });
  await until(async () => (await session()).status === 'waiting');

  await call(`/api/session/${sessionId}/gate/${gate.id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({
      verdict: 'changes_requested',
      comment: 'One thing.',
      threads: [
        {
          id: '',
          file: 'app.ts',
          side: 'new',
          startLine: 5,
          endLine: 6,
          body: 'Guard against NaN here.',
          createdAt: 0,
          resolved: false,
        },
      ],
    }),
  });

  const out = await parked;
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /app\.ts:5-6/);
  assert.match(out.reason ?? '', /Guard against NaN here/);
  assert.match(out.reason ?? '', /subtract/, 'the excerpt is filled in from the diff');
  assert.match(out.reason ?? '', /Address each comment above/);
  assert.match(out.reason ?? '', /harness_reply/);
});

test('checks run and stream their result', async () => {
  await mcp('checks', { commands: ['echo hello-from-check'], run: true });
  const passed = await until(async () => {
    const s = await session();
    const check = s.checks[0];
    return check && check.status !== 'pending' && check.status !== 'running' ? check : null;
  }, 15_000);

  assert.equal(passed.status, 'passed');
  assert.equal(passed.exitCode, 0);
  assert.match(passed.output, /hello-from-check/);
});

test('a failing check is reported as failing', async () => {
  await call(`/api/session/${sessionId}/checks`, {
    method: 'POST',
    body: JSON.stringify({ commands: ['exit 3'] }),
  });
  await call(`/api/session/${sessionId}/checks/run`, { method: 'POST', body: '{}' });

  const failed = await until(async () => {
    const s = await session();
    const check = s.checks[0];
    return check && (check.status === 'failed' || check.status === 'passed') ? check : null;
  }, 15_000);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 3);
});

test('the ship payload is composed from the approved plan and the checks', async () => {
  const ship = await mcp('ship', {});
  const payload = ship['ship'] as { title: string; body: string; commitMessage: string; branch: string };

  assert.equal(payload.title, 'Add a subtract function');
  assert.equal(payload.branch, 'feature/change');
  assert.match(payload.body, /Mirror add\(\)/);
  assert.match(payload.body, /Write subtract/);
  assert.doesNotMatch(payload.body, /Update the docs/, 'dropped steps stay out of the PR body');
  assert.match(payload.body, /## Verification/);
  assert.match(payload.commitMessage, /^Add a subtract function/);
});

test('ship refuses to proceed while a check is failing', async () => {
  const s = await session();
  const result = await call<{ ok: boolean; output: string }>(`/api/session/${sessionId}/ship`, {
    method: 'POST',
    body: JSON.stringify({ ship: { ...s.ship, steps: ['checks', 'commit'] } }),
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /check\(s\) failing/);
});

test('async comments ride along with the next user prompt', async () => {
  await call(`/api/session/${sessionId}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ text: 'also rename the file', origin: 'timeline' }),
  });
  const out = await hook('UserPromptSubmit', { user_input: 'continue' });
  assert.match(out.hookSpecificOutput?.additionalContext ?? '', /also rename the file/);
  assert.equal(out.decision, undefined, 'context injection never blocks the prompt');
});

test('SessionEnd closes the session out', async () => {
  await hook('SessionEnd', { end_reason: 'other' });
  const s = await session();
  assert.equal(s.status, 'ended');
  assert.ok(s.endedAt);
});
