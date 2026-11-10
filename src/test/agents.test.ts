import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { readLiveLock, baseUrl } from '../shared/paths.ts';
import { BUILD_MARKER, PROMPT_BUDGET } from '../daemon/render.ts';
import { readAgentHook, writeAgentOutput } from '../daemon/agentHooks.ts';
import { agentInfo, parseAgent, sessionFromEnv, workspaceFromEnv } from '../shared/agents.ts';
import { codexHooks, relayCalls } from '../cli/doctor.ts';
import type { DaemonLock, SessionState, SessionSummary } from '../shared/types.ts';

/**
 * Coplan with Codex and Cursor: the same daemon, reached through each
 * agent's own hooks. A real daemon, real hook payloads in each agent's
 * shape, and the MCP bridge as each agent's server calls it.
 */

const DAEMON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'main.js');
const MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'main.js');

let home: string;
let repo: string;
let daemon: ChildProcess;
let lock: DaemonLock;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'coplan-agents-home-'));
  repo = mkdtempSync(path.join(tmpdir(), 'coplan-agents-repo-'));
  process.env['CC_HARNESS_HOME'] = home;
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ idleShutdownMinutes: 0 }));
  daemon = spawn(process.execPath, [DAEMON], { env: { ...process.env, CC_HARNESS_HOME: home }, stdio: 'ignore' });
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
  if (daemon && daemon.exitCode === null) {
    await new Promise<void>((resolve) => {
      daemon.once('exit', () => resolve());
      daemon.kill('SIGTERM');
      setTimeout(() => {
        daemon.kill('SIGKILL');
        resolve();
      }, 3000).unref();
    });
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/* ------------------------------------------------------------------ */

async function call<T>(route: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${baseUrl(lock)}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${lock.token}`, ...(init.headers ?? {}) },
  });
  return (await res.json()) as T;
}

/** A hook as the relay sends it: the agent's own event name and payload. */
const hook = (agent: string, event: string, body: Record<string, unknown>) =>
  call<Record<string, unknown>>(`/hook/${event}`, { method: 'POST', headers: { 'x-harness-agent': agent }, body: JSON.stringify(body) });

/** A tool call as each agent's MCP server sends it. */
const mcp = (agent: string, tool: string, body: Record<string, unknown>, sessionId = '') =>
  call<{ ok: boolean; text: string }>(`/mcp/${tool}`, {
    method: 'POST',
    headers: { 'x-harness-agent': agent, 'x-harness-session': sessionId },
    body: JSON.stringify({ cwd: repo, ...body }),
  });

const session = (id: string) => call<{ session: SessionState }>(`/api/session/${id}`).then((r) => r.session);

const PLAN = {
  title: 'Add a cache',
  summary: 'A read-through cache.',
  diagrams: [{ title: 'Components', nodes: [{ id: 'api', label: 'API' }, { id: 'db', label: 'Postgres' }], edges: [{ source: 'api', target: 'db' }] }],
  tasks: [{ title: 'Client' }, { title: 'Wire up' }],
};

async function submit(id: string): Promise<void> {
  // The design is confirmed before the plan is submitted.
  const confirmed = await call<{ error?: string }>(`/api/session/${id}/plan/design/confirm`, { method: 'POST', body: '{}' });
  assert.equal(confirmed.error, undefined);
  const preview = await call<{ version: number }>(`/api/session/${id}/plan/prompt`, {
    method: 'POST',
    body: JSON.stringify({ target: 'session' }),
  });
  const res = await call<{ error?: string }>(`/api/session/${id}/plan/submit`, {
    method: 'POST',
    body: JSON.stringify({ target: 'session', expect: preview.version }),
  });
  assert.equal(res.error, undefined);
}

/* --------------------------------------------------------------- Codex */

const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';

test('a Codex session registers as Codex, with a link that opens the thread in the Codex app', async () => {
  const out = await hook('codex', 'SessionStart', { session_id: THREAD, cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
  assert.deepEqual(out, {}, 'Codex refuses fields an event does not take, so a no-op is empty');
  const s = await session(THREAD);
  assert.equal(s.agent, 'codex');
  assert.equal(s.link?.app, `codex://threads/${THREAD}`);
  assert.equal(s.link?.web, null);
});

