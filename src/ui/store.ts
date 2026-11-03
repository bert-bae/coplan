import { useSyncExternalStore } from 'react';
import { api } from './lib/api.ts';
import type { CleanupGroupId, Plan, PlanOp, ServerEvent, SessionState, SessionSummary, StorageReport } from '../shared/types.ts';

export type Tab = 'diagrams' | 'tasks' | 'overview';
/** The architecture comes first: it is where most of the plan is decided. */
export const TAB_IDS: Tab[] = ['diagrams', 'tasks', 'overview'];

export type TaskMode = 'outline' | 'board';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface UiState {
  sessions: SessionSummary[];
  sessionId: string | null;
  session: SessionState | null;
  tab: Tab;
  /** The diagram open on the Architecture tab; the first one when unset. */
  diagramId: string | null;
  connection: ConnectionState;
  /** How the task tree is laid out: an editable outline, or status columns. */
  taskMode: TaskMode;
  /** Hide finished tasks in the outline. */
  hideDone: boolean;
  /** Tasks whose subtasks are folded away in the outline, by id. */
  collapsedTasks: string[];
  collapsedSidebar: boolean;
  /** The narrow-width sidebar drawer. Never persisted. */
  drawerOpen: boolean;
  pinned: string[];
  collapsedProjects: string[];
  /** Bumped to ask a view to scroll an item into view: `kind:id`. */
  focusTarget: string | null;
  storage: StorageReport | null;
  storageBusy: boolean;
  restarting: boolean;
  /** Edits in flight, so controls can say they are saving. */
  saving: number;
  toasts: Toast[];
  error: string | null;
}

const initial: UiState = {
  sessions: [],
  sessionId: null,
  session: null,
  tab: 'diagrams',
  diagramId: null,
  connection: 'connecting',
  taskMode: 'outline',
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
  error: null,
};

const PREFS_KEY = 'cc-harness:prefs';

/**
 * A tiny external store read through `useSyncExternalStore`.
 *
 * The daemon owns the plan and pushes it over SSE; the client holds that
 * snapshot plus a little local state — which tab is open, how the task tree
 * is laid out. Edits are sent as ops and the daemon's answer replaces the
 * plan, so the page never shows a version the daemon did not accept.
 */
class Store {
  private state: UiState = { ...initial, ...loadPrefs() };
  private listeners = new Set<() => void>();
  private source: EventSource | null = null;
  private reconnectTimer: number | undefined;

  getState = (): UiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  async init(): Promise<void> {
    // Drop the one-time token from the address bar so copied links are clean.
    const url = new URL(window.location.href);
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      window.history.replaceState({}, '', `${url.pathname}${url.hash}`);
    }

    try {
      const { sessions } = await api.sessions();
      this.set({ sessions });
      const target = readHash() ?? sessions[0]?.sessionId ?? null;
      if (target) await this.selectSession(target, false);
    } catch (err) {
      this.set({ error: describeError(err) });
    }

