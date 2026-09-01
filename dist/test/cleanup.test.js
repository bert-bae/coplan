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
import path2 from "node:path";
import { mkdirSync, readFileSync, existsSync as existsSync2 } from "node:fs";
function harnessHome() {
  return process.env.CC_HARNESS_HOME || path2.join(homedir(), ".claude", "cc-harness");
}
function sanitizeId(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}
function ensureHome() {
  const home2 = harnessHome();
  mkdirSync(home2, { recursive: true });
  mkdirSync(path2.join(home2, "sessions"), { recursive: true });
  return home2;
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
var paths;
var init_paths = __esm({
  "src/shared/paths.ts"() {
    "use strict";
    paths = {
      home: harnessHome,
      lockFile: () => path2.join(harnessHome(), "daemon.json"),
      logFile: () => path2.join(harnessHome(), "daemon.log"),
      sessionsDir: () => path2.join(harnessHome(), "sessions"),
      sessionDir: (id) => path2.join(harnessHome(), "sessions", sanitizeId(id)),
      sessionState: (id) => path2.join(harnessHome(), "sessions", sanitizeId(id), "state.json"),
      sessionEvents: (id) => path2.join(harnessHome(), "sessions", sanitizeId(id), "events.jsonl"),
      configDir: harnessHome,
      instructionsDir: () => path2.join(harnessHome(), "instructions")
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
import path3 from "node:path";
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
    title: path3.basename(cwd) || sessionId.slice(0, 8),
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
  state.createdAt ??= state.updatedAt ?? Date.now();
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
  return root ? path3.basename(root) : null;
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
          const sessionDir = path3.join(dir, entry.name);
          const file = path3.join(sessionDir, "state.json");
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
          const tmp = path3.join(dir, `.state.${process.pid}.tmp`);
          writeFileSync(tmp, JSON.stringify(state, null, 2));
          renameSync(tmp, path3.join(dir, "state.json"));
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
      /**
       * The session list the rail renders, newest session first.
       *
       * Ordered on `createdAt`, not activity: an activity order reshuffles itself
       * every time any session takes a turn, so a row the user was reaching for
       * moves out from under the cursor. Creation order never changes.
       */
      summaries() {
        return this.all().sort((a, b) => b.createdAt - a.createdAt).map((s) => ({
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
          createdAt: s.createdAt,
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
        const normalized = path3.resolve(cwd);
        const matches = (value) => !!value && path3.resolve(value) === normalized;
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
            const live2 = state.threads.find((t) => t.id === delivered.id);
            if (live2 && !live2.deliveredAt) live2.deliveredAt = now;
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
            const live2 = state.threads.find((x) => x.id === t.id);
            if (live2) live2.deliveredAt = now;
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
          const tmp = path3.join(dir, `.diff.${process.pid}.tmp`);
          writeFileSync(tmp, JSON.stringify(diff));
          renameSync(tmp, path3.join(dir, "diff.json"));
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
          rmSync(path3.join(paths.sessionDir(id), "diff.json"), { force: true });
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
          const file = path3.join(paths.sessionDir(id), "diff.json");
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

// src/shared/diffparse.ts
var init_diffparse = __esm({
  "src/shared/diffparse.ts"() {
    "use strict";
  }
});

// src/daemon/git.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
async function git(cwd, args, timeout = 2e4) {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, timeout, maxBuffer: MAX_BUFFER });
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
function isFilePath(entry) {
  return !entry.endsWith("/");
}
async function workingTreeFingerprints(cwd) {
  const status = await git(cwd, ["status", "--porcelain", "-z"]);
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
  const hashed = await git(cwd, ["hash-object", "--", ...paths2]);
  const hashes = hashed.stdout.split("\n").filter(Boolean);
  if (hashes.length === paths2.length) {
    paths2.forEach((file, i) => {
      out[file] = hashes[i];
    });
    return out;
  }
  for (const file of paths2) {
    const one = await git(cwd, ["hash-object", "--", file]);
    out[file] = one.ok && one.stdout.trim() || "absent";
  }
  return out;
}
function changedBetween(before2, after2) {
  const paths2 = /* @__PURE__ */ new Set([...Object.keys(before2), ...Object.keys(after2)]);
  return [...paths2].filter((p) => before2[p] !== after2[p]).sort();
}
var exec, MAX_BUFFER;
var init_git = __esm({
  "src/daemon/git.ts"() {
    "use strict";
    init_diffparse();
    exec = promisify(execFile);
    MAX_BUFFER = 32 * 1024 * 1024;
  }
});

// src/daemon/tasks.ts
var tasks_exports = {};
__export(tasks_exports, {
  addNote: () => addNote,
  attributeFile: () => attributeFile,
  baselineCount: () => baselineCount,
  clearBaseline: () => clearBaseline,
  createTasks: () => createTasks,
  pruneBaselines: () => pruneBaselines,
  reconcileFiles: () => reconcileFiles,
  recordDecision: () => recordDecision,
  renderBoard: () => renderBoard,
  reorderTasks: () => reorderTasks,
  summarizeBoard: () => summarizeBoard,
  tasksFromPlan: () => tasksFromPlan,
  updateTask: () => updateTask
});
import { randomUUID as randomUUID2 } from "node:crypto";
function createTasks(store, sessionId, specs, opts = {}) {
  const now = Date.now();
  let created = [];
  store.mutate(sessionId, (s) => {
    const existing = opts.replace ? [] : s.tasks;
    const base = existing.length;
    created = specs.filter((spec) => spec.title.trim()).map((spec, i) => ({
      id: randomUUID2(),
      title: spec.title.trim(),
      ...spec.detail ? { detail: spec.detail } : {},
      ...spec.planStepId ? { planStepId: spec.planStepId } : {},
      status: "todo",
      order: base + i,
      createdAt: now,
      updatedAt: now,
      notes: [],
      files: [],
      decisions: []
    }));
    s.tasks = [...existing, ...created];
  });
  const session = store.get(sessionId);
  if (session) store.emitEvent({ type: "tasks", sessionId, tasks: session.tasks });
  if (created.length) {
    store.addTimeline(sessionId, "stage", `Task board created with ${created.length} task(s)`, {
      label: "board"
    });
  }
  return created;
}
function tasksFromPlan(store, sessionId, steps) {
  const session = store.get(sessionId);
  if (!session) return [];
  const live2 = steps.filter((s) => s.status !== "dropped" && s.title.trim());
  const started = session.tasks.some((t) => t.status !== "todo");
  if (started) return session.tasks;
  return createTasks(
    store,
    sessionId,
    live2.map((step) => ({
      title: step.title,
      ...step.detail ? { detail: step.detail } : {},
      planStepId: step.id
    })),
    { replace: true }
  );
}
async function reconcileFiles(store, sessionId) {
  const session = store.get(sessionId);
  if (!session) return;
  const cwd = session.repoRoot ?? session.cwd;
  let after2;
  try {
    after2 = await workingTreeFingerprints(cwd);
  } catch {
    return;
  }
  const active = session.tasks.find((t) => t.status === "in_progress");
  const baseline = baselines.get(sessionId);
  if (baseline && baseline.taskId) {
    const changed = changedBetween(baseline.fingerprints, after2);
    if (changed.length) {
      store.mutate(sessionId, (s) => {
        const task = s.tasks.find((t) => t.id === baseline.taskId);
        if (!task) return;
        for (const file of changed) {
          if (!task.files.includes(file)) task.files.push(file);
        }
        task.updatedAt = Date.now();
      });
      const updated = store.get(sessionId);
      if (updated) store.emitEvent({ type: "tasks", sessionId, tasks: updated.tasks });
    }
  }
  baselines.set(sessionId, { taskId: active?.id ?? null, fingerprints: after2 });
}
function clearBaseline(sessionId) {
  baselines.delete(sessionId);
}
function pruneBaselines(isLive) {
  let removed = 0;
  for (const sessionId of [...baselines.keys()]) {
    if (isLive(sessionId)) continue;
    baselines.delete(sessionId);
    removed++;
  }
  return removed;
}
function baselineCount() {
  return baselines.size;
}
function updateTask(store, sessionId, taskId, patch) {
  let updated;
  const now = Date.now();
  store.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (patch.status && patch.status !== task.status) {
      if (patch.status === "in_progress") {
        for (const other of s.tasks) {
          if (other.id !== taskId && other.status === "in_progress") {
            other.status = "todo";
            other.updatedAt = now;
          }
        }
        task.startedAt ??= now;
        if (s.stage === "plan_review" || s.stage === "planning" || s.stage === "idle") {
          s.stage = "implementing";
        }
      }
      if (patch.status === "done") task.completedAt = now;
      if (patch.status !== "blocked") {
        delete task.blockedBy;
        delete task.blockedReason;
      }
      task.status = patch.status;
    }
    if (patch.title !== void 0) task.title = patch.title;
    if (patch.detail !== void 0) task.detail = patch.detail;
    if (patch.order !== void 0) task.order = patch.order;
    if (patch.blockedBy !== void 0) {
      if (patch.blockedBy === null) delete task.blockedBy;
      else task.blockedBy = patch.blockedBy;
    }
    if (patch.blockedReason !== void 0) {
      if (patch.blockedReason === null) delete task.blockedReason;
      else task.blockedReason = patch.blockedReason;
    }
    task.updatedAt = now;
    updated = task;
  });
  const session = store.get(sessionId);
  if (session) store.emitEvent({ type: "tasks", sessionId, tasks: session.tasks });
  return updated;
}
function addNote(store, sessionId, taskId, kind, text) {
  const note = { id: randomUUID2(), ts: Date.now(), kind, text };
  let ok = false;
  store.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.notes.push(note);
    task.updatedAt = note.ts;
    ok = true;
  });
  if (!ok) return void 0;
  const session = store.get(sessionId);
  if (session) store.emitEvent({ type: "tasks", sessionId, tasks: session.tasks });
  return note;
}
function recordDecision(store, sessionId, gateId, answer) {
  let decision;
  store.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.blockedBy === gateId);
    if (!task) return;
    decision = {
      id: randomUUID2(),
      ts: Date.now(),
      question: task.blockedReason ?? "Question",
      answer
    };
    task.decisions.push(decision);
    task.notes.push({
      id: randomUUID2(),
      ts: decision.ts,
      kind: "decision",
      text: `${decision.question} \u2192 ${answer}`
    });
    task.status = "in_progress";
    delete task.blockedBy;
    delete task.blockedReason;
    task.updatedAt = decision.ts;
  });
  const session = store.get(sessionId);
  if (session && decision) store.emitEvent({ type: "tasks", sessionId, tasks: session.tasks });
  return decision;
}
function attributeFile(store, sessionId, relPath) {
  const session = store.get(sessionId);
  if (!session) return;
  const active = session.tasks.find((t) => t.status === "in_progress");
  if (!active || active.files.includes(relPath)) return;
  store.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.id === active.id);
    if (task && !task.files.includes(relPath)) {
      task.files.push(relPath);
      task.updatedAt = Date.now();
    }
  });
  const updated = store.get(sessionId);
  if (updated) store.emitEvent({ type: "tasks", sessionId, tasks: updated.tasks });
}
function reorderTasks(store, sessionId, orderedIds) {
  store.mutate(sessionId, (s) => {
    const index = new Map(orderedIds.map((id, i) => [id, i]));
    for (const task of s.tasks) {
      const position = index.get(task.id);
      if (position !== void 0) task.order = position;
    }
    s.tasks.sort((a, b) => a.order - b.order);
  });
  const session = store.get(sessionId);
  if (session) store.emitEvent({ type: "tasks", sessionId, tasks: session.tasks });
  return session?.tasks ?? [];
}
function summarizeBoard(tasks) {
  if (tasks.length === 0) return "No tasks on the board.";
  const by = (status) => tasks.filter((t) => t.status === status);
  const active = by("in_progress")[0];
  const blocked = by("blocked");
  const lines = [
    `Board: ${by("done").length} done \xB7 ${by("in_progress").length} in progress \xB7 ${blocked.length} blocked \xB7 ${by("todo").length} to do`
  ];
  if (active) lines.push(`Now: ${active.title}`);
  for (const task of blocked) {
    lines.push(`BLOCKED: ${task.title} \u2014 ${task.blockedReason ?? "waiting on the user"}`);
  }
  const next = by("todo")[0];
  if (!active && !blocked.length && next) lines.push(`Next: ${next.title}`);
  return lines.join("\n");
}
function renderBoard(tasks) {
  if (tasks.length === 0) return "[cc-harness] The task board is empty.";
  const order = ["in_progress", "blocked", "todo", "done"];
  const label = {
    in_progress: "IN PROGRESS",
    blocked: "BLOCKED",
    todo: "TODO",
    done: "DONE"
  };
  const parts = [];
  for (const status of order) {
    const group = tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order);
    if (group.length === 0) continue;
    parts.push(`
${label[status]}`);
    for (const task of group) {
      parts.push(`\u2022 [${task.id.slice(0, 8)}] ${task.title}`);
      if (task.blockedReason) parts.push(`    waiting on: ${task.blockedReason}`);
      if (task.files.length) parts.push(`    files: ${task.files.join(", ")}`);
      for (const decision of task.decisions) {
        parts.push(`    decided: ${decision.question} \u2192 ${decision.answer}`);
      }
      const changes = task.notes.filter((n) => n.kind === "change");
      for (const note of changes.slice(-3)) parts.push(`    ${note.text}`);
    }
  }
  return parts.join("\n").trim();
}
var baselines;
var init_tasks = __esm({
  "src/daemon/tasks.ts"() {
    "use strict";
    init_git();
    baselines = /* @__PURE__ */ new Map();
  }
});

