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
    title: path2.basename(cwd2) || sessionId.slice(0, 8),
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
function settleStatus(state, parked) {
  if (state.status !== "waiting") return;
  state.status = parked ? "active" : "idle";
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
      findByCwd(cwd2) {
        const normalized = path2.resolve(cwd2);
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
        const parked = gate.waiting;
        gate.status = "resolved";
        gate.result = result;
        gate.waiting = false;
        if (state.activeGateId === gateId) state.activeGateId = null;
        settleStatus(state, parked);
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
        const parked = gate.waiting;
        gate.status = "cancelled";
        gate.waiting = false;
        if (state.activeGateId === gateId) state.activeGateId = null;
        settleStatus(state, parked);
        state.updatedAt = Date.now();
        this.persistSoon(id);
        this.addTimeline(id, "gate", reason ?? `The user skipped the ${gate.kind.replace("_", " ")} gate.`, {
          label: gate.kind,
          meta: { gateId, cancelled: true }
        });
        this.emitEvent({
          type: "state",
          sessionId: id,
          patch: { gates: state.gates, activeGateId: null, status: state.status }
        });
        this.broadcastSessionList();
        this.emit("gate:cancelled", { sessionId: id, gate });
        return gate;
      }
      /**
       * A gate the user has already answered but Claude has not yet been told
       * about. This happens whenever the user answers faster than the turn ends.
       */
      undeliveredGate(id) {
        return this.undeliveredGates(id)[0];
      }
      /**
       * Every answered gate Claude has not been told about, oldest first.
       *
       * Usually there is at most one. More than one means an answer was given
       * while the session was stopped and then another gate came and went before
       * it next ran — and handing over only the first would leave the user's most
       * recent verdict stranded behind a stale one, which reads as the click
       * having done nothing.
       */
      undeliveredGates(id) {
        return this.sessions.get(id)?.gates.filter((g) => g.status === "resolved" && g.result && !g.deliveredAt) ?? [];
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
      /**
       * Stop marking a gate as parked, without deciding what the session is doing.
       *
       * {@link setGateWaiting} promotes a session off `waiting` when its wait
       * ends, which is right for `harness_await` — the wait ending there means the
       * turn is carrying on. It is wrong for a gate hold that simply expired:
       * nothing is running, the turn is about to end, and broadcasting `active`
       * first makes every unanswered gate flash the session card from "waiting"
       * to "working" and back. The caller sets the real status straight after.
       */
      clearGateWaiting(id, gateId) {
        const gate = this.getGate(id, gateId);
        if (!gate || !gate.waiting) return;
        gate.waiting = false;
        const state = this.sessions.get(id);
        if (state) this.emitEvent({ type: "state", sessionId: id, patch: { gates: state.gates } });
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

// src/test/checks.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync as rmSync2 } from "node:fs";
import { tmpdir } from "node:os";
import path3 from "node:path";

// src/daemon/checks.ts
import { randomUUID } from "node:crypto";

// src/daemon/proc.ts
import { spawn } from "node:child_process";
var FLUSH_GRACE_MS = 250;
var KILL_ESCALATION_MS = 4e3;
var live = /* @__PURE__ */ new Set();
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

// src/shared/config.ts
var CHECK_RUN_BUDGET_MS = 15 * 6e4;

// src/daemon/checks.ts
var MAX_OUTPUT = 4e4;
var DEFAULT_TIMEOUT_MS = 15 * 60 * 1e3;
var running = /* @__PURE__ */ new Map();
var runsBySession = /* @__PURE__ */ new Map();
function seedChecks(store2, sessionId, commands) {
  const runs = commands.map((command) => ({
    id: randomUUID(),
    command,
    status: "pending",
    output: ""
  }));
  store2.mutate(sessionId, (s) => {
    s.checks = runs;
  });
  return runs;
}
async function runCheck(store2, sessionId, checkId, opts = {}) {
  const session = store2.get(sessionId);
  const check = session?.checks.find((c) => c.id === checkId);
  if (!session || !check) return void 0;
  if (check.status === "running") return check;
  const cwd2 = session.repoRoot ?? session.cwd;
  const started = Date.now();
  patchCheck(store2, sessionId, checkId, { status: "running", startedAt: started, output: "" });
  const handle = run(check.command, {
    cwd: cwd2,
    timeoutMs: Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutput: MAX_OUTPUT,
    label: `check: ${check.command}`,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    onOutput: (output) => patchCheck(store2, sessionId, checkId, { output })
  });
  running.set(checkId, handle);
  let outcome;
  try {
    outcome = await handle.result;
  } finally {
    running.delete(checkId);
  }
  const note = outcome.timedOut ? "\n[cc-harness] timed out" : outcome.cancelled ? "\n[cc-harness] cancelled" : "";
  const status = outcome.ok ? "passed" : "failed";
  const updated = patchCheck(store2, sessionId, checkId, {
    status,
    exitCode: outcome.code,
    finishedAt: Date.now(),
    output: outcome.output + note
  });
  store2.addTimeline(sessionId, "check", `${check.command} \u2014 ${status}`, {
    label: status,
    meta: { checkId, exitCode: outcome.code }
  });
  return updated;
}
async function runAllChecks(store2, sessionId, opts = {}) {
  const session = store2.get(sessionId);
  if (!session) return [];
  cancelSessionRun(sessionId);
  const ids = /* @__PURE__ */ new Set();
  runsBySession.set(sessionId, ids);
  const deadline = Date.now() + (opts.budgetMs ?? CHECK_RUN_BUDGET_MS);
  const results = [];
  try {
    for (const check of [...session.checks]) {
      if (runsBySession.get(sessionId) !== ids) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      ids.add(check.id);
      const run2 = await runCheck(store2, sessionId, check.id, { timeoutMs: remaining });
      if (run2) results.push(run2);
    }
  } finally {
    if (runsBySession.get(sessionId) === ids) runsBySession.delete(sessionId);
  }
  return results;
}
function cancelSessionRun(sessionId) {
  const ids = runsBySession.get(sessionId);
  if (!ids) return 0;
  let stopped = 0;
  for (const id of ids) {
    if (cancelCheck(id)) stopped++;
  }
  runsBySession.delete(sessionId);
  return stopped;
}
function cancelCheck(checkId) {
  const handle = running.get(checkId);
  if (!handle) return false;
  handle.cancel();
  return true;
}
function patchCheck(store2, sessionId, checkId, patch) {
  let updated;
  const session = store2.get(sessionId);
  if (!session) return void 0;
  const check = session.checks.find((c) => c.id === checkId);
  if (!check) return void 0;
  Object.assign(check, patch);
  updated = check;
  store2.emitEvent({ type: "check", sessionId, check });
  store2.emitEvent({ type: "state", sessionId, patch: { checks: session.checks } });
  return updated;
}

// src/test/checks.test.ts
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
async function running2(id) {
  for (let i = 0; i < 400; i++) {
    if (store.get(id)?.checks.some((c) => c.status === "running")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no check ever started running");
}
var home;
var cwd;
var store;
before(async () => {
  home = mkdtempSync(path3.join(tmpdir(), "cc-harness-checks-home-"));
  cwd = mkdtempSync(path3.join(tmpdir(), "cc-harness-checks-cwd-"));
  process.env["CC_HARNESS_HOME"] = home;
  const { SessionStore: Store } = await Promise.resolve().then(() => (init_store(), store_exports));
  store = new Store();
});
after(() => {
  rmSync2(home, { recursive: true, force: true });
  rmSync2(cwd, { recursive: true, force: true });
});
test("a run finishes inside its budget rather than outlasting every timeout above it", async () => {
  const id = "checks-budget";
  store.ensure(id, cwd);
  seedChecks(store, id, ["sleep 30", "echo never-reached"]);
  const started = Date.now();
  const results = await runAllChecks(store, id, { budgetMs: 400 });
  const took = Date.now() - started;
  assert.ok(took < 1e4, `the run gave up at its deadline rather than running on (${took}ms)`);
  const state = store.get(id);
  assert.equal(state.checks[1]?.status, "pending", "a command never reached stays honestly unrun");
  assert.ok(results.length <= 1);
});
test("a run that finishes early is not held to its budget", async () => {
  const id = "checks-fast";
  store.ensure(id, cwd);
  seedChecks(store, id, ["exit 0", "exit 3"]);
  const results = await runAllChecks(store, id, { budgetMs: 3e4 });
  assert.equal(results.length, 2);
  assert.equal(results[0]?.status, "passed");
  assert.equal(results[1]?.status, "failed");
  assert.equal(results[1]?.exitCode, 3);
});
test("starting a run stops the one it replaces instead of racing it", async () => {
  const id = "checks-replace";
  store.ensure(id, cwd);
  seedChecks(store, id, ["sleep 30", "sleep 30"]);
  const first = runAllChecks(store, id);
  await running2(id);
  const second = runAllChecks(store, id);
  await running2(id);
  const abandoned = await withTimeout(first, 5e3);
  assert.ok(
    abandoned,
    "the superseded run walked on to its next command instead of stopping \u2014 it is now racing its replacement, untracked"
  );
  assert.ok(abandoned.length <= 1, `it should have stopped after its cancelled command (ran ${abandoned.length})`);
  cancelSessionRun(id);
  await second;
});
test("cancelling a session run reports how much it stopped", async () => {
  const id = "checks-cancel";
  store.ensure(id, cwd);
  seedChecks(store, id, ["sleep 30"]);
  const inFlight = runAllChecks(store, id);
  await running2(id);
  assert.equal(cancelSessionRun(id), 1, "the in-flight command is the one that was stopped");
  await inFlight;
  assert.equal(cancelSessionRun(id), 0, "and a session with nothing in flight stops nothing");
});
//# sourceMappingURL=checks.test.js.map
