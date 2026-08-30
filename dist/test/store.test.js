var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/shared/paths.ts
import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
function harnessHome() {
  return process.env.CC_HARNESS_HOME || path.join(homedir(), ".claude", "cc-harness");
}
function sanitizeId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}
function ensureHome() {
  const home2 = harnessHome();
  mkdirSync(home2, { recursive: true });
  mkdirSync(path.join(home2, "sessions"), { recursive: true });
  return home2;
}
var paths;
var init_paths = __esm({
  "src/shared/paths.ts"() {
    "use strict";
    paths = {
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
  }
});

// src/daemon/store.ts
var store_exports = {};
__export(store_exports, {
  MAX_CACHED_DIFFS: () => MAX_CACHED_DIFFS,
  SessionStore: () => SessionStore,
  newSession: () => newSession,
  sanitizeId: () => sanitizeId
});
import { EventEmitter } from "node:events";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync, readdirSync, existsSync as existsSync2, renameSync, rmSync, statSync } from "node:fs";
import path2 from "node:path";
import { randomUUID } from "node:crypto";
function newSession(sessionId, cwd) {
  const now = Date.now();
  return {
    sessionId,
    cwd,
    repoRoot: null,
    worktree: null,
    branch: null,
    transcriptPath: null,
    title: path2.basename(cwd) || sessionId.slice(0, 8),
    stage: "idle",
    status: "active",
    createdAt: now,
    updatedAt: now,
    baseRef: null,
    startCommit: null,
    reviewRound: 0,
    roundHistory: [],
    tasks: [],
    plan: null,
    todos: [],
    files: [],
    commands: [],
    timeline: [],
    gates: [],
    activeGateId: null,
    threads: [],
    checks: [],
    ship: null,
    pendingFeedback: [],
    stats: { turns: 0, toolCalls: 0, edits: 0 }
  };
}
function migrate(state) {
  state.reviewRound ??= 0;
  state.worktree ??= null;
  state.threads ??= [];
  state.roundHistory ??= [];
  state.tasks ??= [];
  if (state.status === "active") state.status = "idle";
  for (const gate of state.gates) gate.waiting = false;
  trimGates(state);
}
function trimGates(state) {
  if (state.gates.length <= MAX_GATES) return;
  const keep = /* @__PURE__ */ new Set();
  for (const gate of state.gates) {
    if (gate.status === "open" || gate.result && !gate.deliveredAt) keep.add(gate);
  }
  const droppable = state.gates.filter((g) => !keep.has(g));
  const surplus = state.gates.length - MAX_GATES;
  const drop = new Set(droppable.slice(0, Math.max(0, surplus)));
  if (drop.size === 0) return;
  state.gates = state.gates.filter((g) => !drop.has(g));
}
function repoNameOf(state) {
  const root = state.worktree?.mainRoot ?? state.repoRoot;
  return root ? path2.basename(root) : null;
}
function mtimeOf(dir) {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return Date.now();
  }
}
function discardDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
function describeVerdict(result) {
  const bits = [];
  switch (result.verdict) {
    case "approved":
      bits.push("Approved");
      break;
    case "changes_requested":
      bits.push("Changes requested");
      break;
    case "rejected":
      bits.push("Rejected");
      break;
    case "answered":
      bits.push("Answered");
      break;
  }
  if (result.threads?.length) bits.push(`${result.threads.length} line comment(s)`);
  if (result.comment) bits.push(result.comment);
  return bits.join(" \u2014 ");
}
var PERSIST_DEBOUNCE_MS, SESSION_TTL_MS, MAX_SESSIONS, MAX_GATES, MAX_CACHED_DIFFS, SessionStore;
var init_store = __esm({
  "src/daemon/store.ts"() {
    "use strict";
    init_paths();
    PERSIST_DEBOUNCE_MS = 400;
    SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1e3;
    MAX_SESSIONS = 60;
    MAX_GATES = 40;
    MAX_CACHED_DIFFS = 12;
    SessionStore = class extends EventEmitter {
      sessions = /* @__PURE__ */ new Map();
      diffs = /* @__PURE__ */ new Map();
      persistTimers = /* @__PURE__ */ new Map();
      maxTimeline;
      constructor(opts = {}) {
        super();
        this.setMaxListeners(0);
        this.maxTimeline = opts.maxTimelineEvents ?? 500;
        ensureHome();
        this.loadFromDisk();
      }
      /* ---------------------------------------------------------------- *
       * Lifecycle
       * ---------------------------------------------------------------- */
      loadFromDisk() {
        const dir = paths.sessionsDir();
        if (!existsSync2(dir)) return;
        const loaded = [];
        const expired = [];
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const sessionDir = path2.join(dir, entry.name);
          const file = path2.join(sessionDir, "state.json");
          if (!existsSync2(file)) {
            if (mtimeOf(sessionDir) < cutoff) expired.push(sessionDir);
            continue;
          }
          try {
            const state = JSON.parse(readFileSync2(file, "utf8"));
            if (!state.sessionId) continue;
            if ((state.updatedAt ?? 0) < cutoff) {
              expired.push(sessionDir);
              continue;
            }
            migrate(state);
            loaded.push(state);
          } catch {
          }
        }
        loaded.sort((a, b) => b.updatedAt - a.updatedAt);
        for (const state of loaded.slice(0, MAX_SESSIONS)) {
          this.sessions.set(state.sessionId, state);
        }
        for (const sessionDir of expired) discardDir(sessionDir);
      }
      /** Read one session from disk, or undefined if there is nothing to read. */
      readSession(id) {
        try {
          const file = paths.sessionState(id);
          if (!existsSync2(file)) return void 0;
          const state = JSON.parse(readFileSync2(file, "utf8"));
          if (!state.sessionId) return void 0;
          migrate(state);
          return state;
        } catch {
          return void 0;
        }
      }
      /**
       * Forget a session: memory, cached diff, and any pending write.
       *
       * On-disk state is left alone — this is eviction, not deletion — so the
       * session is still there if the daemon restarts and the user goes looking.
       */
      drop(id) {
        const timer = this.persistTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.persistTimers.delete(id);
          this.persistNow(id);
        }
        this.diffs.delete(id);
        const removed = this.sessions.delete(id);
        if (removed) this.broadcastSessionList();
        return removed;
      }
      /**
       * Delete a session for good: memory, cached diff, pending write, and the
       * whole on-disk directory.
       *
       * Unlike `drop`, this is not eviction. `ensure` reads state back off disk
       * when a swept session reappears, so anything short of removing the
       * directory would resurrect the session the next time a hook mentioned it —
       * which is exactly what a user who clicked "delete" did not ask for.
       */
      purge(id) {
        const timer = this.persistTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.persistTimers.delete(id);
        }
        this.diffs.delete(id);
        const removed = this.sessions.delete(id);
        discardDir(paths.sessionDir(id));
        if (removed) this.broadcastSessionList();
        return removed;
      }
      /**
       * Evict sessions that ended a while ago, and trim gate history on the rest.
       *
       * Called on a timer by the daemon. A long-lived daemon accumulates finished
       * sessions the user will never look at again; each one holds its timeline,
       * every gate verdict, and its cached diff.
       */
      sweep(opts = { endedTtlMs: 60 * 60 * 1e3 }) {
        const now = opts.now ?? Date.now();
        let dropped = 0;
        for (const state of [...this.sessions.values()]) {
          trimGates(state);
          const finished = state.status === "ended";
          if (finished && now - (state.endedAt ?? state.updatedAt) > opts.endedTtlMs) {
            this.drop(state.sessionId);
            dropped++;
          }
        }
        const overflow = this.all().slice(MAX_SESSIONS);
        for (const state of overflow) {
          this.drop(state.sessionId);
          dropped++;
        }
        return dropped;
      }
      persistSoon(id) {
        const existing = this.persistTimers.get(id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.persistTimers.delete(id);
          this.persistNow(id);
        }, PERSIST_DEBOUNCE_MS);
        timer.unref?.();
        this.persistTimers.set(id, timer);
      }
      persistNow(id) {
        const state = this.sessions.get(id);
        if (!state) return;
        try {
          const dir = paths.sessionDir(id);
          mkdirSync2(dir, { recursive: true });
          const tmp = path2.join(dir, `.state.${process.pid}.tmp`);
          writeFileSync(tmp, JSON.stringify(state, null, 2));
          renameSync(tmp, path2.join(dir, "state.json"));
        } catch {
        }
      }
      persistAll() {
        for (const id of this.sessions.keys()) this.persistNow(id);
      }
      /* ---------------------------------------------------------------- *
       * Access
       * ---------------------------------------------------------------- */
      get(id) {
        return this.sessions.get(id);
      }
      /** Get or create. Sessions appear the moment any signal mentions them. */
      ensure(id, cwd) {
        let state = this.sessions.get(id);
        if (!state) {
          state = this.readSession(id) ?? newSession(id, cwd || process.cwd());
          this.sessions.set(id, state);
          mkdirSync2(paths.sessionDir(id), { recursive: true });
          this.emitEvent({ type: "snapshot", session: state });
          this.broadcastSessionList();
        } else if (cwd && state.cwd !== cwd && !state.repoRoot) {
          state.cwd = cwd;
        }
        return state;
      }
      all() {
        return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      }
      summaries() {
        return this.all().map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          cwd: s.cwd,
          // In a worktree `repoRoot` is the worktree itself, whose basename is the
          // branch. The switcher wants the repository it belongs to.
          repoName: repoNameOf(s),
          repoRoot: s.repoRoot,
          worktree: s.worktree?.name ?? null,
          branch: s.branch,
          stage: s.stage,
          status: s.status,
          updatedAt: s.updatedAt,
          openGates: s.gates.filter((g) => g.status === "open").length,
          pendingFeedback: s.pendingFeedback.length,
          tasks: {
            total: s.tasks.length,
            done: s.tasks.filter((t) => t.status === "done").length,
            blocked: s.tasks.filter((t) => t.status === "blocked").length
          }
        }));
      }
      /** Most recently updated session rooted at (or under) `cwd`. */
      findByCwd(cwd) {
        const normalized = path2.resolve(cwd);
        const matches = (value) => !!value && path2.resolve(value) === normalized;
        return this.all().find(
          (s) => matches(s.cwd) || matches(s.repoRoot) || // A session that moved into a worktree is anchored there, but the MCP
          // server it started with still reports the directory it was launched
          // in — so that has to keep resolving to the same session.
          matches(s.worktree?.originalCwd) || matches(s.worktree?.path)
        );
      }
      findByPid(pid) {
        return this.all().find((s) => s.claudePid === pid);
      }
      /* ---------------------------------------------------------------- *
       * Mutation
       * ---------------------------------------------------------------- */
      /** Apply a patch, persist, and push the delta to every connected client. */
      update(id, patch) {
        const state = this.sessions.get(id);
        if (!state) return void 0;
        Object.assign(state, patch);
        state.updatedAt = Date.now();
        this.persistSoon(id);
        this.emitEvent({ type: "state", sessionId: id, patch: { ...patch, updatedAt: state.updatedAt } });
        if (patch.stage || patch.status || patch.branch || patch.title) this.broadcastSessionList();
        return state;
      }
      /** Mutate in place with a callback, then broadcast the whole session. */
      mutate(id, fn) {
        const state = this.sessions.get(id);
        if (!state) return void 0;
        fn(state);
        state.updatedAt = Date.now();
        this.persistSoon(id);
        this.emitEvent({ type: "snapshot", session: state });
        this.broadcastSessionList();
        return state;
      }
      addTimeline(id, kind, text, opts = {}) {
        const state = this.sessions.get(id);
        if (!state) return void 0;
        const event = {
          id: randomUUID(),
          ts: Date.now(),
          kind,
          text,
          ...opts.label ? { label: opts.label } : {},
          ...opts.meta ? { meta: opts.meta } : {}
        };
        state.timeline.push(event);
        if (state.timeline.length > this.maxTimeline) {
          state.timeline.splice(0, state.timeline.length - this.maxTimeline);
        }
        state.updatedAt = event.ts;
        this.persistSoon(id);
        this.emitEvent({ type: "timeline", sessionId: id, events: [event] });
        return event;
      }
      addTimelineBatch(id, events, baseTs = Date.now()) {
        if (events.length === 0) return;
        const state = this.sessions.get(id);
        if (!state) return;
        const made = events.map((e, i) => ({ id: randomUUID(), ts: baseTs + i, ...e }));
        state.timeline.push(...made);
        if (state.timeline.length > this.maxTimeline) {
          state.timeline.splice(0, state.timeline.length - this.maxTimeline);
        }
        state.updatedAt = Date.now();
        this.persistSoon(id);
        this.emitEvent({ type: "timeline", sessionId: id, events: made });
      }
      setStage(id, stage, note) {
        const state = this.sessions.get(id);
        if (!state || state.stage === stage) {
          if (state && note) this.update(id, { stageNote: note });
          return;
        }
        this.update(id, { stage, stageNote: note });
        this.addTimeline(id, "stage", note ? `${stage} \u2014 ${note}` : stage, { label: stage });
      }
      /* ---------------------------------------------------------------- *
       * Gates
       * ---------------------------------------------------------------- */
      openGate(id, kind, prompt, meta) {
        const state = this.sessions.get(id);
        if (!state) return void 0;
        for (const g of state.gates) {
          if (g.status !== "open") continue;
          g.status = "cancelled";
          g.waiting = false;
          this.emit("gate:cancelled", { sessionId: id, gate: g });
        }
        const gate = {
          id: randomUUID(),
          kind,
          stage: state.stage,
          prompt,
          createdAt: Date.now(),
          status: "open",
          waiting: false,
          ...meta && Object.keys(meta).length ? { meta } : {}
        };
        state.gates.push(gate);
        trimGates(state);
        state.activeGateId = gate.id;
        state.updatedAt = gate.createdAt;
        this.persistSoon(id);
        this.addTimeline(id, "gate", prompt, { label: kind, meta: { gateId: gate.id } });
        this.emitEvent({ type: "state", sessionId: id, patch: { gates: state.gates, activeGateId: gate.id } });
        this.broadcastSessionList();
        return gate;
      }
      getGate(id, gateId) {
        return this.sessions.get(id)?.gates.find((g) => g.id === gateId);
      }
      activeGate(id) {
        const state = this.sessions.get(id);
        if (!state) return void 0;
        return state.gates.find((g) => g.id === state.activeGateId && g.status === "open");
      }
      resolveGate(id, gateId, result) {
        const state = this.sessions.get(id);
        const gate = state?.gates.find((g) => g.id === gateId);
        if (!state || !gate || gate.status !== "open") return void 0;
        gate.status = "resolved";
        gate.result = result;
        gate.waiting = false;
        if (state.activeGateId === gateId) state.activeGateId = null;
        if (result.threads?.length) {
          const byId = new Map(state.threads.map((t) => [t.id, t]));
          for (const t of result.threads) byId.set(t.id, t);
          state.threads = [...byId.values()];
        }
        if (result.steps && state.plan) {
          state.plan = { ...state.plan, steps: result.steps, revision: state.plan.revision + 1, updatedAt: Date.now() };
        }
        state.updatedAt = Date.now();
        this.persistSoon(id);
        this.addTimeline(id, "feedback", describeVerdict(result), {
          label: gate.kind,
          meta: { gateId, verdict: result.verdict }
        });
        this.emitEvent({ type: "snapshot", session: state });
        this.broadcastSessionList();
        this.emit("gate:resolved", { sessionId: id, gate });
        return gate;
      }
      /**
       * A gate the user has already answered but Claude has not yet been told
       * about. This happens whenever the user answers faster than the turn ends.
       */
      undeliveredGate(id) {
        return this.sessions.get(id)?.gates.find((g) => g.status === "resolved" && g.result && !g.deliveredAt);
      }
      markGateDelivered(id, gateId) {
        const gate = this.getGate(id, gateId);
        if (!gate || gate.deliveredAt) return gate;
        const now = Date.now();
        gate.deliveredAt = now;
        const state = this.sessions.get(id);
        if (state) {
          for (const delivered of gate.result?.threads ?? []) {
            const live = state.threads.find((t) => t.id === delivered.id);
            if (live && !live.deliveredAt) live.deliveredAt = now;
          }
          this.emitEvent({ type: "state", sessionId: id, patch: { gates: state.gates, threads: state.threads } });
        }
        this.persistSoon(id);
        return gate;
      }
      setGateWaiting(id, gateId, waiting) {
        const gate = this.getGate(id, gateId);
        if (!gate) return;
        gate.waiting = waiting;
        const state = this.sessions.get(id);
        if (state) {
          const status = waiting ? "waiting" : state.status === "waiting" ? "active" : state.status;
          this.update(id, { status, gates: state.gates });
        }
      }
      /* ---------------------------------------------------------------- *
       * Async feedback queue
       * ---------------------------------------------------------------- */
      queueFeedback(id, item) {
        const state = this.sessions.get(id);
        if (!state) return void 0;
        const full = { id: randomUUID(), createdAt: Date.now(), ...item };
        state.pendingFeedback.push(full);
        if (full.threads?.length) {
          const byId = new Map(state.threads.map((t) => [t.id, t]));
          for (const t of full.threads) byId.set(t.id, t);
          state.threads = [...byId.values()];
        }
        state.updatedAt = full.createdAt;
        this.persistSoon(id);
        this.addTimeline(id, "feedback", full.text, { label: full.origin });
        this.emitEvent({ type: "state", sessionId: id, patch: { pendingFeedback: state.pendingFeedback } });
        this.broadcastSessionList();
        this.emit("feedback:queued", { sessionId: id, item: full });
        return full;
      }
      /** Remove and return everything queued; called at a turn boundary. */
      drainFeedback(id) {
        const state = this.sessions.get(id);
        if (!state || state.pendingFeedback.length === 0) return [];
        const drained = state.pendingFeedback;
        state.pendingFeedback = [];
        const now = Date.now();
        for (const item of drained) {
          for (const t of item.threads ?? []) {
            const live = state.threads.find((x) => x.id === t.id);
            if (live) live.deliveredAt = now;
          }
        }
        state.updatedAt = now;
        this.persistSoon(id);
        this.emitEvent({ type: "state", sessionId: id, patch: { pendingFeedback: [], threads: state.threads } });
        this.broadcastSessionList();
        return drained;
      }
      /* ---------------------------------------------------------------- *
       * Diffs
       * ---------------------------------------------------------------- */
      setDiff(id, diff) {
        this.cacheDiff(id, diff);
        try {
          const dir = paths.sessionDir(id);
          mkdirSync2(dir, { recursive: true });
          const tmp = path2.join(dir, `.diff.${process.pid}.tmp`);
          writeFileSync(tmp, JSON.stringify(diff));
          renameSync(tmp, path2.join(dir, "diff.json"));
        } catch {
        }
        this.emitEvent({ type: "diff", sessionId: id, diff });
      }
      /**
       * Forget a session's diff, in memory and on disk.
       *
       * Used when the ground moves under a session — it relocates into or out of a
       * worktree — because the cached diff describes a tree it is no longer in.
       */
      clearDiff(id) {
        this.diffs.delete(id);
        try {
          rmSync(path2.join(paths.sessionDir(id), "diff.json"), { force: true });
        } catch {
        }
      }
      getDiff(id) {
        const cached = this.diffs.get(id);
        if (cached) {
          this.cacheDiff(id, cached);
          return cached;
        }
        try {
          const file = path2.join(paths.sessionDir(id), "diff.json");
          if (!existsSync2(file)) return void 0;
          const diff = JSON.parse(readFileSync2(file, "utf8"));
          this.cacheDiff(id, diff);
          return diff;
        } catch {
          return void 0;
        }
      }
      /** Append a reply to a review thread and tell every client. */
      addThreadReply(id, threadId, reply) {
        let updated;
        this.mutate(id, (s) => {
          const thread = s.threads.find((t) => t.id === threadId);
          if (!thread) return;
          thread.replies = [
            ...thread.replies ?? [],
            { id: randomUUID(), ts: Date.now(), author: reply.author, text: reply.text }
          ];
          updated = thread;
        });
        return updated;
      }
      setThreadResolved(id, threadId, resolved) {
        let updated;
        this.mutate(id, (s) => {
          const thread = s.threads.find((t) => t.id === threadId);
          if (!thread) return;
          thread.resolved = resolved;
          updated = thread;
        });
        return updated;
      }
      /**
       * Keep the diff cache bounded, evicting least-recently-used.
       *
       * Every entry is a fully parsed diff — up to `maxDiffFileBytes` per file —
       * and the previous behaviour kept one per session forever. Re-inserting
       * moves a key to the end of the Map's iteration order, which is the LRU
       * position we evict from the front of.
       */
      cacheDiff(id, diff) {
        this.diffs.delete(id);
        this.diffs.set(id, diff);
        while (this.diffs.size > MAX_CACHED_DIFFS) {
          const oldest = this.diffs.keys().next();
          if (oldest.done) break;
          this.diffs.delete(oldest.value);
        }
      }
      /* ---------------------------------------------------------------- *
       * Fan-out
       * ---------------------------------------------------------------- */
      emitEvent(event) {
        this.emit("event", event);
      }
      broadcastSessionList() {
        this.emitEvent({ type: "sessions", sessions: this.summaries() });
      }
    };
  }
});