// src/test/cleanup.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync as rmSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import path4 from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// src/daemon/proc.ts
import { spawn } from "node:child_process";
var FLUSH_GRACE_MS = 250;
var KILL_ESCALATION_MS = 4e3;
var live = /* @__PURE__ */ new Set();
function liveChildCount() {
  return live.size;
}
function reapGroup(child) {
  const pid = child.pid;
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
  }
}
function signalTree(child, signal) {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
    }
  }
}
function run(command, opts) {
  const maxOutput = opts.maxOutput ?? Number.POSITIVE_INFINITY;
  let settled = false;
  let output = "";
  let timedOut = false;
  let cancelled = false;
  let escalation = null;
  let flush = null;
  let timer = null;
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    // A new process group, so the whole tree can be signalled at once.
    detached: process.platform !== "win32",
    // stdin is /dev/null on purpose. The default is a pipe the daemon never
    // writes to and never closes, so a command that prompts for a password
    // blocks forever on a read that can never be answered.
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ?? process.env
  });
  const entry = { child, label: opts.label ?? command, kill: () => {
  } };
  const terminate = (reason) => {
    if (settled) return;
    if (reason === "timeout") timedOut = true;
    else cancelled = true;
    signalTree(child, "SIGTERM");
    if (escalation) return;
    escalation = setTimeout(() => {
      escalation = null;
      signalTree(child, "SIGKILL");
      settle(-1, "SIGKILL");
    }, KILL_ESCALATION_MS);
    escalation.unref?.();
  };
  entry.kill = terminate;
  const settle = (code, signal) => {
    if (settled) return;
    settled = true;
    if (escalation) clearTimeout(escalation);
    if (flush) clearTimeout(flush);
    if (timer) clearTimeout(timer);
    live.delete(entry);
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolveResult({
      ok: code === 0 && !timedOut && !cancelled,
      code: code ?? -1,
      signal,
      output,
      timedOut,
      cancelled
    });
  };
  const append = (buf) => {
    const chunk = buf.toString("utf8");
    output += chunk;
    if (output.length > maxOutput) output = `\u2026
${output.slice(-maxOutput)}`;
    opts.onOutput?.(output);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.stdout?.on("error", () => {
  });
  child.stderr?.on("error", () => {
  });
  timer = setTimeout(() => terminate("timeout"), opts.timeoutMs);
  timer.unref?.();
  child.on("error", (err) => {
    output += `
[cc-harness] ${err.message}`;
    settle(-1, null);
  });
  child.on("exit", (code, signal) => {
    if (flush) clearTimeout(flush);
    flush = setTimeout(() => {
      reapGroup(child);
      settle(code, signal);
    }, FLUSH_GRACE_MS);
    flush.unref?.();
  });
  child.on("close", (code, signal) => settle(code, signal));
  live.add(entry);
  return { result, pid: child.pid, cancel: () => terminate("cancel") };
}
async function shutdownChildren(graceMs = 800) {
  if (live.size === 0) return 0;
  const signalled = /* @__PURE__ */ new Set();
  const sweep = (signal) => {
    for (const entry of live) {
      signalTree(entry.child, signal);
      signalled.add(entry);
    }
  };
  sweep("SIGTERM");
  const deadline = Date.now() + graceMs;
  const stillRunning = () => [...live].some((e) => e.child.exitCode === null && e.child.signalCode === null);
  while (Date.now() < deadline && stillRunning()) {
    await new Promise((r) => {
      const t = setTimeout(r, 50);
      t.unref?.();
    });
  }
  sweep("SIGKILL");
  return signalled.size;
}
function killAllChildren() {
  const entries = [...live];
  for (const entry of entries) signalTree(entry.child, "SIGKILL");
  return entries.length;
}

