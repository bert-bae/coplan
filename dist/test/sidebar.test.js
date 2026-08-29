var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/ui/lib/api.ts
async function request(route, init) {
  const res = await fetch(route, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers ?? {} }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return await res.json();
}
var api;
var init_api = __esm({
  "src/ui/lib/api.ts"() {
    "use strict";
    api = {
      sessions: () => request("/api/sessions"),
      session: (id) => request(`/api/session/${id}`),
      /** Permanent: the daemon removes the session's on-disk directory too. */
      deleteSession: (id) => request(`/api/session/${id}`, { method: "DELETE" }),
      diff: (id, refresh = false) => request(`/api/session/${id}/diff${refresh ? "?refresh=1" : ""}`),
      resolveGate: (id, gateId, body) => request(`/api/session/${id}/gate/${gateId}/resolve`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
      feedback: (id, body) => request(`/api/session/${id}/feedback`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
      saveThreads: (id, threads) => request(`/api/session/${id}/threads`, {
        method: "POST",
        body: JSON.stringify({ threads })
      }),
      updateTask: (id, taskId, patch) => request(`/api/session/${id}/tasks/${taskId}`, {
        method: "POST",
        body: JSON.stringify(patch)
      }),
      reorderTasks: (id, ids) => request(`/api/session/${id}/tasks/reorder`, {
        method: "POST",
        body: JSON.stringify({ ids })
      }),
      replyToThread: (id, threadId, text) => request(`/api/session/${id}/thread/${threadId}/reply`, {
        method: "POST",
        body: JSON.stringify({ text })
      }),
      resolveThread: (id, threadId, resolved) => request(`/api/session/${id}/thread/${threadId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolved })
      }),
      addCheck: (id, command) => request(`/api/session/${id}/checks`, {
        method: "POST",
        body: JSON.stringify({ command })
      }),
      runChecks: (id, checkId) => request(`/api/session/${id}/checks/run`, {
        method: "POST",
        body: JSON.stringify(checkId ? { checkId } : {})
      }),
      cancelCheck: (id, checkId) => request(`/api/session/${id}/checks/cancel`, {
        method: "POST",
        body: JSON.stringify({ checkId })
      }),
      shipPreview: (id) => request(
        `/api/session/${id}/ship`
      ),
      executeShip: (id, ship) => request(
        `/api/session/${id}/ship`,
        { method: "POST", body: JSON.stringify({ ship }) }
      )
    };
  }
});

// src/ui/store.ts
var store_exports = {};
__export(store_exports, {
  describeError: () => describeError,
  gateHeadline: () => gateHeadline,
  store: () => store,
  tabForGate: () => tabForGate,
  tabForSession: () => tabForSession,
  useDrafts: () => useDrafts,
  useOpenGate: () => useOpenGate,
  useSession: () => useSession,
  useStore: () => useStore
});
import { useSyncExternalStore } from "react";
function describeError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
function readHash() {
  const match = /^#\/session\/([^/?]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}
function pickDefaultSession(sessions) {
  const waiting = sessions.find((s) => s.openGates > 0);
  return (waiting ?? sessions[0])?.sessionId ?? null;
}
function tabForGate(gate) {
  switch (gate.kind) {
    case "plan":
      return "plan";
    case "code_review":
      return "review";
    case "verification":
      return "verify";
    case "ship":
      return "ship";
    default:
      return "timeline";
  }
}
function tabForSession(session) {
  const gate = session.gates.find((g) => g.status === "open");
  if (gate) return tabForGate(gate);
  switch (session.stage) {
    case "planning":
    case "plan_review":
      return "plan";
    case "implementing":
      return "board";
    case "code_review":
      return "review";
    case "verification":
      return "verify";
    case "ship":
    case "done":
      return "ship";
    default:
      return "timeline";
  }
}
function gateHeadline(gate) {
  switch (gate.kind) {
    case "plan":
      return "Claude is waiting on your review of the plan";
    case "code_review":
      return "Claude is waiting on your review of the code";
    case "verification":
      return "Claude is waiting on your sign-off of the checks";
    case "ship":
      return "Claude is waiting on your confirmation to ship";
    default:
      return "Claude is waiting on you";
  }
}
function notify(title, body) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification(title, { body, tag: "cc-harness-gate" });
  } catch {
  }
}
function loadDrafts() {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveDrafts(drafts) {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
  }
}
function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    const prefs = {};
    if (saved["diffMode"] === "unified" || saved["diffMode"] === "split") prefs.diffMode = saved["diffMode"];
    if (typeof saved["collapsedSidebar"] === "boolean") prefs.collapsedSidebar = saved["collapsedSidebar"];
    if (Array.isArray(saved["pinned"])) prefs.pinned = saved["pinned"].filter((v) => typeof v === "string");
    if (Array.isArray(saved["collapsedProjects"])) {
      prefs.collapsedProjects = saved["collapsedProjects"].filter((v) => typeof v === "string");
    }
    return prefs;
  } catch {
    return {};
  }
}
function savePrefs(prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
  }
}
function useStore(select) {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState())
  );
}
function useSession() {
  return useStore((s) => s.session);
}
function useOpenGate() {
  return useStore((s) => s.session?.gates.find((g) => g.status === "open") ?? null);
}
function useDrafts() {
  return useStore((s) => s.sessionId ? s.drafts[s.sessionId] ?? EMPTY_DRAFTS : EMPTY_DRAFTS);
}
var initial, DRAFTS_KEY, PREFS_KEY, Store, store, EMPTY_DRAFTS;
var init_store = __esm({
  "src/ui/store.ts"() {
    "use strict";
    init_api();
    initial = {
      sessions: [],
      sessionId: null,
      session: null,
      diff: null,
      diffLoading: false,
      tab: "timeline",
      connection: "connecting",
      drafts: {},
      diffMode: "unified",
      selectedFile: null,
      viewedFiles: {},
      collapsedSidebar: false,
      pinned: [],
      collapsedProjects: [],
      toasts: [],
      error: null
    };
    DRAFTS_KEY = "cc-harness:drafts";
    PREFS_KEY = "cc-harness:prefs";
    Store = class {
      state = { ...initial, ...loadPrefs(), drafts: loadDrafts() };
      listeners = /* @__PURE__ */ new Set();
      source = null;
      reconnectTimer;
      getState = () => this.state;
      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };
      emit() {
        for (const listener of this.listeners) listener();
      }
      /** Every mutation goes through here so the snapshot identity always changes. */
      set(patch) {
        this.state = { ...this.state, ...patch };
        this.emit();
      }
      /* ---------------------------------------------------------------- *
       * Boot
       * ---------------------------------------------------------------- */
      async init() {
        const url = new URL(window.location.href);
        if (url.searchParams.has("token")) {
          url.searchParams.delete("token");
          window.history.replaceState({}, "", `${url.pathname}${url.hash}`);
        }
        try {
          const { sessions } = await api.sessions();
          this.set({ sessions });
          const target = readHash() ?? pickDefaultSession(sessions);
          if (target) await this.selectSession(target, false);
        } catch (err) {
          this.set({ error: describeError(err) });
        }
        this.connect();
        window.addEventListener("hashchange", () => {
          const id = readHash();
          if (id && id !== this.state.sessionId) void this.selectSession(id, false);
        });
      }
      async selectSession(id, updateHash = true) {
        if (updateHash) window.location.hash = `#/session/${id}`;
        this.set({ sessionId: id, session: null, diff: null, selectedFile: null, error: null });
        try {
          const { session, diff } = await api.session(id);
          this.set({ session, diff, tab: tabForSession(session) });
          if (!diff && session.stage === "code_review") void this.refreshDiff(false);
        } catch (err) {
          this.set({ error: describeError(err) });
        }
        this.connect();
      }
      async refreshDiff(force = true) {
        const id = this.state.sessionId;
        if (!id) return;
        this.set({ diffLoading: true });
        try {
          const { diff } = await api.diff(id, force);
          this.set({ diff, diffLoading: false });
        } catch (err) {
          this.set({ diffLoading: false, error: describeError(err) });
        }
      }
      /* ---------------------------------------------------------------- *
       * Live connection
       * ---------------------------------------------------------------- */
      connect() {
        this.source?.close();
        window.clearTimeout(this.reconnectTimer);
        const query = this.state.sessionId ? `?session=${encodeURIComponent(this.state.sessionId)}` : "";
        const source = new EventSource(`/api/events${query}`);
        this.source = source;
        source.onopen = () => this.set({ connection: "live" });
        source.onerror = () => {
          this.set({ connection: "reconnecting" });
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = window.setTimeout(() => void this.resync(), 5e3);
        };
        source.onmessage = (message) => {
          try {
            this.apply(JSON.parse(message.data));
          } catch {
          }
        };
      }
      async resync() {
        if (this.state.connection === "live" || !this.state.sessionId) return;
        try {
          const { session, diff } = await api.session(this.state.sessionId);
          this.set({ session, diff, connection: "live" });
        } catch {
        }
      }
      apply(event) {
        const current = this.state.session;
        switch (event.type) {
          case "ping":
            return;
          case "sessions":
            this.set({ sessions: event.sessions });
            return;
          case "snapshot":
            if (event.session.sessionId !== this.state.sessionId) return;
            this.announceGate(current, event.session);
            this.set({ session: event.session });
            return;
          case "state": {
            if (event.sessionId !== this.state.sessionId || !current) return;
            const next = { ...current, ...event.patch };
            this.announceGate(current, next);
            this.set({ session: next });
            return;
          }
          case "timeline": {
            if (event.sessionId !== this.state.sessionId || !current) return;
            const timeline = [...current.timeline, ...event.events].slice(-800);
            this.set({ session: { ...current, timeline } });
            return;
          }
          case "diff":
            if (event.sessionId !== this.state.sessionId) return;
            this.set({ diff: event.diff, diffLoading: false });
            return;
          case "tasks": {
            if (event.sessionId !== this.state.sessionId || !current) return;
            this.set({ session: { ...current, tasks: event.tasks } });
            return;
          }
          case "check": {
            if (event.sessionId !== this.state.sessionId || !current) return;
            const checks = current.checks.some((c) => c.id === event.check.id) ? current.checks.map((c) => c.id === event.check.id ? event.check : c) : [...current.checks, event.check];
            this.set({ session: { ...current, checks } });
            return;
          }
        }
      }
      /** A newly opened gate is the one thing that should pull the user in. */
      announceGate(before, after2) {
        const wasOpen = before?.gates.find((g) => g.status === "open")?.id;
        const nowOpen = after2.gates.find((g) => g.status === "open");
        if (!nowOpen || nowOpen.id === wasOpen) return;
        this.set({ tab: tabForGate(nowOpen) });
        this.toast("info", gateHeadline(nowOpen));
        notify(gateHeadline(nowOpen), after2.title);
      }
      /* ---------------------------------------------------------------- *
       * Draft comments
       * ---------------------------------------------------------------- */
      drafts(sessionId = this.state.sessionId) {
        return sessionId && this.state.drafts[sessionId] || [];
      }
      setDrafts(sessionId, drafts) {
        const next = { ...this.state.drafts, [sessionId]: drafts };
        if (drafts.length === 0) delete next[sessionId];
        this.set({ drafts: next });
        saveDrafts(next);
      }
      addDraft(comment) {
        const id = this.state.sessionId;
        if (!id) return;
        this.setDrafts(id, [...this.drafts(id), { ...comment, draft: true }]);
      }
      updateDraft(commentId, body) {
        const id = this.state.sessionId;
        if (!id) return;
        this.setDrafts(
          id,
          this.drafts(id).map((c) => c.id === commentId ? { ...c, body } : c)
        );
      }
      removeDraft(commentId) {
        const id = this.state.sessionId;
        if (!id) return;
        this.setDrafts(
          id,
          this.drafts(id).filter((c) => c.id !== commentId)
        );
      }
      clearDrafts(sessionId = this.state.sessionId) {
        if (!sessionId) return;
        this.setDrafts(sessionId, []);
      }
      /* ---------------------------------------------------------------- *
       * Local preferences
       * ---------------------------------------------------------------- */
      setTab(tab) {
        this.set({ tab });
      }
      /** Persist the slice of state that is a preference rather than a snapshot. */
      persistPrefs() {
        savePrefs({
          diffMode: this.state.diffMode,
          collapsedSidebar: this.state.collapsedSidebar,
          pinned: this.state.pinned,
          collapsedProjects: this.state.collapsedProjects
        });
      }
      setDiffMode(diffMode) {
        this.set({ diffMode });
        this.persistPrefs();
      }
      toggleSidebar() {
        this.set({ collapsedSidebar: !this.state.collapsedSidebar });
        this.persistPrefs();
      }
      /** Pinned sessions sort to the top of their project, and above every other
       *  project. Purely a reading aid, so it lives in localStorage. */
      togglePin(sessionId) {
        const pinned = this.state.pinned.includes(sessionId) ? this.state.pinned.filter((id) => id !== sessionId) : [...this.state.pinned, sessionId];
        this.set({ pinned });
        this.persistPrefs();
      }
      toggleProject(key) {
        const collapsedProjects = this.state.collapsedProjects.includes(key) ? this.state.collapsedProjects.filter((k) => k !== key) : [...this.state.collapsedProjects, key];
        this.set({ collapsedProjects });
        this.persistPrefs();
      }
      /**
       * Delete a session for good.
       *
       * The daemon broadcasts a new session list, but the local state that hangs
       * off this id — drafts, viewed files, the pin — is the client's own and has
       * to be cleaned up here or it leaks forever in localStorage.
       */
      async deleteSession(sessionId) {
        try {
          await api.deleteSession(sessionId);
        } catch (err) {
          this.fail(err);
          return;
        }
        const drafts = { ...this.state.drafts };
        delete drafts[sessionId];
        const viewedFiles = { ...this.state.viewedFiles };
        delete viewedFiles[sessionId];
        const sessions = this.state.sessions.filter((s) => s.sessionId !== sessionId);
        this.set({
          sessions,
          drafts,
          viewedFiles,
          pinned: this.state.pinned.filter((id) => id !== sessionId)
        });
        saveDrafts(drafts);
        this.persistPrefs();
        if (this.state.sessionId === sessionId) {
          this.set({ sessionId: null, session: null, diff: null, selectedFile: null });
          window.location.hash = "";
          const next = pickDefaultSession(sessions);
          if (next) await this.selectSession(next);
        }
        this.toast("success", "Session deleted.");
      }
      toggleViewed(file) {
        const id = this.state.sessionId;
        if (!id) return;
        const current = this.state.viewedFiles[id] ?? [];
        const next = current.includes(file) ? current.filter((f) => f !== file) : [...current, file];
        this.set({ viewedFiles: { ...this.state.viewedFiles, [id]: next } });
      }
      isViewed(file) {
        const id = this.state.sessionId;
        return Boolean(id && (this.state.viewedFiles[id] ?? []).includes(file));
      }
      selectFile(path) {
        this.set({ selectedFile: path });
      }
      /* ---------------------------------------------------------------- *
       * Notices
       * ---------------------------------------------------------------- */
      toast(kind, text) {
        const toast = { id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, kind, text };
        this.set({ toasts: [...this.state.toasts, toast] });
        window.setTimeout(() => this.dismissToast(toast.id), kind === "error" ? 8e3 : 4e3);
      }
      dismissToast(id) {
        this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
      }
      fail(err) {
        this.toast("error", describeError(err));
      }
    };
    store = new Store();
    EMPTY_DRAFTS = [];
  }
});

// src/ui/lib/format.ts
function relativeTime(ts, now = Date.now()) {
  const delta = Math.max(0, now - ts);
  const seconds = Math.round(delta / 1e3);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1e3));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function splitPath(path) {
  const index = path.lastIndexOf("/");
  if (index < 0) return { dir: "", name: path };
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}
function lineRef(file, startLine, endLine) {
  return startLine === endLine ? `${file}:${startLine}` : `${file}:${startLine}-${endLine}`;
}
function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
function classNames(...parts) {
  return parts.filter(Boolean).join(" ");
}
var init_format = __esm({
  "src/ui/lib/format.ts"() {
    "use strict";
  }
});

// src/ui/components/Sidebar.tsx
import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.sessionId);
  const connection = useStore((s) => s.connection);
  const collapsed = useStore((s) => s.collapsedSidebar);
  const pinned = useStore((s) => s.pinned);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const groups = groupSessions(sessions, pinned);
  return /* @__PURE__ */ jsxs("aside", { className: classNames("sidebar", collapsed && "is-collapsed"), children: [
    /* @__PURE__ */ jsxs("header", { className: "sidebar-head", children: [
      /* @__PURE__ */ jsx("span", { className: "logo", "aria-hidden": "true", children: "cc" }),
      /* @__PURE__ */ jsxs("div", { className: "sidebar-brand", children: [
        /* @__PURE__ */ jsx("strong", { children: "harness" }),
        /* @__PURE__ */ jsx("span", { className: classNames("conn", `is-${connection}`), children: connection === "live" ? "live" : connection === "connecting" ? "connecting\u2026" : "reconnecting\u2026" })
      ] }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "icon-btn",
          title: collapsed ? "Expand sidebar" : "Collapse sidebar",
          onClick: () => store.toggleSidebar(),
          children: collapsed ? "\u203A" : "\u2039"
        }
      )
    ] }),
    /* @__PURE__ */ jsx("nav", { className: "session-list", children: sessions.length === 0 ? /* @__PURE__ */ jsx("p", { className: "sidebar-empty", children: "No sessions yet." }) : groups.map((group) => /* @__PURE__ */ jsx(
      ProjectGroup,
      {
        group,
        current,
        open: !collapsedProjects.includes(group.key),
        showRepo: group.key === PINNED_KEY
      },
      group.key
    )) }),
    /* @__PURE__ */ jsx("footer", { className: "sidebar-foot", children: /* @__PURE__ */ jsxs("span", { children: [
      "v",
      true ? "0.1.0" : "dev"
    ] }) })
  ] });
}
function groupSessions(sessions, pinned) {
  const pinnedSet = new Set(pinned);
  const groups = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const key = pinnedSet.has(session.sessionId) ? PINNED_KEY : session.repoRoot ?? session.cwd;
    let group = groups.get(key);
    if (!group) {
      group = key === PINNED_KEY ? { key, label: "Pinned", path: "", sessions: [], openGates: 0 } : {
        key,
        label: session.repoName ?? basename(session.cwd) ?? "Unknown project",
        path: session.repoRoot ?? session.cwd,
        sessions: [],
        openGates: 0
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.openGates += session.openGates;
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === PINNED_KEY) return -1;
    if (b.key === PINNED_KEY) return 1;
    return (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0);
  });
}
function basename(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function ProjectGroup({
  group,
  current,
  open,
  showRepo
}) {
  const holdsCurrent = group.sessions.some((s) => s.sessionId === current);
  const expanded = open || holdsCurrent;
  return /* @__PURE__ */ jsxs("section", { className: classNames("session-group", expanded && "is-open"), children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        className: "session-group-head",
        "aria-expanded": expanded,
        title: group.path || void 0,
        onClick: () => store.toggleProject(group.key),
        children: [
          /* @__PURE__ */ jsx("span", { className: "session-group-chevron", "aria-hidden": "true", children: expanded ? "\u25BE" : "\u25B8" }),
          /* @__PURE__ */ jsx("span", { className: "session-group-name", children: group.label }),
          group.openGates > 0 && /* @__PURE__ */ jsx("span", { className: "dot is-gate", title: "A session here is waiting on you", "aria-label": "waiting on you" }),
          /* @__PURE__ */ jsx("span", { className: "session-group-count", children: group.sessions.length })
        ]
      }
    ),
    expanded && /* @__PURE__ */ jsx("div", { className: "session-group-body", children: group.sessions.map((s) => /* @__PURE__ */ jsx(
      SessionRow,
      {
        session: s,
        active: s.sessionId === current,
        showRepo
      },
      s.sessionId
    )) })
  ] });
}
function SessionRow({
  session,
  active,
  showRepo
}) {
  const drafts = useStore((s) => s.drafts[session.sessionId]?.length ?? 0);
  const pinned = useStore((s) => s.pinned.includes(session.sessionId));
  const [confirming, setConfirming] = useState(false);
  return /* @__PURE__ */ jsxs("div", { className: classNames("session-row", active && "is-active", confirming && "is-confirming"), children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        className: "session-open",
        onClick: () => void store.selectSession(session.sessionId),
        children: [
          /* @__PURE__ */ jsxs("span", { className: "session-name", children: [
            session.openGates > 0 && /* @__PURE__ */ jsx("span", { className: "dot is-gate", title: "Claude is waiting on you", "aria-label": "waiting on you" }),
            session.title
          ] }),
          /* @__PURE__ */ jsxs("span", { className: "session-sub", children: [
            /* @__PURE__ */ jsx("span", { className: "session-stage", children: STAGE_LABEL[session.stage] ?? session.stage }),
            session.branch && /* @__PURE__ */ jsx("span", { className: "session-branch", children: session.branch })
          ] }),
          /* @__PURE__ */ jsxs("span", { className: "session-foot", children: [
            showRepo && session.repoName && /* @__PURE__ */ jsx("span", { className: "session-repo", children: session.repoName }),
            /* @__PURE__ */ jsx("span", { children: relativeTime(session.updatedAt) }),
            drafts > 0 && /* @__PURE__ */ jsxs("span", { className: "pill is-draft", children: [
              drafts,
              " draft"
            ] }),
            session.pendingFeedback > 0 && /* @__PURE__ */ jsxs("span", { className: "pill is-queued", children: [
              session.pendingFeedback,
              " queued"
            ] })
          ] })
        ]
      }
    ),
    /* @__PURE__ */ jsxs("div", { className: "session-actions", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: classNames("icon-btn", "is-tiny", pinned && "is-active"),
          "aria-pressed": pinned,
          title: pinned ? "Unpin session" : "Pin session",
          onClick: () => store.togglePin(session.sessionId),
          children: pinned ? "\u2605" : "\u2606"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "icon-btn is-tiny is-danger",
          title: "Delete session",
          onClick: () => setConfirming(true),
          children: "\xD7"
        }
      )
    ] }),
    confirming && /* @__PURE__ */ jsxs("div", { className: "session-confirm", children: [
      /* @__PURE__ */ jsx("span", { children: "Delete permanently?" }),
      /* @__PURE__ */ jsxs("div", { className: "row-actions", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "link is-danger",
            onClick: () => {
              setConfirming(false);
              void store.deleteSession(session.sessionId);
            },
            children: "Delete"
          }
        ),
        /* @__PURE__ */ jsx("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Cancel" })
      ] })
    ] })
  ] });
}
var STAGE_LABEL, PINNED_KEY;
var init_Sidebar = __esm({
  "src/ui/components/Sidebar.tsx"() {
    "use strict";
    init_store();
    init_format();
    STAGE_LABEL = {
      idle: "Idle",
      planning: "Planning",
      plan_review: "Plan review",
      implementing: "Building",
      code_review: "Code review",
      verification: "Verifying",
      ship: "Shipping",
      done: "Done"
    };
    PINNED_KEY = "\0pinned";
  }
});

