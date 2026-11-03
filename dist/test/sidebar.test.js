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
    let message = body;
    try {
      message = JSON.parse(body).error ?? body;
    } catch {
    }
    throw new Error(message ? message.slice(0, 300) : `${res.status} ${res.statusText}`);
  }
  const type = res.headers.get("content-type") ?? "";
  return type.includes("json") ? await res.json() : await res.text();
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
      renameSession: (id, title) => request(`/api/session/${id}/title`, { method: "POST", body: JSON.stringify({ title }) }),
      /** Every edit the user makes goes through here, as a batch applied all or nothing. */
      ops: (id, ops) => request(`/api/session/${id}/plan/ops`, {
        method: "POST",
        body: JSON.stringify({ ops })
      }),
      /** The plan exactly as Claude reads it. */
      planText: (id) => request(`/api/session/${id}/plan/text`),
      /* ---------------------- daemon-wide actions ---------------------- */
      storage: () => request("/api/storage"),
      cleanStorage: (groups) => request("/api/storage/clean", {
        method: "POST",
        body: JSON.stringify({ groups })
      }),
      restartDaemon: () => request("/api/daemon/restart", { method: "POST", body: "{}" }),
      /** Unauthenticated liveness; `pid` tells a successor from a survivor. */
      health: () => request("/health")
    };
  }
});

// src/ui/store.ts
var store_exports = {};
__export(store_exports, {
  TAB_IDS: () => TAB_IDS,
  describeError: () => describeError,
  formatBytes: () => formatBytes,
  store: () => store,
  usePlan: () => usePlan,
  useSession: () => useSession,
  useStore: () => useStore
});
import { useSyncExternalStore } from "react";
function describeError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
async function waitForDaemon(previousPid, timeoutMs = 2e4) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    try {
      const health = await api.health();
      if (health.ok && health.pid !== previousPid) return true;
    } catch {
    }
  }
  return false;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function readHash() {
  const match = /^#\/session\/([^/?]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}
function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    const prefs = {};
    const strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    if (typeof saved["collapsedSidebar"] === "boolean") prefs.collapsedSidebar = saved["collapsedSidebar"];
    if (Array.isArray(saved["pinned"])) prefs.pinned = strings(saved["pinned"]);
    if (Array.isArray(saved["collapsedProjects"])) prefs.collapsedProjects = strings(saved["collapsedProjects"]);
    if (Array.isArray(saved["collapsedTasks"])) prefs.collapsedTasks = strings(saved["collapsedTasks"]);
    if (saved["taskMode"] === "outline" || saved["taskMode"] === "board") prefs.taskMode = saved["taskMode"];
    if (typeof saved["hideDone"] === "boolean") prefs.hideDone = saved["hideDone"];
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
function usePlan() {
  return useStore((s) => s.session?.plan ?? null);
}
var TAB_IDS, initial, PREFS_KEY, Store, store;
var init_store = __esm({
  "src/ui/store.ts"() {
    "use strict";
    init_api();
    TAB_IDS = ["diagrams", "tasks", "overview"];
    initial = {
      sessions: [],
      sessionId: null,
      session: null,
      tab: "diagrams",
      diagramId: null,
      connection: "connecting",
      taskMode: "outline",
      hideDone: false,
      collapsedTasks: [],
      collapsedSidebar: false,
      drawerOpen: false,
      pinned: [],
      collapsedProjects: [],
      focusTarget: null,
      storage: null,
      storageBusy: false,
      restarting: false,
      saving: 0,
      toasts: [],
      error: null
    };
    PREFS_KEY = "cc-harness:prefs";
    Store = class {
      state = { ...initial, ...loadPrefs() };
      listeners = /* @__PURE__ */ new Set();
      source = null;
      reconnectTimer;
      getState = () => this.state;
      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };
      set(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
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
          const target = readHash() ?? sessions[0]?.sessionId ?? null;
          if (target) await this.selectSession(target, false);
        } catch (err) {
          this.set({ error: describeError(err) });
        }
        if (!this.source) this.connect();
        window.addEventListener("hashchange", () => {
          const id = readHash();
          if (id && id !== this.state.sessionId) void this.selectSession(id, false);
        });
      }
      async selectSession(id, updateHash = true) {
        if (updateHash) window.location.hash = `#/session/${id}`;
        this.set({ sessionId: id, session: null, diagramId: null, error: null });
        this.connect();
        try {
          const { session } = await api.session(id);
          if (this.state.sessionId === id) this.set({ session });
        } catch (err) {
          if (this.state.sessionId === id) this.set({ error: describeError(err) });
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
          const { session } = await api.session(this.state.sessionId);
          this.set({ session, connection: "live" });
        } catch {
        }
      }
      apply(event) {
        switch (event.type) {
          case "sessions":
            this.set({ sessions: event.sessions });
            return;
          case "snapshot": {
            if (event.session.sessionId !== this.state.sessionId) return;
            const before = this.state.session?.plan;
            const after2 = event.session.plan;
            if (before && after2 && after2.revision > before.revision) {
              this.toast("info", `Claude published revision ${after2.revision} of the plan.`);
            }
            this.set({ session: event.session });
            return;
          }
          case "ping":
            return;
        }
      }
      /* ---------------------------------------------------------------- *
       * Editing the plan
       * ---------------------------------------------------------------- */
      /**
       * Send edits to the daemon. Resolves true when they were accepted; on a
       * refusal the daemon's reason is shown and the plan is left as it was.
       */
      async ops(ops) {
        return await this.commit(ops) !== null;
      }
      /**
       * Send edits, and resolve with the plan exactly as the daemon left it after
       * them — or null when they were refused. Callers that build on the result
       * (the canvas's revision) need the daemon's answer, not whatever the store
       * holds by the time it arrives.
       */
      async commit(ops, sessionId = this.state.sessionId) {
        const id = sessionId;
        if (!id || ops.length === 0) return null;
        this.set({ saving: this.state.saving + 1 });
        try {
          const { plan } = await api.ops(id, ops);
          const session = this.state.session;
          const order = (p) => p.version ?? p.seq;
          if (session && session.sessionId === id && (!session.plan || order(plan) >= order(session.plan))) {
            this.set({ session: { ...session, plan } });
          }
          return plan;
        } catch (err) {
          this.fail(err);
          return null;
        } finally {
          this.set({ saving: Math.max(0, this.state.saving - 1) });
        }
      }
      op(op) {
        return this.ops([op]);
      }
      /** Jump to an item from anywhere: a board card, the overview's "now". */
      focus(kind, id) {
        const tab = kind === "diagram" ? "diagrams" : kind === "task" ? "tasks" : "overview";
        if (kind === "diagram") this.set({ diagramId: id });
        if (kind === "node") {
          const [diagramId] = id.split(":");
          this.set({ tab: "diagrams", diagramId: diagramId ?? null, focusTarget: `node:${id}` });
          return;
        }
        if (kind === "task") {
          const tasks = this.state.session?.plan?.tasks ?? [];
          const ancestors = /* @__PURE__ */ new Set();
          let cursor = tasks.find((t) => t.id === id)?.parentId ?? null;
          while (cursor) {
            ancestors.add(cursor);
            cursor = tasks.find((t) => t.id === cursor)?.parentId ?? null;
          }
          this.set({ collapsedTasks: this.state.collapsedTasks.filter((t) => !ancestors.has(t)), taskMode: "outline" });
        }
        this.set({ tab, focusTarget: `${kind}:${id}` });
      }
      /* ---------------------------------------------------------------- *
       * Local preferences
       * ---------------------------------------------------------------- */
      setTab(tab) {
        this.set({ tab });
      }
      persistPrefs() {
        savePrefs({
          collapsedSidebar: this.state.collapsedSidebar,
          pinned: this.state.pinned,
          collapsedProjects: this.state.collapsedProjects,
          taskMode: this.state.taskMode,
          hideDone: this.state.hideDone,
          collapsedTasks: this.state.collapsedTasks
        });
      }
      setTaskMode(taskMode) {
        this.set({ taskMode });
        this.persistPrefs();
      }
      toggleHideDone() {
        this.set({ hideDone: !this.state.hideDone });
        this.persistPrefs();
      }
      toggleTaskCollapsed(id) {
        const collapsedTasks = this.state.collapsedTasks.includes(id) ? this.state.collapsedTasks.filter((t) => t !== id) : [...this.state.collapsedTasks, id];
        this.set({ collapsedTasks });
        this.persistPrefs();
      }
      toggleSidebar() {
        this.set({ collapsedSidebar: !this.state.collapsedSidebar });
        this.persistPrefs();
      }
      setDrawer(drawerOpen) {
        if (this.state.drawerOpen !== drawerOpen) this.set({ drawerOpen });
      }
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
      async renameSession(sessionId, title) {
        const next = title.trim();
        if (!next) return;
        this.set({
          sessions: this.state.sessions.map((s) => s.sessionId === sessionId ? { ...s, title: next } : s),
          ...this.state.session?.sessionId === sessionId ? { session: { ...this.state.session, title: next } } : {}
        });
        try {
          await api.renameSession(sessionId, next);
        } catch (err) {
          this.fail(err);
        }
      }
      async deleteSession(sessionId) {
        try {
          await api.deleteSession(sessionId);
        } catch (err) {
          this.fail(err);
          return;
        }
        const sessions = this.state.sessions.filter((s) => s.sessionId !== sessionId);
        this.set({ sessions, pinned: this.state.pinned.filter((id) => id !== sessionId) });
        this.persistPrefs();
        if (this.state.sessionId === sessionId) {
          this.set({ sessionId: null, session: null });
          window.location.hash = "";
          const next = sessions[0]?.sessionId;
          if (next) await this.selectSession(next);
        }
        this.toast("success", "Session deleted.");
      }
      /* ---------------------------------------------------------------- *
       * Daemon-wide actions
       * ---------------------------------------------------------------- */
      async loadStorage() {
        this.set({ storageBusy: true });
        try {
          const { report } = await api.storage();
          this.set({ storage: report });
        } catch (err) {
          this.fail(err);
        } finally {
          this.set({ storageBusy: false });
        }
      }
      async cleanStorage(groups) {
        if (groups.length === 0) return;
        this.set({ storageBusy: true });
        try {
          const { result, report } = await api.cleanStorage(groups);
          this.set({ storage: report });
          if (result.failed.length) this.toast("error", `${result.failed.length} item(s) could not be removed.`);
          else if (result.removed === 0) this.toast("info", "Nothing left to clean up.");
          else this.toast("success", `Reclaimed ${formatBytes(result.freedBytes)}.`);
        } catch (err) {
          this.fail(err);
        } finally {
          this.set({ storageBusy: false });
        }
      }
      /** Restart the daemon, then reload once a *different* process answers. */
      async restartDaemon(waitMs = 2e4) {
        if (this.state.restarting) return;
        let previousPid = 0;
        try {
          previousPid = (await api.health()).pid;
        } catch {
        }
        try {
          const { restarting } = await api.restartDaemon();
          if (!restarting) {
            this.toast("error", "The daemon is already shutting down.");
            return;
          }
          this.set({ restarting: true, connection: "reconnecting" });
        } catch (err) {
          this.fail(err);
          return;
        }
        const arrived = await waitForDaemon(previousPid, waitMs);
        if (!arrived) {
          this.set({ restarting: false });
          this.toast("error", "The daemon did not come back. Run `harness start` in a terminal.");
          return;
        }
        this.reloadPage();
      }
      /** Overridable because jsdom will not let a test redefine `location.reload`. */
      reloadPage = () => window.location.reload();
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
function classNames(...parts) {
  return parts.filter(Boolean).join(" ");
}
var init_format = __esm({
  "src/ui/lib/format.ts"() {
    "use strict";
  }
});

// src/ui/components/GlobalActions.tsx
import { useEffect, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function GlobalActions() {
  const restarting = useStore((s) => s.restarting);
  const [panel, setPanel] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return /* @__PURE__ */ jsxs("div", { className: "global", children: [
    /* @__PURE__ */ jsxs("div", { className: "global-bar", children: [
      /* @__PURE__ */ jsxs("span", { className: "global-version", children: [
        "v",
        true ? "0.2.0" : "dev"
      ] }),
      restarting && /* @__PURE__ */ jsx("span", { className: "global-note", children: "restarting\u2026" }),
      /* @__PURE__ */ jsx("span", { className: "spacer" }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: classNames("icon-btn", "is-tiny", panel && "is-active"),
          "aria-expanded": panel,
          title: "Clean up stale harness files",
          disabled: restarting,
          onClick: () => {
            const next = !panel;
            setPanel(next);
            setConfirming(false);
            if (next) void store.loadStorage();
          },
          children: "\u{1F9F9}"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: classNames("icon-btn", "is-tiny", confirming && "is-active"),
          title: "Restart the daemon to pick up a new build",
          disabled: restarting,
          onClick: () => {
            setConfirming(!confirming);
            setPanel(false);
          },
          children: "\u27F3"
        }
      )
    ] }),
    confirming && /* @__PURE__ */ jsxs("div", { className: "global-confirm", children: [
      /* @__PURE__ */ jsx("span", { children: "Restart the daemon? Open pages reconnect by themselves." }),
      /* @__PURE__ */ jsxs("div", { className: "row-actions", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "link",
            onClick: () => {
              setConfirming(false);
              void store.restartDaemon();
            },
            children: "Restart"
          }
        ),
        /* @__PURE__ */ jsx("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Cancel" })
      ] })
    ] }),
    panel && /* @__PURE__ */ jsx(StoragePanel, {})
  ] });
}
function StoragePanel() {
  const report = useStore((s) => s.storage);
  const busy = useStore((s) => s.storageBusy);
  const [selected, setSelected] = useState(DEFAULT_SELECTION);
  const groups = (report?.groups ?? []).filter((g) => g.count > 0);
  const chosen = groups.filter((g) => selected.includes(g.id));
  const total = chosen.reduce((sum, g) => sum + g.bytes, 0);
  useEffect(() => {
    if (!report) void store.loadStorage();
  }, [report]);
  const toggle = (id) => setSelected(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return /* @__PURE__ */ jsx("div", { className: "global-panel", children: !report ? /* @__PURE__ */ jsx("p", { className: "global-empty", children: busy ? "Scanning\u2026" : "Could not read the storage report." }) : groups.length === 0 ? /* @__PURE__ */ jsx("p", { className: "global-empty", children: "Nothing to clean up." }) : /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("ul", { className: "global-groups", children: groups.map((group) => /* @__PURE__ */ jsx(
      GroupRow,
      {
        group,
        checked: selected.includes(group.id),
        onToggle: () => toggle(group.id)
      },
      group.id
    )) }),
    /* @__PURE__ */ jsxs("div", { className: "global-panel-foot", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "btn btn-sm",
          disabled: busy || chosen.length === 0,
          onClick: () => void store.cleanStorage(chosen.map((g) => g.id)),
          children: busy ? "Working\u2026" : `Clean up ${formatBytes(total)}`
        }
      ),
      /* @__PURE__ */ jsx("button", { type: "button", className: "link", disabled: busy, onClick: () => void store.loadStorage(), children: "Rescan" })
    ] })
  ] }) });
}
function GroupRow({
  group,
  checked,
  onToggle
}) {
  return /* @__PURE__ */ jsxs("li", { className: "global-group", children: [
    /* @__PURE__ */ jsxs("label", { className: "global-group-head", children: [
      /* @__PURE__ */ jsx("input", { type: "checkbox", checked, onChange: onToggle }),
      /* @__PURE__ */ jsx("span", { className: "global-group-name", children: group.label }),
      /* @__PURE__ */ jsx("span", { className: "global-group-size", children: formatBytes(group.bytes) })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "global-group-detail", children: group.detail })
  ] });
}
var DEFAULT_SELECTION;
var init_GlobalActions = __esm({
  "src/ui/components/GlobalActions.tsx"() {
    "use strict";
    init_store();
    init_format();
    DEFAULT_SELECTION = ["partial-writes", "log", "lock"];
  }
});

// src/ui/components/Sidebar.tsx
import { useEffect as useEffect2, useRef, useState as useState2 } from "react";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.sessionId);
  const connection = useStore((s) => s.connection);
  const collapsed = useStore((s) => s.collapsedSidebar);
  const pinned = useStore((s) => s.pinned);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const groups = groupSessions(sessions, pinned);
  return /* @__PURE__ */ jsxs2(
    "aside",
    {
      className: classNames("sidebar", collapsed && "is-collapsed", drawerOpen && "is-drawer-open"),
      "aria-label": "Sessions",
      children: [
        /* @__PURE__ */ jsxs2("header", { className: "sidebar-head", children: [
          /* @__PURE__ */ jsx2("span", { className: "logo", "aria-hidden": "true", children: "cc" }),
          /* @__PURE__ */ jsxs2("div", { className: "sidebar-brand", children: [
            /* @__PURE__ */ jsx2("strong", { children: "harness" }),
            /* @__PURE__ */ jsx2("span", { className: classNames("conn", `is-${connection}`), children: connection === "live" ? "live" : connection === "connecting" ? "connecting\u2026" : "reconnecting\u2026" })
          ] }),
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              className: "icon-btn",
              title: collapsed ? "Expand sidebar" : "Collapse sidebar",
              "aria-label": collapsed ? "Expand sidebar" : "Collapse sidebar",
              "aria-expanded": !collapsed,
              onClick: () => store.toggleSidebar(),
              children: /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: collapsed ? "\u203A" : "\u2039" })
            }
          )
        ] }),
        collapsed && !drawerOpen ? /* @__PURE__ */ jsx2(CollapsedRail, { sessions, current }) : /* @__PURE__ */ jsx2("nav", { className: "session-list", "aria-label": "Live sessions", children: sessions.length === 0 ? /* @__PURE__ */ jsx2("p", { className: "sidebar-empty", children: "No sessions yet." }) : groups.map((group) => /* @__PURE__ */ jsx2(
          ProjectGroup,
          {
            group,
            current,
            open: !collapsedProjects.includes(group.key),
            showRepo: group.key === PINNED_KEY || group.key === WAITING_KEY
          },
          group.key
        )) }),
        /* @__PURE__ */ jsx2("footer", { className: "sidebar-foot", children: /* @__PURE__ */ jsx2(GlobalActions, {}) })
      ]
    }
  );
}
function groupSessions(sessions, pinned) {
  const pinnedSet = new Set(pinned);
  const groups = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    const key = session.waiting ? WAITING_KEY : pinnedSet.has(session.sessionId) ? PINNED_KEY : session.repoRoot ?? session.cwd;
    let group = groups.get(key);
    if (!group) {
      group = key === WAITING_KEY ? { key, label: "Waiting on you", path: "", sessions: [] } : key === PINNED_KEY ? { key, label: "Pinned", path: "", sessions: [] } : {
        key,
        label: groupLabel(session),
        path: session.repoRoot ?? session.cwd,
        sessions: []
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => b.createdAt - a.createdAt);
  }
  const rank = (key) => key === WAITING_KEY ? 0 : key === PINNED_KEY ? 1 : 2;
  return [...groups.values()].sort((a, b) => {
    if (rank(a.key) !== rank(b.key)) return rank(a.key) - rank(b.key);
    return (b.sessions[0]?.createdAt ?? 0) - (a.sessions[0]?.createdAt ?? 0);
  });
}
function groupLabel(session) {
  return session.repoName ?? basename(session.cwd) ?? "Unknown project";
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
  return /* @__PURE__ */ jsxs2("section", { className: classNames("session-group", expanded && "is-open"), children: [
    /* @__PURE__ */ jsxs2(
      "button",
      {
        type: "button",
        className: "session-group-head",
        "aria-expanded": expanded,
        title: group.path || void 0,
        onClick: () => store.toggleProject(group.key),
        children: [
          /* @__PURE__ */ jsx2("span", { className: "session-group-chevron", "aria-hidden": "true", children: expanded ? "\u25BE" : "\u25B8" }),
          /* @__PURE__ */ jsx2("span", { className: "session-group-name", children: group.label }),
          /* @__PURE__ */ jsx2("span", { className: "session-group-count", children: group.sessions.length })
        ]
      }
    ),
    expanded && /* @__PURE__ */ jsx2("div", { className: "session-group-body", children: group.sessions.map((s) => /* @__PURE__ */ jsx2(
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
  const pinned = useStore((s) => s.pinned.includes(session.sessionId));
  const [confirming, setConfirming] = useState2(false);
  const [renaming, setRenaming] = useState2(false);
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      className: classNames(
        "session-row",
        active && "is-active",
        confirming && "is-confirming"
      ),
      children: [
        renaming ? /* @__PURE__ */ jsx2(RenameField, { session, onDone: () => setRenaming(false) }) : /* @__PURE__ */ jsxs2(
          "button",
          {
            type: "button",
            className: "session-open",
            "aria-current": active ? "true" : void 0,
            onClick: () => {
              void store.selectSession(session.sessionId);
              store.setDrawer(false);
            },
            onDoubleClick: () => setRenaming(true),
            title: `${session.title}
${session.cwd}
Double-click to rename`,
            children: [
              /* @__PURE__ */ jsxs2("span", { className: "session-name", children: [
                session.waiting ? /* @__PURE__ */ jsx2("span", { className: "dot is-attention", title: "Claude is waiting on you", "aria-label": "Claude is waiting on you" }) : session.status === "active" && /* @__PURE__ */ jsx2("span", { className: "working-dot", title: "Claude is working", "aria-label": "Claude is working" }),
                session.planTitle ?? session.title
              ] }),
              session.waiting ? /* @__PURE__ */ jsx2("span", { className: "session-waiting", children: session.waiting.text }) : session.current && /* @__PURE__ */ jsxs2("span", { className: "session-now", children: [
                "now: ",
                session.current
              ] }),
              /* @__PURE__ */ jsxs2("span", { className: "session-sub", children: [
                session.planTitle && session.planTitle !== session.title && /* @__PURE__ */ jsx2("span", { className: "session-stage", children: session.title }),
                !session.planTitle && /* @__PURE__ */ jsx2("span", { className: "session-stage", children: "no plan yet" }),
                /* @__PURE__ */ jsx2("span", { className: classNames("session-state", `is-${session.status}`), children: SESSION_STATE_LABEL[session.status] ?? session.status }),
                session.branch && /* @__PURE__ */ jsx2("span", { className: "session-branch", children: session.branch })
              ] }),
              /* @__PURE__ */ jsxs2("span", { className: "session-foot", children: [
                showRepo && session.repoName && /* @__PURE__ */ jsx2("span", { className: "session-repo", children: groupLabel(session) }),
                session.tasks.total > 0 && /* @__PURE__ */ jsxs2("span", { title: `${session.tasks.done} of ${session.tasks.total} tasks done`, children: [
                  session.tasks.done,
                  "/",
                  session.tasks.total,
                  " tasks"
                ] }),
                /* @__PURE__ */ jsx2("span", { children: relativeTime(session.updatedAt) }),
                session.unreadByClaude > 0 && /* @__PURE__ */ jsx2("span", { className: "pill is-draft", title: "You changed the plan since Claude last read it", children: "unread" })
              ] })
            ]
          }
        ),
        session.waiting && session.link && !renaming && /* @__PURE__ */ jsx2("a", { className: "session-answer btn btn-sm btn-primary", href: session.link.app, title: "Open this session in the Claude desktop app", children: "Answer in Claude" }),
        /* @__PURE__ */ jsxs2("div", { className: "session-actions", children: [
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              className: "icon-btn is-tiny",
              title: "Rename this session",
              "aria-label": `Rename ${session.title}`,
              onClick: () => setRenaming(true),
              children: /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: "\u270E" })
            }
          ),
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              className: classNames("icon-btn", "is-tiny", pinned && "is-active"),
              "aria-pressed": pinned,
              title: pinned ? "Unpin session" : "Pin session",
              "aria-label": pinned ? `Unpin ${session.title}` : `Pin ${session.title}`,
              onClick: () => store.togglePin(session.sessionId),
              children: /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: pinned ? "\u2605" : "\u2606" })
            }
          ),
          /* @__PURE__ */ jsx2(
            "button",
            {
              type: "button",
              className: "icon-btn is-tiny is-danger",
              title: "Delete session",
              "aria-label": `Delete ${session.title}`,
              onClick: () => setConfirming(true),
              children: /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: "\xD7" })
            }
          )
        ] }),
        confirming && /* @__PURE__ */ jsxs2("div", { className: "session-confirm", children: [
          /* @__PURE__ */ jsx2("span", { children: "Delete permanently?" }),
          /* @__PURE__ */ jsxs2("div", { className: "row-actions", children: [
            /* @__PURE__ */ jsx2(
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
            /* @__PURE__ */ jsx2("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Cancel" })
          ] })
        ] })
      ]
    }
  );
}
function RenameField({ session, onDone }) {
  const [value, setValue] = useState2(session.title);
  const input = useRef(null);
  const done = useRef(false);
  useEffect2(() => {
    input.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (next && next !== session.title) void store.renameSession(session.sessionId, next);
    onDone();
  };
  const abandon = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };
  return /* @__PURE__ */ jsx2(
    "input",
    {
      ref: input,
      className: "session-rename",
      value,
      "aria-label": `Rename ${session.title}`,
      maxLength: 120,
      onChange: (e) => setValue(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") abandon();
      }
    }
  );
}
function CollapsedRail({ sessions, current }) {
  const ordered = [...sessions].sort((a, b) => Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || b.createdAt - a.createdAt);
  return /* @__PURE__ */ jsx2("nav", { className: "session-rail", "aria-label": "Sessions", children: ordered.map((s) => {
    const name = s.planTitle ?? s.title;
    return /* @__PURE__ */ jsxs2(
      "button",
      {
        type: "button",
        className: classNames("rail-item", s.sessionId === current && "is-active", s.waiting && "is-waiting"),
        "aria-current": s.sessionId === current ? "true" : void 0,
        title: `${name}${s.waiting ? ` \u2014 waiting on you: ${s.waiting.text}` : s.current ? ` \u2014 now: ${s.current}` : ""}`,
        "aria-label": `${name}${s.waiting ? ", waiting on you" : ""}`,
        onClick: () => void store.selectSession(s.sessionId),
        children: [
          /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: initials(name) }),
          s.waiting && /* @__PURE__ */ jsx2("span", { className: "rail-dot is-attention", "aria-hidden": "true" }),
          !s.waiting && s.status === "active" && /* @__PURE__ */ jsx2("span", { className: "rail-dot is-working", "aria-hidden": "true" })
        ]
      },
      s.sessionId
    );
  }) });
}
function initials(name) {
  const all = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !MINOR_WORDS.has(w.toLowerCase()));
  if (words.length === 0) words.push(...all);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}