    // Selecting a session opens the stream; with none to select, open it for
    // the session list alone.
    if (!this.source) this.connect();
    window.addEventListener('hashchange', () => {
      const id = readHash();
      if (id && id !== this.state.sessionId) void this.selectSession(id, false);
    });
  }

  async selectSession(id: string, updateHash = true): Promise<void> {
    if (updateHash) window.location.hash = `#/session/${id}`;
    this.set({ sessionId: id, session: null, diagramId: null, error: null });
    this.connect();
    try {
      const { session } = await api.session(id);
      // Clicking through the rail quickly: only the last choice may land.
      if (this.state.sessionId === id) this.set({ session });
    } catch (err) {
      if (this.state.sessionId === id) this.set({ error: describeError(err) });
    }
  }

  /* ---------------------------------------------------------------- *
   * Live connection
   * ---------------------------------------------------------------- */

  private connect(): void {
    this.source?.close();
    window.clearTimeout(this.reconnectTimer);
    const query = this.state.sessionId ? `?session=${encodeURIComponent(this.state.sessionId)}` : '';
    const source = new EventSource(`/api/events${query}`);
    this.source = source;
    source.onopen = () => this.set({ connection: 'live' });
    source.onerror = () => {
      this.set({ connection: 'reconnecting' });
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => void this.resync(), 5000);
    };
    source.onmessage = (message) => {
      try {
        this.apply(JSON.parse(message.data as string) as ServerEvent);
      } catch {
        /* a malformed frame is not worth breaking the UI over */
      }
    };
  }

  private async resync(): Promise<void> {
    if (this.state.connection === 'live' || !this.state.sessionId) return;
    try {
      const { session } = await api.session(this.state.sessionId);
      this.set({ session, connection: 'live' });
    } catch {
      /* the EventSource keeps retrying */
    }
  }

  apply(event: ServerEvent): void {
    switch (event.type) {
      case 'sessions':
        this.set({ sessions: event.sessions });
        return;
      case 'snapshot': {
        if (event.session.sessionId !== this.state.sessionId) return;
        const before = this.state.session?.plan;
        const after = event.session.plan;
        // Claude rewriting the plan under the reader is worth a word.
        if (before && after && after.revision > before.revision) {
          this.toast('info', `Claude published revision ${after.revision} of the plan.`);
        }
        this.set({ session: event.session });
        return;
      }
      case 'ping':
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
  async ops(ops: PlanOp[]): Promise<boolean> {
    return (await this.commit(ops)) !== null;
  }

  /**
   * Send edits, and resolve with the plan exactly as the daemon left it after
   * them — or null when they were refused. Callers that build on the result
   * (the canvas's revision) need the daemon's answer, not whatever the store
   * holds by the time it arrives.
   */
  async commit(ops: PlanOp[], sessionId: string | null = this.state.sessionId): Promise<Plan | null> {
    // A caller bound to one session's plan (the canvas) names it, so a save
    // still queued when the user switches sessions lands where it was made.
    const id = sessionId;
    if (!id || ops.length === 0) return null;
    this.set({ saving: this.state.saving + 1 });
    try {
      const { plan } = await api.ops(id, ops);
      const session = this.state.session;
      // The live stream may already have delivered something newer — a change
      // Claude made right after this one, or another tab's drag. Never roll
      // the page back to it. `version` counts layout saves too; `seq` does not.
      // A daemon started before `version` existed sends none; fall back to seq.
      const order = (p: Plan) => p.version ?? p.seq;
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

  op(op: PlanOp): Promise<boolean> {
    return this.ops([op]);
  }

  /** Jump to an item from anywhere: a board card, the overview's "now". */
  focus(kind: string, id: string): void {
    const tab: Tab = kind === 'diagram' ? 'diagrams' : kind === 'task' ? 'tasks' : 'overview';
    if (kind === 'diagram') this.set({ diagramId: id });
    if (kind === 'node') {
      // `node:<diagram>:<node>` — open that diagram; the editor selects the box.
      const [diagramId] = id.split(':');
      this.set({ tab: 'diagrams', diagramId: diagramId ?? null, focusTarget: `node:${id}` });
      return;
    }
    if (kind === 'task') {
      // Unfold every ancestor so the row actually exists to scroll to.
      const tasks = this.state.session?.plan?.tasks ?? [];
      const ancestors = new Set<string>();
      let cursor = tasks.find((t) => t.id === id)?.parentId ?? null;
      while (cursor) {
        ancestors.add(cursor);
        cursor = tasks.find((t) => t.id === cursor)?.parentId ?? null;
      }
      this.set({ collapsedTasks: this.state.collapsedTasks.filter((t) => !ancestors.has(t)), taskMode: 'outline' });
    }
    this.set({ tab, focusTarget: `${kind}:${id}` });
  }

  /* ---------------------------------------------------------------- *
   * Local preferences
   * ---------------------------------------------------------------- */

  setTab(tab: Tab): void {
    this.set({ tab });
  }

  private persistPrefs(): void {
    savePrefs({
      collapsedSidebar: this.state.collapsedSidebar,
      pinned: this.state.pinned,
      collapsedProjects: this.state.collapsedProjects,
      taskMode: this.state.taskMode,
      hideDone: this.state.hideDone,
      collapsedTasks: this.state.collapsedTasks,
    });
  }

  setTaskMode(taskMode: TaskMode): void {
    this.set({ taskMode });
    this.persistPrefs();
  }

  toggleHideDone(): void {
    this.set({ hideDone: !this.state.hideDone });
    this.persistPrefs();
  }

  toggleTaskCollapsed(id: string): void {
    const collapsedTasks = this.state.collapsedTasks.includes(id)
      ? this.state.collapsedTasks.filter((t) => t !== id)
      : [...this.state.collapsedTasks, id];
    this.set({ collapsedTasks });
    this.persistPrefs();
  }

  toggleSidebar(): void {
    this.set({ collapsedSidebar: !this.state.collapsedSidebar });
    this.persistPrefs();
  }

  setDrawer(drawerOpen: boolean): void {
    if (this.state.drawerOpen !== drawerOpen) this.set({ drawerOpen });
  }

  togglePin(sessionId: string): void {
    const pinned = this.state.pinned.includes(sessionId)
      ? this.state.pinned.filter((id) => id !== sessionId)
      : [...this.state.pinned, sessionId];
    this.set({ pinned });
    this.persistPrefs();
  }

  toggleProject(key: string): void {
    const collapsedProjects = this.state.collapsedProjects.includes(key)
      ? this.state.collapsedProjects.filter((k) => k !== key)
      : [...this.state.collapsedProjects, key];
    this.set({ collapsedProjects });
    this.persistPrefs();
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const next = title.trim();
    if (!next) return;
    this.set({
      sessions: this.state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, title: next } : s)),
      ...(this.state.session?.sessionId === sessionId ? { session: { ...this.state.session, title: next } } : {}),
    });
    try {
      await api.renameSession(sessionId, next);
    } catch (err) {
      this.fail(err);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
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
      window.location.hash = '';
      const next = sessions[0]?.sessionId;
      if (next) await this.selectSession(next);
    }
    this.toast('success', 'Session deleted.');
  }

  /* ---------------------------------------------------------------- *
   * Daemon-wide actions
   * ---------------------------------------------------------------- */

  async loadStorage(): Promise<void> {
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

  async cleanStorage(groups: CleanupGroupId[]): Promise<void> {
    if (groups.length === 0) return;
    this.set({ storageBusy: true });
    try {
      const { result, report } = await api.cleanStorage(groups);
      this.set({ storage: report });
      if (result.failed.length) this.toast('error', `${result.failed.length} item(s) could not be removed.`);
      else if (result.removed === 0) this.toast('info', 'Nothing left to clean up.');
      else this.toast('success', `Reclaimed ${formatBytes(result.freedBytes)}.`);
    } catch (err) {
      this.fail(err);
    } finally {
      this.set({ storageBusy: false });
    }
  }

  /** Restart the daemon, then reload once a *different* process answers. */
  async restartDaemon(waitMs = 20_000): Promise<void> {
    if (this.state.restarting) return;
    let previousPid = 0;
    try {
      previousPid = (await api.health()).pid;
    } catch {
      /* fall back to waiting for any answer */
    }
    try {
      const { restarting } = await api.restartDaemon();
      if (!restarting) {
        this.toast('error', 'The daemon is already shutting down.');
        return;
      }
      this.set({ restarting: true, connection: 'reconnecting' });
    } catch (err) {
      this.fail(err);
      return;
    }
    const arrived = await waitForDaemon(previousPid, waitMs);
    if (!arrived) {
      this.set({ restarting: false });
      this.toast('error', 'The daemon did not come back. Run `harness start` in a terminal.');
      return;
    }
    this.reloadPage();
  }

  /** Overridable because jsdom will not let a test redefine `location.reload`. */
  reloadPage = (): void => window.location.reload();

  /* ---------------------------------------------------------------- *
   * Notices
   * ---------------------------------------------------------------- */

  toast(kind: Toast['kind'], text: string): void {
    const toast: Toast = { id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, kind, text };
    this.set({ toasts: [...this.state.toasts, toast] });
    window.setTimeout(() => this.dismissToast(toast.id), kind === 'error' ? 8000 : 4000);
  }

  dismissToast(id: string): void {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  fail(err: unknown): void {
    this.toast('error', describeError(err));
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function waitForDaemon(previousPid: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    try {
      const health = await api.health();
      if (health.ok && health.pid !== previousPid) return true;
    } catch {
      /* mid-handover */
    }
  }
  return false;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readHash(): string | null {
  const match = /^#\/session\/([^/?]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

function loadPrefs(): Partial<UiState> {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const prefs: Partial<UiState> = {};
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    if (typeof saved['collapsedSidebar'] === 'boolean') prefs.collapsedSidebar = saved['collapsedSidebar'];
    if (Array.isArray(saved['pinned'])) prefs.pinned = strings(saved['pinned']);
    if (Array.isArray(saved['collapsedProjects'])) prefs.collapsedProjects = strings(saved['collapsedProjects']);
    if (Array.isArray(saved['collapsedTasks'])) prefs.collapsedTasks = strings(saved['collapsedTasks']);
    if (saved['taskMode'] === 'outline' || saved['taskMode'] === 'board') prefs.taskMode = saved['taskMode'];
    if (typeof saved['hideDone'] === 'boolean') prefs.hideDone = saved['hideDone'];
    return prefs;
  } catch {
    return {};
  }
}

function savePrefs(prefs: Record<string, unknown>): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export const store = new Store();

/* ------------------------------------------------------------------ *
 * React bindings
 * ------------------------------------------------------------------ */

export function useStore<T>(select: (state: UiState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState()),
  );
}

export function useSession(): SessionState | null {
  return useStore((s) => s.session);
}

export function usePlan() {
  return useStore((s) => s.session?.plan ?? null);
}