test("Codex's MCP server finds its session by thread id, and is told to ask with request_user_input", async () => {
  const res = await mcp('codex', 'publish', PLAN, THREAD);
  assert.equal(res.ok, true, res.text);
  assert.match(res.text, /request_user_input/);
  assert.doesNotMatch(res.text, /AskUserQuestion/);
});

test("a Codex thread whose hooks Codex does not run shows as one, and the doctor says how to fix it (#52)", async () => {
  // Codex skips a plugin's hooks until the user trusts them in /hooks — and
  // again after an update changes them. The tools still work, by thread id.
  const untrusted = '0199a213-81c0-7800-8aa1-0000000000aa';
  const res = await mcp('codex', 'publish', { ...PLAN, title: 'Hookless' }, untrusted);
  assert.equal(res.ok, true, res.text);
  const rows = () => call<{ sessions: SessionSummary[] }>('/api/sessions').then((r) => r.sessions);
  let row = (await rows()).find((r) => r.sessionId === untrusted)!;
  assert.equal(row.hooked, false, 'known only from its tool calls');
  assert.equal((await rows()).find((r) => r.sessionId === THREAD)?.hooked, true, 'a thread whose SessionStart arrived');
  let verdict = codexHooks(await rows());
  assert.equal(verdict?.ok, false);
  assert.match(verdict!.detail, /"Hookless" used Coplan's tools, but none of its hooks reached Coplan: open \/hooks in Codex, trust Coplan's hooks — again after every update/);

  // Trusted, its next hook counts: the latest thread runs them now.
  await hook('codex', 'UserPromptSubmit', { session_id: untrusted, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  row = (await rows()).find((r) => r.sessionId === untrusted)!;
  assert.equal(row.hooked, true);
  verdict = codexHooks(await rows());
  assert.equal(verdict?.ok, true);

  // No Codex thread has used Coplan: nothing to say. An older thread without
  // hooks does not outweigh the latest one with them.
  assert.equal(codexHooks([]), null);
  const summary = (id: string, updatedAt: number, hooked: boolean) => ({ sessionId: id, agent: 'codex', engaged: true, updatedAt, hooked, title: id, planTitle: null }) as SessionSummary;
  assert.deepEqual(codexHooks([summary('old', 1, false), summary('new', 2, true)]), { ok: true, detail: "its latest thread's hooks reach Coplan (1 earlier thread did not)" });
  assert.equal(codexHooks([summary('old', 1, true), summary('new', 2, false)])?.ok, false);
});

test('a Codex request_user_input is shown as a question, and cleared when answered', async () => {
  await hook('codex', 'PreToolUse', {
    session_id: THREAD,
    cwd: repo,
    tool_name: 'request_user_input',
    tool_input: { questions: [{ id: 'db', header: 'Store', question: 'Which cache?', options: [{ label: 'Redis', description: 'fast' }, { label: 'Memcached' }] }] },
  });
  let s = await session(THREAD);
  assert.equal(s.waiting?.kind, 'question');
  assert.deepEqual(s.waiting?.questions?.[0]?.options, ['Redis', 'Memcached']);
  await hook('codex', 'PostToolUse', { session_id: THREAD, cwd: repo, tool_name: 'request_user_input' });
  s = await session(THREAD);
  assert.equal(s.waiting, null);
});

test('a submitted plan rides along with the next Codex prompt, as it does in Claude Code', async () => {
  await submit(THREAD);
  const out = await hook('codex', 'UserPromptSubmit', { session_id: THREAD, cwd: repo, prompt: 'go' });
  const context = (out['hookSpecificOutput'] as { additionalContext?: string } | undefined)?.additionalContext ?? '';
  assert.ok(context.startsWith(BUILD_MARKER), 'the build prompt is added to the prompt');
  assert.match(context, /request_user_input/, 'and says how this agent asks');
});

/* -------------------------------------------------------------- Cursor */

const CHAT = 'cursor-chat-1';
const cursorBase = { conversation_id: CHAT, generation_id: 'g1', workspace_roots: [] as string[], cursor_version: '2.0.0' };

test('a Cursor chat registers from its own payload: conversation id and workspace root', async () => {
  const base = { ...cursorBase, workspace_roots: [repo] };
  const out = await hook('cursor', 'sessionStart', { ...base, hook_event_name: 'sessionStart', session_id: CHAT });
  assert.equal('suppressOutput' in out, false, 'Cursor is answered in its own format');
  const s = await session(CHAT);
  assert.equal(s.agent, 'cursor');
  assert.equal(s.cwd, repo);
  assert.equal(s.link, null, 'Cursor has no link to a chat');
});

test("Cursor's MCP server, shared by the window, finds the chat by workspace", async () => {
  const res = await mcp('cursor', 'publish', PLAN);
  assert.equal(res.ok, true, res.text);
  assert.equal((await session(CHAT)).plan?.title, 'Add a cache');
  assert.doesNotMatch(res.text, /AskUserQuestion/);
});

test('a Cursor turn that ends on a question is waiting on the user', async () => {
  const base = { ...cursorBase, workspace_roots: [repo] };
  await hook('cursor', 'afterAgentResponse', { ...base, hook_event_name: 'afterAgentResponse', text: 'Done with the outline.\n\nShould the cache be per tenant?' });
  const out = await hook('cursor', 'stop', { ...base, hook_event_name: 'stop', status: 'completed', loop_count: 0 });
  assert.equal(out['followup_message'], undefined, 'stop never sends Cursor on');
  const s = await session(CHAT);
  assert.equal(s.waiting?.kind, 'input');
  assert.match(s.waiting?.text ?? '', /per tenant\?/);
});

test('in Cursor the build prompt is pasted, or picked up by the next read', async () => {
  const base = { ...cursorBase, workspace_roots: [repo] };
  await submit(CHAT);

  // An ordinary message cannot carry it: Cursor's hooks cannot add to a prompt.
  const typed = await hook('cursor', 'beforeSubmitPrompt', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'go' });
  assert.deepEqual(typed, { continue: true });
  assert.ok(!(await session(CHAT)).plan?.submission?.deliveredAt, 'still waiting for the prompt to reach Cursor');

  // Asked to build without it, Cursor reads the plan and gets the prompt.
  const read = await mcp('cursor', 'read', {});
  assert.ok(read.text.startsWith(BUILD_MARKER));
  assert.ok((await session(CHAT)).plan?.submission?.deliveredAt, 'and that counts as delivered');
  const again = await mcp('cursor', 'read', {});
  assert.ok(!again.text.startsWith(BUILD_MARKER), 'only once');
});

test('pasting the build prompt into Cursor counts as delivering it', async () => {
  const id = 'cursor-chat-2';
  const base = { ...cursorBase, conversation_id: id, workspace_roots: [repo] };
  await hook('cursor', 'sessionStart', { ...base, hook_event_name: 'sessionStart' });
  await mcp('cursor', 'publish', PLAN);
  await submit(id);
  // Only the whole prompt counts: an older prompt for the same plan starts
  // the same way, and must not stand in for this one.
  await hook('cursor', 'beforeSubmitPrompt', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: `${BUILD_MARKER} "Add a cache" …` });
  assert.equal((await session(id)).plan?.submission?.deliveredAt, null);
  const prompt = (await session(id)).plan!.submission!.prompt;
  await hook('cursor', 'beforeSubmitPrompt', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: `Here it is:\n\n${prompt}` });
  assert.ok((await session(id)).plan?.submission?.deliveredAt);
});

