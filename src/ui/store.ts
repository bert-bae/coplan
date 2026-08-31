import { useSyncExternalStore } from 'react';
import { api } from './lib/api.ts';
import { armAudio, playAlert } from './lib/sound.ts';
import type {
  CleanupGroupId,
  DiffPayload,
  Gate,
  GateKind,
  ReviewThread,
  ServerEvent,
  SessionState,
  SessionSummary,
  StorageReport,
} from '../shared/types.ts';

export type Tab = 'timeline' | 'plan' | 'board' | 'review' | 'verify' | 'ship';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

/** A comment the user is composing. It is theirs until they submit the review. */
export interface DraftComment extends ReviewThread {
  /** Local-only: never sent, used to distinguish drafts from delivered threads. */
  draft: true;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface UiState {
  sessions: SessionSummary[];
  sessionId: string | null;
  session: SessionState | null;
  diff: DiffPayload | null;
  diffLoading: boolean;
  tab: Tab;
  connection: ConnectionState;
  /** Unsubmitted line comments, keyed by session so switching never loses them. */
  drafts: Record<string, DraftComment[]>;
  diffMode: 'unified' | 'split';
  selectedFile: string | null;
  /** Files the user has ticked off while reviewing, per session. */
  viewedFiles: Record<string, string[]>;
  collapsedSidebar: boolean;
  /** Session ids the user pinned to the top of the sidebar. Local-only: which
   *  sessions matter to *this* reader is not something the daemon can know. */
  pinned: string[];
  /** Project groups the user has folded shut, keyed by repo root (or cwd). */
  collapsedProjects: string[];
  /** Play a chime when a session starts waiting on the user. */
  soundEnabled: boolean;
  /** Bumped to pull the question card into view from anywhere in the app. */
  gateFocus: number;
  /** What the harness has left on disk. Null until the panel asks for it. */
  storage: StorageReport | null;
  storageBusy: boolean;
  /** A handover is in flight; every request will fail until it lands. */
  restarting: boolean;
  toasts: Toast[];
  error: string | null;
}

const initial: UiState = {
  sessions: [],
  sessionId: null,
  session: null,
  diff: null,
  diffLoading: false,
  tab: 'timeline',
  connection: 'connecting',
  drafts: {},
  diffMode: 'unified',
  selectedFile: null,
  viewedFiles: {},
  collapsedSidebar: false,
  pinned: [],
  collapsedProjects: [],
  soundEnabled: true,
  gateFocus: 0,
  storage: null,
  storageBusy: false,
  restarting: false,
  toasts: [],
  error: null,
};

const DRAFTS_KEY = 'cc-harness:drafts';
const PREFS_KEY = 'cc-harness:prefs';

/**
 * A tiny external store read through `useSyncExternalStore`.
 *
 * Deliberately not a reducer library: the daemon owns nearly all state and
 * pushes it over SSE, so the client's job is to hold the server snapshot plus
 * a small amount of genuinely local state — unsubmitted comments, which tab
 * is open, which files have been marked viewed.
 */
class Store {
  private state: UiState = { ...initial, ...loadPrefs(), drafts: loadDrafts() };
  private listeners = new Set<() => void>();
  private source: EventSource | null = null;
  private reconnectTimer: number | undefined;
  private lastAlertAt = 0;

  getState = (): UiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Every mutation goes through here so the snapshot identity always changes. */
  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  async init(): Promise<void> {
    // Browsers will not let a page make noise before it has been touched, so
    // the audio context waits for the first click or keypress.
    armAudio();

    // The token arrives once in the query string and the daemon swaps it for a
    // cookie; drop it from the address bar so links the user copies are clean.
    const url = new URL(window.location.href);
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      window.history.replaceState({}, '', `${url.pathname}${url.hash}`);
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
    window.addEventListener('hashchange', () => {
      const id = readHash();
      if (id && id !== this.state.sessionId) void this.selectSession(id, false);
    });
  }

