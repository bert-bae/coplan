// src/test/agents.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync as existsSync2, mkdtempSync, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path2 from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

// src/shared/paths.ts
import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
function harnessHome() {
  const override = process.env.CC_HARNESS_HOME;
  return override && !override.includes("${") ? override : path.join(homedir(), ".claude", "cc-harness");
}
var paths = {
  home: harnessHome,
  lockFile: () => path.join(harnessHome(), "daemon.json"),
  logFile: () => path.join(harnessHome(), "daemon.log"),
  sessionsDir: () => path.join(harnessHome(), "sessions"),
  sessionDir: (id) => path.join(harnessHome(), "sessions", sanitizeId(id)),
  sessionState: (id) => path.join(harnessHome(), "sessions", sanitizeId(id), "state.json"),
  sessionEvents: (id) => path.join(harnessHome(), "sessions", sanitizeId(id), "events.jsonl"),
  configDir: harnessHome,
  instructionsDir: () => path.join(harnessHome(), "instructions")
};
function sanitizeId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}
function readLock() {
  try {
    const file = paths.lockFile();
    if (!existsSync(file)) return null;
    const lock2 = JSON.parse(readFileSync(file, "utf8"));
    if (typeof lock2.port !== "number" || typeof lock2.token !== "string") return null;
    return lock2;
  } catch {
    return null;
  }
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function readLiveLock() {
  const lock2 = readLock();
  if (!lock2) return null;
  return isPidAlive(lock2.pid) ? lock2 : null;
}
function baseUrl(lock2) {
  return `http://${lock2.host || "127.0.0.1"}:${lock2.port}`;
}

// src/shared/agents.ts
var AGENT_KINDS = ["claude", "codex", "cursor"];
var AGENTS = {
  claude: {
    kind: "claude",
    name: "Claude",
    product: "Claude Code",
    app: "the Claude desktop app",
    askTools: ["AskUserQuestion"],
    askWith: "AskUserQuestion",
    promptContext: true
  },
  codex: {
    kind: "codex",
    name: "Codex",
    product: "Codex",
    app: "the Codex app",
    askTools: ["request_user_input", "request_user_input_async"],
    // Codex only offers request_user_input in Plan mode.
    askWith: "request_user_input (in Plan mode) or plainly",
    promptContext: true
  },
  cursor: {
    kind: "cursor",
    name: "Cursor",
    product: "Cursor",
    app: "Cursor",
    // Cursor's hooks do not see AskQuestion today; a question is noticed
    // when the turn ends on one. Listed for when they do.
    askTools: ["AskQuestion"],
    askWith: "AskQuestion or plainly",
    promptContext: false
  }
};
var DEFAULT_AGENT = "claude";
function isAgentKind(value) {
  return typeof value === "string" && AGENT_KINDS.includes(value);
}
function parseAgent(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isAgentKind(v) ? v : DEFAULT_AGENT;
}
function agentInfo(kind) {
  return AGENTS[kind && isAgentKind(kind) ? kind : DEFAULT_AGENT];
}
var SESSION_ENV = {
  claude: ["CLAUDE_CODE_SESSION_ID"],
  codex: ["CODEX_THREAD_ID"],
  cursor: ["CURSOR_CONVERSATION_ID"]
};
function sessionFromEnv(env, agent) {
  for (const key of SESSION_ENV[agent]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}
function workspaceFromEnv(env) {
  const value = env["COPLAN_WORKSPACE"]?.trim();
  return value && !value.includes("${") ? value : null;
}

// src/daemon/render.ts
var STATUS_MARK = { todo: "[ ]", in_progress: "[~]", blocked: "[!]", done: "[x]" };
var STATUS_LEGEND = `_Statuses: ${Object.entries(STATUS_MARK).map(([k, v]) => `${v} ${k}`).join(", ")}_`;
var BUILD_MARKER = "[cc-harness] Build the plan";

// src/daemon/agentHooks.ts
var CURSOR_EVENTS = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUse",
  afterAgentResponse: "AfterAgentResponse",
  stop: "Stop"
};
var CLAUDE_EVENTS_IN_CURSOR = /* @__PURE__ */ new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
function readAgentHook(agent, event, raw) {
  if (agent === "cursor") {
    const known = CURSOR_EVENTS[event] ?? (CLAUDE_EVENTS_IN_CURSOR.has(event) ? event : null);
    return { event: known, input: fromCursor(raw) };
  }
  if (agent === "codex" && event === "PermissionRequest") {
    const tool = typeof raw["tool_name"] === "string" ? raw["tool_name"] : "";
    return {
      event: "Notification",
      input: {
        ...raw,
        notification_type: "permission_prompt",
        message: tool ? `Codex needs your permission to use ${tool}` : "Codex needs your permission"
      }
    };
  }
  return { event, input: raw };
}
function fromCursor(raw) {
  const str = (key) => typeof raw[key] === "string" ? raw[key] : void 0;
  const roots = Array.isArray(raw["workspace_roots"]) ? raw["workspace_roots"].filter((r) => typeof r === "string") : [];
  const sessionId = str("conversation_id") ?? str("session_id");
  const cwd = roots[0] ?? str("cwd");
  return {
    ...raw,
    ...sessionId ? { session_id: sessionId } : {},
    ...cwd ? { cwd } : {},
    // `afterAgentResponse` carries the reply that `Stop` does not.
    ...str("text") !== void 0 && raw["last_assistant_message"] === void 0 ? { last_assistant_message: str("text") } : {}
  };
}
function writeAgentOutput(agent, event, output) {
  if (agent === "claude") return output;
  if (agent === "codex") {
    const context2 = output.hookSpecificOutput?.additionalContext;
    return context2 && CODEX_CONTEXT_EVENTS.has(event) ? { hookSpecificOutput: { hookEventName: event, additionalContext: context2 } } : {};
  }
  const context = output.hookSpecificOutput?.additionalContext;
  switch (event) {
    case "beforeSubmitPrompt":
    case "UserPromptSubmit":
      return context ? { continue: true, additional_context: context } : { continue: true };
    case "sessionStart":
    case "SessionStart":
      return context ? { additional_context: context } : {};
    default:
      return {};
  }
}
var CODEX_CONTEXT_EVENTS = /* @__PURE__ */ new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);

