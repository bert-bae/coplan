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
    TAB_IDS = ["overview", "diagrams", "tasks", "questions", "activity"];
    initial = {
      sessions: [],
      sessionId: null,
      session: null,
      tab: "overview",
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
        this.connect();
        window.addEventListener("hashchange", () => {
          const id = readHash();
          if (id && id !== this.state.sessionId) void this.selectSession(id, false);
        });
      }
      async selectSession(id, updateHash = true) {
        if (updateHash) window.location.hash = `#/session/${id}`;
        this.set({ sessionId: id, session: null, error: null });
        try {
          const { session } = await api.session(id);
          this.set({ session });
        } catch (err) {
          this.set({ error: describeError(err) });
        }
        this.connect();
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
        const id = this.state.sessionId;
        if (!id || ops.length === 0) return false;
        this.set({ saving: this.state.saving + 1 });
        try {
          const { plan } = await api.ops(id, ops);
          const session = this.state.session;
          if (session && session.sessionId === id) this.set({ session: { ...session, plan } });
          return true;
        } catch (err) {
          this.fail(err);
          return false;
        } finally {
          this.set({ saving: Math.max(0, this.state.saving - 1) });
        }
      }
      op(op) {
        return this.ops([op]);
      }
      /** Jump to an item from anywhere: the activity log, a linked question. */
      focus(kind, id) {
        const tab = kind === "diagram" ? "diagrams" : kind === "task" ? "tasks" : kind === "question" ? "questions" : "overview";
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
function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
        true ? "0.1.0" : "dev"
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
        /* @__PURE__ */ jsx2("nav", { className: "session-list", "aria-label": "Live sessions", children: sessions.length === 0 ? /* @__PURE__ */ jsx2("p", { className: "sidebar-empty", children: "No sessions yet." }) : groups.map((group) => /* @__PURE__ */ jsx2(
          ProjectGroup,
          {
            group,
            current,
            open: !collapsedProjects.includes(group.key),
            showRepo: group.key === PINNED_KEY
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
    const lift = pinnedSet.has(session.sessionId);
    const key = lift ? PINNED_KEY : session.repoRoot ?? session.cwd;
    let group = groups.get(key);
    if (!group) {
      group = key === PINNED_KEY ? { key, label: "Pinned", path: "", sessions: [] } : {
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
  return [...groups.values()].sort((a, b) => {
    if (a.key === PINNED_KEY) return -1;
    if (b.key === PINNED_KEY) return 1;
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
                session.status === "active" && /* @__PURE__ */ jsx2("span", { className: "working-dot", title: "Claude is working", "aria-label": "Claude is working" }),
                session.planTitle ?? session.title
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
                session.openQuestions > 0 && /* @__PURE__ */ jsxs2("span", { className: "pill is-queued", children: [
                  session.openQuestions,
                  " open q"
                ] }),
                session.unreadByClaude > 0 && /* @__PURE__ */ jsxs2("span", { className: "pill is-draft", title: "Changes Claude has not read yet", children: [
                  session.unreadByClaude,
                  " unread"
                ] })
              ] })
            ]
          }
        ),
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
var SESSION_STATE_LABEL, PINNED_KEY;
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
    PINNED_KEY = "\0pinned";
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
        /* @__PURE__ */ jsx5("span", { "aria-hidden": "true", children: GLYPH[option] }),
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
var KEY, ORDER, LABEL, GLYPH;
var init_ThemeToggle = __esm({
  "src/ui/components/ThemeToggle.tsx"() {
    "use strict";
    init_format();
    KEY = "cc-harness:theme";
    ORDER = ["system", "light", "dark"];
    LABEL = { system: "Match the system", light: "Light", dark: "Dark" };
    GLYPH = { system: "\u25D1", light: "\u2600", dark: "\u263E" };
  }
});

// src/shared/types.ts
var NODE_KINDS, TASK_STATUSES;
var init_types = __esm({
  "src/shared/types.ts"() {
    "use strict";
    NODE_KINDS = ["component", "service", "datastore", "queue", "external", "actor", "note"];
    TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];
  }
});

// src/shared/plan.ts
function unreadByClaude(plan) {
  if (!plan) return [];
  return plan.changes.filter((c) => c.seq > plan.claudeReadSeq && c.author === "user");
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
function targetExists(plan, target) {
  switch (target.kind) {
    case "plan":
      return true;
    case "section":
      return plan.sections.some((s) => s.id === target.id);
    case "diagram":
      return plan.diagrams.some((d) => d.id === target.id);
    case "task":
      return plan.tasks.some((t) => t.id === target.id);
    case "question":
      return plan.questions.some((q) => q.id === target.id);
    default:
      return false;
  }
}
var init_plan = __esm({
  "src/shared/plan.ts"() {
    "use strict";
    init_types();
  }
});

// src/ui/components/Handoff.tsx
import { useEffect as useEffect5, useState as useState5 } from "react";
import { Fragment as Fragment2, jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function Handoff() {
  const plan = usePlan();
  const [viewing, setViewing] = useState5(false);
  if (!plan) return null;
  const unread = unreadByClaude(plan).length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(HANDOFF_MESSAGE);
      store.toast("success", "Copied \u2014 paste it into Claude's chat.");
    } catch {
      store.toast("info", `Tell Claude: "${HANDOFF_MESSAGE}"`);
    }
  };
  return /* @__PURE__ */ jsxs6("div", { className: "handoff", children: [
    unread > 0 ? /* @__PURE__ */ jsxs6(Fragment2, { children: [
      /* @__PURE__ */ jsxs6("span", { className: "handoff-state is-behind", title: "Changes you made that Claude has not read yet", children: [
        /* @__PURE__ */ jsx6("span", { className: "dot is-attention", "aria-hidden": "true" }),
        unread,
        " change",
        unread === 1 ? "" : "s",
        " Claude hasn't read"
      ] }),
      /* @__PURE__ */ jsx6("button", { type: "button", className: "btn btn-sm btn-primary", onClick: () => void copy(), title: HANDOFF_MESSAGE, children: "Copy message for Claude" })
    ] }) : /* @__PURE__ */ jsxs6("span", { className: "handoff-state is-current", title: plan.claudeReadAt ? `Read ${new Date(plan.claudeReadAt).toLocaleString()}` : void 0, children: [
      "\u2713 Claude is up to date",
      plan.claudeReadAt ? ` \xB7 read ${relativeTime(plan.claudeReadAt)}` : ""
    ] }),
    /* @__PURE__ */ jsx6("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: () => setViewing(true), children: "As Claude sees it" }),
    viewing && /* @__PURE__ */ jsx6(ClaudeView, { onClose: () => setViewing(false) })
  ] });
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
var HANDOFF_MESSAGE;
var init_Handoff = __esm({
  "src/ui/components/Handoff.tsx"() {
    "use strict";
    init_store();
    init_api();
    init_format();
    init_plan();
    HANDOFF_MESSAGE = "I've updated the plan in the harness. Read it with harness_plan_read, take my edits, answers and comments into account, and tell me what changes.";
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
  onCancel
}) {
  const [editing, setEditing] = useState6(startEditing);
  const [draft, setDraft] = useState6(value);
  const area = useRef2(null);
  useEffect6(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect6(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  const save = () => {
    setEditing(false);
    if (draft !== value) void onSave(draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(value);
    onCancel?.();
  };
  const onKeyDown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
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
      /* @__PURE__ */ jsxs7("div", { className: "md-field-foot", children: [
        /* @__PURE__ */ jsx8("span", { className: "muted", children: "Markdown \xB7 \u2318/Ctrl+Enter to save \xB7 Esc to cancel" }),
        /* @__PURE__ */ jsx8("span", { className: "spacer" }),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: cancel, children: "Cancel" }),
        /* @__PURE__ */ jsx8("button", { type: "button", className: "btn btn-sm btn-primary", onClick: save, children: "Save" })
      ] })
    ] });
  }
  if (!value.trim()) {
    return /* @__PURE__ */ jsx8("div", { className: classNames("md-field is-empty", className), children: /* @__PURE__ */ jsxs7("button", { type: "button", className: "md-empty", onClick: () => setEditing(true), "aria-label": `${emptyAction}: ${label}`, children: [
      /* @__PURE__ */ jsx8("span", { className: "muted", children: placeholder }),
      " ",
      /* @__PURE__ */ jsx8("span", { className: "link", children: emptyAction })
    ] }) });
  }
  return /* @__PURE__ */ jsxs7("div", { className: classNames("md-field", className), children: [
    /* @__PURE__ */ jsx8(Markdown, { source: value }),
    /* @__PURE__ */ jsx8("button", { type: "button", className: "md-edit icon-btn is-tiny", title: `Edit ${label}`, "aria-label": `Edit ${label}`, onClick: () => setEditing(true), children: /* @__PURE__ */ jsx8("span", { "aria-hidden": "true", children: "\u270E" }) })
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
      in_progress: "\u25D0",
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

// src/ui/components/Threads.tsx
import { useState as useState7 } from "react";
import { jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
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
  return /* @__PURE__ */ jsxs10(
    "button",
    {
      type: "button",
      className: classNames("comment-toggle", open && "is-active", unresolved > 0 && "has-comments", waiting && "has-reply"),
      "aria-expanded": open,
      title: unresolved ? `${unresolved} open comment(s)` : "Comment",
      "aria-label": unresolved ? `${unresolved} open comment(s) on ${label}` : `Comment on ${label}`,
      onClick: onToggle,
      children: [
        /* @__PURE__ */ jsx11("span", { "aria-hidden": "true", children: "\u{1F4AC}" }),
        unresolved > 0 && /* @__PURE__ */ jsx11("span", { className: "comment-count", children: unresolved })
      ]
    }
  );
}
function ThreadPanel({ target, label }) {
  const threads = useThreads(target);
  const [showResolved, setShowResolved] = useState7(false);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  return /* @__PURE__ */ jsxs10("div", { className: "threads", "aria-label": `Comments on ${label}`, children: [
    open.map((t) => /* @__PURE__ */ jsx11(ThreadView, { thread: t }, t.id)),
    resolved.length > 0 && /* @__PURE__ */ jsxs10("button", { type: "button", className: "link threads-resolved", onClick: () => setShowResolved((v) => !v), children: [
      showResolved ? "Hide" : "Show",
      " ",
      resolved.length,
      " resolved"
    ] }),
    showResolved && resolved.map((t) => /* @__PURE__ */ jsx11(ThreadView, { thread: t }, t.id)),
    /* @__PURE__ */ jsx11(
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
  return /* @__PURE__ */ jsxs10("article", { className: classNames("thread", thread.resolved && "is-resolved"), children: [
    /* @__PURE__ */ jsx11(Entry, { author: thread.author, text: thread.text, ts: thread.ts }),
    thread.replies.map((r) => /* @__PURE__ */ jsx11(Entry, { author: r.author, text: r.text, ts: r.ts, reply: true }, r.id)),
    /* @__PURE__ */ jsxs10("div", { className: "thread-actions", children: [
      !thread.resolved && /* @__PURE__ */ jsx11("button", { type: "button", className: "link", onClick: () => setReplying((v) => !v), children: "Reply" }),
      /* @__PURE__ */ jsx11("button", { type: "button", className: "link", onClick: () => void store.op({ op: "resolve", threadId: thread.id, resolved: !thread.resolved }), children: thread.resolved ? "Reopen" : "Resolve" }),
      !thread.resolved && lastAuthor(thread) === "user" && /* @__PURE__ */ jsx11("span", { className: "muted", children: "Claude sees this when it next reads the plan" })
    ] }),
    replying && /* @__PURE__ */ jsx11(
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
  return /* @__PURE__ */ jsxs10("div", { className: classNames("thread-entry", reply && "is-reply", `by-${author}`), children: [
    /* @__PURE__ */ jsxs10("div", { className: "thread-meta", children: [
      /* @__PURE__ */ jsx11(AuthorBadge, { author }),
      /* @__PURE__ */ jsx11("span", { className: "muted", children: relativeTime(ts) })
    ] }),
    /* @__PURE__ */ jsx11(Markdown, { source: text })
  ] });
}
function AuthorBadge({ author }) {
  return /* @__PURE__ */ jsx11("span", { className: classNames("author", `is-${author}`), children: author === "user" ? "You" : "Claude" });
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
  return /* @__PURE__ */ jsxs10("div", { className: "thread-composer", children: [
    /* @__PURE__ */ jsx11(
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
    /* @__PURE__ */ jsxs10("div", { className: "thread-composer-foot", children: [
      /* @__PURE__ */ jsx11("span", { className: "muted", children: "\u2318/Ctrl+Enter" }),
      /* @__PURE__ */ jsx11("span", { className: "spacer" }),
      onCancel && /* @__PURE__ */ jsx11("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: onCancel, children: "Cancel" }),
      /* @__PURE__ */ jsx11("button", { type: "button", className: "btn btn-sm", disabled: !text.trim() || busy, onClick: () => void send(), children: "Comment" })
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
import { jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
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
  return /* @__PURE__ */ jsx12(Tag, { ref, id: `${kind}-${id}`, className: classNames(className, flash && "is-flash"), children });
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
    return /* @__PURE__ */ jsxs11("span", { className: "item-confirm", children: [
      "Remove?",
      /* @__PURE__ */ jsx12("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Remove" }),
      /* @__PURE__ */ jsx12("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
    ] });
  }
  return /* @__PURE__ */ jsxs11("span", { className: "item-actions", children: [
    /* @__PURE__ */ jsx12(
      "button",
      {
        type: "button",
        className: "icon-btn is-tiny",
        disabled: index === 0,
        title: "Move up",
        "aria-label": `Move ${label} up`,
        onClick: () => onMove(index - 1),
        children: /* @__PURE__ */ jsx12("span", { "aria-hidden": "true", children: "\u2191" })
      }
    ),
    /* @__PURE__ */ jsx12(
      "button",
      {
        type: "button",
        className: "icon-btn is-tiny",
        disabled: index >= count - 1,
        title: "Move down",
        "aria-label": `Move ${label} down`,
        onClick: () => onMove(index + 1),
        children: /* @__PURE__ */ jsx12("span", { "aria-hidden": "true", children: "\u2193" })
      }
    ),
    /* @__PURE__ */ jsx12("button", { type: "button", className: "icon-btn is-tiny is-danger", title: "Remove", "aria-label": `Remove ${label}`, onClick: () => setConfirming(true), children: /* @__PURE__ */ jsx12("span", { "aria-hidden": "true", children: "\xD7" }) })
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
import { jsx as jsx13, jsxs as jsxs12 } from "react/jsx-runtime";
function OverviewView() {
  const plan = usePlan();
  if (!plan) return null;
  return /* @__PURE__ */ jsxs12("div", { className: "view-pad doc", children: [
    /* @__PURE__ */ jsx13(Glance, { plan }),
    /* @__PURE__ */ jsxs12("section", { className: "doc-block", "aria-labelledby": "summary-head", children: [
      /* @__PURE__ */ jsx13("h2", { id: "summary-head", className: "doc-label", children: "Summary" }),
      /* @__PURE__ */ jsx13(
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
    plan.sections.map((section, i) => /* @__PURE__ */ jsx13(SectionCard, { section, index: i, count: plan.sections.length }, section.id)),
    /* @__PURE__ */ jsx13("div", { className: "doc-add", children: /* @__PURE__ */ jsx13(
      AddField,
      {
        placeholder: "New section title \u2014 e.g. Data model, Risks, Out of scope",
        label: "New section title",
        onAdd: (title) => store.op({ op: "upsert_section", title, body: "" })
      }
    ) }),
    /* @__PURE__ */ jsxs12("section", { className: "doc-block", "aria-labelledby": "general-head", children: [
      /* @__PURE__ */ jsx13("h2", { id: "general-head", className: "doc-label", children: "General comments" }),
      /* @__PURE__ */ jsx13(ThreadPanel, { target: { kind: "plan", id: "" }, label: "the plan" })
    ] })
  ] });
}
function Glance({ plan }) {
  const counts = countTasks(plan);
  const openQuestions = plan.questions.filter((q) => !q.answer);
  const waitingOnYou = openQuestions.filter((q) => q.askedBy === "claude").length;
  const openThreads = plan.threads.filter((t) => !t.resolved).length;
  return /* @__PURE__ */ jsxs12("div", { className: "glance", role: "list", "aria-label": "Plan at a glance", children: [
    /* @__PURE__ */ jsxs12("button", { type: "button", role: "listitem", className: "glance-tile", onClick: () => store.setTab("tasks"), children: [
      /* @__PURE__ */ jsx13("span", { className: "glance-label", children: "Tasks" }),
      /* @__PURE__ */ jsxs12("span", { className: "glance-value", children: [
        counts.done,
        /* @__PURE__ */ jsxs12("span", { className: "glance-of", children: [
          "/",
          counts.total
        ] })
      ] }),
      /* @__PURE__ */ jsx13(ProgressBar, { counts }),
      /* @__PURE__ */ jsxs12("span", { className: "glance-sub", children: [
        counts.inProgress ? `${counts.inProgress} in progress` : counts.total ? "none in progress" : "no tasks yet",
        counts.blocked ? ` \xB7 ${counts.blocked} blocked` : ""
      ] })
    ] }),
    /* @__PURE__ */ jsxs12(
      "button",
      {
        type: "button",
        role: "listitem",
        className: waitingOnYou ? "glance-tile is-attention" : "glance-tile",
        onClick: () => store.setTab("questions"),
        children: [
          /* @__PURE__ */ jsx13("span", { className: "glance-label", children: "Open questions" }),
          /* @__PURE__ */ jsx13("span", { className: "glance-value", children: openQuestions.length }),
          /* @__PURE__ */ jsx13("span", { className: "glance-sub", children: waitingOnYou ? `${waitingOnYou} from Claude for you to answer` : openQuestions.length ? "waiting on Claude" : "all answered" })
        ]
      }
    ),
    /* @__PURE__ */ jsxs12("button", { type: "button", role: "listitem", className: "glance-tile", onClick: () => store.setTab("diagrams"), children: [
      /* @__PURE__ */ jsx13("span", { className: "glance-label", children: "Diagrams" }),
      /* @__PURE__ */ jsx13("span", { className: "glance-value", children: plan.diagrams.length }),
      /* @__PURE__ */ jsx13("span", { className: "glance-sub", children: plan.diagrams.map((d) => d.title).slice(0, 2).join(", ") || "none yet" })
    ] }),
    /* @__PURE__ */ jsxs12("button", { type: "button", role: "listitem", className: "glance-tile", onClick: () => store.setTab("activity"), children: [
      /* @__PURE__ */ jsx13("span", { className: "glance-label", children: "Open comments" }),
      /* @__PURE__ */ jsx13("span", { className: "glance-value", children: openThreads }),
      /* @__PURE__ */ jsxs12("span", { className: "glance-sub", children: [
        "revision ",
        plan.revision || "draft"
      ] })
    ] })
  ] });
}
function SectionCard({ section, index, count }) {
  const [comments, setComments] = useState9(false);
  const target = { kind: "section", id: section.id };
  return /* @__PURE__ */ jsxs12(Focusable, { kind: "section", id: section.id, className: "doc-block section-card", children: [
    /* @__PURE__ */ jsxs12("header", { className: "item-head", children: [
      /* @__PURE__ */ jsx13(
        InlineText,
        {
          as: "h2",
          className: "section-title",
          value: section.title,
          label: "Section title",
          onSave: (title) => store.op({ op: "upsert_section", id: section.id, title })
        }
      ),
      /* @__PURE__ */ jsx13("span", { className: "item-id", children: section.id }),
      /* @__PURE__ */ jsx13("span", { className: "spacer" }),
      /* @__PURE__ */ jsx13(CommentToggle, { target, label: section.title, open: comments, onToggle: () => setComments((v) => !v) }),
      /* @__PURE__ */ jsx13(
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
    /* @__PURE__ */ jsx13(
      MarkdownField,
      {
        value: section.body,
        label: `section "${section.title}"`,
        rows: 8,
        onSave: (body) => store.op({ op: "upsert_section", id: section.id, body })
      }
    ),
    comments && /* @__PURE__ */ jsx13(ThreadPanel, { target, label: section.title })
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
    init_plan();
  }
});

// src/ui/lib/layout.ts
import dagre from "@dagrejs/dagre";
function nodeSize(node) {
  const longest = Math.max(node.label.length, Math.min(node.detail?.length ?? 0, 40) * 0.8);
  const width = Math.round(Math.min(240, Math.max(140, longest * 7.5 + 40)));
  const height = node.detail ? 64 : 44;
  return node.kind === "datastore" ? { width, height: height + 12 } : { width, height };
}
function autoLayout(diagram, direction) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 36, ranksep: 70, marginx: 10, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of diagram.nodes) g.setNode(node.id, { ...nodeSize(node) });
  for (const edge of diagram.edges) {
    if (edge.source !== edge.target) g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);
  const out = /* @__PURE__ */ new Map();
  for (const node of diagram.nodes) {
    const laid = g.node(node.id);
    if (!laid) continue;
    out.set(node.id, { x: Math.round(laid.x - laid.width / 2), y: Math.round(laid.y - laid.height / 2) });
  }
  return out;
}
function resolvePositions(diagram) {
  const placed = diagram.nodes.filter((n) => n.x !== void 0 && n.y !== void 0);
  const out = new Map(placed.map((n) => [n.id, { x: n.x, y: n.y }]));
  if (placed.length === diagram.nodes.length) return out;
  const auto = autoLayout(diagram, diagram.direction);
  if (placed.length === 0) return auto;
  let farX = -Infinity;
  let farY = -Infinity;
  for (const n of placed) {
    const size = nodeSize(n);
    farX = Math.max(farX, n.x + size.width);
    farY = Math.max(farY, n.y + size.height);
  }
  const fresh = diagram.nodes.filter((n) => !out.has(n.id));
  const minX = Math.min(...fresh.map((n) => auto.get(n.id)?.x ?? 0));
  const minY = Math.min(...fresh.map((n) => auto.get(n.id)?.y ?? 0));
  for (const n of fresh) {
    const p = auto.get(n.id) ?? { x: 0, y: 0 };
    out.set(
      n.id,
      diagram.direction === "LR" ? { x: p.x - minX + farX + 80, y: p.y } : { x: p.x, y: p.y - minY + farY + 80 }
    );
  }
  return out;
}
var init_layout = __esm({
  "src/ui/lib/layout.ts"() {
    "use strict";
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

// src/ui/components/FlowCanvas.tsx
import { memo, useCallback, useEffect as useEffect9, useMemo as useMemo2, useRef as useRef4, useState as useState11 } from "react";
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow
} from "@xyflow/react";
import { jsx as jsx14, jsxs as jsxs13 } from "react/jsx-runtime";
function FlowCanvas(props) {
  return /* @__PURE__ */ jsx14(ReactFlowProvider, { children: /* @__PURE__ */ jsx14(Canvas, { ...props }) });
}
function Canvas({ diagram, onSave, expanded }) {
  const theme = useResolvedTheme();
  const flow = useReactFlow();
  const wrapper = useRef4(null);
  const [nodes, setNodes] = useState11(() => toFlowNodes(diagram));
  const [edges, setEdges] = useState11(() => toFlowEdges(diagram));
  const nodesRef = useRef4(nodes);
  const edgesRef = useRef4(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const dragging = useRef4(false);
  const signature = useMemo2(() => JSON.stringify([diagram.nodes, diagram.edges, diagram.direction]), [diagram]);
  useEffect9(() => {
    if (dragging.current) return;
    setNodes((prev) => keepSelection(prev, toFlowNodes(diagram)));
    setEdges((prev) => keepSelection(prev, toFlowEdges(diagram)));
  }, [signature]);
  const firstRender = useRef4(true);
  useEffect9(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const frame = window.requestAnimationFrame(() => void flow.fitView({ padding: 0.15, duration: 200 }));
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, flow]);
  const persist = useCallback(
    (ns, es, direction) => onSave({
      nodes: ns.map((n) => ({
        id: n.id,
        label: n.data.label,
        kind: n.data.kind,
        ...n.data.detail ? { detail: n.data.detail } : {},
        x: Math.round(n.position.x),
        y: Math.round(n.position.y)
      })),
      edges: es.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...e.data?.label ? { label: e.data.label } : {},
        ...e.data?.dashed ? { dashed: true } : {}
      })),
      ...direction ? { direction } : {}
    }),
    [onSave]
  );
  const onNodesChange = useCallback((changes) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes) => setEdges((es) => applyEdgeChanges(changes, es)), []);
  const onConnect = useCallback(
    (conn) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      if (edgesRef.current.some((e) => e.source === conn.source && e.target === conn.target)) return;
      const next = [...edgesRef.current, makeEdge({ id: `${conn.source}->${conn.target}`, source: conn.source, target: conn.target })];
      setEdges(next);
      void persist(nodesRef.current, next);
    },
    [persist]
  );
  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }) => {
      const goneIds = new Set(gone.map((n) => n.id));
      const cutIds = new Set(cut.map((e) => e.id));
      const ns = nodesRef.current.filter((n) => !goneIds.has(n.id));
      const es = edgesRef.current.filter((e) => !cutIds.has(e.id) && !goneIds.has(e.source) && !goneIds.has(e.target));
      setNodes(ns);
      setEdges(es);
      void persist(ns, es);
    },
    [persist]
  );
  const onNodeDragStop = useCallback(
    (_, __, moved) => {
      dragging.current = false;
      const at = new Map(moved.map((n) => [n.id, n.position]));
      const ns = nodesRef.current.map((n) => at.has(n.id) ? { ...n, position: at.get(n.id) } : n);
      void persist(ns, edgesRef.current);
    },
    [persist]
  );
  const updateNode = (id, patch) => {
    const ns = nodesRef.current.map((n) => {
      if (n.id !== id) return n;
      const data = { ...n.data, ...patch };
      if (!data.detail) delete data.detail;
      return { ...n, data: { ...data, width: nodeSize(data).width } };
    });
    setNodes(ns);
    void persist(ns, edgesRef.current);
  };
  const updateEdge = (id, patch) => {
    const es = edgesRef.current.map((e) => {
      if (e.id !== id) return e;
      const data = { ...e.data, ...patch };
      if (!data.label) delete data.label;
      return makeEdge({ id: e.id, source: e.source, target: e.target, ...data }, e.selected);
    });
    setEdges(es);
    void persist(nodesRef.current, es);
  };
  const removeSelected = () => {
    void flow.deleteElements({ nodes: nodesRef.current.filter((n) => n.selected), edges: edgesRef.current.filter((e) => e.selected) });
  };
  const addNode = (kind) => {
    const rect = wrapper.current?.getBoundingClientRect();
    const centre = rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    let n = nodesRef.current.length + 1;
    while (nodesRef.current.some((x) => x.id === `n${n}`)) n++;
    const data = { label: `New ${KIND_LABEL[kind].toLowerCase()}`, kind, direction: diagram.direction, width: 0 };
    data.width = nodeSize(data).width;
    const node = {
      id: `n${n}`,
      type: "plan",
      position: { x: Math.round(centre.x - data.width / 2), y: Math.round(centre.y - 22) },
      data,
      selected: true
    };
    const ns = [...nodesRef.current.map((x) => ({ ...x, selected: false })), node];
    setNodes(ns);
    void persist(ns, edgesRef.current);
  };
  const relayout = (direction) => {
    const graph = {
      nodes: nodesRef.current.map((n) => ({ id: n.id, label: n.data.label, kind: n.data.kind, ...n.data.detail ? { detail: n.data.detail } : {} })),
      edges: edgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target }))
    };
    const at = autoLayout(graph, direction);
    const ns = nodesRef.current.map((n) => ({
      ...n,
      position: at.get(n.id) ?? n.position,
      data: { ...n.data, direction }
    }));
    setNodes(ns);
    void persist(ns, edgesRef.current, direction).then(() => window.requestAnimationFrame(() => void flow.fitView({ padding: 0.15, duration: 250 })));
  };
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedEdges = edges.filter((e) => e.selected);
  return /* @__PURE__ */ jsx14("div", { ref: wrapper, className: classNames("flow", expanded && "is-expanded"), children: /* @__PURE__ */ jsxs13(
    ReactFlow,
    {
      nodes,
      edges,
      nodeTypes,
      onNodesChange,
      onEdgesChange,
      onConnect,
      onDelete,
      onNodeDragStart: () => {
        dragging.current = true;
      },
      onNodeDragStop,
      connectionMode: ConnectionMode.Loose,
      deleteKeyCode: ["Backspace", "Delete"],
      colorMode: theme,
      fitView: true,
      fitViewOptions: { padding: 0.15 },
      minZoom: 0.2,
      maxZoom: 2,
      defaultEdgeOptions: { type: "smoothstep" },
      children: [
        /* @__PURE__ */ jsx14(Background, { gap: 18, size: 1 }),
        /* @__PURE__ */ jsx14(Controls, { showInteractive: false, position: "bottom-left" }),
        expanded && /* @__PURE__ */ jsx14(MiniMap, { pannable: true, zoomable: true, position: "bottom-right" }),
        /* @__PURE__ */ jsxs13(Panel, { position: "top-left", className: "flow-toolbar", children: [
          /* @__PURE__ */ jsx14(AddMenu, { onAdd: addNode }),
          /* @__PURE__ */ jsx14("button", { type: "button", className: "btn btn-sm", title: "Lay the whole diagram out again", onClick: () => relayout(diagram.direction), children: "Tidy layout" }),
          /* @__PURE__ */ jsx14(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              title: diagram.direction === "LR" ? "Flow top to bottom" : "Flow left to right",
              onClick: () => relayout(diagram.direction === "LR" ? "TB" : "LR"),
              children: diagram.direction === "LR" ? "\u2192 Left to right" : "\u2193 Top to bottom"
            }
          )
        ] }),
        selectedNodes.length + selectedEdges.length > 0 && /* @__PURE__ */ jsx14(Panel, { position: "top-right", className: "flow-inspector", children: selectedNodes.length === 1 && selectedEdges.length === 0 ? /* @__PURE__ */ jsx14(NodeInspector, { node: selectedNodes[0], onChange: (patch) => updateNode(selectedNodes[0].id, patch), onRemove: removeSelected }, selectedNodes[0].id) : selectedEdges.length === 1 && selectedNodes.length === 0 ? /* @__PURE__ */ jsx14(EdgeInspector, { edge: selectedEdges[0], nodes, onChange: (patch) => updateEdge(selectedEdges[0].id, patch), onRemove: removeSelected }, selectedEdges[0].id) : /* @__PURE__ */ jsxs13("div", { className: "flow-inspector-body", children: [
          /* @__PURE__ */ jsxs13("p", { className: "muted", children: [
            selectedNodes.length,
            " box(es), ",
            selectedEdges.length,
            " arrow(s) selected"
          ] }),
          /* @__PURE__ */ jsx14("button", { type: "button", className: "btn btn-sm btn-danger", onClick: removeSelected, children: "Delete selection" })
        ] }) })
      ]
    }
  ) });
}
function PlanNode({ data, selected }) {
  const horizontal = data.direction === "LR";
  return /* @__PURE__ */ jsxs13("div", { className: classNames("flow-node", `kind-${data.kind}`, selected && "is-selected"), style: { width: data.width }, children: [
    /* @__PURE__ */ jsx14(Handle, { type: "target", position: horizontal ? Position.Left : Position.Top }),
    /* @__PURE__ */ jsxs13("div", { className: "flow-node-head", children: [
      /* @__PURE__ */ jsx14("span", { className: "flow-node-glyph", "aria-hidden": "true", children: KIND_GLYPH[data.kind] }),
      /* @__PURE__ */ jsx14("span", { className: "flow-node-label", children: data.label })
    ] }),
    data.detail && /* @__PURE__ */ jsx14("div", { className: "flow-node-detail", children: data.detail }),
    /* @__PURE__ */ jsx14(Handle, { type: "source", position: horizontal ? Position.Right : Position.Bottom })
  ] });
}
function toFlowNodes(diagram) {
  const at = resolvePositions(diagram);
  return diagram.nodes.map((n) => ({
    id: n.id,
    type: "plan",
    position: at.get(n.id) ?? { x: 0, y: 0 },
    data: {
      label: n.label,
      kind: n.kind,
      ...n.detail ? { detail: n.detail } : {},
      direction: diagram.direction,
      width: nodeSize(n).width
    }
  }));
}
function toFlowEdges(diagram) {
  return diagram.edges.map((e) => makeEdge(e));
}
function makeEdge(e, selected) {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: "smoothstep",
    ...e.label ? { label: e.label } : {},
    data: { ...e.label ? { label: e.label } : {}, ...e.dashed ? { dashed: true } : {} },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    className: e.dashed ? "is-dashed" : void 0,
    ...e.dashed ? { style: { strokeDasharray: "6 4" } } : {},
    ...selected ? { selected } : {}
  };
}
function keepSelection(prev, next) {
  const selected = new Set(prev.filter((x) => x.selected).map((x) => x.id));
  return next.map((x) => selected.has(x.id) ? { ...x, selected: true } : x);
}
function AddMenu({ onAdd }) {
  const [open, setOpen] = useState11(false);
  return /* @__PURE__ */ jsxs13("div", { className: "add-menu", children: [
    /* @__PURE__ */ jsx14("button", { type: "button", className: "btn btn-sm btn-primary", "aria-expanded": open, onClick: () => setOpen((v) => !v), children: "+ Box" }),
    open && /* @__PURE__ */ jsx14("div", { className: "add-menu-list", role: "menu", children: NODE_KINDS.map((k) => /* @__PURE__ */ jsxs13(
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
          /* @__PURE__ */ jsx14("span", { className: classNames("kind-swatch", `kind-${k}`), "aria-hidden": "true", children: KIND_GLYPH[k] }),
          KIND_LABEL[k]
        ]
      },
      k
    )) })
  ] });
}
function CommitInput({ value, label, placeholder, onCommit }) {
  const [draft, setDraft] = useState11(value);
  useEffect9(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return /* @__PURE__ */ jsx14(
    "input",
    {
      className: "input",
      value: draft,
      "aria-label": label,
      placeholder,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }
    }
  );
}
function NodeInspector({
  node,
  onChange,
  onRemove
}) {
  return /* @__PURE__ */ jsxs13("div", { className: "flow-inspector-body", "aria-label": "Selected box", children: [
    /* @__PURE__ */ jsxs13("label", { className: "field", children: [
      /* @__PURE__ */ jsx14("span", { className: "field-label", children: "Label" }),
      /* @__PURE__ */ jsx14(CommitInput, { value: node.data.label, label: "Box label", onCommit: (label) => label && onChange({ label }) })
    ] }),
    /* @__PURE__ */ jsxs13("label", { className: "field", children: [
      /* @__PURE__ */ jsx14("span", { className: "field-label", children: "Kind" }),
      /* @__PURE__ */ jsx14("select", { className: "input", value: node.data.kind, onChange: (e) => onChange({ kind: e.target.value }), children: NODE_KINDS.map((k) => /* @__PURE__ */ jsx14("option", { value: k, children: KIND_LABEL[k] }, k)) })
    ] }),
    /* @__PURE__ */ jsxs13("label", { className: "field", children: [
      /* @__PURE__ */ jsx14("span", { className: "field-label", children: "Detail" }),
      /* @__PURE__ */ jsx14(CommitInput, { value: node.data.detail ?? "", label: "Box detail", placeholder: "Responsibility, technology\u2026", onCommit: (detail) => onChange({ detail }) })
    ] }),
    /* @__PURE__ */ jsxs13("div", { className: "flow-inspector-foot", children: [
      /* @__PURE__ */ jsx14("span", { className: "item-id", children: node.id }),
      /* @__PURE__ */ jsx14("span", { className: "spacer" }),
      /* @__PURE__ */ jsx14("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Delete box" })
    ] })
  ] });
}
function EdgeInspector({
  edge,
  nodes,
  onChange,
  onRemove
}) {
  const name = (id) => nodes.find((n) => n.id === id)?.data.label ?? id;
  return /* @__PURE__ */ jsxs13("div", { className: "flow-inspector-body", "aria-label": "Selected arrow", children: [
    /* @__PURE__ */ jsxs13("p", { className: "flow-inspector-title", children: [
      name(edge.source),
      " \u2192 ",
      name(edge.target)
    ] }),
    /* @__PURE__ */ jsxs13("label", { className: "field", children: [
      /* @__PURE__ */ jsx14("span", { className: "field-label", children: "Label" }),
      /* @__PURE__ */ jsx14(CommitInput, { value: edge.data?.label ?? "", label: "Arrow label", placeholder: "What flows along it", onCommit: (label) => onChange({ label }) })
    ] }),
    /* @__PURE__ */ jsxs13("label", { className: "toggle", children: [
      /* @__PURE__ */ jsx14("input", { type: "checkbox", checked: Boolean(edge.data?.dashed), onChange: (e) => onChange({ dashed: e.target.checked }) }),
      "Dashed \u2014 optional, async or future"
    ] }),
    /* @__PURE__ */ jsxs13("div", { className: "flow-inspector-foot", children: [
      /* @__PURE__ */ jsx14("span", { className: "spacer" }),
      /* @__PURE__ */ jsx14("button", { type: "button", className: "link is-danger", onClick: onRemove, children: "Delete arrow" })
    ] })
  ] });
}
var KIND_LABEL, KIND_GLYPH, nodeTypes;
var init_FlowCanvas = __esm({
  "src/ui/components/FlowCanvas.tsx"() {
    "use strict";
    init_layout();
    init_theme();
    init_format();
    init_types();
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
    nodeTypes = { plan: memo(PlanNode) };
  }
});

// src/ui/views/DiagramsView.tsx
import { useEffect as useEffect10, useState as useState12 } from "react";
import { jsx as jsx15, jsxs as jsxs14 } from "react/jsx-runtime";
function DiagramsView() {
  const plan = usePlan();
  const [adding, setAdding] = useState12(false);
  if (!plan) return null;
  const add = async (t) => {
    setAdding(false);
    await store.op({ op: "upsert_diagram", title: t.title, nodes: t.nodes, edges: t.edges });
  };
  return /* @__PURE__ */ jsxs14("div", { className: "view-pad", children: [
    /* @__PURE__ */ jsxs14("div", { className: "toolbar", children: [
      /* @__PURE__ */ jsx15("p", { className: "toolbar-hint", children: plan.diagrams.length ? "Drag boxes to arrange them, drag from a handle to connect, select to edit, Backspace to delete." : "No diagrams yet." }),
      /* @__PURE__ */ jsx15("span", { className: "spacer" }),
      /* @__PURE__ */ jsxs14("div", { className: "add-menu", children: [
        /* @__PURE__ */ jsx15("button", { type: "button", className: "btn btn-sm", "aria-expanded": adding, onClick: () => setAdding((v) => !v), children: "+ New diagram" }),
        adding && /* @__PURE__ */ jsx15("div", { className: "add-menu-list is-right", role: "menu", children: TEMPLATES.map((t) => /* @__PURE__ */ jsx15("button", { type: "button", role: "menuitem", className: "add-menu-item", onClick: () => void add(t), children: t.label }, t.label)) })
      ] })
    ] }),
    plan.diagrams.length === 0 ? /* @__PURE__ */ jsx15(
      EmptyState,
      {
        title: "No diagrams yet",
        hint: "Ask Claude to draw the architecture \u2014 components, data flow, boundaries \u2014 or start one from a template."
      }
    ) : /* @__PURE__ */ jsx15("div", { className: "diagram-list", children: plan.diagrams.map((d, i) => /* @__PURE__ */ jsx15(DiagramCard, { diagram: d, index: i, count: plan.diagrams.length }, d.id)) })
  ] });
}
function DiagramCard({ diagram, index, count }) {
  const [expanded, setExpanded] = useState12(false);
  const [comments, setComments] = useState12(false);
  const target = { kind: "diagram", id: diagram.id };
  useEffect10(() => {
    if (!expanded) return;
    const onKey = (e) => {
      const el = e.target;
      if (e.key === "Escape" && !(el && (el.tagName === "INPUT" || el.tagName === "SELECT"))) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);
  const save = (patch) => store.op({ op: "upsert_diagram", id: diagram.id, ...patch });
  return /* @__PURE__ */ jsxs14(Focusable, { kind: "diagram", id: diagram.id, as: "article", className: classNames("diagram-card", expanded && "is-expanded"), children: [
    /* @__PURE__ */ jsxs14("header", { className: "item-head", children: [
      /* @__PURE__ */ jsx15(
        InlineText,
        {
          as: "h2",
          className: "section-title",
          value: diagram.title,
          label: "Diagram title",
          onSave: (title) => store.op({ op: "upsert_diagram", id: diagram.id, title })
        }
      ),
      /* @__PURE__ */ jsx15("span", { className: "item-id", children: diagram.id }),
      /* @__PURE__ */ jsxs14("span", { className: "muted item-when", children: [
        diagram.nodes.length,
        " boxes \xB7 ",
        diagram.updatedBy === "user" ? "edited by you" : "by Claude",
        " \xB7 ",
        relativeTime(diagram.updatedAt)
      ] }),
      /* @__PURE__ */ jsx15("span", { className: "spacer" }),
      /* @__PURE__ */ jsx15("button", { type: "button", className: "btn btn-sm btn-ghost", "aria-pressed": expanded, onClick: () => setExpanded((v) => !v), children: expanded ? "Exit full screen" : "Full screen" }),
      /* @__PURE__ */ jsx15(CommentToggle, { target, label: diagram.title, open: comments, onToggle: () => setComments((v) => !v) }),
      !expanded && /* @__PURE__ */ jsx15(
        ItemActions,
        {
          label: diagram.title,
          index,
          count,
          onMove: (to) => store.op({ op: "move_diagram", id: diagram.id, index: to }),
          onRemove: () => store.op({ op: "remove", kind: "diagram", id: diagram.id })
        }
      )
    ] }),
    /* @__PURE__ */ jsx15(FlowCanvas, { diagram, onSave: save, expanded }),
    !expanded && /* @__PURE__ */ jsx15(
      MarkdownField,
      {
        className: "diagram-caption",
        value: diagram.caption ?? "",
        label: `caption of "${diagram.title}"`,
        placeholder: "No caption.",
        emptyAction: "Add a caption",
        rows: 3,
        onSave: (caption) => store.op({ op: "upsert_diagram", id: diagram.id, caption })
      }
    ),
    comments && /* @__PURE__ */ jsx15(ThreadPanel, { target, label: diagram.title })
  ] });
}
var TEMPLATES;
var init_DiagramsView = __esm({
  "src/ui/views/DiagramsView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Threads();
    init_Item();
    init_FlowCanvas();
    init_primitives();
    init_format();
    TEMPLATES = [
      { label: "Blank", title: "New diagram", nodes: [], edges: [] },
      {
        label: "Components",
        title: "Components",
        nodes: [
          { id: "client", label: "Client", kind: "actor" },
          { id: "api", label: "API", kind: "service" },
          { id: "db", label: "Database", kind: "datastore" }
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
import { useMemo as useMemo3, useState as useState13 } from "react";
import { Fragment as Fragment3, jsx as jsx16, jsxs as jsxs15 } from "react/jsx-runtime";
function TasksView() {
  const plan = usePlan();
  const mode = useStore((s) => s.taskMode);
  const hideDone = useStore((s) => s.hideDone);
  if (!plan) return null;
  const counts = countTasks(plan);
  return /* @__PURE__ */ jsxs15("div", { className: "view-pad", children: [
    /* @__PURE__ */ jsxs15("div", { className: "toolbar", children: [
      /* @__PURE__ */ jsxs15("div", { className: "segmented", role: "group", "aria-label": "Task layout", children: [
        /* @__PURE__ */ jsx16("button", { type: "button", className: classNames("seg", mode === "outline" && "is-active"), "aria-pressed": mode === "outline", onClick: () => store.setTaskMode("outline"), children: "Outline" }),
        /* @__PURE__ */ jsx16("button", { type: "button", className: classNames("seg", mode === "board" && "is-active"), "aria-pressed": mode === "board", onClick: () => store.setTaskMode("board"), children: "Board" })
      ] }),
      mode === "outline" && /* @__PURE__ */ jsxs15("label", { className: "toggle", children: [
        /* @__PURE__ */ jsx16("input", { type: "checkbox", checked: hideDone, onChange: () => store.toggleHideDone() }),
        "Hide done"
      ] }),
      /* @__PURE__ */ jsx16("span", { className: "spacer" }),
      /* @__PURE__ */ jsxs15("span", { className: "toolbar-progress", children: [
        /* @__PURE__ */ jsx16(ProgressBar, { counts }),
        /* @__PURE__ */ jsxs15("span", { className: "muted", children: [
          counts.done,
          "/",
          counts.total,
          " done"
        ] })
      ] })
    ] }),
    plan.tasks.length === 0 ? /* @__PURE__ */ jsxs15(Fragment3, { children: [
      /* @__PURE__ */ jsx16(EmptyState, { title: "No tasks yet", hint: "Break the work down here, or ask Claude to publish a task tree with the plan." }),
      /* @__PURE__ */ jsx16(AddField, { placeholder: "Add a task\u2026", label: "New task", onAdd: (title) => store.op({ op: "upsert_task", title }) })
    ] }) : mode === "outline" ? /* @__PURE__ */ jsx16(Outline, { plan, hideDone }) : /* @__PURE__ */ jsx16(Board, { plan })
  ] });
}
function Outline({ plan, hideDone }) {
  const collapsed = useStore((s) => s.collapsedTasks);
  const [dragging, setDragging] = useState13(null);
  const [hint, setHint] = useState13(null);
  const [expanded, setExpanded] = useState13(null);
  const [addingUnder, setAddingUnder] = useState13(null);
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
  return /* @__PURE__ */ jsxs15("div", { className: "task-outline", children: [
    /* @__PURE__ */ jsx16("div", { className: "outline-rows", role: "tree", "aria-label": "Task tree", children: rows.map(({ task, depth, number }) => /* @__PURE__ */ jsx16(
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
        onCloseAdd: () => setAddingUnder(null)
      },
      task.id
    )) }),
    /* @__PURE__ */ jsx16(AddField, { placeholder: "Add a top-level task\u2026", label: "New top-level task", onAdd: (title) => store.op({ op: "upsert_task", title }) }),
    /* @__PURE__ */ jsx16("p", { className: "outline-help muted", children: "Drag a row onto another to nest it, or to its top or bottom edge to place it beside. With a row focused: Alt+\u2191/\u2193 reorders, Alt+\u2192 nests under the row above, Alt+\u2190 moves it out a level." })
  ] });
}
function TaskRow(props) {
  const { plan, task, depth, number, expanded } = props;
  const collapsed = useStore((s) => s.collapsedTasks.includes(task.id));
  const [comments, setComments] = useState13(false);
  const kids = childrenOf(plan, task.id);
  const sub = kids.length ? countTasks({ tasks: [task, ...descendants(plan, task.id)] }) : null;
  const questions = plan.questions.filter((q) => q.taskId === task.id);
  const openQuestions = questions.filter((q) => !q.answer).length;
  const threads = useThreads({ kind: "task", id: task.id });
  const target = { kind: "task", id: task.id };
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
  return /* @__PURE__ */ jsxs15(Focusable, { kind: "task", id: task.id, as: "div", className: classNames("task", `is-${task.status}`, props.dragging && "is-dragging"), children: [
    /* @__PURE__ */ jsxs15(
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
          /* @__PURE__ */ jsx16("span", { className: "drag-handle", "aria-hidden": "true", title: "Drag to move", children: "\u22EE\u22EE" }),
          kids.length ? /* @__PURE__ */ jsx16(
            "button",
            {
              type: "button",
              className: "twisty",
              "aria-label": collapsed ? `Show subtasks of ${task.title}` : `Hide subtasks of ${task.title}`,
              onClick: () => store.toggleTaskCollapsed(task.id),
              children: collapsed ? "\u25B8" : "\u25BE"
            }
          ) : /* @__PURE__ */ jsx16("span", { className: "twisty is-leaf", "aria-hidden": "true" }),
          /* @__PURE__ */ jsx16(StatusDot, { task }),
          /* @__PURE__ */ jsx16("span", { className: "task-num", children: number }),
          /* @__PURE__ */ jsx16(
            InlineText,
            {
              className: "task-title",
              value: task.title,
              label: "Task title",
              onSave: (title) => store.op({ op: "upsert_task", id: task.id, title })
            }
          ),
          /* @__PURE__ */ jsxs15("span", { className: "task-badges", children: [
            sub && /* @__PURE__ */ jsxs15("span", { className: "chip", title: `${sub.done} of ${sub.total} subtasks done`, children: [
              sub.done,
              "/",
              sub.total
            ] }),
            task.note && /* @__PURE__ */ jsx16("span", { className: classNames("chip is-note", task.status === "blocked" && "is-warning"), title: task.note, children: task.note }),
            openQuestions > 0 && /* @__PURE__ */ jsxs15("button", { type: "button", className: "chip is-warning", onClick: () => store.focus("question", questions.find((q) => !q.answer).id), children: [
              openQuestions,
              " question",
              openQuestions === 1 ? "" : "s"
            ] }),
            task.files?.length ? /* @__PURE__ */ jsxs15("span", { className: "chip", title: task.files.join("\n"), children: [
              task.files.length,
              " file",
              task.files.length === 1 ? "" : "s"
            ] }) : null,
            task.createdBy === "user" && /* @__PURE__ */ jsx16("span", { className: "chip is-you", children: "added by you" })
          ] }),
          /* @__PURE__ */ jsx16("span", { className: "spacer" }),
          /* @__PURE__ */ jsxs15("span", { className: "task-actions", children: [
            /* @__PURE__ */ jsx16("button", { type: "button", className: "icon-btn is-tiny", title: "Add subtask", "aria-label": `Add a subtask to ${task.title}`, onClick: props.onAddSubtask, children: /* @__PURE__ */ jsx16("span", { "aria-hidden": "true", children: "\uFF0B" }) }),
            /* @__PURE__ */ jsx16(MoveButton, { op: moves.outdent, glyph: "\u2190", label: `Move ${task.title} out a level` }),
            /* @__PURE__ */ jsx16(MoveButton, { op: moves.indent, glyph: "\u2192", label: `Nest ${task.title} under the task above` }),
            /* @__PURE__ */ jsx16(MoveButton, { op: moves.up, glyph: "\u2191", label: `Move ${task.title} up` }),
            /* @__PURE__ */ jsx16(MoveButton, { op: moves.down, glyph: "\u2193", label: `Move ${task.title} down` })
          ] }),
          /* @__PURE__ */ jsx16(CommentToggle, { target, label: task.title, open: comments, onToggle: () => setComments((v) => !v) }),
          /* @__PURE__ */ jsx16(
            "button",
            {
              type: "button",
              className: classNames("icon-btn is-tiny", expanded && "is-active", (Boolean(task.detail) || threads.length > 0) && "has-detail"),
              "aria-expanded": expanded,
              title: "Details",
              "aria-label": `Details of ${task.title}`,
              onClick: props.onToggleExpanded,
              children: /* @__PURE__ */ jsx16("span", { "aria-hidden": "true", children: expanded ? "\u2303" : "\u2304" })
            }
          )
        ]
      }
    ),
    (expanded || comments) && /* @__PURE__ */ jsxs15("div", { className: "task-detail", style: { ["--depth"]: depth }, children: [
      expanded && /* @__PURE__ */ jsx16(TaskDetail, { plan, task }),
      comments && /* @__PURE__ */ jsx16(ThreadPanel, { target, label: task.title })
    ] }),
    props.addingSubtask && /* @__PURE__ */ jsx16("div", { className: "task-add-sub", style: { ["--depth"]: depth + 1 }, children: /* @__PURE__ */ jsx16(
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
  const [confirming, setConfirming] = useState13(false);
  const questions = plan.questions.filter((q) => q.taskId === task.id);
  const subtasks = descendants(plan, task.id).length;
  return /* @__PURE__ */ jsxs15("div", { className: "task-detail-body", children: [
    /* @__PURE__ */ jsxs15("div", { className: "field-row", children: [
      /* @__PURE__ */ jsx16("span", { className: "field-label", children: "Status" }),
      /* @__PURE__ */ jsx16(StatusPicker, { task })
    ] }),
    /* @__PURE__ */ jsxs15("div", { className: "field-row", children: [
      /* @__PURE__ */ jsx16("span", { className: "field-label", children: "Note" }),
      /* @__PURE__ */ jsx16(
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
    /* @__PURE__ */ jsxs15("div", { className: "field-col", children: [
      /* @__PURE__ */ jsx16("span", { className: "field-label", children: "Detail" }),
      /* @__PURE__ */ jsx16(
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
    /* @__PURE__ */ jsxs15("div", { className: "field-col", children: [
      /* @__PURE__ */ jsx16("span", { className: "field-label", children: "Files" }),
      /* @__PURE__ */ jsx16(FilesField, { task })
    ] }),
    questions.length > 0 && /* @__PURE__ */ jsxs15("div", { className: "field-col", children: [
      /* @__PURE__ */ jsx16("span", { className: "field-label", children: "Questions" }),
      /* @__PURE__ */ jsx16("ul", { className: "plain-list", children: questions.map((q) => /* @__PURE__ */ jsxs15("li", { children: [
        /* @__PURE__ */ jsx16("button", { type: "button", className: "link", onClick: () => store.focus("question", q.id), children: q.question }),
        " ",
        /* @__PURE__ */ jsx16("span", { className: q.answer ? "muted" : "attention", children: q.answer ? "answered" : "open" })
      ] }, q.id)) })
    ] }),
    /* @__PURE__ */ jsxs15("div", { className: "task-detail-foot", children: [
      /* @__PURE__ */ jsxs15("span", { className: "muted", children: [
        task.id,
        " \xB7 ",
        task.createdBy === "user" ? "added by you" : "added by Claude"
      ] }),
      /* @__PURE__ */ jsx16("span", { className: "spacer" }),
      confirming ? /* @__PURE__ */ jsxs15("span", { className: "item-confirm", children: [
        "Remove",
        subtasks ? ` with ${subtasks} subtask(s)` : "",
        "?",
        /* @__PURE__ */ jsx16("button", { type: "button", className: "link is-danger", onClick: () => void store.op({ op: "remove", kind: "task", id: task.id }), children: "Remove" }),
        /* @__PURE__ */ jsx16("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
      ] }) : /* @__PURE__ */ jsx16("button", { type: "button", className: "link is-danger", onClick: () => setConfirming(true), children: "Remove task" })
    ] })
  ] });
}
function FilesField({ task }) {
  const [editing, setEditing] = useState13(false);
  const [draft, setDraft] = useState13((task.files ?? []).join("\n"));
  if (!editing) {
    return /* @__PURE__ */ jsxs15("div", { className: "files", children: [
      task.files?.length ? /* @__PURE__ */ jsx16("ul", { className: "plain-list mono", children: task.files.map((f) => /* @__PURE__ */ jsx16("li", { children: f }, f)) }) : /* @__PURE__ */ jsx16("span", { className: "muted", children: "None listed." }),
      " ",
      /* @__PURE__ */ jsx16(
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
  return /* @__PURE__ */ jsxs15("div", { className: "md-field is-editing", children: [
    /* @__PURE__ */ jsx16("textarea", { className: "input mono", rows: 4, value: draft, "aria-label": "Files, one per line", onChange: (e) => setDraft(e.target.value) }),
    /* @__PURE__ */ jsxs15("div", { className: "md-field-foot", children: [
      /* @__PURE__ */ jsx16("span", { className: "muted", children: "One path per line" }),
      /* @__PURE__ */ jsx16("span", { className: "spacer" }),
      /* @__PURE__ */ jsx16("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: () => setEditing(false), children: "Cancel" }),
      /* @__PURE__ */ jsx16(
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
  return /* @__PURE__ */ jsx16("button", { type: "button", className: "icon-btn is-tiny", disabled: !op, title: label, "aria-label": label, onClick: () => op && void store.op(op), children: /* @__PURE__ */ jsx16("span", { "aria-hidden": "true", children: glyph }) });
}
function StatusDot({ task }) {
  const next = NEXT_STATUS[task.status];
  return /* @__PURE__ */ jsx16(
    "button",
    {
      type: "button",
      className: classNames("status-dot", `is-${task.status}`),
      title: `${STATUS_LABEL[task.status]} \u2014 click to mark ${STATUS_LABEL[next].toLowerCase()}`,
      "aria-label": `${task.title}: ${STATUS_LABEL[task.status]}. Mark ${STATUS_LABEL[next].toLowerCase()}`,
      onClick: () => void store.op({ op: "upsert_task", id: task.id, status: next }),
      children: /* @__PURE__ */ jsx16("span", { "aria-hidden": "true", children: STATUS_GLYPH[task.status] })
    }
  );
}
function StatusPicker({ task }) {
  return /* @__PURE__ */ jsx16("div", { className: "segmented", role: "radiogroup", "aria-label": `Status of ${task.title}`, children: TASK_STATUSES.map((s) => /* @__PURE__ */ jsx16(
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
  const [over, setOver] = useState13(null);
  const leaves = outline(plan).map((r) => r.task).filter((t) => !hasChildren(plan, t.id));
  return /* @__PURE__ */ jsx16("div", { className: "board", children: TASK_STATUSES.map((status) => {
    const cards = leaves.filter((t) => t.status === status);
    return /* @__PURE__ */ jsxs15(
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
          /* @__PURE__ */ jsxs15("header", { className: "board-col-head", children: [
            /* @__PURE__ */ jsx16("span", { className: classNames("status-dot is-static", `is-${status}`), "aria-hidden": "true", children: STATUS_GLYPH[status] }),
            /* @__PURE__ */ jsx16("h2", { children: STATUS_LABEL[status] }),
            /* @__PURE__ */ jsx16("span", { className: "board-count", children: cards.length })
          ] }),
          /* @__PURE__ */ jsxs15("div", { className: "board-cards", children: [
            cards.map((task) => /* @__PURE__ */ jsx16(BoardCard, { plan, task }, task.id)),
            cards.length === 0 && /* @__PURE__ */ jsx16("p", { className: "board-empty", children: "Drop tasks here" })
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
  return /* @__PURE__ */ jsxs15(
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
        path.length > 0 && /* @__PURE__ */ jsx16("p", { className: "board-path", children: path.join(" \u203A ") }),
        /* @__PURE__ */ jsx16("button", { type: "button", className: "board-title", onClick: () => store.focus("task", task.id), children: task.title }),
        task.note && /* @__PURE__ */ jsx16("p", { className: "board-note", children: task.note }),
        /* @__PURE__ */ jsxs15("footer", { className: "board-foot", children: [
          /* @__PURE__ */ jsx16("span", { className: "item-id", children: task.id }),
          comments > 0 && /* @__PURE__ */ jsxs15("span", { className: "chip", children: [
            "\u{1F4AC} ",
            comments
          ] }),
          /* @__PURE__ */ jsx16("span", { className: "spacer" }),
          /* @__PURE__ */ jsxs15("label", { className: "sr-only", htmlFor: `status-${task.id}`, children: [
            "Status of ",
            task.title
          ] }),
          /* @__PURE__ */ jsx16(
            "select",
            {
              id: `status-${task.id}`,
              className: "board-status",
              value: task.status,
              onChange: (e) => void store.op({ op: "upsert_task", id: task.id, status: e.target.value }),
              children: TASK_STATUSES.map((s) => /* @__PURE__ */ jsx16("option", { value: s, children: STATUS_LABEL[s] }, s))
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
var NEXT_STATUS, DRAG_TYPE;
var init_TasksView = __esm({
  "src/ui/views/TasksView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Threads();
    init_Item();
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
    DRAG_TYPE = "application/x-harness-task";
  }
});

// src/ui/views/QuestionsView.tsx
import { useEffect as useEffect11, useState as useState14 } from "react";
import { Fragment as Fragment4, jsx as jsx17, jsxs as jsxs16 } from "react/jsx-runtime";
function QuestionsView() {
  const plan = usePlan();
  const [filter, setFilter] = useState14("open");
  if (!plan) return null;
  const shown = plan.questions.filter((q) => filter === "all" ? true : filter === "open" ? !q.answer : Boolean(q.answer));
  shown.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  const counts = {
    open: plan.questions.filter((q) => !q.answer).length,
    answered: plan.questions.filter((q) => q.answer).length,
    all: plan.questions.length
  };
  return /* @__PURE__ */ jsxs16("div", { className: "view-pad questions", children: [
    /* @__PURE__ */ jsxs16("div", { className: "toolbar", children: [
      /* @__PURE__ */ jsx17("div", { className: "segmented", role: "group", "aria-label": "Show questions", children: ["open", "answered", "all"].map((f) => /* @__PURE__ */ jsxs16("button", { type: "button", className: classNames("seg", filter === f && "is-active"), "aria-pressed": filter === f, onClick: () => setFilter(f), children: [
        f === "open" ? "Open" : f === "answered" ? "Answered" : "All",
        " ",
        /* @__PURE__ */ jsx17("span", { className: "seg-count", children: counts[f] })
      ] }, f)) }),
      /* @__PURE__ */ jsx17("span", { className: "spacer" })
    ] }),
    shown.length === 0 ? /* @__PURE__ */ jsx17(
      EmptyState,
      {
        title: filter === "open" ? "No open questions" : "Nothing here",
        hint: filter === "open" && counts.all ? "Every question has an answer." : "Questions Claude needs settled before it builds appear here."
      }
    ) : /* @__PURE__ */ jsx17("div", { className: "question-list", children: shown.map((q) => /* @__PURE__ */ jsx17(QuestionCard, { plan, question: q }, q.id)) }),
    /* @__PURE__ */ jsx17(AskClaude, {})
  ] });
}
function rank(q) {
  if (!q.answer && q.askedBy === "claude") return 0;
  if (!q.answer) return 1;
  return 2;
}
function QuestionCard({ plan, question }) {
  const [selected, setSelected] = useState14(question.answer?.selected ?? []);
  const [text, setText] = useState14(question.answer?.text ?? "");
  const [comments, setComments] = useState14(false);
  const [confirming, setConfirming] = useState14(false);
  const answer = question.answer;
  const task = question.taskId ? plan.tasks.find((t) => t.id === question.taskId) : void 0;
  const target = { kind: "question", id: question.id };
  const forYou = question.askedBy === "claude";
  useEffect11(() => {
    setSelected(question.answer?.selected ?? []);
    setText(question.answer?.text ?? "");
  }, [question.answer?.at]);
  const dirty = (answer?.text ?? "") !== text || (answer?.selected ?? []).join("\0") !== selected.join("\0");
  const pick = (label) => {
    if (question.multiSelect) setSelected((cur) => cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]);
    else setSelected((cur) => cur[0] === label ? [] : [label]);
  };
  const save = () => void store.op({ op: "answer", id: question.id, selected, text });
  return /* @__PURE__ */ jsxs16(Focusable, { kind: "question", id: question.id, as: "article", className: classNames("question-card", answer ? "is-answered" : "is-open", forYou && "is-for-you"), children: [
    /* @__PURE__ */ jsxs16("header", { className: "item-head", children: [
      question.header && /* @__PURE__ */ jsx17("span", { className: "qchip", children: question.header }),
      /* @__PURE__ */ jsxs16("span", { className: "muted", children: [
        forYou ? "Claude asks" : "You asked",
        " \xB7 ",
        relativeTime(question.createdAt)
      ] }),
      task && /* @__PURE__ */ jsxs16("button", { type: "button", className: "chip", onClick: () => store.focus("task", task.id), children: [
        "holds up: ",
        task.title
      ] }),
      /* @__PURE__ */ jsx17("span", { className: "spacer" }),
      /* @__PURE__ */ jsx17(CommentToggle, { target, label: question.question, open: comments, onToggle: () => setComments((v) => !v) }),
      confirming ? /* @__PURE__ */ jsxs16("span", { className: "item-confirm", children: [
        "Remove?",
        /* @__PURE__ */ jsx17("button", { type: "button", className: "link is-danger", onClick: () => void store.op({ op: "remove", kind: "question", id: question.id }), children: "Remove" }),
        /* @__PURE__ */ jsx17("button", { type: "button", className: "link", onClick: () => setConfirming(false), children: "Keep" })
      ] }) : /* @__PURE__ */ jsx17("button", { type: "button", className: "icon-btn is-tiny is-danger", "aria-label": `Remove question ${question.question}`, onClick: () => setConfirming(true), children: "\xD7" })
    ] }),
    /* @__PURE__ */ jsx17(
      InlineText,
      {
        as: "h2",
        className: "question-text",
        value: question.question,
        label: "Question",
        onSave: (q) => store.op({ op: "upsert_question", id: question.id, question: q })
      }
    ),
    question.context && /* @__PURE__ */ jsx17(Markdown, { source: question.context, className: "question-context" }),
    forYou || answer ? /* @__PURE__ */ jsxs16(Fragment4, { children: [
      question.options.length > 0 && /* @__PURE__ */ jsx17("div", { className: "qoptions", role: question.multiSelect ? "group" : "radiogroup", "aria-label": question.question, children: question.options.map((o) => {
        const on = selected.includes(o.label);
        return /* @__PURE__ */ jsxs16(
          "button",
          {
            type: "button",
            role: question.multiSelect ? "checkbox" : "radio",
            "aria-checked": on,
            className: classNames("qoption", on && "is-selected"),
            onClick: () => pick(o.label),
            children: [
              /* @__PURE__ */ jsx17("span", { className: classNames("qoption-mark", question.multiSelect && "is-multi"), "aria-hidden": "true", children: on ? "\u2713" : "" }),
              /* @__PURE__ */ jsxs16("span", { className: "qoption-body", children: [
                /* @__PURE__ */ jsx17("span", { className: "qoption-label", children: o.label }),
                o.description && /* @__PURE__ */ jsx17("span", { className: "qoption-desc", children: o.description })
              ] })
            ]
          },
          o.label
        );
      }) }),
      /* @__PURE__ */ jsx17(
        "textarea",
        {
          className: "input",
          rows: 2,
          value: text,
          "aria-label": `Answer to: ${question.question}`,
          placeholder: question.options.length ? "Add a note, or answer in your own words\u2026" : "Your answer\u2026",
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty) {
              e.preventDefault();
              save();
            }
          }
        }
      ),
      /* @__PURE__ */ jsxs16("footer", { className: "question-foot", children: [
        answer ? /* @__PURE__ */ jsxs16("span", { className: "muted", children: [
          /* @__PURE__ */ jsx17(AuthorBadge, { author: answer.by }),
          " answered ",
          relativeTime(answer.at)
        ] }) : /* @__PURE__ */ jsx17("span", { className: "muted", children: "Saved to the plan. Claude reads it when you next ask it to." }),
        /* @__PURE__ */ jsx17("span", { className: "spacer" }),
        answer && /* @__PURE__ */ jsx17("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: () => void store.op({ op: "clear_answer", id: question.id }), children: "Reopen" }),
        /* @__PURE__ */ jsx17("button", { type: "button", className: "btn btn-sm btn-primary", disabled: !dirty || !text.trim() && selected.length === 0, onClick: save, children: answer ? "Update answer" : "Save answer" })
      ] })
    ] }) : /* @__PURE__ */ jsx17("p", { className: "question-waiting", children: "Waiting for Claude. It sees this question the next time you ask it to read the plan." }),
    comments && /* @__PURE__ */ jsx17(ThreadPanel, { target, label: question.question })
  ] });
}
function AskClaude() {
  const [question, setQuestion] = useState14("");
  const [context, setContext] = useState14("");
  const [open, setOpen] = useState14(false);
  if (!open) {
    return /* @__PURE__ */ jsx17("button", { type: "button", className: "btn ask-open", onClick: () => setOpen(true), children: "+ Ask Claude a question" });
  }
  return /* @__PURE__ */ jsxs16(
    "form",
    {
      className: "ask",
      onSubmit: async (e) => {
        e.preventDefault();
        if (!question.trim()) return;
        const ok = await store.op({ op: "upsert_question", question, ...context.trim() ? { context } : {} });
        if (ok) {
          setQuestion("");
          setContext("");
          setOpen(false);
        }
      },
      children: [
        /* @__PURE__ */ jsx17("h2", { className: "doc-label", children: "Ask Claude" }),
        /* @__PURE__ */ jsx17("input", { className: "input", value: question, autoFocus: true, placeholder: "What should Claude look into or decide?", "aria-label": "Question for Claude", onChange: (e) => setQuestion(e.target.value) }),
        /* @__PURE__ */ jsx17(MarkdownField, { value: context, label: "context for the question", placeholder: "No context.", emptyAction: "Add context", rows: 3, onSave: setContext }),
        /* @__PURE__ */ jsxs16("div", { className: "md-field-foot", children: [
          /* @__PURE__ */ jsx17("span", { className: "muted", children: "Claude answers it here when it next reads the plan." }),
          /* @__PURE__ */ jsx17("span", { className: "spacer" }),
          /* @__PURE__ */ jsx17("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: () => setOpen(false), children: "Cancel" }),
          /* @__PURE__ */ jsx17("button", { type: "submit", className: "btn btn-sm btn-primary", disabled: !question.trim(), children: "Add question" })
        ] })
      ]
    }
  );
}
var init_QuestionsView = __esm({
  "src/ui/views/QuestionsView.tsx"() {
    "use strict";
    init_store();
    init_Editable();
    init_Threads();
    init_Item();
    init_primitives();
    init_Markdown();
    init_format();
  }
});

// src/ui/views/ActivityView.tsx
import { useState as useState15 } from "react";
import { Fragment as Fragment5, jsx as jsx18, jsxs as jsxs17 } from "react/jsx-runtime";
function ActivityView() {
  const plan = usePlan();
  const [filter, setFilter] = useState15("all");
  if (!plan) return null;
  const changes = [...plan.changes].reverse().filter((c) => filter === "all" || c.author === filter);
  const markerAt = changes.findIndex((c) => c.seq <= plan.claudeReadSeq);
  return /* @__PURE__ */ jsxs17("div", { className: "view-pad", children: [
    /* @__PURE__ */ jsxs17("div", { className: "toolbar", children: [
      /* @__PURE__ */ jsx18("div", { className: "segmented", role: "group", "aria-label": "Show changes by", children: ["all", "user", "claude"].map((f) => /* @__PURE__ */ jsx18("button", { type: "button", className: classNames("seg", filter === f && "is-active"), "aria-pressed": filter === f, onClick: () => setFilter(f), children: f === "all" ? "Everyone" : f === "user" ? "You" : "Claude" }, f)) }),
      /* @__PURE__ */ jsx18("span", { className: "spacer" }),
      /* @__PURE__ */ jsx18("span", { className: "muted", children: plan.claudeReadAt ? `Claude last read the plan ${relativeTime(plan.claudeReadAt)}` : "Claude has not read the plan back yet" })
    ] }),
    changes.length === 0 ? /* @__PURE__ */ jsx18(EmptyState, { title: "No changes yet" }) : /* @__PURE__ */ jsx18("ol", { className: "activity", children: changes.map((c, i) => /* @__PURE__ */ jsx18(Row, { change: c, marker: i === markerAt && i > 0, exists: targetExists(plan, c.target), unread: c.seq > plan.claudeReadSeq && c.author === "user" }, c.seq)) })
  ] });
}
function Row({ change, marker, exists, unread }) {
  const linkable = exists && change.target.kind !== "plan" && change.kind !== "deleted";
  return /* @__PURE__ */ jsxs17(Fragment5, { children: [
    marker && /* @__PURE__ */ jsx18("li", { className: "activity-marker", "aria-label": "Claude has read everything below this line", children: /* @__PURE__ */ jsx18("span", { children: "Claude has read everything below" }) }),
    /* @__PURE__ */ jsxs17("li", { className: classNames("activity-row", `by-${change.author}`, unread && "is-unread"), children: [
      /* @__PURE__ */ jsx18(AuthorBadge, { author: change.author }),
      /* @__PURE__ */ jsx18("span", { className: "activity-text", children: change.summary }),
      linkable && /* @__PURE__ */ jsx18("button", { type: "button", className: "link", onClick: () => store.focus(change.target.kind, change.target.id), children: "Show" }),
      /* @__PURE__ */ jsx18("span", { className: "spacer" }),
      unread && /* @__PURE__ */ jsx18("span", { className: "chip is-warning", children: "unread by Claude" }),
      /* @__PURE__ */ jsxs17("time", { className: "muted", dateTime: new Date(change.ts).toISOString(), title: new Date(change.ts).toLocaleString(), children: [
        relativeTime(change.ts),
        " \xB7 ",
        clockTime(change.ts)
      ] })
    ] })
  ] });
}
var init_ActivityView = __esm({
  "src/ui/views/ActivityView.tsx"() {
    "use strict";
    init_store();
    init_Threads();
    init_primitives();
    init_format();
    init_plan();
  }
});

// src/ui/App.tsx
var App_exports = {};
__export(App_exports, {
  App: () => App
});
import { useCallback as useCallback2, useEffect as useEffect12, useRef as useRef5 } from "react";
import { Fragment as Fragment6, jsx as jsx19, jsxs as jsxs18 } from "react/jsx-runtime";
function App() {
  const session = useSession();
  const sessionId = useStore((s) => s.sessionId);
  const tab = useStore((s) => s.tab);
  const error = useStore((s) => s.error);
  const sidebarCollapsed = useStore((s) => s.collapsedSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const tabs = useRef5(null);
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
  return /* @__PURE__ */ jsxs18("div", { className: classNames("app", sidebarCollapsed && "is-sidebar-collapsed", drawerOpen && "is-drawer-open"), children: [
    /* @__PURE__ */ jsx19("a", { className: "skip-link", href: `#${panelId(tab)}`, children: "Skip to content" }),
    /* @__PURE__ */ jsx19(Sidebar, {}),
    drawerOpen && /* @__PURE__ */ jsx19("button", { type: "button", className: "scrim", "aria-label": "Close the session list", onClick: () => store.setDrawer(false) }),
    /* @__PURE__ */ jsx19("main", { className: "main", "aria-label": "Plan", children: !sessionId || !session ? /* @__PURE__ */ jsx19(NoSession, { error }) : /* @__PURE__ */ jsxs18(Fragment6, { children: [
      /* @__PURE__ */ jsx19(Header, { session }),
      /* @__PURE__ */ jsx19(ConnectionBar, {}),
      !plan ? /* @__PURE__ */ jsx19(NoPlan, { session }) : /* @__PURE__ */ jsxs18(Fragment6, { children: [
        /* @__PURE__ */ jsx19("nav", { className: "tabs", role: "tablist", "aria-label": "Plan views", ref: tabs, onKeyDown: onTabKeyDown, children: TAB_IDS.map((t) => /* @__PURE__ */ jsx19(TabButton, { id: t, active: tab === t, plan }, t)) }),
        /* @__PURE__ */ jsxs18("div", { className: "view", id: panelId(tab), role: "tabpanel", "aria-labelledby": tabId(tab), tabIndex: -1, children: [
          tab === "overview" && /* @__PURE__ */ jsx19(OverviewView, {}),
          tab === "diagrams" && /* @__PURE__ */ jsx19(DiagramsView, {}),
          tab === "tasks" && /* @__PURE__ */ jsx19(TasksView, {}),
          tab === "questions" && /* @__PURE__ */ jsx19(QuestionsView, {}),
          tab === "activity" && /* @__PURE__ */ jsx19(ActivityView, {})
        ] }, tab)
      ] })
    ] }) }),
    /* @__PURE__ */ jsx19(Toasts, {})
  ] });
}
function TabButton({ id, active, plan }) {
  const badge = tabBadge(id, plan);
  return /* @__PURE__ */ jsxs18(
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
        badge && /* @__PURE__ */ jsxs18(Fragment6, { children: [
          /* @__PURE__ */ jsx19("span", { className: classNames("tab-badge", `is-${badge.tone}`), "aria-hidden": "true", children: badge.text }),
          /* @__PURE__ */ jsx19("span", { className: "sr-only", children: badge.label })
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
    case "questions": {
      const forYou = plan.questions.filter((q) => !q.answer && q.askedBy === "claude").length;
      if (forYou) return { text: String(forYou), tone: "warning", label: `${forYou} question(s) from Claude to answer` };
      const open = plan.questions.filter((q) => !q.answer).length;
      return open ? { text: String(open), tone: "neutral", label: `${open} open question(s)` } : null;
    }
    case "activity": {
      const unread = unreadByClaude(plan).length;
      return unread ? { text: String(unread), tone: "accent", label: `${unread} change(s) Claude has not read` } : null;
    }
    default:
      return null;
  }
}
function Header({ session }) {
  const drawerOpen = useStore((s) => s.drawerOpen);
  const saving = useStore((s) => s.saving);
  const plan = session.plan;
  const counts = countTasks(plan);
  return /* @__PURE__ */ jsxs18("header", { className: "head", children: [
    /* @__PURE__ */ jsxs18("div", { className: "head-main", children: [
      /* @__PURE__ */ jsx19(
        "button",
        {
          type: "button",
          className: "icon-btn drawer-toggle",
          "aria-label": "Open the session list",
          "aria-expanded": drawerOpen,
          onClick: () => store.setDrawer(true),
          children: /* @__PURE__ */ jsx19("span", { "aria-hidden": "true", children: "\u2630" })
        }
      ),
      plan ? /* @__PURE__ */ jsx19(
        InlineText,
        {
          as: "h1",
          className: "head-title",
          value: plan.title,
          label: "Plan title",
          onSave: (title) => store.op({ op: "set_meta", title })
        }
      ) : /* @__PURE__ */ jsx19("h1", { className: "head-title", children: session.title }),
      saving > 0 && /* @__PURE__ */ jsx19("span", { className: "muted head-saving", children: "saving\u2026" }),
      /* @__PURE__ */ jsx19("span", { className: "spacer" }),
      /* @__PURE__ */ jsx19(Handoff, {}),
      /* @__PURE__ */ jsx19(ThemeToggle, {})
    ] }),
    /* @__PURE__ */ jsxs18("div", { className: "head-meta", children: [
      /* @__PURE__ */ jsx19("span", { className: classNames("head-status", `is-${session.status}`), title: "The Claude session this plan belongs to", children: session.status === "active" ? "Claude is working" : session.status === "idle" ? "Claude is idle" : "session ended" }),
      plan && plan.title !== session.title && /* @__PURE__ */ jsx19("span", { className: "head-stat", children: session.title }),
      session.branch && /* @__PURE__ */ jsx19("code", { className: "head-branch", children: session.branch }),
      counts.total > 0 && /* @__PURE__ */ jsxs18("span", { className: "head-progress", children: [
        /* @__PURE__ */ jsx19(ProgressBar, { counts, compact: true }),
        /* @__PURE__ */ jsxs18("span", { className: "head-stat", children: [
          counts.done,
          "/",
          counts.total,
          " tasks"
        ] })
      ] }),
      /* @__PURE__ */ jsx19("span", { className: "head-path", title: session.cwd, children: session.cwd })
    ] })
  ] });
}
function NoPlan({ session }) {
  return /* @__PURE__ */ jsx19("div", { className: "view", children: /* @__PURE__ */ jsx19(
    EmptyState,
    {
      title: "No plan yet",
      hint: /* @__PURE__ */ jsxs18(Fragment6, { children: [
        "In Claude's chat, run ",
        /* @__PURE__ */ jsx19("code", { children: "/harness <what you want to build>" }),
        ". Claude investigates the code, then publishes its plan here \u2014 architecture, diagrams, a task breakdown and the questions it needs answered."
      ] }),
      action: /* @__PURE__ */ jsx19("button", { type: "button", className: "btn", onClick: () => void store.op({ op: "set_meta", title: session.title || "Untitled plan" }), children: "Start a plan by hand" })
    }
  ) });
}
function NoSession({ error }) {
  return /* @__PURE__ */ jsx19("div", { className: "view", children: /* @__PURE__ */ jsx19(
    EmptyState,
    {
      title: "No session yet",
      hint: /* @__PURE__ */ jsxs18(Fragment6, { children: [
        "Start Claude Code in a project with the harness enabled, then run ",
        /* @__PURE__ */ jsx19("code", { children: "/harness" }),
        ". Sessions appear here the moment they register.",
        error && /* @__PURE__ */ jsxs18("span", { className: "error-text", children: [
          " \xB7 ",
          error
        ] })
      ] }),
      action: /* @__PURE__ */ jsxs18("p", { className: "empty-hint", children: [
        "If a session is running and nothing shows up, the hooks are not firing \u2014 run ",
        /* @__PURE__ */ jsx19("code", { children: "harness doctor" }),
        "."
      ] })
    }
  ) });
}
function useDocumentTitle(session) {
  const title = session?.plan?.title ?? session?.title ?? "cc-harness";
  useEffect12(() => {
    document.title = `${title} \u2014 plan`;
  }, [title]);
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
    init_OverviewView();
    init_DiagramsView();
    init_TasksView();
    init_QuestionsView();
    init_ActivityView();
    init_format();
    init_plan();
    TAB_LABEL = {
      overview: "Overview",
      diagrams: "Diagrams",
      tasks: "Tasks",
      questions: "Questions",
      activity: "Activity"
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
      return {
        ok: true,
        status: 200,
        statusText: "OK",
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
import { jsx as jsx20 } from "react/jsx-runtime";
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
    openQuestions: 0,
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
  render(/* @__PURE__ */ jsx20(App2, {}));
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
test("a row shows the plan, its progress, and what Claude has not read", async () => {
  const now = Date.now();
  await boot(() => [
    {
      ...summary("s1", "repo", now),
      planTitle: "Cache rewrite",
      tasks: { total: 5, done: 2, inProgress: 1, blocked: 0 },
      openQuestions: 2,
      unreadByClaude: 3
    }
  ]);
  const row = rowFor("Cache rewrite");
  assert.ok(row, "the plan title names the row");
  assert.match(row.textContent ?? "", /2\/5 tasks/);
  assert.match(row.textContent ?? "", /2 open q/);
  assert.match(row.textContent ?? "", /3 unread/);
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