var SESSION_STATE_LABEL, WAITING_KEY, PINNED_KEY, MINOR_WORDS;
var init_Sidebar = __esm({
  "src/ui/components/Sidebar.tsx"() {
    "use strict";
    init_store();
    init_GlobalActions();
    init_format();
    SESSION_STATE_LABEL = {
      active: "working",
      idle: "idle",
      ended: "ended"
    };
    WAITING_KEY = "\0waiting";
    PINNED_KEY = "\0pinned";
    MINOR_WORDS = /* @__PURE__ */ new Set(["a", "an", "the", "to", "of", "for", "and", "in", "on", "with"]);
  }
});

// src/ui/components/Toasts.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return /* @__PURE__ */ jsx3("div", { className: "toasts", role: "status", "aria-live": "polite", children: toasts.map((toast) => /* @__PURE__ */ jsxs3("div", { className: classNames("toast", `is-${toast.kind}`), children: [
    /* @__PURE__ */ jsx3("span", { children: toast.text }),
    /* @__PURE__ */ jsx3(
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
import { useEffect as useEffect3, useState as useState3 } from "react";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function ConnectionBar() {
  const connection = useStore((s) => s.connection);
  const [since, setSince] = useState3(null);
  const [now, setNow] = useState3(Date.now());
  useEffect3(() => {
    if (connection === "live") {
      setSince(null);
      return;
    }
    setSince((current) => current ?? Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1e3);
    return () => window.clearInterval(timer);
  }, [connection]);
  if (connection === "live" || !since || now - since < 2e3) return null;
  return /* @__PURE__ */ jsxs4("div", { className: "conn-bar", role: "status", children: [
    /* @__PURE__ */ jsx4("span", { "aria-hidden": "true", children: "\u26A0" }),
    /* @__PURE__ */ jsxs4("span", { children: [
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
import { useEffect as useEffect4, useState as useState4 } from "react";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function ThemeToggle() {
  const [theme, setTheme] = useState4(readStored);
  useEffect4(() => {
    const media = matchDark();
    const apply = () => {
      const resolved = theme === "system" ? media?.matches ? "dark" : "light" : theme;
      document.documentElement.setAttribute("data-theme", resolved);
    };
    apply();
    try {
      window.localStorage.setItem(KEY, theme);
    } catch {
    }
    if (theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return /* @__PURE__ */ jsx5("div", { className: "segmented", role: "group", "aria-label": "Colour theme", children: ORDER.map((option) => /* @__PURE__ */ jsxs5(
    "button",
    {
      type: "button",
      className: classNames("seg", theme === option && "is-active"),
      "aria-pressed": theme === option,
      title: LABEL[option],
      onClick: () => setTheme(option),
      children: [
        ICON[option],
        /* @__PURE__ */ jsx5("span", { className: "sr-only", children: LABEL[option] })
      ]
    },
    option
  )) });
}
function readStored() {
  try {
    const saved = window.localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  } catch {
    return "system";
  }
}
function matchDark() {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  } catch {
    return null;
  }
}
var KEY, ORDER, LABEL, ICON;
var init_ThemeToggle = __esm({
  "src/ui/components/ThemeToggle.tsx"() {
    "use strict";
    init_format();
    KEY = "cc-harness:theme";
    ORDER = ["system", "light", "dark"];
    LABEL = { system: "Match the system", light: "Light", dark: "Dark" };
    ICON = {
      system: /* @__PURE__ */ jsxs5("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
        /* @__PURE__ */ jsx5("circle", { cx: "8", cy: "8", r: "6", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }),
        /* @__PURE__ */ jsx5("path", { d: "M8 2a6 6 0 0 1 0 12z", fill: "currentColor" })
      ] }),
      light: /* @__PURE__ */ jsxs5("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
        /* @__PURE__ */ jsx5("circle", { cx: "8", cy: "8", r: "3", fill: "currentColor" }),
        /* @__PURE__ */ jsx5("g", { stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", children: /* @__PURE__ */ jsx5("path", { d: "M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" }) })
      ] }),
      dark: /* @__PURE__ */ jsx5("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: /* @__PURE__ */ jsx5("path", { d: "M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z", fill: "currentColor" }) })
    };
  }
});

// src/shared/types.ts
var NODE_KINDS, EDGE_ARROWS, TASK_STATUSES;
var init_types = __esm({
  "src/shared/types.ts"() {
    "use strict";
    NODE_KINDS = ["component", "service", "datastore", "queue", "external", "actor", "note"];
    EDGE_ARROWS = ["end", "both", "none"];
    TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];
  }
});

// src/shared/plan.ts
function unreadByClaude(plan) {
  if (!plan) return [];
  return plan.changes.filter((c) => c.seq > plan.claudeReadSeq && c.author === "user");
}
function unreadAreas(plan) {
  const areas = [];
  const add = (what) => void (areas.includes(what) || areas.push(what));
  for (const c of unreadByClaude(plan)) {
    if (["commented", "replied", "resolved", "reopened"].includes(c.kind)) add("comments");
    else if (c.target.kind === "diagram") add(`the "${plan.diagrams.find((d) => d.id === c.target.id)?.title ?? c.target.id}" diagram`);
    else if (c.target.kind === "task") add("tasks");
    else if (c.target.kind === "section") add("sections");
    else if (c.summary.startsWith(RENAMED_PLAN)) add("the plan's title");
    else add("the summary");
  }
  return areas;
}
function flowRanks(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const out = /* @__PURE__ */ new Map();
  const connected = [];
  const seen = /* @__PURE__ */ new Set();
  for (const e of edges) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    out.set(e.source, [...out.get(e.source) ?? [], e.target]);
    for (const end of [e.source, e.target]) {
      if (!seen.has(end)) connected.push(end);
      seen.add(end);
    }
  }
  const state = /* @__PURE__ */ new Map();
  const order = [];
  const forward = /* @__PURE__ */ new Map();
  const visit = (v) => {
    state.set(v, "open");
    const keep = [];
    for (const w of out.get(v) ?? []) {
      if (state.get(w) === "open") continue;
      keep.push(w);
      if (!state.has(w)) visit(w);
    }
    forward.set(v, keep);
    state.set(v, "done");
    order.push(v);
  };
  for (const v of connected) if (!state.has(v)) visit(v);
  const rank = new Map(connected.map((v) => [v, 0]));
  for (const v of order.reverse()) {
    for (const w of forward.get(v) ?? []) rank.set(w, Math.max(rank.get(w) ?? 0, rank.get(v) + 1));
  }
  return rank;
}
function childrenOf(plan, parentId) {
  return plan.tasks.filter((t) => t.parentId === parentId).sort((a, b) => a.order - b.order);
}
function descendants(plan, id) {
  const out = [];
  const visit = (pid) => {
    for (const child of childrenOf(plan, pid)) {
      out.push(child);
      visit(child.id);
    }
  };
  visit(id);
  return out;
}
function outline(plan) {
  const out = [];
  const visit = (parentId, depth, prefix) => {
    childrenOf(plan, parentId).forEach((task, i) => {
      const number = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push({ task, depth, number });
      visit(task.id, depth + 1, number);
    });
  };
  visit(null, 0, "");
  return out;
}
function countTasks(plan) {
  const counts = { total: 0, done: 0, inProgress: 0, blocked: 0 };
  if (!plan) return counts;
  const parents = new Set(plan.tasks.map((t) => t.parentId).filter(Boolean));
  for (const t of plan.tasks) {
    if (parents.has(t.id)) continue;
    counts.total++;
    if (t.status === "done") counts.done++;
    else if (t.status === "in_progress") counts.inProgress++;
    else if (t.status === "blocked") counts.blocked++;
  }
  return counts;
}
function currentTask(plan) {
  if (!plan) return null;
  return outline(plan).find((r) => r.task.status === "in_progress" && !plan.tasks.some((t) => t.parentId === r.task.id))?.task ?? null;
}
var RENAMED_PLAN;
var init_plan = __esm({
  "src/shared/plan.ts"() {
    "use strict";
    init_types();
    RENAMED_PLAN = "renamed the plan";
  }
});

// src/ui/components/Handoff.tsx
import { useEffect as useEffect5, useState as useState5 } from "react";
import { jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function Handoff() {
  const session = useSession();
  const plan = usePlan();
  const [viewing, setViewing] = useState5(false);
  if (!session) return null;
  const areas = unreadAreas(plan);
  const unread = areas.length;
  return /* @__PURE__ */ jsxs6("div", { className: "handoff", children: [
    plan && (unread > 0 ? /* @__PURE__ */ jsxs6("span", { className: "handoff-state is-behind", title: `You changed ${areas.join(", ")} since Claude last read the plan`, children: [
      /* @__PURE__ */ jsx6("span", { className: "dot is-attention", "aria-hidden": "true" }),
      "Claude hasn't read your changes"
    ] }) : /* @__PURE__ */ jsxs6("span", { className: "handoff-state is-current", title: plan.claudeReadAt ? `Read ${new Date(plan.claudeReadAt).toLocaleString()}` : void 0, children: [
      "\u2713 Claude is up to date",
      plan.claudeReadAt ? ` \xB7 read ${relativeTime(plan.claudeReadAt)}` : ""
    ] })),
    /* @__PURE__ */ jsx6(OpenInClaude, { session, primary: unread > 0 }),
    plan && /* @__PURE__ */ jsx6("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: () => setViewing(true), children: "As Claude sees it" }),
    viewing && /* @__PURE__ */ jsx6(ClaudeView, { onClose: () => setViewing(false) })
  ] });
}
function OpenInClaude({
  session,
  primary,
  label = "Open in Claude"
}) {
  if (session.link) return /* @__PURE__ */ jsx6(ClaudeLinks, { link: session.link, primary, label });
  return /* @__PURE__ */ jsx6(
    "button",
    {
      type: "button",
      className: classNames("btn btn-sm", primary && "btn-primary"),
      title: `${whereItRuns(session)} has no link the harness can open. Copies a message to paste there instead.`,
      onClick: () => void copyHandoff(),
      children: "Copy message for Claude"
    }
  );
}
function ClaudeLinks({ link, primary, label }) {
  return /* @__PURE__ */ jsxs6("span", { className: "claude-links", children: [
    /* @__PURE__ */ jsx6("a", { className: classNames("btn btn-sm", primary && "btn-primary"), href: link.app, title: "Open this session in the Claude desktop app", children: label }),
    /* @__PURE__ */ jsx6("a", { className: "link claude-web", href: link.web, target: "_blank", rel: "noreferrer", title: "Open this session on claude.ai", children: "web" })
  ] });
}
function WaitingBanner({ session }) {
  const waiting = session.waiting;
  if (!waiting) return null;
  return /* @__PURE__ */ jsxs6("section", { className: classNames("waiting", `is-${waiting.kind}`), role: "status", "aria-label": "Claude is waiting on you", children: [
    /* @__PURE__ */ jsxs6("div", { className: "waiting-body", children: [
      /* @__PURE__ */ jsxs6("p", { className: "waiting-head", children: [
        /* @__PURE__ */ jsx6("span", { className: "dot is-attention", "aria-hidden": "true" }),
        HEADLINE[waiting.kind],
        /* @__PURE__ */ jsxs6("span", { className: "muted", children: [
          " \xB7 ",
          relativeTime(waiting.since)
        ] })
      ] }),
      waiting.questions?.length ? /* @__PURE__ */ jsx6("ol", { className: "waiting-questions", children: waiting.questions.map((q, i) => /* @__PURE__ */ jsxs6("li", { children: [
        q.header && /* @__PURE__ */ jsx6("span", { className: "qchip", children: q.header }),
        " ",
        /* @__PURE__ */ jsx6("strong", { children: q.question }),
        q.options.length > 0 && /* @__PURE__ */ jsxs6("span", { className: "waiting-options", children: [
          q.multiSelect ? "choose any: " : "choose one: ",
          q.options.join(" \xB7 ")
        ] })
      ] }, i)) }) : /* @__PURE__ */ jsx6("p", { className: "waiting-text", children: waiting.text }),
      !session.link && /* @__PURE__ */ jsx6("p", { className: "waiting-hint", children: noLinkHint(session) })
    ] }),
    /* @__PURE__ */ jsx6(OpenInClaude, { session, primary: true, label: waiting.kind === "permission" ? "Decide in Claude" : "Answer in Claude" })
  ] });
}
function whereItRuns(session) {
  return session.surface === "desktop" ? "This desktop session" : session.surface === "cli" ? "This terminal session" : "This session";
}
function noLinkHint(session) {
  const where = session.surface === "desktop" ? "in the Claude desktop app" : session.surface === "cli" ? "in your terminal" : "where the session is running";
  return `Answer it ${where}. Turn on Remote Control there (/remote-control) and this becomes a link that opens the session directly.`;
}
async function copyHandoff() {
  try {
    await navigator.clipboard.writeText(HANDOFF_MESSAGE);
    store.toast("success", "Copied \u2014 paste it into Claude's chat.");
  } catch {
    store.toast("info", `Tell Claude: "${HANDOFF_MESSAGE}"`);
  }
}
function ClaudeView({ onClose }) {
  const session = useSession();
  const plan = usePlan();
  const [text, setText] = useState5(null);
  useEffect5(() => {
    if (!session) return;
    let live = true;
    api.planText(session.sessionId).then((t) => live && setText(t)).catch((err) => live && setText(`Could not load: ${err.message}`));
    return () => {
      live = false;
    };
  }, [session?.sessionId, plan?.seq]);
  useEffect5(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return /* @__PURE__ */ jsxs6("div", { className: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": "The plan as Claude reads it", children: [
    /* @__PURE__ */ jsx6("button", { type: "button", className: "lightbox-scrim", "aria-label": "Close", onClick: onClose }),
    /* @__PURE__ */ jsxs6("div", { className: "lightbox-body is-text", children: [
      /* @__PURE__ */ jsxs6("header", { className: "item-head", children: [
        /* @__PURE__ */ jsx6("h2", { className: "section-title", children: "What Claude reads" }),
        /* @__PURE__ */ jsx6("span", { className: "muted", children: "the output of harness_plan_read" }),
        /* @__PURE__ */ jsx6("span", { className: "spacer" }),
        /* @__PURE__ */ jsx6("button", { type: "button", className: "icon-btn", "aria-label": "Close", onClick: onClose, children: "\xD7" })
      ] }),
      /* @__PURE__ */ jsx6("pre", { className: "claude-text", children: text ?? "Loading\u2026" })
    ] })
  ] });
}
var HANDOFF_MESSAGE, HEADLINE;
var init_Handoff = __esm({
  "src/ui/components/Handoff.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_format();
    init_plan();
    HANDOFF_MESSAGE = "I've updated the plan in the harness. Read it with harness_plan_read, take my edits and comments into account, and tell me what changes.";
    HEADLINE = {
      question: "Claude is asking you",
      permission: "Claude needs your permission",
      input: "Claude is waiting for your reply"
    };
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
  const indent2 = (match[1] ?? "").replace(/\t/g, "  ").length;
  let content = match[2] ?? "";
  const item = { type: bullet ? "ul" : "ol", indent: indent2, content };
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
import { jsx as jsx7 } from "react/jsx-runtime";
function Markdown({ source, className }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return /* @__PURE__ */ jsx7("div", { className: className ? `md ${className}` : "md", dangerouslySetInnerHTML: { __html: html } });
}
var init_Markdown = __esm({
  "src/ui/components/Markdown.tsx"() {
    "use strict";
    init_markdown();
  }
});

// src/ui/components/Editable.tsx
import { useEffect as useEffect6, useRef as useRef2, useState as useState6 } from "react";
import { jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
function InlineText({
  value,
  onSave,
  label,
  placeholder = "Untitled",
  className,
  as: Tag = "span"
}) {
  const [editing, setEditing] = useState6(false);
  const [draft, setDraft] = useState6(value);
  const done = useRef2(false);
  const input = useRef2(null);
  useEffect6(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect6(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const start = () => {
    done.current = false;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) void onSave(next);
  };
  const abandon = () => {
    done.current = true;
    setEditing(false);
    setDraft(value);
  };
  if (editing) {
    return /* @__PURE__ */ jsx8(
      "input",
      {
        ref: input,
        className: classNames("inline-input", className),
        value: draft,
        "aria-label": label,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            abandon();
          }
        }
      }
    );
  }
  return /* @__PURE__ */ jsx8(Tag, { className: classNames("inline-text", !value && "is-empty", className), children: /* @__PURE__ */ jsx8("button", { type: "button", className: "inline-trigger", onClick: start, title: "Click to edit", "aria-label": `${label}: ${value || placeholder}. Edit`, children: value || placeholder }) });
}
function MarkdownField({
  value,
  onSave,
  label,
  placeholder = "Nothing written yet.",
  emptyAction = "Add detail",
  rows = 6,
  className,
  startEditing = false,
  onCancel,
  version
}) {
  const [editing, setEditing] = useState6(startEditing);
  const [draft, setDraft] = useState6(value);
  const [saving, setSaving] = useState6(false);
  const startedAt = useRef2(version);
  const area = useRef2(null);
  useEffect6(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect6(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  const begin = () => {
    startedAt.current = version;
    setEditing(true);
  };
  const changedUnderneath = editing && version !== void 0 && startedAt.current !== void 0 && version !== startedAt.current;
  const save = async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const base = changedUnderneath ? version : startedAt.current;
    const result = await onSave(draft, base);
    setSaving(false);
    if (result === false) {
      startedAt.current = version;
      return;
    }
    setEditing(false);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(value);
    onCancel?.();
  };
  const onKeyDown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
  };
  if (editing) {
    return /* @__PURE__ */ jsxs7("div", { className: classNames("md-field is-editing", className), children: [
      /* @__PURE__ */ jsx8(
        "textarea",
        {
          ref: area,
          className: "input md-input",
          value: draft,
          rows: Math.max(rows, Math.min(24, draft.split("\n").length + 1)),
          "aria-label": label,
          placeholder: "Markdown: **bold**, `code`, - lists, ## headings",
          onChange: (e) => setDraft(e.target.value),
          onKeyDown
        }
      ),
      changedUnderneath && /* @__PURE__ */ jsx8("p", { className: "md-conflict", role: "alert", children: "This changed while you were editing. Saving now replaces the newer version with your text \u2014 copy anything you want to keep from it first." }),
      /* @__PURE__ */ jsxs7("div", { className: "md-field-foot", children: [
        /* @__PURE__ */ jsx8("span", { className: "muted", children: "Markdown \xB7 \u2318/Ctrl+Enter to save \xB7 Esc to cancel" }),
        /* @__PURE__ */ jsx8("span", { className: "spacer" }),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: cancel, children: "Cancel" }),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-sm btn-primary", disabled: saving, onClick: () => void save(), children: saving ? "Saving\u2026" : "Save" })
      ] })
    ] });
  }
  if (!value.trim()) {
    return /* @__PURE__ */ jsx8("div", { className: classNames("md-field is-empty", className), children: /* @__PURE__ */ jsxs7("button", { type: "button", className: "md-empty", onClick: begin, "aria-label": `${emptyAction}: ${label}`, children: [
      /* @__PURE__ */ jsx8("span", { className: "muted", children: placeholder }),
      " ",
      /* @__PURE__ */ jsx8("span", { className: "link", children: emptyAction })
    ] }) });
  }
  return /* @__PURE__ */ jsxs7("div", { className: classNames("md-field", className), children: [
    /* @__PURE__ */ jsx8(Markdown, { source: value }),
    /* @__PURE__ */ jsx8("button", { type: "button", className: "md-edit icon-btn is-tiny", title: `Edit ${label}`, "aria-label": `Edit ${label}`, onClick: begin, children: /* @__PURE__ */ jsx8("span", { "aria-hidden": "true", children: "\u270E" }) })
  ] });
}
function AddField({
  placeholder,
  label,
  onAdd,
  autoFocus,
  onCancel,
  children
}) {
  const [value, setValue] = useState6("");
  return /* @__PURE__ */ jsxs7(
    "form",
    {
      className: "add-field",
      onSubmit: async (e) => {
        e.preventDefault();
        const next = value.trim();
        if (!next) return;
        const ok = await onAdd(next);
        if (ok !== false) setValue("");
      },
      children: [
        /* @__PURE__ */ jsx8(
          "input",
          {
            className: "input",
            value,
            placeholder,
            "aria-label": label,
            autoFocus,
            onChange: (e) => setValue(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Escape" && onCancel) {
                e.stopPropagation();
                onCancel();
              }
            },
            onBlur: () => {
              if (!value.trim()) onCancel?.();
            }
          }
        ),
        children,
        /* @__PURE__ */ jsx8("button", { type: "submit", className: "btn btn-sm", disabled: !value.trim(), children: "Add" })
      ]
    }
  );
}
var init_Editable = __esm({
  "src/ui/components/Editable.tsx"() {
    "use strict";
    init_Markdown();
    init_format();
  }
});

// src/ui/components/Progress.tsx
import { jsx as jsx9, jsxs as jsxs8 } from "react/jsx-runtime";
function ProgressBar({ counts, compact }) {
  const total = Math.max(1, counts.total);
  const pct = (n) => `${n / total * 100}%`;
  return /* @__PURE__ */ jsxs8(
    "span",
    {
      className: classNames("progress", compact && "is-compact"),
      role: "img",
      "aria-label": `${counts.done} of ${counts.total} tasks done${counts.inProgress ? `, ${counts.inProgress} in progress` : ""}${counts.blocked ? `, ${counts.blocked} blocked` : ""}`,
      children: [
        /* @__PURE__ */ jsx9("span", { className: "progress-seg is-done", style: { width: pct(counts.done) } }),
        /* @__PURE__ */ jsx9("span", { className: "progress-seg is-in_progress", style: { width: pct(counts.inProgress) } }),
        /* @__PURE__ */ jsx9("span", { className: "progress-seg is-blocked", style: { width: pct(counts.blocked) } })
      ]
    }
  );
}
var STATUS_LABEL, STATUS_GLYPH;
var init_Progress = __esm({
  "src/ui/components/Progress.tsx"() {
    "use strict";
    init_format();
    STATUS_LABEL = {
      todo: "To do",
      in_progress: "In progress",
      blocked: "Blocked",
      done: "Done"
    };
    STATUS_GLYPH = {
      todo: "",
      in_progress: "",
      blocked: "!",
      done: "\u2713"
    };
  }
});

// src/ui/components/primitives.tsx
import { jsx as jsx10, jsxs as jsxs9 } from "react/jsx-runtime";
function EmptyState({
  title,
  hint,
  action
}) {
  return /* @__PURE__ */ jsxs9("div", { className: "empty-state", children: [
    /* @__PURE__ */ jsx10("p", { className: "empty-title", children: title }),
    hint && /* @__PURE__ */ jsx10("p", { className: "empty-hint", children: hint }),
    action
  ] });
}
var init_primitives = __esm({
  "src/ui/components/primitives.tsx"() {
    "use strict";
    init_format();
  }
});

// src/ui/components/ErrorBoundary.tsx
import { Component } from "react";
import { jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
var ErrorBoundary;
var init_ErrorBoundary = __esm({
  "src/ui/components/ErrorBoundary.tsx"() {
    "use strict";
    ErrorBoundary = class extends Component {
      state = { error: null };
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        console.error(`[cc-harness] ${this.props.label} failed to render`, error, info.componentStack);
      }
      componentDidUpdate(prev) {
        if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
      }
      render() {
        if (!this.state.error) return this.props.children;
        return /* @__PURE__ */ jsxs10("div", { className: "crash", role: "alert", children: [
          /* @__PURE__ */ jsxs10("p", { className: "crash-title", children: [
            "The ",
            this.props.label,
            " could not be shown."
          ] }),
          /* @__PURE__ */ jsxs10("p", { className: "crash-detail", children: [
            "Your plan is saved \u2014 this is a display problem only. ",
            /* @__PURE__ */ jsx11("code", { children: this.state.error.message })
          ] }),
          /* @__PURE__ */ jsxs10("div", { className: "row-actions", children: [
            /* @__PURE__ */ jsx11("button", { type: "button", className: "btn btn-sm btn-primary", onClick: () => this.setState({ error: null }), children: "Try again" }),
            /* @__PURE__ */ jsx11("button", { type: "button", className: "btn btn-sm", onClick: () => window.location.reload(), children: "Reload the page" })
          ] })
        ] });
      }
    };
  }
});

// src/ui/components/Threads.tsx
import { useState as useState7 } from "react";
import { jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
function useThreads(target) {
  const plan = usePlan();
  return (plan?.threads ?? []).filter((t) => t.target.kind === target.kind && t.target.id === target.id);
}
function CommentToggle({
  target,
  open,
  onToggle,
  label
}) {
  const threads = useThreads(target);
  const unresolved = threads.filter((t) => !t.resolved).length;
  const waiting = threads.some((t) => !t.resolved && lastAuthor(t) === "claude");
  return /* @__PURE__ */ jsxs11(
    "button",
    {
      type: "button",
      className: classNames("comment-toggle", open && "is-active", unresolved > 0 && "has-comments", waiting && "has-reply"),
      "aria-expanded": open,
      title: unresolved ? `${unresolved} open comment(s)` : "Comment",
      "aria-label": unresolved ? `${unresolved} open comment(s) on ${label}` : `Comment on ${label}`,
      onClick: onToggle,
      children: [
        /* @__PURE__ */ jsx12("span", { "aria-hidden": "true", children: "\u{1F4AC}" }),
        unresolved > 0 && /* @__PURE__ */ jsx12("span", { className: "comment-count", children: unresolved })
      ]
    }
  );
}
function ThreadPanel({ target, label }) {
  const threads = useThreads(target);
  const [showResolved, setShowResolved] = useState7(false);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  return /* @__PURE__ */ jsxs11("div", { className: "threads", "aria-label": `Comments on ${label}`, children: [
    open.map((t) => /* @__PURE__ */ jsx12(ThreadView, { thread: t }, t.id)),
    resolved.length > 0 && /* @__PURE__ */ jsxs11("button", { type: "button", className: "link threads-resolved", onClick: () => setShowResolved((v) => !v), children: [
      showResolved ? "Hide" : "Show",
      " ",
      resolved.length,
      " resolved"
    ] }),
    showResolved && resolved.map((t) => /* @__PURE__ */ jsx12(ThreadView, { thread: t }, t.id)),
    /* @__PURE__ */ jsx12(
      Composer,
      {
        placeholder: open.length ? "Add another comment\u2026" : `Comment on ${label}\u2026`,
        label: `New comment on ${label}`,
        onSend: (text) => store.op({ op: "comment", target, text })
      }
    )
  ] });
}
function ThreadView({ thread }) {
  const [replying, setReplying] = useState7(false);
  return /* @__PURE__ */ jsxs11("article", { className: classNames("thread", thread.resolved && "is-resolved"), children: [
    /* @__PURE__ */ jsx12(Entry, { author: thread.author, text: thread.text, ts: thread.ts }),
    thread.replies.map((r) => /* @__PURE__ */ jsx12(Entry, { author: r.author, text: r.text, ts: r.ts, reply: true }, r.id)),
    /* @__PURE__ */ jsxs11("div", { className: "thread-actions", children: [
      !thread.resolved && /* @__PURE__ */ jsx12("button", { type: "button", className: "link", onClick: () => setReplying((v) => !v), children: "Reply" }),
      /* @__PURE__ */ jsx12("button", { type: "button", className: "link", onClick: () => void store.op({ op: "resolve", threadId: thread.id, resolved: !thread.resolved }), children: thread.resolved ? "Reopen" : "Resolve" }),
      !thread.resolved && lastAuthor(thread) === "user" && /* @__PURE__ */ jsx12("span", { className: "muted", children: "Claude sees this when it next reads the plan" })
    ] }),
    replying && /* @__PURE__ */ jsx12(
      Composer,
      {
        placeholder: "Reply\u2026",
        label: "Reply",
        autoFocus: true,
        onSend: async (text) => {
          const ok = await store.op({ op: "reply", threadId: thread.id, text });
          if (ok) setReplying(false);
          return ok;
        },
        onCancel: () => setReplying(false)
      }
    )
  ] });
}
function Entry({ author, text, ts, reply }) {
  return /* @__PURE__ */ jsxs11("div", { className: classNames("thread-entry", reply && "is-reply", `by-${author}`), children: [
    /* @__PURE__ */ jsxs11("div", { className: "thread-meta", children: [
      /* @__PURE__ */ jsx12(AuthorBadge, { author }),
      /* @__PURE__ */ jsx12("span", { className: "muted", children: relativeTime(ts) })
    ] }),
    /* @__PURE__ */ jsx12(Markdown, { source: text })
  ] });
}
function AuthorBadge({ author }) {
  return /* @__PURE__ */ jsx12("span", { className: classNames("author", `is-${author}`), children: author === "user" ? "You" : "Claude" });
}
function Composer({
  placeholder,
  label,
  onSend,
  autoFocus,
  onCancel
}) {
  const [text, setText] = useState7("");
  const [busy, setBusy] = useState7(false);
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onSend(value);
    setBusy(false);
    if (ok) setText("");
  };
  return /* @__PURE__ */ jsxs11("div", { className: "thread-composer", children: [
    /* @__PURE__ */ jsx12(
      "textarea",
      {
        className: "input",
        rows: text.includes("\n") ? 4 : 2,
        value: text,
        placeholder,
        "aria-label": label,
        autoFocus,
        onChange: (e) => setText(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape" && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }
      }
    ),
    /* @__PURE__ */ jsxs11("div", { className: "thread-composer-foot", children: [
      /* @__PURE__ */ jsx12("span", { className: "muted", children: "\u2318/Ctrl+Enter" }),
      /* @__PURE__ */ jsx12("span", { className: "spacer" }),
      onCancel && /* @__PURE__ */ jsx12("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: onCancel, children: "Cancel" }),
      /* @__PURE__ */ jsx12("button", { type: "button", className: "btn btn-sm", disabled: !text.trim() || busy, onClick: () => void send(), children: "Comment" })
    ] })
  ] });
}
function lastAuthor(t) {
  return t.replies.length ? t.replies[t.replies.length - 1].author : t.author;
}
var init_Threads = __esm({
  "src/ui/components/Threads.tsx"() {
    "use strict";
    init_store();
    init_Markdown();
    init_format();
  }
});

// src/ui/lib/motion.ts
function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}
function scrollBehavior() {
  return prefersReducedMotion() ? "auto" : "smooth";
}
var init_motion = __esm({
  "src/ui/lib/motion.ts"() {
    "use strict";
  }
});

// src/ui/components/Item.tsx
import { useEffect as useEffect7, useRef as useRef3, useState as useState8 } from "react";
import { jsx as jsx13, jsxs as jsxs12 } from "react/jsx-runtime";
function Focusable({
  kind,
  id,
  className,
  children,
  as: Tag = "section"
}) {
  const focusTarget = useStore((s) => s.focusTarget);
  const ref = useRef3(null);
  const [flash, setFlash] = useState8(false);
  const mine = focusTarget === `${kind}:${id}`;
  useEffect7(() => {
    if (!mine) return;
    ref.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: "center" });
    setFlash(true);
    const timer = window.setTimeout(() => {
      setFlash(false);
      store.set({ focusTarget: null });
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [mine]);
  return /* @__PURE__ */ jsx13(Tag, { ref, id: `${kind}-${id}`, className: classNames(className, flash && "is-flash"), children });
}
function ItemActions({
  label,
  index,
  count,
  onMove,
  onRemove
}) {
  const [confirming, setConfirming] = useState8(false);
  if (confirming) {
    return /* @__PURE__ */ jsxs12("span", { className: "item-confirm", children: [
      "Remove?",
      /* @__PURE__ */ jsx13("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Remove" }),
      /* @__PURE__ */ jsx13("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
    ] });
  }
  return /* @__PURE__ */ jsxs12("span", { className: "item-actions", children: [
    /* @__PURE__ */ jsx13(
      "button",
      {
        type: "button",
        className: "icon-btn is-tiny",
        disabled: index === 0,
        title: "Move up",
        "aria-label": `Move ${label} up`,
        onClick: () => onMove(index - 1),
        children: /* @__PURE__ */ jsx13("span", { "aria-hidden": "true", children: "\u2191" })
      }
    ),
    /* @__PURE__ */ jsx13(
      "button",
      {
        type: "button",
        className: "icon-btn is-tiny",
        disabled: index >= count - 1,
        title: "Move down",
        "aria-label": `Move ${label} down`,
        onClick: () => onMove(index + 1),
        children: /* @__PURE__ */ jsx13("span", { "aria-hidden": "true", children: "\u2193" })
      }
    ),
    /* @__PURE__ */ jsx13("button", { type: "button", className: "icon-btn is-tiny is-danger", title: "Remove", "aria-label": `Remove ${label}`, onClick: () => setConfirming(true), children: /* @__PURE__ */ jsx13("span", { "aria-hidden": "true", children: "\xD7" }) })
  ] });
}
var init_Item = __esm({
  "src/ui/components/Item.tsx"() {
    "use strict";
    init_store();
    init_motion();
    init_format();
  }
});

// src/ui/views/OverviewView.tsx
import { useState as useState9 } from "react";
import { jsx as jsx14, jsxs as jsxs13 } from "react/jsx-runtime";
function OverviewView() {
  const plan = usePlan();
  if (!plan) return null;
  return /* @__PURE__ */ jsxs13("div", { className: "view-pad doc", children: [
    /* @__PURE__ */ jsx14(Glance, { plan }),
    /* @__PURE__ */ jsxs13("section", { className: "doc-block", "aria-labelledby": "summary-head", children: [
      /* @__PURE__ */ jsx14("h2", { id: "summary-head", className: "doc-label", children: "Summary" }),
      /* @__PURE__ */ jsx14(
        MarkdownField,
        {
          value: plan.summary,
          label: "the plan summary",
          placeholder: "No summary yet.",
          emptyAction: "Write one",
          onSave: (summary2) => store.op({ op: "set_meta", summary: summary2 })
        }
      )
    ] }),
    plan.sections.map((section, i) => /* @__PURE__ */ jsx14(SectionCard, { section, index: i, count: plan.sections.length }, section.id)),
    /* @__PURE__ */ jsx14("div", { className: "doc-add", children: /* @__PURE__ */ jsx14(
      AddField,
      {
        placeholder: "New section title \u2014 e.g. Data model, Risks, Out of scope",
        label: "New section title",
        onAdd: (title) => store.op({ op: "upsert_section", title, body: "" })
      }
    ) }),
    /* @__PURE__ */ jsxs13("section", { className: "doc-block", "aria-labelledby": "general-head", children: [
      /* @__PURE__ */ jsx14("h2", { id: "general-head", className: "doc-label", children: "General comments" }),
      /* @__PURE__ */ jsx14(ThreadPanel, { target: { kind: "plan", id: "" }, label: "the plan" })
    ] })
  ] });
}
function Glance({ plan }) {
  const counts = countTasks(plan);
  const openThreads = plan.threads.filter((t) => !t.resolved).length;
  const now = currentTask(plan);
  const blocked = plan.tasks.filter((t) => t.status === "blocked");
  return /* @__PURE__ */ jsxs13("div", { className: "glance", role: "list", "aria-label": "Plan at a glance", children: [
    /* @__PURE__ */ jsxs13("button", { type: "button", role: "listitem", className: "glance-tile", onClick: () => store.setTab("tasks"), children: [
      /* @__PURE__ */ jsx14("span", { className: "glance-label", children: "Tasks" }),
      /* @__PURE__ */ jsxs13("span", { className: "glance-value", children: [
        counts.done,
        /* @__PURE__ */ jsxs13("span", { className: "glance-of", children: [
          "/",
          counts.total
        ] })
      ] }),
      /* @__PURE__ */ jsx14(ProgressBar, { counts }),
      /* @__PURE__ */ jsxs13("span", { className: "glance-sub", children: [
        counts.inProgress ? `${counts.inProgress} in progress` : counts.total ? "none in progress" : "no tasks yet",
        counts.blocked ? ` \xB7 ${counts.blocked} blocked` : ""
      ] })
    ] }),
    /* @__PURE__ */ jsxs13(
      "button",
      {
        type: "button",
        role: "listitem",
        className: blocked.length ? "glance-tile is-attention" : "glance-tile",
        onClick: () => {
          const target = now ?? blocked[0];
          if (target) store.focus("task", target.id);
          else store.setTab("tasks");
        },
        children: [
          /* @__PURE__ */ jsx14("span", { className: "glance-label", children: now ? "Claude is on" : blocked.length ? "Blocked" : "Now" }),
          /* @__PURE__ */ jsx14("span", { className: "glance-now", children: now?.title ?? blocked[0]?.title ?? (counts.total && counts.done === counts.total ? "All done" : "Nothing in progress") }),
          /* @__PURE__ */ jsx14("span", { className: "glance-sub", children: now?.note ?? blocked[0]?.note ?? (blocked.length > 1 ? `${blocked.length} tasks blocked` : " ") })
        ]
      }
    ),
    /* @__PURE__ */ jsxs13("button", { type: "button", role: "listitem", className: "glance-tile", onClick: () => store.setTab("diagrams"), children: [
      /* @__PURE__ */ jsx14("span", { className: "glance-label", children: "Diagrams" }),
      /* @__PURE__ */ jsx14("span", { className: "glance-value", children: plan.diagrams.length }),
      /* @__PURE__ */ jsx14("span", { className: "glance-sub", children: plan.diagrams.map((d) => d.title).slice(0, 2).join(", ") || "none yet" })
    ] }),
    /* @__PURE__ */ jsxs13(
      "button",
      {
        type: "button",
        role: "listitem",
        className: "glance-tile",
        onClick: () => document.getElementById("general-head")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" }),
        children: [
          /* @__PURE__ */ jsx14("span", { className: "glance-label", children: "Open comments" }),
          /* @__PURE__ */ jsx14("span", { className: "glance-value", children: openThreads }),
          /* @__PURE__ */ jsxs13("span", { className: "glance-sub", children: [
            "revision ",
            plan.revision || "draft"
          ] })
        ]
      }
    )
  ] });
}
function SectionCard({ section, index, count }) {
  const [comments, setComments] = useState9(false);
  const target = { kind: "section", id: section.id };
  return /* @__PURE__ */ jsxs13(Focusable, { kind: "section", id: section.id, className: "doc-block section-card", children: [
    /* @__PURE__ */ jsxs13("header", { className: "item-head", children: [
      /* @__PURE__ */ jsx14(
        InlineText,
        {
          as: "h2",
          className: "section-title",
          value: section.title,
          label: "Section title",
          onSave: (title) => store.op({ op: "upsert_section", id: section.id, title })
        }
      ),
      /* @__PURE__ */ jsx14("span", { className: "item-id", children: section.id }),
      /* @__PURE__ */ jsx14("span", { className: "spacer" }),
      /* @__PURE__ */ jsx14(CommentToggle, { target, label: section.title, open: comments, onToggle: () => setComments((v) => !v) }),
      /* @__PURE__ */ jsx14(
        ItemActions,
        {
          label: section.title,
          index,
          count,
          onMove: (to) => store.op({ op: "move_section", id: section.id, index: to }),
          onRemove: () => store.op({ op: "remove", kind: "section", id: section.id })
        }
      )
    ] }),
    /* @__PURE__ */ jsx14(
      MarkdownField,
      {
        value: section.body,
        label: `section "${section.title}"`,
        rows: 8,
        version: section.rev,
        onSave: (body, rev) => store.op({ op: "upsert_section", id: section.id, body, ...rev !== void 0 ? { expect: rev } : {} })
      }
    ),
    comments && /* @__PURE__ */ jsx14(ThreadPanel, { target, label: section.title })
  ] });
}
var init_OverviewView = __esm({
  "src/ui/views/OverviewView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Threads();
    init_Item();
    init_Progress();
    init_motion();
    init_plan();
  }
});

// src/ui/lib/layout.ts
import dagre from "@dagrejs/dagre";
function nodeSize(node) {
  const label = node.label.length * LABEL_CHAR;
  const detail = node.detail ? Math.min(node.detail.length, 46) * DETAIL_CHAR : 0;
  const raw = Math.max(label + LABEL_CHROME, detail ? detail / (node.detail.length > 34 ? 2 : 1) + DETAIL_CHROME : 0);
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw)) / 10) * 10;
  const labelLines = Math.min(2, Math.max(1, Math.ceil(label / (width - LABEL_CHROME))));
  const detailLines = node.detail ? Math.min(2, Math.max(1, Math.ceil(node.detail.length * DETAIL_CHAR / (width - DETAIL_CHROME)))) : 0;
  let height = 18 + labelLines * 17 + (detailLines ? 2 + detailLines * 14 : 0) + (node.taskIds?.length ? 16 : 0);
  if (node.kind === "datastore") height += 6;
  return { width, height: Math.max(44, height) };
}
function labelSize(label) {
  const text = label.length * 6.2;
  const lines = Math.min(2, Math.ceil(text / 160));
  return { width: Math.round(Math.min(172, text + 14)), height: 8 + lines * 14 };
}
function autoLayout(diagram, direction) {
  const key = JSON.stringify([
    direction,
    diagram.nodes.map((n) => [n.id, n.label, n.detail ?? "", n.kind, n.taskIds?.length ? 1 : 0]),
    diagram.edges.map((e) => [e.id, e.source, e.target, e.label ?? ""])
  ]);
  let hit = computed.get(key);
  if (hit) computed.delete(key);
  else hit = seal(computeLayout(diagram, direction));
  computed.set(key, hit);
  if (computed.size > COMPUTED_MAX) computed.delete(computed.keys().next().value);
  return { positions: new Map([...hit.positions].map(([id, p]) => [id, { ...p }])), routes: new Map(hit.routes) };
}
function seal(layout) {
  for (const r of layout.routes.values()) {
    for (const p of r.points) Object.freeze(p);
    Object.freeze(r.points);
    if (r.label) Object.freeze(r.label);
    Object.freeze(r.from);
    Object.freeze(r.to);
    Object.freeze(r);
  }
  return layout;
}
function computeLayout(diagram, direction) {
  const degree = /* @__PURE__ */ new Map();
  for (const e of diagram.edges) {
    if (e.source === e.target) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const connected = diagram.nodes.filter((n) => degree.has(n.id));
  const loose = diagram.nodes.filter((n) => !degree.has(n.id));
  const positions = /* @__PURE__ */ new Map();
  const routes = /* @__PURE__ */ new Map();
  if (connected.length) {
    const ids = new Set(connected.map((n) => n.id));
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: direction, ...SPACING[direction], marginx: 0, marginy: 0, acyclicer: "greedy", ranker: "network-simplex" });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of connected) g.setNode(n.id, { ...nodeSize(n) });
    for (const e of diagram.edges) {
      if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
      g.setEdge(e.source, e.target, e.label ? { ...labelSize(e.label), labelpos: "c" } : { width: 0, height: 0 }, e.id);
    }
    dagre.layout(g);
    for (const n of connected) {
      const laid = g.node(n.id);
      positions.set(n.id, { x: Math.round(laid.x - laid.width / 2), y: Math.round(laid.y - laid.height / 2) });
    }
    for (const e of diagram.edges) {
      const laid = g.edge({ v: e.source, w: e.target, name: e.id });
      if (!laid?.points?.length) continue;
      routes.set(e.id, {
        points: laid.points.map((p) => ({ x: p.x, y: p.y })),
        ...e.label && laid.x !== void 0 && laid.y !== void 0 ? { label: { x: laid.x, y: laid.y } } : {},
        from: positions.get(e.source),
        to: positions.get(e.target)
      });
    }
  }
  shelve(loose, positions, new Map(diagram.nodes.map((n) => [n.id, nodeSize(n)])), direction);
  return normalize({ positions, routes });
}
function shelve(loose, positions, size, direction) {
  if (!loose.length) return;
  const sizes = loose.map((n) => size.get(n.id));
  const bounds = boundsOf(positions, size);
  const gapX = 40;
  const gapY = 32;
  if (!bounds) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(loose.length * 1.6)));
    let y = 0;
    for (let row = 0; row * cols < loose.length; row++) {
      let x = 0;
      const items = loose.slice(row * cols, row * cols + cols);
      let tallest = 0;
      items.forEach((n, i) => {
        const s = sizes[row * cols + i];
        positions.set(n.id, { x, y });
        x += s.width + gapX;
        tallest = Math.max(tallest, s.height);
      });
      y += tallest + gapY;
    }
    return;
  }
  if (direction === "LR") {
    const limit = Math.max(bounds.maxX, bounds.minX + 3 * (MAX_WIDTH + gapX));
    let x = bounds.minX;
    let y = bounds.maxY + SHELF_GAP;
    let tallest = 0;
    loose.forEach((n, i) => {
      const s = sizes[i];
      if (x > bounds.minX && x + s.width > limit) {
        x = bounds.minX;
        y += tallest + gapY;
        tallest = 0;
      }
      positions.set(n.id, { x, y });
      x += s.width + gapX;
      tallest = Math.max(tallest, s.height);
    });
  } else {
    const limit = Math.max(bounds.maxY, bounds.minY + 4 * (60 + gapY));
    let x = bounds.maxX + SHELF_GAP;
    let y = bounds.minY;
    let widest = 0;
    loose.forEach((n, i) => {
      const s = sizes[i];
      if (y > bounds.minY && y + s.height > limit) {
        y = bounds.minY;
        x += widest + gapX;
        widest = 0;
      }
      positions.set(n.id, { x, y });
      y += s.height + gapY;
      widest = Math.max(widest, s.width);
    });
  }
}
function normalize(layout) {
  let minX = Infinity;
  let minY = Infinity;
  for (const p of layout.positions.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  if (!Number.isFinite(minX) || minX === 0 && minY === 0) return layout;
  const at = (p) => ({ x: Math.round(p.x - minX), y: Math.round(p.y - minY) });
  const positions = new Map([...layout.positions].map(([id, p]) => [id, at(p)]));
  const routes = new Map(
    [...layout.routes].map(([id, r]) => [
      id,
      {
        points: r.points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
        ...r.label ? { label: { x: r.label.x - minX, y: r.label.y - minY } } : {},
        from: at(r.from),
        to: at(r.to)
      }
    ])
  );
  return { positions, routes };
}
function resolveLayout(diagram) {
  const placed = diagram.nodes.filter((n) => n.x !== void 0 && n.y !== void 0);
  const positions = new Map(placed.map((n) => [n.id, { x: n.x, y: n.y }]));
  if (placed.length === diagram.nodes.length && diagram.edges.length === 0) return { positions, routes: /* @__PURE__ */ new Map() };
  const auto = autoLayout(diagram, diagram.direction);
  if (placed.length === 0) return auto;
  if (placed.length < diagram.nodes.length) placeNewcomers(diagram, positions, auto.positions);
  const routes = /* @__PURE__ */ new Map();
  for (const e of diagram.edges) {
    const r = auto.routes.get(e.id);
    if (r && samePoint(positions.get(e.source), r.from) && samePoint(positions.get(e.target), r.to)) routes.set(e.id, r);
  }
  return { positions, routes };
}
function placeNewcomers(diagram, positions, auto) {
  const lr = diagram.direction === "LR";
  const size = new Map(diagram.nodes.map((n) => [n.id, nodeSize(n)]));
  const fresh = diagram.nodes.filter((n) => !positions.has(n.id)).sort((a, b) => {
    const pa = auto.get(a.id) ?? { x: 0, y: 0 };
    const pb = auto.get(b.id) ?? { x: 0, y: 0 };
    return lr ? pa.x - pb.x || pa.y - pb.y : pa.y - pb.y || pa.x - pb.x;
  });
  const strays = [];
  for (const n of fresh) {
    const s = size.get(n.id);
    const sources = diagram.edges.filter((e) => e.target === n.id && e.source !== n.id && positions.has(e.source)).map((e) => e.source);
    const targets = diagram.edges.filter((e) => e.source === n.id && e.target !== n.id && positions.has(e.target)).map((e) => e.target);
    const anchors = sources.length ? sources : targets;
    if (!anchors.length) {
      strays.push(n);
      continue;
    }
    const boxes = anchors.map((id) => ({ ...positions.get(id), ...size.get(id) }));
    const centre2 = {
      x: boxes.reduce((t, b) => t + b.x + b.width / 2, 0) / boxes.length,
      y: boxes.reduce((t, b) => t + b.y + b.height / 2, 0) / boxes.length
    };
    const after2 = sources.length > 0;
    const want = lr ? {
      x: after2 ? Math.max(...boxes.map((b) => b.x + b.width)) + RANK_GAP : Math.min(...boxes.map((b) => b.x)) - RANK_GAP - s.width,
      y: centre2.y - s.height / 2
    } : {
      x: centre2.x - s.width / 2,
      y: after2 ? Math.max(...boxes.map((b) => b.y + b.height)) + RANK_GAP : Math.min(...boxes.map((b) => b.y)) - RANK_GAP - s.height
    };
    positions.set(n.id, findFreeSpot(want, s, positions, size, lr));
  }
  if (!strays.length) return;
  const sub = autoLayout(
    { nodes: strays.map((n) => ({ ...n, id: n.id })), edges: diagram.edges.filter((e) => strays.some((n) => n.id === e.source) && strays.some((n) => n.id === e.target)) },
    diagram.direction
  );
  const bounds = boundsOf(positions, size);
  for (const n of strays) {
    const p = sub.positions.get(n.id) ?? { x: 0, y: 0 };
    positions.set(n.id, lr ? { x: p.x + bounds.maxX + RANK_GAP, y: p.y + bounds.minY } : { x: p.x + bounds.minX, y: p.y + bounds.maxY + RANK_GAP });
  }
}
function findFreeSpot(want, s, positions, size, lr) {
  const clear = (p) => [...positions].every(([id, q]) => {
    const b = size.get(id) ?? { width: MIN_WIDTH, height: 44 };
    return p.x + s.width + CLEARANCE <= q.x || q.x + b.width + CLEARANCE <= p.x || p.y + s.height + CLEARANCE <= q.y || q.y + b.height + CLEARANCE <= p.y;
  });
  const step = lr ? 26 : 40;
  for (let k = 0; k < 60; k++) {
    const offset = Math.ceil(k / 2) * step * (k % 2 ? 1 : -1);
    const p = lr ? { x: want.x, y: want.y + offset } : { x: want.x + offset, y: want.y };
    if (clear(p)) return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return findFreeSpot(lr ? { x: want.x + s.width + RANK_GAP, y: want.y } : { x: want.x, y: want.y + s.height + RANK_GAP }, s, positions, size, lr);
}
function boundsOf(positions, size) {
  if (positions.size === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [id, p] of positions) {
    const s = size.get(id) ?? { width: MIN_WIDTH, height: 44 };
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.width);
    maxY = Math.max(maxY, p.y + s.height);
  }
  return { minX, minY, maxX, maxY };
}
function samePoint(a, b) {
  return Boolean(a && b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5);
}
var LABEL_CHAR, DETAIL_CHAR, LABEL_CHROME, DETAIL_CHROME, MIN_WIDTH, MAX_WIDTH, SPACING, SHELF_GAP, computed, COMPUTED_MAX, RANK_GAP, CLEARANCE;
var init_layout = __esm({
  "src/ui/lib/layout.ts"() {
    "use strict";
    LABEL_CHAR = 7.4;
    DETAIL_CHAR = 6.1;
    LABEL_CHROME = 70;
    DETAIL_CHROME = 25;
    MIN_WIDTH = 170;
    MAX_WIDTH = 250;
    SPACING = {
      // In LR, nodesep is the vertical gap between boxes in one rank.
      LR: { nodesep: 30, ranksep: 72, edgesep: 14 },
      TB: { nodesep: 44, ranksep: 58, edgesep: 14 }
    };
    SHELF_GAP = 72;
    computed = /* @__PURE__ */ new Map();
    COMPUTED_MAX = 16;
    RANK_GAP = 90;
    CLEARANCE = 22;
  }
});

// src/ui/lib/geometry.ts
function centre(r) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
function facingSides(a, b, direction = "LR") {
  const ca = centre(a);
  const cb = centre(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const gapX = Math.abs(dx) - (a.width + b.width) / 2;
  const gapY = Math.abs(dy) - (a.height + b.height) / 2;
  const horizontal = dx >= 0 ? ["right", "left"] : ["left", "right"];
  const vertical = dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  if (gapX > 0 && gapY > 0) {
    if (direction === "LR") return gapY > gapX * 2.5 ? vertical : horizontal;
    return gapX > gapY * 2.5 ? horizontal : vertical;
  }
  if (gapX > 0) return horizontal;
  if (gapY > 0) return vertical;
  return Math.abs(dx) / (a.width || 1) >= Math.abs(dy) / (a.height || 1) ? horizontal : vertical;
}
function sidePoint(r, side, offset = 0) {
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2 + offset, y: r.y };
    case "bottom":
      return { x: r.x + r.width / 2 + offset, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height / 2 + offset };
    case "right":
      return { x: r.x + r.width, y: r.y + r.height / 2 + offset };
  }
}
function clipToRect(r, toward) {
  const c = centre(r);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx ? r.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? r.height / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}
function splinePath(points) {
  if (points.length === 0) return "";
  const f = (n) => Math.round(n * 10) / 10;
  if (points.length === 1) return `M${f(points[0].x)},${f(points[0].y)}`;
  if (points.length === 2) return `M${f(points[0].x)},${f(points[0].y)}L${f(points[1].x)},${f(points[1].y)}`;
  let d = `M${f(points[0].x)},${f(points[0].y)}`;
  let x0 = points[0].x;
  let y0 = points[0].y;
  let x1 = points[1].x;
  let y1 = points[1].y;
  d += `L${f((5 * x0 + x1) / 6)},${f((5 * y0 + y1) / 6)}`;
  for (let i = 2; i < points.length; i++) {
    const { x, y } = points[i];
    d += `C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f((x0 + 4 * x1 + x) / 6)},${f((y0 + 4 * y1 + y) / 6)}`;
    x0 = x1;
    y0 = y1;
    x1 = x;
    y1 = y;
  }
  d += `C${f((2 * x0 + x1) / 3)},${f((2 * y0 + y1) / 3)} ${f((x0 + 2 * x1) / 3)},${f((y0 + 2 * y1) / 3)} ${f((x0 + 5 * x1) / 6)},${f((y0 + 5 * y1) / 6)}`;
  d += `L${f(x1)},${f(y1)}`;
  return d;
}
function midpoint(points) {
  if (points.length === 0) return { x: 0, y: 0 };
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(l);
    total += l;
  }
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const l = lengths[i - 1];
    if (left <= l && l > 0) {
      const t = left / l;
      return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t };
    }
    left -= l;
  }
  return points[points.length - 1];
}
function loopPath(r) {
  const sx = r.x + r.width;
  const sy = r.y + r.height * 0.35;
  const ex = r.x + r.width * 0.75;
  const ey = r.y;
  return {
    path: `M${sx},${sy} C${sx + 46},${sy} ${ex},${ey - 46} ${ex},${ey}`,
    label: { x: sx + 22, y: ey - 22 }
  };
}
function lanes(edges) {
  const groups = /* @__PURE__ */ new Map();
  for (const e of edges) {
    if (e.source === e.target) continue;
    const key = [e.source, e.target].sort().join("\0");
    groups.set(key, [...groups.get(key) ?? [], e.id]);
  }
  const out = /* @__PURE__ */ new Map();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.forEach((id, i) => out.set(id, (i - (ids.length - 1) / 2) * 14));
  }
  return out;
}
var init_geometry = __esm({
  "src/ui/lib/geometry.ts"() {
    "use strict";
  }
});

