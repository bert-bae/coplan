// src/test/integration.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { tmpdir } from "node:os";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// src/shared/paths.ts
import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
function harnessHome() {
  return process.env.CC_HARNESS_HOME || path.join(homedir(), ".claude", "cc-harness");
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
var transcript;
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
  transcript = path2.join(home, "transcript.jsonl");
  writeFileSync(transcript, "");
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
  return await res.json();
}
var hookFor = (id, event, body = {}) => call(`/hook/${event}`, {
  method: "POST",
  body: JSON.stringify({ session_id: id, cwd: repo, transcript_path: transcript, ...body })
});
var mcpFor = (id, tool, body = {}) => call(`/mcp/${tool}`, {
  method: "POST",
  headers: { "x-harness-session": id },
  body: JSON.stringify({ cwd: repo, ...body })
});
var hook = (event, body = {}) => hookFor(sessionId, event, body);
var mcp = (tool, body = {}) => mcpFor(sessionId, tool, body);
var session = () => call(`/api/session/${sessionId}`).then((r) => r.session);
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(fn, ms = 5e3) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(75);
  }
  throw new Error("condition never became true");
}
test("SessionStart records the repo, branch and start commit", async () => {
  await hook("SessionStart", { start_reason: "startup" });
  const s = await session();
  assert.equal(s.repoRoot, repo);
  assert.equal(s.branch, "feature/change");
  assert.match(s.startCommit ?? "", /^[0-9a-f]{40}$/);
});
test("the transcript tailer turns session output into timeline entries", async () => {
  appendFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "considering the approach" },
          { type: "text", text: "I will add a subtract function." },
          { type: "tool_use", name: "Edit", input: { file_path: `${repo}/app.ts` } }
        ]
      }
    }) + "\n"
  );
  const found = await until(async () => {
    const s2 = await session();
    return s2.timeline.find((e) => e.text.includes("add a subtract function"));
  });
  assert.equal(found.kind, "assistant");
  const s = await session();
  assert.ok(s.timeline.some((e) => e.kind === "thinking"), "reasoning is captured separately");
  assert.ok(s.timeline.some((e) => e.kind === "tool" && e.label === "Edit"), "tool calls are captured");
});
test("tool-result user entries are not mistaken for user prompts", async () => {
  appendFileSync(
    transcript,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "ok" }] }
    }) + "\n"
  );
  await sleep(300);
  const s = await session();
  assert.equal(s.timeline.filter((e) => e.kind === "user").length, 0);
});
test("the plan gate parks the Stop hook and returns the edited plan", async () => {
  const plan = await mcp("plan", {
    title: "Add a subtract function",
    summary: "Mirror add().",
    steps: [{ title: "Write subtract" }, { title: "Add a test" }, { title: "Update the docs" }]
  });
  const gateId = String(plan["gateId"]);
  assert.ok(gateId);
  assert.match(String(plan["text"]), /End your turn now/);
  assert.doesNotMatch(String(plan["text"]), /Call harness_await/);
  const parked = hook("Stop", { stop_hook_active: false });
  await until(async () => (await session()).status === "waiting");
  await call(`/api/session/${sessionId}/gate/${gateId}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      verdict: "approved",
      comment: "Drop the docs step.",
      steps: [
        { id: "s1", title: "Write subtract" },
        { id: "s2", title: "Add a test" },
        { id: "s3", title: "Update the docs", status: "dropped" }
      ]
    })
  });
  const out = await parked;
  assert.equal(out.decision, "block", "the turn is resumed rather than ended");
  assert.match(out.reason ?? "", /approved at the plan gate/);
  assert.match(out.reason ?? "", /Drop the docs step/);
  assert.match(out.reason ?? "", /Approved plan \(2 steps\)/);
  const s = await session();
  assert.equal(s.plan?.steps.length, 3);
  assert.equal(s.plan?.steps[2]?.status, "dropped");
});
test("a verdict given before the turn ends is still delivered", async () => {
  const other = "integration-race";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  const plan = await mcpFor(other, "plan", { title: "Race", steps: [{ title: "only step" }] });
  const gateId = String(plan["gateId"]);
  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ verdict: "approved", comment: "Answered early." })
  });
  const out = await hookFor(other, "Stop", { stop_hook_active: false });
  assert.equal(out.decision, "block");
  assert.match(out.reason ?? "", /Answered early/);
  const again = await hookFor(other, "Stop", { stop_hook_active: true });
  assert.notEqual(again.decision, "block");
});
test("a verdict already delivered by harness_await is not replayed at Stop", async () => {
  const other = "integration-no-replay";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  const plan = await mcpFor(other, "plan", { title: "No replay", steps: [{ title: "only step" }] });
  const gateId = String(plan["gateId"]);
  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ verdict: "approved", comment: "Seen by await." })
  });
  const awaited = await mcpFor(other, "await", { gate_id: gateId, timeout_seconds: 5 });
  assert.equal(awaited["status"], "resolved");
  assert.match(String(awaited["text"]), /Seen by await/);
  const out = await hookFor(other, "Stop", { stop_hook_active: false });
  assert.notEqual(out.decision, "block", "the same verdict is not delivered twice");
});
test("a question opens a gate the UI can answer", async () => {
  const other = "integration-question";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  const asked = await mcpFor(other, "ask", {
    question: "Map or plain object?",
    options: ["Map", "Plain object"]
  });
  const gateId = String(asked["gateId"]);
  assert.ok(gateId);
  assert.match(String(asked["text"]), /Question posted/);
  const state = await call(`/api/session/${other}`).then((r) => r.session);
  const gate = state.gates.find((g) => g.id === gateId);
  assert.equal(gate.kind, "question");
  assert.deepEqual(gate.meta?.options, ["Map", "Plain object"]);
  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ verdict: "answered", comment: "Map" })
  });
  const out = await hookFor(other, "Stop", { stop_hook_active: false });
  assert.equal(out.decision, "block");
  assert.match(out.reason ?? "", /answered at the question gate/);
  assert.match(out.reason ?? "", /Map/);
});
test("a structured question round-trips as one answer per question", async () => {
  const other = "integration-questions";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  const asked = await mcpFor(other, "ask", {
    question: "How should the cache work?",
    questions: [
      {
        header: "Backend",
        question: "Where should it live?",
        options: [
          { label: "Redis", description: "Shared across processes." },
          { label: "In-memory", description: "Simplest, lost on restart." }
        ]
      },
      {
        header: "Eviction",
        question: "What should it evict on?",
        multiSelect: true,
        options: [{ label: "TTL" }, { label: "LRU" }]
      }
    ]
  });
  const gateId = String(asked["gateId"]);
  const state = await call(`/api/session/${other}`).then((r) => r.session);
  const gate = state.gates.find((g) => g.id === gateId);
  assert.equal(gate.meta?.questions?.length, 2);
  assert.equal(gate.meta?.questions?.[0]?.header, "Backend");
  assert.equal(gate.meta?.questions?.[0]?.options[0]?.description, "Shared across processes.");
  assert.equal(gate.meta?.questions?.[1]?.multiSelect, true);
  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ verdict: "answered", answers: { q1: "Redis", q2: "TTL, LRU" } })
  });
  const out = await hookFor(other, "Stop", { stop_hook_active: false });
  assert.equal(out.decision, "block");
  assert.match(out.reason ?? "", /Where should it live\?/);
  assert.match(out.reason ?? "", /Redis/);
  assert.match(out.reason ?? "", /TTL, LRU/);
});
test("a renamed session keeps its name against the transcript title", async () => {
  const other = "integration-rename";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  const renamed = await call(`/api/session/${other}/title`, {
    method: "POST",
    body: JSON.stringify({ title: "Cache rewrite" })
  });
  assert.equal(renamed.title, "Cache rewrite");
  const list = await call("/api/sessions");
  assert.equal(list.sessions.find((s) => s.sessionId === other)?.title, "Cache rewrite");
  appendFileSync(transcript, `${JSON.stringify({ type: "ai-title", title: "Auto-generated title" })}
`);
  await sleep(400);
  const state = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(state.title, "Cache rewrite");
  assert.equal(state.titleLocked, true);
});
test("an empty rename is refused rather than blanking the session", async () => {
  const other = "integration-rename-empty";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  const before2 = await call(`/api/session/${other}`).then((r) => r.session);
  const res = await fetch(`${baseUrl(lock)}/api/session/${other}/title`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lock.token}` },
    body: JSON.stringify({ title: "   " })
  });
  assert.equal(res.status, 400);
  const after2 = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(after2.title, before2.title);
});
test("a superseded gate stops holding the turn", async () => {
  const other = "integration-superseded";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  await mcpFor(other, "plan", { title: "First", steps: [{ title: "a" }] });
  const parked = hookFor(other, "Stop", { stop_hook_active: false });
  await until(async () => {
    const s = await call(`/api/session/${other}`).then((r) => r.session);
    return s.status === "waiting";
  });
  await mcpFor(other, "plan", { title: "Second", steps: [{ title: "b" }] });
  const out = await withTimeout(parked, 8e3);
  assert.ok(out, "the parked Stop hook returned rather than hanging");
});
test("the verification gate opens only after the checks have finished", async () => {
  const other = "integration-checks";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  const result = await mcpFor(other, "checks", { commands: ["exit 0", "exit 7"] });
  const state = await call(`/api/session/${other}`).then((r) => r.session);
  assert.ok(state.checks.every((c) => c.status === "passed" || c.status === "failed"));
  assert.match(String(result["text"]), /1 of 2 check\(s\) FAILED/);
  assert.match(String(result["text"]), /exit 7/);
  assert.match(String(result["text"]), /Do not ask the user to sign off on a red check/);
});
test("ship refuses to commit onto the default branch", async () => {
  const other = "integration-onmain";
  const mainRepo = mkdtempSync(path2.join(tmpdir(), "cc-harness-main-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: mainRepo });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: mainRepo });
  execFileSync("git", ["config", "user.name", "T"], { cwd: mainRepo });
  writeFileSync(path2.join(mainRepo, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: mainRepo });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: mainRepo });
  writeFileSync(path2.join(mainRepo, "a.txt"), "two\n");
  await call(`/hook/SessionStart`, {
    method: "POST",
    body: JSON.stringify({ session_id: other, cwd: mainRepo, start_reason: "startup" })
  });
  const outcome = await call(`/api/session/${other}/ship`, {
    method: "POST",
    body: JSON.stringify({
      ship: {
        title: "t",
        body: "b",
        commitMessage: "c",
        branch: "main",
        baseBranch: "main",
        steps: ["commit"],
        provider: "none"
      }
    })
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /refusing to commit to "main"/);
  rmSync(mainRepo, { recursive: true, force: true });
});
test("a repo-local config supplies its own checks", async () => {
  const other = "integration-projectconfig";
  const cfgRepo = mkdtempSync(path2.join(tmpdir(), "cc-harness-cfg-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: cfgRepo });
  mkdirSync2(path2.join(cfgRepo, ".claude"), { recursive: true });
  writeFileSync(
    path2.join(cfgRepo, ".claude", "harness.json"),
    JSON.stringify({ stages: { verification: { checks: ["echo from-project-config"] } } })
  );
  await call(`/hook/SessionStart`, {
    method: "POST",
    body: JSON.stringify({ session_id: other, cwd: cfgRepo, start_reason: "startup" })
  });
  await call(`/mcp/checks`, {
    method: "POST",
    headers: { "x-harness-session": other },
    body: JSON.stringify({ cwd: cfgRepo })
  });
  const state = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(state.checks.length, 1, "the project config was read");
  assert.equal(state.checks[0].command, "echo from-project-config");
  assert.match(state.checks[0].output, /from-project-config/);
  rmSync(cfgRepo, { recursive: true, force: true });
});
test("publishing a new diff closes out the previous review round", async () => {
  const other = "integration-rounds";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  await mcpFor(other, "diff", {});
  const gate = await call(`/api/session/${other}`).then((r) => r.session.gates.find((g) => g.status === "open"));
  await call(`/api/session/${other}/gate/${gate.id}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      verdict: "changes_requested",
      threads: [
        { id: "", file: "app.ts", side: "new", startLine: 1, endLine: 1, body: "round one", createdAt: 0, resolved: false }
      ]
    })
  });
  await hookFor(other, "Stop", { stop_hook_active: false });
  await mcpFor(other, "diff", {});
  const after2 = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(after2.reviewRound, 2);
  assert.equal(after2.threads[0].resolved, true, "delivered comments close out when Claude republishes");
  assert.equal(after2.threads[0].round, 1);
});
test("approving a plan fills the task board", async () => {
  const other = "integration-board";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  const plan = await mcpFor(other, "plan", {
    title: "Board test",
    steps: [{ title: "One" }, { title: "Two" }, { title: "Three" }]
  });
  await call(`/api/session/${other}/gate/${String(plan["gateId"])}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      verdict: "approved",
      steps: [
        { id: "s1", title: "One" },
        { id: "s2", title: "Two" },
        { id: "s3", title: "Three", status: "dropped" }
      ]
    })
  });
  const s = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(s.tasks.length, 2, "dropped steps do not become tasks");
  assert.ok(s.tasks.every((t) => t.status === "todo"));
  assert.deepEqual(s.tasks.map((t) => t.title), ["One", "Two"]);
});
test("files edited are attributed to the task in progress", async () => {
  const other = "integration-attribute";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  await mcpFor(other, "tasks", { tasks: [{ title: "First" }, { title: "Second" }] });
  let s = await call(`/api/session/${other}`).then((r) => r.session);
  const [first, second] = s.tasks;
  await mcpFor(other, "task_update", { task_id: first.id, status: "in_progress" });
  await hookFor(other, "PostToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: path2.join(repo, "app.ts") }
  });
  await mcpFor(other, "task_update", { task_id: second.id, status: "in_progress" });
  await hookFor(other, "PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path2.join(repo, "other.ts") }
  });
  s = await call(`/api/session/${other}`).then((r) => r.session);
  assert.deepEqual(s.tasks.find((t) => t.id === first.id).files, ["app.ts"]);
  assert.deepEqual(s.tasks.find((t) => t.id === second.id).files, ["other.ts"]);
  assert.equal(
    s.tasks.filter((t) => t.status === "in_progress").length,
    1,
    "starting a task stands the previous one down"
  );
});
test("files changed through the shell are still attributed to the task", async () => {
  const other = "integration-shelledit";
  const shellRepo = mkdtempSync(path2.join(tmpdir(), "cc-harness-shell-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: shellRepo });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: shellRepo });
  execFileSync("git", ["config", "user.name", "T"], { cwd: shellRepo });
  writeFileSync(path2.join(shellRepo, "seed.ts"), "export const seed = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: shellRepo });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: shellRepo });
  const hook2 = (event, extra = {}) => call(`/hook/${event}`, {
    method: "POST",
    body: JSON.stringify({ session_id: other, cwd: shellRepo, ...extra })
  });
  const mcp2 = (tool, extra = {}) => call(`/mcp/${tool}`, {
    method: "POST",
    headers: { "x-harness-session": other },
    body: JSON.stringify({ cwd: shellRepo, ...extra })
  });
  await hook2("SessionStart", { start_reason: "startup" });
  await mcp2("tasks", { tasks: [{ title: "Shell task" }] });
  const before2 = await call(`/api/session/${other}`).then((r) => r.session);
  const task = before2.tasks[0];
  await mcp2("task_update", { task_id: task.id, status: "in_progress" });
  writeFileSync(path2.join(shellRepo, "seed.ts"), "export const seed = 2;\n");
  writeFileSync(path2.join(shellRepo, "brand-new.ts"), "export const fresh = true;\n");
  await mcp2("task_update", { task_id: task.id, status: "done", note: "did it with sed" });
  const after2 = await call(`/api/session/${other}`).then((r) => r.session);
  assert.deepEqual(after2.tasks[0].files.sort(), ["brand-new.ts", "seed.ts"]);
  rmSync(shellRepo, { recursive: true, force: true });
});
test("claiming a task moves the session into the implementing stage", async () => {
  const other = "integration-autostage";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  await mcpFor(other, "plan", { title: "Stage test", steps: [{ title: "One" }] });
  let s = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(s.stage, "plan_review");
  await mcpFor(other, "tasks", { tasks: [{ title: "Do the thing" }] });
  s = await call(`/api/session/${other}`).then((r) => r.session);
  await mcpFor(other, "task_update", { task_id: s.tasks[0].id, status: "in_progress" });
  s = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(s.stage, "implementing", "the stage follows the board, not a separate tool call");
});
test("completing a task requires a record of what changed", async () => {
  const other = "integration-taskdone";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  await mcpFor(other, "tasks", { tasks: [{ title: "Only" }] });
  const s = await call(`/api/session/${other}`).then((r) => r.session);
  const task = s.tasks[0];
  const refused = await mcpFor(other, "task_update", { task_id: task.id, status: "done" });
  assert.equal(refused["ok"], false);
  assert.match(String(refused["text"]), /requires `note`/);
  const accepted = await mcpFor(other, "task_update", {
    task_id: task.id.slice(0, 8),
    status: "done",
    note: "Added the helper and wired it in."
  });
  assert.equal(accepted["ok"], true, "the short id prefix is accepted");
  const after2 = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(after2.tasks[0].status, "done");
  assert.match(after2.tasks[0].notes.at(-1).text, /Added the helper/);
});
test("blocking a task asks the user and records their answer as a decision", async () => {
  const other = "integration-block";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  await mcpFor(other, "tasks", { tasks: [{ title: "Needs a decision" }] });
  let s = await call(`/api/session/${other}`).then((r) => r.session);
  const task = s.tasks[0];
  const blocked = await mcpFor(other, "task_block", {
    task_id: task.id,
    question: "Map or plain object?",
    options: ["Map", "Plain object"]
  });
  const gateId = String(blocked["gateId"]);
  s = await call(`/api/session/${other}`).then((r) => r.session);
  assert.equal(s.tasks[0].status, "blocked");
  assert.equal(s.tasks[0].blockedBy, gateId);
  await call(`/api/session/${other}/gate/${gateId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ verdict: "answered", comment: "Map" })
  });
  s = await call(`/api/session/${other}`).then((r) => r.session);
  const after2 = s.tasks[0];
  assert.equal(after2.status, "in_progress", "answering unblocks the task");
  assert.equal(after2.decisions.length, 1);
  assert.equal(after2.decisions[0].answer, "Map");
  assert.match(after2.decisions[0].question, /Map or plain object/);
  assert.ok(after2.notes.some((n) => n.kind === "decision"));
});
test("a second round marks only what actually moved", async () => {
  const other = "integration-rounds2";
  const roundRepo = mkdtempSync(path2.join(tmpdir(), "cc-harness-rounds-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: roundRepo });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: roundRepo });
  execFileSync("git", ["config", "user.name", "T"], { cwd: roundRepo });
  writeFileSync(path2.join(roundRepo, "stable.ts"), "export const a = 1;\n");
  writeFileSync(path2.join(roundRepo, "moving.ts"), "export const b = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: roundRepo });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: roundRepo });
  writeFileSync(path2.join(roundRepo, "stable.ts"), "export const a = 2;\n");
  writeFileSync(path2.join(roundRepo, "moving.ts"), "export const b = 2;\n");
  await call(`/hook/SessionStart`, {
    method: "POST",
    body: JSON.stringify({ session_id: other, cwd: roundRepo, start_reason: "startup" })
  });
  const first = await call(`/mcp/diff`, {
    method: "POST",
    headers: { "x-harness-session": other },
    body: JSON.stringify({ cwd: roundRepo })
  });
  assert.equal(first["round"], 1);
  writeFileSync(path2.join(roundRepo, "moving.ts"), "export const b = 3;\n");
  await call(`/mcp/diff`, {
    method: "POST",
    headers: { "x-harness-session": other },
    body: JSON.stringify({ cwd: roundRepo })
  });
  const { diff } = await call(`/api/session/${other}/diff`);
  assert.equal(diff.round, 2);
  assert.equal(diff.previousRound, 1);
  assert.deepEqual(diff.changedSinceLastReview, ["moving.ts"]);
  assert.equal(diff.files.find((f) => f.path === "stable.ts").changedSinceLastReview, false);
  assert.equal(diff.files.find((f) => f.path === "moving.ts").changedSinceLastReview, true);
  rmSync(roundRepo, { recursive: true, force: true });
});
test("Claude can reply to a comment in its thread", async () => {
  const other = "integration-reply";
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  await mcpFor(other, "diff", {});
  const gate = await call(`/api/session/${other}`).then((r) => r.session.gates.find((g) => g.status === "open"));
  await call(`/api/session/${other}/gate/${gate.id}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      verdict: "changes_requested",
      threads: [
        { id: "", file: "app.ts", side: "new", startLine: 1, endLine: 1, body: "why?", createdAt: 0, resolved: false }
      ]
    })
  });
  const withThread = await call(`/api/session/${other}`).then((r) => r.session);
  const threadId = withThread.threads[0].id;
  const replied = await mcpFor(other, "reply", { thread_id: threadId, text: "Because of X." });
  assert.equal(replied["ok"], true);
  const after2 = await call(`/api/session/${other}`).then((r) => r.session);
  const thread = after2.threads[0];
  assert.equal(thread.replies?.length, 1);
  assert.equal(thread.replies[0].author, "claude");
  assert.equal(thread.replies[0].text, "Because of X.");
  assert.equal(thread.resolved, true, "replying resolves the thread by default");
});
test("the diff is persisted, so a daemon restart does not empty the review", async () => {
  const other = "integration-diffpersist";
  writeFileSync(path2.join(repo, "persisted.ts"), "export const persisted = true;\n");
  await hookFor(other, "SessionStart", { start_reason: "startup" });
  await mcpFor(other, "diff", {});
  const served = await call(`/api/session/${other}/diff`);
  assert.ok(served.diff.files.length > 0);
  const onDisk = JSON.parse(
    readFileSync2(path2.join(home, "sessions", other, "diff.json"), "utf8")
  );
  assert.equal(onDisk.files.length, served.diff.files.length);
  assert.equal(onDisk.baseRef, served.diff.baseRef);
  rmSync(path2.join(repo, "persisted.ts"), { force: true });
});
test("the diff engine sees uncommitted and untracked work", async () => {
  writeFileSync(
    path2.join(repo, "app.ts"),
    "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function subtract(a: number, b: number) {\n  return a - b;\n}\n"
  );
  writeFileSync(path2.join(repo, "app.test.ts"), 'import { subtract } from "./app";\nsubtract(2, 1);\n');
  const published = await mcp("diff", {});
  assert.match(String(published["text"]), /Diff published \(round \d+\): 2 file\(s\)/);
  const { diff } = await call(`/api/session/${sessionId}/diff`);
  const app = diff.files.find((f) => f.path === "app.ts");
  const test2 = diff.files.find((f) => f.path === "app.test.ts");
  assert.ok(app, "the modified file is present");
  assert.equal(test2?.status, "added", "the untracked file is present as an addition");
  assert.ok((app?.additions ?? 0) >= 4);
});
test("a line comment reaches the session with the source the user selected", async () => {
  const s = await session();
  const gate = s.gates.find((g) => g.status === "open" && g.kind === "code_review");
  assert.ok(gate, "publishing the diff opened the review gate");
  const parked = hook("Stop", { stop_hook_active: false });
  await until(async () => (await session()).status === "waiting");
  await call(`/api/session/${sessionId}/gate/${gate.id}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      verdict: "changes_requested",
      comment: "One thing.",
      threads: [
        {
          id: "",
          file: "app.ts",
          side: "new",
          startLine: 5,
          endLine: 6,
          body: "Guard against NaN here.",
          createdAt: 0,
          resolved: false
        }
      ]
    })
  });
  const out = await parked;
  assert.equal(out.decision, "block");
  assert.match(out.reason ?? "", /app\.ts:5-6/);
  assert.match(out.reason ?? "", /Guard against NaN here/);
  assert.match(out.reason ?? "", /subtract/, "the excerpt is filled in from the diff");
  assert.match(out.reason ?? "", /Address each comment above/);
  assert.match(out.reason ?? "", /harness_reply/);
});
test("checks run and stream their result", async () => {
  await mcp("checks", { commands: ["echo hello-from-check"], run: true });
  const passed = await until(async () => {
    const s = await session();
    const check = s.checks[0];
    return check && check.status !== "pending" && check.status !== "running" ? check : null;
  }, 15e3);
  assert.equal(passed.status, "passed");
  assert.equal(passed.exitCode, 0);
  assert.match(passed.output, /hello-from-check/);
});
test("a failing check is reported as failing", async () => {
  await call(`/api/session/${sessionId}/checks`, {
    method: "POST",
    body: JSON.stringify({ commands: ["exit 3"] })
  });
  await call(`/api/session/${sessionId}/checks/run`, { method: "POST", body: "{}" });
  const failed = await until(async () => {
    const s = await session();
    const check = s.checks[0];
    return check && (check.status === "failed" || check.status === "passed") ? check : null;
  }, 15e3);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 3);
});
test("the ship payload is composed from the approved plan and the checks", async () => {
  const ship = await mcp("ship", {});
  const payload = ship["ship"];
  assert.equal(payload.title, "Add a subtract function");
  assert.equal(payload.branch, "feature/change");
  assert.match(payload.body, /Mirror add\(\)/);
  assert.match(payload.body, /Write subtract/);
  assert.doesNotMatch(payload.body, /Update the docs/, "dropped steps stay out of the PR body");
  assert.match(payload.body, /## Verification/);
  assert.match(payload.commitMessage, /^Add a subtract function/);
});
test("ship refuses to proceed while a check is failing", async () => {
  const s = await session();
  const result = await call(`/api/session/${sessionId}/ship`, {
    method: "POST",
    body: JSON.stringify({ ship: { ...s.ship, steps: ["checks", "commit"] } })
  });
  assert.equal(result.ok, false);
  assert.match(result.output, /check\(s\) failing/);
});
test("async comments ride along with the next user prompt", async () => {
  await call(`/api/session/${sessionId}/feedback`, {
    method: "POST",
    body: JSON.stringify({ text: "also rename the file", origin: "timeline" })
  });
  const out = await hook("UserPromptSubmit", { user_input: "continue" });
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", /also rename the file/);
  assert.equal(out.decision, void 0, "context injection never blocks the prompt");
});
test("SessionEnd closes the session out", async () => {
  await hook("SessionEnd", { end_reason: "other" });
  const s = await session();
  assert.equal(s.status, "ended");
  assert.ok(s.endedAt);
});
test("a session can be deleted, and stays deleted", async () => {
  const doomed = "doomed-session";
  await hookFor(doomed, "SessionStart", { start_reason: "startup" });
  const before2 = await call("/api/sessions");
  assert.ok(before2.sessions.some((s) => s.sessionId === doomed), "the session is listed first");
  const dir = path2.join(home, "sessions", doomed);
  assert.ok(existsSync2(dir), "and has state on disk");
  const res = await call(`/api/session/${doomed}`, { method: "DELETE" });
  assert.equal(res.deleted, true);
  const after2 = await call("/api/sessions");
  assert.ok(!after2.sessions.some((s) => s.sessionId === doomed), "gone from the list");
  assert.ok(!existsSync2(dir), "and gone from disk \u2014 this is deletion, not eviction");
  const missing = await fetch(`${baseUrl(lock)}/api/session/${doomed}`, {
    headers: { authorization: `Bearer ${lock.token}` }
  });
  assert.equal(missing.status, 404);
});
test("deleting an unknown session is a 404, not a silent success", async () => {
  const res = await fetch(`${baseUrl(lock)}/api/session/no-such-session`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${lock.token}` }
  });
  assert.equal(res.status, 404);
});
test("deleting a session takes its transcript tailer with it", async () => {
  const tailed = "tailed-session";
  const ownTranscript = path2.join(home, "tailed.jsonl");
  writeFileSync(ownTranscript, "");
  await hookFor(tailed, "SessionStart", { start_reason: "startup", transcript_path: ownTranscript });
  appendFileSync(
    ownTranscript,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }) + "\n"
  );
  await until(async () => {
    const r = await call(`/api/session/${tailed}`);
    return r.session?.timeline?.some((e) => e.text.includes("hello"));
  });
  await call(`/api/session/${tailed}`, { method: "DELETE" });
  appendFileSync(
    ownTranscript,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "after" }] } }) + "\n"
  );
  await sleep(600);
  const list = await call("/api/sessions");
  assert.ok(!list.sessions.some((s) => s.sessionId === tailed), "it does not come back");
});
//# sourceMappingURL=integration.test.js.map