// src/ui/components/primitives.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  disabled,
  title,
  type = "button"
}) {
  return /* @__PURE__ */ jsx2(
    "button",
    {
      type,
      className: classNames("btn", `btn-${variant}`, size === "sm" && "btn-sm"),
      onClick,
      disabled,
      title,
      children
    }
  );
}
function Panel({
  title,
  actions,
  children,
  className
}) {
  return /* @__PURE__ */ jsxs2("section", { className: classNames("panel", className), children: [
    (title || actions) && /* @__PURE__ */ jsxs2("header", { className: "panel-head", children: [
      title && /* @__PURE__ */ jsx2("h3", { className: "panel-title", children: title }),
      actions && /* @__PURE__ */ jsx2("div", { className: "panel-actions", children: actions })
    ] }),
    children
  ] });
}
function EmptyState({
  title,
  hint,
  action
}) {
  return /* @__PURE__ */ jsxs2("div", { className: "empty-state", children: [
    /* @__PURE__ */ jsx2("p", { className: "empty-title", children: title }),
    hint && /* @__PURE__ */ jsx2("p", { className: "empty-hint", children: hint }),
    action
  ] });
}
function Explain({ children }) {
  return /* @__PURE__ */ jsx2("p", { className: "explain", children });
}
function Spinner({ label }) {
  return /* @__PURE__ */ jsxs2("span", { className: "spinner-wrap", children: [
    /* @__PURE__ */ jsx2("span", { className: "spinner", "aria-hidden": "true" }),
    label && /* @__PURE__ */ jsx2("span", { className: "muted", children: label })
  ] });
}
var init_primitives = __esm({
  "src/ui/components/primitives.tsx"() {
    "use strict";
    init_format();
  }
});

// src/ui/components/GateBanner.tsx
import { useEffect, useState as useState2 } from "react";
import { Fragment, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function GateBanner() {
  const gate = useOpenGate();
  const session = useSession();
  const pending = session?.pendingFeedback ?? [];
  const elapsed = useElapsed(gate?.createdAt);
  if (!gate) {
    if (pending.length === 0) return null;
    return /* @__PURE__ */ jsxs3("div", { className: "gate-banner is-queued", role: "status", children: [
      /* @__PURE__ */ jsx3("span", { className: "gate-icon", "aria-hidden": "true", children: "\u2709" }),
      /* @__PURE__ */ jsxs3("div", { className: "gate-copy", children: [
        /* @__PURE__ */ jsxs3("strong", { children: [
          pending.length,
          " message",
          pending.length === 1 ? "" : "s",
          " queued"
        ] }),
        /* @__PURE__ */ jsx3("span", { className: "gate-sub", children: session?.status === "idle" ? "Claude has finished its turn. These reach it when the session next runs \u2014 prompt it in the terminal, or wait for its next turn." : "Delivered at the end of the turn Claude is running now." })
      ] })
    ] });
  }
  const parked = gate.waiting;
  return /* @__PURE__ */ jsxs3("div", { className: parked ? "gate-banner is-blocking" : "gate-banner is-open", role: "alert", "aria-live": "assertive", children: [
    /* @__PURE__ */ jsx3("span", { className: "gate-icon", "aria-hidden": "true", children: parked ? "\u23F8" : "\u25F7" }),
    /* @__PURE__ */ jsxs3("div", { className: "gate-copy", children: [
      /* @__PURE__ */ jsx3("strong", { children: gateHeadline(gate) }),
      /* @__PURE__ */ jsx3("span", { className: "gate-sub", children: parked ? /* @__PURE__ */ jsxs3(Fragment, { children: [
        "The terminal session is parked and will not continue until you answer \xB7 waiting ",
        elapsed
      ] }) : /* @__PURE__ */ jsxs3(Fragment, { children: [
        "Claude has gone idle with this open \xB7 opened ",
        elapsed,
        " ago. Your answer is still delivered when it next runs."
      ] }) })
    ] }),
    /* @__PURE__ */ jsx3(Button, { variant: "primary", onClick: () => store.setTab(tabForGate(gate)), children: "Answer" })
  ] });
}
function useElapsed(since) {
  const [now, setNow] = useState2(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1e3);
    return () => window.clearInterval(timer);
  }, [since]);
  if (!since) return "";
  return duration(now - since);
}
var init_GateBanner = __esm({
  "src/ui/components/GateBanner.tsx"() {
    "use strict";
    init_store();
    init_primitives();
    init_format();
  }
});

// src/ui/components/Composer.tsx
import { useState as useState3 } from "react";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function Composer() {
  const session = useSession();
  const gate = useOpenGate();
  const drafts = useDrafts();
  const [text, setText] = useState3("");
  const [sending, setSending] = useState3(false);
  if (!session) return null;
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await api.feedback(session.sessionId, { text: body, origin: "timeline" });
      setText("");
      store.toast(
        "success",
        session.status === "idle" ? "Queued. Claude receives it the next time the session runs." : "Sent \u2014 Claude receives it at the end of this turn."
      );
    } catch (err) {
      store.fail(err);
    } finally {
      setSending(false);
    }
  };
  return /* @__PURE__ */ jsxs4("div", { className: "composer", children: [
    gate && /* @__PURE__ */ jsxs4("div", { className: "composer-notice", children: [
      /* @__PURE__ */ jsxs4("span", { children: [
        "Claude is waiting at the ",
        /* @__PURE__ */ jsx4("strong", { children: gateLabel(gate.kind) }),
        " gate. A message here does",
        " ",
        /* @__PURE__ */ jsx4("em", { children: "not" }),
        " answer it."
      ] }),
      /* @__PURE__ */ jsx4("button", { type: "button", className: "link", onClick: () => store.setTab(tabForGate(gate)), children: "Go answer the gate \u2192" })
    ] }),
    /* @__PURE__ */ jsxs4("div", { className: "composer-row", children: [
      /* @__PURE__ */ jsx4(
        "textarea",
        {
          className: "composer-input",
          rows: 2,
          value: text,
          placeholder: "Message this session\u2026",
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
          }
        }
      ),
      /* @__PURE__ */ jsxs4("div", { className: "composer-side", children: [
        /* @__PURE__ */ jsx4(Button, { variant: "primary", onClick: () => void send(), disabled: !text.trim() || sending, children: sending ? "Sending\u2026" : "Send message" }),
        /* @__PURE__ */ jsx4("span", { className: "composer-hint", children: deliveryHint(session.status) })
      ] })
    ] }),
    drafts.length > 0 && /* @__PURE__ */ jsxs4("p", { className: "composer-warn", children: [
      "You have ",
      drafts.length,
      " unsent line comment",
      drafts.length === 1 ? "" : "s",
      ". A message here does not include them \u2014 submit your review to send those."
    ] })
  ] });
}
function deliveryHint(status) {
  switch (status) {
    case "active":
      return "\u2318\u21B5 \xB7 arrives at the end of this turn";
    case "waiting":
      return "\u2318\u21B5 \xB7 queued until the gate is answered";
    case "ended":
      return "this session has ended";
    default:
      return "\u2318\u21B5 \xB7 queued for the next turn";
  }
}
function gateLabel(kind) {
  return kind.replace("_", " ");
}
var init_Composer = __esm({
  "src/ui/components/Composer.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_primitives();
    init_store();
  }
});

// src/ui/components/Toasts.tsx
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return /* @__PURE__ */ jsx5("div", { className: "toasts", role: "status", "aria-live": "polite", children: toasts.map((toast) => /* @__PURE__ */ jsxs5("div", { className: classNames("toast", `is-${toast.kind}`), children: [
    /* @__PURE__ */ jsx5("span", { children: toast.text }),
    /* @__PURE__ */ jsx5(
      "button",
      {
        type: "button",
        className: "toast-close",
        "aria-label": "Dismiss",
        onClick: () => store.dismissToast(toast.id),
        children: "\xD7"
      }
    )
  ] }, toast.id)) });
}
var init_Toasts = __esm({
  "src/ui/components/Toasts.tsx"() {
    "use strict";
    init_store();
    init_format();
  }
});

// src/ui/components/ConnectionBar.tsx
import { useEffect as useEffect2, useState as useState4 } from "react";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function ConnectionBar() {
  const connection = useStore((s) => s.connection);
  const [since, setSince] = useState4(null);
  const [now, setNow] = useState4(Date.now());
  useEffect2(() => {
    if (connection === "live") {
      setSince(null);
      return;
    }
    setSince((current) => current ?? Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1e3);
    return () => window.clearInterval(timer);
  }, [connection]);
  if (connection === "live" || !since || now - since < 2e3) return null;
  return /* @__PURE__ */ jsxs6("div", { className: "conn-bar", role: "status", children: [
    /* @__PURE__ */ jsx6("span", { "aria-hidden": "true", children: "\u26A0" }),
    /* @__PURE__ */ jsxs6("span", { children: [
      "Reconnecting \u2014 last update ",
      duration(now - since),
      " ago. What you see may be out of date."
    ] })
  ] });
}
var init_ConnectionBar = __esm({
  "src/ui/components/ConnectionBar.tsx"() {
    "use strict";
    init_store();
    init_format();
  }
});

// src/ui/components/ThemeToggle.tsx
import { useEffect as useEffect3, useState as useState5 } from "react";
import { jsx as jsx7 } from "react/jsx-runtime";
function ThemeToggle() {
  const [theme, setTheme] = useState5(() => {
    try {
      return window.localStorage.getItem(KEY) || "system";
    } catch {
      return "system";
    }
  });
  useEffect3(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(KEY, theme);
    } catch {
    }
  }, [theme]);
  const next = { system: "light", light: "dark", dark: "system" };
  const label = { system: "Auto", light: "Light", dark: "Dark" };
  return /* @__PURE__ */ jsx7(
    "button",
    {
      type: "button",
      className: "icon-btn",
      title: `Theme: ${label[theme]} \u2014 click to change`,
      onClick: () => setTheme(next[theme]),
      children: theme === "dark" ? "\u25D0" : theme === "light" ? "\u25CB" : "\u25D1"
    }
  );
}
var KEY;
var init_ThemeToggle = __esm({
  "src/ui/components/ThemeToggle.tsx"() {
    "use strict";
    KEY = "cc-harness:theme";
  }
});