  async selectSession(id: string, updateHash = true): Promise<void> {
    if (updateHash) window.location.hash = `#/session/${id}`;
    this.set({ sessionId: id, session: null, diff: null, selectedFile: null, error: null });
    try {
      const { session, diff } = await api.session(id);
      this.set({ session, diff, tab: tabForSession(session) });
      if (!diff && session.stage === 'code_review') void this.refreshDiff(false);
    } catch (err) {
      this.set({ error: describeError(err) });
    }
    this.connect();
  }

  async refreshDiff(force = true): Promise<void> {
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

  private connect(): void {
    this.source?.close();
    window.clearTimeout(this.reconnectTimer);

    const query = this.state.sessionId ? `?session=${encodeURIComponent(this.state.sessionId)}` : '';
    const source = new EventSource(`/api/events${query}`);
    this.source = source;

    source.onopen = () => this.set({ connection: 'live' });
    source.onerror = () => {
      this.set({ connection: 'reconnecting' });
      // EventSource retries on its own, but a daemon restart changes the port
      // it was pointed at, so re-resolve the session after a beat.
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
      const { session, diff } = await api.session(this.state.sessionId);
      this.set({ session, diff, connection: 'live' });
    } catch {
      /* the EventSource keeps retrying */
    }
  }

  private apply(event: ServerEvent): void {
    const current = this.state.session;
    switch (event.type) {
      case 'ping':
        return;

      case 'sessions':
        // The session list is the only signal for a gate opening in a
        // session the user is not currently looking at — which, with several
        // sessions in the rail, is most of them.
        this.announceOtherSessions(this.state.sessions, event.sessions);
        this.set({ sessions: event.sessions });
        return;

      case 'snapshot':
        if (event.session.sessionId !== this.state.sessionId) return;
        this.announceGate(current, event.session);
        this.set({ session: event.session });
        return;

      case 'state': {
        if (event.sessionId !== this.state.sessionId || !current) return;
        const next = { ...current, ...event.patch };
        this.announceGate(current, next);
        this.set({ session: next });
        return;
      }

      case 'timeline': {
        if (event.sessionId !== this.state.sessionId || !current) return;
        const timeline = [...current.timeline, ...event.events].slice(-800);
        this.set({ session: { ...current, timeline } });
        return;
      }

      case 'diff':
        if (event.sessionId !== this.state.sessionId) return;
        this.set({ diff: event.diff, diffLoading: false });
        return;

      case 'tasks': {
        if (event.sessionId !== this.state.sessionId || !current) return;
        this.set({ session: { ...current, tasks: event.tasks } });
        return;
      }

      case 'check': {
        if (event.sessionId !== this.state.sessionId || !current) return;
        const checks = current.checks.some((c) => c.id === event.check.id)
          ? current.checks.map((c) => (c.id === event.check.id ? event.check : c))
          : [...current.checks, event.check];
        this.set({ session: { ...current, checks } });
        return;
      }
    }
  }

  /** A newly opened gate is the one thing that should pull the user in. */
  private announceGate(before: SessionState | null, after: SessionState): void {
    const wasOpen = before?.gates.find((g) => g.status === 'open')?.id;
    const nowOpen = after.gates.find((g) => g.status === 'open');
    if (!nowOpen || nowOpen.id === wasOpen) return;
    // A question is answerable from every tab, so do not yank the user out of
    // whatever they were reading to answer it.
    if (nowOpen.kind !== 'question') this.set({ tab: tabForGate(nowOpen) });
    this.toast('info', gateHeadline(nowOpen));
    notify(gateHeadline(nowOpen), after.title);
    this.alert();
  }

  /** The same announcement for sessions the user is not watching. */
  private announceOtherSessions(before: SessionSummary[], after: SessionSummary[]): void {
    if (before.length === 0) return; // the first list is not news
    const previous = new Map(before.map((s) => [s.sessionId, s.openGates]));
    for (const summary of after) {
      if (summary.sessionId === this.state.sessionId) continue; // announceGate has it
      const was = previous.get(summary.sessionId);
      if (was === undefined || summary.openGates <= was) continue;
      this.toast('info', `${summary.title} is waiting on you`);
      notify('Claude is waiting on you', summary.title);
      this.alert();
    }
  }

  /** One chime per burst: several sessions parking at once is one event. */
  private alert(): void {
    if (!this.state.soundEnabled) return;
    if (Date.now() - this.lastAlertAt < 1500) return;
    this.lastAlertAt = Date.now();
    playAlert();
  }

  /* ---------------------------------------------------------------- *
   * Draft comments
   * ---------------------------------------------------------------- */

  drafts(sessionId = this.state.sessionId): DraftComment[] {
    return (sessionId && this.state.drafts[sessionId]) || [];
  }

  private setDrafts(sessionId: string, drafts: DraftComment[]): void {
    const next = { ...this.state.drafts, [sessionId]: drafts };
    if (drafts.length === 0) delete next[sessionId];
    this.set({ drafts: next });
    saveDrafts(next);
  }

  addDraft(comment: Omit<DraftComment, 'draft'>): void {
    const id = this.state.sessionId;
    if (!id) return;
    this.setDrafts(id, [...this.drafts(id), { ...comment, draft: true }]);
  }

  updateDraft(commentId: string, body: string): void {
    const id = this.state.sessionId;
    if (!id) return;
    this.setDrafts(
      id,
      this.drafts(id).map((c) => (c.id === commentId ? { ...c, body } : c)),
    );
  }

  removeDraft(commentId: string): void {
    const id = this.state.sessionId;
    if (!id) return;
    this.setDrafts(
      id,
      this.drafts(id).filter((c) => c.id !== commentId),
    );
  }

  clearDrafts(sessionId = this.state.sessionId): void {
    if (!sessionId) return;
    this.setDrafts(sessionId, []);
  }

  /* ---------------------------------------------------------------- *
   * Local preferences
   * ---------------------------------------------------------------- */

  setTab(tab: Tab): void {
    this.set({ tab });
  }

  /** Persist the slice of state that is a preference rather than a snapshot. */
  private persistPrefs(): void {
    savePrefs({
      diffMode: this.state.diffMode,
      collapsedSidebar: this.state.collapsedSidebar,
      pinned: this.state.pinned,
      collapsedProjects: this.state.collapsedProjects,
      soundEnabled: this.state.soundEnabled,
    });
  }

  setDiffMode(diffMode: 'unified' | 'split'): void {
    this.set({ diffMode });
    this.persistPrefs();
  }

  toggleSidebar(): void {
    this.set({ collapsedSidebar: !this.state.collapsedSidebar });
    this.persistPrefs();
  }

  /** Pinned sessions sort to the top of their project, and above every other
   *  project. Purely a reading aid, so it lives in localStorage. */
  togglePin(sessionId: string): void {
    const pinned = this.state.pinned.includes(sessionId)
      ? this.state.pinned.filter((id) => id !== sessionId)
      : [...this.state.pinned, sessionId];
    this.set({ pinned });
    this.persistPrefs();
  }

  toggleSound(): void {
    const soundEnabled = !this.state.soundEnabled;
    this.set({ soundEnabled });
    this.persistPrefs();
    // Play the chime being switched on, so the user hears what they enabled.
    if (soundEnabled) playAlert();
  }

  /** Bring the open question into view from wherever the user is. */
  focusGate(): void {
    this.set({ gateFocus: this.state.gateFocus + 1 });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const next = title.trim();
    if (!next) return;
    // Optimistic: the rail is the thing being edited, and waiting a round
    // trip to redraw it makes the input feel broken.
    this.set({
      sessions: this.state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, title: next } : s)),
      ...(this.state.session?.sessionId === sessionId
        ? { session: { ...this.state.session, title: next } }
        : {}),
    });
    try {
      await api.renameSession(sessionId, next);
    } catch (err) {
      this.fail(err);
    }
  }

  toggleProject(key: string): void {
    const collapsedProjects = this.state.collapsedProjects.includes(key)
      ? this.state.collapsedProjects.filter((k) => k !== key)
      : [...this.state.collapsedProjects, key];
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
  async deleteSession(sessionId: string): Promise<void> {
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
      pinned: this.state.pinned.filter((id) => id !== sessionId),
    });
    saveDrafts(drafts);
    this.persistPrefs();

    if (this.state.sessionId === sessionId) {
      this.set({ sessionId: null, session: null, diff: null, selectedFile: null });
      window.location.hash = '';
      const next = pickDefaultSession(sessions);
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

  /**
   * Remove the selected groups of stale files.
   *
   * The daemon answers with a freshly scanned report, so the panel redraws
   * from what is actually left rather than from an optimistic subtraction —
   * which matters because the daemon can legitimately decline to remove
   * something the report offered.
   */
  async cleanStorage(groups: CleanupGroupId[]): Promise<void> {
    if (groups.length === 0) return;
    this.set({ storageBusy: true });
    try {
      const { result, report } = await api.cleanStorage(groups);
      this.set({ storage: report });
      if (result.failed.length) {
        this.toast('error', `${result.failed.length} item(s) could not be removed.`);
      } else if (result.removed === 0) {
        this.toast('info', 'Nothing left to clean up.');
      } else {
        this.toast('success', `Reclaimed ${formatBytes(result.freedBytes)}.`);
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.set({ storageBusy: false });
    }
  }

  /**
   * Restart the daemon, then reload once its replacement answers.
   *
   * The successor inherits the port and the token, so the page it reloads is
   * the same address with the same cookie. Waiting for a *different* pid is
   * what makes that safe: reloading against the outgoing process would just
   * race the handover and land on a closed socket.
   */
  async restartDaemon(waitMs = 20_000): Promise<void> {
    if (this.state.restarting) return;
    let previousPid = 0;
    try {
      previousPid = (await api.health()).pid;
    } catch {
      /* if health is unreachable, fall back to waiting for any answer */
    }

    try {
      const { restarting, interrupted } = await api.restartDaemon();
      if (!restarting) {
        this.toast('error', 'The daemon is already shutting down.');
        return;
      }
      this.set({ restarting: true, connection: 'reconnecting' });
      if (interrupted.length) {
        this.toast('info', `Restarting — ${interrupted.length} running command(s) will stop.`);
      }
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

  /** The seam between deciding to reload and reloading. Overridable because
   *  jsdom will not let a test redefine `location.reload`. */
  reloadPage = (): void => window.location.reload();

  toggleViewed(file: string): void {
    const id = this.state.sessionId;
    if (!id) return;
    const current = this.state.viewedFiles[id] ?? [];
    const next = current.includes(file) ? current.filter((f) => f !== file) : [...current, file];
    this.set({ viewedFiles: { ...this.state.viewedFiles, [id]: next } });
  }

  isViewed(file: string): boolean {
    const id = this.state.sessionId;
    return Boolean(id && (this.state.viewedFiles[id] ?? []).includes(file));
  }

  selectFile(path: string | null): void {
    this.set({ selectedFile: path });
  }

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

/**
 * Wait for a daemon that is not the one we just asked to stand down.
 *
 * `/health` needs no credentials, which is what makes it usable here: the
 * successor has to be answering *before* the page reloads, and every other
 * route would be a redirect to a login the harness does not have.
 */
async function waitForDaemon(previousPid: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    try {
      const health = await api.health();
      if (health.ok && health.pid !== previousPid) return true;
    } catch {
      /* the socket is down mid-handover; that is the expected state here */
    }
  }
  return false;
}

/** Sizes in a sentence the user is reading, not a column to be aligned. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readHash(): string | null {
  const match = /^#\/session\/([^/?]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Prefer a session that is waiting on the user over the merely most recent. */
function pickDefaultSession(sessions: SessionSummary[]): string | null {
  const waiting = sessions.find((s) => s.openGates > 0);
  return (waiting ?? sessions[0])?.sessionId ?? null;
}

export function tabForGate(gate: Gate): Tab {
  switch (gate.kind) {
    case 'plan':
      return 'plan';
    case 'code_review':
      return 'review';
    case 'verification':
      return 'verify';
    case 'ship':
      return 'ship';
    default:
      return 'timeline';
  }
}

export function tabForSession(session: SessionState): Tab {
  const gate = session.gates.find((g) => g.status === 'open');
  if (gate) return tabForGate(gate);
  switch (session.stage) {
    case 'planning':
    case 'plan_review':
      return 'plan';
    case 'implementing':
      return 'board';
    case 'code_review':
      return 'review';
    case 'verification':
      return 'verify';
    case 'ship':
    case 'done':
      return 'ship';
    default:
      return 'timeline';
  }
}

export function gateHeadline(gate: Gate): string {
  switch (gate.kind) {
    case 'question':
      return 'Claude is asking you a question';
    case 'plan':
      return 'Claude is waiting on your review of the plan';
    case 'code_review':
      return 'Claude is waiting on your review of the code';
    case 'verification':
      return 'Claude is waiting on your sign-off of the checks';
    case 'ship':
      return 'Claude is waiting on your confirmation to ship';
    default:
      return 'Claude is waiting on you';
  }
}

function notify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    new Notification(title, { body, tag: 'cc-harness-gate' });
  } catch {
    /* notifications are a nicety */
  }
}

/** Drafts are unsubmitted user writing: they must survive a reload. */
function loadDrafts(): Record<string, DraftComment[]> {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, DraftComment[]>) : {};
  } catch {
    return {};
  }
}