// src/test/store.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync as rmSync2, existsSync as existsSync3 } from "node:fs";
import { tmpdir } from "node:os";
import path3 from "node:path";
var home;
before(() => {
  home = mkdtempSync(path3.join(tmpdir(), "cc-harness-test-"));
  process.env["CC_HARNESS_HOME"] = home;
});
after(() => rmSync2(home, { recursive: true, force: true }));
async function freshStore() {
  const { SessionStore: SessionStore2 } = await Promise.resolve().then(() => (init_store(), store_exports));
  return new SessionStore2();
}
test("gates: only one is open at a time", async () => {
  const store = await freshStore();
  store.ensure("s1", process.cwd());
  const first = store.openGate("s1", "plan", "Review the plan");
  const second = store.openGate("s1", "code_review", "Review the code");
  assert.equal(store.getGate("s1", first.id).status, "cancelled");
  assert.equal(store.activeGate("s1").id, second.id);
});
test("gates: resolving delivers the result and clears the active gate", async () => {
  const store = await freshStore();
  store.ensure("s2", process.cwd());
  const gate = store.openGate("s2", "plan", "Review the plan");
  const seen = [];
  store.on("gate:resolved", (payload) => seen.push(payload.gate.id));
  store.resolveGate("s2", gate.id, { verdict: "approved", resolvedAt: Date.now() });
  assert.deepEqual(seen, [gate.id]);
  assert.equal(store.get("s2").activeGateId, null);
  assert.equal(store.getGate("s2", gate.id).status, "resolved");
  assert.equal(store.resolveGate("s2", gate.id, { verdict: "approved", resolvedAt: 1 }), void 0);
});
test("feedback: drains exactly once", async () => {
  const store = await freshStore();
  store.ensure("s3", process.cwd());
  store.queueFeedback("s3", { text: "first", origin: "timeline" });
  store.queueFeedback("s3", { text: "second", origin: "diff" });
  const drained = store.drainFeedback("s3");
  assert.deepEqual(drained.map((f) => f.text), ["first", "second"]);
  assert.deepEqual(store.drainFeedback("s3"), []);
  assert.equal(store.get("s3").pendingFeedback.length, 0);
});
test("resolving a plan gate with edited steps updates the stored plan", async () => {
  const store = await freshStore();
  store.ensure("s4", process.cwd());
  store.mutate("s4", (s) => {
    s.plan = { title: "p", steps: [{ id: "a", title: "one" }], revision: 1, updatedAt: 0 };
  });
  const gate = store.openGate("s4", "plan", "Review");
  store.resolveGate("s4", gate.id, {
    verdict: "approved",
    resolvedAt: Date.now(),
    steps: [{ id: "a", title: "one, revised" }]
  });
  const plan = store.get("s4").plan;
  assert.equal(plan.steps[0].title, "one, revised");
  assert.equal(plan.revision, 2);
});
test("timeline is capped so a long session cannot grow without bound", async () => {
  const { SessionStore: SessionStore2 } = await Promise.resolve().then(() => (init_store(), store_exports));
  const store = new SessionStore2({ maxTimelineEvents: 10 });
  store.ensure("s5", process.cwd());
  for (let i = 0; i < 25; i++) store.addTimeline("s5", "note", `event ${i}`);
  const timeline = store.get("s5").timeline;
  assert.equal(timeline.length, 10);
  assert.equal(timeline[0].text, "event 15");
});
test("state survives a daemon restart", async () => {
  const store = await freshStore();
  store.ensure("s6", process.cwd());
  store.setStage("s6", "implementing", "building");
  store.openGate("s6", "code_review", "Review the code");
  store.persistNow("s6");
  const reloaded = await freshStore();
  const session = reloaded.get("s6");
  assert.ok(session, "session was reloaded from disk");
  assert.equal(session.stage, "implementing");
  assert.equal(session.gates.length, 1);
  assert.equal(session.gates[0].waiting, false, "a parked waiter does not survive a restart");
});
test("purge removes a session from memory and from disk", async () => {
  const store = await freshStore();
  store.ensure("s7", process.cwd());
  store.setStage("s7", "implementing", "building");
  store.persistNow("s7");
  assert.ok(existsSync3(path3.join(home, "sessions", "s7", "state.json")));
  assert.equal(store.purge("s7"), true);
  assert.equal(store.get("s7"), void 0);
  assert.ok(!existsSync3(path3.join(home, "sessions", "s7")), "the directory goes too");
  const revived = store.ensure("s7", process.cwd());
  assert.equal(revived.stage, "idle", "a purged session does not come back");
});
test("a purged session does not reappear after a restart", async () => {
  const store = await freshStore();
  store.ensure("s8", process.cwd());
  store.persistNow("s8");
  store.purge("s8");
  const reloaded = await freshStore();
  assert.equal(reloaded.get("s8"), void 0);
});
test("purge reports whether there was anything to delete", async () => {
  const store = await freshStore();
  assert.equal(store.purge("never-existed"), false);
});
test("drop is eviction, not deletion: the state stays on disk", async () => {
  const store = await freshStore();
  store.ensure("s9", process.cwd());
  store.setStage("s9", "planning", "thinking");
  store.drop("s9");
  assert.equal(store.get("s9"), void 0, "evicted from memory");
  const reloaded = await freshStore();
  assert.equal(reloaded.get("s9")?.stage, "planning", "but still recoverable");
});
//# sourceMappingURL=store.test.js.map