// src/ui/lib/markdown.ts
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function matchXmlBlock(lines, i) {
  const open = /^\s*<([A-Za-z][\w:.-]*)\s*>(.*)$/.exec(lines[i] ?? "");
  if (!open) return null;
  const raw = open[1];
  const tag = raw.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(XML_BLOCKS, tag)) return null;
  const close = `</${raw}>`;
  const rest = open[2] ?? "";
  const inline2 = rest.indexOf(close);
  if (inline2 >= 0) return { tag, body: rest.slice(0, inline2), endLine: i };
  const body = rest ? [rest] : [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    const at = line.indexOf(close);
    if (at >= 0) {
      if (line.slice(0, at)) body.push(line.slice(0, at));
      return { tag, body: body.join("\n"), endLine: j };
    }
    body.push(line);
  }
  return null;
}
function renderCommandGroup(fields) {
  const name = fields.get("command-name")?.trim();
  const args = fields.get("command-args")?.trim();
  const message = fields.get("command-message")?.trim();
  const head = [];
  if (name) head.push(`<span class="md-command-name">${escapeHtml(name)}</span>`);
  if (args) head.push(`<span class="md-command-args">${escapeHtml(args)}</span>`);
  const extra = message && message !== name && `/${message}` !== name ? message : "";
  return `<div class="md-command">` + (head.length ? `<div class="md-command-head">${head.join("")}</div>` : "") + (extra ? `<div class="md-command-message">${escapeHtml(extra)}</div>` : "") + `</div>`;
}
function renderDetailsBlock(spec, tag, body) {
  const text = body.replace(/^\n+|\n+$/g, "");
  return `<details class="md-xml is-${escapeHtml(tag)}"><summary>${escapeHtml(spec.label)}</summary><pre class="md-xml-body">${escapeHtml(text)}</pre></details>`;
}
function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuffer = [];
  let paragraph = [];
  const lists = [];
  let command = null;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeDeepestList = () => {
    const list = lists.pop();
    if (!list) return;
    out.push("</li>");
    out.push(`</${list.type}>`);
  };
  const closeLists = () => {
    while (lists.length) closeDeepestList();
  };
  const flushCommand = () => {
    if (!command) return;
    out.push(renderCommandGroup(command));
    command = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    closeLists();
    flushCommand();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        out.push(
          `<pre class="md-code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ""}><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`
        );
        codeBuffer = [];
        inCode = false;
        codeLang = "";
      } else {
        flushBlocks();
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    const xml = matchXmlBlock(lines, i);
    if (xml) {
      const spec = XML_BLOCKS[xml.tag];
      if (spec.mode === "command") {
        flushParagraph();
        closeLists();
        command ??= /* @__PURE__ */ new Map();
        command.set(xml.tag, xml.body);
      } else {
        flushBlocks();
        out.push(renderDetailsBlock(spec, xml.tag, xml.body));
      }
      i = xml.endLine;
      continue;
    }
    if (!line.trim()) {
      flushBlocks();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushBlocks();
      const level = heading[1].length + 1;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const table = matchTable(lines, i);
    if (table) {
      flushBlocks();
      out.push(table.html);
      i = table.endLine;
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushBlocks();
      out.push("<hr />");
      continue;
    }
    const item = matchListItem(line);
    if (item) {
      flushParagraph();
      flushCommand();
      pushListItem(out, lists, item);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushBlocks();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode && codeBuffer.length) {
    out.push(`<pre class="md-code"><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  }
  flushBlocks();
  return out.join("\n");
}
function matchListItem(line) {
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  const ordered = bullet ? null : /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
  const match = bullet ?? ordered;
  if (!match) return null;
  const indent = (match[1] ?? "").replace(/\t/g, "  ").length;
  let content = match[2] ?? "";
  const item = { type: bullet ? "ul" : "ol", indent, content };
  const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
  if (task && bullet) {
    item.task = true;
    item.checked = task[1] !== " ";
    content = task[2] ?? "";
    item.content = content;
  }
  return item;
}
function pushListItem(out, lists, item) {
  const closeDeepest = () => {
    const list = lists.pop();
    if (!list) return;
    out.push("</li>");
    out.push(`</${list.type}>`);
  };
  while (lists.length > 1 && item.indent < lists[lists.length - 1].indent) closeDeepest();
  const top = lists[lists.length - 1];
  if (!top || item.indent > top.indent) {
    out.push(`<${item.type}>`);
    lists.push({ type: item.type, indent: item.indent });
  } else if (top.type !== item.type) {
    closeDeepest();
    out.push(`<${item.type}>`);
    lists.push({ type: item.type, indent: item.indent });
  } else {
    out.push("</li>");
  }
  const box = item.task ? `<input type="checkbox" disabled${item.checked ? " checked" : ""} /> ` : "";
  const cls = item.task ? ` class="md-task${item.checked ? " is-done" : ""}"` : "";
  out.push(`<li${cls}>${box}${inline(item.content)}`);
}
function matchTable(lines, i) {
  const header = lines[i] ?? "";
  const divider = lines[i + 1] ?? "";
  if (!/\|/.test(header)) return null;
  if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(divider)) return null;
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const heads = cells(header);
  const aligns = cells(divider).map(
    (c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""
  );
  const align = (n) => aligns[n] ? ` style="text-align:${aligns[n]}"` : "";
  const body = [];
  let end = i + 1;
  for (let j = i + 2; j < lines.length; j++) {
    const row = lines[j] ?? "";
    if (!row.trim() || !row.includes("|")) break;
    const tds = cells(row).map((c, n) => `<td${align(n)}>${inline(c)}</td>`).join("");
    body.push(`<tr>${tds}</tr>`);
    end = j;
  }
  const ths = heads.map((c, n) => `<th${align(n)}>${inline(c)}</th>`).join("");
  const html = `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead>` + (body.length ? `<tbody>${body.join("")}</tbody>` : "") + `</table></div>`;
  return { html, endLine: end };
}
function inline(text) {
  let html = escapeHtml(text);
  const spans = [];
  html = html.replace(/`([^`]+)`/g, (_all, body) => {
    spans.push(`<code>${body}</code>`);
    return `${CODE_MARK}${spans.length - 1}${CODE_MARK}`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  return html.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g"), (_all, n) => spans[Number(n)] ?? "");
}
var XML_BLOCKS, CODE_MARK;
var init_markdown = __esm({
  "src/ui/lib/markdown.ts"() {
    "use strict";
    XML_BLOCKS = {
      "command-name": { mode: "command", label: "name" },
      "command-args": { mode: "command", label: "args" },
      "command-message": { mode: "command", label: "message" },
      "system-reminder": { mode: "details", label: "system reminder" },
      "local-command-stdout": { mode: "details", label: "command output" },
      "local-command-stderr": { mode: "details", label: "command error output" },
      "user-prompt-submit-hook": { mode: "details", label: "hook output" },
      "ide_selection": { mode: "details", label: "editor selection" },
      "ide-selection": { mode: "details", label: "editor selection" },
      "function_results": { mode: "details", label: "tool result" },
      "task-notification": { mode: "details", label: "task notification" }
    };
    CODE_MARK = "\0";
  }
});

// src/ui/components/Markdown.tsx
import { useMemo } from "react";
import { jsx as jsx8 } from "react/jsx-runtime";
function Markdown({ source, className }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return /* @__PURE__ */ jsx8("div", { className: className ? `md ${className}` : "md", dangerouslySetInnerHTML: { __html: html } });
}
var init_Markdown = __esm({
  "src/ui/components/Markdown.tsx"() {
    "use strict";
    init_markdown();
  }
});

// src/ui/views/ActivityView.tsx
import { useEffect as useEffect4, useRef, useState as useState6 } from "react";
import { Fragment as Fragment2, jsx as jsx9, jsxs as jsxs7 } from "react/jsx-runtime";
function ActivityView() {
  const session = useSession();
  const [showThinking, setShowThinking] = useState6(false);
  const feed = useRef(null);
  const pinned = useRef(true);
  const events = (session?.timeline ?? []).filter((e) => showThinking || e.kind !== "thinking");
  useEffect4(() => {
    if (pinned.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [events.length]);
  if (!session) return null;
  const gate = session.gates.find((g) => g.status === "open" && g.kind === "question");
  const done = session.todos.filter((t) => t.status === "completed").length;
  const percent = session.todos.length ? Math.round(done / session.todos.length * 100) : 0;
  return /* @__PURE__ */ jsxs7("div", { className: "activity", children: [
    /* @__PURE__ */ jsxs7("div", { className: "activity-main", children: [
      gate && /* @__PURE__ */ jsx9(QuestionCard, { gate, sessionId: session.sessionId }),
      /* @__PURE__ */ jsxs7("div", { className: "feed-head", children: [
        /* @__PURE__ */ jsx9("strong", { children: "Activity" }),
        /* @__PURE__ */ jsxs7("label", { className: "toggle", children: [
          /* @__PURE__ */ jsx9("input", { type: "checkbox", checked: showThinking, onChange: (e) => setShowThinking(e.target.checked) }),
          "show reasoning"
        ] })
      ] }),
      /* @__PURE__ */ jsx9(
        "div",
        {
          className: "feed",
          ref: feed,
          onScroll: (e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          },
          children: events.length === 0 ? /* @__PURE__ */ jsx9(EmptyState, { title: "Nothing yet", hint: "Claude's output appears here as it works." }) : events.map((event) => /* @__PURE__ */ jsx9(Event, { event }, event.id))
        }
      )
    ] }),
    /* @__PURE__ */ jsxs7("aside", { className: "activity-side", children: [
      /* @__PURE__ */ jsx9(Panel, { title: "Progress", children: session.todos.length === 0 ? /* @__PURE__ */ jsx9("p", { className: "muted", children: "No task list yet." }) : /* @__PURE__ */ jsxs7(Fragment2, { children: [
        /* @__PURE__ */ jsx9("div", { className: "progress-bar", children: /* @__PURE__ */ jsx9("div", { className: "progress-fill", style: { width: `${percent}%` } }) }),
        /* @__PURE__ */ jsxs7("p", { className: "progress-label", children: [
          done,
          " of ",
          session.todos.length,
          " tasks complete"
        ] }),
        /* @__PURE__ */ jsx9("ul", { className: "todo-list", children: session.todos.map((todo, i) => /* @__PURE__ */ jsxs7("li", { className: classNames("todo", `is-${todo.status}`), children: [
          /* @__PURE__ */ jsx9("span", { className: "todo-mark", children: todo.status === "completed" ? "\u2713" : todo.status === "in_progress" ? "\u25D0" : "\u25CB" }),
          /* @__PURE__ */ jsx9("span", { children: todo.content })
        ] }, i)) })
      ] }) }),
      /* @__PURE__ */ jsx9(Panel, { title: `Files touched \xB7 ${session.files.length}`, children: session.files.length === 0 ? /* @__PURE__ */ jsx9("p", { className: "muted", children: "Nothing changed yet." }) : /* @__PURE__ */ jsx9("ul", { className: "touch-list", children: [...session.files].sort((a, b) => b.lastTouchedAt - a.lastTouchedAt).map((file) => /* @__PURE__ */ jsxs7("li", { children: [
        /* @__PURE__ */ jsx9("code", { title: file.path, children: file.path }),
        /* @__PURE__ */ jsxs7("span", { className: "muted", children: [
          pluralize(file.edits, "edit"),
          " \xB7 ",
          relativeTime(file.lastTouchedAt)
        ] })
      ] }, file.path)) }) }),
      /* @__PURE__ */ jsx9(Panel, { title: `Commands \xB7 ${session.commands.length}`, children: session.commands.length === 0 ? /* @__PURE__ */ jsx9("p", { className: "muted", children: "No shell commands yet." }) : /* @__PURE__ */ jsx9("ul", { className: "cmd-list", children: [...session.commands].slice(-25).reverse().map((run) => /* @__PURE__ */ jsx9("li", { className: run.ok ? "is-ok" : "is-failed", children: /* @__PURE__ */ jsx9("code", { children: run.command }) }, run.id)) }) })
    ] })
  ] });
}
function Event({ event }) {
  const prose = PROSE_KINDS.has(event.kind);
  return /* @__PURE__ */ jsxs7("article", { className: classNames("event", `is-${event.kind}`), children: [
    /* @__PURE__ */ jsx9("span", { className: "event-icon", title: event.kind, children: ICON[event.kind] ?? "\xB7" }),
    /* @__PURE__ */ jsxs7("div", { className: "event-body", children: [
      /* @__PURE__ */ jsxs7("div", { className: "event-meta", children: [
        event.label && /* @__PURE__ */ jsx9("span", { className: "event-label", children: event.label }),
        /* @__PURE__ */ jsx9("time", { children: clockTime(event.ts) })
      ] }),
      prose ? /* @__PURE__ */ jsx9(Markdown, { source: event.text }) : /* @__PURE__ */ jsx9("pre", { className: "event-text", children: event.text })
    ] })
  ] });
}
function QuestionCard({ gate, sessionId }) {
  const [answer, setAnswer] = useState6("");
  const [busy, setBusy] = useState6(false);
  const options = gate.meta?.options ?? [];
  const send = async (text) => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.resolveGate(sessionId, gate.id, { verdict: "answered", comment: body });
      store.toast("success", "Answer sent \u2014 Claude is resuming.");
      setAnswer("");
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs7("div", { className: "question-card", children: [
    /* @__PURE__ */ jsx9("h3", { children: "Claude is asking" }),
    /* @__PURE__ */ jsx9("p", { className: "question-text", children: gate.prompt }),
    options.length > 0 && /* @__PURE__ */ jsx9("div", { className: "question-options", children: options.map((option) => /* @__PURE__ */ jsx9(Button, { onClick: () => void send(option), disabled: busy, children: option }, option)) }),
    /* @__PURE__ */ jsx9(
      "textarea",
      {
        className: "input",
        rows: 3,
        value: answer,
        placeholder: "Your answer\u2026",
        onChange: (e) => setAnswer(e.target.value),
        onKeyDown: (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send(answer);
        }
      }
    ),
    /* @__PURE__ */ jsx9("div", { className: "row-actions", children: /* @__PURE__ */ jsx9(Button, { variant: "primary", onClick: () => void send(answer), disabled: !answer.trim() || busy, children: "Send answer" }) })
  ] });
}
var ICON, PROSE_KINDS;
var init_ActivityView = __esm({
  "src/ui/views/ActivityView.tsx"() {
    "use strict";
    init_store();
    init_Markdown();
    init_primitives();
    init_api();
    init_primitives();
    init_format();
    ICON = {
      assistant: "\u25CF",
      thinking: "\u25E6",
      tool: "\u203A",
      stage: "\u25B8",
      note: "\xB7",
      user: "\xBB",
      feedback: "\u270E",
      notification: "!",
      gate: "\u23F8",
      check: "\u2713",
      ship: "\u21E7",
      error: "\u2717"
    };
    PROSE_KINDS = /* @__PURE__ */ new Set([
      "assistant",
      "user",
      "feedback",
      "thinking",
      "note",
      "notification",
      "gate",
      "ship"
    ]);
  }
});

// src/ui/views/PlanView.tsx
import { useEffect as useEffect5, useMemo as useMemo2, useRef as useRef2, useState as useState7 } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Fragment as Fragment3, jsx as jsx10, jsxs as jsxs8 } from "react/jsx-runtime";
function PlanView() {
  const session = useSession();
  const gate = useOpenGate();
  const sessionId = useStore((s) => s.sessionId);
  const plan = session?.plan ?? null;
  const [steps, setSteps] = useState7(() => plan?.steps.map(clone) ?? []);
  const [baseRevision, setBaseRevision] = useState7(plan?.revision ?? 0);
  const [summary2, setSummary] = useState7("");
  const [busy, setBusy] = useState7(false);
  const [announcement, setAnnouncement] = useState7("");
  const dirty = useRef2(false);
  const incoming = plan && plan.revision !== baseRevision ? plan : null;
  useEffect5(() => {
    if (!plan) return;
    if (plan.revision === baseRevision) return;
    if (dirty.current) return;
    setSteps(plan.steps.map(clone));
    setBaseRevision(plan.revision);
  }, [plan, baseRevision]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const ids = useMemo2(() => steps.map((s) => s.id), [steps]);
  if (!plan) {
    return /* @__PURE__ */ jsx10("div", { className: "view-pad", children: /* @__PURE__ */ jsx10(
      EmptyState,
      {
        title: "No plan published yet",
        hint: /* @__PURE__ */ jsxs8(Fragment3, { children: [
          "Ask Claude to run ",
          /* @__PURE__ */ jsx10("code", { children: "/harness" }),
          ", or call ",
          /* @__PURE__ */ jsx10("code", { children: "harness_publish_plan" }),
          ". The plan appears here for you to edit and approve before it starts building."
        ] })
      }
    ) });
  }
  const edit = (fn) => {
    dirty.current = true;
    setSteps((current) => fn(current));
  };
  const move = (from, to) => {
    if (to < 0 || to >= steps.length) return;
    edit((current) => {
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setAnnouncement(`Step moved to position ${to + 1} of ${steps.length}`);
  };
  const onDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = steps.findIndex((s) => s.id === active.id);
    const to = steps.findIndex((s) => s.id === over.id);
    if (from < 0 || to < 0) return;
    move(from, to);
  };
  const submit = async (verdict) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      if (gate) {
        await api.resolveGate(sessionId, gate.id, { verdict, comment: summary2.trim(), steps });
        store.toast("success", verdict === "approved" ? "Plan approved \u2014 Claude is resuming." : "Sent to Claude.");
      } else {
        await api.feedback(sessionId, { text: describeEdits(plan.steps, steps, summary2.trim()), origin: "plan" });
        store.toast("success", "Queued for Claude's next turn.");
      }
      setSummary("");
      dirty.current = false;
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };
  const live = steps.filter((s) => s.status !== "dropped");
  return /* @__PURE__ */ jsxs8("div", { className: "plan", children: [
    /* @__PURE__ */ jsxs8("div", { className: "plan-main", children: [
      /* @__PURE__ */ jsxs8("header", { className: "plan-head", children: [
        /* @__PURE__ */ jsx10("h2", { children: plan.title }),
        /* @__PURE__ */ jsxs8("span", { className: "muted", children: [
          "revision ",
          plan.revision
        ] })
      ] }),
      plan.summary && /* @__PURE__ */ jsx10("p", { className: "plan-summary", children: plan.summary }),
      plan.markdown && /* @__PURE__ */ jsx10(Markdown, { source: plan.markdown }),
      incoming && /* @__PURE__ */ jsxs8("div", { className: "plan-incoming", children: [
        /* @__PURE__ */ jsxs8("span", { children: [
          "Claude published revision ",
          incoming.revision,
          " while you were editing. Your edits are still here."
        ] }),
        /* @__PURE__ */ jsxs8("div", { className: "row-actions", children: [
          /* @__PURE__ */ jsx10(
            Button,
            {
              size: "sm",
              variant: "primary",
              onClick: () => {
                setSteps(incoming.steps.map(clone));
                setBaseRevision(incoming.revision);
                dirty.current = false;
              },
              children: "Load the new revision"
            }
          ),
          /* @__PURE__ */ jsx10(Button, { size: "sm", variant: "ghost", onClick: () => setBaseRevision(incoming.revision), children: "Keep my edits" })
        ] })
      ] }),
      /* @__PURE__ */ jsx10(
        DndContext,
        {
          sensors,
          collisionDetection: closestCenter,
          modifiers: [restrictToVerticalAxis, restrictToParentElement],
          onDragEnd,
          children: /* @__PURE__ */ jsx10(SortableContext, { items: ids, strategy: verticalListSortingStrategy, children: /* @__PURE__ */ jsx10("ol", { className: "plan-steps", children: steps.map((step, index) => /* @__PURE__ */ jsx10(
            SortableStep,
            {
              step,
              index,
              total: steps.length,
              onMove: move,
              onChange: (patch) => edit((current) => current.map((s) => s.id === step.id ? { ...s, ...patch } : s))
            },
            step.id
          )) }) })
        }
      ),
      /* @__PURE__ */ jsx10(
        Button,
        {
          variant: "ghost",
          onClick: () => edit((current) => [...current, { id: newStepId(current), title: "", status: "pending" }]),
          children: "+ Add a step"
        }
      ),
      /* @__PURE__ */ jsx10("p", { className: "sr-only", role: "status", "aria-live": "polite", children: announcement })
    ] }),
    /* @__PURE__ */ jsxs8("aside", { className: "plan-side", children: [
      /* @__PURE__ */ jsx10("h3", { className: "panel-title", children: "Your response" }),
      gate ? /* @__PURE__ */ jsxs8(Explain, { children: [
        "Claude is parked here. Approving resumes it with the plan exactly as you have edited it \u2014",
        " ",
        pluralize(live.length, "step"),
        steps.length !== live.length && `, ${steps.length - live.length} dropped`,
        "."
      ] }) : /* @__PURE__ */ jsx10(Explain, { children: "No gate is open, so this is queued and reaches Claude at the end of its next turn." }),
      /* @__PURE__ */ jsx10(
        "textarea",
        {
          className: "input",
          rows: 4,
          value: summary2,
          placeholder: "Anything to add? (optional)",
          onChange: (e) => setSummary(e.target.value)
        }
      ),
      /* @__PURE__ */ jsxs8("div", { className: "plan-actions", children: [
        /* @__PURE__ */ jsx10(Button, { variant: "primary", onClick: () => void submit("approved"), disabled: busy, children: "Approve plan" }),
        /* @__PURE__ */ jsx10(Button, { onClick: () => void submit("changes_requested"), disabled: busy, children: "Request changes" }),
        /* @__PURE__ */ jsx10(Button, { variant: "danger", onClick: () => void submit("rejected"), disabled: busy, children: "Reject" })
      ] })
    ] })
  ] });
}
function SortableStep({
  step,
  index,
  total,
  onMove,
  onChange
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id
  });
  const dropped = step.status === "dropped";
  return /* @__PURE__ */ jsxs8(
    "li",
    {
      ref: setNodeRef,
      className: classNames("plan-step", dropped && "is-dropped", isDragging && "is-dragging"),
      style: { transform: CSS.Transform.toString(transform), transition },
      children: [
        /* @__PURE__ */ jsxs8("div", { className: "step-handle-col", children: [
          /* @__PURE__ */ jsx10(
            "button",
            {
              type: "button",
              className: "step-grip",
              "aria-label": `Reorder step ${index + 1}`,
              ...attributes,
              ...listeners,
              children: "\u283F"
            }
          ),
          /* @__PURE__ */ jsx10("span", { className: "step-index", children: index + 1 })
        ] }),
        /* @__PURE__ */ jsxs8("div", { className: "step-main", children: [
          /* @__PURE__ */ jsx10(
            "input",
            {
              className: "step-title",
              value: step.title,
              placeholder: "Describe this step",
              onChange: (e) => onChange({ title: e.target.value })
            }
          ),
          step.detail && /* @__PURE__ */ jsx10("p", { className: "step-detail", children: step.detail }),
          /* @__PURE__ */ jsx10(
            "input",
            {
              className: "step-comment",
              value: step.comment ?? "",
              placeholder: "Note on this step (optional)",
              onChange: (e) => onChange({ comment: e.target.value || void 0 })
            }
          )
        ] }),
        /* @__PURE__ */ jsxs8("div", { className: "step-actions", children: [
          /* @__PURE__ */ jsx10("button", { type: "button", className: "icon-btn", title: "Move up", onClick: () => onMove(index, index - 1), children: "\u2191" }),
          /* @__PURE__ */ jsx10("button", { type: "button", className: "icon-btn", title: "Move down", onClick: () => onMove(index, index + 1), children: "\u2193" }),
          /* @__PURE__ */ jsx10(
            "button",
            {
              type: "button",
              className: classNames("icon-btn", dropped && "is-active"),
              title: dropped ? "Keep this step" : "Drop this step",
              onClick: () => onChange({ status: dropped ? "pending" : "dropped" }),
              children: dropped ? "\u27F2" : "\u2715"
            }
          )
        ] }),
        /* @__PURE__ */ jsx10("span", { className: "sr-only", children: `Step ${index + 1} of ${total}` })
      ]
    }
  );
}
function clone(step) {
  return { ...step };
}
function newStepId(steps) {
  let n = steps.length + 1;
  const taken = new Set(steps.map((s) => s.id));
  while (taken.has(`u${n}`)) n++;
  return `u${n}`;
}
function describeEdits(original, edited, note) {
  const lines = [];
  if (note) lines.push(note);
  const dropped = edited.filter((s) => s.status === "dropped");
  if (dropped.length) {
    lines.push("Drop these steps:");
    for (const s of dropped) lines.push(`- ${s.title}`);
  }
  const commented = edited.filter((s) => s.comment);
  if (commented.length) {
    lines.push("Comments on steps:");
    for (const s of commented) lines.push(`- ${s.title}: ${s.comment}`);
  }
  const before = original.map((s) => s.title).join("|");
  const after2 = edited.filter((s) => s.status !== "dropped").map((s) => s.title).join("|");
  if (before !== after2) {
    lines.push("Revised plan:");
    edited.filter((s) => s.status !== "dropped").forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
  }
  return lines.join("\n") || "No changes.";
}
var init_PlanView = __esm({
  "src/ui/views/PlanView.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_primitives();
    init_Markdown();
    init_format();
  }
});

// src/shared/types.ts
var TASK_STATUSES;
var init_types = __esm({
  "src/shared/types.ts"() {
    "use strict";
    TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];
  }
});

// src/ui/views/BoardView.tsx
import { useMemo as useMemo3, useState as useState8 } from "react";
import {
  DndContext as DndContext2,
  DragOverlay,
  KeyboardSensor as KeyboardSensor2,
  PointerSensor as PointerSensor2,
  pointerWithin,
  useDroppable,
  useSensor as useSensor2,
  useSensors as useSensors2
} from "@dnd-kit/core";
import { SortableContext as SortableContext2, useSortable as useSortable2, verticalListSortingStrategy as verticalListSortingStrategy2 } from "@dnd-kit/sortable";
import { CSS as CSS2 } from "@dnd-kit/utilities";
import { Fragment as Fragment4, jsx as jsx11, jsxs as jsxs9 } from "react/jsx-runtime";
function BoardView() {
  const session = useSession();
  const sessionId = useStore((s) => s.sessionId);
  const [dragging, setDragging] = useState8(null);
  const [expanded, setExpanded] = useState8(null);
  const tasks = session?.tasks ?? [];
  const byStatus = useMemo3(() => {
    const map = new Map(TASK_STATUSES.map((s) => [s, []]));
    for (const task of [...tasks].sort((a, b) => a.order - b.order)) {
      map.get(task.status)?.push(task);
    }
    return map;
  }, [tasks]);
  const sensors = useSensors2(
    useSensor2(PointerSensor2, { activationConstraint: { distance: 4 } }),
    useSensor2(KeyboardSensor2)
  );
  if (!session || !sessionId) return null;
  if (tasks.length === 0) {
    return /* @__PURE__ */ jsx11("div", { className: "view-pad", children: /* @__PURE__ */ jsx11(
      EmptyState,
      {
        title: "No task board yet",
        hint: /* @__PURE__ */ jsx11(Fragment4, { children: "Approving a plan fills the board automatically \u2014 one card per step. Claude can also add subtasks it discovers while working." })
      }
    ) });
  }
  const move = async (task, status) => {
    if (task.status === status) return;
    try {
      await api.updateTask(sessionId, task.id, { status });
      store.toast("info", `Moved \u201C${task.title}\u201D to ${status.replace("_", " ")} \u2014 Claude will be told.`);
    } catch (err) {
      store.fail(err);
    }
  };
  const onDragEnd = (event) => {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;
    const task = tasks.find((t) => t.id === active.id);
    if (!task) return;
    const target = String(over.id);
    const status = TASK_STATUSES.find((s) => s === target) ?? tasks.find((t) => t.id === target)?.status;
    if (status) void move(task, status);
  };
  const onDragStart = (event) => {
    setDragging(tasks.find((t) => t.id === event.active.id) ?? null);
  };
  const done = byStatus.get("done")?.length ?? 0;
  const blocked = byStatus.get("blocked") ?? [];
  return /* @__PURE__ */ jsxs9("div", { className: "board", children: [
    /* @__PURE__ */ jsxs9("div", { className: "board-bar", children: [
      /* @__PURE__ */ jsx11("strong", { children: "Task board" }),
      /* @__PURE__ */ jsxs9("span", { className: "muted", children: [
        done,
        "/",
        tasks.length,
        " done",
        blocked.length > 0 && ` \xB7 ${blocked.length} blocked`
      ] }),
      /* @__PURE__ */ jsx11("span", { className: "spacer" }),
      /* @__PURE__ */ jsx11(Explain, { children: "Drag a card to redirect Claude \u2014 it is told when you move one." })
    ] }),
    /* @__PURE__ */ jsxs9(
      DndContext2,
      {
        sensors,
        collisionDetection: pointerWithin,
        onDragStart,
        onDragEnd,
        children: [
          /* @__PURE__ */ jsx11("div", { className: "board-columns", children: COLUMNS.map((column) => /* @__PURE__ */ jsx11(
            Column,
            {
              status: column.status,
              label: column.label,
              hint: column.hint,
              tasks: byStatus.get(column.status) ?? [],
              expanded,
              onExpand: (id) => setExpanded((current) => current === id ? null : id)
            },
            column.status
          )) }),
          /* @__PURE__ */ jsx11(DragOverlay, { children: dragging ? /* @__PURE__ */ jsx11(Card, { task: dragging, overlay: true }) : null })
        ]
      }
    )
  ] });
}
function Column({
  status,
  label,
  hint,
  tasks,
  expanded,
  onExpand
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return /* @__PURE__ */ jsxs9("section", { className: classNames("board-column", `is-${status}`, isOver && "is-over"), ref: setNodeRef, children: [
    /* @__PURE__ */ jsxs9("header", { className: "board-column-head", children: [
      /* @__PURE__ */ jsx11("span", { className: "board-column-name", children: label }),
      /* @__PURE__ */ jsx11("span", { className: "board-count", children: tasks.length })
    ] }),
    /* @__PURE__ */ jsx11("p", { className: "board-column-hint", children: hint }),
    /* @__PURE__ */ jsx11(SortableContext2, { items: tasks.map((t) => t.id), strategy: verticalListSortingStrategy2, children: /* @__PURE__ */ jsx11("div", { className: "board-cards", children: tasks.length === 0 ? /* @__PURE__ */ jsx11("p", { className: "board-empty", children: "Nothing here" }) : tasks.map((task) => /* @__PURE__ */ jsx11(
      SortableCard,
      {
        task,
        expanded: expanded === task.id,
        onExpand: () => onExpand(task.id)
      },
      task.id
    )) }) })
  ] });
}
function SortableCard({
  task,
  expanded,
  onExpand
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable2({
    id: task.id
  });
  return /* @__PURE__ */ jsx11(
    "div",
    {
      ref: setNodeRef,
      style: { transform: CSS2.Transform.toString(transform), transition },
      className: classNames(isDragging && "is-source"),
      ...attributes,
      ...listeners,
      children: /* @__PURE__ */ jsx11(Card, { task, expanded, onExpand })
    }
  );
}
function Card({
  task,
  expanded,
  onExpand,
  overlay
}) {
  const changes = task.notes.filter((n) => n.kind === "change");
  const elapsed = task.status === "in_progress" && task.startedAt ? duration(Date.now() - task.startedAt) : null;
  return /* @__PURE__ */ jsxs9("article", { className: classNames("board-card", `is-${task.status}`, overlay && "is-overlay"), children: [
    /* @__PURE__ */ jsxs9("header", { className: "board-card-head", children: [
      /* @__PURE__ */ jsx11("span", { className: "board-card-title", children: task.title }),
      elapsed && /* @__PURE__ */ jsx11("span", { className: "board-card-elapsed", children: elapsed })
    ] }),
    task.detail && /* @__PURE__ */ jsx11("p", { className: "board-card-detail", children: task.detail }),
    task.status === "blocked" && task.blockedReason && /* @__PURE__ */ jsxs9("p", { className: "board-card-blocked", children: [
      /* @__PURE__ */ jsx11("strong", { children: "Waiting on you:" }),
      " ",
      task.blockedReason
    ] }),
    /* @__PURE__ */ jsxs9("div", { className: "board-card-meta", children: [
      task.files.length > 0 && /* @__PURE__ */ jsx11("span", { title: task.files.join("\n"), children: pluralize(task.files.length, "file") }),
      changes.length > 0 && /* @__PURE__ */ jsx11("span", { children: pluralize(changes.length, "note") }),
      task.decisions.length > 0 && /* @__PURE__ */ jsx11("span", { className: "board-card-decisions", children: pluralize(task.decisions.length, "decision") }),
      task.completedAt && /* @__PURE__ */ jsx11("span", { className: "muted", children: relativeTime(task.completedAt) }),
      onExpand && (task.files.length > 0 || task.notes.length > 0) && /* @__PURE__ */ jsx11(
        "button",
        {
          type: "button",
          className: "link",
          onClick: (e) => {
            e.stopPropagation();
            onExpand();
          },
          onPointerDown: (e) => e.stopPropagation(),
          children: expanded ? "less" : "details"
        }
      )
    ] }),
    expanded && /* @__PURE__ */ jsxs9("div", { className: "board-card-body", children: [
      task.files.length > 0 && /* @__PURE__ */ jsxs9(Fragment4, { children: [
        /* @__PURE__ */ jsx11("h4", { children: "Files changed" }),
        /* @__PURE__ */ jsx11("ul", { className: "board-files", children: task.files.map((file) => /* @__PURE__ */ jsx11("li", { children: /* @__PURE__ */ jsx11("code", { children: file }) }, file)) })
      ] }),
      task.decisions.length > 0 && /* @__PURE__ */ jsxs9(Fragment4, { children: [
        /* @__PURE__ */ jsx11("h4", { children: "Decisions" }),
        /* @__PURE__ */ jsx11("ul", { className: "board-decisions", children: task.decisions.map((d) => /* @__PURE__ */ jsxs9("li", { children: [
          /* @__PURE__ */ jsx11("span", { className: "board-question", children: d.question }),
          /* @__PURE__ */ jsxs9("span", { className: "board-answer", children: [
            "\u2192 ",
            d.answer
          ] })
        ] }, d.id)) })
      ] }),
      task.notes.length > 0 && /* @__PURE__ */ jsxs9(Fragment4, { children: [
        /* @__PURE__ */ jsx11("h4", { children: "Record" }),
        /* @__PURE__ */ jsx11("ul", { className: "board-notes", children: task.notes.map((note) => /* @__PURE__ */ jsxs9("li", { className: `is-${note.kind}`, children: [
          /* @__PURE__ */ jsx11("span", { className: "board-note-kind", children: note.kind }),
          note.text
        ] }, note.id)) })
      ] })
    ] })
  ] });
}
var COLUMNS;
var init_BoardView = __esm({
  "src/ui/views/BoardView.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_primitives();
    init_format();
    init_types();
    COLUMNS = [
      { status: "todo", label: "To do", hint: "Queued \u2014 not started" },
      { status: "in_progress", label: "In progress", hint: "What Claude is doing right now" },
      { status: "blocked", label: "Blocked", hint: "Waiting on an answer from you" },
      { status: "done", label: "Done", hint: "Finished, with a record of what changed" }
    ];
  }
});

// src/ui/views/review/FileTree.tsx
import { useMemo as useMemo4, useState as useState9 } from "react";
import { jsx as jsx12, jsxs as jsxs10 } from "react/jsx-runtime";
function FileTree({
  files,
  selected,
  onSelect
}) {
  const [filter, setFilter] = useState9("");
  const drafts = useDrafts();
  const threads = useStore((s) => s.session?.threads ?? EMPTY);
  const viewed = useStore((s) => s.sessionId ? s.viewedFiles[s.sessionId] ?? EMPTY_STR : EMPTY_STR);
  const groups = useMemo4(() => groupByDirectory(files, filter), [files, filter]);
  const viewedCount = files.filter((f) => viewed.includes(f.path)).length;
  return /* @__PURE__ */ jsxs10("nav", { className: "file-rail", "aria-label": "Changed files", children: [
    /* @__PURE__ */ jsxs10("div", { className: "file-rail-head", children: [
      /* @__PURE__ */ jsx12(
        "input",
        {
          className: "file-filter",
          type: "search",
          value: filter,
          placeholder: `Filter ${files.length} files\u2026`,
          onChange: (e) => setFilter(e.target.value)
        }
      ),
      /* @__PURE__ */ jsxs10("span", { className: "file-rail-progress", children: [
        viewedCount,
        "/",
        files.length,
        " viewed"
      ] })
    ] }),
    /* @__PURE__ */ jsxs10("div", { className: "file-rail-body", children: [
      groups.length === 0 && /* @__PURE__ */ jsx12("p", { className: "sidebar-empty", children: "No files match." }),
      groups.map((group) => /* @__PURE__ */ jsxs10("div", { className: "file-group", children: [
        group.dir && /* @__PURE__ */ jsx12("div", { className: "file-group-head", children: group.dir }),
        group.files.map((file) => /* @__PURE__ */ jsx12(
          FileRow,
          {
            file,
            active: file.path === selected,
            viewed: viewed.includes(file.path),
            comments: countFor(file.path, drafts, threads),
            onSelect: () => onSelect(file.path)
          },
          file.path
        ))
      ] }, group.dir))
    ] })
  ] });
}
function FileRow({
  file,
  active,
  viewed,
  comments,
  onSelect
}) {
  const { name } = splitPath(file.path);
  return /* @__PURE__ */ jsxs10(
    "div",
    {
      className: classNames(
        "file-row",
        active && "is-active",
        viewed && "is-viewed",
        file.changedSinceLastReview === false && "is-unchanged"
      ),
      children: [
        /* @__PURE__ */ jsx12("label", { className: "file-viewed", title: viewed ? "Mark as not viewed" : "Mark as viewed", children: /* @__PURE__ */ jsx12(
          "input",
          {
            type: "checkbox",
            checked: viewed,
            onChange: () => store.toggleViewed(file.path),
            "aria-label": `Mark ${file.path} viewed`
          }
        ) }),
        /* @__PURE__ */ jsxs10("button", { type: "button", className: "file-open", onClick: onSelect, title: file.path, children: [
          /* @__PURE__ */ jsx12("span", { className: classNames("file-status", `is-${file.status}`), "aria-hidden": "true", children: file.status[0].toUpperCase() }),
          /* @__PURE__ */ jsx12("span", { className: "file-name", children: name }),
          file.changedSinceLastReview && /* @__PURE__ */ jsx12("span", { className: "pill is-moved", title: "Changed since your last review", children: "new" }),
          comments.draft > 0 && /* @__PURE__ */ jsx12("span", { className: "pill is-draft", title: `${comments.draft} unsent comment(s)`, children: comments.draft }),
          comments.sent > 0 && /* @__PURE__ */ jsx12("span", { className: "pill is-sent", title: `${comments.sent} comment(s) already sent`, children: comments.sent }),
          /* @__PURE__ */ jsxs10("span", { className: "file-counts", children: [
            file.additions > 0 && /* @__PURE__ */ jsxs10("span", { className: "add", children: [
              "+",
              file.additions
            ] }),
            file.deletions > 0 && /* @__PURE__ */ jsxs10("span", { className: "del", children: [
              "\u2212",
              file.deletions
            ] })
          ] })
        ] })
      ]
    }
  );
}
function countFor(path, drafts, threads) {
  return {
    draft: drafts.filter((t) => t.file === path).length,
    sent: threads.filter((t) => t.file === path && t.deliveredAt).length
  };
}
function groupByDirectory(files, filter) {
  const needle = filter.trim().toLowerCase();
  const matched = needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files;
  const map = /* @__PURE__ */ new Map();
  for (const file of matched) {
    const { dir } = splitPath(file.path);
    const key = dir.replace(/\/$/, "");
    const bucket = map.get(key);
    if (bucket) bucket.push(file);
    else map.set(key, [file]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, group]) => ({ dir, files: group }));
}
var EMPTY, EMPTY_STR;
var init_FileTree = __esm({
  "src/ui/views/review/FileTree.tsx"() {
    "use strict";
    init_store();
    init_format();
    EMPTY = [];
    EMPTY_STR = [];
  }
});

// src/ui/views/review/CommentThread.tsx
import { useState as useState10 } from "react";
import { Fragment as Fragment5, jsx as jsx13, jsxs as jsxs11 } from "react/jsx-runtime";
function CommentThread({ thread }) {
  const isDraft = !thread.deliveredAt;
  const sessionId = useStore((s) => s.sessionId);
  const [editing, setEditing] = useState10(false);
  const [body, setBody] = useState10(thread.body);
  const [confirmingDelete, setConfirmingDelete] = useState10(false);
  const [replying, setReplying] = useState10(false);
  const [reply, setReply] = useState10("");
  const sendReply = async () => {
    const text = reply.trim();
    if (!text || !sessionId) return;
    try {
      await api.replyToThread(sessionId, thread.id, text);
      setReply("");
      setReplying(false);
      store.toast("success", "Reply queued for Claude.");
    } catch (err) {
      store.fail(err);
    }
  };
  const toggleResolved = async () => {
    if (!sessionId) return;
    try {
      await api.resolveThread(sessionId, thread.id, !thread.resolved);
    } catch (err) {
      store.fail(err);
    }
  };
  const save = () => {
    const next = body.trim();
    if (!next) return;
    store.updateDraft(thread.id, next);
    setEditing(false);
  };
  return /* @__PURE__ */ jsx13("div", { className: classNames("dthread", isDraft ? "is-draft" : "is-sent", thread.resolved && "is-resolved"), children: /* @__PURE__ */ jsxs11("article", { className: "dthread-card", children: [
    /* @__PURE__ */ jsxs11("header", { className: "dthread-head", children: [
      /* @__PURE__ */ jsx13("span", { className: "dthread-ref", children: lineRef(thread.file, thread.startLine, thread.endLine) }),
      isDraft ? /* @__PURE__ */ jsx13("span", { className: "pill is-draft", children: "Not sent yet" }) : /* @__PURE__ */ jsxs11("span", { className: "pill is-sent", title: new Date(thread.deliveredAt).toLocaleString(), children: [
        "Sent ",
        relativeTime(thread.deliveredAt)
      ] }),
      thread.resolved && /* @__PURE__ */ jsx13("span", { className: "pill is-resolved", children: "Addressed in a later revision" }),
      /* @__PURE__ */ jsx13("span", { className: "spacer" }),
      isDraft && !editing && /* @__PURE__ */ jsxs11(Fragment5, { children: [
        /* @__PURE__ */ jsx13("button", { type: "button", className: "link", onClick: () => setEditing(true), children: "Edit" }),
        /* @__PURE__ */ jsx13("button", { type: "button", className: "link is-danger", onClick: () => setConfirmingDelete(true), children: "Delete" })
      ] }),
      !isDraft && /* @__PURE__ */ jsxs11(Fragment5, { children: [
        /* @__PURE__ */ jsx13("button", { type: "button", className: "link", onClick: () => setReplying((v) => !v), children: "Reply" }),
        /* @__PURE__ */ jsx13("button", { type: "button", className: "link", onClick: () => void toggleResolved(), children: thread.resolved ? "Reopen" : "Resolve" })
      ] })
    ] }),
    editing ? /* @__PURE__ */ jsxs11("div", { className: "dthread-edit", children: [
      /* @__PURE__ */ jsx13(
        "textarea",
        {
          className: "input",
          rows: 3,
          value: body,
          autoFocus: true,
          onChange: (e) => setBody(e.target.value),
          onKeyDown: (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
            if (e.key === "Escape") {
              setBody(thread.body);
              setEditing(false);
            }
          }
        }
      ),
      /* @__PURE__ */ jsxs11("div", { className: "row-actions", children: [
        /* @__PURE__ */ jsx13(Button, { size: "sm", variant: "primary", onClick: save, disabled: !body.trim(), children: "Save" }),
        /* @__PURE__ */ jsx13(
          Button,
          {
            size: "sm",
            variant: "ghost",
            onClick: () => {
              setBody(thread.body);
              setEditing(false);
            },
            children: "Cancel"
          }
        )
      ] })
    ] }) : /* @__PURE__ */ jsx13(Markdown, { source: thread.body, className: "dthread-body" }),
    (thread.replies?.length ?? 0) > 0 && /* @__PURE__ */ jsx13("ul", { className: "dthread-replies", children: thread.replies.map((r) => /* @__PURE__ */ jsxs11("li", { className: classNames("dthread-reply", `is-${r.author}`), children: [
      /* @__PURE__ */ jsx13("span", { className: "dthread-author", children: r.author === "claude" ? "Claude" : "You" }),
      /* @__PURE__ */ jsx13(Markdown, { source: r.text, className: "dthread-reply-body" })
    ] }, r.id)) }),
    replying && /* @__PURE__ */ jsxs11("div", { className: "dthread-edit", children: [
      /* @__PURE__ */ jsx13(
        "textarea",
        {
          className: "input",
          rows: 2,
          value: reply,
          autoFocus: true,
          placeholder: "Reply to this thread\u2026",
          onChange: (e) => setReply(e.target.value),
          onKeyDown: (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void sendReply();
            if (e.key === "Escape") setReplying(false);
          }
        }
      ),
      /* @__PURE__ */ jsxs11("div", { className: "row-actions", children: [
        /* @__PURE__ */ jsx13(Button, { size: "sm", variant: "primary", onClick: () => void sendReply(), disabled: !reply.trim(), children: "Send reply" }),
        /* @__PURE__ */ jsx13(Button, { size: "sm", variant: "ghost", onClick: () => setReplying(false), children: "Cancel" })
      ] })
    ] }),
    confirmingDelete && /* @__PURE__ */ jsxs11("div", { className: "dthread-confirm", children: [
      /* @__PURE__ */ jsx13("span", { children: "Delete this comment? It has not been sent." }),
      /* @__PURE__ */ jsx13(Button, { size: "sm", variant: "danger", onClick: () => store.removeDraft(thread.id), children: "Delete" }),
      /* @__PURE__ */ jsx13(Button, { size: "sm", variant: "ghost", onClick: () => setConfirmingDelete(false), children: "Keep" })
    ] })
  ] }) });
}
var init_CommentThread = __esm({
  "src/ui/views/review/CommentThread.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_primitives();
    init_Markdown();
    init_format();
  }
});

// src/shared/diffparse.ts
function excerptFor(file, side, startLine, endLine, maxLines = 40) {
  const out = [];
  for (const hunk of file.hunks ?? []) {
    for (const line of hunk.lines) {
      const n = side === "old" ? line.oldLine : line.newLine;
      if (n === null || n < startLine || n > endLine) continue;
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      out.push(`${marker}${line.text}`);
      if (out.length >= maxLines) return `${out.join("\n")}
\u2026 (truncated)`;
    }
  }
  return out.join("\n");
}
var init_diffparse = __esm({
  "src/shared/diffparse.ts"() {
    "use strict";
  }
});

// src/ui/views/review/CommentComposer.tsx
import { useEffect as useEffect6, useRef as useRef3, useState as useState11 } from "react";
import { jsx as jsx14, jsxs as jsxs12 } from "react/jsx-runtime";
function CommentComposer({ selection, onDone }) {
  const [body, setBody] = useState11("");
  const diff = useStore((s) => s.diff);
  const ref = useRef3(null);
  useEffect6(() => {
    ref.current?.focus();
  }, []);
  const submit = () => {
    const text = body.trim();
    if (!text) return;
    const file = diff?.files.find((f) => f.path === selection.file);
    store.addDraft({
      id: newId(),
      file: selection.file,
      side: selection.side,
      startLine: selection.start,
      endLine: selection.end,
      body: text,
      excerpt: file ? excerptFor(file, selection.side, selection.start, selection.end) : void 0,
      createdAt: Date.now(),
      resolved: false
    });
    setBody("");
    onDone();
  };
  return /* @__PURE__ */ jsx14("div", { className: "dcomposer", children: /* @__PURE__ */ jsxs12("div", { className: "dcomposer-card", children: [
    /* @__PURE__ */ jsxs12("header", { className: "dcomposer-head", children: [
      /* @__PURE__ */ jsx14("strong", { children: lineRef(selection.file, selection.start, selection.end) }),
      /* @__PURE__ */ jsx14("span", { className: "muted", children: "shift-click another line to extend the range" })
    ] }),
    /* @__PURE__ */ jsx14(
      "textarea",
      {
        ref,
        className: "input",
        rows: 3,
        value: body,
        placeholder: "What should change here?",
        onChange: (e) => setBody(e.target.value),
        onKeyDown: (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          if (e.key === "Escape") onDone();
        }
      }
    ),
    /* @__PURE__ */ jsxs12("div", { className: "dcomposer-foot", children: [
      /* @__PURE__ */ jsx14("span", { className: "explain", children: "Saved to your review \u2014 Claude sees it when you submit." }),
      /* @__PURE__ */ jsxs12("div", { className: "row-actions", children: [
        /* @__PURE__ */ jsx14(Button, { size: "sm", variant: "primary", onClick: submit, disabled: !body.trim(), children: "Add to review" }),
        /* @__PURE__ */ jsx14(Button, { size: "sm", variant: "ghost", onClick: onDone, children: "Cancel" })
      ] })
    ] })
  ] }) });
}
function newId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
var init_CommentComposer = __esm({
  "src/ui/views/review/CommentComposer.tsx"() {
    "use strict";
    init_store();
    init_primitives();
    init_format();
    init_diffparse();
  }
});

// src/ui/views/review/DiffFile.tsx
import { memo, useMemo as useMemo5 } from "react";
import { Fragment as Fragment6, jsx as jsx15, jsxs as jsxs13 } from "react/jsx-runtime";
function Row({
  file,
  line,
  selection,
  threads,
  onSelect,
  onCancelSelection
}) {
  const side = line.kind === "del" ? "old" : "new";
  const lineNo = side === "old" ? line.oldLine : line.newLine;
  const selected = selection !== null && selection.file === file && selection.side === side && lineNo !== null && lineNo >= selection.start && lineNo <= selection.end;
  const anchored = threads.filter(
    (t) => t.side === side && lineNo !== null && (t.endLine === lineNo || t.startLine === lineNo)
  );
  const endsHere = anchored.filter((t) => t.endLine === lineNo);
  const click = (event) => {
    if (lineNo === null) return;
    if (window.getSelection()?.toString()) return;
    if (event.shiftKey && selection && selection.file === file && selection.side === side) {
      onSelect({
        ...selection,
        start: Math.min(selection.start, lineNo),
        end: Math.max(selection.end, lineNo)
      });
    } else {
      onSelect({ file, side, start: lineNo, end: lineNo });
    }
  };
  const isSelectionEnd = selected && selection?.end === lineNo;
  return /* @__PURE__ */ jsxs13(Fragment6, { children: [
    /* @__PURE__ */ jsxs13(
      "div",
      {
        className: classNames(
          "drow",
          `is-${line.kind}`,
          selected && "is-selected",
          anchored.length > 0 && "has-comment"
        ),
        role: "button",
        tabIndex: lineNo === null ? -1 : 0,
        "aria-label": lineNo === null ? void 0 : `${file} line ${lineNo}. Press Enter to comment.`,
        onClick: click,
        onKeyDown: (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (lineNo !== null) onSelect({ file, side, start: lineNo, end: lineNo });
        },
        children: [
          /* @__PURE__ */ jsx15("span", { className: "dnum", children: line.oldLine ?? "" }),
          /* @__PURE__ */ jsx15("span", { className: "dnum", children: line.newLine ?? "" }),
          /* @__PURE__ */ jsxs13("span", { className: "dmark", "aria-hidden": "true", children: [
            line.kind === "add" ? "+" : line.kind === "del" ? "\u2212" : "",
            /* @__PURE__ */ jsx15("span", { className: "dadd-hint", title: "Comment on this line", children: "+" })
          ] }),
          /* @__PURE__ */ jsx15("span", { className: "dcode", children: line.text || " " })
        ]
      }
    ),
    endsHere.map((thread) => /* @__PURE__ */ jsx15(CommentThread, { thread }, thread.id)),
    isSelectionEnd && selection && /* @__PURE__ */ jsx15(CommentComposer, { selection, onDone: onCancelSelection })
  ] });
}
function gutterDigits(file) {
  let max = 0;
  for (const hunk of file.hunks ?? []) {
    max = Math.max(max, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
  }
  return Math.max(2, String(max).length);
}
var DiffFileView, EMPTY_THREADS;
var init_DiffFile = __esm({
  "src/ui/views/review/DiffFile.tsx"() {
    "use strict";
    init_store();
    init_CommentThread();
    init_CommentComposer();
    init_format();
    DiffFileView = memo(function DiffFileView2({
      file,
      selection,
      onSelect,
      onCancelSelection,
      registerAnchor
    }) {
      const drafts = useDrafts();
      const sent = useStore((s) => s.session?.threads ?? EMPTY_THREADS);
      const viewed = useStore((s) => store.isViewed(file.path));
      const wrap = useStore((s) => s.diffMode === "unified");
      const threads = useMemo5(
        () => [...drafts, ...sent].filter((t) => t.file === file.path),
        [drafts, sent, file.path]
      );
      const digits = useMemo5(() => gutterDigits(file), [file]);
      const { dir, name } = splitPath(file.path);
      return /* @__PURE__ */ jsxs13(
        "section",
        {
          className: classNames("dfile", viewed && "is-viewed"),
          ref: (node) => registerAnchor(file.path, node),
          "data-path": file.path,
          style: { "--gut": `calc(${digits}ch + 16px)` },
          children: [
            /* @__PURE__ */ jsxs13("header", { className: "dfile-head", children: [
              /* @__PURE__ */ jsx15("span", { className: classNames("file-status", `is-${file.status}`), children: file.status[0].toUpperCase() }),
              /* @__PURE__ */ jsxs13("span", { className: "dfile-path", title: file.path, children: [
                /* @__PURE__ */ jsx15("span", { className: "dfile-dir", children: dir }),
                /* @__PURE__ */ jsx15("span", { className: "dfile-name", children: name })
              ] }),
              file.oldPath && file.oldPath !== file.path && /* @__PURE__ */ jsxs13("span", { className: "muted", children: [
                "renamed from ",
                file.oldPath
              ] }),
              /* @__PURE__ */ jsxs13("span", { className: "dfile-counts", children: [
                file.additions > 0 && /* @__PURE__ */ jsxs13("span", { className: "add", children: [
                  "+",
                  file.additions
                ] }),
                file.deletions > 0 && /* @__PURE__ */ jsxs13("span", { className: "del", children: [
                  "\u2212",
                  file.deletions
                ] })
              ] }),
              threads.length > 0 && /* @__PURE__ */ jsxs13("span", { className: "pill is-draft", children: [
                threads.length,
                " comment",
                threads.length === 1 ? "" : "s"
              ] }),
              /* @__PURE__ */ jsxs13("label", { className: "dfile-viewed", children: [
                /* @__PURE__ */ jsx15("input", { type: "checkbox", checked: viewed, onChange: () => store.toggleViewed(file.path) }),
                "Viewed"
              ] })
            ] }),
            file.binary ? /* @__PURE__ */ jsx15("p", { className: "dfile-note", children: "Binary file \u2014 content not shown. It is still part of the change." }) : file.truncated || !file.hunks ? /* @__PURE__ */ jsx15("p", { className: "dfile-note", children: "This file is too large to render here. It is still part of the change \u2014 review it in your editor." }) : viewed ? /* @__PURE__ */ jsxs13("p", { className: "dfile-note", children: [
              "Marked viewed.",
              " ",
              /* @__PURE__ */ jsx15("button", { type: "button", className: "link", onClick: () => store.toggleViewed(file.path), children: "Show the diff again" })
            ] }) : /* @__PURE__ */ jsx15("div", { className: classNames("dtable", wrap ? "is-wrap" : "is-nowrap"), children: file.hunks.map((hunk, hunkIndex) => /* @__PURE__ */ jsxs13("div", { className: "dhunk", children: [
              /* @__PURE__ */ jsxs13("div", { className: "dhunk-head", children: [
                "@@ \u2212",
                hunk.oldStart,
                ",",
                hunk.oldCount,
                " +",
                hunk.newStart,
                ",",
                hunk.newCount,
                " @@",
                hunk.header && /* @__PURE__ */ jsxs13("span", { className: "dhunk-ctx", children: [
                  " ",
                  hunk.header
                ] })
              ] }),
              hunk.lines.map((line, lineIndex) => /* @__PURE__ */ jsx15(
                Row,
                {
                  file: file.path,
                  line,
                  selection,
                  threads,
                  onSelect,
                  onCancelSelection
                },
                `${hunkIndex}-${lineIndex}`
              ))
            ] }, `${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`)) })
          ]
        }
      );
    });
    EMPTY_THREADS = [];
  }
});

// src/ui/views/review/Reconciliation.tsx
import { useMemo as useMemo6 } from "react";
import { jsx as jsx16, jsxs as jsxs14 } from "react/jsx-runtime";
function Reconciliation() {
  const session = useSession();
  const diff = useStore((s) => s.diff);
  const rows = useMemo6(() => {
    const changed = new Set((diff?.files ?? []).map((f) => f.path));
    return (session?.tasks ?? []).slice().sort((a, b) => a.order - b.order).map((task) => ({
      task,
      matched: task.files.filter((f) => changed.has(f)),
      missing: task.files.filter((f) => !changed.has(f))
    }));
  }, [session?.tasks, diff?.files]);
  if (rows.length === 0) return null;
  const attributed = new Set(rows.flatMap((r) => r.task.files));
  const unattributed = (diff?.files ?? []).filter((f) => !attributed.has(f.path));
  const suspect = rows.filter((r) => r.task.status === "done" && r.matched.length === 0);
  return /* @__PURE__ */ jsxs14("section", { className: "reconcile", children: [
    /* @__PURE__ */ jsxs14("header", { className: "reconcile-head", children: [
      /* @__PURE__ */ jsx16("strong", { children: "Plan vs. what changed" }),
      suspect.length > 0 && /* @__PURE__ */ jsxs14("span", { className: "pill is-draft", children: [
        pluralize(suspect.length, "task"),
        " marked done with no visible change"
      ] })
    ] }),
    /* @__PURE__ */ jsx16("ul", { className: "reconcile-list", children: rows.map(({ task, matched }) => /* @__PURE__ */ jsxs14("li", { className: classNames("reconcile-row", `is-${task.status}`), children: [
      /* @__PURE__ */ jsx16("span", { className: "reconcile-status", children: glyph(task) }),
      /* @__PURE__ */ jsx16("span", { className: "reconcile-title", children: task.title }),
      /* @__PURE__ */ jsx16("span", { className: "reconcile-files", children: matched.length === 0 ? /* @__PURE__ */ jsx16("em", { className: "muted", children: "no files" }) : matched.map((file) => /* @__PURE__ */ jsx16("code", { title: file, children: file }, file)) })
    ] }, task.id)) }),
    unattributed.length > 0 && /* @__PURE__ */ jsxs14("p", { className: "reconcile-extra", children: [
      pluralize(unattributed.length, "changed file"),
      " not attributed to any task:",
      " ",
      unattributed.slice(0, 6).map((f) => /* @__PURE__ */ jsx16("code", { children: f.path }, f.path)),
      unattributed.length > 6 && /* @__PURE__ */ jsxs14("span", { className: "muted", children: [
        " +",
        unattributed.length - 6,
        " more"
      ] })
    ] })
  ] });
}
function glyph(task) {
  return { done: "\u2713", in_progress: "\u25D0", blocked: "\u23F8", todo: "\u25CB" }[task.status] ?? "\u25CB";
}
var init_Reconciliation = __esm({
  "src/ui/views/review/Reconciliation.tsx"() {
    "use strict";
    init_store();
    init_format();
  }
});

// src/ui/views/review/PendingPanel.tsx
import { useMemo as useMemo7, useState as useState12 } from "react";
import { jsx as jsx17, jsxs as jsxs15 } from "react/jsx-runtime";
function PendingPanel({
  gate,
  onJump,
  onClose
}) {
  const drafts = useDrafts();
  const sessionId = useStore((s) => s.sessionId);
  const [summary2, setSummary] = useState12("");
  const [busy, setBusy] = useState12(false);
  const [confirming, setConfirming] = useState12(null);
  const grouped = useMemo7(() => groupByFile(drafts), [drafts]);
  const submit = async (verdict) => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      if (gate) {
        await api.resolveGate(sessionId, gate.id, {
          verdict,
          comment: summary2.trim(),
          threads: drafts
        });
        store.toast(
          "success",
          verdict === "approved" ? `Approved${drafts.length ? ` with ${pluralize(drafts.length, "comment")}` : ""} \u2014 Claude is resuming.` : `Sent ${pluralize(drafts.length, "comment")} \u2014 Claude is resuming.`
        );
      } else {
        await api.feedback(sessionId, {
          text: summary2.trim() || (verdict === "approved" ? "Looks good." : "Please address these comments."),
          origin: "diff",
          threads: drafts
        });
        store.toast("success", `Queued ${pluralize(drafts.length, "comment")} for Claude's next turn.`);
      }
      store.clearDrafts();
      setSummary("");
      setConfirming(null);
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };
  const request2 = (verdict) => {
    if (verdict === "approved" && drafts.length > 0) setConfirming("approved");
    else void submit(verdict);
  };
  return /* @__PURE__ */ jsxs15("aside", { className: "pending", "aria-label": "Your review", children: [
    /* @__PURE__ */ jsxs15("header", { className: "pending-head", children: [
      /* @__PURE__ */ jsx17("strong", { children: "Your review" }),
      /* @__PURE__ */ jsx17("span", { className: "muted", children: drafts.length === 0 ? "no comments yet" : pluralize(drafts.length, "comment") }),
      /* @__PURE__ */ jsx17("span", { className: "spacer" }),
      /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn", onClick: onClose, title: "Hide this panel", children: "\u203A" })
    ] }),
    /* @__PURE__ */ jsxs15("div", { className: "pending-body", children: [
      /* @__PURE__ */ jsx17(Reconciliation, {}),
      drafts.length === 0 ? /* @__PURE__ */ jsx17("p", { className: "pending-empty", children: "Click a line in the diff to comment on it. Comments collect here and are sent together when you submit." }) : grouped.map(([file, threads]) => /* @__PURE__ */ jsxs15("div", { className: "pending-group", children: [
        /* @__PURE__ */ jsx17("div", { className: "pending-file", title: file, children: file }),
        threads.map((thread) => /* @__PURE__ */ jsxs15("div", { className: "pending-item", children: [
          /* @__PURE__ */ jsxs15("button", { type: "button", className: "pending-jump", onClick: () => onJump(thread), children: [
            /* @__PURE__ */ jsxs15("span", { className: "pending-ref", children: [
              "L",
              thread.startLine,
              thread.endLine !== thread.startLine ? `\u2013${thread.endLine}` : ""
            ] }),
            /* @__PURE__ */ jsx17("span", { className: "pending-body-text", children: thread.body })
          ] }),
          /* @__PURE__ */ jsx17(
            "button",
            {
              type: "button",
              className: "icon-btn is-danger",
              title: "Remove this comment",
              onClick: () => store.removeDraft(thread.id),
              children: "\xD7"
            }
          )
        ] }, thread.id))
      ] }, file))
    ] }),
    /* @__PURE__ */ jsxs15("footer", { className: "pending-foot", children: [
      gate ? /* @__PURE__ */ jsx17("p", { className: "explain", children: "Submitting resumes the parked session. Claude receives your summary and every comment above, each with the lines you selected." }) : /* @__PURE__ */ jsx17("p", { className: "explain", children: "No gate is open, so this is queued and reaches Claude at the end of its next turn." }),
      /* @__PURE__ */ jsx17(
        "textarea",
        {
          className: "input",
          rows: 2,
          value: summary2,
          placeholder: "Summary for Claude (optional)",
          onChange: (e) => setSummary(e.target.value)
        }
      ),
      confirming === "approved" ? /* @__PURE__ */ jsxs15("div", { className: "pending-confirm", children: [
        /* @__PURE__ */ jsxs15("span", { children: [
          "Approve with ",
          pluralize(drafts.length, "unsent comment"),
          "? They will be sent, but approving tells Claude to move on."
        ] }),
        /* @__PURE__ */ jsxs15("div", { className: "row-actions", children: [
          /* @__PURE__ */ jsx17(Button, { size: "sm", variant: "primary", onClick: () => void submit("approved"), disabled: busy, children: "Approve anyway" }),
          /* @__PURE__ */ jsx17(Button, { size: "sm", variant: "ghost", onClick: () => setConfirming(null), children: "Cancel" })
        ] })
      ] }) : /* @__PURE__ */ jsxs15("div", { className: "pending-actions", children: [
        /* @__PURE__ */ jsx17(Button, { onClick: () => request2("changes_requested"), disabled: busy, children: busy ? "Sending\u2026" : "Request changes" }),
        /* @__PURE__ */ jsx17(Button, { variant: "primary", onClick: () => request2("approved"), disabled: busy, children: "Approve" })
      ] })
    ] })
  ] });
}
function groupByFile(threads) {
  const map = /* @__PURE__ */ new Map();
  for (const thread of threads) {
    const bucket = map.get(thread.file);
    if (bucket) bucket.push(thread);
    else map.set(thread.file, [thread]);
  }
  for (const bucket of map.values()) bucket.sort((a, b) => a.startLine - b.startLine);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}
var init_PendingPanel = __esm({
  "src/ui/views/review/PendingPanel.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_primitives();
    init_format();
    init_Reconciliation();
  }
});

// src/ui/views/ReviewView.tsx
import { useCallback, useEffect as useEffect7, useRef as useRef4, useState as useState13 } from "react";
import { Fragment as Fragment7, jsx as jsx18, jsxs as jsxs16 } from "react/jsx-runtime";
function ReviewView() {
  const diff = useStore((s) => s.diff);
  const loading = useStore((s) => s.diffLoading);
  const selectedFile = useStore((s) => s.selectedFile);
  const diffMode = useStore((s) => s.diffMode);
  const gate = useOpenGate();
  const drafts = useDrafts();
  const [selection, setSelection] = useState13(null);
  const [panelOpen, setPanelOpen] = useState13(true);
  const [onlyChanged, setOnlyChanged] = useState13(false);
  const anchors = useRef4(/* @__PURE__ */ new Map());
  const scroller = useRef4(null);
  const registerAnchor = useCallback((path, node) => {
    if (node) anchors.current.set(path, node);
    else anchors.current.delete(path);
  }, []);
  const scrollToFile = useCallback((path) => {
    store.selectFile(path);
    anchors.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const jumpToThread = useCallback((thread) => {
    const node = anchors.current.get(thread.file);
    node?.scrollIntoView({ behavior: "smooth", block: "start" });
    store.selectFile(thread.file);
    window.setTimeout(() => {
      const row = node?.querySelector(`[data-line="${thread.endLine}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      row?.classList.add("is-flash");
      window.setTimeout(() => row?.classList.remove("is-flash"), 900);
    }, 120);
  }, []);
  const moved = diff?.changedSinceLastReview ?? null;
  const visible = onlyChanged && moved ? (diff?.files ?? []).filter((f) => f.changedSinceLastReview) : diff?.files ?? [];
  useTrackVisibleFile(scroller, anchors);
  useReviewShortcuts({
    files: visible.map((f) => f.path),
    selected: selectedFile,
    onFile: scrollToFile,
    onTogglePanel: () => setPanelOpen((v) => !v),
    onToggleViewed: () => selectedFile && store.toggleViewed(selectedFile),
    onRefresh: () => void store.refreshDiff(true)
  });
  if (loading && !diff) {
    return /* @__PURE__ */ jsx18("div", { className: "review-empty", children: /* @__PURE__ */ jsx18(Spinner, { label: "Computing the diff\u2026" }) });
  }
  if (!diff) {
    return /* @__PURE__ */ jsx18("div", { className: "review-empty", children: /* @__PURE__ */ jsx18(
      EmptyState,
      {
        title: "No diff published yet",
        hint: "Claude publishes one when it reaches the review stage. You can also compute the current diff now.",
        action: /* @__PURE__ */ jsx18(Button, { variant: "primary", onClick: () => void store.refreshDiff(true), children: "Compute diff now" })
      }
    ) });
  }
  if (diff.files.length === 0) {
    return /* @__PURE__ */ jsx18("div", { className: "review-empty", children: /* @__PURE__ */ jsx18(
      EmptyState,
      {
        title: "No changes against this base",
        hint: /* @__PURE__ */ jsxs16(Fragment7, { children: [
          "Diffed against ",
          /* @__PURE__ */ jsx18("code", { children: shortRef(diff.baseRef) }),
          ". Either nothing has changed yet, or the base is wrong."
        ] }),
        action: /* @__PURE__ */ jsx18(Button, { onClick: () => void store.refreshDiff(true), children: "Recompute" })
      }
    ) });
  }
  return /* @__PURE__ */ jsxs16("div", { className: classNames("review", panelOpen && "has-panel"), children: [
    /* @__PURE__ */ jsxs16("div", { className: "review-bar", children: [
      /* @__PURE__ */ jsxs16("div", { className: "review-bar-info", children: [
        /* @__PURE__ */ jsx18("strong", { children: pluralize(diff.files.length, "file") }),
        /* @__PURE__ */ jsxs16("span", { className: "add", children: [
          "+",
          diff.additions
        ] }),
        /* @__PURE__ */ jsxs16("span", { className: "del", children: [
          "\u2212",
          diff.deletions
        ] }),
        /* @__PURE__ */ jsxs16("span", { className: "muted", title: `base ${diff.baseRef}`, children: [
          "since ",
          shortRef(diff.baseRef),
          diff.includesWorkingTree && " \xB7 includes uncommitted work"
        ] }),
        diff.round > 1 && /* @__PURE__ */ jsxs16("span", { className: "pill is-sent", children: [
          "round ",
          diff.round
        ] })
      ] }),
      /* @__PURE__ */ jsxs16("div", { className: "review-bar-actions", children: [
        moved && // Round three should not be a cold read of the whole change.
        /* @__PURE__ */ jsxs16("div", { className: "segmented", role: "group", "aria-label": "Scope", children: [
          /* @__PURE__ */ jsx18(
            "button",
            {
              type: "button",
              className: classNames("seg", !onlyChanged && "is-active"),
              onClick: () => setOnlyChanged(false),
              children: "All files"
            }
          ),
          /* @__PURE__ */ jsxs16(
            "button",
            {
              type: "button",
              className: classNames("seg", onlyChanged && "is-active"),
              onClick: () => setOnlyChanged(true),
              title: `${moved.length} file(s) changed since round ${diff.previousRound}`,
              children: [
                "Changed since round ",
                diff.previousRound,
                " \xB7 ",
                moved.length
              ]
            }
          )
        ] }),
        /* @__PURE__ */ jsxs16("div", { className: "segmented", role: "group", "aria-label": "Diff layout", children: [
          /* @__PURE__ */ jsx18(
            "button",
            {
              type: "button",
              className: classNames("seg", diffMode === "unified" && "is-active"),
              onClick: () => store.setDiffMode("unified"),
              children: "Wrap"
            }
          ),
          /* @__PURE__ */ jsx18(
            "button",
            {
              type: "button",
              className: classNames("seg", diffMode === "split" && "is-active"),
              onClick: () => store.setDiffMode("split"),
              children: "No wrap"
            }
          )
        ] }),
        /* @__PURE__ */ jsx18(Button, { variant: "ghost", onClick: () => void store.refreshDiff(true), children: "Refresh" }),
        /* @__PURE__ */ jsxs16(Button, { variant: drafts.length ? "primary" : "default", onClick: () => setPanelOpen((v) => !v), children: [
          "Your review",
          drafts.length > 0 ? ` \xB7 ${drafts.length}` : ""
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxs16("div", { className: "review-body", children: [
      /* @__PURE__ */ jsx18(FileTree, { files: visible, selected: selectedFile, onSelect: scrollToFile }),
      /* @__PURE__ */ jsxs16("div", { className: "diff-pane", ref: scroller, children: [
        onlyChanged && visible.length === 0 && /* @__PURE__ */ jsxs16("p", { className: "dfile-note", children: [
          "Nothing changed since round ",
          diff.previousRound,
          "."
        ] }),
        visible.map((file) => /* @__PURE__ */ jsx18(
          DiffFileView,
          {
            file,
            selection,
            onSelect: setSelection,
            onCancelSelection: () => setSelection(null),
            registerAnchor
          },
          file.path
        ))
      ] }),
      panelOpen && /* @__PURE__ */ jsx18(PendingPanel, { gate, onJump: jumpToThread, onClose: () => setPanelOpen(false) })
    ] })
  ] });
}
function useReviewShortcuts(opts) {
  const ref = useRef4(opts);
  ref.current = opts;
  useEffect7(() => {
    const handler = (event) => {
      const target = event.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const { files, selected, onFile } = ref.current;
      const index = selected ? files.indexOf(selected) : -1;
      switch (event.key) {
        case "j":
        case "]": {
          event.preventDefault();
          const next = files[Math.min(files.length - 1, index + 1)];
          if (next) onFile(next);
          return;
        }
        case "k":
        case "[": {
          event.preventDefault();
          const previous = files[Math.max(0, index - 1)];
          if (previous) onFile(previous);
          return;
        }
        case "v":
          event.preventDefault();
          ref.current.onToggleViewed();
          return;
        case "p":
          event.preventDefault();
          ref.current.onTogglePanel();
          return;
        case "r":
          event.preventDefault();
          ref.current.onRefresh();
          return;
        case "/": {
          event.preventDefault();
          document.querySelector(".file-filter")?.focus();
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
function useTrackVisibleFile(scroller, anchors) {
  useEffect7(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const path = visible?.target.getAttribute("data-path");
        if (path) store.selectFile(path);
      },
      { root, rootMargin: "-8px 0px -70% 0px", threshold: 0 }
    );
    for (const node of anchors.current?.values() ?? []) observer.observe(node);
    return () => observer.disconnect();
  }, [scroller, anchors]);
}
function shortRef(ref) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
}
var init_ReviewView = __esm({
  "src/ui/views/ReviewView.tsx"() {
    "use strict";
    init_store();
    init_FileTree();
    init_DiffFile();
    init_PendingPanel();
    init_primitives();
    init_format();
  }
});

// src/ui/views/VerifyView.tsx
import { useEffect as useEffect8, useRef as useRef5, useState as useState14 } from "react";
import { Fragment as Fragment8, jsx as jsx19, jsxs as jsxs17 } from "react/jsx-runtime";
function VerifyView() {
  const session = useSession();
  const gate = useOpenGate();
  const sessionId = useStore((s) => s.sessionId);
  const [command, setCommand] = useState14("");
  const [notes, setNotes] = useState14("");
  const [busy, setBusy] = useState14(false);
  if (!session || !sessionId) return null;
  const failing = session.checks.filter((c) => c.status === "failed");
  const running = session.checks.some((c) => c.status === "running");
  const unrun = session.checks.filter((c) => c.status === "pending");
  const add = async () => {
    const value = command.trim();
    if (!value) return;
    try {
      await api.addCheck(sessionId, value);
      setCommand("");
    } catch (err) {
      store.fail(err);
    }
  };
  const submit = async (verdict) => {
    setBusy(true);
    try {
      if (gate) {
        await api.resolveGate(sessionId, gate.id, { verdict, comment: notes.trim() });
        store.toast("success", verdict === "approved" ? "Signed off \u2014 Claude is resuming." : "Sent to Claude.");
      } else {
        await api.feedback(sessionId, { text: notes.trim() || "Verification notes", origin: "checks" });
        store.toast("success", "Queued for Claude's next turn.");
      }
      setNotes("");
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs17("div", { className: "verify", children: [
    /* @__PURE__ */ jsxs17("div", { className: "verify-main", children: [
      /* @__PURE__ */ jsxs17("div", { className: "verify-bar", children: [
        /* @__PURE__ */ jsx19("strong", { children: "Checks" }),
        /* @__PURE__ */ jsx19("span", { className: "muted", children: session.checks.length === 0 ? "none configured" : failing.length ? `${failing.length} failing` : running ? "running\u2026" : unrun.length ? `${unrun.length} not run` : "all passing" }),
        /* @__PURE__ */ jsx19("span", { className: "spacer" }),
        /* @__PURE__ */ jsx19(Button, { onClick: () => void api.runChecks(sessionId).catch((e) => store.fail(e)), children: "Run all" })
      ] }),
      /* @__PURE__ */ jsxs17("div", { className: "check-add", children: [
        /* @__PURE__ */ jsx19(
          "input",
          {
            className: "input",
            value: command,
            placeholder: "npm test",
            onChange: (e) => setCommand(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") void add();
            }
          }
        ),
        /* @__PURE__ */ jsx19(Button, { variant: "ghost", onClick: () => void add(), disabled: !command.trim(), children: "Add check" })
      ] }),
      session.checks.length === 0 ? /* @__PURE__ */ jsx19(
        EmptyState,
        {
          title: "No checks configured",
          hint: /* @__PURE__ */ jsxs17(Fragment8, { children: [
            "Add one above, or set them per repo in ",
            /* @__PURE__ */ jsx19("code", { children: ".claude/harness.json" }),
            " under",
            " ",
            /* @__PURE__ */ jsx19("code", { children: "stages.verification.checks" }),
            "."
          ] })
        }
      ) : session.checks.map((check) => /* @__PURE__ */ jsx19(Check, { check, sessionId }, check.id))
    ] }),
    /* @__PURE__ */ jsxs17("aside", { className: "verify-side", children: [
      /* @__PURE__ */ jsx19("h3", { className: "panel-title", children: "Sign-off" }),
      failing.length > 0 && /* @__PURE__ */ jsxs17("p", { className: "warn-note", children: [
        failing.length,
        " check",
        failing.length === 1 ? "" : "s",
        " failing. Signing off anyway tells Claude to move on."
      ] }),
      gate ? /* @__PURE__ */ jsx19(Explain, { children: "Claude is parked here. Your verdict resumes it." }) : /* @__PURE__ */ jsx19(Explain, { children: "No gate is open, so this is queued for Claude's next turn." }),
      /* @__PURE__ */ jsx19(
        "textarea",
        {
          className: "input",
          rows: 4,
          value: notes,
          placeholder: "Testing notes (optional)",
          onChange: (e) => setNotes(e.target.value)
        }
      ),
      /* @__PURE__ */ jsxs17("div", { className: "row-actions", children: [
        /* @__PURE__ */ jsx19(Button, { variant: "primary", onClick: () => void submit("approved"), disabled: busy, children: "Looks verified" }),
        /* @__PURE__ */ jsx19(Button, { onClick: () => void submit("changes_requested"), disabled: busy, children: "Not ready" })
      ] })
    ] })
  ] });
}
function Check({ check, sessionId }) {
  const [open, setOpen] = useState14(check.status === "failed");
  const log = useRef5(null);
  const pinned = useRef5(true);
  useEffect8(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [check.output]);
  useEffect8(() => {
    if (check.status === "failed") setOpen(true);
  }, [check.status]);
  const elapsed = check.startedAt && check.finishedAt ? duration(check.finishedAt - check.startedAt) : null;
  return /* @__PURE__ */ jsxs17("section", { className: classNames("check", `is-${check.status}`), children: [
    /* @__PURE__ */ jsxs17("header", { className: "check-head", children: [
      /* @__PURE__ */ jsx19("span", { className: "check-mark", children: mark(check.status) }),
      /* @__PURE__ */ jsx19("code", { className: "check-cmd", children: check.command }),
      /* @__PURE__ */ jsx19("span", { className: "spacer" }),
      elapsed && /* @__PURE__ */ jsx19("span", { className: "muted", children: elapsed }),
      check.exitCode !== void 0 && check.status === "failed" && /* @__PURE__ */ jsxs17("span", { className: "muted", children: [
        "exit ",
        check.exitCode
      ] }),
      check.status === "running" ? /* @__PURE__ */ jsx19("button", { className: "link", onClick: () => void api.cancelCheck(sessionId, check.id).catch(() => {
      }), children: "cancel" }) : /* @__PURE__ */ jsx19(
        "button",
        {
          className: "link",
          onClick: () => void api.runChecks(sessionId, check.id).catch((e) => store.fail(e)),
          children: "run"
        }
      ),
      check.output && /* @__PURE__ */ jsx19("button", { className: "link", onClick: () => setOpen((v) => !v), children: open ? "hide output" : "show output" })
    ] }),
    open && check.output && /* @__PURE__ */ jsx19(
      "pre",
      {
        className: "check-output",
        ref: log,
        onScroll: (e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        },
        children: check.output
      }
    )
  ] });
}
function mark(status) {
  return { passed: "\u2713", failed: "\u2717", running: "\u27F3", pending: "\u25CB", skipped: "\u2013" }[status] ?? "\u25CB";
}
var init_VerifyView = __esm({
  "src/ui/views/VerifyView.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_primitives();
    init_format();
  }
});

// src/ui/views/ShipView.tsx
import { useEffect as useEffect9, useState as useState15 } from "react";
import { Fragment as Fragment9, jsx as jsx20, jsxs as jsxs18 } from "react/jsx-runtime";
function ShipView() {
  const session = useSession();
  const gate = useOpenGate();
  const sessionId = useStore((s) => s.sessionId);
  const [ship, setShip] = useState15(null);
  const [providers, setProviders] = useState15([]);
  const [loading, setLoading] = useState15(true);
  const [busy, setBusy] = useState15(false);
  const [confirming, setConfirming] = useState15(false);
  const [outcome, setOutcome] = useState15(
    null
  );
  useEffect9(() => {
    if (!sessionId) return;
    let live = true;
    setLoading(true);
    api.shipPreview(sessionId).then((res) => {
      if (!live) return;
      setShip(res.ship);
      setProviders(res.providers);
    }).catch((err) => store.fail(err)).finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sessionId]);
  if (!session || !sessionId) return null;
  if (loading) return /* @__PURE__ */ jsx20("div", { className: "view-pad", children: /* @__PURE__ */ jsx20(Spinner, { label: "Composing from the plan and review\u2026" }) });
  if (!ship) {
    return /* @__PURE__ */ jsx20("div", { className: "view-pad", children: /* @__PURE__ */ jsx20(EmptyState, { title: "Nothing to ship yet", hint: "The ship payload is built once there is a plan and a diff." }) });
  }
  const onBase = Boolean(ship.branch && ship.branch === ship.baseBranch);
  const failing = session.checks.filter((c) => c.status === "failed");
  const provider = providers.find((p) => p.id === ship.provider);
  const patch = (p) => setShip((current) => current ? { ...current, ...p } : current);
  const run = async () => {
    setBusy(true);
    setConfirming(false);
    try {
      const result = await api.executeShip(sessionId, ship);
      setOutcome(result);
      store.toast(result.ok ? "success" : "error", result.ok ? "Ship finished." : "Ship failed \u2014 see the log.");
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs18("div", { className: "ship", children: [
    /* @__PURE__ */ jsxs18("div", { className: "ship-main", children: [
      /* @__PURE__ */ jsx20(Panel, { title: "What will happen", children: /* @__PURE__ */ jsx20("ul", { className: "ship-steps", children: ALL_STEPS.map((step) => {
        const on = ship.steps.includes(step);
        return /* @__PURE__ */ jsx20("li", { className: classNames("ship-step", on && "is-on"), children: /* @__PURE__ */ jsxs18("label", { children: [
          /* @__PURE__ */ jsx20(
            "input",
            {
              type: "checkbox",
              checked: on,
              onChange: (e) => patch({
                steps: e.target.checked ? ALL_STEPS.filter((s) => s === step || ship.steps.includes(s)) : ship.steps.filter((s) => s !== step)
              })
            }
          ),
          /* @__PURE__ */ jsx20("span", { className: "ship-step-name", children: step }),
          /* @__PURE__ */ jsx20("span", { className: "muted", children: STEP_HELP[step] })
        ] }) }, step);
      }) }) }),
      /* @__PURE__ */ jsxs18(Panel, { title: "Pull request", children: [
        /* @__PURE__ */ jsxs18("label", { className: "field", children: [
          /* @__PURE__ */ jsx20("span", { children: "Provider" }),
          /* @__PURE__ */ jsx20("select", { value: ship.provider, onChange: (e) => patch({ provider: e.target.value }), children: providers.map((p) => /* @__PURE__ */ jsx20("option", { value: p.id, children: p.label }, p.id)) })
        ] }),
        provider?.kind === "mcp" && /* @__PURE__ */ jsx20(Explain, { children: "This provider runs through an MCP server connected to the Claude session, not the harness. Claude performs the PR call itself and reports the URL back." }),
        /* @__PURE__ */ jsxs18("label", { className: "field", children: [
          /* @__PURE__ */ jsx20("span", { children: "Title" }),
          /* @__PURE__ */ jsx20("input", { className: "input", value: ship.title, onChange: (e) => patch({ title: e.target.value }) })
        ] }),
        /* @__PURE__ */ jsxs18("label", { className: "field", children: [
          /* @__PURE__ */ jsx20("span", { children: "Body" }),
          /* @__PURE__ */ jsx20(
            "textarea",
            {
              className: "input ship-body",
              rows: 14,
              value: ship.body,
              onChange: (e) => patch({ body: e.target.value })
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsx20(Panel, { title: "Commit message", children: /* @__PURE__ */ jsx20(
        "textarea",
        {
          className: "input mono",
          rows: 5,
          value: ship.commitMessage,
          onChange: (e) => patch({ commitMessage: e.target.value })
        }
      ) }),
      outcome && /* @__PURE__ */ jsxs18(Panel, { title: outcome.ok ? "Result" : "Ship failed", className: outcome.ok ? "is-ok" : "is-failed", children: [
        outcome.url && /* @__PURE__ */ jsx20("p", { children: /* @__PURE__ */ jsx20("a", { href: outcome.url, target: "_blank", rel: "noreferrer", children: outcome.url }) }),
        outcome.directive && /* @__PURE__ */ jsxs18("p", { className: "explain", children: [
          "Handed to Claude to finish through its MCP server: ",
          outcome.directive
        ] }),
        /* @__PURE__ */ jsx20("pre", { className: "check-output", children: outcome.output })
      ] })
    ] }),
    /* @__PURE__ */ jsxs18("aside", { className: "ship-side", children: [
      /* @__PURE__ */ jsx20("h3", { className: "panel-title", children: "Confirm" }),
      /* @__PURE__ */ jsxs18("dl", { className: "ship-facts", children: [
        /* @__PURE__ */ jsx20("dt", { children: "Branch" }),
        /* @__PURE__ */ jsx20("dd", { children: /* @__PURE__ */ jsx20("code", { children: ship.branch ?? "detached" }) }),
        /* @__PURE__ */ jsx20("dt", { children: "Base" }),
        /* @__PURE__ */ jsx20("dd", { children: /* @__PURE__ */ jsx20("code", { children: ship.baseBranch ?? "unknown" }) })
      ] }),
      onBase && /* @__PURE__ */ jsxs18("p", { className: "warn-note", children: [
        "The session is on ",
        /* @__PURE__ */ jsx20("code", { children: ship.branch }),
        ", which is this repository's default branch. The harness will refuse to commit or push here \u2014 create a feature branch first."
      ] }),
      failing.length > 0 && ship.steps.includes("checks") && /* @__PURE__ */ jsxs18("p", { className: "warn-note", children: [
        failing.length,
        " check(s) failing \u2014 the checks step will stop the ship."
      ] }),
      gate ? /* @__PURE__ */ jsx20(Explain, { children: "Claude is parked here. Shipping resolves the gate and reports the result back to it." }) : /* @__PURE__ */ jsx20(Explain, { children: "This runs git commands against your working tree right now." }),
      confirming ? /* @__PURE__ */ jsxs18("div", { className: "ship-confirm", children: [
        /* @__PURE__ */ jsxs18("p", { children: [
          "Run ",
          /* @__PURE__ */ jsx20("strong", { children: ship.steps.join(" \u2192 ") }),
          " on ",
          /* @__PURE__ */ jsx20("code", { children: ship.branch }),
          ship.steps.includes("pr") && ship.baseBranch ? /* @__PURE__ */ jsxs18(Fragment9, { children: [
            " into ",
            /* @__PURE__ */ jsx20("code", { children: ship.baseBranch })
          ] }) : null,
          "?"
        ] }),
        /* @__PURE__ */ jsxs18("div", { className: "row-actions", children: [
          /* @__PURE__ */ jsx20(Button, { variant: "primary", onClick: () => void run(), disabled: busy, children: busy ? "Running\u2026" : "Yes, ship it" }),
          /* @__PURE__ */ jsx20(Button, { variant: "ghost", onClick: () => setConfirming(false), children: "Cancel" })
        ] })
      ] }) : /* @__PURE__ */ jsx20("div", { className: "row-actions", children: /* @__PURE__ */ jsx20(Button, { variant: "primary", onClick: () => setConfirming(true), disabled: busy || onBase, children: "Ship\u2026" }) })
    ] })
  ] });
}
var ALL_STEPS, STEP_HELP;
var init_ShipView = __esm({
  "src/ui/views/ShipView.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_primitives();
    init_format();
    ALL_STEPS = ["checks", "commit", "push", "pr", "summary"];
    STEP_HELP = {
      checks: "Refuse to continue if any check is failing",
      commit: "Stage the reviewed files and commit them",
      push: "Push the branch to origin",
      pr: "Open a pull request with the provider below",
      summary: "Write a markdown summary of the review into the repo"
    };
  }
});

// src/ui/App.tsx
var App_exports = {};
__export(App_exports, {
  App: () => App
});
import { useEffect as useEffect10 } from "react";
import { Fragment as Fragment10, jsx as jsx21, jsxs as jsxs19 } from "react/jsx-runtime";
function App() {
  const session = useSession();
  const sessionId = useStore((s) => s.sessionId);
  const tab = useStore((s) => s.tab);
  const error = useStore((s) => s.error);
  const gate = useOpenGate();
  const drafts = useDrafts();
  const sidebarCollapsed = useStore((s) => s.collapsedSidebar);
  useDocumentTitle(session, Boolean(gate));
  useUnsavedGuard(drafts.length);
  useShortcuts();
  return /* @__PURE__ */ jsxs19("div", { className: classNames("app", sidebarCollapsed && "is-sidebar-collapsed"), children: [
    /* @__PURE__ */ jsx21(Sidebar, {}),
    /* @__PURE__ */ jsx21("main", { className: "main", children: !sessionId || !session ? /* @__PURE__ */ jsx21(NoSession, { error }) : /* @__PURE__ */ jsxs19(Fragment10, { children: [
      /* @__PURE__ */ jsx21(Header, { session }),
      /* @__PURE__ */ jsx21(ConnectionBar, {}),
      /* @__PURE__ */ jsx21(GateBanner, {}),
      /* @__PURE__ */ jsx21("nav", { className: "tabs", role: "tablist", children: TABS.map((t) => /* @__PURE__ */ jsx21(TabButton, { id: t.id, label: t.label, active: tab === t.id, session }, t.id)) }),
      /* @__PURE__ */ jsxs19("div", { className: "view", children: [
        tab === "timeline" && /* @__PURE__ */ jsx21(ActivityView, {}),
        tab === "plan" && /* @__PURE__ */ jsx21(PlanView, {}),
        tab === "board" && /* @__PURE__ */ jsx21(BoardView, {}),
        tab === "review" && /* @__PURE__ */ jsx21(ReviewView, {}),
        tab === "verify" && /* @__PURE__ */ jsx21(VerifyView, {}),
        tab === "ship" && /* @__PURE__ */ jsx21(ShipView, {})
      ] }, tab),
      /* @__PURE__ */ jsx21(Composer, {})
    ] }) }),
    /* @__PURE__ */ jsx21(Toasts, {})
  ] });
}
function TabButton({
  id,
  label,
  active,
  session
}) {
  const drafts = useDrafts();
  const badge = tabBadge(id, session, drafts.length);
  return /* @__PURE__ */ jsxs19(
    "button",
    {
      type: "button",
      role: "tab",
      "aria-selected": active,
      className: classNames("tab", active && "is-active"),
      onClick: () => store.setTab(id),
      children: [
        label,
        badge && /* @__PURE__ */ jsx21("span", { className: classNames("tab-badge", `is-${badge.tone}`), children: badge.text })
      ]
    }
  );
}
function tabBadge(id, session, draftCount) {
  const gate = session.gates.find((g) => g.status === "open");
  switch (id) {
    case "review": {
      if (draftCount) return { text: String(draftCount), tone: "accent" };
      if (gate?.kind === "code_review") return { text: "!", tone: "warning" };
      return null;
    }
    case "plan":
      return gate?.kind === "plan" ? { text: "!", tone: "warning" } : null;
    case "board": {
      const blocked = session.tasks.filter((t) => t.status === "blocked").length;
      if (blocked) return { text: String(blocked), tone: "warning" };
      const open = session.tasks.filter((t) => t.status !== "done").length;
      return session.tasks.length > 0 ? { text: String(open), tone: "accent" } : null;
    }
    case "verify": {
      const failed = session.checks.filter((c) => c.status === "failed").length;
      if (failed) return { text: String(failed), tone: "danger" };
      if (gate?.kind === "verification") return { text: "!", tone: "warning" };
      return null;
    }
    case "ship":
      return gate?.kind === "ship" ? { text: "!", tone: "warning" } : null;
    case "timeline":
      return gate?.kind === "question" ? { text: "?", tone: "warning" } : null;
    default:
      return null;
  }
}
function Header({ session }) {
  const done = session.todos.filter((t) => t.status === "completed").length;
  return /* @__PURE__ */ jsxs19("header", { className: "head", children: [
    /* @__PURE__ */ jsxs19("div", { className: "head-main", children: [
      /* @__PURE__ */ jsx21("h1", { className: "head-title", title: session.cwd, children: session.title }),
      session.branch && /* @__PURE__ */ jsx21("code", { className: "head-branch", children: session.branch }),
      /* @__PURE__ */ jsx21("span", { className: classNames("head-status", `is-${session.status}`), children: statusLabel(session) }),
      /* @__PURE__ */ jsx21("span", { className: "spacer" }),
      /* @__PURE__ */ jsx21(ThemeToggle, {})
    ] }),
    /* @__PURE__ */ jsxs19("div", { className: "head-meta", children: [
      session.todos.length > 0 && /* @__PURE__ */ jsxs19("span", { className: "head-stat", children: [
        done,
        "/",
        session.todos.length,
        " tasks"
      ] }),
      session.files.length > 0 && /* @__PURE__ */ jsx21("span", { className: "head-stat", children: pluralize(session.files.length, "file") }),
      session.usage && session.usage.outputTokens > 0 && /* @__PURE__ */ jsxs19("span", { className: "head-stat", title: usageTooltip(session), children: [
        formatTokens(session.usage.outputTokens),
        " out"
      ] }),
      /* @__PURE__ */ jsx21("span", { className: "head-path", title: session.cwd, children: session.cwd })
    ] })
  ] });
}
function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
function usageTooltip(session) {
  const usage = session.usage;
  if (!usage) return "";
  const byStage = Object.entries(usage.byStage).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a).map(([stage, v]) => `  ${stage}: ${formatTokens(v)}`).join("\n");
  return `Output tokens by stage:
${byStage}

Input (incl. cache): ${formatTokens(usage.inputTokens)}`;
}
function statusLabel(session) {
  switch (session.status) {
    case "active":
      return "working";
    case "waiting":
      return "waiting on you";
    case "idle":
      return "idle";
    case "ended":
      return "ended";
  }
}
function NoSession({ error }) {
  return /* @__PURE__ */ jsx21("div", { className: "view", children: /* @__PURE__ */ jsx21(
    EmptyState,
    {
      title: "No session yet",
      hint: /* @__PURE__ */ jsxs19(Fragment10, { children: [
        "Start Claude Code in a project with the harness enabled, then run ",
        /* @__PURE__ */ jsx21("code", { children: "/harness" }),
        ". Sessions appear here the moment they register.",
        error && /* @__PURE__ */ jsxs19("span", { className: "error-text", children: [
          " \xB7 ",
          error
        ] })
      ] }),
      action: /* @__PURE__ */ jsxs19("p", { className: "empty-hint", children: [
        "If a session is running and nothing shows up, the hooks are not firing \u2014 run",
        " ",
        /* @__PURE__ */ jsx21("code", { children: "harness doctor" }),
        "."
      ] })
    }
  ) });
}
function useDocumentTitle(session, blocked) {
  useEffect10(() => {
    const name = session?.title ?? "cc-harness";
    document.title = blocked ? `\u25CF ${name} \u2014 waiting on you` : name;
  }, [session?.title, blocked]);
}
function useUnsavedGuard(draftCount) {
  useEffect10(() => {
    if (draftCount === 0) return;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [draftCount]);
}
function useShortcuts() {
  useEffect10(() => {
    const handler = (event) => {
      const target = event.target;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const map = {
        "1": "timeline",
        "2": "plan",
        "3": "board",
        "4": "review",
        "5": "verify",
        "6": "ship"
      };
      const tab = map[event.key];
      if (tab) {
        event.preventDefault();
        store.setTab(tab);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
var TABS;
var init_App = __esm({
  "src/ui/App.tsx"() {
    "use strict";
    init_store();
    init_Sidebar();
    init_GateBanner();
    init_Composer();
    init_Toasts();
    init_ConnectionBar();
    init_ThemeToggle();
    init_ActivityView();
    init_PlanView();
    init_BoardView();
    init_ReviewView();
    init_VerifyView();
    init_ShipView();
    init_primitives();
    init_format();
    TABS = [
      { id: "timeline", label: "Activity" },
      { id: "plan", label: "Plan" },
      { id: "board", label: "Board" },
      { id: "review", label: "Review" },
      { id: "verify", label: "Verify" },
      { id: "ship", label: "Ship" }
    ];
  }
});

// src/test/sidebar.test.tsx
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// src/test/dom-env.ts
import { JSDOM } from "jsdom";
function setupDom(url = "http://127.0.0.1:1234/#/session/s1") {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
    pretendToBeVisual: true
  });
  const win = dom.window;
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    HTMLElement: win["HTMLElement"],
    HTMLInputElement: win["HTMLInputElement"],
    HTMLTextAreaElement: win["HTMLTextAreaElement"],
    HTMLSelectElement: win["HTMLSelectElement"],
    Element: win["Element"],
    Node: win["Node"],
    Event: win["Event"],
    CustomEvent: win["CustomEvent"],
    KeyboardEvent: win["KeyboardEvent"],
    MouseEvent: win["MouseEvent"],
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id)
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  globalThis["IS_REACT_ACT_ENVIRONMENT"] = true;
  if (!("IntersectionObserver" in globalThis)) {
    Object.defineProperty(globalThis, "IntersectionObserver", {
      value: class {
        constructor(cb) {
          this.cb = cb;
        }
        observe() {
        }
        unobserve() {
        }
        disconnect() {
        }
        takeRecords() {
          return [];
        }
      },
      writable: true,
      configurable: true
    });
  }
  if (!("ResizeObserver" in globalThis)) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: class {
        observe() {
        }
        unobserve() {
        }
        disconnect() {
        }
      },
      writable: true,
      configurable: true
    });
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {
    };
  }
  if (!("EventSource" in globalThis)) {
    Object.defineProperty(globalThis, "EventSource", {
      value: class {
        constructor(url2) {
          this.url = url2;
        }
        onopen = null;
        onerror = null;
        onmessage = null;
        close() {
        }
      },
      writable: true,
      configurable: true
    });
  }
  return dom;
}
function stubFetch(handler) {
  const posts2 = [];
  Object.defineProperty(globalThis, "fetch", {
    value: async (input, init) => {
      const route = String(input);
      if (init?.method && init.method !== "GET") {
        posts2.push({ route, body: init.body ? JSON.parse(String(init.body)) : {} });
      }
      const body = handler(route, init);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
        text: async () => JSON.stringify(body)
      };
    },
    writable: true,
    configurable: true
  });
  return { posts: posts2 };
}

// src/test/sidebar.test.tsx
import { jsx as jsx22 } from "react/jsx-runtime";
setupDom();
var { render, fireEvent, within, cleanup, act, screen } = await import("@testing-library/react");
var { App: App2 } = await Promise.resolve().then(() => (init_App(), App_exports));
var { store: store2 } = await Promise.resolve().then(() => (init_store(), store_exports));
function makeSession() {
  const now = Date.now();
  return {
    sessionId: "s1",
    cwd: "/repo",
    repoRoot: "/repo",
    branch: "main",
    transcriptPath: null,
    title: "s1 title",
    stage: "implementing",
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
function summary(sessionId, repo, updatedAt) {
  return {
    sessionId,
    title: `${sessionId} title`,
    cwd: `/${repo}`,
    repoName: repo,
    repoRoot: `/${repo}`,
    branch: "main",
    stage: "implementing",
    status: "active",
    updatedAt,
    openGates: 0,
    pendingFeedback: 0,
    tasks: { total: 0, done: 0, blocked: 0 }
  };
}
var posts;
var SESSIONS = () => {
  const now = Date.now();
  return [summary("s1", "repo", now), summary("s2", "other", now - 1e3), summary("s3", "other", now - 2e3)];
};
async function boot() {
  ({ posts } = stubFetch((route) => {
    if (route.startsWith("/api/sessions")) return { sessions: SESSIONS(), version: "test" };
    if (route.startsWith("/api/session/")) return { session: makeSession(), diff: null };
    return { ok: true };
  }));
  render(/* @__PURE__ */ jsx22(App2, {}));
  await act(async () => {
    await store2.init();
  });
}
var groupNames = () => [...document.querySelectorAll(".session-group-name")].map((el) => el.textContent ?? "");
var rowNames = () => [...document.querySelectorAll(".session-row .session-name")].map((el) => el.textContent ?? "");
var rowFor = (text) => [...document.querySelectorAll(".session-row")].find(
  (el) => (el.textContent ?? "").includes(text)
);
var groupHeadFor = (text) => [...document.querySelectorAll(".session-group-head")].find(
  (el) => (el.textContent ?? "").includes(text)
);
beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  store2.set({
    sessions: [],
    sessionId: null,
    session: null,
    diff: null,
    drafts: {},
    toasts: [],
    pinned: [],
    collapsedProjects: [],
    collapsedSidebar: false
  });
});
after(() => cleanup());
test("sessions are grouped by the project they run in", async () => {
  await boot();
  assert.deepEqual(groupNames(), ["repo", "other"], "most recently active project first");
  const counts = [...document.querySelectorAll(".session-group-count")].map((el) => el.textContent);
  assert.deepEqual(counts, ["1", "2"]);
  assert.deepEqual(rowNames(), ["s1 title", "s2 title", "s3 title"]);
});
test("a project group folds away, and the fold is remembered", async () => {
  await boot();
  const other = groupHeadFor("other");
  await act(async () => {
    fireEvent.click(other);
  });
  assert.deepEqual(rowNames(), ["s1 title"], "the folded project hides its sessions");
  assert.equal(other.getAttribute("aria-expanded"), "false");
  assert.ok(store2.getState().collapsedProjects.includes("/other"));
  const saved = JSON.parse(window.localStorage.getItem("cc-harness:prefs") ?? "{}");
  assert.deepEqual(saved.collapsedProjects, ["/other"], "the fold survives a reload");
});
test("the group holding the open session stays open", async () => {
  await boot();
  assert.equal(store2.getState().sessionId, "s1");
  await act(async () => {
    fireEvent.click(groupHeadFor("repo"));
  });
  assert.ok(store2.getState().collapsedProjects.includes("/repo"));
  assert.ok(rowNames().includes("s1 title"));
});
test("a pinned session moves to its own group at the top", async () => {
  await boot();
  await act(async () => {
    fireEvent.click(within(rowFor("s3 title")).getByTitle("Pin session"));
  });
  assert.deepEqual(groupNames(), ["Pinned", "repo", "other"]);
  assert.deepEqual(store2.getState().pinned, ["s3"]);
  assert.match(document.querySelector(".session-group")?.textContent ?? "", /s3 title/);
  const saved = JSON.parse(window.localStorage.getItem("cc-harness:prefs") ?? "{}");
  assert.deepEqual(saved.pinned, ["s3"], "a pin is the reader\u2019s own preference and outlives the tab");
  await act(async () => {
    fireEvent.click(within(rowFor("s3 title")).getByTitle("Unpin session"));
  });
  assert.deepEqual(groupNames(), ["repo", "other"], "unpinning puts it back with its project");
});
test("deleting a session asks first, then deletes it for good", async () => {
  await boot();
  posts.length = 0;
  await act(async () => {
    fireEvent.click(within(rowFor("s2 title")).getByTitle("Delete session"));
  });
  assert.equal(posts.length, 0, "the first click only asks");
  assert.match(rowFor("s2 title").textContent ?? "", /Delete permanently\?/);
  await act(async () => {
    fireEvent.click(within(rowFor("s2 title")).getByText("Delete"));
  });
  const call = posts.find((p) => p.route.endsWith("/api/session/s2"));
  assert.ok(call, "confirming sends the delete");
  assert.ok(!rowNames().includes("s2 title"), "the row goes away");
});
test("cancelling a delete leaves the session alone", async () => {
  await boot();
  posts.length = 0;
  await act(async () => {
    fireEvent.click(within(rowFor("s2 title")).getByTitle("Delete session"));
  });
  await act(async () => {
    fireEvent.click(within(rowFor("s2 title")).getByText("Cancel"));
  });
  assert.equal(posts.length, 0);
  assert.ok(rowNames().includes("s2 title"));
});
test("deleting the open session moves to another one", async () => {
  await boot();
  assert.equal(store2.getState().sessionId, "s1");
  await act(async () => {
    fireEvent.click(within(rowFor("s1 title")).getByTitle("Delete session"));
  });
  await act(async () => {
    fireEvent.click(within(rowFor("s1 title")).getByText("Delete"));
  });
  assert.equal(store2.getState().sessionId, "s2");
});
test("deleting a session forgets the local state hanging off it", async () => {
  await boot();
  await act(async () => {
    store2.set({
      drafts: {
        s2: [
          {
            id: "c1",
            file: "a.ts",
            side: "new",
            startLine: 1,
            endLine: 1,
            body: "note",
            createdAt: Date.now(),
            resolved: false,
            draft: true
          }
        ]
      },
      pinned: ["s2"]
    });
  });
  await act(async () => {
    fireEvent.click(within(rowFor("s2 title")).getByTitle("Delete session"));
  });
  await act(async () => {
    fireEvent.click(within(rowFor("s2 title")).getByText("Delete"));
  });
  assert.equal(store2.getState().drafts["s2"], void 0);
  assert.deepEqual(store2.getState().pinned, []);
});
test("collapsing the sidebar narrows the column it sits in", async () => {
  await boot();
  assert.ok(!document.querySelector(".app")?.classList.contains("is-sidebar-collapsed"));
  await act(async () => {
    fireEvent.click(screen.getByTitle("Collapse sidebar"));
  });
  assert.ok(document.querySelector(".app")?.classList.contains("is-sidebar-collapsed"));
});
//# sourceMappingURL=sidebar.test.js.map