function saveDrafts(drafts: Record<string, DraftComment[]>): void {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* private mode, quota — the drafts still live in memory */
  }
}

/** Only known keys, only the right shapes: a corrupt or stale prefs blob must
 *  not be able to put `undefined` where the UI expects an array. */
function loadPrefs(): Partial<UiState> {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const prefs: Partial<UiState> = {};
    if (saved['diffMode'] === 'unified' || saved['diffMode'] === 'split') prefs.diffMode = saved['diffMode'];
    if (typeof saved['collapsedSidebar'] === 'boolean') prefs.collapsedSidebar = saved['collapsedSidebar'];
    if (Array.isArray(saved['pinned'])) prefs.pinned = saved['pinned'].filter((v) => typeof v === 'string');
    if (Array.isArray(saved['collapsedProjects'])) {
      prefs.collapsedProjects = saved['collapsedProjects'].filter((v) => typeof v === 'string');
    }
    if (typeof saved['soundEnabled'] === 'boolean') prefs.soundEnabled = saved['soundEnabled'];
    return prefs;
  } catch {
    return {};
  }
}

function savePrefs(prefs: {
  diffMode: string;
  collapsedSidebar: boolean;
  pinned: string[];
  collapsedProjects: string[];
  soundEnabled: boolean;
}): void {
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

export function useOpenGate(): Gate | null {
  return useStore((s) => s.session?.gates.find((g) => g.status === 'open') ?? null);
}

/** The open question, if there is one. Rendered above the tabs, so every view
 *  can be read while it is answered. */
export function useQuestionGate(): Gate | null {
  return useGateOfKind('question');
}

/**
 * The open gate a particular stage owns.
 *
 * Views must not act on `useOpenGate()`: only one gate is open at a time, so
 * while Claude has a question outstanding that is the gate the Plan tab would
 * see — and approving the plan would have resolved the *question* with a
 * plan-shaped verdict.
 */
export function useGateOfKind(kind: GateKind): Gate | null {
  return useStore((s) => s.session?.gates.find((g) => g.status === 'open' && g.kind === kind) ?? null);
}

export function useDrafts(): DraftComment[] {
  return useStore((s) => (s.sessionId ? (s.drafts[s.sessionId] ?? EMPTY_DRAFTS) : EMPTY_DRAFTS));
}

const EMPTY_DRAFTS: DraftComment[] = [];
