// src/test/housekeeping.test.ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync as mkdirSync2,
  rmSync as rmSync2,
  writeFileSync as writeFileSync2,
  existsSync as existsSync3,
  utimesSync,
  readFileSync as readFileSync3
} from "node:fs";
import { tmpdir } from "node:os";
import path3 from "node:path";

// src/daemon/housekeeping.ts
import { readdirSync, statSync, existsSync as existsSync2, rmSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import path2 from "node:path";

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

// src/daemon/housekeeping.ts
var STALE_SESSION_MS = 24 * 60 * 60 * 1e3;
var PARTIAL_WRITE_MS = 5 * 60 * 1e3;
var LOG_LIMIT_BYTES = 1024 * 1024;
var LOG_KEEP_BYTES = 256 * 1024;
function scanStorage(opts2 = {}) {
  const now = opts2.now ?? Date.now();
  const live = /* @__PURE__ */ new Set();
  for (const id of opts2.liveSessionIds ?? []) live.add(sanitizeId(id));
  const plans = buildPlans(live, now);
  const groups = plans.map((plan) => ({
    id: plan.id,
    label: plan.label,
    detail: plan.detail,
    count: plan.candidates.length,
    bytes: plan.candidates.reduce((sum, c) => sum + reclaimable(c), 0)
  }));
  return {
    home: harnessHome(),
    scannedAt: now,
    groups,
    totalBytes: groups.reduce((sum, g) => sum + g.bytes, 0)
  };
}
function cleanStorage(opts2 = {}) {
  const now = opts2.now ?? Date.now();
  const live = /* @__PURE__ */ new Set();
  for (const id of opts2.liveSessionIds ?? []) live.add(sanitizeId(id));
  const wanted = opts2.groups && opts2.groups.length ? new Set(opts2.groups) : null;
  const plans = buildPlans(live, now).filter((p) => !wanted || wanted.has(p.id));
  const groups = [];
  const failed = [];
  let freedBytes = 0;
  let removed = 0;
  for (const plan of plans) {
    let groupBytes = 0;
    let groupCount = 0;
    for (const candidate of plan.candidates) {
      const gain = reclaimable(candidate);
      if (opts2.dryRun) {
        groupBytes += gain;
        groupCount++;
        continue;
      }
      if (!discard(candidate)) {
        failed.push(candidate.path);
        continue;
      }
      groupBytes += gain;
      groupCount++;
    }
    groups.push({ id: plan.id, label: plan.label, count: groupCount, bytes: groupBytes });
    freedBytes += groupBytes;
    removed += groupCount;
  }
  return { dryRun: Boolean(opts2.dryRun), groups, removed, freedBytes, failed };
}
function buildPlans(live, now) {
  return [
    {
      id: "sessions",
      label: "Finished sessions",
      detail: "Saved plans for sessions Coplan no longer lists, untouched for over a day.",
      candidates: staleSessionDirs(live, now)
    },
    {
      id: "partial-writes",
      label: "Interrupted writes",
      detail: "Half-written state files left behind when a daemon was killed mid-save.",
      candidates: partialWrites(now)
    },
    {
      id: "log",
      label: "Daemon log",
      detail: "The older part of the log. The most recent entries are kept.",
      candidates: oversizedLog()
    },
    {
      id: "lock",
      label: "Stale lock file",
      detail: "A daemon address left behind by a process that is no longer running.",
      candidates: staleLock()
    }
  ];
}
function staleSessionDirs(live, now) {
  const root = paths.sessionsDir();
  if (!existsSync2(root)) return [];
  const out = [];
  for (const entry of safeReaddir(root)) {
    if (!entry.isDirectory()) continue;
    if (live.has(sanitizeId(entry.name))) continue;
    const dir = path2.join(root, entry.name);
    if (now - touchedAt(dir) < STALE_SESSION_MS) continue;
    out.push({ path: dir, bytes: sizeOf(dir) });
  }
  return out;
}
function touchedAt(dir) {
  let latest = mtimeOf(dir);
  for (const entry of safeReaddir(dir)) {
    if (!entry.isFile()) continue;
    latest = Math.max(latest, mtimeOf(path2.join(dir, entry.name)));
  }
  return latest;
}
function partialWrites(now) {
  const root = paths.sessionsDir();
  if (!existsSync2(root)) return [];
  const out = [];
  for (const entry of safeReaddir(root)) {
    if (!entry.isDirectory()) continue;
    const dir = path2.join(root, entry.name);
    for (const file of safeReaddir(dir)) {
      if (!file.isFile()) continue;
      if (!/^\.(state|diff)\..*\.tmp$/.test(file.name)) continue;
      const full = path2.join(dir, file.name);
      if (now - mtimeOf(full) < PARTIAL_WRITE_MS) continue;
      out.push({ path: full, bytes: sizeOf(full) });
    }
  }
  return out;
}
function oversizedLog() {
  const file = paths.logFile();
  const bytes = sizeOf(file);
  if (bytes <= LOG_LIMIT_BYTES) return [];
  return [{ path: file, bytes, trimTo: LOG_KEEP_BYTES }];
}
function staleLock() {
  const lock = readLock();
  if (!lock || isPidAlive(lock.pid)) return [];
  const file = paths.lockFile();
  return [{ path: file, bytes: sizeOf(file) }];
}
function reclaimable(candidate) {
  return candidate.trimTo === void 0 ? candidate.bytes : Math.max(0, candidate.bytes - candidate.trimTo);
}
function discard(candidate) {
  const target = path2.resolve(candidate.path);
  const home2 = path2.resolve(harnessHome());
  if (!target.startsWith(home2 + path2.sep)) return false;
  try {
    if (candidate.trimTo !== void 0) {
      trimFile(target, candidate.trimTo);
      return true;
    }
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
function trimFile(file, keepBytes) {
  const content = readFileSync2(file, "utf8");
  const tail = content.slice(Math.max(0, content.length - keepBytes));
  const from = tail.indexOf("\n");
  writeFileSync(file, from === -1 ? tail : tail.slice(from + 1));
}
function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function mtimeOf(target) {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}
function sizeOf(target) {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of safeReaddir(target)) total += sizeOf(path2.join(target, entry.name));
  return total;
}

// src/test/housekeeping.test.ts
var home;
before(() => {
  home = mkdtempSync(path3.join(tmpdir(), "cc-harness-hk-home-"));
  process.env["CC_HARNESS_HOME"] = home;
});
after(() => {
  rmSync2(home, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync2(path3.join(home, "sessions"), { recursive: true, force: true });
  rmSync2(path3.join(home, "daemon.log"), { force: true });
  rmSync2(path3.join(home, "daemon.json"), { force: true });
  mkdirSync2(path3.join(home, "sessions"), { recursive: true });
});
var DAY = 24 * 60 * 60 * 1e3;
function session(id, ageMs, bytes = 200) {
  const dir = path3.join(home, "sessions", id);
  mkdirSync2(dir, { recursive: true });
  const file = path3.join(dir, "state.json");
  writeFileSync2(file, JSON.stringify({ sessionId: id, pad: "x".repeat(bytes) }));
  const when = (Date.now() - ageMs) / 1e3;
  utimesSync(file, when, when);
  utimesSync(dir, when, when);
  return dir;
}
function group(report, id) {
  const found = report.groups.find((g) => g.id === id);
  assert.ok(found, `expected a "${id}" group in the report`);
  return found;
}
var opts = () => ({});
test("a session the daemon is holding is never offered up", () => {
  session("resident", 30 * DAY);
  const report = scanStorage({ ...opts(), liveSessionIds: ["resident"] });
  assert.equal(group(report, "sessions").count, 0);
  cleanStorage({ ...opts(), liveSessionIds: ["resident"], groups: ["sessions"] });
  assert.ok(existsSync3(path3.join(home, "sessions", "resident")), "a live session must survive a clean");
});
test("a session evicted from memory but touched recently is kept", () => {
  session("evicted-recently", 2 * 60 * 60 * 1e3);
  const report = scanStorage(opts());
  assert.equal(group(report, "sessions").count, 0);
});
test("a session directory nothing has touched in a day is reclaimable", () => {
  const dir = session("cold", 3 * DAY, 500);
  const report = scanStorage(opts());
  assert.equal(group(report, "sessions").count, 1);
  assert.ok(group(report, "sessions").bytes >= 500);
  const result = cleanStorage({ ...opts(), groups: ["sessions"] });
  assert.equal(result.removed, 1);
  assert.equal(existsSync3(dir), false);
});
test("age is read from the newest file, not the directory", () => {
  const dir = session("busy", 10 * DAY);
  const fresh = path3.join(dir, "state.json");
  const now = Date.now() / 1e3;
  utimesSync(fresh, now, now);
  assert.equal(group(scanStorage(opts()), "sessions").count, 0);
});
test("a dry run reports what would go and removes nothing", () => {
  const dir = session("cold", 3 * DAY);
  const result = cleanStorage({ ...opts(), dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(result.freedBytes > 0);
  assert.equal(existsSync3(dir), true, "a dry run must not touch the filesystem");
});
test("cleaning one group leaves the others alone", () => {
  const dir = session("cold", 3 * DAY);
  const junk = path3.join(home, "daemon.json");
  writeFileSync2(junk, JSON.stringify({ pid: 0, port: 1, token: "t" }));
  const result = cleanStorage({ ...opts(), groups: ["lock"] });
  assert.equal(result.groups.length, 1);
  assert.equal(existsSync3(dir), true, "the session group was not selected");
  assert.equal(existsSync3(junk), false);
});
test("an abandoned .tmp is reclaimed even inside a live session", () => {
  const dir = session("live", 6e4);
  const partial = path3.join(dir, ".state.1234.tmp");
  writeFileSync2(partial, '{"half":');
  age(partial, 10 * 60 * 1e3);
  const report = scanStorage({ ...opts(), liveSessionIds: ["live"] });
  assert.equal(group(report, "partial-writes").count, 1);
  cleanStorage({ ...opts(), liveSessionIds: ["live"], groups: ["partial-writes"] });
  assert.equal(existsSync3(partial), false);
  assert.ok(existsSync3(path3.join(dir, "state.json")), "the real state file is untouched");
});
test("a .tmp from a write still in flight is left alone", () => {
  const dir = session("live", 6e4);
  writeFileSync2(path3.join(dir, ".diff.99.tmp"), "x");
  assert.equal(group(scanStorage({ ...opts(), liveSessionIds: ["live"] }), "partial-writes").count, 0);
});
test("an oversized log is trimmed to its tail, not deleted", () => {
  const file = path3.join(home, "daemon.log");
  const line = `${"x".repeat(200)}
`;
  writeFileSync2(file, line.repeat(9e3));
  const report = scanStorage(opts());
  assert.equal(group(report, "log").count, 1);
  assert.ok(group(report, "log").bytes > 0, "only the part being dropped counts as reclaimed");
  cleanStorage({ ...opts(), groups: ["log"] });
  const after2 = readFileSync3(file, "utf8");
  assert.ok(existsSync3(file), "the daemon appends to this file; it must still exist");
  assert.ok(after2.length < 4e5, `expected a trimmed log, got ${after2.length} bytes`);
  assert.ok(after2.length > 0, "the recent entries are kept");
  assert.ok(after2.startsWith("x"), "the trim lands on a line boundary");
});
test("a log under the limit is left alone", () => {
  writeFileSync2(path3.join(home, "daemon.log"), "a few lines\n");
  assert.equal(group(scanStorage(opts()), "log").count, 0);
});
test("a lock file is reclaimable only once its process is gone", () => {
  const file = path3.join(home, "daemon.json");
  writeFileSync2(file, JSON.stringify({ pid: process.pid, port: 1, token: "t", version: "0", startedAt: 0, host: "" }));
  assert.equal(group(scanStorage(opts()), "lock").count, 0, "a running daemon owns its lock");
  writeFileSync2(file, JSON.stringify({ pid: 0, port: 1, token: "t", version: "0", startedAt: 0, host: "" }));
  assert.equal(group(scanStorage(opts()), "lock").count, 1);
  cleanStorage({ ...opts(), groups: ["lock"] });
  assert.equal(existsSync3(file), false);
});
test("cleaning never reaches outside the harness home", () => {
  const outside = mkdtempSync(path3.join(tmpdir(), "cc-harness-hk-outside-"));
  const victim = path3.join(outside, "precious.txt");
  writeFileSync2(victim, "keep me");
  age(victim, 30 * DAY);
  try {
    const result = cleanStorage({ groups: ["sessions", "partial-writes", "log", "lock"] });
    assert.equal(result.failed.length, 0);
    assert.equal(existsSync3(victim), true);
  } finally {
    rmSync2(outside, { recursive: true, force: true });
  }
});
function age(target, ms) {
  const when = (Date.now() - ms) / 1e3;
  utimesSync(target, when, when);
}
//# sourceMappingURL=housekeeping.test.js.map