test('in Cursor the design prompt is picked up by the next read, and a paste counts as delivering it', async () => {
  for (const pasted of [false, true]) {
    const id = `cursor-design-${pasted ? 'paste' : 'read'}`;
    const base = { ...cursorBase, conversation_id: id, workspace_roots: [repo] };
    await hook('cursor', 'sessionStart', { ...base, hook_event_name: 'sessionStart' });
    await mcp('cursor', 'publish', PLAN, id);
    const confirmed = await call<{ plan?: { design?: { prompt: string } } }>(`/api/session/${id}/plan/design/confirm`, { method: 'POST', body: '{}' });
    const prompt = confirmed.plan!.design!.prompt;
    assert.match(prompt, /^\[cc-harness\] The design is confirmed/);
    assert.match(prompt, /Ask the user, with AskQuestion or plainly, only when/, "Cursor's own question tool");

    // An ordinary message cannot carry it.
    await hook('cursor', 'beforeSubmitPrompt', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'go' });
    assert.equal((await session(id)).plan?.design?.deliveredAt, null);

    if (pasted) {
      await hook('cursor', 'beforeSubmitPrompt', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt });
    } else {
      const read = await mcp('cursor', 'read', {}, id);
      assert.equal(read.text, prompt, 'the first read after confirming is the design prompt');
      assert.ok(!(await mcp('cursor', 'read', {}, id)).text.startsWith('[cc-harness] The design'), 'only once');
    }
    assert.ok((await session(id)).plan?.design?.deliveredAt, pasted ? 'a paste delivers it' : 'the read delivered it');
  }
});

