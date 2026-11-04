// src/test/integration.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
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

// src/test/integration.test.ts
var DAEMON = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "daemon", "main.js");
var home;
var repo;
var daemon;
var lock;
var sessionId = "integration-session";
function git(args) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}
before(async () => {
  home = mkdtempSync(path2.join(tmpdir(), "cc-harness-int-home-"));
  repo = mkdtempSync(path2.join(tmpdir(), "cc-harness-int-repo-"));
  process.env["CC_HARNESS_HOME"] = home;
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path2.join(repo, "app.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);
  git(["checkout", "-qb", "feature/change"]);
  writeFileSync(path2.join(home, "config.json"), JSON.stringify({ idleShutdownMinutes: 0 }));
  daemon = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, CC_HARNESS_HOME: home },
    stdio: "ignore"
  });
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
      const done = () => resolve();
      daemon.once("exit", done);
      daemon.kill("SIGTERM");
      setTimeout(() => {
        daemon.kill("SIGKILL");
        done();
      }, 3e3).unref();
    });
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function call(route, init) {
  const res = await fetch(`${baseUrl(lock)}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${lock.token}`,
      "x-harness-session": sessionId,
      ...init?.headers ?? {}
    }
  });
  const type = res.headers.get("content-type") ?? "";
  return type.includes("json") ? await res.json() : { status: res.status, text: await res.text() };
}
var hookFor = (id, event, body = {}, headers = {}) => call(`/hook/${event}`, {
  method: "POST",
  headers,
  body: JSON.stringify({ session_id: id, cwd: repo, ...body })
});
var mcpFor = (id, tool, body = {}) => call(`/mcp/${tool}`, {
  method: "POST",
  headers: { "x-harness-session": id },
  body: JSON.stringify({ cwd: repo, ...body })
});
var hook = (event, body = {}, headers = {}) => hookFor(sessionId, event, body, headers);
var mcp = (tool, body = {}) => mcpFor(sessionId, tool, body);
var sessionFor = (id) => call(`/api/session/${id}`).then((r) => r.session);
var session = () => sessionFor(sessionId);
var ops = (list) => call(`/api/session/${sessionId}/plan/ops`, {
  method: "POST",
  body: JSON.stringify({ ops: list })
});
var PLAN = {
  title: "Add a cache",
  summary: "A read-through cache in front of Postgres.",
  sections: [{ title: "Context", body: "Reads are slow." }],
  diagrams: [
    {
      title: "Components",
      nodes: [
        { id: "api", label: "API", kind: "service" },
        { id: "db", label: "Postgres", kind: "datastore" }
      ],
      edges: [{ source: "api", target: "db" }]
    }
  ],
  tasks: [{ title: "Storage", subtasks: [{ title: "Client" }, { title: "Invalidation" }] }, { title: "Wire up" }]
};
test("SessionStart records the repo and branch", async () => {
  await hook("SessionStart", { start_reason: "startup" });
  const s = await session();
  assert.ok(s.repoRoot && s.repoRoot.endsWith(path2.basename(repo)));
  assert.equal(s.branch, "feature/change");
  assert.equal(s.plan, null);
});
test("publishing returns the plan as Claude will read it, with its ids", async () => {
  const res = await mcp("publish", PLAN);
  assert.equal(res["ok"], true);
  const text = String(res["text"]);
  assert.match(text, /Published "Add a cache"/);
  assert.match(text, /Tell them in chat/);
  assert.match(text, /t2 Client/);
  assert.match(text, /- API → Postgres `api → db`/);
  assert.doesNotMatch(text, /token=/, "the auth token never reaches the transcript");
  const s = await session();
  assert.equal(s.plan?.tasks.length, 4);
});
test("no hook ever holds a turn", async () => {
  for (const event of ["Stop", "UserPromptSubmit", "SessionEnd", "SessionStart"]) {
    const started = Date.now();
    const out = await hook(event, { stop_hook_active: false, prompt: "hi" });
    assert.notEqual(out.decision, "block", event);
    assert.ok(Date.now() - started < 2e3, `${event} answered at once`);
  }
});
test("what the user does in the browser is what Claude reads back", async () => {
  const res = await ops([
    { op: "move_task", id: "t4", parentId: "t1", index: 0 },
    { op: "upsert_task", parentId: "t1", title: "Load test" },
    { op: "comment", target: { kind: "diagram", id: "d1" }, text: "where does the cache go?" },
    {
      op: "upsert_diagram",
      id: "d1",
      nodes: [
        { id: "api", label: "API", kind: "service", x: 0, y: 0 },
        { id: "cache", label: "Redis", kind: "datastore", x: 200, y: 0, notes: "Already deployed.", taskIds: ["t2"] },
        { id: "db", label: "Postgres", kind: "datastore", x: 400, y: 0 }
      ],
      edges: [
        { source: "api", target: "cache" },
        { source: "cache", target: "db" }
      ]
    }
  ]);
  assert.ok(res.plan, res.error);
  const read = String((await mcp("read", {}))["text"]);
  assert.match(read, /Since you last read — what the user changed/);
  assert.match(read, /Changed t4 "Wire up": moved under "Storage"/);
  assert.match(read, /Added t5 "Load test" under "Storage"/);
  assert.match(read, /Commented on diagram "Components": where does the cache go\?/);
  assert.match(read, /\*\*Diagram \[d1\] "Components"\*\*\n- Added Redis \(`cache`\) — data store\./);
  assert.match(read, /- Connected API → Redis\.\n- Connected Redis → Postgres\.\n- Disconnected API → Postgres\./);
  assert.doesNotMatch(read, /x: |"x"|200/, "no coordinates reach Claude");
  assert.match(read, /\*\*Parts\*\*\n- \*\*API\*\* `api` — service\n- \*\*Redis\*\* `cache` — data store\n  Decisions:\n    Already deployed\.\n  Built by: \[ \] t2 Client\n- \*\*Postgres\*\* `db` — data store/);
});
test("moving boxes around is saved but is not news to Claude", async () => {
  const before2 = await session();
  const d = before2.plan.diagrams[0];
  const res = await ops([{ op: "upsert_diagram", id: d.id, nodes: d.nodes.map((n, i) => ({ ...n, x: i * 300, y: 90 })), edges: d.edges, direction: "TB" }]);
  assert.ok(res.plan, res.error);
  assert.equal(res.plan.diagrams[0].nodes[1].x, 300, "the layout is saved");
  const read = String((await mcp("read", { changes_only: true }))["text"]);
  assert.match(read, /has not changed the plan/);
  const notice = await hook("UserPromptSubmit", { prompt: "continue" });
  assert.equal(notice.hookSpecificOutput?.additionalContext, void 0);
});
test("what Claude last read stays in the daemon", async () => {
  const s = await session();
  assert.ok(s.plan);
  assert.equal("claudeBaseline" in s.plan, false, "not sent to the page");
});
test("reading once catches Claude up", async () => {
  const again = String((await mcp("read", { changes_only: true }))["text"]);
  assert.match(again, /has not changed the plan/);
  const notice = await hook("UserPromptSubmit", { prompt: "continue" });
  assert.equal(notice.hookSpecificOutput?.additionalContext, void 0, "no notice once Claude is up to date");
});
test("the next chat message after an edit tells Claude to read the plan", async () => {
  await ops([{ op: "upsert_task", title: "Shard later" }]);
  const out = await hook("UserPromptSubmit", { prompt: "ok, go on" });
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", /changed the plan .* harness_plan_read/);
});
test("a republish over unread user edits is refused", async () => {
  const res = await mcp("publish", PLAN);
  assert.equal(res["ok"], false);
  assert.match(String(res["text"]), /harness_plan_read first/);
  const s = await session();
  assert.ok(s.plan.tasks.some((t) => t.title === "Shard later"), "nothing the user did was lost");
});
test("Claude replies to the user's comment in its thread", async () => {
  await mcp("read", {});
  const s = await session();
  const thread = s.plan.threads[0];
  const res = await mcp("edit", { ops: [{ op: "reply", threadId: thread.id, text: "Between the API and Postgres." }] });
  assert.equal(res["ok"], true, String(res["text"]));
  const after2 = await session();
  assert.equal(after2.plan.threads[0].replies[0].author, "claude");
  assert.equal(after2.plan.claudeReadSeq, after2.plan.seq, "its own edits are not news to it");
});
test("a question Claude asks is shown as waiting, and cleared when answered in Claude", async () => {
  await hook("PreToolUse", {
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which TTL?", header: "TTL", options: [{ label: "1m" }, { label: "10m" }] }] }
  });
  const asking = await session();
  assert.equal(asking.waiting?.kind, "question");
  assert.deepEqual(asking.waiting?.questions?.[0], { question: "Which TTL?", header: "TTL", options: ["1m", "10m"] });
  const { sessions } = await call("/api/sessions");
  assert.ok(sessions.find((x) => x.sessionId === sessionId)?.waiting, "the rail hears about it");
  await hook("PostToolUse", { tool_name: "AskUserQuestion" });
  assert.equal((await session()).waiting, null);
});
test("an idle reminder does not replace the question it reminds about", async () => {
  await hook("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Shard?", options: [] }] } });
  await hook("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  assert.equal((await session()).waiting?.text, "Shard?");
  await hook("UserPromptSubmit", { prompt: "no" });
  assert.equal((await session()).waiting, null, "replying in Claude clears it");
});
test("a permission prompt is waiting too", async () => {
  await hook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  const s = await session();
  assert.equal(s.waiting?.kind, "permission");
  assert.match(s.waiting?.text ?? "", /permission to use Bash/);
  await hook("PostToolUse", { tool_name: "Bash" });
});
test("a turn that ends on a question is waiting on a reply", async () => {
  await hook("Stop", { last_assistant_message: "Done with the plan.\n\nShould the warmer read from a replica?" });
  const s = await session();
  assert.equal(s.status, "idle");
  assert.equal(s.waiting?.text, "Should the warmer read from a replica?");
  await hook("Stop", { last_assistant_message: "All done." });
  assert.equal((await session()).waiting, null);
});
test("the session environment decides the link back to Claude", async () => {
  await hook("UserPromptSubmit", { prompt: "x" });
  assert.equal((await session()).link, null, "a plain local session has no documented link");
  await hook("Stop", {}, { "x-harness-bridge-session": "session_01Bridge", "x-harness-entrypoint": "cli" });
  const s = await session();
  assert.equal(s.surface, "cli");
  assert.equal(s.link?.app, "claude://claude.ai/code/session_01Bridge");
  await hook("Stop", {}, { "x-harness-remote-sdk": "https://api.anthropic.com/v1/code/sessions/cse_01Cloud" });
  assert.equal((await session()).link?.web, "https://claude.ai/code/session_01Cloud");
});
test("task tracking moves statuses and reports them", async () => {
  await ops([{ op: "upsert_task", title: "Profile it" }]);
  const res = await mcp("task", { task_id: "t2", status: "done", note: "client added" });
  assert.match(String(res["text"]), /"Client" is done/);
  assert.match(String(res["text"]), /The user has changed tasks since you last read the plan/);
  assert.doesNotMatch(String(res["text"]), /time\(s\)/);
  const bad = await mcp("task", { task_id: "nope", status: "done" });
  assert.equal(bad["ok"], false);
  assert.match(String(bad["text"]), /No task "nope"/);
});
test("a refused browser edit says why and changes nothing", async () => {
  const before2 = await session();
  const res = await ops([{ op: "move_task", id: "t1", parentId: "t2", index: 0 }]);
  assert.match(res.error ?? "", /inside itself/);
  const after2 = await session();
  assert.equal(after2.plan.seq, before2.plan.seq);
});
test("the plan text endpoint shows exactly what Claude reads, without counting as a read", async () => {
  await ops([{ op: "comment", target: { kind: "plan", id: "" }, text: "peek" }]);
  const res = await call(`/api/session/${sessionId}/plan/text`);
  assert.match(res.text, /# Add a cache/);
  const s = await session();
  assert.ok(s.plan.claudeReadSeq < s.plan.seq, "Claude still has the comment to read");
});
test("a renamed session keeps its name", async () => {
  await call(`/api/session/${sessionId}/title`, { method: "POST", body: JSON.stringify({ title: "Cache work" }) });
  await hook("SessionStart", { start_reason: "resume" });
  assert.equal((await session()).title, "Cache work");
  const empty = await call(`/api/session/${sessionId}/title`, { method: "POST", body: JSON.stringify({ title: "  " }) });
  assert.ok(empty.error);
});
test("the session list summarizes the plan", async () => {
  const { sessions } = await call("/api/sessions");
  const row = sessions.find((s) => s.sessionId === sessionId);
  assert.equal(row.planTitle, "Add a cache");
  assert.equal(row.tasks.done, 1);
});
var raw = (route, init = {}) => fetch(`${baseUrl(lock)}${route}`, {
  ...init,
  headers: { authorization: `Bearer ${lock.token}`, "content-type": "application/json", ...init.headers ?? {} }
});
test("the UI is served with a strict content policy and no referrer", async () => {
  const res = await fetch(`${baseUrl(lock)}/?token=${lock.token}`);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, "no inline script, ever");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer", "the token in the first URL never leaks");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});
test("malformed input is a 400, not a 500", async () => {
  const bad = await raw(`/api/session/${sessionId}/plan/ops`, { method: "POST", body: "{not json" });
  assert.equal(bad.status, 400);
  const notObject = await raw(`/api/session/${sessionId}/plan/ops`, { method: "POST", body: "[1,2]" });
  assert.equal(notObject.status, 400);
  const badPath = await raw("/api/session/%E0%A4%A");
  assert.equal(badPath.status, 400);
});
test("an oversized body is refused", async () => {
  const res = await raw(`/api/session/${sessionId}/plan/ops`, { method: "POST", body: JSON.stringify({ ops: [], pad: "x".repeat(3 * 1024 * 1024) }) }).catch(() => null);
  assert.ok(!res || res.status === 413, `expected 413, got ${res?.status}`);
});
test("a write from another origin is refused even with valid credentials", async () => {
  const res = await raw(`/api/session/${sessionId}/plan/ops`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
    body: JSON.stringify({ ops: [{ op: "upsert_task", title: "injected" }] })
  });
  assert.equal(res.status, 403);
  const own = await raw(`/api/session/${sessionId}/plan/ops`, {
    method: "POST",
    headers: { origin: baseUrl(lock) },
    body: JSON.stringify({ ops: [{ op: "upsert_task", title: "from the page" }] })
  });
  assert.equal(own.status, 200, "the page itself is allowed");
});
test("without the token, nothing is served", async () => {
  const res = await fetch(`${baseUrl(lock)}/api/sessions`);
  assert.equal(res.status, 401);
});
test("a stale diagram save is refused over HTTP and changes nothing", async () => {
  const before2 = (await session()).plan.diagrams[0];
  await mcp("edit", { ops: [{ op: "upsert_diagram", id: before2.id, caption: "Claude moved first" }] });
  const res = await ops([{ op: "upsert_diagram", id: before2.id, caption: "stale", expect: before2.rev }]);
  assert.match(res.error ?? "", /changed by Claude while this edit was open/);
  assert.equal((await session()).plan.diagrams[0].caption, "Claude moved first");
});
test("a batch too large to apply whole is refused, not truncated", async () => {
  const before2 = (await session()).plan.tasks.length;
  const many = Array.from({ length: 201 }, (_, i) => ({ op: "upsert_task", title: `bulk ${i}` }));
  const res = await raw(`/api/session/${sessionId}/plan/ops`, { method: "POST", body: JSON.stringify({ ops: many }) });
  assert.equal(res.status, 400);
  const viaClaude = await mcp("edit", { ops: many });
  assert.equal(viaClaude["ok"], false);
  assert.equal((await session()).plan.tasks.length, before2, "none of it applied");
});
var built = "submit-session";
var opsOn = (id, list) => call(`/api/session/${id}/plan/ops`, { method: "POST", body: JSON.stringify({ ops: list }) });
var post = (route, body = {}) => call(route, { method: "POST", body: JSON.stringify(body) });
test("the prompt preview is the prompt, and reading it changes nothing", async () => {
  await hookFor(built, "SessionStart", { start_reason: "startup" });
  await mcpFor(built, "publish", PLAN);
  await opsOn(built, [{ op: "upsert_task", title: "Load test" }]);
  const before2 = await sessionFor(built);
  const preview = await post(`/api/session/${built}/plan/prompt`, { target: "session", note: "Start with the client." });
  assert.match(preview.prompt, /^\[cc-harness\] Build the plan "Add a cache"/);
  assert.match(preview.prompt, /> Start with the client\./);
  assert.match(preview.prompt, /Added t\d+ "Load test"/, "the edit Claude has not read leads");
  assert.equal(preview.version, before2.plan.version);
  const after2 = await sessionFor(built);
  assert.equal(after2.plan.version, before2.plan.version);
  assert.equal(after2.plan.submission, void 0);
});
test("a submission made against an older preview is refused", async () => {
  const { version } = await post(`/api/session/${built}/plan/prompt`, { target: "session" });
  await mcpFor(built, "task", { task_id: "t2", status: "in_progress" });
  const res = await post(`/api/session/${built}/plan/submit`, { target: "session", expect: version });
  assert.match(res.error ?? "", /changed while you were reviewing it/);
  assert.equal((await sessionFor(built)).plan.submission, void 0);
});
test("submitting locks the plan with exactly the previewed prompt", async () => {
  const preview = await post(`/api/session/${built}/plan/prompt`, { target: "session", note: "Go." });
  const res = await post(`/api/session/${built}/plan/submit`, {
    target: "session",
    note: "Go.",
    expect: preview.version
  });
  assert.ok(res.plan, res.error);
  assert.equal(res.plan.submission?.prompt, preview.prompt);
  assert.equal(res.plan.submission?.deliveredAt, null);
  const { sessions } = await call("/api/sessions");
  assert.equal(sessions.find((s) => s.sessionId === built)?.phase, "submitted");
  const edit = await opsOn(built, [{ op: "upsert_task", title: "sneak in" }]);
  assert.match(edit.error ?? "", /locked/);
  const again = await post(`/api/session/${built}/plan/submit`, { target: "session" });
  assert.match(again.error ?? "", /already been submitted/);
});
test("the user's next message in Claude carries the prompt \u2014 once", async () => {
  const first = await hookFor(built, "UserPromptSubmit", { prompt: "go" });
  const s = await sessionFor(built);
  assert.equal(first.hookSpecificOutput?.additionalContext, s.plan.submission.prompt);
  assert.notEqual(first.decision, "block", "delivering never holds the turn");
  assert.ok(s.plan.submission.deliveredAt);
  assert.equal(s.plan.claudeReadSeq, s.plan.seq, "the prompt is Claude reading the plan");
  const second = await hookFor(built, "UserPromptSubmit", { prompt: "and go on" });
  assert.equal(second.hookSpecificOutput?.additionalContext, void 0);
  const { sessions } = await call("/api/sessions");
  assert.equal(sessions.find((x) => x.sessionId === built)?.phase, "building");
});
test("while building, Claude tracks tasks but cannot redesign", async () => {
  const redesign = await mcpFor(built, "edit", { ops: [{ op: "upsert_diagram", id: "d1", title: "Different" }] });
  assert.equal(redesign["ok"], false);
  assert.match(String(redesign["text"]), /submitted this plan to be built, so it is locked/);
  const republish = await mcpFor(built, "publish", { ...PLAN, title: "Something else" });
  assert.equal(republish["ok"], false);
  const read = String((await mcpFor(built, "read", {}))["text"]);
  assert.match(read, /Locked for building/);
  const discovered = await mcpFor(built, "edit", { ops: [{ op: "upsert_task", parentId: "t1", title: "Handle timeouts" }] });
  assert.equal(discovered["ok"], true, String(discovered["text"]));
});
test("finishing the last task finishes the build, and a new plan may follow", async () => {
  const s = await sessionFor(built);
  const leaves = s.plan.tasks.filter((t) => !s.plan.tasks.some((c) => c.parentId === t.id));
  let last = {};
  for (const t of leaves) last = await mcpFor(built, "task", { task_id: t.id, status: "done", note: "done" });
  assert.match(String(last["text"]), /That was the last task: the plan is built/);
  const { sessions } = await call("/api/sessions");
  assert.equal(sessions.find((x) => x.sessionId === built)?.phase, "built");
  const next = await mcpFor(built, "publish", { ...PLAN, title: "Next feature" });
  assert.equal(next["ok"], true, String(next["text"]));
  assert.equal((await sessionFor(built)).plan.submission, void 0);
});
test("a prompt the user pasted themselves is not delivered a second time", async () => {
  const id = "paste-session";
  await hookFor(id, "SessionStart", { start_reason: "startup" });
  await mcpFor(id, "publish", PLAN);
  const { version, prompt } = await post(`/api/session/${id}/plan/prompt`, { target: "session" });
  await post(`/api/session/${id}/plan/submit`, { target: "session", expect: version });
  const out = await hookFor(id, "UserPromptSubmit", { prompt });
  assert.equal(out.hookSpecificOutput?.additionalContext, void 0);
  assert.ok((await sessionFor(id)).plan.submission.deliveredAt, "but it is counted as delivered");
});
test("a plan handed off elsewhere is locked but never delivered here, and can be reopened", async () => {
  const id = "elsewhere-session";
  await hookFor(id, "SessionStart", { start_reason: "startup" });
  await mcpFor(id, "publish", PLAN);
  const preview = await post(`/api/session/${id}/plan/prompt`, { target: "elsewhere" });
  assert.doesNotMatch(preview.prompt, /harness_/);
  await post(`/api/session/${id}/plan/submit`, { target: "elsewhere", expect: preview.version });
  const out = await hookFor(id, "UserPromptSubmit", { prompt: "hello" });
  assert.equal(out.hookSpecificOutput?.additionalContext, void 0);
  assert.equal((await sessionFor(id)).plan.submission.deliveredAt, null);
  const reopened = await post(`/api/session/${id}/plan/reopen`);
  assert.ok(reopened.plan, reopened.error);
  assert.equal(reopened.plan.submission, void 0);
  const edit = await opsOn(id, [{ op: "upsert_task", title: "after reopening" }]);
  assert.ok(edit.plan, edit.error);
  const twice = await post(`/api/session/${id}/plan/reopen`);
  assert.match(twice.error ?? "", /not locked/);
});
test("a submission needs to say who builds it", async () => {
  const res = await raw(`/api/session/${built}/plan/submit`, { method: "POST", body: JSON.stringify({ target: "mars" }) });
  assert.equal(res.status, 400);
});
//# sourceMappingURL=integration.test.js.map
