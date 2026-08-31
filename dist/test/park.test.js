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
import path4 from "node:path";
import { mkdirSync, readFileSync, existsSync as existsSync2 } from "node:fs";
function harnessHome() {
  return process.env.CC_HARNESS_HOME || path4.join(homedir(), ".claude", "cc-harness");
}
function sanitizeId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}
function ensureHome() {
  const home2 = harnessHome();
  mkdirSync(home2, { recursive: true });
  mkdirSync(path4.join(home2, "sessions"), { recursive: true });
  return home2;
}
var paths;
var init_paths = __esm({
  "src/shared/paths.ts"() {
    "use strict";
    paths = {
      home: harnessHome,
      lockFile: () => path4.join(harnessHome(), "daemon.json"),
      logFile: () => path4.join(harnessHome(), "daemon.log"),
      sessionsDir: () => path4.join(harnessHome(), "sessions"),
      sessionDir: (id) => path4.join(harnessHome(), "sessions", sanitizeId(id)),
      sessionState: (id) => path4.join(harnessHome(), "sessions", sanitizeId(id), "state.json"),
      sessionEvents: (id) => path4.join(harnessHome(), "sessions", sanitizeId(id), "events.jsonl"),
      configDir: harnessHome,
      instructionsDir: () => path4.join(harnessHome(), "instructions")
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
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync, readdirSync, existsSync as existsSync3, renameSync, rmSync, statSync as statSync2 } from "node:fs";
import path5 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
function newSession(sessionId, cwd2) {
  const now = Date.now();
  return {
    sessionId,
    cwd: cwd2,
    repoRoot: null,
    worktree: null,
    branch: null,
    transcriptPath: null,
    title: path5.basename(cwd2) || sessionId.slice(0, 8),
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
  return root ? path5.basename(root) : null;
}
function mtimeOf(dir) {
  try {
    return statSync2(dir).mtimeMs;
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
        if (!existsSync3(dir)) return;
        const loaded = [];
        const expired = [];
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const sessionDir = path5.join(dir, entry.name);
          const file = path5.join(sessionDir, "state.json");
          if (!existsSync3(file)) {
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
          if (!existsSync3(file)) return void 0;
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
          const tmp = path5.join(dir, `.state.${process.pid}.tmp`);
          writeFileSync(tmp, JSON.stringify(state, null, 2));
          renameSync(tmp, path5.join(dir, "state.json"));
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
      ensure(id, cwd2) {
        let state = this.sessions.get(id);
        if (!state) {
          state = this.readSession(id) ?? newSession(id, cwd2 || process.cwd());
          this.sessions.set(id, state);
          mkdirSync2(paths.sessionDir(id), { recursive: true });
          this.emitEvent({ type: "snapshot", session: state });
          this.broadcastSessionList();
        } else if (cwd2 && state.cwd !== cwd2 && !state.repoRoot) {
          state.cwd = cwd2;
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
      findByCwd(cwd2) {
        const normalized = path5.resolve(cwd2);
        const matches = (value) => !!value && path5.resolve(value) === normalized;
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
          id: randomUUID2(),
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
        const made = events.map((e, i) => ({ id: randomUUID2(), ts: baseTs + i, ...e }));
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
          id: randomUUID2(),
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
       * Close an open gate without a verdict.
       *
       * This is what "send now" does: the user has decided the question the gate
       * was asking is no longer the thing to answer, so anything parked on it is
       * released and the session is free to act on the message instead. The gate
       * is kept in the list as `cancelled` rather than deleted, so the UI can
       * still say what was skipped and when.
       */
      cancelGate(id, gateId, reason) {
        const state = this.sessions.get(id);
        const gate = state?.gates.find((g) => g.id === gateId);
        if (!state || !gate || gate.status !== "open") return void 0;
        gate.status = "cancelled";
        gate.waiting = false;
        if (state.activeGateId === gateId) state.activeGateId = null;
        state.updatedAt = Date.now();
        this.persistSoon(id);
        this.addTimeline(id, "gate", reason ?? `The user skipped the ${gate.kind.replace("_", " ")} gate.`, {
          label: gate.kind,
          meta: { gateId, cancelled: true }
        });
        this.emitEvent({ type: "state", sessionId: id, patch: { gates: state.gates, activeGateId: null } });
        this.broadcastSessionList();
        this.emit("gate:cancelled", { sessionId: id, gate });
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
        const full = { id: randomUUID2(), createdAt: Date.now(), ...item };
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
          const tmp = path5.join(dir, `.diff.${process.pid}.tmp`);
          writeFileSync(tmp, JSON.stringify(diff));
          renameSync(tmp, path5.join(dir, "diff.json"));
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
          rmSync(path5.join(paths.sessionDir(id), "diff.json"), { force: true });
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
          const file = path5.join(paths.sessionDir(id), "diff.json");
          if (!existsSync3(file)) return void 0;
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
            { id: randomUUID2(), ts: Date.now(), author: reply.author, text: reply.text }
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

// src/test/park.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync as rmSync2 } from "node:fs";
import { tmpdir } from "node:os";
import path6 from "node:path";

// src/shared/config.ts
var DEFAULT_CONFIG = {
  autoOpen: false,
  maxTimelineEvents: 500,
  stopHoldSeconds: 540,
  awaitSeconds: 120,
  gateHoldRounds: 4,
  holdIdleSessions: false,
  maxDiffFileBytes: 4e5,
  idleShutdownMinutes: 120,
  stages: {
    verification: { checks: [] }
  },
  ship: {
    steps: ["checks", "commit", "push", "pr", "summary"],
    provider: "gh",
    providers: {
      gh: {
        kind: "command",
        label: "GitHub (gh CLI)",
        command: "gh pr create --base {{base}} --head {{branch}} --title {{title}} --body-file {{bodyFile}}"
      },
      bitbucket: {
        kind: "mcp",
        label: "Bitbucket (MCP)",
        directive: "Open a pull request using the connected Bitbucket MCP server. Use the title and body below verbatim, source branch {{branch}}, destination branch {{base}}. Report the resulting PR URL back with harness_note."
      },
      none: { kind: "none", label: "No PR \u2014 commit and push only" }
    },
    summaryPath: "docs/reviews/{{branch}}.md",
    commitTemplate: "{{title}}\n\n{{body}}"
  }
};

// src/daemon/hookIngest.ts
import { randomUUID } from "node:crypto";
import path3 from "node:path";

// src/daemon/transcript.ts
import { createReadStream as createReadStream2, existsSync, statSync, watch } from "node:fs";

// src/daemon/worktree.ts
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
var WorktreeResolver = class {
  resolved = null;
  context = null;
  /** The worktree the session is in as of the last entry fed in. */
  get current() {
    return this.resolved;
  }
  /** Feed one transcript entry. True when the resolved worktree changed. */
  consume(entry) {
    const before2 = this.resolved?.path ?? null;
    switch (entry["type"]) {
      case "worktree-state": {
        const record = parseWorktreeSession(entry["worktreeSession"]);
        this.context = record;
        this.resolved = record;
        break;
      }
      case "relocated": {
        const to = asPath(entry["relocatedCwd"]);
        if (!to) break;
        if (this.context && to === this.context.originalCwd) {
          this.resolved = null;
          break;
        }
        this.resolved = this.context && this.context.path === to ? this.context : {
          path: to,
          name: path.basename(to),
          originalCwd: null,
          originalBranch: null,
          originalHeadCommit: null
        };
        break;
      }
      default:
        return false;
    }
    return (this.resolved?.path ?? null) !== before2;
  }
};
async function scanTranscriptForWorktree(file) {
  const resolver = new WorktreeResolver();
  try {
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"relocated') && !line.includes('"worktree-state"')) continue;
        try {
          resolver.consume(JSON.parse(line));
        } catch {
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  } catch {
    return null;
  }
  return resolver.current;
}
function parseWorktreeSession(value) {
  if (!value || typeof value !== "object") return null;
  const rec = value;
  const worktreePath = asPath(rec["worktreePath"]);
  if (!worktreePath) return null;
  return {
    path: worktreePath,
    name: asString(rec["worktreeName"]) ?? path.basename(worktreePath),
    originalCwd: asPath(rec["originalCwd"]) ?? asPath(rec["preEnterOriginalCwd"]),
    originalBranch: asString(rec["originalBranch"]),
    originalHeadCommit: asString(rec["originalHeadCommit"])
  };
}
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asPath(value) {
  const str = asString(value);
  return str && path.isAbsolute(str) ? path.normalize(str) : null;
}

// src/daemon/transcript.ts
var MAX_TEXT = 4e3;
var MAX_THINKING = 600;
var POLL_MS = 700;
var MAX_CARRY = 4 * 1024 * 1024;
var TranscriptTailer = class {
  constructor(file, onUpdate) {
    this.file = file;
    this.onUpdate = onUpdate;
  }
  offset = 0;
  carry = "";
  watcher = null;
  poller = null;
  reading = false;
  pending = false;
  closed = false;
  worktree = new WorktreeResolver();
  /**
   * Start tailing. `fromStart` replays the whole file, which is what a fresh
   * daemon needs when it attaches to a session already in progress.
   *
   * The file usually does not exist yet at `SessionStart` — the CLI writes it
   * once the first message lands — so this waits for it rather than giving up.
   * Polling backs up `fs.watch` because watches are unreliable across
   * rotation, network filesystems and WSL.
   */
  start(fromStart = false) {
    if (!fromStart && existsSync(this.file)) {
      try {
        this.offset = statSync(this.file).size;
      } catch {
        this.offset = 0;
      }
    }
    this.poller = setInterval(() => this.tick(), POLL_MS);
    this.poller.unref?.();
    this.tick();
  }
  /** One poll: attach a watcher once the file appears, then read. */
  tick() {
    if (this.closed) return;
    if (!this.watcher && existsSync(this.file)) {
      try {
        this.watcher = watch(this.file, { persistent: false }, () => this.scheduleRead());
      } catch {
      }
    }
    this.scheduleRead();
  }
  /** Idempotent: releases the watch descriptor and the poll interval. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending = false;
    this.carry = "";
    try {
      this.watcher?.close();
    } catch {
    }
    this.watcher = null;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }
  scheduleRead() {
    if (this.closed) return;
    if (this.reading) {
      this.pending = true;
      return;
    }
    void this.read();
  }
  async read() {
    if (this.closed) return;
    this.reading = true;
    try {
      let size = 0;
      try {
        size = statSync(this.file).size;
      } catch {
        return;
      }
      if (size < this.offset) {
        this.offset = 0;
        this.carry = "";
      }
      if (size === this.offset) return;
      const chunk = await readRange(this.file, this.offset, size - 1);
      this.offset = size;
      const text = this.carry + chunk;
      const lines = text.split("\n");
      this.carry = lines.pop() ?? "";
      if (this.carry.length > MAX_CARRY) {
        this.carry = "";
      }
      const update = { events: [] };
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.consume(JSON.parse(line), update);
        } catch {
        }
      }
      if (this.closed) return;
      if (update.events.length > 0 || update.title || update.usage || "worktree" in update) {
        this.onUpdate(update);
      }
    } finally {
      this.reading = false;
      if (this.pending && !this.closed) {
        this.pending = false;
        this.scheduleRead();
      }
    }
  }
  consume(entry, update) {
    const type = entry["type"];
    if (type === "worktree-state" || type === "relocated") {
      if (this.worktree.consume(entry)) update.worktree = this.worktree.current;
      return;
    }
    if (type === "ai-title") {
      const title = firstString(entry["title"], entry["text"], entry["value"]);
      if (title) update.title = title;
      return;
    }
    if (type === "assistant") {
      const message = entry["message"];
      const usage = message?.usage;
      if (usage) {
        const input = num(usage["input_tokens"]) + num(usage["cache_read_input_tokens"]) + num(usage["cache_creation_input_tokens"]);
        const output = num(usage["output_tokens"]);
        if (input || output) {
          update.usage ??= { inputTokens: 0, outputTokens: 0 };
          update.usage.inputTokens += input;
          update.usage.outputTokens += output;
        }
      }
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const raw of content) {
        const block = raw;
        switch (block["blockType"] ?? block["type"]) {
          case "text": {
            const text = String(block["text"] ?? "").trim();
            if (text) update.events.push({ kind: "assistant", text: truncate(text, MAX_TEXT) });
            break;
          }
          case "thinking": {
            const text = String(block["thinking"] ?? block["text"] ?? "").trim();
            if (text) update.events.push({ kind: "thinking", text: truncate(text, MAX_THINKING) });
            break;
          }
          case "tool_use": {
            const name = String(block["name"] ?? "tool");
            const input = block["input"] ?? {};
            update.events.push({
              kind: "tool",
              label: name,
              text: describeToolInput(name, input),
              meta: { tool: name }
            });
            break;
          }
        }
      }
      return;
    }
    if (type === "user" && entry["isSidechain"] !== true) {
      const origin = entry["origin"];
      if (origin?.kind !== "human") return;
      const message = entry["message"];
      const text = extractUserText(message?.content);
      if (text) update.events.push({ kind: "user", text: truncate(text, MAX_TEXT) });
      return;
    }
    if (type === "system") {
      const text = firstString(entry["content"], entry["text"]);
      if (text) update.events.push({ kind: "note", text: truncate(text, 500) });
    }
  }
};
function extractUserText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const raw of content) {
    const block = raw;
    if (block["type"] !== "text") continue;
    const text = String(block["text"] ?? "");
    if (/^<(ide_|system-reminder|local-command)/.test(text.trim())) continue;
    parts.push(text);
  }
  return parts.join("\n").trim();
}
function describeToolInput(name, input) {
  const str = (k) => {
    const v = input[k];
    return typeof v === "string" ? v : void 0;
  };
  switch (name) {
    case "Bash":
      return truncate(str("command") ?? "", 240);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return str("file_path") ?? str("notebook_path") ?? "";
    case "Grep":
      return `${str("pattern") ?? ""}${str("path") ? ` in ${str("path")}` : ""}`;
    case "Glob":
      return str("pattern") ?? "";
    case "Task":
    case "Agent":
      return str("description") ?? str("prompt")?.slice(0, 120) ?? "";
    case "Skill":
      return str("skill") ?? "";
    case "WebFetch":
      return str("url") ?? "";
    case "TodoWrite":
      return "updated the task list";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return truncate(first ?? "", 160);
    }
  }
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function firstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return void 0;
}
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\u2026`;
}
function readRange(file, start, end) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const stream = createReadStream2(file, { start, end, encoding: "utf8" });
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(out);
    };
    stream.on("data", (c) => {
      out += c;
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}

// src/daemon/gates.ts
function waitForResume(store2, sessionId, gateId, opts) {
  const existing = store2.getGate(sessionId, gateId);
  if (existing && existing.status !== "open") {
    return Promise.resolve({ kind: "gate", gate: existing });
  }
  const session = store2.get(sessionId);
  if (session && session.pendingFeedback.length > 0) {
    return Promise.resolve({ kind: "feedback", items: store2.drainFeedback(sessionId) });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      store2.off("gate:resolved", onGate);
      store2.off("gate:cancelled", onGate);
      store2.off("feedback:queued", onQueued);
      opts.signal?.removeEventListener("abort", onAbort);
      store2.setGateWaiting(sessionId, gateId, false);
      resolve(value);
    };
    const onGate = (payload) => {
      if (payload.sessionId !== sessionId || payload.gate.id !== gateId) return;
      finish({ kind: "gate", gate: payload.gate });
    };
    const onQueued = (payload) => {
      if (payload.sessionId !== sessionId) return;
      finish({ kind: "feedback", items: store2.drainFeedback(sessionId) });
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    timer.unref?.();
    store2.on("gate:resolved", onGate);
    store2.on("gate:cancelled", onGate);
    store2.on("feedback:queued", onQueued);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    store2.setGateWaiting(sessionId, gateId, true);
  });
}
function waitForFeedback(store2, sessionId, opts) {
  const session = store2.get(sessionId);
  if (session && session.pendingFeedback.length > 0) {
    return Promise.resolve(store2.drainFeedback(sessionId));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      store2.off("feedback:queued", onQueued);
      store2.off("gate:resolved", onGate);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onQueued = (payload) => {
      if (payload.sessionId !== sessionId) return;
      finish(store2.drainFeedback(sessionId));
    };
    const onGate = (payload) => {
      if (payload.sessionId !== sessionId) return;
      finish(gateAsFeedback(payload.gate));
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    timer.unref?.();
    store2.on("feedback:queued", onQueued);
    store2.on("gate:resolved", onGate);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function gateAsFeedback(gate) {
  const result = gate.result;
  if (!result) return [];
  return [
    {
      id: gate.id,
      createdAt: result.resolvedAt,
      origin: gate.kind === "code_review" ? "diff" : gate.kind === "plan" ? "plan" : "timeline",
      text: result.comment ?? `Gate ${gate.kind}: ${result.verdict}`,
      ...result.threads?.length ? { threads: result.threads } : {}
    }
  ];
}
function renderFeedback(items) {
  if (items.length === 0) return "";
  const skipped = items.find((item) => item.skippedGate)?.skippedGate;
  const parts = [
    skipped ? `[cc-harness] The user skipped the ${skipped.kind.replace("_", " ")} gate ("${skipped.prompt}") and sent this message instead. That gate is closed \u2014 do not wait on it:` : "[cc-harness] The user submitted feedback in the review UI:"
  ];
  for (const item of items) {
    if (item.text) parts.push(`
${item.text}`);
    for (const thread of item.threads ?? []) {
      parts.push(renderThread(thread));
    }
  }
  if (skipped) {
    parts.push(
      "\nAct on the message above instead of the step you were waiting on. Publish a new gate when you reach the next point that needs the user."
    );
    return parts.join("\n");
  }
  parts.push(
    "\nAddress each comment, then reply to it with harness_reply({ thread_id, text }) saying what you changed or why you disagree. When they are all answered, call harness_publish_diff again so the user can re-review."
  );
  return parts.join("\n");
}
function renderThread(thread) {
  const range = thread.startLine === thread.endLine ? `${thread.startLine}` : `${thread.startLine}-${thread.endLine}`;
  const lines = [`
\u2022 [${thread.id}] ${thread.file}:${range} (${thread.side === "old" ? "before" : "after"})`];
  if (thread.excerpt) {
    lines.push("  ```");
    for (const l of thread.excerpt.split("\n")) lines.push(`  ${l}`);
    lines.push("  ```");
  }
  lines.push(`  \u2192 ${thread.body}`);
  return lines.join("\n");
}
function renderGateResult(gate) {
  const result = gate.result;
  if (!result) return `[cc-harness] Gate ${gate.kind} is still open.`;
  const header = {
    approved: "approved",
    changes_requested: "requested changes",
    rejected: "rejected this",
    answered: "answered"
  };
  const parts = [`[cc-harness] The user ${header[result.verdict] ?? result.verdict} at the ${gate.kind} gate.`];
  if (result.comment) parts.push(`
${result.comment}`);
  if (result.steps?.length) {
    const edited = result.steps.filter((s) => s.comment || s.status === "dropped");
    if (edited.length) {
      parts.push("\nPlan changes:");
      for (const step of edited) {
        if (step.status === "dropped") parts.push(`\u2022 DROP \u2014 ${step.title}`);
        else parts.push(`\u2022 ${step.title}
  \u2192 ${step.comment}`);
      }
    }
    parts.push(`
Approved plan (${result.steps.filter((s) => s.status !== "dropped").length} steps):`);
    for (const [i, step] of result.steps.filter((s) => s.status !== "dropped").entries()) {
      parts.push(`${i + 1}. ${step.title}${step.detail ? ` \u2014 ${step.detail}` : ""}`);
    }
  }
  for (const thread of result.threads ?? []) parts.push(renderThread(thread));
  if (result.ship) {
    const ship = result.ship;
    parts.push(
      `
Ship: provider=${ship.provider} steps=${ship.steps.join(" \u2192 ")}${ship.branch ? ` branch=${ship.branch}` : ""}${ship.baseBranch ? ` base=${ship.baseBranch}` : ""}`
    );
    if (ship.outcome) {
      parts.push(ship.outcome.ok ? `Result: ${ship.outcome.output}` : `FAILED: ${ship.outcome.output}`);
      if (ship.outcome.url) parts.push(`URL: ${ship.outcome.url}`);
    }
    if (ship.directive) {
      parts.push(
        `
ACTION REQUIRED \u2014 the user chose an MCP-backed provider, so you must open the pull request yourself:`,
        ship.directive,
        `
Title (use verbatim):
${ship.title}`,
        `
Body (use verbatim):
${ship.body}`,
        `
Then report the resulting URL with harness_note.`
      );
    }
  }
  if (result.verdict === "approved") {
    parts.push("\nProceed with the next stage.");
  } else if (result.verdict === "changes_requested") {
    parts.push(
      result.threads?.length ? "\nAddress each comment above, then reply to it with harness_reply({ thread_id, text })." : "\nAddress the feedback above before moving on."
    );
  } else if (result.verdict === "rejected") {
    parts.push("\nStop and wait for further direction from the user.");
  }
  return parts.join("\n");
}

// src/daemon/git.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path2 from "node:path";
var exec = promisify(execFile);
var MAX_BUFFER = 32 * 1024 * 1024;
async function git(cwd2, args, timeout = 2e4) {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd: cwd2, timeout, maxBuffer: MAX_BUFFER });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err) {
    const e = err;
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      code: typeof e.code === "number" ? e.code : 1
    };
  }
}
async function repoRoot(cwd2) {
  const res = await git(cwd2, ["rev-parse", "--show-toplevel"]);
  return res.ok ? res.stdout.trim() || null : null;
}
async function mainWorktreeRoot(cwd2) {
  const res = await git(cwd2, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const dir = res.stdout.trim();
  if (!res.ok || !dir) return null;
  const base = path2.basename(dir);
  return base === ".git" ? path2.dirname(dir) : null;
}
async function currentBranch(cwd2) {
  const res = await git(cwd2, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = res.stdout.trim();
  return res.ok && name && name !== "HEAD" ? name : null;
}
async function headCommit(cwd2) {
  const res = await git(cwd2, ["rev-parse", "HEAD"]);
  return res.ok ? res.stdout.trim() || null : null;
}
function isFilePath(entry) {
  return !entry.endsWith("/");
}
async function workingTreeFingerprints(cwd2) {
  const status = await git(cwd2, ["status", "--porcelain", "-z"]);
  if (!status.ok) return {};
  const paths2 = [];
  const entries = status.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (isFilePath(file)) paths2.push(file);
    if (code[0] === "R" || code[1] === "R") i++;
  }
  if (paths2.length === 0) return {};
  const out = {};
  const hashed = await git(cwd2, ["hash-object", "--", ...paths2]);
  const hashes = hashed.stdout.split("\n").filter(Boolean);
  if (hashes.length === paths2.length) {
    paths2.forEach((file, i) => {
      out[file] = hashes[i];
    });
    return out;
  }
  for (const file of paths2) {
    const one = await git(cwd2, ["hash-object", "--", file]);
    out[file] = one.ok && one.stdout.trim() || "absent";
  }
  return out;
}
function changedBetween(before2, after2) {
  const paths2 = /* @__PURE__ */ new Set([...Object.keys(before2), ...Object.keys(after2)]);
  return [...paths2].filter((p) => before2[p] !== after2[p]).sort();
}

// src/daemon/tasks.ts
async function reconcileFiles(store2, sessionId) {
  const session = store2.get(sessionId);
  if (!session) return;
  const cwd2 = session.repoRoot ?? session.cwd;
  let after2;
  try {
    after2 = await workingTreeFingerprints(cwd2);
  } catch {
    return;
  }
  const active = session.tasks.find((t) => t.status === "in_progress");
  const baseline = baselines.get(sessionId);
  if (baseline && baseline.taskId) {
    const changed = changedBetween(baseline.fingerprints, after2);
    if (changed.length) {
      store2.mutate(sessionId, (s) => {
        const task = s.tasks.find((t) => t.id === baseline.taskId);
        if (!task) return;
        for (const file of changed) {
          if (!task.files.includes(file)) task.files.push(file);
        }
        task.updatedAt = Date.now();
      });
      const updated = store2.get(sessionId);
      if (updated) store2.emitEvent({ type: "tasks", sessionId, tasks: updated.tasks });
    }
  }
  baselines.set(sessionId, { taskId: active?.id ?? null, fingerprints: after2 });
}
var baselines = /* @__PURE__ */ new Map();
function clearBaseline(sessionId) {
  baselines.delete(sessionId);
}
function attributeFile(store2, sessionId, relPath) {
  const session = store2.get(sessionId);
  if (!session) return;
  const active = session.tasks.find((t) => t.status === "in_progress");
  if (!active || active.files.includes(relPath)) return;
  store2.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.id === active.id);
    if (task && !task.files.includes(relPath)) {
      task.files.push(relPath);
      task.updatedAt = Date.now();
    }
  });
  const updated = store2.get(sessionId);
  if (updated) store2.emitEvent({ type: "tasks", sessionId, tasks: updated.tasks });
}

// src/shared/hooks.ts
function stopBlock(reason) {
  return {
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "Stop",
      decision: "block",
      reason,
      additionalContext: reason
    }
  };
}
function additionalContext(event, text) {
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text
    }
  };
}
var HOOK_NOOP = { suppressOutput: true };

// src/daemon/hookIngest.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
var MAX_COMMANDS = 200;
var MAX_TOUCHED_FILES = 500;
var holds = /* @__PURE__ */ new Map();
var worktreeScanned = /* @__PURE__ */ new Set();
var MAX_SCANNED = 500;
async function ingestHook(event, input, ctx) {
  const sessionId = input.session_id;
  if (!sessionId) return HOOK_NOOP;
  switch (event) {
    case "SessionStart":
      return onSessionStart(sessionId, input, ctx);
    case "SessionEnd":
      return onSessionEnd(sessionId, input, ctx);
    case "UserPromptSubmit":
      return onUserPromptSubmit(sessionId, input, ctx);
    case "PostToolUse":
      return onPostToolUse(sessionId, input, ctx);
    case "PostToolUseFailure":
      return onPostToolUseFailure(sessionId, input, ctx);
    case "Notification":
      return onNotification(sessionId, input, ctx);
    case "Stop":
      return onStop(sessionId, input, ctx);
    default:
      ctx.store.ensure(sessionId, input.cwd);
      return HOOK_NOOP;
  }
}
async function onSessionStart(sessionId, input, ctx) {
  const launchedIn = input.cwd || process.cwd();
  const session = ctx.store.ensure(sessionId, launchedIn);
  const cwd2 = session.worktree?.path ?? launchedIn;
  const root = await repoRoot(cwd2);
  const [branch, head] = await Promise.all([
    currentBranch(root ?? cwd2),
    headCommit(root ?? cwd2)
  ]);
  const named = session.worktree?.mainRoot ?? root ?? cwd2;
  ctx.store.update(sessionId, {
    cwd: cwd2,
    repoRoot: root,
    branch,
    // Preserve the original start commit across resume/compact restarts.
    startCommit: session.startCommit ?? head,
    transcriptPath: input.transcript_path ?? session.transcriptPath,
    status: "active",
    title: session.title === sessionId.slice(0, 8) ? path3.basename(named) : session.title,
    ...input.start_reason === "clear" ? { stage: "idle" } : {}
  });
  await resolveWorktree(sessionId, ctx);
  attachTailer(sessionId, ctx, input.start_reason === "resume");
  ctx.store.addTimeline(sessionId, "note", `Session ${input.start_reason ?? "started"}`, {
    label: "session"
  });
  return HOOK_NOOP;
}
async function onSessionEnd(sessionId, input, ctx) {
  ctx.tailers.get(sessionId)?.close();
  ctx.tailers.delete(sessionId);
  worktreeScanned.delete(sessionId);
  holds.delete(sessionId);
  clearBaseline(sessionId);
  ctx.store.update(sessionId, { status: "ended", endedAt: Date.now() });
  ctx.store.addTimeline(sessionId, "note", `Session ended (${input.end_reason ?? "unknown"})`, {
    label: "session"
  });
  ctx.store.persistNow(sessionId);
  return HOOK_NOOP;
}
async function onUserPromptSubmit(sessionId, input, ctx) {
  const session = ctx.store.ensure(sessionId, input.cwd);
  ctx.store.update(sessionId, {
    status: "active",
    transcriptPath: input.transcript_path ?? session.transcriptPath,
    stats: { ...session.stats, turns: session.stats.turns + 1 }
  });
  attachTailer(sessionId, ctx);
  const drained = ctx.store.drainFeedback(sessionId);
  const answered = ctx.store.undeliveredGate(sessionId);
  if (answered) ctx.store.markGateDelivered(sessionId, answered.id);
  const text = [
    answered ? renderGateResult(answered) : "",
    drained.length > 0 ? renderFeedback(drained) : ""
  ].filter(Boolean).join("\n\n");
  if (text) return additionalContext("UserPromptSubmit", text);
  return HOOK_NOOP;
}
async function onPostToolUse(sessionId, input, ctx) {
  const session = ctx.store.ensure(sessionId, input.cwd);
  const tool = input.tool_name ?? "tool";
  const toolInput = input.tool_input ?? {};
  let touched = null;
  ctx.store.mutate(sessionId, (s) => {
    s.stats.toolCalls++;
    if (tool === "TodoWrite") {
      const todos = normalizeTodos(toolInput["todos"]);
      if (todos) s.todos = todos;
      return;
    }
    if (EDIT_TOOLS.has(tool)) {
      const file = typeof toolInput["file_path"] === "string" ? toolInput["file_path"] : typeof toolInput["notebook_path"] === "string" ? toolInput["notebook_path"] : null;
      if (file) {
        const rel = s.repoRoot ? relativeWithin(s.repoRoot, file) : file;
        const existing = s.files.find((f) => f.path === rel);
        const now = Date.now();
        if (existing) {
          existing.edits++;
          existing.lastTouchedAt = now;
          if (!existing.tools.includes(tool)) existing.tools.push(tool);
        } else {
          s.files.push({ path: rel, edits: 1, firstTouchedAt: now, lastTouchedAt: now, tools: [tool] });
          if (s.files.length > MAX_TOUCHED_FILES) s.files.splice(0, s.files.length - MAX_TOUCHED_FILES);
        }
        s.stats.edits++;
        touched = rel;
      }
      return;
    }
    if (tool === "Bash") {
      const command = typeof toolInput["command"] === "string" ? toolInput["command"] : "";
      if (!command) return;
      s.commands.push({
        id: randomUUID(),
        command,
        description: typeof toolInput["description"] === "string" ? toolInput["description"] : void 0,
        startedAt: Date.now(),
        ok: true,
        preview: previewOutput(input.tool_output ?? input.tool_response)
      });
      if (s.commands.length > MAX_COMMANDS) s.commands.splice(0, s.commands.length - MAX_COMMANDS);
    }
  });
  if (touched) attributeFile(ctx.store, sessionId, touched);
  return HOOK_NOOP;
}
async function onPostToolUseFailure(sessionId, input, ctx) {
  ctx.store.ensure(sessionId, input.cwd);
  const tool = input.tool_name ?? "tool";
  const toolInput = input.tool_input ?? {};
  if (tool === "Bash" && typeof toolInput["command"] === "string") {
    ctx.store.mutate(sessionId, (s) => {
      s.commands.push({
        id: randomUUID(),
        command: toolInput["command"],
        startedAt: Date.now(),
        ok: false,
        preview: (input.error ?? "").slice(0, 400)
      });
      if (s.commands.length > MAX_COMMANDS) s.commands.splice(0, s.commands.length - MAX_COMMANDS);
    });
  }
  ctx.store.addTimeline(sessionId, "error", `${tool} failed: ${(input.error ?? "").slice(0, 300)}`, {
    label: tool
  });
  return HOOK_NOOP;
}
async function onNotification(sessionId, input, ctx) {
  ctx.store.ensure(sessionId, input.cwd);
  const kind = input.notification_type ?? "notification";
  const text = input.message ?? summarizeNotification(input);
  ctx.store.addTimeline(sessionId, "notification", text, { label: kind });
  if (kind === "idle_prompt") {
    ctx.store.update(sessionId, { status: "idle" });
  }
  return HOOK_NOOP;
}
async function onStop(sessionId, input, ctx) {
  const session = ctx.store.ensure(sessionId, input.cwd);
  attachTailer(sessionId, ctx);
  if (session.tasks.some((t) => t.status === "in_progress")) {
    await reconcileFiles(ctx.store, sessionId).catch(() => {
    });
  }
  const drained = ctx.store.drainFeedback(sessionId);
  if (drained.length > 0) {
    holds.delete(sessionId);
    const open = ctx.store.activeGate(sessionId);
    ctx.store.update(sessionId, { status: "active" });
    return stopBlock(renderFeedback(drained) + (open ? stillParked(open.kind) : ""));
  }
  const answered = ctx.store.undeliveredGate(sessionId);
  if (answered) {
    holds.delete(sessionId);
    ctx.store.markGateDelivered(sessionId, answered.id);
    ctx.store.update(sessionId, { status: "active" });
    return stopBlock(renderGateResult(answered));
  }
  const gate = ctx.store.activeGate(sessionId);
  if (input.stop_hook_active && !gate) {
    holds.delete(sessionId);
    ctx.store.update(sessionId, { status: "idle" });
    return HOOK_NOOP;
  }
  if (!gate) {
    if (ctx.config.holdIdleSessions && session.stage !== "idle" && !input.stop_hook_active) {
      ctx.store.update(sessionId, { status: "waiting" });
      const late = await waitForFeedback(ctx.store, sessionId, {
        timeoutMs: ctx.config.stopHoldSeconds * 1e3,
        ...ctx.signal ? { signal: ctx.signal } : {}
      });
      if (late?.length) {
        ctx.store.update(sessionId, { status: "active" });
        return stopBlock(renderFeedback(late));
      }
    }
    holds.delete(sessionId);
    ctx.store.update(sessionId, { status: "idle" });
    return HOOK_NOOP;
  }
  ctx.store.update(sessionId, { status: "waiting" });
  const signal = await waitForResume(ctx.store, sessionId, gate.id, {
    timeoutMs: ctx.config.stopHoldSeconds * 1e3,
    ...ctx.signal ? { signal: ctx.signal } : {}
  });
  if (signal?.kind === "gate") {
    holds.delete(sessionId);
    if (signal.gate.result) {
      ctx.store.markGateDelivered(sessionId, gate.id);
      ctx.store.update(sessionId, { status: "active" });
      return stopBlock(renderGateResult(signal.gate));
    }
    const queued = ctx.store.drainFeedback(sessionId);
    if (queued.length > 0) {
      ctx.store.update(sessionId, { status: "active" });
      return stopBlock(renderFeedback(queued));
    }
    const current = ctx.store.activeGate(sessionId);
    if (current) {
      ctx.store.update(sessionId, { status: "waiting" });
      return stopBlock(
        `[cc-harness] The "${gate.kind}" gate was replaced by a newer "${current.kind}" gate. End your turn again \u2014 the harness parks on that one and resumes you with its verdict.`
      );
    }
    ctx.store.update(sessionId, { status: "idle" });
    return HOOK_NOOP;
  }
  if (signal?.kind === "feedback" && signal.items.length > 0) {
    holds.delete(sessionId);
    ctx.store.update(sessionId, { status: "active" });
    const skipped = signal.items.some((item) => item.skippedGate);
    return stopBlock(renderFeedback(signal.items) + (skipped ? "" : stillParked(gate.kind)));
  }
  const round = (holds.get(sessionId)?.gateId === gate.id ? holds.get(sessionId).rounds : 0) + 1;
  const limit = ctx.config.gateHoldRounds;
  if (limit > 0 && round > limit) {
    holds.delete(sessionId);
    ctx.store.update(sessionId, { status: "idle" });
    ctx.store.addTimeline(
      sessionId,
      "note",
      `Stopped holding the turn at the "${gate.kind}" gate after ${Math.round(limit * ctx.config.stopHoldSeconds / 60)} minutes. Answer it in the UI \u2014 the verdict is delivered with your next message to the session.`,
      { label: "gate" }
    );
    return HOOK_NOOP;
  }
  holds.set(sessionId, { gateId: gate.id, rounds: round });
  ctx.store.update(sessionId, { status: "waiting" });
  return stopBlock(
    `[cc-harness] Still parked at the "${gate.kind}" gate \u2014 the user has not answered yet. Do not call a tool and do not start new work: end your turn again, immediately. The harness re-parks the session and resumes you the moment they answer.`
  );
}
function stillParked(kind) {
  return `
[cc-harness] The "${kind}" gate is still open \u2014 this message is not a verdict. Respond to it, then end your turn to park again.`;
}
async function resolveWorktree(sessionId, ctx) {
  if (worktreeScanned.has(sessionId)) return;
  const transcript = ctx.store.get(sessionId)?.transcriptPath;
  if (!transcript) return;
  if (worktreeScanned.size >= MAX_SCANNED) worktreeScanned.clear();
  worktreeScanned.add(sessionId);
  await applyWorktree(sessionId, ctx, await scanTranscriptForWorktree(transcript));
}
async function applyWorktree(sessionId, ctx, worktree) {
  const session = ctx.store.get(sessionId);
  if (!session) return;
  const previous = session.worktree ?? null;
  if ((worktree?.path ?? null) === (previous?.path ?? null)) return;
  const target = worktree?.path ?? previous?.originalCwd ?? session.cwd;
  const root = await repoRoot(target) ?? target;
  const [branch, head, mainRoot] = await Promise.all([
    currentBranch(root),
    headCommit(root),
    worktree ? mainWorktreeRoot(root) : Promise.resolve(null)
  ]);
  ctx.store.update(sessionId, {
    cwd: target,
    repoRoot: root,
    branch,
    // The commit the worktree forked from is the right base for its review;
    // the one recorded at session start belongs to the tree it just left.
    startCommit: worktree ? worktree.originalHeadCommit ?? head : previous?.originalHeadCommit ?? session.startCommit ?? head,
    worktree: worktree ? {
      path: worktree.path,
      name: worktree.name,
      mainRoot,
      originalCwd: worktree.originalCwd ?? previous?.originalCwd ?? session.cwd,
      originalBranch: worktree.originalBranch ?? previous?.originalBranch ?? null,
      originalHeadCommit: worktree.originalHeadCommit ?? previous?.originalHeadCommit ?? session.startCommit
    } : null
  });
  ctx.store.addTimeline(
    sessionId,
    "note",
    worktree ? `Working in worktree ${worktree.name} (${target})` : `Left the worktree; back in ${target}`,
    { label: "worktree" }
  );
  ctx.store.clearDiff(sessionId);
  clearBaseline(sessionId);
}
function relativeWithin(root, file) {
  const rel = path3.relative(root, file);
  if (!rel) return file;
  return rel.startsWith("..") || path3.isAbsolute(rel) ? file : rel;
}
function attachTailer(sessionId, ctx, fromStart = false) {
  const session = ctx.store.get(sessionId);
  if (!session?.transcriptPath || ctx.tailers.has(sessionId)) return;
  const tailer = new TranscriptTailer(session.transcriptPath, (update) => {
    if (update.title && !ctx.store.get(sessionId)?.titleLocked) {
      ctx.store.update(sessionId, { title: update.title });
    }
    if ("worktree" in update) void applyWorktree(sessionId, ctx, update.worktree ?? null);
    if (update.events.length) ctx.store.addTimelineBatch(sessionId, update.events);
    if (update.usage) {
      ctx.store.mutate(sessionId, (s) => {
        const usage = s.usage ?? { inputTokens: 0, outputTokens: 0, byStage: {} };
        usage.inputTokens += update.usage.inputTokens;
        usage.outputTokens += update.usage.outputTokens;
        usage.byStage[s.stage] = (usage.byStage[s.stage] ?? 0) + update.usage.outputTokens;
        s.usage = usage;
      });
    }
  });
  ctx.tailers.set(sessionId, tailer);
  tailer.start(fromStart);
  void resolveWorktree(sessionId, ctx).catch(() => {
  });
}
function normalizeTodos(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw;
    const content = typeof item["content"] === "string" ? item["content"] : null;
    if (!content) continue;
    const status = item["status"];
    out.push({
      content,
      status: status === "in_progress" || status === "completed" ? status : "pending",
      ...typeof item["activeForm"] === "string" ? { activeForm: item["activeForm"] } : {}
    });
  }
  return out;
}
function previewOutput(output) {
  if (typeof output === "string") return output.slice(0, 400);
  if (output && typeof output === "object") {
    const rec = output;
    const text = rec["stdout"] ?? rec["output"] ?? rec["content"];
    if (typeof text === "string") return text.slice(0, 400);
  }
  return void 0;
}
function summarizeNotification(input) {
  const data = input.notification_data;
  if (data && typeof data === "object") {
    const message = data["message"];
    if (typeof message === "string") return message;
  }
  return input.notification_type ?? "notification";
}

// src/test/park.test.ts
var home;
var cwd;
var store;
before(async () => {
  home = mkdtempSync(path6.join(tmpdir(), "cc-harness-park-home-"));
  cwd = mkdtempSync(path6.join(tmpdir(), "cc-harness-park-cwd-"));
  process.env["CC_HARNESS_HOME"] = home;
  const { SessionStore: Store } = await Promise.resolve().then(() => (init_store(), store_exports));
  store = new Store();
});
after(() => {
  rmSync2(home, { recursive: true, force: true });
  rmSync2(cwd, { recursive: true, force: true });
});
var ctxWith = (over = {}) => ({
  store,
  config: { ...DEFAULT_CONFIG, stopHoldSeconds: 0.15, gateHoldRounds: 1, ...over },
  uiUrl: (id) => `http://127.0.0.1/s/${id}`,
  tailers: /* @__PURE__ */ new Map()
});
var stop = (id, ctx, stopHookActive = false) => ingestHook("Stop", { session_id: id, cwd, stop_hook_active: stopHookActive }, ctx);
test("the parked turn resumes on the verdict, without the model having polled", async () => {
  const id = "park-resolve";
  const ctx = ctxWith({ stopHoldSeconds: 5 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, "plan", "Review the plan");
  const parked = stop(id, ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.get(id)?.status, "waiting", "the session shows as waiting while parked");
  store.resolveGate(id, gate.id, { verdict: "approved", resolvedAt: Date.now(), comment: "Ship it." });
  const out = await parked;
  assert.equal(out.decision, "block", "the turn is resumed rather than ended");
  assert.match(out.reason ?? "", /approved at the plan gate/);
  assert.match(out.reason ?? "", /Ship it\./);
  assert.equal(store.get(id)?.status, "active");
});
test("a message sent while a gate is open reaches the session instead of queueing behind it", async () => {
  const id = "park-message";
  const ctx = ctxWith({ stopHoldSeconds: 5 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, "code_review", "Review the diff");
  const parked = stop(id, ctx);
  await new Promise((r) => setTimeout(r, 50));
  store.queueFeedback(id, { text: "Actually, check the null case first.", origin: "timeline" });
  const out = await parked;
  assert.equal(out.decision, "block", "the message wakes the parked turn");
  assert.match(out.reason ?? "", /check the null case first/);
  assert.match(out.reason ?? "", /gate is still open/, "and is not mistaken for the verdict");
  assert.equal(store.getGate(id, gate.id)?.status, "open", "the gate itself is untouched");
});
test("an expired hold re-parks quietly rather than asking the model to poll", async () => {
  const id = "park-expire";
  const ctx = ctxWith();
  store.ensure(id, cwd);
  store.openGate(id, "plan", "Review the plan");
  const out = await stop(id, ctx);
  assert.equal(out.decision, "block");
  assert.match(out.reason ?? "", /Still parked at the "plan" gate/);
  assert.match(out.reason ?? "", /end your turn again/i);
  assert.doesNotMatch(out.reason ?? "", /harness_await/, "the model is never sent back to poll");
});
test("the harness stops holding the terminal once its patience runs out", async () => {
  const id = "park-giveup";
  const ctx = ctxWith();
  store.ensure(id, cwd);
  const gate = store.openGate(id, "question", "Map or plain object?");
  await stop(id, ctx);
  const out = await stop(id, ctx, true);
  assert.notEqual(out.decision, "block", "the turn is allowed to end");
  assert.equal(store.get(id)?.status, "idle");
  assert.match(
    store.get(id)?.timeline.at(-1)?.text ?? "",
    /Stopped holding the turn/,
    "and the UI says why, so the gate does not look ignored"
  );
  store.resolveGate(id, gate.id, { verdict: "answered", resolvedAt: Date.now(), comment: "A Map." });
  const resumed = await ingestHook(
    "UserPromptSubmit",
    { session_id: id, cwd, prompt: "carry on" },
    ctx
  );
  assert.match(
    resumed.hookSpecificOutput?.additionalContext ?? "",
    /A Map\./,
    "the verdict is handed over with the message that woke the session"
  );
});
test("a superseded gate releases the park instead of holding for nothing", async () => {
  const id = "park-superseded";
  const ctx = ctxWith({ stopHoldSeconds: 5 });
  store.ensure(id, cwd);
  store.openGate(id, "plan", "First plan");
  const parked = stop(id, ctx);
  await new Promise((r) => setTimeout(r, 50));
  store.openGate(id, "plan", "Second plan");
  const out = await parked;
  assert.match(out.reason ?? "", /replaced by a newer "plan" gate/);
  assert.match(out.reason ?? "", /End your turn again/);
});
test('"send now" wakes the park with the message, not with a phantom verdict', async () => {
  const id = "park-sendnow";
  const ctx = ctxWith({ stopHoldSeconds: 5 });
  store.ensure(id, cwd);
  const gate = store.openGate(id, "plan", "Review the plan");
  const parked = stop(id, ctx);
  await new Promise((r) => setTimeout(r, 50));
  store.queueFeedback(id, {
    text: "Forget the plan \u2014 fix the README typo first.",
    origin: "timeline",
    interrupt: true,
    skippedGate: { kind: gate.kind, prompt: gate.prompt }
  });
  store.cancelGate(id, gate.id);
  const out = await parked;
  assert.equal(out.decision, "block");
  assert.match(out.reason ?? "", /fix the README typo first/);
  assert.match(out.reason ?? "", /do not wait on it/i);
  assert.doesNotMatch(
    out.reason ?? "",
    /gate is still open/,
    "the message closed the gate, so nothing may claim it is still there"
  );
});
//# sourceMappingURL=park.test.js.map