// src/daemon/transcript.ts
import { createReadStream, existsSync, statSync, watch } from "node:fs";

// src/daemon/worktree.ts
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
    const stream = createReadStream(file, { start, end, encoding: "utf8" });
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

// src/test/cleanup.test.ts
init_paths();
var home;
before(() => {
  home = mkdtempSync(path4.join(tmpdir(), "cc-harness-cleanup-"));
  process.env["CC_HARNESS_HOME"] = home;
});
after(() => {
  killAllChildren();
  rmSync2(home, { recursive: true, force: true });
});
async function until(predicate, timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}
test("a cancelled command kills the whole process tree, not just the shell", async () => {
  const pidFile = path4.join(home, "grandchild.pid");
  const handle = run(`sh -c 'sleep 120 & echo $! > ${pidFile}; wait'`, {
    cwd: home,
    timeoutMs: 6e4,
    label: "tree test"
  });
  await until(() => {
    try {
      return readPid(pidFile) > 0;
    } catch {
      return false;
    }
  });
  const grandchild = readPid(pidFile);
  assert.ok(grandchild > 0, "the grandchild should have recorded its pid");
  assert.equal(isPidAlive(grandchild), true, "the grandchild should be running");
  handle.cancel();
  const outcome = await handle.result;
  assert.equal(outcome.cancelled, true);
  assert.equal(
    await until(() => !isPidAlive(grandchild)),
    true,
    "the grandchild must not survive the cancellation"
  );
});
test("a timeout kills the tree and always settles", async () => {
  const handle = run(`sleep 60`, { cwd: home, timeoutMs: 300, label: "timeout test" });
  const outcome = await handle.result;
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.ok, false);
});
test("a command whose child holds stdout open still settles", async () => {
  const handle = run(`sh -c '(sleep 30 &) ; echo done'`, {
    cwd: home,
    timeoutMs: 1e4,
    label: "orphan pipe test"
  });
  const outcome = await Promise.race([handle.result, sleep(6e3).then(() => null)]);
  assert.notEqual(outcome, null, "the promise must settle without waiting on the orphan");
  assert.match(outcome.output, /done/);
});
test("the orphan holding the pipes is reaped, not merely stepped around", async () => {
  const pidFile = path4.join(home, "orphan.pid");
  const handle = run(`sh -c '(sleep 30 & echo $! > ${pidFile}) ; echo done'`, {
    cwd: home,
    timeoutMs: 1e4,
    label: "orphan reap test"
  });
  const outcome = await Promise.race([handle.result, sleep(6e3).then(() => null)]);
  assert.notEqual(outcome, null, "the promise must settle");
  const orphan = readPid(pidFile);
  assert.ok(orphan > 0, "the background process should have recorded its pid");
  assert.equal(
    await until(() => !isPidAlive(orphan)),
    true,
    "the background process must not survive the command that started it"
  );
  assert.equal(liveChildCount(), 0, "and the registry must not still be holding it");
});
test("a child started during shutdown is still reaped", async () => {
  const first = run(`exec node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`, {
    cwd: home,
    timeoutMs: 6e4,
    label: "shutdown stubborn"
  });
  await sleep(400);
  const shutdown = shutdownChildren(1500);
  await sleep(200);
  const late = run("sleep 30", { cwd: home, timeoutMs: 6e4, label: "shutdown latecomer" });
  const latePid = late.pid;
  try {
    await shutdown;
    assert.ok(latePid && latePid > 0, "the latecomer should have a pid to check");
    assert.equal(
      await until(() => !isPidAlive(latePid)),
      true,
      "a child spawned during the grace window must still be killed"
    );
  } finally {
    killAllChildren();
    await Promise.all([first.result, late.result]);
  }
});
test("output is capped rather than accumulated without limit", async () => {
  const handle = run(`sh -c 'i=0; while [ $i -lt 400 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done'`, {
    cwd: home,
    timeoutMs: 2e4,
    maxOutput: 500,
    label: "output cap test"
  });
  const outcome = await handle.result;
  assert.ok(outcome.output.length <= 600, `output should stay bounded, got ${outcome.output.length}`);
});
test("shutdownChildren reaps everything still running", async () => {
  const a = run("sleep 60", { cwd: home, timeoutMs: 6e4, label: "a" });
  const b = run("sleep 60", { cwd: home, timeoutMs: 6e4, label: "b" });
  assert.equal(liveChildCount(), 2);
  const reaped = await shutdownChildren(300);
  assert.equal(reaped, 2);
  assert.equal(liveChildCount(), 0);
  await Promise.all([a.result, b.result]);
});
test("a successful command reports its exit code and is deregistered", async () => {
  const before2 = liveChildCount();
  const ok = await run("exit 0", { cwd: home, timeoutMs: 1e4 }).result;
  const bad = await run("exit 3", { cwd: home, timeoutMs: 1e4 }).result;
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.equal(liveChildCount(), before2, "finished children must not stay registered");
});
test("closing a tailer stops its poller and is idempotent", async () => {
  const file = path4.join(home, "tail.jsonl");
  writeFileSync2(file, "");
  let updates = 0;
  const tailer = new TranscriptTailer(file, () => updates++);
  tailer.start(true);
  writeFileSync2(file, `${JSON.stringify({ type: "ai-title", title: "hello" })}
`);
  await until(() => updates > 0);
  assert.ok(updates > 0, "the tailer should have read the file");
  tailer.close();
  tailer.close();
  const seen = updates;
  writeFileSync2(file, `${JSON.stringify({ type: "ai-title", title: "later" })}
`);
  await sleep(1200);
  assert.equal(updates, seen, "a closed tailer must not keep reading");
});
async function freshStore() {
  const { SessionStore: SessionStore2 } = await Promise.resolve().then(() => (init_store(), store_exports));
  return new SessionStore2();
}
test("gate history is capped", async () => {
  const store = await freshStore();
  store.ensure("gates", process.cwd());
  for (let i = 0; i < 120; i++) {
    const gate = store.openGate("gates", "question", `q${i}`);
    store.resolveGate("gates", gate.id, { verdict: "answered", resolvedAt: Date.now() });
    store.markGateDelivered("gates", gate.id);
  }
  const session = store.get("gates");
  assert.ok(session.gates.length <= 41, `expected a capped gate list, got ${session.gates.length}`);
});
test("an open gate is never trimmed away", async () => {
  const store = await freshStore();
  store.ensure("keep", process.cwd());
  for (let i = 0; i < 80; i++) {
    const gate = store.openGate("keep", "question", `q${i}`);
    store.resolveGate("keep", gate.id, { verdict: "answered", resolvedAt: Date.now() });
    store.markGateDelivered("keep", gate.id);
  }
  const open = store.openGate("keep", "plan", "still open");
  assert.equal(store.activeGate("keep").id, open.id);
  assert.ok(store.getGate("keep", open.id), "the open gate must survive trimming");
});
test("sweep evicts sessions that ended long ago and keeps live ones", async () => {
  const store = await freshStore();
  store.ensure("live", process.cwd());
  store.ensure("finished", process.cwd());
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1e3;
  store.update("finished", { status: "ended", endedAt: twoHoursAgo });
  const dropped = store.sweep({ endedTtlMs: 60 * 60 * 1e3 });
  assert.ok(dropped >= 1);
  assert.equal(store.get("finished"), void 0, "a long-finished session should be evicted");
  assert.ok(store.get("live"), "an active session must be kept");
});
test("dropping a session releases its cached diff", async () => {
  const store = await freshStore();
  store.ensure("withdiff", process.cwd());
  store.setDiff("withdiff", {
    baseRef: "abc",
    files: [],
    additions: 0,
    deletions: 0,
    generatedAt: Date.now()
  });
  assert.ok(store.getDiff("withdiff"));
  store.drop("withdiff");
  assert.equal(store.get("withdiff"), void 0);
});
test("an evicted session is rehydrated, not silently blanked", async () => {
  const store = await freshStore();
  store.ensure("evicted", process.cwd());
  store.setStage("evicted", "code_review", "most of the way through");
  store.addTimeline("evicted", "note", "something worth keeping");
  store.mutate("evicted", (state) => {
    state.status = "ended";
    state.endedAt = Date.now() - 2 * 60 * 60 * 1e3;
    state.updatedAt = Date.now() - 2 * 60 * 60 * 1e3;
  });
  store.persistNow("evicted");
  store.sweep({ endedTtlMs: 60 * 60 * 1e3 });
  assert.equal(store.get("evicted"), void 0, "the cold session is gone from memory");
  const revived = store.ensure("evicted", process.cwd());
  assert.equal(revived.stage, "code_review", "the stage came back");
  assert.ok(
    revived.timeline.some((e) => e.text === "something worth keeping"),
    "and so did the history"
  );
});
test("a session that never existed is created fresh rather than failing", async () => {
  const store = await freshStore();
  const made = store.ensure("brand-new", process.cwd());
  assert.equal(made.stage, "idle");
  assert.equal(made.timeline.length, 0);
});
test("reading a cached diff refreshes its place in the LRU", async () => {
  const store = await freshStore();
  const diff = (ref) => ({ baseRef: ref, files: [], additions: 0, deletions: 0, generatedAt: Date.now() });
  const { MAX_CACHED_DIFFS: MAX_CACHED_DIFFS2 } = await Promise.resolve().then(() => (init_store(), store_exports));
  const ids = [];
  for (let i = 0; i < MAX_CACHED_DIFFS2; i++) {
    const id = `s${i}`;
    ids.push(id);
    store.ensure(id, process.cwd());
    store.setDiff(id, diff(id));
  }
  for (const id of ids) rmSync2(path4.join(home, "sessions", id, "diff.json"), { force: true });
  const oldest = ids[0];
  assert.ok(store.getDiff(oldest), "the oldest entry is still cached");
  store.ensure("newcomer", process.cwd());
  store.setDiff("newcomer", diff("newcomer"));
  rmSync2(path4.join(home, "sessions", "newcomer", "diff.json"), { force: true });
  assert.ok(store.getDiff(oldest), "the entry just read survives the eviction");
  assert.equal(store.getDiff(ids[1]), void 0, "the genuinely least-recent one is evicted");
});
test("sessions older than the retention window are not loaded from disk", async () => {
  const stale = path4.join(home, "sessions", "ancient");
  mkdirSync3(stale, { recursive: true });
  writeFileSync2(
    path4.join(stale, "state.json"),
    JSON.stringify({
      sessionId: "ancient",
      cwd: process.cwd(),
      updatedAt: Date.now() - 60 * 24 * 60 * 60 * 1e3,
      gates: [],
      status: "ended"
    })
  );
  const store = await freshStore();
  assert.equal(store.get("ancient"), void 0, "a two-month-old session should not be resident");
});
test("pruneBaselines drops entries for sessions that are gone", async () => {
  const { reconcileFiles: reconcileFiles2, pruneBaselines: pruneBaselines2, baselineCount: baselineCount2 } = await Promise.resolve().then(() => (init_tasks(), tasks_exports));
  const store = await freshStore();
  store.ensure("b1", process.cwd());
  store.ensure("b2", process.cwd());
  await reconcileFiles2(store, "b1");
  await reconcileFiles2(store, "b2");
  assert.equal(baselineCount2(), 2);
  const removed = pruneBaselines2((id) => id === "b1");
  assert.equal(removed, 1);
  assert.equal(baselineCount2(), 1);
});
function readPid(file) {
  return Number(readFileSync3(file, "utf8").trim());
}
//# sourceMappingURL=cleanup.test.js.map