// src/ui/lib/clipboard.ts
function toClip(nodes, edges) {
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  return {
    kind: CLIP_KIND,
    version: 1,
    nodes: nodes.map((n) => strip({ ...n })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => strip({ ...e }))
  };
}
function serializeClip(clip) {
  return JSON.stringify(clip);
}
function parseClip(text) {
  if (!text || !text.includes(CLIP_KIND)) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw;
  if (!r || r.kind !== CLIP_KIND || !Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null;
  const str = (v, max) => typeof v === "string" && v.trim() ? v.slice(0, max) : void 0;
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const nodes = [];
  for (const n of r.nodes.slice(0, 120)) {
    const o = n;
    const id = str(o?.["id"], 60);
    if (!id || nodes.some((x) => x.id === id)) continue;
    nodes.push(
      strip({
        id,
        label: str(o["label"], 120) ?? id,
        kind: NODE_KINDS.includes(o["kind"]) ? o["kind"] : "component",
        detail: str(o["detail"], 400),
        description: str(o["description"], 4e3),
        notes: str(o["notes"], 2e4),
        taskIds: Array.isArray(o["taskIds"]) ? o["taskIds"].filter((t) => typeof t === "string") : void 0,
        x: num(o["x"]),
        y: num(o["y"])
      })
    );
  }
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const e of r.edges.slice(0, 300)) {
    const o = e;
    const source = str(o?.["source"], 60);
    const target = str(o?.["target"], 60);
    if (!source || !target || !ids.has(source) || !ids.has(target)) continue;
    const arrows = EDGE_ARROWS.includes(o["arrows"]) ? o["arrows"] : void 0;
    edges.push(strip({ source, target, label: str(o["label"], 120), dashed: o["dashed"] === true ? true : void 0, arrows: arrows === "end" ? void 0 : arrows }));
  }
  return { kind: CLIP_KIND, version: 1, nodes, edges };
}
function pasteClip(clip, taken, tasks, offset) {
  const used = new Set(taken);
  const ids = /* @__PURE__ */ new Map();
  for (const n of clip.nodes) {
    const id = freeId(n.id, used);
    used.add(id);
    ids.set(n.id, id);
  }
  const nodes = clip.nodes.map(
    (n) => strip({
      ...n,
      id: ids.get(n.id),
      taskIds: n.taskIds?.filter((t) => tasks.has(t)),
      x: Math.round(n.x + offset.x),
      y: Math.round(n.y + offset.y)
    })
  );
  const edges = clip.edges.map((e) => ({ ...e, source: ids.get(e.source), target: ids.get(e.target) }));
  return { nodes, edges };
}
function clipOrigin(clip) {
  return { x: Math.min(...clip.nodes.map((n) => n.x)), y: Math.min(...clip.nodes.map((n) => n.y)) };
}
function freeId(wanted, used) {
  if (!used.has(wanted)) return wanted;
  const base = wanted.replace(/-\d+$/, "").slice(0, 54);
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}
function strip(o) {
  for (const key of Object.keys(o)) {
    const v = o[key];
    if (v === void 0 || Array.isArray(v) && v.length === 0) delete o[key];
  }
  return o;
}
var CLIP_KIND;
var init_clipboard = __esm({
  "src/ui/lib/clipboard.ts"() {
    "use strict";
    init_types();
    CLIP_KIND = "cc-harness/diagram-selection";
  }
});