test('an unknown Cursor event is answered with nothing, never an error', async () => {
  const out = await hook('cursor', 'beforeReadFile', { ...cursorBase, workspace_roots: [repo], hook_event_name: 'beforeReadFile', file_path: 'x' });
  assert.deepEqual(out, {});
});

/* --------------------------------------------------- the MCP server */

/**
 * One tool call through a real MCP server process, as `agent` starts it.
 * `client` answers the server's own requests (`roots/list`).
 */
function serverCall(
  env: Record<string, string>,
  call: { name: string; arguments: Record<string, unknown>; _meta?: Record<string, unknown> },
  opts: { roots?: string[]; cwd?: string } = {},
): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], {
      cwd: opts.cwd ?? tmpdir(),
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', CC_HARNESS_HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('no answer from the MCP server'));
    }, 10_000);
    const write = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    createInterface({ input: child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as { id?: unknown; method?: string; result?: { content?: { text: string }[]; isError?: boolean } };
      if (msg.method === 'roots/list') {
        write({ jsonrpc: '2.0', id: msg.id, result: { roots: (opts.roots ?? []).map((r) => ({ uri: pathToFileURL(r).href, name: 'w' })) } });
        return;
      }
      if (msg.id === 1) {
        write({ jsonrpc: '2.0', method: 'notifications/initialized' });
        write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: call });
      }
      if (msg.id === 2) {
        clearTimeout(timer);
        child.stdin.end();
        resolve({ text: msg.result?.content?.[0]?.text ?? '', isError: Boolean(msg.result?.isError) });
      }
    });
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: opts.roots ? { roots: { listChanged: true } } : {}, clientInfo: { name: 't', version: '0' } },
    });
  });
}

