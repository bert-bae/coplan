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
var hookFor = (id, event, body = {}) => call(`/hook/${event}`, {
  method: "POST",
  body: JSON.stringify({ session_id: id, cwd: repo, ...body })
});
var mcpFor = (id, tool, body = {}) => call(`/mcp/${tool}`, {
  method: "POST",
  headers: { "x-harness-session": id },
  body: JSON.stringify({ cwd: repo, ...body })
});
var hook = (event, body = {}) => hookFor(sessionId, event, body);
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
  tasks: [{ title: "Storage", subtasks: [{ title: "Client" }, { title: "Invalidation" }] }, { title: "Wire up" }],
  questions: [{ question: "Which backend?", options: ["Redis", "Memcached"] }]
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
  assert.match(text, /- api → db/);
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
  const before2 = await session();
  const q = before2.plan.questions[0].id;
  const res = await ops([
    { op: "answer", id: q, selected: ["Redis"], text: "already deployed" },
    { op: "move_task", id: "t4", parentId: "t1", index: 0 },
    { op: "upsert_task", parentId: "t1", title: "Load test" },
    { op: "comment", target: { kind: "diagram", id: "d1" }, text: "where does the cache go?" },
    {
      op: "upsert_diagram",
      id: "d1",
      nodes: [
        { id: "api", label: "API", kind: "service", x: 0, y: 0 },
        { id: "cache", label: "Redis", kind: "datastore", x: 200, y: 0 },
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
  assert.match(read, /Since you last read — 5 change\(s\) by the user/);
  assert.match(read, /answered "Which backend\?": Redis — already deployed/);
  assert.match(read, /moved "Wire up" under "Storage"/);
  assert.match(read, /added task "Load test" under "Storage"/);
  assert.match(read, /commented on diagram "Components"/);
  assert.match(read, /added "Redis".*connected API → Redis/);
  assert.match(read, /- cache: "Redis" \(datastore\)/);
});
test("reading once catches Claude up", async () => {
  const again = String((await mcp("read", { changes_only: true }))["text"]);
  assert.match(again, /has not changed the plan/);
  const notice = await hook("UserPromptSubmit", { prompt: "continue" });
  assert.equal(notice.hookSpecificOutput?.additionalContext, void 0, "no notice once Claude is up to date");
});
test("the next chat message after an edit tells Claude to read the plan", async () => {
  await ops([{ op: "upsert_question", question: "Should we shard?" }]);
  const out = await hook("UserPromptSubmit", { prompt: "ok, go on" });
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", /changed the plan .* harness_plan_read/);
});
test("a republish over unread user edits is refused", async () => {
  const res = await mcp("publish", PLAN);
  assert.equal(res["ok"], false);
  assert.match(String(res["text"]), /harness_plan_read first/);
  const s = await session();
  assert.ok(s.plan.questions.some((q) => q.question === "Should we shard?"), "nothing the user did was lost");
});
test("Claude answers the user's question and replies to their comment", async () => {
  await mcp("read", {});
  const s = await session();
  const asked = s.plan.questions.find((q) => q.question === "Should we shard?");
  const thread = s.plan.threads[0];
  const res = await mcp("edit", {
    ops: [
      { op: "answer", id: asked.id, text: "Not yet \u2014 one node handles the load." },
      { op: "reply", threadId: thread.id, text: "Between the API and Postgres." }
    ]
  });
  assert.equal(res["ok"], true, String(res["text"]));
  const after2 = await session();
  assert.equal(after2.plan.questions.find((q) => q.id === asked.id)?.answer?.by, "claude");
  assert.equal(after2.plan.threads[0].replies[0].author, "claude");
  assert.equal(after2.plan.claudeReadSeq, after2.plan.seq, "its own edits are not news to it");
});
test("task tracking moves statuses and reports them", async () => {
  const res = await mcp("task", { task_id: "t2", status: "done", note: "client added" });
  assert.match(String(res["text"]), /"Client" is done/);
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
//# sourceMappingURL=integration.test.js.map
