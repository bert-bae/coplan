// src/test/restart.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
    const lock = JSON.parse(readFileSync(file, "utf8"));
    if (typeof lock.port !== "number" || typeof lock.token !== "string") return null;
    return lock;
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
  const lock = readLock();
  if (!lock) return null;
  return isPidAlive(lock.pid) ? lock : null;
}
function baseUrl(lock) {
  return `http://${lock.host || "127.0.0.1"}:${lock.port}`;
}

// src/test/restart.test.ts
var DAEMON = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "daemon", "main.js");
var home;
var daemon;
var first;
before(async () => {
  home = mkdtempSync(path2.join(tmpdir(), "cc-harness-restart-"));
  process.env["CC_HARNESS_HOME"] = home;
  daemon = spawn(process.execPath, [DAEMON], { env: { ...process.env, CC_HARNESS_HOME: home }, stdio: "ignore" });
  const lock = await waitForLock(0);
  if (!lock) throw new Error("daemon did not start");
  first = lock;
});
after(async () => {
  const live = readLiveLock();
  if (live) {
    try {
      process.kill(live.pid, "SIGTERM");
    } catch {
    }
  }
  if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
  await sleep(300);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function waitForLock(previousPid, timeoutMs = 2e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readLiveLock();
    if (lock && lock.pid !== previousPid) return lock;
    await sleep(100);
  }
  return null;
}
test("the daemon hands its address and token to its replacement", async () => {
  const res = await fetch(`${baseUrl(first)}/api/daemon/restart`, {
    method: "POST",
    headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.restarting, true);
  const second = await waitForLock(first.pid);
  assert.ok(second, "a replacement daemon should have claimed the lock");
  assert.notEqual(second.pid, first.pid, "it is a new process");
  assert.equal(second.port, first.port, "an open browser tab is still pointed at a live daemon");
  assert.equal(second.token, first.token, "and the cookie it holds still authorizes it");
  assert.equal(await tokenWorks(second), true);
  await waitUntil(() => !isPidAlive(first.pid));
  assert.equal(isPidAlive(first.pid), false, "the outgoing daemon exits rather than lingering");
});
test("the replacement serves the API on the inherited address", async () => {
  const lock = readLiveLock();
  assert.ok(lock, "a daemon should be running");
  const health = await fetch(`${baseUrl(lock)}/health`).then((r) => r.json());
  assert.equal(health.pid, lock.pid);
  const sessions = await fetch(`${baseUrl(lock)}/api/sessions`, {
    headers: { authorization: `Bearer ${lock.token}` }
  });
  assert.equal(sessions.status, 200);
});
async function tokenWorks(lock) {
  const res = await fetch(`${baseUrl(lock)}/api/sessions`, {
    headers: { authorization: `Bearer ${lock.token}` }
  });
  return res.ok;
}
async function waitUntil(predicate, timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) await sleep(50);
}
//# sourceMappingURL=restart.test.js.map