test("a Claude tool call naming no session never takes over another agent's in its folder", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'coplan-shared-folder-'));
  const other = mkdtempSync(path.join(tmpdir(), 'coplan-cursor-folder-'));
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'coplan-elsewhere-'));
  try {
    const thread = '019a0000-0000-7000-8000-00000000b7b7';
    await hook('codex', 'SessionStart', { session_id: thread, cwd: folder, hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal((await mcp('codex', 'publish', { ...PLAN, title: "Codex's plan", cwd: folder }, thread)).ok, true);
    // A Claude Code that names no session (no CLAUDE_CODE_SESSION_ID) and has none of its own here.
    const read = await mcp('claude', 'read', { cwd: folder, pid: 424242 });
    assert.doesNotMatch(read.text, /Codex's plan/, "it is not handed the Codex thread's plan");
    // Nor does its process come to stand for the thread: the reaper would end the thread when Claude exits.
    assert.doesNotMatch((await mcp('claude', 'read', { cwd: elsewhere, pid: 424242 })).text, /Codex's plan/);
    // And a pid the Codex app gave its thread is the Codex app's: a Claude call with the same one is not the thread's.
    await mcp('codex', 'read', { cwd: folder, pid: 515151 }, thread);
    assert.doesNotMatch((await mcp('claude', 'read', { cwd: elsewhere, pid: 515151 })).text, /Codex's plan/);

    // What the fallback is for: Cursor running Claude Code's config names itself Claude, and still finds its chat.
    const chat = 'cursor-chat-b7';
    await hook('cursor', 'sessionStart', { ...cursorBase, conversation_id: chat, workspace_roots: [other], hook_event_name: 'sessionStart', session_id: chat });
    const published = await mcp('claude', 'publish', { ...PLAN, title: "Cursor's plan", cwd: other, pid: 434343 });
    assert.equal(published.ok, true, published.text);
    assert.equal((await session(chat)).plan?.title, "Cursor's plan");
    // Its process stands for the chat from then on: a Claude session started in that folder later does not take its calls.
    await hook('claude', 'SessionStart', { session_id: 'claude-later-b7', cwd: other, source: 'startup' });
    assert.equal((await mcp('claude', 'publish', { ...PLAN, title: "Cursor's plan, again", cwd: other, pid: 434343 })).ok, true);
    assert.equal((await session(chat)).plan?.title, "Cursor's plan, again");
    assert.equal((await session('claude-later-b7')).plan, null);
  } finally {
    for (const dir of [folder, other, elsewhere]) rmSync(dir, { recursive: true, force: true });
  }
});

test('the Codex MCP server takes its thread from each call, not from its folder or environment', async () => {
  const other = '0199a213-81c0-7800-8aa1-000000000002';
  await hook('codex', 'SessionStart', { session_id: other, cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
  // Codex starts the server in the plugin's own folder, with a bare environment.
  const res = await serverCall(
    { COPLAN_AGENT: 'codex' },
    { name: 'harness_task_update', arguments: { task_id: 't1', status: 'in_progress' }, _meta: { threadId: other } },
    { cwd: path.dirname(MCP) },
  );
  assert.equal(res.isError, true, 'the new thread has no plan yet, so the update is refused…');
  assert.match(res.text, /No task "t1"/);
  const read = await serverCall({ COPLAN_AGENT: 'codex' }, { name: 'harness_plan_read', arguments: {}, _meta: { threadId: THREAD } });
  assert.match(read.text, /Add a cache/, '…while the thread that published reads its own plan');
});

test('the Cursor MCP server learns the open folder from MCP roots when its config could not say', async () => {
  const res = await serverCall(
    { COPLAN_AGENT: 'cursor', COPLAN_WORKSPACE: '${workspaceFolder}' },
    { name: 'harness_plan_read', arguments: { changes_only: true } },
    { roots: [repo] },
  );
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /Add a cache/);
});

test('each agent is told to ask with its own question tool', async () => {
  const list = (agent: string) =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [MCP], { env: { ...process.env, CC_HARNESS_HOME: home, COPLAN_AGENT: agent }, stdio: ['pipe', 'pipe', 'ignore'] });
      createInterface({ input: child.stdout }).on('line', (line) => {
        child.stdin.end();
        resolve(line);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    });
  assert.match(await list('claude'), /AskUserQuestion/);
  assert.match(await list('codex'), /request_user_input/);
  assert.doesNotMatch(await list('codex'), /AskUserQuestion/);
  assert.match(await list('cursor'), /AskQuestion/);
});

/* ---------------------------------------------------------------- units */

test('agents are named by the relay and the MCP config; anything else is Claude Code', () => {
  assert.equal(parseAgent('codex'), 'codex');
  assert.equal(parseAgent(' Cursor '), 'cursor');
  assert.equal(parseAgent(undefined), 'claude');
  assert.equal(parseAgent('vim'), 'claude');
  assert.equal(agentInfo('codex').name, 'Codex');
});

test("each agent's session id is read from its own variable", () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'claude-1', CODEX_THREAD_ID: 'codex-1' };
  assert.equal(sessionFromEnv(env, 'claude'), 'claude-1');
  assert.equal(sessionFromEnv(env, 'codex'), 'codex-1');
  assert.equal(sessionFromEnv(env, 'cursor'), null);
  assert.equal(sessionFromEnv({ CURSOR_CONVERSATION_ID: 'chat-1' }, 'cursor'), 'chat-1');
  assert.equal(workspaceFromEnv({ COPLAN_WORKSPACE: '/repo' }), '/repo');
  assert.equal(workspaceFromEnv({ COPLAN_WORKSPACE: '${workspaceFolder}' }), null, 'an unexpanded variable names no folder');
});

test("Cursor's payloads are read as Claude Code's, and answered in Cursor's format", () => {
  const { event, input } = readAgentHook('cursor', 'beforeSubmitPrompt', { conversation_id: 'c', workspace_roots: ['/w'], prompt: 'hi' });
  assert.equal(event, 'UserPromptSubmit');
  assert.equal(input.session_id, 'c');
  assert.equal(input.cwd, '/w');
  assert.deepEqual(writeAgentOutput('cursor', 'beforeSubmitPrompt', { suppressOutput: true }), { continue: true });
  assert.equal(readAgentHook('cursor', 'beforeReadFile', {}).event, null);
  // Claude Code and Codex pass straight through.
  const raw = { session_id: 's', cwd: '/w' };
  assert.deepEqual(readAgentHook('codex', 'Stop', raw), { event: 'Stop', input: raw });
  assert.deepEqual(writeAgentOutput('claude', 'Stop', { suppressOutput: true }), { suppressOutput: true });
});

/* ----------------------------------------------------------- packaging */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (file: string) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as Record<string, unknown>;

test('every agent manifest carries the package version and points at files that exist', () => {
  const version = readJson('package.json')['version'];
  for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    const m = readJson(manifest);
    assert.equal(m['name'], 'coplan', manifest);
    assert.equal(m['version'], version, `${manifest} is at the package version`);
    for (const key of ['hooks', 'mcpServers', 'skills', 'commands']) {
      const target = m[key];
      if (typeof target === 'string') assert.ok(existsSync(path.join(ROOT, target)), `${manifest} ${key}: ${target}`);
    }
  }
  assert.deepEqual(readJson('.codex-plugin/plugin.json')['commands'], [], "Codex does not turn Claude Code's slash commands into skills");
});