// src/ui/lib/theme.ts
import { useEffect as useEffect8, useState as useState10 } from "react";
function useResolvedTheme() {
  const read = () => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState10(read);
  useEffect8(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
var init_theme = __esm({
  "src/ui/lib/theme.ts"() {
    "use strict";
  }
});

// src/ui/components/flow/shared.ts
import { createContext, useContext } from "react";
function useCanvas() {
  const api2 = useContext(CanvasContext);
  if (!api2) throw new Error("useCanvas outside the diagram editor");
  return api2;
}
var CanvasContext, KIND_LABEL, KIND_GLYPH, KIND_HINT;
var init_shared = __esm({
  "src/ui/components/flow/shared.ts"() {
    "use strict";
    CanvasContext = createContext(null);
    KIND_LABEL = {
      component: "Component",
      service: "Service",
      datastore: "Datastore",
      queue: "Queue",
      external: "External",
      actor: "Actor",
      note: "Note"
    };
    KIND_GLYPH = {
      component: "\u25A2",
      service: "\u2699",
      datastore: "\u26C1",
      queue: "\u2630",
      external: "\u2601",
      actor: "\u263A",
      note: "\u270E"
    };
    KIND_HINT = {
      component: "A part of the codebase: a module, a UI, a library",
      service: "Something that runs: an API, a worker, a job",
      datastore: "Where state lives: a database, a cache, a bucket",
      queue: "A queue, topic or stream between parts",
      external: "A system you depend on but do not own",
      actor: "A person or client that uses the system",
      note: "An annotation on the diagram, not a part of the system"
    };
  }
});

// src/ui/components/flow/PlanNode.tsx
import { useEffect as useEffect9, useRef as useRef4, useState as useState11 } from "react";
import { Handle, NodeToolbar, Position, useEdges, useNodes } from "@xyflow/react";
import { jsx as jsx15, jsxs as jsxs14 } from "react/jsx-runtime";
function PlanNode({ id, data, selected }) {
  const api2 = useCanvas();
  const editing = api2.editing === `node:${id}`;
  const p = data.progress;
  const state = !p ? null : p.blocked ? "blocked" : p.inProgress ? "in_progress" : p.done === p.total ? "done" : "todo";
  const summary2 = useHoverSummary();
  const hasStory = Boolean(data.description?.trim() || data.notes?.trim());
  return /* @__PURE__ */ jsxs14(
    "div",
    {
      className: classNames("flow-node", `kind-${data.kind}`, selected && "is-selected", state && `progress-${state}`, editing && "is-editing"),
      style: { width: data.width, minHeight: data.height },
      children: [
        SIDES.map(([side, position]) => /* @__PURE__ */ jsx15(Handle, { id: side, type: "source", position, className: `handle-${side}` }, side)),
        /* @__PURE__ */ jsxs14("div", { className: "flow-node-head", children: [
          /* @__PURE__ */ jsx15("span", { className: "flow-node-glyph", "aria-hidden": "true", children: KIND_GLYPH[data.kind] }),
          editing ? /* @__PURE__ */ jsx15(LabelInput, { value: data.label, onDone: (label) => api2.finishNodeLabel(id, label) }) : /* @__PURE__ */ jsx15("span", { className: "flow-node-label", children: data.label }),
          /* @__PURE__ */ jsx15(
            "button",
            {
              type: "button",
              className: classNames("flow-node-info nodrag", hasStory && "has-story", summary2.open && "is-open"),
              "aria-label": `About ${data.label}`,
              "aria-expanded": summary2.open,
              onMouseEnter: summary2.show,
              onMouseLeave: summary2.hideSoon,
              onFocus: summary2.show,
              onBlur: summary2.hideNow,
              onKeyDown: (e) => {
                if (e.key === "Escape") summary2.hideNow();
              },
              children: /* @__PURE__ */ jsx15(InfoIcon, {})
            }
          )
        ] }),
        data.detail && /* @__PURE__ */ jsx15("div", { className: "flow-node-detail", children: data.detail }),
        p && /* @__PURE__ */ jsxs14(
          "div",
          {
            className: "flow-node-progress",
            title: `${p.done} of ${p.total} tasks done${p.inProgress ? `, ${p.inProgress} in progress` : ""}${p.blocked ? `, ${p.blocked} blocked` : ""}`,
            children: [
              /* @__PURE__ */ jsx15(ProgressBar, { counts: p, compact: true }),
              /* @__PURE__ */ jsxs14("span", { children: [
                p.done,
                "/",
                p.total
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsx15(NodeToolbar, { isVisible: summary2.open, position: summary2.side, align: summary2.align, offset: 10, className: "flow-summary-layer", children: summary2.open && /* @__PURE__ */ jsx15(NodeSummary, { id, data, onEnter: summary2.keep, onLeave: summary2.hideSoon }) })
      ]
    }
  );
}
function useHoverSummary() {
  const [side, setSide] = useState11(null);
  const [align, setAlign] = useState11("center");
  const timer = useRef4(void 0);
  useEffect9(() => () => window.clearTimeout(timer.current), []);
  const keep = () => window.clearTimeout(timer.current);
  const show = (e) => {
    keep();
    const box = e.currentTarget.closest(".react-flow__node")?.getBoundingClientRect();
    const frame = e.currentTarget.closest(".react-flow")?.getBoundingClientRect();
    const roomAbove = box && frame ? box.top - frame.top : 0;
    setSide(roomAbove > 300 ? Position.Top : Position.Bottom);
    const half = 170;
    const centre2 = box ? box.left + box.width / 2 : 0;
    setAlign(!box || !frame ? "center" : centre2 - frame.left < half ? "start" : frame.right - centre2 < half ? "end" : "center");
  };
  const hideSoon = () => {
    keep();
    timer.current = window.setTimeout(() => setSide(null), 140);
  };
  const hideNow = () => {
    keep();
    setSide(null);
  };
  return { open: side !== null, side: side ?? Position.Top, align, show, keep, hideSoon, hideNow };
}
function NodeSummary({ id, data, onEnter, onLeave }) {
  const plan = usePlan();
  const edges = useEdges();
  const nodes = useNodes();
  const name = (nid) => nodes.find((n) => n.id === nid)?.data.label ?? nid;
  const out = edges.filter((e) => e.source === id && e.target !== id);
  const into = edges.filter((e) => e.target === id && e.source !== id);
  const tasks = (data.taskIds ?? []).map((t) => plan?.tasks.find((x) => x.id === t)).filter((t) => t !== void 0);
  const SHOWN = 5;
  const hidden = Math.max(0, out.length - SHOWN) + Math.max(0, into.length - SHOWN);
  return /* @__PURE__ */ jsxs14("div", { className: "flow-summary", role: "tooltip", onMouseEnter: onEnter, onMouseLeave: onLeave, children: [
    /* @__PURE__ */ jsxs14("header", { className: "flow-summary-head", children: [
      /* @__PURE__ */ jsx15("span", { className: classNames("kind-swatch", `kind-${data.kind}`), "aria-hidden": "true", children: KIND_GLYPH[data.kind] }),
      /* @__PURE__ */ jsx15("span", { className: "panel-kicker", children: KIND_LABEL[data.kind] })
    ] }),
    /* @__PURE__ */ jsx15("p", { className: "flow-summary-title", children: data.label }),
    data.detail && /* @__PURE__ */ jsx15("p", { className: "flow-summary-detail", children: data.detail }),
    data.description?.trim() ? /* @__PURE__ */ jsx15("div", { className: "flow-summary-body", children: /* @__PURE__ */ jsx15(Markdown, { source: data.description }) }) : /* @__PURE__ */ jsx15("p", { className: "flow-summary-empty", children: "No description yet. Select the box to write what it does." }),
    data.notes?.trim() && /* @__PURE__ */ jsxs14("section", { className: "flow-summary-section", children: [
      /* @__PURE__ */ jsx15("p", { className: "flow-summary-label", children: "Decisions" }),
      /* @__PURE__ */ jsx15("div", { className: "flow-summary-notes", children: /* @__PURE__ */ jsx15(Markdown, { source: data.notes }) })
    ] }),
    tasks.length > 0 && /* @__PURE__ */ jsxs14("section", { className: "flow-summary-section", children: [
      /* @__PURE__ */ jsxs14("p", { className: "flow-summary-label", children: [
        "Built by",
        data.progress && /* @__PURE__ */ jsxs14("span", { className: "flow-summary-progress", children: [
          /* @__PURE__ */ jsx15(ProgressBar, { counts: data.progress, compact: true }),
          " ",
          data.progress.done,
          "/",
          data.progress.total
        ] })
      ] }),
      /* @__PURE__ */ jsxs14("ul", { className: "flow-summary-list", children: [
        tasks.slice(0, SHOWN).map((t) => /* @__PURE__ */ jsxs14("li", { children: [
          /* @__PURE__ */ jsx15("span", { className: classNames("status-dot is-static", `is-${t.status}`), "aria-label": STATUS_LABEL[t.status], children: STATUS_GLYPH[t.status] }),
          t.title
        ] }, t.id)),
        tasks.length > SHOWN && /* @__PURE__ */ jsxs14("li", { className: "muted", children: [
          "and ",
          tasks.length - SHOWN,
          " more"
        ] })
      ] })
    ] }),
    (out.length > 0 || into.length > 0) && /* @__PURE__ */ jsxs14("section", { className: "flow-summary-section", children: [
      /* @__PURE__ */ jsx15("p", { className: "flow-summary-label", children: "Connections" }),
      /* @__PURE__ */ jsxs14("ul", { className: "flow-summary-list", children: [
        out.slice(0, SHOWN).map((e) => /* @__PURE__ */ jsxs14("li", { children: [
          /* @__PURE__ */ jsx15("span", { "aria-hidden": "true", children: e.data?.arrows === "both" ? "\u2194" : "\u2192" }),
          " ",
          name(e.target),
          e.data?.label && /* @__PURE__ */ jsxs14("span", { className: "muted", children: [
            " \xB7 ",
            e.data.label
          ] })
        ] }, e.id)),
        into.slice(0, SHOWN).map((e) => /* @__PURE__ */ jsxs14("li", { children: [
          /* @__PURE__ */ jsx15("span", { "aria-hidden": "true", children: e.data?.arrows === "both" ? "\u2194" : "\u2190" }),
          " ",
          name(e.source),
          e.data?.label && /* @__PURE__ */ jsxs14("span", { className: "muted", children: [
            " \xB7 ",
            e.data.label
          ] })
        ] }, e.id)),
        hidden > 0 && /* @__PURE__ */ jsxs14("li", { className: "muted", children: [
          "and ",
          hidden,
          " more"
        ] })
      ] })
    ] })
  ] });
}
function LabelInput({ value, onDone, className = "flow-node-input", placeholder }) {
  const [draft, setDraft] = useState11(value);
  const done = useRef4(false);
  const ref = useRef4(null);
  useEffect9(() => {
    let tries = 0;
    let frame = 0;
    const grab = () => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      if (document.activeElement === el) el.select();
      else if (tries++ < 20) frame = window.requestAnimationFrame(grab);
    };
    grab();
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const finish = (v) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return /* @__PURE__ */ jsx15(
    "input",
    {
      ref,
      className: classNames(className, "nodrag nopan"),
      value: draft,
      "aria-label": "Rename",
      placeholder,
      maxLength: 120,
      onChange: (e) => setDraft(e.target.value),
      onBlur: () => finish(draft),
      onKeyDown: (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(draft);
        if (e.key === "Escape") finish(null);
      },
      onDoubleClick: (e) => e.stopPropagation()
    }
  );
}
function InfoIcon() {
  return /* @__PURE__ */ jsxs14("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx15("circle", { cx: "8", cy: "8", r: "6.6", fill: "none", stroke: "currentColor", strokeWidth: "1.4" }),
    /* @__PURE__ */ jsx15("rect", { x: "7.25", y: "7", width: "1.5", height: "4.6", rx: "0.75", fill: "currentColor" }),
    /* @__PURE__ */ jsx15("circle", { cx: "8", cy: "4.9", r: "0.95", fill: "currentColor" })
  ] });
}
var SIDES;
var init_PlanNode = __esm({
  "src/ui/components/flow/PlanNode.tsx"() {
    "use strict";
    init_store();
    init_Markdown();
    init_Progress();
    init_format();
    init_shared();
    SIDES = [
      ["top", Position.Top],
      ["right", Position.Right],
      ["bottom", Position.Bottom],
      ["left", Position.Left]
    ];
  }
});

// src/ui/components/flow/PlanEdge.tsx
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position as Position2, useInternalNode } from "@xyflow/react";
import { Fragment as Fragment2, jsx as jsx16, jsxs as jsxs15 } from "react/jsx-runtime";
function PlanEdge({ id, source, target, data, markerEnd, markerStart, selected, style }) {
  const api2 = useCanvas();
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return null;
  const a = rectOf(from);
  const b = rectOf(to);
  if (!a.width || !b.width) return null;
  let path;
  let label;
  const route = data?.route;
  if (source === target) {
    ({ path, label } = loopPath(a));
  } else if (route && route.points.length >= 2 && samePoint(route.from, a) && samePoint(route.to, b)) {
    const pts = route.points.map((p) => ({ ...p }));
    pts[0] = clipToRect(a, pts[1]);
    pts[pts.length - 1] = clipToRect(b, pts[pts.length - 2]);
    path = splinePath(pts);
    label = route.label ?? midpoint(pts);
  } else {
    const [sa, sb] = facingSides(a, b, api2.direction);
    const lane = data?.lane ?? 0;
    const s = sidePoint(a, sa, lane);
    const t = sidePoint(b, sb, lane);
    const [p, lx, ly] = getBezierPath({ sourceX: s.x, sourceY: s.y, sourcePosition: POSITION[sa], targetX: t.x, targetY: t.y, targetPosition: POSITION[sb], curvature: 0.3 });
    path = p;
    label = { x: lx, y: ly };
  }
  const editing = api2.editing === `edge:${id}`;
  const text = data?.label;
  return /* @__PURE__ */ jsxs15(Fragment2, { children: [
    /* @__PURE__ */ jsx16(BaseEdge, { id, path, markerEnd, markerStart, style, interactionWidth: 22 }),
    (text || editing) && /* @__PURE__ */ jsx16(EdgeLabelRenderer, { children: /* @__PURE__ */ jsx16(
      "div",
      {
        className: classNames("flow-edge-label nodrag nopan", selected && "is-selected", data?.dashed && "is-dashed", editing && "is-editing"),
        style: { transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` },
        onClick: () => api2.selectEdge(id),
        onDoubleClick: (e) => {
          e.stopPropagation();
          api2.startEditing(`edge:${id}`);
        },
        title: "Double-click to edit",
        children: editing ? /* @__PURE__ */ jsx16(LabelInput, { value: text ?? "", className: "flow-edge-input", placeholder: "What flows along it", onDone: (v) => api2.finishEdgeLabel(id, v) }) : text
      }
    ) })
  ] });
}
function rectOf(n) {
  return {
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    width: n.measured.width ?? n.width ?? n.data.width,
    height: n.measured.height ?? n.height ?? n.data.height
  };
}
var POSITION;
var init_PlanEdge = __esm({
  "src/ui/components/flow/PlanEdge.tsx"() {
    "use strict";
    init_format();
    init_geometry();
    init_layout();
    init_PlanNode();
    init_shared();
    POSITION = { top: Position2.Top, right: Position2.Right, bottom: Position2.Bottom, left: Position2.Left };
  }
});

// src/ui/components/flow/Panels.tsx
import { useEffect as useEffect10, useLayoutEffect, useRef as useRef5, useState as useState12 } from "react";
import { Fragment as Fragment3, jsx as jsx17, jsxs as jsxs16 } from "react/jsx-runtime";
function CommitInput({
  value,
  label,
  placeholder,
  className,
  maxLength,
  onCommit
}) {
  const [draft, setDraft] = useState12(value);
  const live = useRef5({ draft, value, onCommit });
  live.current = { draft, value, onCommit };
  useEffect10(() => setDraft(value), [value]);
  useEffect10(
    () => () => {
      const { draft: draft2, value: value2, onCommit: onCommit2 } = live.current;
      if (draft2.trim() !== value2) onCommit2(draft2.trim());
    },
    []
  );
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return /* @__PURE__ */ jsx17(
    "input",
    {
      className: classNames("input", className),
      value: draft,
      "aria-label": label,
      placeholder,
      maxLength,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
        }
      }
    }
  );
}
function CommitTextArea({
  value,
  label,
  placeholder,
  minRows = 3,
  maxLength,
  onCommit
}) {
  const [draft, setDraft] = useState12(value);
  const area = useRef5(null);
  const live = useRef5({ draft, value, onCommit });
  live.current = { draft, value, onCommit };
  useEffect10(() => setDraft(value), [value]);
  useEffect10(
    () => () => {
      const { draft: draft2, value: value2, onCommit: onCommit2 } = live.current;
      if (draft2.trim() !== value2.trim()) onCommit2(draft2.trim());
    },
    []
  );
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight + 2, 420)}px`;
  }, [draft]);
  const commit = () => {
    if (draft.trim() !== value.trim()) onCommit(draft.trim());
  };
  return /* @__PURE__ */ jsx17(
    "textarea",
    {
      ref: area,
      className: "input text-area",
      value: draft,
      rows: minRows,
      "aria-label": label,
      placeholder,
      maxLength,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
          area.current?.blur();
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
        }
      }
    }
  );
}
function KindPicker({ value, onChange, label }) {
  return /* @__PURE__ */ jsxs16("div", { className: "kind-picker", role: "radiogroup", "aria-label": label, children: [
    NODE_KINDS.map((k) => /* @__PURE__ */ jsx17(
      "button",
      {
        type: "button",
        role: "radio",
        "aria-checked": value === k,
        "aria-label": KIND_LABEL[k],
        title: `${KIND_LABEL[k]} \u2014 ${KIND_HINT[k]}`,
        className: classNames("kind-option", `kind-${k}`, value === k && "is-active"),
        onClick: () => onChange(k),
        children: /* @__PURE__ */ jsx17("span", { className: "kind-swatch", "aria-hidden": "true", children: KIND_GLYPH[k] })
      },
      k
    )),
    /* @__PURE__ */ jsx17("span", { className: "kind-picker-name", children: value ? KIND_LABEL[value] : "Mixed" })
  ] });
}
function Segmented({ value, options, label, onChange }) {
  return /* @__PURE__ */ jsx17("div", { className: "segmented is-small", role: "radiogroup", "aria-label": label, children: options.map(([v, text, title]) => /* @__PURE__ */ jsx17("button", { type: "button", role: "radio", "aria-checked": value === v, title, className: classNames("seg", value === v && "is-active"), onClick: () => onChange(v), children: text }, v)) });
}
function NodePanel({
  node,
  nodes,
  edges,
  plan,
  onChange,
  onSelect,
  onConnect,
  onDisconnect,
  onAddConnected,
  onDuplicate,
  onRemove,
  onClose
}) {
  const [confirming, setConfirming] = useState12(false);
  const name = (id) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const outgoing = edges.filter((e) => e.source === node.id);
  const incoming = edges.filter((e) => e.target === node.id && e.source !== node.id);
  const linked = node.data.taskIds ?? [];
  const rows = outline(plan);
  const linkable = rows.filter((r) => !linked.includes(r.task.id));
  const unconnected = nodes.filter((n) => n.id !== node.id && !outgoing.some((e) => e.target === n.id));
  return /* @__PURE__ */ jsxs16("div", { className: "arch-panel-body", "aria-label": `Details of ${node.data.label}`, children: [
    /* @__PURE__ */ jsxs16("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx17("span", { className: classNames("kind-swatch", `kind-${node.data.kind}`), "aria-hidden": "true", children: KIND_GLYPH[node.data.kind] }),
      /* @__PURE__ */ jsx17("span", { className: "panel-kicker", children: KIND_LABEL[node.data.kind] }),
      /* @__PURE__ */ jsx17("span", { className: "item-id", title: "Id \u2014 how Claude refers to this box", children: node.id }),
      /* @__PURE__ */ jsx17("span", { className: "spacer" }),
      /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn is-tiny", "aria-label": "Close details", title: "Back to the diagram", onClick: onClose, children: "\xD7" })
    ] }),
    /* @__PURE__ */ jsx17(
      CommitInput,
      {
        className: "panel-title-input",
        value: node.data.label,
        label: "Box label",
        maxLength: 120,
        onCommit: (label) => label && onChange({ label })
      }
    ),
    /* @__PURE__ */ jsxs16("div", { className: "field", children: [
      /* @__PURE__ */ jsx17("span", { className: "field-label", children: "Kind" }),
      /* @__PURE__ */ jsx17(KindPicker, { value: node.data.kind, label: "Kind", onChange: (kind) => onChange({ kind }) })
    ] }),
    /* @__PURE__ */ jsxs16("label", { className: "field", children: [
      /* @__PURE__ */ jsxs16("span", { className: "field-label", children: [
        "On the box ",
        /* @__PURE__ */ jsx17("span", { className: "field-aside", children: "a few words: technology or role" })
      ] }),
      /* @__PURE__ */ jsx17(CommitInput, { value: node.data.detail ?? "", label: "Box detail", placeholder: "e.g. Redis, read-through", maxLength: 80, onCommit: (detail) => onChange({ detail }) })
    ] }),
    /* @__PURE__ */ jsxs16("label", { className: "field", children: [
      /* @__PURE__ */ jsxs16("span", { className: "field-label", children: [
        "Description ",
        /* @__PURE__ */ jsx17("span", { className: "field-aside", children: "shown when hovering \u24D8" })
      ] }),
      /* @__PURE__ */ jsx17(
        CommitTextArea,
        {
          value: node.data.description ?? "",
          label: `Description of ${node.data.label}`,
          placeholder: "What this part does, what it owns, and how other parts talk to it.",
          maxLength: 4e3,
          onCommit: (description) => onChange({ description })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs16("div", { className: "field", children: [
      /* @__PURE__ */ jsx17("span", { className: "field-label", children: "Notes and decisions" }),
      /* @__PURE__ */ jsx17(
        MarkdownField,
        {
          value: node.data.notes ?? "",
          label: `notes on ${node.data.label}`,
          placeholder: "What was decided about this part, and why.",
          emptyAction: "Add a decision",
          rows: 6,
          onSave: (notes) => onChange({ notes })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs16("div", { className: "field", children: [
      /* @__PURE__ */ jsx17("span", { className: "field-label", children: "Built by" }),
      linked.length > 0 ? /* @__PURE__ */ jsx17("ul", { className: "panel-tasks", children: linked.map((id) => {
        const task = plan.tasks.find((t) => t.id === id);
        if (!task) return null;
        return /* @__PURE__ */ jsxs16("li", { children: [
          /* @__PURE__ */ jsx17("span", { className: classNames("status-dot is-static", `is-${task.status}`), title: STATUS_LABEL[task.status], "aria-label": STATUS_LABEL[task.status], children: STATUS_GLYPH[task.status] }),
          /* @__PURE__ */ jsx17("button", { type: "button", className: "link panel-task", onClick: () => store.focus("task", id), children: task.title }),
          /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn is-tiny", "aria-label": `Unlink ${task.title}`, title: "Unlink", onClick: () => onChange({ taskIds: linked.filter((t) => t !== id) }), children: "\xD7" })
        ] }, id);
      }) }) : /* @__PURE__ */ jsx17("p", { className: "muted panel-empty", children: "No tasks linked. Link the tasks that build this part to see its progress on the box." }),
      linkable.length > 0 && /* @__PURE__ */ jsxs16("select", { className: "input", "aria-label": `Link a task to ${node.data.label}`, value: "", onChange: (e) => e.target.value && onChange({ taskIds: [...linked, e.target.value] }), children: [
        /* @__PURE__ */ jsx17("option", { value: "", children: "Link a task\u2026" }),
        linkable.map(({ task, number, depth }) => /* @__PURE__ */ jsxs16("option", { value: task.id, children: [
          " ".repeat(depth * 3),
          number,
          " ",
          task.title
        ] }, task.id))
      ] })
    ] }),
    /* @__PURE__ */ jsxs16("div", { className: "field", children: [
      /* @__PURE__ */ jsx17("span", { className: "field-label", children: "Connections" }),
      outgoing.length + incoming.length > 0 ? /* @__PURE__ */ jsxs16("ul", { className: "panel-links", children: [
        outgoing.map((e) => /* @__PURE__ */ jsxs16("li", { children: [
          /* @__PURE__ */ jsxs16("button", { type: "button", className: "link", onClick: () => onSelect("edge", e.id), children: [
            e.data?.arrows === "both" ? "\u2194" : "\u2192",
            " ",
            name(e.target)
          ] }),
          e.data?.label && /* @__PURE__ */ jsxs16("span", { className: "muted", children: [
            " ",
            e.data.label
          ] }),
          /* @__PURE__ */ jsx17("span", { className: "spacer" }),
          /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn is-tiny", "aria-label": `Remove connection to ${name(e.target)}`, title: "Disconnect", onClick: () => onDisconnect(e.id), children: "\xD7" })
        ] }, e.id)),
        incoming.map((e) => /* @__PURE__ */ jsxs16("li", { children: [
          /* @__PURE__ */ jsxs16("button", { type: "button", className: "link", onClick: () => onSelect("edge", e.id), children: [
            e.data?.arrows === "both" ? "\u2194" : "\u2190",
            " ",
            name(e.source)
          ] }),
          e.data?.label && /* @__PURE__ */ jsxs16("span", { className: "muted", children: [
            " ",
            e.data.label
          ] }),
          /* @__PURE__ */ jsx17("span", { className: "spacer" }),
          /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn is-tiny", "aria-label": `Remove connection from ${name(e.source)}`, title: "Disconnect", onClick: () => onDisconnect(e.id), children: "\xD7" })
        ] }, e.id))
      ] }) : /* @__PURE__ */ jsx17("p", { className: "muted panel-empty", children: "Not connected. Drag from any edge of the box to another box, or into space for a new one." }),
      /* @__PURE__ */ jsxs16("div", { className: "row-actions", children: [
        unconnected.length > 0 && /* @__PURE__ */ jsxs16("select", { className: "input", "aria-label": `Connect ${node.data.label} to`, value: "", onChange: (e) => e.target.value && onConnect(e.target.value), children: [
          /* @__PURE__ */ jsx17("option", { value: "", children: "Connect to\u2026" }),
          unconnected.map((n) => /* @__PURE__ */ jsx17("option", { value: n.id, children: n.data.label }, n.id))
        ] }),
        /* @__PURE__ */ jsx17("button", { type: "button", className: "btn btn-sm", onClick: onAddConnected, title: "A new box, connected from this one", children: "+ Connected box" })
      ] })
    ] }),
    /* @__PURE__ */ jsxs16("footer", { className: "panel-foot", children: [
      /* @__PURE__ */ jsx17("button", { type: "button", className: "link", onClick: onDuplicate, title: "\u2318/Ctrl+D", children: "Duplicate" }),
      /* @__PURE__ */ jsx17("span", { className: "spacer" }),
      confirming ? /* @__PURE__ */ jsxs16("span", { className: "item-confirm", children: [
        "Delete this box and its arrows?",
        /* @__PURE__ */ jsx17("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Delete" }),
        /* @__PURE__ */ jsx17("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
      ] }) : /* @__PURE__ */ jsx17("button", { type: "button", className: "link is-danger", onClick: () => setConfirming(true), children: "Delete box" })
    ] })
  ] });
}
function EdgePanel({
  edge,
  nodes,
  onChange,
  onReverse,
  onSelect,
  onRemove,
  onClose
}) {
  const name = (id) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const ends = (which) => /* @__PURE__ */ jsx17("select", { className: "input", "aria-label": which === "source" ? "From" : "To", value: edge[which], onChange: (e) => onChange({ [which]: e.target.value }), children: nodes.map((n) => /* @__PURE__ */ jsx17("option", { value: n.id, disabled: n.id === (which === "source" ? edge.target : edge.source), children: n.data.label }, n.id)) });
  return /* @__PURE__ */ jsxs16("div", { className: "arch-panel-body", "aria-label": "Details of the selected arrow", children: [
    /* @__PURE__ */ jsxs16("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx17("span", { className: "panel-kicker", children: "Connection" }),
      /* @__PURE__ */ jsx17("span", { className: "spacer" }),
      /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn is-tiny", "aria-label": "Close details", title: "Back to the diagram", onClick: onClose, children: "\xD7" })
    ] }),
    /* @__PURE__ */ jsxs16("p", { className: "panel-edge", children: [
      /* @__PURE__ */ jsx17("button", { type: "button", className: "link", onClick: () => onSelect("node", edge.source), children: name(edge.source) }),
      /* @__PURE__ */ jsxs16("span", { "aria-hidden": "true", children: [
        " ",
        edge.data?.arrows === "both" ? "\u2194" : edge.data?.arrows === "none" ? "\u2014" : "\u2192",
        " "
      ] }),
      /* @__PURE__ */ jsx17("button", { type: "button", className: "link", onClick: () => onSelect("node", edge.target), children: name(edge.target) })
    ] }),
    /* @__PURE__ */ jsxs16("label", { className: "field", children: [
      /* @__PURE__ */ jsx17("span", { className: "field-label", children: "What flows along it" }),
      /* @__PURE__ */ jsx17(CommitInput, { value: edge.data?.label ?? "", label: "Arrow label", placeholder: "e.g. REST, publishes events", maxLength: 120, onCommit: (label) => onChange({ label }) })
    ] }),
    /* @__PURE__ */ jsxs16("div", { className: "field", children: [
      /* @__PURE__ */ jsx17("span", { className: "field-label", children: "Joins" }),
      /* @__PURE__ */ jsxs16("div", { className: "edge-ends", children: [
        ends("source"),
        /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn", "aria-label": "Reverse direction", title: "Reverse direction", onClick: onReverse, children: "\u21C4" }),
        ends("target")
      ] })
    ] }),
    /* @__PURE__ */ jsxs16("div", { className: "field-row", children: [
      /* @__PURE__ */ jsxs16("div", { className: "field-col", children: [
        /* @__PURE__ */ jsx17("span", { className: "field-label", children: "Line" }),
        /* @__PURE__ */ jsx17(
          Segmented,
          {
            label: "Line",
            value: edge.data?.dashed ? "dashed" : "solid",
            options: [
              ["solid", "Solid", "A connection that is always there"],
              ["dashed", "Dashed", "Optional, async or future"]
            ],
            onChange: (v) => onChange({ dashed: v === "dashed" })
          }
        )
      ] }),
      /* @__PURE__ */ jsxs16("div", { className: "field-col", children: [
        /* @__PURE__ */ jsx17("span", { className: "field-label", children: "Arrowheads" }),
        /* @__PURE__ */ jsx17(
          Segmented,
          {
            label: "Arrowheads",
            value: edge.data?.arrows ?? "end",
            options: [
              ["end", "\u2192", "One way, from the first box to the second"],
              ["both", "\u2194", "Both ways"],
              ["none", "\u2014", "No direction"]
            ],
            onChange: (v) => onChange({ arrows: v === "end" ? void 0 : v })
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsx17("footer", { className: "panel-foot", children: /* @__PURE__ */ jsx17("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Delete connection" }) })
  ] });
}
function SelectionPanel({
  nodes,
  edges,
  onKind,
  onCopy,
  onDuplicate,
  onRemove,
  onClose
}) {
  const kinds = new Set(nodes.map((n) => n.data.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  return /* @__PURE__ */ jsxs16("div", { className: "arch-panel-body", "aria-label": "Details of the selection", children: [
    /* @__PURE__ */ jsxs16("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx17("span", { className: "panel-kicker", children: "Selection" }),
      /* @__PURE__ */ jsx17("span", { className: "spacer" }),
      /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn is-tiny", "aria-label": "Clear selection", title: "Clear selection", onClick: onClose, children: "\xD7" })
    ] }),
    /* @__PURE__ */ jsxs16("p", { className: "panel-hint", children: [
      nodes.length,
      " box",
      nodes.length === 1 ? "" : "es",
      " and ",
      edges.length,
      " arrow",
      edges.length === 1 ? "" : "s",
      " selected."
    ] }),
    nodes.length > 0 && /* @__PURE__ */ jsxs16("div", { className: "field", children: [
      /* @__PURE__ */ jsx17("span", { className: "field-label", children: "Kind of every box" }),
      /* @__PURE__ */ jsx17(KindPicker, { value: kind, label: "Kind of every selected box", onChange: onKind })
    ] }),
    /* @__PURE__ */ jsxs16("div", { className: "row-actions", children: [
      nodes.length > 0 && /* @__PURE__ */ jsxs16(Fragment3, { children: [
        /* @__PURE__ */ jsx17("button", { type: "button", className: "btn btn-sm", onClick: onCopy, title: "\u2318/Ctrl+C", children: "Copy" }),
        /* @__PURE__ */ jsx17("button", { type: "button", className: "btn btn-sm", onClick: onDuplicate, title: "\u2318/Ctrl+D", children: "Duplicate" })
      ] }),
      /* @__PURE__ */ jsx17("button", { type: "button", className: "btn btn-sm btn-danger", onClick: onRemove, children: "Delete selection" })
    ] })
  ] });
}
var init_Panels = __esm({
  "src/ui/components/flow/Panels.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Progress();
    init_format();
    init_plan();
    init_types();
    init_shared();
  }
});

// src/ui/components/FlowCanvas.tsx
import { useCallback, useEffect as useEffect11, useMemo as useMemo2, useRef as useRef6, useState as useState13 } from "react";
import {
  Background,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow
} from "@xyflow/react";
import { jsx as jsx18, jsxs as jsxs17 } from "react/jsx-runtime";
function DiagramEditor(props) {
  return /* @__PURE__ */ jsx18(ReactFlowProvider, { children: /* @__PURE__ */ jsx18(Editor, { ...props }) });
}
function Editor({
  diagram,
  plan,
  onSave,
  aside
}) {
  const theme = useResolvedTheme();
  const flow = useReactFlow();
  const wrapper = useRef6(null);
  const [initial2] = useState13(() => toFlow(diagram, plan));
  const [nodes, setNodes] = useState13(initial2.nodes);
  const [edges, setEdges] = useState13(initial2.edges);
  const [editing, setEditing] = useState13(null);
  const nodesRef = useRef6(nodes);
  const edgesRef = useRef6(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const planRef = useRef6(plan);
  planRef.current = plan;
  const dragging = useRef6(false);
  const queue = useRef6({ pending: null, busy: false });
  const pointer = useRef6(null);
  const pastes = useRef6(0);
  const signature = useMemo2(() => signatureOf(diagram), [diagram]);
  const loaded = useRef6(signature);
  const nudge = useRef6(void 0);
  const baseRev = useRef6(diagram.rev);
  const load = useCallback((source, p) => {
    const next = toFlow(source, p);
    setNodes((prev) => keepSelection(prev, next.nodes));
    setEdges((prev) => keepRoutes(prev, keepSelection(prev, next.edges), next.nodes));
    baseRev.current = source.rev;
    loaded.current = signatureOf(source);
  }, []);
  useEffect11(() => {
    if (dragging.current || nudge.current !== void 0 || queue.current.busy || queue.current.pending) return;
    if (loaded.current !== signature) load(diagram, plan);
    else baseRev.current = diagram.rev;
  }, [signature, diagram.rev]);
  const progressKey = useMemo2(() => JSON.stringify(plan.tasks.map((t) => [t.id, t.status, t.parentId])), [plan.tasks]);
  useEffect11(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, ...progressOf(plan, n.data.taskIds) } })));
  }, [progressKey]);
  const focusTarget = useStore((s) => s.focusTarget);
  useEffect11(() => {
    const prefix = `node:${diagram.id}:`;
    if (!focusTarget?.startsWith(prefix)) return;
    const id = focusTarget.slice(prefix.length);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: false })));
    window.requestAnimationFrame(() => void flow.fitView({ nodes: [{ id }], padding: 1.2, duration: 250, maxZoom: 1.2 }));
    store.set({ focusTarget: null });
  }, [focusTarget, diagram.id, flow]);
  const latest = () => store.getState().session?.plan?.diagrams.find((d) => d.id === diagram.id);
  const resyncFromServer = useCallback(() => {
    const p = store.getState().session?.plan;
    const current = p?.diagrams.find((d) => d.id === diagram.id);
    if (p && current) load(current, p);
  }, [diagram.id, load]);
  const flush = useCallback(async () => {
    const q = queue.current;
    if (q.busy) return;
    q.busy = true;
    try {
      while (q.pending) {
        const patch = q.pending;
        q.pending = null;
        const savedRev = await onSave({ ...patch, expect: baseRev.current });
        if (savedRev !== null) {
          baseRev.current = savedRev;
        } else {
          q.pending = null;
          resyncFromServer();
        }
      }
    } finally {
      q.busy = false;
    }
    const now = latest();
    if (now && now.rev !== baseRev.current) resyncFromServer();
  }, [onSave, resyncFromServer]);
  const persist = useCallback(
    (ns, es, direction) => {
      const superseded = queue.current.pending;
      queue.current.pending = {
        nodes: ns.map((n) => ({
          id: n.id,
          label: n.data.label,
          kind: n.data.kind,
          ...n.data.detail ? { detail: n.data.detail } : {},
          // Sent even when empty: leaving them out would keep the old text.
          description: n.data.description ?? "",
          notes: n.data.notes ?? "",
          taskIds: n.data.taskIds ?? [],
          x: Math.round(n.position.x),
          y: Math.round(n.position.y)
        })),
        edges: es.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          // Always said, even when empty: the daemon keeps an arrow's label
          // and style when an edit leaves them out.
          label: e.data?.label ?? "",
          dashed: Boolean(e.data?.dashed),
          arrows: e.data?.arrows ?? "end"
        })),
        // A patch waiting behind the one in flight is replaced, not merged —
        // except for the direction, which only the relayout ever sets.
        ...direction ?? superseded?.direction ? { direction: direction ?? superseded?.direction } : {}
      };
      void flush();
    },
    [flush]
  );
  const commit = useCallback(
    (ns, es, direction) => {
      setNodes(ns);
      setEdges(es);
      persist(ns, es, direction);
    },
    [persist]
  );
  const onNodesChange = useCallback(
    (changes) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (dragging.current || !changes.some((c) => c.type === "position" && c.position && !c.dragging)) return;
      window.clearTimeout(nudge.current);
      nudge.current = window.setTimeout(() => {
        nudge.current = void 0;
        persist(nodesRef.current, edgesRef.current);
      }, 300);
    },
    [persist]
  );
  const persistRef = useRef6(persist);
  persistRef.current = persist;
  useEffect11(
    () => () => {
      if (nudge.current === void 0) return;
      window.clearTimeout(nudge.current);
      nudge.current = void 0;
      persistRef.current(nodesRef.current, edgesRef.current);
    },
    []
  );
  const onEdgesChange = useCallback((changes) => setEdges((es) => applyEdgeChanges(changes, es)), []);
  const connect = useCallback(
    (source, target, base = edgesRef.current, ns = nodesRef.current) => {
      if (source === target || base.some((e) => e.source === source && e.target === target)) return false;
      commit(ns, [...base, makeEdge({ id: freeEdgeId(base, source, target), source, target })]);
      return true;
    },
    [commit]
  );
  const onConnect = useCallback((conn) => conn.source && conn.target && connect(conn.source, conn.target), [connect]);
  const addNode = useCallback(
    (kind, opts = {}) => {
      const ns = nodesRef.current;
      let k = ns.length + 1;
      while (ns.some((x) => x.id === `n${k}`)) k++;
      const id = `n${k}`;
      const data = sized({ label: `New ${KIND_LABEL[kind].toLowerCase()}`, kind, width: 0, height: 0 });
      const lr = diagram.direction === "LR";
      let want;
      if (opts.at) want = { x: opts.at.x - data.width / 2, y: opts.at.y - data.height / 2 };
      else if (opts.from) {
        const src = ns.find((n) => n.id === opts.from);
        want = lr ? { x: src.position.x + src.data.width + 90, y: src.position.y } : { x: src.position.x, y: src.position.y + src.data.height + 90 };
      } else {
        const rect = wrapper.current?.getBoundingClientRect();
        const c = rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
        want = { x: c.x - data.width / 2, y: c.y - data.height / 2 };
      }
      const position = opts.at ? round(want) : findFreeSpot(want, data, positionsOf(ns), sizesOf(ns), lr);
      const node = { id, type: "plan", position, data, selected: true };
      const nextNodes = [...ns.map((x) => x.selected ? { ...x, selected: false } : x), node];
      const base = edgesRef.current.map((e) => e.selected ? { ...e, selected: false } : e);
      const nextEdges = opts.from ? [...base, makeEdge({ id: freeEdgeId(base, opts.from, id), source: opts.from, target: id })] : base;
      commit(nextNodes, nextEdges);
      setEditing(`node:${id}`);
    },
    [commit, diagram.direction, flow]
  );
  const onConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      const hit = document.elementFromPoint?.(point.clientX, point.clientY) ?? null;
      const onNode = hit?.closest(".react-flow__node")?.getAttribute("data-id");
      if (onNode) {
        if (onNode !== state.fromNode.id) connect(state.fromNode.id, onNode);
        return;
      }
      if (hit?.closest(".react-flow__pane")) {
        addNode("component", { at: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }), from: state.fromNode.id });
      }
    },
    [addNode, connect, flow]
  );
  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }) => {
      const goneIds = new Set(gone.map((n) => n.id));
      const cutIds = new Set(cut.map((e) => e.id));
      commit(
        nodesRef.current.filter((n) => !goneIds.has(n.id)),
        edgesRef.current.filter((e) => !cutIds.has(e.id) && !goneIds.has(e.source) && !goneIds.has(e.target))
      );
    },
    [commit]
  );
  const onDragStop = useCallback(
    (moved) => {
      dragging.current = false;
      const at = new Map(moved.map((n) => [n.id, n.position]));
      persist(
        nodesRef.current.map((n) => at.has(n.id) ? { ...n, position: at.get(n.id) } : n),
        edgesRef.current
      );
    },
    [persist]
  );
  const onNodeDragStop = useCallback((_, __, moved) => onDragStop(moved), [onDragStop]);
  const onSelectionDragStop = useCallback((_, moved) => onDragStop(moved), [onDragStop]);
  const onDragStart = useCallback(() => {
    dragging.current = true;
  }, []);
  const updateNodes = (ids, patch) => {
    const ns = nodesRef.current.map((n) => {
      if (!ids.has(n.id)) return n;
      const data = { ...n.data, ...patch };
      for (const key of ["detail", "description", "notes"]) if (!data[key]) delete data[key];
      return { ...n, data: { ...sized(data), ...progressOf(planRef.current, data.taskIds) } };
    });
    commit(ns, edgesRef.current);
  };
  const updateNode = (id, patch) => updateNodes(/* @__PURE__ */ new Set([id]), patch);
  const updateEdge = (id, patch) => {
    const es = edgesRef.current.map((e) => {
      if (e.id !== id) return e;
      const source = patch.source ?? e.source;
      const target = patch.target ?? e.target;
      const data = { ...e.data, ...patch };
      delete data.source;
      delete data.target;
      if (!data.label) delete data.label;
      if (!data.arrows) delete data.arrows;
      if (!data.dashed) delete data.dashed;
      if (source !== e.source || target !== e.target) delete data.route;
      return makeEdge({ id: e.id, source, target, ...data }, e.selected);
    });
    commit(nodesRef.current, es);
  };
  const reverseEdge = (id) => {
    const e = edgesRef.current.find((x) => x.id === id);
    if (e) updateEdge(id, { source: e.target, target: e.source });
  };
  const select = useCallback((kind, id) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: kind === "node" && n.id === id })));
    setEdges((es) => es.map((e) => ({ ...e, selected: kind === "edge" && e.id === id })));
  }, []);
  const clearSelection = () => {
    setNodes((ns) => ns.map((n) => n.selected ? { ...n, selected: false } : n));
    setEdges((es) => es.map((e) => e.selected ? { ...e, selected: false } : e));
  };
  const removeSelected = useCallback(() => {
    void flow.deleteElements({ nodes: nodesRef.current.filter((n) => n.selected), edges: edgesRef.current.filter((e) => e.selected) });
  }, [flow]);
  const relayout = (direction) => {
    const at = autoLayout(graphOf(nodesRef.current, edgesRef.current), direction);
    const ns = nodesRef.current.map((n) => ({ ...n, position: at.positions.get(n.id) ?? n.position }));
    const es = edgesRef.current.map((e) => withRoute(e, at));
    commit(ns, es, direction);
    window.requestAnimationFrame(() => void flow.fitView(FIT));
  };
  const selectionClip = useCallback(() => {
    const picked = nodesRef.current.filter((n) => n.selected);
    return toClip(
      picked.map((n) => ({ id: n.id, ...contentOf(n.data), x: n.position.x, y: n.position.y })),
      edgesRef.current.map((e) => ({ source: e.source, target: e.target, ...edgeContent(e.data) }))
    );
  }, []);
  const paste = useCallback(
    (clip, where) => {
      const origin = clipOrigin(clip);
      pastes.current += 1;
      const step = 32 * pastes.current;
      const at = where === "pointer" && pointer.current ? { x: pointer.current.x - origin.x, y: pointer.current.y - origin.y } : { x: step, y: step };
      const tasks = new Set(planRef.current.tasks.map((t) => t.id));
      const made = pasteClip(clip, nodesRef.current.map((n) => n.id), tasks, at);
      const newNodes = made.nodes.map(({ id, x, y, ...content }) => ({
        id,
        type: "plan",
        position: { x, y },
        data: { ...sized({ ...content, width: 0, height: 0 }), ...progressOf(planRef.current, content.taskIds) },
        selected: true
      }));
      const base = edgesRef.current.map((e) => e.selected ? { ...e, selected: false } : e);
      const newEdges = made.edges.reduce((es, e) => [...es, makeEdge({ id: freeEdgeId(es, e.source, e.target), ...e })], base);
      commit([...nodesRef.current.map((n) => n.selected ? { ...n, selected: false } : n), ...newNodes], newEdges);
      return newNodes.length;
    },
    [commit]
  );
  const copySelection = useCallback(
    (data) => {
      const clip = selectionClip();
      if (!clip) return false;
      lastClip = clip;
      pastes.current = 0;
      const text = serializeClip(clip);
      if (data) data.setData("text/plain", text);
      else void navigator.clipboard?.writeText(text).catch(() => void 0);
      store.toast("info", `Copied ${clip.nodes.length} box${clip.nodes.length === 1 ? "" : "es"}. Paste with \u2318/Ctrl+V, here or in another diagram.`);
      return true;
    },
    [selectionClip]
  );
  const duplicate = useCallback(() => {
    const clip = selectionClip();
    if (!clip) return;
    pastes.current = 0;
    paste(clip, "offset");
  }, [paste, selectionClip]);
  useEffect11(() => {
    const busy = (target) => {
      const el = target;
      if (!el || !(el instanceof HTMLElement)) return false;
      return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    };
    const ours = (e) => {
      if (busy(e.target) || busy(document.activeElement)) return false;
      const active = document.activeElement;
      const onCanvas = !active || active === document.body || Boolean(wrapper.current?.contains(active));
      const text = window.getSelection?.()?.toString() ?? "";
      return onCanvas && !text;
    };
    const onCopy = (e) => {
      if (!ours(e) || !nodesRef.current.some((n) => n.selected)) return;
      if (copySelection(e.clipboardData)) e.preventDefault();
    };
    const onCut = (e) => {
      if (!ours(e) || !nodesRef.current.some((n) => n.selected)) return;
      if (copySelection(e.clipboardData)) {
        e.preventDefault();
        removeSelected();
      }
    };
    const onPaste = (e) => {
      if (!ours(e)) return;
      const text = e.clipboardData?.getData("text/plain");
      const clip = text ? parseClip(text) : lastClip;
      if (!clip) return;
      e.preventDefault();
      paste(clip, "pointer");
    };
    const onKey = (e) => {
      if (busy(e.target)) return;
      const active = document.activeElement;
      if (active && active !== document.body && !wrapper.current?.contains(active)) return;
      const mod = e.metaKey || e.ctrlKey;
      const selected = nodesRef.current.filter((n) => n.selected);
      if (mod && e.key.toLowerCase() === "d" && selected.length) {
        e.preventDefault();
        duplicate();
      } else if (mod && e.key.toLowerCase() === "a" && !e.shiftKey) {
        e.preventDefault();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
        setEdges((es) => es.map((x) => ({ ...x, selected: true })));
      } else if (e.key === "F2" && selected.length === 1) {
        e.preventDefault();
        setEditing(`node:${selected[0].id}`);
      } else if (e.key === "Escape") {
        setEditing(null);
        clearSelection();
      }
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey);
    };
  }, [copySelection, duplicate, paste, removeSelected]);
  const api2 = useMemo2(
    () => ({
      direction: diagram.direction,
      editing,
      startEditing: setEditing,
      finishNodeLabel: (id, label) => {
        setEditing(null);
        const node = nodesRef.current.find((n) => n.id === id);
        const next = label?.trim();
        if (node && next && next !== node.data.label) updateNode(id, { label: next });
      },
      finishEdgeLabel: (id, label) => {
        setEditing(null);
        const edge = edgesRef.current.find((e) => e.id === id);
        if (edge && label !== null && label.trim() !== (edge.data?.label ?? "")) updateEdge(id, { label: label.trim() });
      },
      selectEdge: (id) => select("edge", id)
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the updaters read live state through refs
    [diagram.direction, editing, select]
  );
  const drawnEdges = useMemo2(() => {
    const offsets = lanes(edges);
    if (offsets.size === 0) return edges;
    return edges.map((e) => offsets.has(e.id) ? { ...e, data: { ...e.data, lane: offsets.get(e.id) } } : e);
  }, [edges]);
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);
  let panel;
  if (selectedNodes.length === 1 && selectedEdges.length === 0) {
    const node = selectedNodes[0];
    panel = /* @__PURE__ */ jsx18(
      NodePanel,
      {
        node,
        nodes,
        edges,
        plan,
        onChange: (patch) => updateNode(node.id, patch),
        onSelect: select,
        onConnect: (target) => connect(node.id, target),
        onDisconnect: (id) => commit(nodesRef.current, edgesRef.current.filter((e) => e.id !== id)),
        onAddConnected: () => addNode("component", { from: node.id }),
        onDuplicate: duplicate,
        onRemove: removeSelected,
        onClose: clearSelection
      },
      node.id
    );
  } else if (selectedEdges.length === 1 && selectedNodes.length === 0) {
    const edge = selectedEdges[0];
    panel = /* @__PURE__ */ jsx18(
      EdgePanel,
      {
        edge,
        nodes,
        onChange: (patch) => updateEdge(edge.id, patch),
        onReverse: () => reverseEdge(edge.id),
        onSelect: select,
        onRemove: removeSelected,
        onClose: clearSelection
      },
      edge.id
    );
  } else if (selectedNodes.length + selectedEdges.length > 1) {
    panel = /* @__PURE__ */ jsx18(
      SelectionPanel,
      {
        nodes: selectedNodes,
        edges: selectedEdges,
        onKind: (kind) => updateNodes(new Set(selectedNodes.map((n) => n.id)), { kind }),
        onCopy: () => copySelection(null),
        onDuplicate: duplicate,
        onRemove: removeSelected,
        onClose: clearSelection
      }
    );
  } else {
    panel = aside;
  }
  return /* @__PURE__ */ jsx18(CanvasContext.Provider, { value: api2, children: /* @__PURE__ */ jsxs17("div", { className: "arch-body", children: [
    /* @__PURE__ */ jsx18(
      "div",
      {
        ref: wrapper,
        className: "flow",
        onMouseMove: (e) => {
          pointer.current = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        },
        onMouseLeave: () => {
          pointer.current = null;
        },
        onDoubleClick: (e) => {
          const el = e.target;
          if (el.closest(".react-flow__node, .react-flow__edge, .react-flow__panel, .flow-edge-label")) return;
          if (!el.closest(".react-flow__pane")) return;
          addNode("component", { at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
        },
        children: /* @__PURE__ */ jsxs17(
          ReactFlow,
          {
            nodes,
            edges: drawnEdges,
            nodeTypes,
            edgeTypes,
            onNodesChange,
            onEdgesChange,
            onConnect,
            onConnectEnd,
            onDelete,
            onNodeDragStart: onDragStart,
            onNodeDragStop,
            onSelectionDragStart: onDragStart,
            onSelectionDragStop,
            onNodeDoubleClick: (_, node) => setEditing(`node:${node.id}`),
            onEdgeDoubleClick: (_, edge) => setEditing(`edge:${edge.id}`),
            connectionMode: ConnectionMode.Loose,
            deleteKeyCode: ["Backspace", "Delete"],
            zoomOnDoubleClick: false,
            colorMode: theme,
            fitView: true,
            fitViewOptions: FIT,
            minZoom: 0.2,
            maxZoom: 2,
            defaultEdgeOptions: { type: "plan" },
            children: [
              /* @__PURE__ */ jsx18(Background, { gap: 18, size: 1 }),
              /* @__PURE__ */ jsx18(Controls, { showInteractive: false, position: "bottom-left", fitViewOptions: FIT }),
              /* @__PURE__ */ jsx18(MiniMap, { pannable: true, zoomable: true, position: "bottom-right", style: { width: 150, height: 96 }, nodeBorderRadius: 4 }),
              /* @__PURE__ */ jsxs17(Panel, { position: "top-left", className: "flow-toolbar", children: [
                /* @__PURE__ */ jsx18(AddMenu, { onAdd: (kind) => addNode(kind) }),
                /* @__PURE__ */ jsx18("button", { type: "button", className: "btn btn-sm", title: "Lay the whole diagram out again, along its flow", onClick: () => relayout(diagram.direction), children: "Tidy layout" }),
                /* @__PURE__ */ jsx18(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-sm",
                    title: diagram.direction === "LR" ? "Lay it out top to bottom" : "Lay it out left to right",
                    onClick: () => relayout(diagram.direction === "LR" ? "TB" : "LR"),
                    children: diagram.direction === "LR" ? "\u2192 Left to right" : "\u2193 Top to bottom"
                  }
                )
              ] })
            ]
          }
        )
      }
    ),
    /* @__PURE__ */ jsx18("aside", { className: "arch-panel", "aria-label": "Details", children: panel })
  ] }) });
}
function toFlow(diagram, plan) {
  const layout = resolveLayout(diagram);
  const nodes = diagram.nodes.map((n) => ({
    id: n.id,
    type: "plan",
    position: layout.positions.get(n.id) ?? { x: 0, y: 0 },
    data: {
      ...sized({
        label: n.label,
        kind: n.kind,
        ...n.detail ? { detail: n.detail } : {},
        ...n.description ? { description: n.description } : {},
        ...n.notes ? { notes: n.notes } : {},
        ...n.taskIds?.length ? { taskIds: n.taskIds } : {},
        width: 0,
        height: 0
      }),
      ...progressOf(plan, n.taskIds)
    }
  }));
  const edges = diagram.edges.map((e) => withRoute(makeEdge(e), layout));
  return { nodes, edges };
}
function signatureOf(d) {
  return JSON.stringify([d.nodes, d.edges, d.direction]);
}
function makeEdge(e, selected) {
  const arrows = e.arrows === "both" || e.arrows === "none" ? e.arrows : void 0;
  const marker = { type: MarkerType.ArrowClosed, width: 16, height: 16 };
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: "plan",
    data: {
      ...e.label ? { label: e.label } : {},
      ...e.dashed ? { dashed: true } : {},
      ...arrows ? { arrows } : {},
      ...e.route ? { route: e.route } : {}
    },
    ...arrows !== "none" ? { markerEnd: marker } : {},
    ...arrows === "both" ? { markerStart: marker } : {},
    className: classNames(e.dashed && "is-dashed"),
    ...e.dashed ? { style: { strokeDasharray: "6 4" } } : {},
    ...selected ? { selected } : {}
  };
}
function withRoute(edge, layout) {
  const route = layout.routes.get(edge.id);
  const data = { ...edge.data };
  if (route) data.route = route;
  else delete data.route;
  return { ...edge, data };
}
function keepRoutes(prev, next, nodes) {
  const at = new Map(nodes.map((n) => [n.id, n.position]));
  return next.map((e) => {
    if (e.data?.route) return e;
    const old = prev.find((p) => p.id === e.id && p.source === e.source && p.target === e.target)?.data?.route;
    if (old && samePoint(at.get(e.source), old.from) && samePoint(at.get(e.target), old.to)) return { ...e, data: { ...e.data, route: old } };
    return e;
  });
}
function keepSelection(prev, next) {
  const selected = new Set(prev.filter((x) => x.selected).map((x) => x.id));
  return next.map((x) => selected.has(x.id) ? { ...x, selected: true } : x);
}
function sized(data) {
  const { width, height } = nodeSize(data);
  return { ...data, width, height };
}
function contentOf(d) {
  return {
    label: d.label,
    kind: d.kind,
    ...d.detail ? { detail: d.detail } : {},
    ...d.description ? { description: d.description } : {},
    ...d.notes ? { notes: d.notes } : {},
    ...d.taskIds?.length ? { taskIds: d.taskIds } : {}
  };
}
function edgeContent(d) {
  return { ...d?.label ? { label: d.label } : {}, ...d?.dashed ? { dashed: true } : {}, ...d?.arrows ? { arrows: d.arrows } : {} };
}
function graphOf(ns, es) {
  return {
    nodes: ns.map((n) => ({ id: n.id, ...contentOf(n.data) })),
    edges: es.map((e) => ({ id: e.id, source: e.source, target: e.target, ...e.data?.label ? { label: e.data.label } : {} }))
  };
}
function positionsOf(ns) {
  return new Map(ns.map((n) => [n.id, n.position]));
}
function sizesOf(ns) {
  return new Map(ns.map((n) => [n.id, { width: n.data.width, height: n.data.height }]));
}
function freeEdgeId(edges, source, target) {
  let id = `${source}->${target}`;
  for (let n = 2; edges.some((e) => e.id === id); n++) id = `${source}->${target}#${n}`;
  return id;
}
function round(p) {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
function progressOf(plan, taskIds) {
  if (!taskIds?.length) return { progress: void 0 };
  const seen = /* @__PURE__ */ new Map();
  for (const id of taskIds) {
    const task = plan.tasks.find((t) => t.id === id);
    if (!task) continue;
    seen.set(task.id, task);
    for (const d of descendants(plan, task.id)) seen.set(d.id, d);
  }
  if (seen.size === 0) return { progress: void 0 };
  return { progress: countTasks({ tasks: [...seen.values()] }) };
}
function AddMenu({ onAdd }) {
  const [open, setOpen] = useState13(false);
  return /* @__PURE__ */ jsxs17("div", { className: "add-menu", children: [
    /* @__PURE__ */ jsx18("button", { type: "button", className: "btn btn-sm btn-primary", "aria-expanded": open, onClick: () => setOpen((v) => !v), title: "Or double-click empty canvas", children: "+ Box" }),
    open && /* @__PURE__ */ jsx18("div", { className: "add-menu-list", role: "menu", children: NODE_KINDS.map((k) => /* @__PURE__ */ jsxs17(
      "button",
      {
        type: "button",
        role: "menuitem",
        className: "add-menu-item",
        onClick: () => {
          setOpen(false);
          onAdd(k);
        },
        children: [
          /* @__PURE__ */ jsx18("span", { className: classNames("kind-swatch", `kind-${k}`), "aria-hidden": "true", children: KIND_GLYPH[k] }),
          KIND_LABEL[k]
        ]
      },
      k
    )) })
  ] });
}
var nodeTypes, edgeTypes, lastClip, FIT;
var init_FlowCanvas = __esm({
  "src/ui/components/FlowCanvas.tsx"() {
    "use strict";
    init_store();
    init_layout();
    init_geometry();
    init_clipboard();
    init_theme();
    init_format();
    init_plan();
    init_types();
    init_PlanNode();
    init_PlanEdge();
    init_Panels();
    init_shared();
    nodeTypes = { plan: PlanNode };
    edgeTypes = { plan: PlanEdge };
    lastClip = null;
    FIT = { padding: 0.14, maxZoom: 1, minZoom: 0.4, duration: 0 };
  }
});

// src/shared/architecture.ts
function diagramToMarkdown(diagram, opts = {}) {
  const ids = opts.ids ?? true;
  const hashes = "#".repeat(Math.min(6, Math.max(1, opts.level ?? 3)));
  const out = [`${hashes} ${ids ? `[${diagram.id}] ` : ""}${diagram.title}`];
  if (opts.note) out.push(`_${opts.note}_`);
  if (diagram.caption?.trim()) out.push("", diagram.caption.trim());
  const nodes = diagram.nodes;
  if (nodes.length === 0) {
    out.push("", "_No parts yet._");
    return out.join("\n");
  }
  const label = labeller(diagram);
  const ref = (n) => ids ? `${n.label} (\`${n.id}\`)` : n.label;
  const { ordered, notes, isolated } = flowOrder(diagram);
  const shape = shapeOf(diagram, ordered);
  if (shape) out.push("", shape);
  if (ordered.length) {
    out.push("", "**Parts**");
    for (const n of ordered) out.push(...renderPart(n, opts, ids));
  }
  if (isolated.length) {
    out.push("", `_Not connected to anything yet: ${isolated.map((n) => n.label).join(", ")}._`);
  }
  if (diagram.edges.length) {
    out.push("", "**Connections**");
    const rank = new Map(ordered.map((n, i) => [n.id, i]));
    const edges = [...diagram.edges].sort(
      (a, b) => (rank.get(a.source) ?? 1e9) - (rank.get(b.source) ?? 1e9) || (rank.get(a.target) ?? 1e9) - (rank.get(b.target) ?? 1e9)
    );
    for (const e of edges) out.push(`- ${edgePhrase(e, label)}${ids ? ` \`${e.source} ${ARROW[e.arrows ?? "end"]} ${e.target}\`` : ""}`);
  }
  if (notes.length) {
    out.push("", "**Notes on the diagram**");
    for (const n of notes) {
      out.push(`- ${ref(n)}`);
      for (const text of [n.detail, n.description, n.notes]) if (text?.trim()) out.push(...indent(text, 2));
    }
  }
  return out.join("\n");
}
function renderPart(n, opts, ids) {
  const head = `- **${n.label}**${ids ? ` \`${n.id}\`` : ""} \u2014 ${KIND_NOUN[n.kind]}${n.detail ? `: ${oneLine(n.detail)}` : ""}`;
  const lines = [head];
  if (n.description?.trim()) lines.push(...indent(n.description, 2));
  if (n.notes?.trim()) lines.push("  Decisions:", ...indent(n.notes, 4));
  if (n.taskIds?.length) {
    const named = n.taskIds.map((id) => {
      const task = opts.tasks?.find((t) => t.id === id);
      if (!task) return ids ? id : null;
      return `${STATUS_MARK[task.status]} ${ids ? `${id} ` : ""}${task.title}`;
    });
    const list = named.filter(Boolean);
    if (list.length) lines.push(`  Built by: ${list.join("; ")}`);
  }
  return lines;
}
function edgePhrase(e, label) {
  const flags = [e.dashed ? "dashed: optional, async or future" : "", e.arrows === "none" ? "no direction" : ""].filter(Boolean);
  return `${label(e.source)} ${ARROW[e.arrows ?? "end"]} ${label(e.target)}${e.label ? `: ${oneLine(e.label)}` : ""}${flags.length ? ` (${flags.join("; ")})` : ""}`;
}
function shapeOf(diagram, ordered) {
  const incoming = /* @__PURE__ */ new Set();
  const outgoing = /* @__PURE__ */ new Set();
  for (const e of diagram.edges) {
    if (e.source === e.target) continue;
    outgoing.add(e.source);
    incoming.add(e.target);
    if (e.arrows === "both" || e.arrows === "none") {
      outgoing.add(e.target);
      incoming.add(e.source);
    }
  }
  const names = (pick) => ordered.filter(pick).map((n) => n.label);
  const parts = [
    ["Entry points", names((n) => outgoing.has(n.id) && !incoming.has(n.id))],
    ["Data stores", names((n) => n.kind === "datastore")],
    ["Queues", names((n) => n.kind === "queue")],
    ["External systems", names((n) => n.kind === "external")]
  ];
  const said = parts.filter(([, list]) => list.length).map(([what, list]) => `${what}: ${list.join(", ")}.`);
  return said.length ? said.join(" ") : null;
}
function flowOrder(diagram) {
  const ranks = flowRanks(diagram.nodes, diagram.edges);
  const index = new Map(diagram.nodes.map((n, i) => [n.id, i]));
  const parts = diagram.nodes.filter((n) => n.kind !== "note");
  const connected = parts.filter((n) => ranks.has(n.id)).sort((a, b) => ranks.get(a.id) - ranks.get(b.id) || index.get(a.id) - index.get(b.id));
  const isolated = parts.filter((n) => !ranks.has(n.id));
  return { ordered: [...connected, ...isolated], notes: diagram.nodes.filter((n) => n.kind === "note"), isolated };
}
function labeller(diagram) {
  const names = new Map(diagram.nodes.map((n) => [n.id, n.label]));
  return (id) => names.get(id) ?? id;
}
function indent(text, by) {
  const pad = " ".repeat(by);
  return text.trim().split("\n").map((line) => line.trim() ? `${pad}${line.trimEnd()}` : "");
}
function oneLine(text) {
  return text.replace(/\s*\n\s*/g, " ").trim();
}
var KIND_NOUN, STATUS_MARK, ARROW;
var init_architecture = __esm({
  "src/shared/architecture.ts"() {
    "use strict";
    init_plan();
    KIND_NOUN = {
      component: "component",
      service: "service",
      datastore: "data store",
      queue: "queue",
      external: "external system",
      actor: "actor",
      note: "note"
    };
    STATUS_MARK = { todo: "[ ]", in_progress: "[~]", blocked: "[!]", done: "[x]" };
    ARROW = { end: "\u2192", both: "\u2194", none: "\u2014" };
  }
});

// src/ui/views/DiagramsView.tsx
import { useState as useState14 } from "react";
import { jsx as jsx19, jsxs as jsxs18 } from "react/jsx-runtime";
function DiagramsView() {
  const plan = usePlan();
  const chosen = useStore((s) => s.diagramId);
  const sessionId = useStore((s) => s.sessionId);
  if (!plan) return null;
  const diagram = plan.diagrams.find((d) => d.id === chosen) ?? plan.diagrams[0] ?? null;
  return /* @__PURE__ */ jsxs18("div", { className: "arch", children: [
    /* @__PURE__ */ jsxs18("div", { className: "arch-bar", children: [
      /* @__PURE__ */ jsx19("nav", { className: "arch-tabs", "aria-label": "Diagrams", children: plan.diagrams.map((d) => /* @__PURE__ */ jsxs18(
        "button",
        {
          type: "button",
          className: classNames("arch-tab", d.id === diagram?.id && "is-active"),
          "aria-current": d.id === diagram?.id ? "true" : void 0,
          onClick: () => store.set({ diagramId: d.id }),
          children: [
            d.title,
            /* @__PURE__ */ jsx19("span", { className: "arch-tab-count", children: d.nodes.length })
          ]
        },
        d.id
      )) }),
      /* @__PURE__ */ jsx19(NewDiagram, {}),
      /* @__PURE__ */ jsx19("span", { className: "spacer" }),
      /* @__PURE__ */ jsxs18("p", { className: "toolbar-hint", children: [
        "Double-click to add a box \xB7 drag from a box's edge to connect \xB7 \u24D8 for a summary \xB7 ",
        /* @__PURE__ */ jsx19("kbd", { children: "\u2318C" }),
        " ",
        /* @__PURE__ */ jsx19("kbd", { children: "\u2318V" }),
        " copy and paste \xB7",
        " ",
        /* @__PURE__ */ jsx19("kbd", { children: "\u232B" }),
        " deletes"
      ] })
    ] }),
    diagram ? /* @__PURE__ */ jsx19(
      DiagramEditor,
      {
        diagram,
        plan,
        onSave: async (patch) => {
          const plan2 = await store.commit([{ op: "upsert_diagram", id: diagram.id, ...patch }], sessionId);
          return plan2?.diagrams.find((d) => d.id === diagram.id)?.rev ?? null;
        },
        aside: /* @__PURE__ */ jsx19(DiagramPanel, { plan, diagram })
      },
      `${sessionId}:${diagram.id}`
    ) : /* @__PURE__ */ jsx19("div", { className: "view-pad", children: /* @__PURE__ */ jsx19(
      EmptyState,
      {
        title: "No diagrams yet",
        hint: "Ask Claude to draw the architecture \u2014 components, data flow, boundaries \u2014 or start one from a template."
      }
    ) })
  ] });
}
function NewDiagram() {
  const [open, setOpen] = useState14(false);
  const add = async (t) => {
    setOpen(false);
    const before = new Set(store.getState().session?.plan?.diagrams.map((d) => d.id));
    if (await store.op({ op: "upsert_diagram", title: t.title, nodes: t.nodes, edges: t.edges })) {
      const made = store.getState().session?.plan?.diagrams.find((d) => !before.has(d.id));
      if (made) store.set({ diagramId: made.id });
    }
  };
  return /* @__PURE__ */ jsxs18("div", { className: "add-menu", children: [
    /* @__PURE__ */ jsx19("button", { type: "button", className: "btn btn-sm", "aria-expanded": open, onClick: () => setOpen((v) => !v), children: "+ New diagram" }),
    open && /* @__PURE__ */ jsx19("div", { className: "add-menu-list", role: "menu", children: TEMPLATES.map((t) => /* @__PURE__ */ jsx19("button", { type: "button", role: "menuitem", className: "add-menu-item", onClick: () => void add(t), children: t.label }, t.label)) })
  ] });
}
function DiagramPanel({ plan, diagram }) {
  const [confirming, setConfirming] = useState14(false);
  const index = plan.diagrams.findIndex((d) => d.id === diagram.id);
  const linked = diagram.nodes.filter((n) => n.taskIds?.length).length;
  return /* @__PURE__ */ jsxs18("div", { className: "arch-panel-body", "aria-label": `About ${diagram.title}`, children: [
    /* @__PURE__ */ jsxs18("header", { className: "panel-top", children: [
      /* @__PURE__ */ jsx19("span", { className: "panel-kicker", children: "Diagram" }),
      /* @__PURE__ */ jsx19("span", { className: "item-id", children: diagram.id }),
      /* @__PURE__ */ jsx19("span", { className: "spacer" }),
      /* @__PURE__ */ jsxs18("span", { className: "muted panel-meta", children: [
        diagram.updatedBy === "user" ? "edited by you" : "by Claude",
        " \xB7 ",
        relativeTime(diagram.updatedAt)
      ] })
    ] }),
    /* @__PURE__ */ jsx19(
      InlineText,
      {
        as: "h2",
        className: "panel-title",
        value: diagram.title,
        label: "Diagram title",
        onSave: (title) => store.op({ op: "upsert_diagram", id: diagram.id, title })
      }
    ),
    /* @__PURE__ */ jsx19(
      MarkdownField,
      {
        value: diagram.caption ?? "",
        label: `caption of "${diagram.title}"`,
        placeholder: "What this diagram shows.",
        emptyAction: "Describe it",
        rows: 3,
        onSave: (caption) => store.op({ op: "upsert_diagram", id: diagram.id, caption })
      }
    ),
    /* @__PURE__ */ jsxs18("p", { className: "panel-hint", children: [
      diagram.nodes.length,
      " boxes, ",
      diagram.edges.length,
      " arrows",
      linked ? `, ${linked} tracking tasks` : "",
      ". Select a box to edit its details, decisions and the tasks that build it."
    ] }),
    /* @__PURE__ */ jsx19("div", { className: "row-actions", children: /* @__PURE__ */ jsx19(
      "button",
      {
        type: "button",
        className: "btn btn-sm",
        title: "The diagram as Claude reads it: every part, what it does and what was decided, then every connection",
        onClick: () => {
          const text = diagramToMarkdown(diagram, { tasks: plan.tasks });
          void navigator.clipboard?.writeText(text).then(() => store.toast("success", "Copied the diagram as Markdown.")).catch(() => store.toast("error", "The browser would not let the page use the clipboard."));
        },
        children: "Copy as Markdown"
      }
    ) }),
    /* @__PURE__ */ jsx19("ul", { className: "kind-legend", "aria-label": "Box kinds", children: NODE_KINDS.map((k) => /* @__PURE__ */ jsxs18("li", { children: [
      /* @__PURE__ */ jsx19("span", { className: classNames("kind-swatch", `kind-${k}`), "aria-hidden": "true", children: KIND_GLYPH[k] }),
      KIND_LABEL[k]
    ] }, k)) }),
    /* @__PURE__ */ jsxs18("div", { className: "field", children: [
      /* @__PURE__ */ jsx19("span", { className: "field-label", children: "Comments" }),
      /* @__PURE__ */ jsx19(ThreadPanel, { target: { kind: "diagram", id: diagram.id }, label: diagram.title })
    ] }),
    /* @__PURE__ */ jsxs18("footer", { className: "panel-foot", children: [
      /* @__PURE__ */ jsx19("button", { type: "button", className: "link", disabled: index <= 0, onClick: () => void store.op({ op: "move_diagram", id: diagram.id, index: index - 1 }), children: "Move left" }),
      /* @__PURE__ */ jsx19(
        "button",
        {
          type: "button",
          className: "link",
          disabled: index >= plan.diagrams.length - 1,
          onClick: () => void store.op({ op: "move_diagram", id: diagram.id, index: index + 1 }),
          children: "Move right"
        }
      ),
      /* @__PURE__ */ jsx19("span", { className: "spacer" }),
      confirming ? /* @__PURE__ */ jsxs18("span", { className: "item-confirm", children: [
        "Remove?",
        /* @__PURE__ */ jsx19("button", { type: "button", className: "link is-danger", onClick: () => void store.op({ op: "remove", kind: "diagram", id: diagram.id }), children: "Remove" }),
        /* @__PURE__ */ jsx19("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
      ] }) : /* @__PURE__ */ jsx19("button", { type: "button", className: "link is-danger", onClick: () => setConfirming(true), children: "Remove diagram" })
    ] })
  ] });
}
var TEMPLATES;
var init_DiagramsView = __esm({
  "src/ui/views/DiagramsView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Threads();
    init_FlowCanvas();
    init_primitives();
    init_format();
    init_architecture();
    init_types();
    TEMPLATES = [
      { label: "Blank", title: "New diagram", nodes: [], edges: [] },
      {
        label: "Components",
        title: "Components",
        nodes: [
          { id: "client", label: "Client", kind: "actor", description: "Whoever calls the API: a browser, an app, another service." },
          { id: "api", label: "API", kind: "service", description: "Takes requests, applies the rules, and reads and writes the database." },
          { id: "db", label: "Database", kind: "datastore", description: "The system of record." }
        ],
        edges: [
          { source: "client", target: "api", label: "HTTPS" },
          { source: "api", target: "db", label: "reads / writes" }
        ]
      },
      {
        label: "Pipeline",
        title: "Data flow",
        nodes: [
          { id: "source", label: "Source", kind: "external" },
          { id: "queue", label: "Queue", kind: "queue" },
          { id: "worker", label: "Worker", kind: "service" },
          { id: "store", label: "Store", kind: "datastore" }
        ],
        edges: [
          { source: "source", target: "queue", label: "events" },
          { source: "queue", target: "worker" },
          { source: "worker", target: "store" }
        ]
      }
    ];
  }
});

// src/ui/views/TasksView.tsx
import { useMemo as useMemo3, useState as useState15 } from "react";
import { Fragment as Fragment4, jsx as jsx20, jsxs as jsxs19 } from "react/jsx-runtime";
function TasksView() {
  const plan = usePlan();
  const mode = useStore((s) => s.taskMode);
  const hideDone = useStore((s) => s.hideDone);
  if (!plan) return null;
  const counts = countTasks(plan);
  return /* @__PURE__ */ jsxs19("div", { className: "view-pad", children: [
    /* @__PURE__ */ jsxs19("div", { className: "toolbar", children: [
      /* @__PURE__ */ jsxs19("div", { className: "segmented", role: "group", "aria-label": "Task layout", children: [
        /* @__PURE__ */ jsx20("button", { type: "button", className: classNames("seg", mode === "outline" && "is-active"), "aria-pressed": mode === "outline", onClick: () => store.setTaskMode("outline"), children: "Outline" }),
        /* @__PURE__ */ jsx20("button", { type: "button", className: classNames("seg", mode === "board" && "is-active"), "aria-pressed": mode === "board", onClick: () => store.setTaskMode("board"), children: "Board" })
      ] }),
      mode === "outline" && /* @__PURE__ */ jsxs19("label", { className: "toggle", children: [
        /* @__PURE__ */ jsx20("input", { type: "checkbox", checked: hideDone, onChange: () => store.toggleHideDone() }),
        "Hide done"
      ] }),
      /* @__PURE__ */ jsx20("span", { className: "spacer" }),
      /* @__PURE__ */ jsxs19("span", { className: "toolbar-progress", children: [
        /* @__PURE__ */ jsx20(ProgressBar, { counts }),
        /* @__PURE__ */ jsxs19("span", { className: "muted", children: [
          counts.done,
          "/",
          counts.total,
          " done"
        ] })
      ] })
    ] }),
    plan.tasks.length === 0 ? /* @__PURE__ */ jsxs19(Fragment4, { children: [
      /* @__PURE__ */ jsx20(EmptyState, { title: "No tasks yet", hint: "Break the work down here, or ask Claude to publish a task tree with the plan." }),
      /* @__PURE__ */ jsx20(AddField, { placeholder: "Add a task\u2026", label: "New task", onAdd: (title) => store.op({ op: "upsert_task", title }) })
    ] }) : mode === "outline" ? /* @__PURE__ */ jsx20(Outline, { plan, hideDone }) : /* @__PURE__ */ jsx20(Board, { plan })
  ] });
}
function Outline({ plan, hideDone }) {
  const collapsed = useStore((s) => s.collapsedTasks);
  const [dragging, setDragging] = useState15(null);
  const [hint, setHint] = useState15(null);
  const [expanded, setExpanded] = useState15(null);
  const [addingUnder, setAddingUnder] = useState15(null);
  const partsByTask = useMemo3(() => {
    const map = /* @__PURE__ */ new Map();
    for (const d of plan.diagrams) {
      for (const n of d.nodes) {
        for (const t of n.taskIds ?? []) map.set(t, [...map.get(t) ?? [], { d, n }]);
      }
    }
    return map;
  }, [plan.diagrams]);
  const rows = useMemo3(() => {
    const hidden = /* @__PURE__ */ new Set();
    for (const id of collapsed) for (const d of descendants(plan, id)) hidden.add(d.id);
    return outline(plan).filter(({ task }) => !hidden.has(task.id) && !(hideDone && task.status === "done" && !hasChildren(plan, task.id)));
  }, [plan, collapsed, hideDone]);
  const dropOp = (draggedId, target, zone) => {
    if (draggedId === target.id || descendants(plan, draggedId).some((d) => d.id === target.id)) return null;
    if (zone === "inside") return { op: "move_task", id: draggedId, parentId: target.id, index: Number.MAX_SAFE_INTEGER };
    const siblings = childrenOf(plan, target.parentId).filter((t) => t.id !== draggedId);
    const at = siblings.findIndex((t) => t.id === target.id);
    return { op: "move_task", id: draggedId, parentId: target.parentId, index: zone === "before" ? at : at + 1 };
  };
  const onDragOver = (e, target) => {
    if (!dragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    const zone = y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
    if (!dropOp(dragging, target, zone)) {
      setHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (hint?.id !== target.id || hint.zone !== zone) setHint({ id: target.id, zone });
  };
  const onDrop = (e, target) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_TYPE) || dragging;
    const zone = hint?.id === target.id ? hint.zone : null;
    setHint(null);
    setDragging(null);
    if (!id || !zone) return;
    const op = dropOp(id, target, zone);
    if (!op) return;
    if (zone === "inside" && collapsed.includes(target.id)) store.toggleTaskCollapsed(target.id);
    void store.op(op);
  };
  return /* @__PURE__ */ jsxs19("div", { className: "task-outline", children: [
    /* @__PURE__ */ jsx20("div", { className: "outline-rows", role: "tree", "aria-label": "Task tree", children: rows.map(({ task, depth, number }) => /* @__PURE__ */ jsx20(
      TaskRow,
      {
        plan,
        task,
        depth,
        number,
        expanded: expanded === task.id,
        onToggleExpanded: () => setExpanded((cur) => cur === task.id ? null : task.id),
        dragging: dragging === task.id,
        dropZone: hint?.id === task.id ? hint.zone : null,
        onDragStart: (e) => {
          e.dataTransfer.setData(DRAG_TYPE, task.id);
          e.dataTransfer.setData("text/plain", task.title);
          e.dataTransfer.effectAllowed = "move";
          setDragging(task.id);
        },
        onDragEnd: () => {
          setDragging(null);
          setHint(null);
        },
        onDragOver: (e) => onDragOver(e, task),
        onDragLeave: () => setHint((h) => h?.id === task.id ? null : h),
        onDrop: (e) => onDrop(e, task),
        addingSubtask: addingUnder === task.id,
        onAddSubtask: () => setAddingUnder(task.id),
        onCloseAdd: () => setAddingUnder(null),
        parts: partsByTask.get(task.id) ?? NO_PARTS
      },
      task.id
    )) }),
    /* @__PURE__ */ jsx20(AddField, { placeholder: "Add a top-level task\u2026", label: "New top-level task", onAdd: (title) => store.op({ op: "upsert_task", title }) }),
    /* @__PURE__ */ jsx20("p", { className: "outline-help muted", children: "Drag a row onto another to nest it, or to its top or bottom edge to place it beside. With a row focused: Alt+\u2191/\u2193 reorders, Alt+\u2192 nests under the row above, Alt+\u2190 moves it out a level." })
  ] });
}
function TaskRow(props) {
  const { plan, task, depth, number, expanded } = props;
  const collapsed = useStore((s) => s.collapsedTasks.includes(task.id));
  const [comments, setComments] = useState15(false);
  const kids = childrenOf(plan, task.id);
  const sub = kids.length ? countTasks({ tasks: [task, ...descendants(plan, task.id)] }) : null;
  const threads = useThreads({ kind: "task", id: task.id });
  const target = { kind: "task", id: task.id };
  const parts = props.parts;
  const siblings = childrenOf(plan, task.parentId);
  const index = siblings.findIndex((t) => t.id === task.id);
  const parent = task.parentId ? plan.tasks.find((t) => t.id === task.parentId) : void 0;
  const moves = {
    up: index > 0 ? { op: "move_task", id: task.id, parentId: task.parentId, index: index - 1 } : null,
    down: index < siblings.length - 1 ? { op: "move_task", id: task.id, parentId: task.parentId, index: index + 1 } : null,
    // Nest under the sibling above, at the end of its subtasks.
    indent: index > 0 ? { op: "move_task", id: task.id, parentId: siblings[index - 1].id, index: Number.MAX_SAFE_INTEGER } : null,
    // Out one level, right after the old parent.
    outdent: parent ? {
      op: "move_task",
      id: task.id,
      parentId: parent.parentId,
      index: childrenOf(plan, parent.parentId).findIndex((t) => t.id === parent.id) + 1
    } : null
  };
  const onKeyDown = (e) => {
    if (!e.altKey || isTyping(e.target)) return;
    const op = e.key === "ArrowUp" ? moves.up : e.key === "ArrowDown" ? moves.down : e.key === "ArrowRight" ? moves.indent : e.key === "ArrowLeft" ? moves.outdent : null;
    if (!op) return;
    e.preventDefault();
    void store.op(op).then(() => {
      window.requestAnimationFrame(() => document.querySelector(`#task-${task.id} .task-line`)?.focus());
    });
  };
  return /* @__PURE__ */ jsxs19(Focusable, { kind: "task", id: task.id, as: "div", className: classNames("task", `is-${task.status}`, props.dragging && "is-dragging"), children: [
    /* @__PURE__ */ jsxs19(
      "div",
      {
        className: classNames("task-line", props.dropZone && `drop-${props.dropZone}`),
        style: { ["--depth"]: depth },
        role: "treeitem",
        "aria-level": depth + 1,
        "aria-expanded": kids.length ? !collapsed : void 0,
        "aria-label": `${number} ${task.title}, ${STATUS_LABEL[task.status]}`,
        tabIndex: 0,
        draggable: true,
        onDragStart: props.onDragStart,
        onDragEnd: props.onDragEnd,
        onDragOver: props.onDragOver,
        onDragLeave: props.onDragLeave,
        onDrop: props.onDrop,
        onKeyDown,
        children: [
          /* @__PURE__ */ jsx20("span", { className: "drag-handle", "aria-hidden": "true", title: "Drag to move", children: "\u22EE\u22EE" }),
          kids.length ? /* @__PURE__ */ jsx20(
            "button",
            {
              type: "button",
              className: "twisty",
              "aria-label": collapsed ? `Show subtasks of ${task.title}` : `Hide subtasks of ${task.title}`,
              onClick: () => store.toggleTaskCollapsed(task.id),
              children: collapsed ? "\u25B8" : "\u25BE"
            }
          ) : /* @__PURE__ */ jsx20("span", { className: "twisty is-leaf", "aria-hidden": "true" }),
          /* @__PURE__ */ jsx20(StatusDot, { task }),
          /* @__PURE__ */ jsx20("span", { className: "task-num", children: number }),
          /* @__PURE__ */ jsx20(
            InlineText,
            {
              className: "task-title",
              value: task.title,
              label: "Task title",
              onSave: (title) => store.op({ op: "upsert_task", id: task.id, title })
            }
          ),
          /* @__PURE__ */ jsxs19("span", { className: "task-badges", children: [
            sub && /* @__PURE__ */ jsxs19("span", { className: "chip", title: `${sub.done} of ${sub.total} subtasks done`, children: [
              sub.done,
              "/",
              sub.total
            ] }),
            task.note && /* @__PURE__ */ jsx20("span", { className: classNames("chip is-note", task.status === "blocked" && "is-warning"), title: task.note, children: task.note }),
            task.files?.length ? /* @__PURE__ */ jsxs19("span", { className: "chip", title: task.files.join("\n"), children: [
              task.files.length,
              " file",
              task.files.length === 1 ? "" : "s"
            ] }) : null,
            parts.map(({ d, n }) => /* @__PURE__ */ jsxs19(
              "button",
              {
                type: "button",
                className: "chip is-part",
                title: `Builds "${n.label}" in ${d.title} \u2014 show it`,
                onClick: () => store.focus("node", `${d.id}:${n.id}`),
                children: [
                  /* @__PURE__ */ jsx20("span", { "aria-hidden": "true", children: KIND_GLYPH[n.kind] }),
                  " ",
                  n.label
                ]
              },
              `${d.id}:${n.id}`
            )),
            task.createdBy === "user" && /* @__PURE__ */ jsx20("span", { className: "chip is-you", children: "added by you" })
          ] }),
          /* @__PURE__ */ jsx20("span", { className: "spacer" }),
          /* @__PURE__ */ jsxs19("span", { className: "task-actions", children: [
            /* @__PURE__ */ jsx20("button", { type: "button", className: "icon-btn is-tiny", title: "Add subtask", "aria-label": `Add a subtask to ${task.title}`, onClick: props.onAddSubtask, children: /* @__PURE__ */ jsx20("span", { "aria-hidden": "true", children: "\uFF0B" }) }),
            /* @__PURE__ */ jsx20(MoveButton, { op: moves.outdent, glyph: "\u2190", label: `Move ${task.title} out a level` }),
            /* @__PURE__ */ jsx20(MoveButton, { op: moves.indent, glyph: "\u2192", label: `Nest ${task.title} under the task above` }),
            /* @__PURE__ */ jsx20(MoveButton, { op: moves.up, glyph: "\u2191", label: `Move ${task.title} up` }),
            /* @__PURE__ */ jsx20(MoveButton, { op: moves.down, glyph: "\u2193", label: `Move ${task.title} down` })
          ] }),
          /* @__PURE__ */ jsx20(CommentToggle, { target, label: task.title, open: comments, onToggle: () => setComments((v) => !v) }),
          /* @__PURE__ */ jsx20(
            "button",
            {
              type: "button",
              className: classNames("icon-btn is-tiny", expanded && "is-active", (Boolean(task.detail) || threads.length > 0) && "has-detail"),
              "aria-expanded": expanded,
              title: "Details",
              "aria-label": `Details of ${task.title}`,
              onClick: props.onToggleExpanded,
              children: /* @__PURE__ */ jsx20("span", { "aria-hidden": "true", children: expanded ? "\u2303" : "\u2304" })
            }
          )
        ]
      }
    ),
    (expanded || comments) && /* @__PURE__ */ jsxs19("div", { className: "task-detail", style: { ["--depth"]: depth }, children: [
      expanded && /* @__PURE__ */ jsx20(TaskDetail, { plan, task }),
      comments && /* @__PURE__ */ jsx20(ThreadPanel, { target, label: task.title })
    ] }),
    props.addingSubtask && /* @__PURE__ */ jsx20("div", { className: "task-add-sub", style: { ["--depth"]: depth + 1 }, children: /* @__PURE__ */ jsx20(
      AddField,
      {
        placeholder: `Subtask of "${task.title}"\u2026`,
        label: `New subtask of ${task.title}`,
        autoFocus: true,
        onCancel: props.onCloseAdd,
        onAdd: async (title) => {
          const ok = await store.op({ op: "upsert_task", parentId: task.id, title });
          if (ok && collapsed) store.toggleTaskCollapsed(task.id);
          return ok;
        }
      }
    ) })
  ] });
}
function TaskDetail({ plan, task }) {
  const [confirming, setConfirming] = useState15(false);
  const subtasks = descendants(plan, task.id).length;
  return /* @__PURE__ */ jsxs19("div", { className: "task-detail-body", children: [
    /* @__PURE__ */ jsxs19("div", { className: "field-row", children: [
      /* @__PURE__ */ jsx20("span", { className: "field-label", children: "Status" }),
      /* @__PURE__ */ jsx20(StatusPicker, { task })
    ] }),
    /* @__PURE__ */ jsxs19("div", { className: "field-row", children: [
      /* @__PURE__ */ jsx20("span", { className: "field-label", children: "Note" }),
      /* @__PURE__ */ jsx20(
        InlineText,
        {
          className: "task-note",
          value: task.note ?? "",
          placeholder: "One line \u2014 what it's blocked on, or what was done",
          label: "Status note",
          onSave: (note) => store.op({ op: "upsert_task", id: task.id, note })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs19("div", { className: "field-col", children: [
      /* @__PURE__ */ jsx20("span", { className: "field-label", children: "Detail" }),
      /* @__PURE__ */ jsx20(
        MarkdownField,
        {
          value: task.detail ?? "",
          label: `detail of "${task.title}"`,
          placeholder: "No detail yet.",
          emptyAction: "Add approach or acceptance criteria",
          onSave: (detail) => store.op({ op: "upsert_task", id: task.id, detail })
        }
      )
    ] }),
    /* @__PURE__ */ jsxs19("div", { className: "field-col", children: [
      /* @__PURE__ */ jsx20("span", { className: "field-label", children: "Files" }),
      /* @__PURE__ */ jsx20(FilesField, { task })
    ] }),
    /* @__PURE__ */ jsxs19("div", { className: "task-detail-foot", children: [
      /* @__PURE__ */ jsxs19("span", { className: "muted", children: [
        task.id,
        " \xB7 ",
        task.createdBy === "user" ? "added by you" : "added by Claude"
      ] }),
      /* @__PURE__ */ jsx20("span", { className: "spacer" }),
      confirming ? /* @__PURE__ */ jsxs19("span", { className: "item-confirm", children: [
        "Remove",
        subtasks ? ` with ${subtasks} subtask(s)` : "",
        "?",
        /* @__PURE__ */ jsx20("button", { type: "button", className: "link is-danger", onClick: () => void store.op({ op: "remove", kind: "task", id: task.id }), children: "Remove" }),
        /* @__PURE__ */ jsx20("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
      ] }) : /* @__PURE__ */ jsx20("button", { type: "button", className: "link is-danger", onClick: () => setConfirming(true), children: "Remove task" })
    ] })
  ] });
}
function FilesField({ task }) {
  const [editing, setEditing] = useState15(false);
  const [draft, setDraft] = useState15((task.files ?? []).join("\n"));
  if (!editing) {
    return /* @__PURE__ */ jsxs19("div", { className: "files", children: [
      task.files?.length ? /* @__PURE__ */ jsx20("ul", { className: "plain-list mono", children: task.files.map((f) => /* @__PURE__ */ jsx20("li", { children: f }, f)) }) : /* @__PURE__ */ jsx20("span", { className: "muted", children: "None listed." }),
      " ",
      /* @__PURE__ */ jsx20(
        "button",
        {
          type: "button",
          className: "link",
          onClick: () => {
            setDraft((task.files ?? []).join("\n"));
            setEditing(true);
          },
          children: "Edit"
        }
      )
    ] });
  }
  return /* @__PURE__ */ jsxs19("div", { className: "md-field is-editing", children: [
    /* @__PURE__ */ jsx20("textarea", { className: "input mono", rows: 4, value: draft, "aria-label": "Files, one per line", onChange: (e) => setDraft(e.target.value) }),
    /* @__PURE__ */ jsxs19("div", { className: "md-field-foot", children: [
      /* @__PURE__ */ jsx20("span", { className: "muted", children: "One path per line" }),
      /* @__PURE__ */ jsx20("span", { className: "spacer" }),
      /* @__PURE__ */ jsx20("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: () => setEditing(false), children: "Cancel" }),
      /* @__PURE__ */ jsx20(
        "button",
        {
          type: "button",
          className: "btn btn-sm btn-primary",
          onClick: () => {
            setEditing(false);
            void store.op({ op: "upsert_task", id: task.id, files: draft.split("\n").map((f) => f.trim()).filter(Boolean) });
          },
          children: "Save"
        }
      )
    ] })
  ] });
}
function MoveButton({ op, glyph, label }) {
  return /* @__PURE__ */ jsx20("button", { type: "button", className: "icon-btn is-tiny", disabled: !op, title: label, "aria-label": label, onClick: () => op && void store.op(op), children: /* @__PURE__ */ jsx20("span", { "aria-hidden": "true", children: glyph }) });
}
function StatusDot({ task }) {
  const next = NEXT_STATUS[task.status];
  return /* @__PURE__ */ jsx20(
    "button",
    {
      type: "button",
      className: classNames("status-dot", `is-${task.status}`),
      title: `${STATUS_LABEL[task.status]} \u2014 click to mark ${STATUS_LABEL[next].toLowerCase()}`,
      "aria-label": `${task.title}: ${STATUS_LABEL[task.status]}. Mark ${STATUS_LABEL[next].toLowerCase()}`,
      onClick: () => void store.op({ op: "upsert_task", id: task.id, status: next }),
      children: /* @__PURE__ */ jsx20("span", { "aria-hidden": "true", children: STATUS_GLYPH[task.status] })
    }
  );
}
function StatusPicker({ task }) {
  return /* @__PURE__ */ jsx20("div", { className: "segmented", role: "radiogroup", "aria-label": `Status of ${task.title}`, children: TASK_STATUSES.map((s) => /* @__PURE__ */ jsx20(
    "button",
    {
      type: "button",
      role: "radio",
      "aria-checked": task.status === s,
      className: classNames("seg", `status-${s}`, task.status === s && "is-active"),
      onClick: () => void store.op({ op: "upsert_task", id: task.id, status: s }),
      children: STATUS_LABEL[s]
    },
    s
  )) });
}
function Board({ plan }) {
  const [over, setOver] = useState15(null);
  const leaves = outline(plan).map((r) => r.task).filter((t) => !hasChildren(plan, t.id));
  return /* @__PURE__ */ jsx20("div", { className: "board", children: TASK_STATUSES.map((status) => {
    const cards = leaves.filter((t) => t.status === status);
    return /* @__PURE__ */ jsxs19(
      "section",
      {
        className: classNames("board-col", `is-${status}`, over === status && "is-over"),
        "aria-label": STATUS_LABEL[status],
        onDragOver: (e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setOver(status);
        },
        onDragLeave: () => setOver((cur) => cur === status ? null : cur),
        onDrop: (e) => {
          e.preventDefault();
          setOver(null);
          const id = e.dataTransfer.getData(DRAG_TYPE);
          const task = plan.tasks.find((t) => t.id === id);
          if (task && task.status !== status) void store.op({ op: "upsert_task", id, status });
        },
        children: [
          /* @__PURE__ */ jsxs19("header", { className: "board-col-head", children: [
            /* @__PURE__ */ jsx20("span", { className: classNames("status-dot is-static", `is-${status}`), "aria-hidden": "true", children: STATUS_GLYPH[status] }),
            /* @__PURE__ */ jsx20("h2", { children: STATUS_LABEL[status] }),
            /* @__PURE__ */ jsx20("span", { className: "board-count", children: cards.length })
          ] }),
          /* @__PURE__ */ jsxs19("div", { className: "board-cards", children: [
            cards.map((task) => /* @__PURE__ */ jsx20(BoardCard, { plan, task }, task.id)),
            cards.length === 0 && /* @__PURE__ */ jsx20("p", { className: "board-empty", children: "Drop tasks here" })
          ] })
        ]
      },
      status
    );
  }) });
}
function BoardCard({ plan, task }) {
  const path = [];
  let cursor = task.parentId ? plan.tasks.find((t) => t.id === task.parentId) : void 0;
  while (cursor) {
    path.unshift(cursor.title);
    cursor = cursor.parentId ? plan.tasks.find((t) => t.id === cursor.parentId) : void 0;
  }
  const comments = plan.threads.filter((t) => !t.resolved && t.target.kind === "task" && t.target.id === task.id).length;
  return /* @__PURE__ */ jsxs19(
    "article",
    {
      className: classNames("board-card", `is-${task.status}`),
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData(DRAG_TYPE, task.id);
        e.dataTransfer.setData("text/plain", task.title);
        e.dataTransfer.effectAllowed = "move";
      },
      children: [
        path.length > 0 && /* @__PURE__ */ jsx20("p", { className: "board-path", children: path.join(" \u203A ") }),
        /* @__PURE__ */ jsx20("button", { type: "button", className: "board-title", onClick: () => store.focus("task", task.id), children: task.title }),
        task.note && /* @__PURE__ */ jsx20("p", { className: "board-note", children: task.note }),
        /* @__PURE__ */ jsxs19("footer", { className: "board-foot", children: [
          /* @__PURE__ */ jsx20("span", { className: "item-id", children: task.id }),
          comments > 0 && /* @__PURE__ */ jsxs19("span", { className: "chip", children: [
            "\u{1F4AC} ",
            comments
          ] }),
          /* @__PURE__ */ jsx20("span", { className: "spacer" }),
          /* @__PURE__ */ jsxs19("label", { className: "sr-only", htmlFor: `status-${task.id}`, children: [
            "Status of ",
            task.title
          ] }),
          /* @__PURE__ */ jsx20(
            "select",
            {
              id: `status-${task.id}`,
              className: "board-status",
              value: task.status,
              onChange: (e) => void store.op({ op: "upsert_task", id: task.id, status: e.target.value }),
              children: TASK_STATUSES.map((s) => /* @__PURE__ */ jsx20("option", { value: s, children: STATUS_LABEL[s] }, s))
            }
          )
        ] })
      ]
    }
  );
}
function hasChildren(plan, id) {
  return plan.tasks.some((t) => t.parentId === id);
}
function isTyping(target) {
  const el = target;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
}
var NEXT_STATUS, NO_PARTS, DRAG_TYPE;
var init_TasksView = __esm({
  "src/ui/views/TasksView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Threads();
    init_Item();
    init_FlowCanvas();
    init_Progress();
    init_primitives();
    init_format();
    init_plan();
    init_types();
    NEXT_STATUS = {
      todo: "in_progress",
      in_progress: "done",
      blocked: "in_progress",
      done: "todo"
    };
    NO_PARTS = [];
    DRAG_TYPE = "application/x-harness-task";
  }
});

// src/ui/App.tsx
var App_exports = {};
__export(App_exports, {
  App: () => App
});
import { useCallback as useCallback2, useEffect as useEffect12, useRef as useRef7 } from "react";
import { Fragment as Fragment5, jsx as jsx21, jsxs as jsxs20 } from "react/jsx-runtime";
function App() {
  const session = useSession();
  const sessionId = useStore((s) => s.sessionId);
  const tab = useStore((s) => s.tab);
  const error = useStore((s) => s.error);
  const sidebarCollapsed = useStore((s) => s.collapsedSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const tabs = useRef7(null);
  const plan = session?.plan ?? null;
  useDocumentTitle(session);
  useShortcuts();
  useDrawerDismiss(drawerOpen);
  const onTabKeyDown = useCallback2(
    (event) => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      let next;
      if (delta !== 0) next = TAB_IDS[(TAB_IDS.indexOf(tab) + delta + TAB_IDS.length) % TAB_IDS.length];
      else if (event.key === "Home") next = TAB_IDS[0];
      else if (event.key === "End") next = TAB_IDS[TAB_IDS.length - 1];
      if (!next) return;
      event.preventDefault();
      store.setTab(next);
      tabs.current?.querySelector(`#${tabId(next)}`)?.focus();
    },
    [tab]
  );
  return /* @__PURE__ */ jsxs20("div", { className: classNames("app", sidebarCollapsed && "is-sidebar-collapsed", drawerOpen && "is-drawer-open"), children: [
    /* @__PURE__ */ jsx21("a", { className: "skip-link", href: `#${panelId(tab)}`, children: "Skip to content" }),
    /* @__PURE__ */ jsx21(Sidebar, {}),
    drawerOpen && /* @__PURE__ */ jsx21("button", { type: "button", className: "scrim", "aria-label": "Close the session list", onClick: () => store.setDrawer(false) }),
    /* @__PURE__ */ jsx21("main", { className: "main", "aria-label": "Plan", children: !sessionId ? /* @__PURE__ */ jsx21(NoSession, { error }) : !session ? error ? /* @__PURE__ */ jsx21(SessionUnavailable, { error }) : /* @__PURE__ */ jsx21(Loading, {}) : /* @__PURE__ */ jsxs20(Fragment5, { children: [
      /* @__PURE__ */ jsx21(Header, { session }),
      /* @__PURE__ */ jsx21(ConnectionBar, {}),
      /* @__PURE__ */ jsx21(WaitingBanner, { session }),
      !plan ? /* @__PURE__ */ jsx21(NoPlan, { session }) : /* @__PURE__ */ jsxs20(Fragment5, { children: [
        /* @__PURE__ */ jsx21("nav", { className: "tabs", role: "tablist", "aria-label": "Plan views", ref: tabs, onKeyDown: onTabKeyDown, children: TAB_IDS.map((t) => /* @__PURE__ */ jsx21(TabButton, { id: t, active: tab === t, plan }, t)) }),
        /* @__PURE__ */ jsx21("div", { className: "view", id: panelId(tab), role: "tabpanel", "aria-labelledby": tabId(tab), tabIndex: -1, children: /* @__PURE__ */ jsxs20(ErrorBoundary, { label: `${TAB_LABEL[tab]} view`, resetKey: `${sessionId}:${tab}`, children: [
          tab === "overview" && /* @__PURE__ */ jsx21(OverviewView, {}),
          tab === "diagrams" && /* @__PURE__ */ jsx21(DiagramsView, {}),
          tab === "tasks" && /* @__PURE__ */ jsx21(TasksView, {})
        ] }) }, tab)
      ] })
    ] }) }),
    /* @__PURE__ */ jsx21(Toasts, {})
  ] });
}
function TabButton({ id, active, plan }) {
  const badge = tabBadge(id, plan);
  return /* @__PURE__ */ jsxs20(
    "button",
    {
      type: "button",
      role: "tab",
      id: tabId(id),
      "aria-selected": active,
      "aria-controls": panelId(id),
      tabIndex: active ? 0 : -1,
      className: classNames("tab", active && "is-active"),
      onClick: () => store.setTab(id),
      children: [
        TAB_LABEL[id],
        badge && /* @__PURE__ */ jsxs20(Fragment5, { children: [
          /* @__PURE__ */ jsx21("span", { className: classNames("tab-badge", `is-${badge.tone}`), "aria-hidden": "true", children: badge.text }),
          /* @__PURE__ */ jsx21("span", { className: "sr-only", children: badge.label })
        ] })
      ]
    }
  );
}
function tabBadge(id, plan) {
  switch (id) {
    case "diagrams":
      return plan.diagrams.length ? { text: String(plan.diagrams.length), tone: "neutral", label: `${plan.diagrams.length} diagrams` } : null;
    case "tasks": {
      const c = countTasks(plan);
      return c.total ? { text: `${c.done}/${c.total}`, tone: "neutral", label: `${c.done} of ${c.total} done` } : null;
    }
    default:
      return null;
  }
}
function Header({ session }) {
  const saving = useStore((s) => s.saving);
  const plan = session.plan;
  const counts = countTasks(plan);
  return /* @__PURE__ */ jsxs20("header", { className: "head", children: [
    /* @__PURE__ */ jsxs20("div", { className: "head-main", children: [
      /* @__PURE__ */ jsx21(SessionsToggle, {}),
      plan ? /* @__PURE__ */ jsx21(
        InlineText,
        {
          as: "h1",
          className: "head-title",
          value: plan.title,
          label: "Plan title",
          onSave: (title) => store.op({ op: "set_meta", title })
        }
      ) : /* @__PURE__ */ jsx21("h1", { className: "head-title", children: session.title }),
      saving > 0 && /* @__PURE__ */ jsx21("span", { className: "muted head-saving", children: "saving\u2026" }),
      /* @__PURE__ */ jsx21("span", { className: "spacer" }),
      /* @__PURE__ */ jsx21(Handoff, {}),
      /* @__PURE__ */ jsx21(ThemeToggle, {})
    ] }),
    /* @__PURE__ */ jsxs20("div", { className: "head-meta", children: [
      /* @__PURE__ */ jsx21("span", { className: classNames("head-status", `is-${session.waiting ? "waiting" : session.status}`), title: "The Claude session this plan belongs to", children: session.waiting ? "Claude is waiting on you" : session.status === "active" ? "Claude is working" : session.status === "idle" ? "Claude is idle" : "session ended" }),
      plan && plan.title !== session.title && /* @__PURE__ */ jsx21("span", { className: "head-stat", children: session.title }),
      session.branch && /* @__PURE__ */ jsx21("code", { className: "head-branch", children: session.branch }),
      counts.total > 0 && /* @__PURE__ */ jsxs20("span", { className: "head-progress", children: [
        /* @__PURE__ */ jsx21(ProgressBar, { counts, compact: true }),
        /* @__PURE__ */ jsxs20("span", { className: "head-stat", children: [
          counts.done,
          "/",
          counts.total,
          " tasks"
        ] })
      ] }),
      /* @__PURE__ */ jsx21("span", { className: "head-path", title: session.cwd, children: session.cwd })
    ] })
  ] });
}
function SessionsToggle() {
  const collapsed = useStore((s) => s.collapsedSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const narrow = () => window.innerWidth <= 900;
  const label = collapsed ? "Show sessions" : "Hide sessions";
  return /* @__PURE__ */ jsx21(
    "button",
    {
      type: "button",
      className: "icon-btn sessions-toggle",
      title: `${label} ( [ )`,
      "aria-label": label,
      "aria-expanded": narrow() ? drawerOpen : !collapsed,
      onClick: () => narrow() ? store.setDrawer(true) : store.toggleSidebar(),
      children: /* @__PURE__ */ jsx21("span", { "aria-hidden": "true", children: "\u2630" })
    }
  );
}
function NoPlan({ session }) {
  return /* @__PURE__ */ jsx21("div", { className: "view", children: /* @__PURE__ */ jsx21(
    EmptyState,
    {
      title: "No plan yet",
      hint: /* @__PURE__ */ jsxs20(Fragment5, { children: [
        "In Claude's chat, run ",
        /* @__PURE__ */ jsx21("code", { children: "/harness <what you want to build>" }),
        ". Claude investigates the code, then publishes its plan here \u2014 the architecture, diagrams and a task breakdown \u2014 and asks what it needs to know in the chat."
      ] }),
      action: /* @__PURE__ */ jsx21("button", { type: "button", className: "btn", onClick: () => void store.op({ op: "set_meta", title: session.title || "Untitled plan" }), children: "Start a plan by hand" })
    }
  ) });
}
function Loading() {
  return /* @__PURE__ */ jsx21("div", { className: "view", children: /* @__PURE__ */ jsxs20("div", { className: "loading", role: "status", "aria-live": "polite", children: [
    /* @__PURE__ */ jsx21("span", { className: "spinner", "aria-hidden": "true" }),
    "Loading the plan\u2026"
  ] }) });
}
function SessionUnavailable({ error }) {
  const sessions = useStore((s) => s.sessions);
  const unauthorized = /401|unauthorized/i.test(error);
  const other = sessions[0];
  return /* @__PURE__ */ jsx21("div", { className: "view", children: /* @__PURE__ */ jsx21(
    EmptyState,
    {
      title: unauthorized ? "This page is not signed in to the harness" : "This session is not available",
      hint: unauthorized ? /* @__PURE__ */ jsxs20(Fragment5, { children: [
        "Open the harness with ",
        /* @__PURE__ */ jsx21("code", { children: "/harness-open" }),
        " in Claude, or ",
        /* @__PURE__ */ jsx21("code", { children: "harness open" }),
        " in a terminal \u2014 the link it prints carries the key this page needs."
      ] }) : /* @__PURE__ */ jsxs20(Fragment5, { children: [
        "It may have been deleted, or it ended long enough ago to be cleaned up. (",
        error,
        ")"
      ] }),
      action: !unauthorized && other ? /* @__PURE__ */ jsxs20("button", { type: "button", className: "btn", onClick: () => void store.selectSession(other.sessionId), children: [
        "Open ",
        other.planTitle ?? other.title
      ] }) : void 0
    }
  ) });
}
function NoSession({ error }) {
  if (error && /401|unauthorized/i.test(error)) return /* @__PURE__ */ jsx21(SessionUnavailable, { error });
  return /* @__PURE__ */ jsx21("div", { className: "view", children: /* @__PURE__ */ jsx21(
    EmptyState,
    {
      title: "No session yet",
      hint: /* @__PURE__ */ jsxs20(Fragment5, { children: [
        "Start Claude Code in a project with the harness enabled, then run ",
        /* @__PURE__ */ jsx21("code", { children: "/harness" }),
        ". Sessions appear here the moment they register.",
        error && /* @__PURE__ */ jsxs20("span", { className: "error-text", children: [
          " \xB7 ",
          error
        ] })
      ] }),
      action: /* @__PURE__ */ jsxs20("p", { className: "empty-hint", children: [
        "If a session is running and nothing shows up, the hooks are not firing \u2014 run ",
        /* @__PURE__ */ jsx21("code", { children: "harness doctor" }),
        "."
      ] })
    }
  ) });
}
function useDocumentTitle(session) {
  const title = session?.plan?.title ?? session?.title ?? "cc-harness";
  const waiting = Boolean(session?.waiting);
  useEffect12(() => {
    document.title = waiting ? `\u25CF ${title} \u2014 Claude is waiting` : `${title} \u2014 plan`;
  }, [title, waiting]);
}
function useDrawerDismiss(open) {
  useEffect12(() => {
    if (!open) return;
    const onKey = (event) => {
      if (event.key === "Escape") store.setDrawer(false);
    };
    const onResize = () => {
      if (window.innerWidth > 900) store.setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
}
function useShortcuts() {
  useEffect12(() => {
    const handler = (event) => {
      const target = event.target;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "[") {
        event.preventDefault();
        store.toggleSidebar();
        return;
      }
      const index = Number(event.key) - 1;
      const tab = TAB_IDS[index];
      if (tab && store.getState().session?.plan) {
        event.preventDefault();
        store.setTab(tab);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
var TAB_LABEL, tabId, panelId;
var init_App = __esm({
  "src/ui/App.tsx"() {
    "use strict";
    init_store();
    init_Sidebar();
    init_Toasts();
    init_ConnectionBar();
    init_ThemeToggle();
    init_Handoff();
    init_Editable();
    init_Progress();
    init_primitives();
    init_ErrorBoundary();
    init_OverviewView();
    init_DiagramsView();
    init_TasksView();
    init_format();
    init_plan();
    TAB_LABEL = {
      diagrams: "Architecture",
      tasks: "Tasks",
      overview: "Overview"
    };
    tabId = (id) => `tab-${id}`;
    panelId = (id) => `panel-${id}`;
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
  if (!("DOMMatrixReadOnly" in globalThis)) {
    Object.defineProperty(globalThis, "DOMMatrixReadOnly", {
      value: class {
        m22;
        constructor(transform) {
          const scale = /scale\(([\d.]+)\)/.exec(transform ?? "");
          this.m22 = scale ? Number(scale[1]) : 1;
        }
      },
      writable: true,
      configurable: true
    });
  }
  globalThis.MutationObserver ??= dom.window.MutationObserver;
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
      const status = body && typeof body === "object" && "__status" in body ? Number(body.__status) : 200;
      return {
        ok: status < 400,
        status,
        statusText: status < 400 ? "OK" : "Error",
        headers: { get: (name) => name.toLowerCase() === "content-type" ? typeof body === "string" ? "text/plain" : "application/json" : null },
        json: async () => body,
        text: async () => typeof body === "string" ? body : JSON.stringify(body)
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
var { render, fireEvent, within, cleanup, act, screen, waitFor } = await import("@testing-library/react");
var { App: App2 } = await Promise.resolve().then(() => (init_App(), App_exports));
var { store: store2 } = await Promise.resolve().then(() => (init_store(), store_exports));
function makeSession() {
  const now = Date.now();
  return {
    sessionId: "s1",
    cwd: "/repo",
    repoRoot: "/repo",
    branch: "main",
    title: "s1 title",
    status: "active",
    waiting: null,
    surface: "unknown",
    link: null,
    createdAt: now,
    updatedAt: now,
    plan: null
  };
}
function summary(sessionId, repo, createdAt, updatedAt = createdAt) {
  return {
    sessionId,
    title: `${sessionId} title`,
    planTitle: null,
    cwd: `/${repo}`,
    repoName: repo,
    repoRoot: `/${repo}`,
    branch: "main",
    status: "active",
    createdAt,
    updatedAt,
    tasks: { total: 0, done: 0, inProgress: 0, blocked: 0 },
    current: null,
    waiting: null,
    surface: "unknown",
    link: null,
    openThreads: 0,
    unreadByClaude: 0
  };
}
var posts;
var SESSIONS = () => {
  const now = Date.now();
  return [summary("s1", "repo", now), summary("s2", "other", now - 1e3), summary("s3", "other", now - 2e3)];
};
function storageReport(scale = 1) {
  return {
    home: "/home/u/.claude/cc-harness",
    scannedAt: Date.now(),
    groups: [
      {
        id: "sessions",
        label: "Finished sessions",
        detail: "Recorded history for sessions the harness no longer lists.",
        count: 12 * scale,
        bytes: 4e6 * scale
      },
      {
        id: "partial-writes",
        label: "Interrupted writes",
        detail: "Half-written state.",
        count: 2 * scale,
        bytes: 2048 * scale
      },
      { id: "log", label: "Daemon log", detail: "The older part of the log.", count: 1 * scale, bytes: 1024 * scale },
      { id: "lock", label: "Stale lock file", detail: "A dead address.", count: 0, bytes: 0 }
    ],
    totalBytes: 4003072 * scale
  };
}
var pids;
var nextPid = () => pids.length > 1 ? pids.shift() : pids[0] ?? 0;
async function boot(sessions) {
  const list = sessions ?? SESSIONS;
  pids = [100, 100, 200];
  ({ posts } = stubFetch((route) => {
    if (route.startsWith("/api/sessions")) return { sessions: list(), version: "test" };
    if (route === "/api/storage") return { report: storageReport() };
    if (route === "/api/storage/clean") {
      return {
        result: { dryRun: false, groups: [], removed: 5, freedBytes: 3072, failed: [] },
        report: storageReport(0)
      };
    }
    if (route === "/api/daemon/restart") return { restarting: true };
    if (route === "/health") return { ok: true, version: "test", pid: nextPid() };
    if (route.startsWith("/api/session/")) return { session: makeSession() };
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
    toasts: [],
    pinned: [],
    collapsedProjects: [],
    collapsedSidebar: false,
    storage: null,
    storageBusy: false,
    restarting: false
  });
});
after(() => cleanup());
test("sessions are grouped by the project they run in", async () => {
  await boot();
  assert.deepEqual(groupNames(), ["repo", "other"], "newest project first");
  const counts = [...document.querySelectorAll(".session-group-count")].map((el) => el.textContent);
  assert.deepEqual(counts, ["1", "2"]);
  assert.deepEqual(rowNames(), ["s1 title", "s2 title", "s3 title"]);
});
test("the rail holds its order when a session takes a turn", async () => {
  const now = Date.now();
  await boot();
  assert.deepEqual(groupNames(), ["repo", "other"]);
  assert.deepEqual(rowNames(), ["s1 title", "s2 title", "s3 title"]);
  await act(async () => {
    store2.set({
      sessions: [
        summary("s1", "repo", now),
        summary("s2", "other", now - 1e3),
        summary("s3", "other", now - 2e3, now + 5e3)
      ]
    });
  });
  assert.deepEqual(groupNames(), ["repo", "other"], "activity does not reorder the projects");
  assert.deepEqual(rowNames(), ["s1 title", "s2 title", "s3 title"], "nor the rows within one");
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
test("deleting a session forgets the pin hanging off it", async () => {
  await boot();
  await act(async () => {
    store2.set({ pinned: ["s2"] });
  });
  await act(async () => {
    fireEvent.click(within(rowFor("s2 title")).getByTitle("Delete session"));
  });
  await act(async () => {
    fireEvent.click(within(rowFor("s2 title")).getByText("Delete"));
  });
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
test("a row shows the plan, its progress, and what Claude is on", async () => {
  const now = Date.now();
  await boot(() => [
    {
      ...summary("s1", "repo", now),
      planTitle: "Cache rewrite",
      tasks: { total: 5, done: 2, inProgress: 1, blocked: 0 },
      current: "Read-through wrapper",
      unreadByClaude: 3
    }
  ]);
  const row = rowFor("Cache rewrite");
  assert.ok(row, "the plan title names the row");
  assert.match(row.textContent ?? "", /now: Read-through wrapper/);
  assert.match(row.textContent ?? "", /2\/5 tasks/);
  assert.match(row.textContent ?? "", /unread/);
});
test("a session waiting on the user is lifted to the top, with a way into Claude", async () => {
  const now = Date.now();
  const link = { app: "claude://claude.ai/code/session_1", web: "https://claude.ai/code/session_1", via: "cloud" };
  await boot(() => [
    summary("s1", "repo", now),
    { ...summary("s3", "other", now - 2e3), waiting: { kind: "question", text: "Which TTL?", since: now }, link }
  ]);
  assert.deepEqual(groupNames(), ["Waiting on you", "repo"]);
  const row = rowFor("s3 title");
  assert.match(row.textContent ?? "", /Which TTL\?/);
  assert.equal(within(row).getByText("Answer in Claude").getAttribute("href"), link.app);
});
test("collapsing the sidebar folds it to a rail of initials", async () => {
  const now = Date.now();
  await boot(() => [
    { ...summary("s1", "repo", now), planTitle: "Cache rewrite" },
    { ...summary("s2", "other", now - 1e3), waiting: { kind: "input", text: "Go?", since: now } }
  ]);
  await act(async () => {
    fireEvent.click(screen.getByTitle("Collapse sidebar"));
  });
  assert.equal(document.querySelector(".session-list"), null, "the full list is gone");
  const items = [...document.querySelectorAll(".rail-item")];
  assert.deepEqual(items.map((i) => i.textContent), ["ST", "CR"], "waiting first, by initials");
  assert.ok(items[0].classList.contains("is-waiting"));
  await act(async () => {
    fireEvent.click(items[0]);
  });
  assert.equal(store2.getState().sessionId, "s2", "a rail item still opens its session");
});
test("a session can be renamed from the rail", async () => {
  await boot();
  posts.length = 0;
  await act(async () => {
    fireEvent.click(within(rowFor("s1 title")).getByTitle("Rename this session"));
  });
  const field = document.querySelector(".session-rename");
  assert.ok(field, "the row becomes an input");
  await act(async () => {
    fireEvent.change(field, { target: { value: "Cache rewrite" } });
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter" });
  });
  const call = posts.find((p) => p.route.includes("/title"));
  assert.ok(call, "the new name is saved");
  assert.equal(call.body["title"], "Cache rewrite");
  assert.ok(rowNames().some((n) => n.includes("Cache rewrite")));
});
test("abandoning a rename leaves the name alone", async () => {
  await boot();
  posts.length = 0;
  await act(async () => {
    fireEvent.click(within(rowFor("s1 title")).getByTitle("Rename this session"));
  });
  const field = document.querySelector(".session-rename");
  await act(async () => {
    fireEvent.change(field, { target: { value: "Discard me" } });
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: "Escape" });
  });
  assert.equal(posts.find((p) => p.route.includes("/title")), void 0, "nothing was saved");
  assert.ok(rowNames().some((n) => n.includes("s1 title")), "the original name is still there");
});
var openCleanup = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTitle("Clean up stale harness files"));
  });
};
test("the cleanup panel lists only what is actually holding space", async () => {
  await boot();
  await openCleanup();
  const labels = [...document.querySelectorAll(".global-group-name")].map((el) => el.textContent);
  assert.deepEqual(
    labels,
    ["Finished sessions", "Interrupted writes", "Daemon log"],
    "empty groups are decisions the user does not have to make"
  );
});
test("recorded history is the one group not ticked by default", async () => {
  await boot();
  await openCleanup();
  const boxes = [...document.querySelectorAll(".global-group input")];
  assert.deepEqual(
    boxes.map((b) => b.checked),
    [false, true, true]
  );
  assert.match(screen.getByText(/^Clean up/).textContent ?? "", /3 KB/);
});
test("only the ticked groups are sent to be removed", async () => {
  await boot();
  await openCleanup();
  posts.length = 0;
  await act(async () => {
    fireEvent.click(screen.getByText(/^Clean up/));
  });
  const call = posts.find((p) => p.route === "/api/storage/clean");
  assert.ok(call, "the clean request was sent");
  assert.deepEqual(call.body["groups"], ["partial-writes", "log"]);
  assert.ok(
    store2.getState().toasts.some((t) => /Reclaimed/.test(t.text)),
    "the user is told how much came back"
  );
  assert.equal(document.querySelector(".global-empty")?.textContent, "Nothing to clean up.");
});
test("ticking history in adds it to the request", async () => {
  await boot();
  await openCleanup();
  posts.length = 0;
  const first = document.querySelector(".global-group input");
  await act(async () => {
    fireEvent.click(first);
  });
  await act(async () => {
    fireEvent.click(screen.getByText(/^Clean up/));
  });
  const call = posts.find((p) => p.route === "/api/storage/clean");
  assert.deepEqual(call.body["groups"], ["sessions", "partial-writes", "log"]);
});
test("a restart is confirmed first", async () => {
  await boot();
  const reloaded = stubReload();
  await act(async () => {
    fireEvent.click(screen.getByTitle("Restart the daemon to pick up a new build"));
  });
  assert.ok(document.querySelector(".global-confirm"), "the click asks before it acts");
  assert.equal(posts.find((p) => p.route === "/api/daemon/restart"), void 0, "and sends nothing yet");
  await act(async () => {
    fireEvent.click(screen.getByText("Restart"));
  });
  assert.ok(posts.find((p) => p.route === "/api/daemon/restart"), "confirming sends the request");
  await waitFor(() => assert.equal(reloaded.count, 1));
});
test("a restart that never lands says so instead of hanging", async () => {
  await boot();
  const reloaded = stubReload();
  pids = [100];
  await act(async () => {
    await store2.restartDaemon(600);
  });
  assert.equal(reloaded.count, 0, "nothing is reloaded onto a daemon that is not there");
  assert.equal(store2.getState().restarting, false, "and the UI is usable again");
  assert.ok(store2.getState().toasts.some((t) => /did not come back/.test(t.text)));
});
function stubReload() {
  const calls = { count: 0 };
  store2.reloadPage = () => {
    calls.count++;
  };
  return calls;
}
//# sourceMappingURL=sidebar.test.js.map