// src/test/agents.test.ts
var DAEMON = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "daemon", "main.js");
var MCP = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "main.js");
var home;
var repo;
var daemon;
var lock;
before(async () => {
  home = mkdtempSync(path2.join(tmpdir(), "coplan-agents-home-"));
  repo = mkdtempSync(path2.join(tmpdir(), "coplan-agents-repo-"));
  process.env["CC_HARNESS_HOME"] = home;
  writeFileSync(path2.join(home, "config.json"), JSON.stringify({ idleShutdownMinutes: 0 }));
  daemon = spawn(process.execPath, [DAEMON], { env: { ...process.env, CC_HARNESS_HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    const live = readLiveLock();
    if (live) {
      lock = live;
      return;
    }
  }
  throw new Error("daemon did not start");
});
after(async () => {
  if (daemon && daemon.exitCode === null) {
    await new Promise((resolve) => {
      daemon.once("exit", () => resolve());
      daemon.kill("SIGTERM");
      setTimeout(() => {
        daemon.kill("SIGKILL");
        resolve();
      }, 3e3).unref();
    });
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function call(route, init = {}) {
  const res = await fetch(`${baseUrl(lock)}${route}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${lock.token}`, ...init.headers ?? {} }
  });
  return await res.json();
}
var hook = (agent, event, body) => call(`/hook/${event}`, { method: "POST", headers: { "x-harness-agent": agent }, body: JSON.stringify(body) });
var mcp = (agent, tool, body, sessionId = "") => call(`/mcp/${tool}`, {
  method: "POST",
  headers: { "x-harness-agent": agent, "x-harness-session": sessionId },
  body: JSON.stringify({ cwd: repo, ...body })
});
var session = (id) => call(`/api/session/${id}`).then((r) => r.session);
var PLAN = {
  title: "Add a cache",
  summary: "A read-through cache.",
  diagrams: [{ title: "Components", nodes: [{ id: "api", label: "API" }, { id: "db", label: "Postgres" }], edges: [{ source: "api", target: "db" }] }],
  tasks: [{ title: "Client" }, { title: "Wire up" }]
};
async function submit(id) {
  const preview = await call(`/api/session/${id}/plan/prompt`, {
    method: "POST",
    body: JSON.stringify({ target: "session" })
  });
  const res = await call(`/api/session/${id}/plan/submit`, {
    method: "POST",
    body: JSON.stringify({ target: "session", expect: preview.version })
  });
  assert.equal(res.error, void 0);
}
var THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53";
test("a Codex session registers as Codex, with a link that opens the thread in the Codex app", async () => {
  const out = await hook("codex", "SessionStart", { session_id: THREAD, cwd: repo, hook_event_name: "SessionStart", source: "startup" });
  assert.deepEqual(out, {}, "Codex refuses fields an event does not take, so a no-op is empty");
  const s = await session(THREAD);
  assert.equal(s.agent, "codex");
  assert.equal(s.link?.app, `codex://threads/${THREAD}`);
  assert.equal(s.link?.web, null);
});
test("Codex's MCP server finds its session by thread id, and is told to ask with request_user_input", async () => {
  const res = await mcp("codex", "publish", PLAN, THREAD);
  assert.equal(res.ok, true, res.text);
  assert.match(res.text, /request_user_input/);
  assert.doesNotMatch(res.text, /AskUserQuestion/);
});
test("a Codex request_user_input is shown as a question, and cleared when answered", async () => {
  await hook("codex", "PreToolUse", {
    session_id: THREAD,
    cwd: repo,
    tool_name: "request_user_input",
    tool_input: { questions: [{ id: "db", header: "Store", question: "Which cache?", options: [{ label: "Redis", description: "fast" }, { label: "Memcached" }] }] }
  });
  let s = await session(THREAD);
  assert.equal(s.waiting?.kind, "question");
  assert.deepEqual(s.waiting?.questions?.[0]?.options, ["Redis", "Memcached"]);
  await hook("codex", "PostToolUse", { session_id: THREAD, cwd: repo, tool_name: "request_user_input" });
  s = await session(THREAD);
  assert.equal(s.waiting, null);
});
test("a submitted plan rides along with the next Codex prompt, as it does in Claude Code", async () => {
  await submit(THREAD);
  const out = await hook("codex", "UserPromptSubmit", { session_id: THREAD, cwd: repo, prompt: "go" });
  const context = out["hookSpecificOutput"]?.additionalContext ?? "";
  assert.ok(context.startsWith(BUILD_MARKER), "the build prompt is added to the prompt");
  assert.match(context, /request_user_input/, "and says how this agent asks");
});
var CHAT = "cursor-chat-1";
var cursorBase = { conversation_id: CHAT, generation_id: "g1", workspace_roots: [], cursor_version: "2.0.0" };
test("a Cursor chat registers from its own payload: conversation id and workspace root", async () => {
  const base = { ...cursorBase, workspace_roots: [repo] };
  const out = await hook("cursor", "sessionStart", { ...base, hook_event_name: "sessionStart", session_id: CHAT });
  assert.equal("suppressOutput" in out, false, "Cursor is answered in its own format");
  const s = await session(CHAT);
  assert.equal(s.agent, "cursor");
  assert.equal(s.cwd, repo);
  assert.equal(s.link, null, "Cursor has no link to a chat");
});
test("Cursor's MCP server, shared by the window, finds the chat by workspace", async () => {
  const res = await mcp("cursor", "publish", PLAN);
  assert.equal(res.ok, true, res.text);
  assert.equal((await session(CHAT)).plan?.title, "Add a cache");
  assert.doesNotMatch(res.text, /AskUserQuestion/);
});
test("a Cursor turn that ends on a question is waiting on the user", async () => {
  const base = { ...cursorBase, workspace_roots: [repo] };
  await hook("cursor", "afterAgentResponse", { ...base, hook_event_name: "afterAgentResponse", text: "Done with the outline.\n\nShould the cache be per tenant?" });
  const out = await hook("cursor", "stop", { ...base, hook_event_name: "stop", status: "completed", loop_count: 0 });
  assert.equal(out["followup_message"], void 0, "stop never sends Cursor on");
  const s = await session(CHAT);
  assert.equal(s.waiting?.kind, "input");
  assert.match(s.waiting?.text ?? "", /per tenant\?/);
});
test("in Cursor the build prompt is pasted, or picked up by the next read", async () => {
  const base = { ...cursorBase, workspace_roots: [repo] };
  await submit(CHAT);
  const typed = await hook("cursor", "beforeSubmitPrompt", { ...base, hook_event_name: "beforeSubmitPrompt", prompt: "go" });
  assert.deepEqual(typed, { continue: true });
  assert.ok(!(await session(CHAT)).plan?.submission?.deliveredAt, "still waiting for the prompt to reach Cursor");
  const read = await mcp("cursor", "read", {});
  assert.ok(read.text.startsWith(BUILD_MARKER));
  assert.ok((await session(CHAT)).plan?.submission?.deliveredAt, "and that counts as delivered");
  const again = await mcp("cursor", "read", {});
  assert.ok(!again.text.startsWith(BUILD_MARKER), "only once");
});
test("pasting the build prompt into Cursor counts as delivering it", async () => {
  const id = "cursor-chat-2";
  const base = { ...cursorBase, conversation_id: id, workspace_roots: [repo] };
  await hook("cursor", "sessionStart", { ...base, hook_event_name: "sessionStart" });
  await mcp("cursor", "publish", PLAN);
  await submit(id);
  await hook("cursor", "beforeSubmitPrompt", { ...base, hook_event_name: "beforeSubmitPrompt", prompt: `${BUILD_MARKER} "Add a cache" \u2026` });
  assert.ok((await session(id)).plan?.submission?.deliveredAt);
});
test("an unknown Cursor event is answered with nothing, never an error", async () => {
  const out = await hook("cursor", "beforeReadFile", { ...cursorBase, workspace_roots: [repo], hook_event_name: "beforeReadFile", file_path: "x" });
  assert.deepEqual(out, {});
});
function serverCall(env, call2, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], {
      cwd: opts.cwd ?? tmpdir(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", CC_HARNESS_HOME: home, ...env },
      stdio: ["pipe", "pipe", "ignore"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("no answer from the MCP server"));
    }, 1e4);
    const write = (m) => child.stdin.write(`${JSON.stringify(m)}
`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.method === "roots/list") {
        write({ jsonrpc: "2.0", id: msg.id, result: { roots: (opts.roots ?? []).map((r) => ({ uri: pathToFileURL(r).href, name: "w" })) } });
        return;
      }
      if (msg.id === 1) {
        write({ jsonrpc: "2.0", method: "notifications/initialized" });
        write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: call2 });
      }
      if (msg.id === 2) {
        clearTimeout(timer);
        child.stdin.end();
        resolve({ text: msg.result?.content?.[0]?.text ?? "", isError: Boolean(msg.result?.isError) });
      }
    });
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: opts.roots ? { roots: { listChanged: true } } : {}, clientInfo: { name: "t", version: "0" } }
    });
  });
}
test("the Codex MCP server takes its thread from each call, not from its folder or environment", async () => {
  const other = "0199a213-81c0-7800-8aa1-000000000002";
  await hook("codex", "SessionStart", { session_id: other, cwd: repo, hook_event_name: "SessionStart", source: "startup" });
  const res = await serverCall(
    { COPLAN_AGENT: "codex" },
    { name: "harness_task_update", arguments: { task_id: "t1", status: "in_progress" }, _meta: { threadId: other } },
    { cwd: path2.dirname(MCP) }
  );
  assert.equal(res.isError, true, "the new thread has no plan yet, so the update is refused\u2026");
  assert.match(res.text, /No task "t1"/);
  const read = await serverCall({ COPLAN_AGENT: "codex" }, { name: "harness_plan_read", arguments: {}, _meta: { threadId: THREAD } });
  assert.match(read.text, /Add a cache/, "\u2026while the thread that published reads its own plan");
});
test("the Cursor MCP server learns the open folder from MCP roots when its config could not say", async () => {
  const res = await serverCall(
    { COPLAN_AGENT: "cursor", COPLAN_WORKSPACE: "${workspaceFolder}" },
    { name: "harness_plan_read", arguments: { changes_only: true } },
    { roots: [repo] }
  );
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /Add a cache/);
});
test("each agent is told to ask with its own question tool", async () => {
  const list = (agent) => new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP], { env: { ...process.env, CC_HARNESS_HOME: home, COPLAN_AGENT: agent }, stdio: ["pipe", "pipe", "ignore"] });
    createInterface({ input: child.stdout }).on("line", (line) => {
      child.stdin.end();
      resolve(line);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}
`);
  });
  assert.match(await list("claude"), /AskUserQuestion/);
  assert.match(await list("codex"), /request_user_input/);
  assert.doesNotMatch(await list("codex"), /AskUserQuestion/);
  assert.match(await list("cursor"), /AskQuestion/);
});
test("agents are named by the relay and the MCP config; anything else is Claude Code", () => {
  assert.equal(parseAgent("codex"), "codex");
  assert.equal(parseAgent(" Cursor "), "cursor");
  assert.equal(parseAgent(void 0), "claude");
  assert.equal(parseAgent("vim"), "claude");
  assert.equal(agentInfo("codex").name, "Codex");
});
test("each agent's session id is read from its own variable", () => {
  const env = { CLAUDE_CODE_SESSION_ID: "claude-1", CODEX_THREAD_ID: "codex-1" };
  assert.equal(sessionFromEnv(env, "claude"), "claude-1");
  assert.equal(sessionFromEnv(env, "codex"), "codex-1");
  assert.equal(sessionFromEnv(env, "cursor"), null);
  assert.equal(sessionFromEnv({ CURSOR_CONVERSATION_ID: "chat-1" }, "cursor"), "chat-1");
  assert.equal(workspaceFromEnv({ COPLAN_WORKSPACE: "/repo" }), "/repo");
  assert.equal(workspaceFromEnv({ COPLAN_WORKSPACE: "${workspaceFolder}" }), null, "an unexpanded variable names no folder");
});
test("Cursor's payloads are read as Claude Code's, and answered in Cursor's format", () => {
  const { event, input } = readAgentHook("cursor", "beforeSubmitPrompt", { conversation_id: "c", workspace_roots: ["/w"], prompt: "hi" });
  assert.equal(event, "UserPromptSubmit");
  assert.equal(input.session_id, "c");
  assert.equal(input.cwd, "/w");
  assert.deepEqual(writeAgentOutput("cursor", "beforeSubmitPrompt", { suppressOutput: true }), { continue: true });
  assert.equal(readAgentHook("cursor", "beforeReadFile", {}).event, null);
  const raw = { session_id: "s", cwd: "/w" };
  assert.deepEqual(readAgentHook("codex", "Stop", raw), { event: "Stop", input: raw });
  assert.deepEqual(writeAgentOutput("claude", "Stop", { suppressOutput: true }), { suppressOutput: true });
});
var ROOT = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "..");
var readJson = (file) => JSON.parse(readFileSync2(path2.join(ROOT, file), "utf8"));
test("every agent manifest carries the package version and points at files that exist", () => {
  const version = readJson("package.json")["version"];
  for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    const m = readJson(manifest);
    assert.equal(m["name"], "coplan", manifest);
    assert.equal(m["version"], version, `${manifest} is at the package version`);
    for (const key of ["hooks", "mcpServers", "skills", "commands"]) {
      const target = m[key];
      if (typeof target === "string") assert.ok(existsSync2(path2.join(ROOT, target)), `${manifest} ${key}: ${target}`);
    }
  }
  assert.deepEqual(readJson(".codex-plugin/plugin.json")["commands"], [], "Codex does not turn Claude Code's slash commands into skills");
});
test("each agent's MCP config and hooks name that agent", () => {
  for (const agent of ["codex", "cursor"]) {
    const servers = readJson(`mcp/${agent}.json`)["mcpServers"];
    assert.equal(servers["harness"]?.env?.["COPLAN_AGENT"], agent);
    const hooks = readJson(`hooks/${agent}.json`)["hooks"];
    for (const [event, entries] of Object.entries(hooks)) {
      assert.match(JSON.stringify(entries), new RegExp(`coplan-hook-relay\\.sh\\\\?" ${event} ${agent}"`), `${agent} ${event}`);
    }
  }
  assert.equal(readJson("hooks/cursor.json")["version"], 1, "Cursor refuses a hooks file without a version");
  const codexServer = readJson("mcp/codex.json")["mcpServers"]["harness"];
  assert.equal(codexServer.cwd, ".", "Codex resolves a plugin server only through a relative cwd");
  assert.ok(!codexServer.args.some((a) => a.includes("${")), "Codex expands nothing in a plugin server");
});
//# sourceMappingURL=agents.test.js.map