test("the Cursor and Codex manifests keep to each agent's rules", () => {
  // Cursor's schema (cursor/plugins schemas/plugin.schema.json) allows no other key.
  const CURSOR_KEYS = ['name', 'displayName', 'description', 'version', 'minClientVersions', 'author', 'publisher', 'homepage', 'repository', 'license', 'logo', 'keywords', 'category', 'tags', 'commands', 'agents', 'skills', 'rules', 'hooks', 'variables', 'mcpServers'];
  const cursor = readJson('.cursor-plugin/plugin.json');
  for (const key of Object.keys(cursor)) assert.ok(CURSOR_KEYS.includes(key), `Cursor does not know "${key}"`);
  assert.match(cursor['name'] as string, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
  for (const manifest of ['.cursor-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    const m = readJson(manifest);
    assert.match(m['version'] as string, /^\d+\.\d+\.\d+$/, `${manifest} version is X.Y.Z`);
    // Both resolve a component path against the plugin folder: relative, and never outside it.
    for (const key of ['skills', 'commands', 'hooks', 'mcpServers', 'logo']) {
      const value = m[key];
      for (const p of typeof value === 'string' ? [value] : Array.isArray(value) ? value : []) {
        assert.match(p as string, /^\.\//, `${manifest} ${key} is relative: ${p}`);
        assert.ok(!(p as string).includes('..'), `${manifest} ${key} stays inside the plugin: ${p}`);
      }
    }
  }
});

test('a version is released with its changelog: no bump without a heading for it', () => {
  const version = readJson('package.json')['version'] as string;
  const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  // Unreleased work may sit above it; the newest released heading is this version.
  const released = [...changelog.matchAll(/^## (.+)$/gm)].map((m) => m[1]).filter((h) => h !== 'Unreleased');
  assert.equal(released[0], version, `the newest version in CHANGELOG.md is ${version}, the one every manifest carries`);
});

const COMMANDS = readdirSync(path.join(ROOT, 'commands'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort();

test('the docs list the slash commands each agent really ships', () => {
  // Claude Code finds commands/ by itself; Cursor's manifest points at it; Codex's lists none.
  assert.equal(readJson('.cursor-plugin/plugin.json')['commands'], './commands/');
  const row = readFileSync(path.join(ROOT, 'README.md'), 'utf8').split('\n').find((l) => l.startsWith('| Slash commands |'))!;
  const [, claude, codex, cursor] = row.split('|').map((c) => c.trim()).filter(Boolean);
  const named = (cell: string) => [...cell.matchAll(/`\/([\w-]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(named(claude!), COMMANDS, 'Claude Code');
  assert.deepEqual(named(cursor!), COMMANDS, 'Cursor');
  assert.match(codex!, /^none/, 'Codex');
  const skill = readFileSync(path.join(ROOT, 'skills', 'coplan', 'SKILL.md'), 'utf8');
  const listed = skill.match(/In Claude Code and Cursor these are also ([^.]+)\./s)?.[1] ?? '';
  assert.deepEqual(named(listed), COMMANDS, 'the skill');
});

test('every command names itself, and finds the plugin where an agent leaves its path empty', () => {
  for (const name of COMMANDS) {
    const text = readFileSync(path.join(ROOT, 'commands', `${name}.md`), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`), `${name} frontmatter`);
    if (text.includes('${CLAUDE_PLUGIN_ROOT}')) assert.match(text, /CURSOR_PLUGIN_ROOT[\s\S]*commands\/` folder/, `${name} says where the plugin is without it`);
  }
});

test('the hooks listen only where each agent can be heard, and give it the same time', () => {
  const hooks = (agent: string) => readJson(`hooks/${agent}.json`)['hooks'] as Record<string, { matcher?: string; timeout?: number; hooks?: { timeout?: number }[] }[]>;
  // Codex: every tool it asks with is matched.
  const codexAsk = hooks('codex')['PreToolUse']!.map((g) => g.matcher ?? '').join('|').split('|');
  for (const tool of agentInfo('codex').askTools) assert.ok(codexAsk.includes(tool), `Codex PreToolUse matches ${tool}`);
  // Cursor: its hooks do not see AskQuestion, so nothing listens for it.
  assert.ok(!JSON.stringify(hooks('cursor')).includes('AskQuestion'), 'no dead Cursor matcher');
  // SessionEnd: the same budget everywhere.
  const endTimeout = (agent: string, event: string) => {
    const g = hooks(agent)[event]![0]!;
    return g.timeout ?? g.hooks?.[0]?.timeout;
  };
  assert.equal(endTimeout('hooks', 'SessionEnd'), endTimeout('codex', 'SessionEnd'));
  assert.equal(endTimeout('hooks', 'SessionEnd'), endTimeout('cursor', 'sessionEnd'));
});

test("doctor reads which agent a hook names, in either agent's hook form", () => {
  assert.deepEqual(relayCalls([{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/bin/coplan-hook-relay.sh', args: ['Stop'] }] }]), [{ event: 'Stop', agent: 'claude' }]);
  assert.deepEqual(relayCalls([{ command: '"${CURSOR_PLUGIN_ROOT}/bin/coplan-hook-relay.sh" stop cursor' }]), [{ event: 'stop', agent: 'cursor' }]);
  for (const [file, agent] of [['hooks/hooks.json', 'claude'], ['hooks/codex.json', 'codex'], ['hooks/cursor.json', 'cursor']] as const) {
    for (const [event, entries] of Object.entries(readJson(file)['hooks'] as Record<string, unknown>)) {
      assert.deepEqual(relayCalls(entries), [{ event, agent }], `${file} ${event}`);
    }
  }
});

test("each agent's MCP config and hooks name that agent", () => {
  for (const agent of ['codex', 'cursor'] as const) {
    const servers = readJson(`mcp/${agent}.json`)['mcpServers'] as Record<string, { env?: Record<string, string> }>;
    assert.equal(servers['harness']?.env?.['COPLAN_AGENT'], agent);
    const hooks = readJson(`hooks/${agent}.json`)['hooks'] as Record<string, unknown>;
    for (const [event, entries] of Object.entries(hooks)) {
      assert.match(JSON.stringify(entries), new RegExp(`coplan-hook-relay\\.sh\\\\?" ${event} ${agent}"`), `${agent} ${event}`);
    }
  }
  assert.equal(readJson('hooks/cursor.json')['version'], 1, 'Cursor refuses a hooks file without a version');
  const codexServer = (readJson('mcp/codex.json')['mcpServers'] as Record<string, { args: string[]; cwd?: string }>)['harness']!;
  assert.equal(codexServer.cwd, '.', 'Codex resolves a plugin server only through a relative cwd');
  assert.ok(!codexServer.args.some((a) => a.includes('${')), 'Codex expands nothing in a plugin server');
});

test('Codex takes the most a message can carry whole: one prompt and the unread notice, in any script', () => {
  const hooks = JSON.parse(readFileSync(path.join(ROOT, 'hooks', 'codex.json'), 'utf8')) as { hooks: Record<string, { hooks: { additionalContextLimit?: number }[] }[]> };
  const limit = hooks.hooks['UserPromptSubmit']![0]!.hooks[0]!.additionalContextLimit;
  // Codex counts approximate tokens, about four bytes each, and past the limit
  // saves the text to a file the model sees only a preview of. A message
  // carries one prompt, up to the budget in characters, and the unread notice
  // (a line); a plan in Chinese or Japanese takes three bytes a character.
  const most = Math.ceil(((PROMPT_BUDGET + 1_000) * 3) / 4);
  assert.ok(typeof limit === 'number' && limit >= most, `additionalContextLimit ${limit} is under ${most}`);
});
