import { createContext, createElement, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { api, eventsUrl, Unauthorized, type ProjectChecks } from './lib/api.ts';
import { onDroppedAfterSend, pruneDrafts, unsavedDrafts, type DroppedDraft } from './lib/drafts.ts';

const NO_CHECKS: ProjectChecks = { implement: [], review: [] };
import { isLocked } from '../shared/plan.ts';
import { agentInfo, type AgentInfo } from '../shared/agents.ts';
import type { GapSeverities } from '../shared/check.ts';
import type { BuildSettings, BuildTarget, CleanupGroupId, ExecutionMode, Plan, PlanOp, PlanStatus, ServerEvent, SessionState, SessionSummary, StorageReport, Target } from '../shared/types.ts';
import { PLAN_STATUSES } from '../shared/types.ts';

export type Tab = 'diagrams' | 'tasks' | 'overview';
/** The architecture comes first: it is where most of the plan is decided. */
export const TAB_IDS: Tab[] = ['diagrams', 'tasks', 'overview'];

/** How the Tasks view lays out the tree: an editable outline, status
 *  columns, or grouped under the boxes each task builds. */
export type TaskMode = 'outline' | 'board' | 'boxes';

/** What the prompt viewer shows: the read-back, the next prompt (or one
 *  already sent), or one task's brief. */
export type ViewerTab = 'readback' | 'prompt' | 'brief';

export interface ViewerState {
  tab: ViewerTab;
  /** The task whose brief is shown. */
  taskId?: string;
  /** A prompt already sent, shown as it was. */
  sent?: { title: string; prompt: string; meta: string };
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'unauthorized';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
  /** Text the user may want to keep: offered to copy, and the toast stays
   *  until dismissed. */
  copy?: string;
}

export interface UiState {
  sessions: SessionSummary[];
  sessionId: string | null;
  session: SessionState | null;
  /** How the open session's repository counts each plan-check rule
   *  (`planCheck` in .coplan/config.json); empty means every rule warns. */
  planCheck: GapSeverities;
  /** The open session's repository checks by stage, which a task can skip. */
  projectChecks: ProjectChecks;
  tab: Tab;
  /** The diagram open on the Architecture tab; the first one when unset. */
  diagramId: string | null;
  connection: ConnectionState;
  /** How the task tree is laid out: an editable outline, status columns, or
   *  by the box each task builds. */
  taskMode: TaskMode;
  /** Hide finished tasks in the outline. */
  hideDone: boolean;
  /** Tasks whose subtasks are folded away in the outline, by session, then
   *  task id: task ids repeat across plans. The most recently folded last. */
  collapsedTasks: Map<string, string[]>;
  collapsedSidebar: boolean;
  /** The narrow-width sidebar drawer. Never persisted. */
  drawerOpen: boolean;
  pinned: string[];
  collapsedProjects: string[];
  /** The session list shows only plans with this status; all when null. */
  statusFilter: PlanStatus | null;
  /** Bumped to ask a view to scroll an item into view: `kind:id`. */
  focusTarget: string | null;
  storage: StorageReport | null;
  storageBusy: boolean;
  restarting: boolean;
  /** Edits in flight, so controls can say they are saving. */
  saving: number;
  /** The canvas has an edit queued, in flight or about to be (a keyboard
   *  nudge): what is on screen is not yet saved. */
  canvasSaving: boolean;
  /** The proposal shown on the canvas, as the plan would be with it. */
  proposalPreview: string | null;
  /** The prompt viewer, when open. */
  viewer: ViewerState | null;
  /** The Export plan dialog is open. */
  exportOpen: boolean;
  /** Show the agent's bookkeeping in the viewer. Off until asked for. */
  showBookkeeping: boolean;
  /** What is wrong with Coplan's settings files now, each naming its file. */
  configErrors: string[];
  toasts: Toast[];
  error: string | null;
}

const initial: UiState = {
  sessions: [],
  sessionId: null,
  session: null,
  planCheck: {},
  projectChecks: { implement: [], review: [] },
  tab: 'diagrams',
  diagramId: null,
  connection: 'connecting',
  taskMode: 'outline',
  hideDone: false,
  collapsedTasks: new Map(),
  collapsedSidebar: false,
  drawerOpen: false,
  pinned: [],
  collapsedProjects: [],
  statusFilter: null,
  focusTarget: null,
  storage: null,
  storageBusy: false,
  restarting: false,
  saving: 0,
  canvasSaving: false,
  proposalPreview: null,
  viewer: null,
  exportOpen: false,
  showBookkeeping: false,
  configErrors: [],
  toasts: [],
  error: null,
};

/**
 * What the page holds for the session on screen, let go when another opens
 * (or it is deleted): its ids (a task's brief, an item to scroll to, a
 * proposal, a diagram) may name others in the next.
 */
const SESSION_RESET: Partial<UiState> = {
  planCheck: {},
  diagramId: null,
  proposalPreview: null,
  viewer: null,
  focusTarget: null,
  exportOpen: false,
};

const PREFS_KEY = 'cc-harness:prefs';
/** Sessions whose folded tasks are remembered, the most recently folded. */
const FOLDS_KEPT = 100;

/** The settings errors this browser has already been told about. */
const SEEN_CONFIG_ERRORS_KEY = 'cc-harness:config-errors-seen';

/** A list kept in this browser; empty where storage is unavailable. */
function readList(key: string): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(list.slice(0, 50)));
  } catch {
    /* a private window: told again next time, which is the safe side */
  }
}

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
  private retries = 0;
  private connectAttempt = 0;
  /** A stream is being opened: its ticket is not back yet. */
  private opening = false;

  getState = (): UiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    // A plan landing settles the drafts kept for it (see pruneDrafts).
    const dropped = patch.session?.plan ? pruneDrafts(patch.session.sessionId, patch.session.plan) : [];
    for (const listener of this.listeners) listener();
    const plan = patch.session?.plan;
    for (const d of dropped) this.offerDropped(d, plan, patch.session!.sessionId);
  }

  /** A change request whose round stopped waiting, offered of its own
   *  session's plan (named if that is not the one shown). */
  offerDroppedNow(sessionId: string | null, { name, text }: DroppedDraft, title?: string): void {
    this.sayOf(sessionId, 'error', `That task no longer waits on your review, so ${name} could not be sent. Copy it to keep it:`, title, text);
  }

  /** Text a plan landing took the field of, offered to copy. */
  private offerDropped(dropped: DroppedDraft, plan: Plan | null | undefined, sessionId: string): void {
    const { name, text, why } = dropped;
    if (why === 'review') return this.offerDroppedNow(sessionId, dropped, plan?.title);
    const how = plan?.submission ? 'was submitted' : 'had its design confirmed';
    this.toast('error', `"${plan?.title}" ${how}, so the text you had open in ${name} could not be saved. Copy it to keep it:`, text);
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  async init(): Promise<void> {
    // The token was already taken out of the address bar, by `lib/api.ts`.
    try {
      const { sessions } = await api.sessions();
      this.set({ sessions });
      const target = readHash() ?? listedSessions(sessions, null)[0]?.sessionId ?? null;
      if (target) await this.selectSession(target, false);
    } catch (err) {
      this.set({ error: describeError(err) });
    }

    // Selecting a session opens the stream (its ticket maybe not back yet);
    // with none to select, open it for the session list alone.
    if (!this.source && !this.opening) this.connect();
    // Closing or reloading with an edit still on its way, or one open and
    // not saved, would lose it without a word: the browser asks first.
    window.addEventListener('beforeunload', (e) => {
      if (this.state.saving > 0 || this.state.canvasSaving || unsavedDrafts()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    window.addEventListener('hashchange', () => {
      const id = readHash();
      if (id && id !== this.state.sessionId) void this.selectSession(id, false);
    });
  }

  async selectSession(id: string, updateHash = true): Promise<void> {
    // A field being typed in saves when it loses focus: let it, before its
    // view goes. Left to the removal, it would be dropped where a browser
    // does not blur a removed field. Its save goes to its own session
    // either way: each view's edits are bound to it (useCommit).
    if (id !== this.state.sessionId) {
      const typing = document.activeElement;
      if (typing instanceof HTMLInputElement || typing instanceof HTMLTextAreaElement) typing.blur();
    }
    if (updateHash) window.location.hash = `#/session/${id}`;
    // Opened again, it reloads and keeps what was open on it.
    this.set({ ...(id !== this.state.sessionId ? SESSION_RESET : {}), sessionId: id, session: null, error: null });
    this.connect();
    try {
      const { session, planCheck, projectChecks } = await api.session(id);
      // Clicking through the rail quickly: only the last choice may land.
      if (this.state.sessionId === id) this.set({ session: this.newest(session), planCheck: planCheck ?? {}, projectChecks: projectChecks ?? NO_CHECKS });
    } catch (err) {
      if (this.state.sessionId === id) this.set({ error: describeError(err) });
    }
  }

  /* ---------------------------------------------------------------- *
   * Live connection
   * ---------------------------------------------------------------- */

  /**
   * Open the live stream. Each opening takes a fresh single-use ticket, so
   * the browser's own retry (which would reuse a spent one) is not relied
   * on: on any error the stream is closed and opened again here, backing off
   * — and stops, saying so, if the daemon no longer knows the page's token.
   */
  private connect(): void {
    this.source?.close();
    this.source = null;
    window.clearTimeout(this.reconnectTimer);
    const attempt = ++this.connectAttempt;
    this.opening = true;
    void eventsUrl(this.state.sessionId)
      .then((url) => {
        if (attempt !== this.connectAttempt) return;
        this.opening = false;
        const source = new EventSource(url);
        this.source = source;
        source.onopen = () => {
          this.retries = 0;
          this.set({ connection: 'live' });
        };
        source.onerror = () => {
          source.close();
          if (this.source === source) this.source = null;
          this.retry();
        };
        source.onmessage = (message) => {
          try {
            this.apply(JSON.parse(message.data as string) as ServerEvent);
          } catch {
            /* a malformed frame is not worth breaking the UI over */
          }
        };
      })
      .catch((err: unknown) => {
        if (attempt !== this.connectAttempt) return;
        this.opening = false;
        if (err instanceof Unauthorized) {
          this.set({ connection: 'unauthorized' });
          return;
        }
        this.retry();
      });
  }

  /** Try again, a little later each time, up to half a minute apart. */
  private retry(): void {
    this.set({ connection: 'reconnecting' });
    window.clearTimeout(this.reconnectTimer);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.retries++, 5));
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
      void this.resync();
    }, delay);
  }

  /** Catch up on what was missed while the stream was down. The stream
   *  says when it is live again; a fetch does not. */
  private async resync(): Promise<void> {
    if (!this.state.sessionId) return;
    try {
      const { session, planCheck, projectChecks } = await api.session(this.state.sessionId);
      if (session.sessionId === this.state.sessionId) this.set({ session: this.newest(session), planCheck: planCheck ?? {}, projectChecks: projectChecks ?? NO_CHECKS });
    } catch {
      /* the next connect says what is wrong */
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
        const agent = agentInfo(event.session.agent).name;
        if (before && after && after.revision > before.revision) {
          this.toast('info', `${agent} published revision ${after.revision} of the plan.`);
        }
        // The moment the agent picks up the submitted plan.
        if (before?.submission && !before.submission.deliveredAt && after?.submission?.deliveredAt) {
          this.toast('success', `${agent} has the build prompt. Follow it on the board.`);
        } else if (before?.design && !before.design.deliveredAt && after?.design?.deliveredAt && !after.submission) {
          this.toast('success', `${agent} has the confirmed design and is making the task list.`);
        }
        this.set({ session: this.newest(event.session) });
        return;
      }
      case 'ping':
        return;
      case 'config-errors':
        this.configErrors(event.errors, event.files ?? []);
        return;
      case 'persist-error':
        if (event.sessionId === this.state.sessionId) {
          this.toast(
            'error',
            `Coplan could not save this plan to disk (${event.message}): your latest edits are not saved. Free some space, or check the folder's permissions.`,
          );
        }
        return;
    }
  }

  /**
   * A session from the daemon, but never with an older plan than the page
   * holds: a fetch that resolves after a newer snapshot (or a save's reply)
   * would otherwise roll the page — and the canvas — back. The rest of the
   * session (its status, its link) is taken as it comes.
   */
  private newest(incoming: SessionState): SessionState {
    const current = this.state.session;
    if (!current || current.sessionId !== incoming.sessionId || !current.plan || !incoming.plan) return incoming;
    const order = (p: Plan) => p.version ?? p.seq;
    return order(incoming.plan) < order(current.plan) ? { ...incoming, plan: current.plan } : incoming;
  }

  /* ---------------------------------------------------------------- *
   * Editing the plan
   * ---------------------------------------------------------------- */

  /**
   * Send edits to one session's plan, and resolve with the plan exactly as
   * the daemon left it after them — or null when they were refused (the
   * reason is shown). Callers that build on the result (the canvas's
   * revision) need the daemon's answer, not whatever the store holds by the
   * time it arrives. The session is the caller's, never the one on screen
   * when this runs: `useCommit` binds it when the view renders.
   */
  async commit(ops: PlanOp[], sessionId: string | null): Promise<Plan | null> {
    if (!sessionId || ops.length === 0) return null;
    this.set({ saving: this.state.saving + 1 });
    try {
      return await this.send(sessionId, (id) => api.ops(id, ops));
    } finally {
      this.set({ saving: Math.max(0, this.state.saving - 1) });
    }
  }

  /**
   * Ask the daemon for a change to a session's plan — edits, or a sign-off
   * — and put its answer in place. Null when there is no session, or when
   * the daemon refused: its reason is shown and the plan is left as it was.
   */
  private async send(sessionId: string | null, call: (sessionId: string) => Promise<{ plan: Plan }>): Promise<Plan | null> {
    if (!sessionId) return null;
    try {
      const { plan } = await call(sessionId);
      this.adoptPlan(sessionId, plan);
      return plan;
    } catch (err) {
      this.failFor(sessionId, err);
      return null;
    }
  }

  /** Said of a session's plan: over another, it names the one it is about
   *  ("t3" there is another task) — `title` if the answer gave one. With
   *  `copy`, the text is offered to copy (see toast). */
  sayOf(sessionId: string | null, kind: Toast['kind'], text: string, title?: string, copy?: string): void {
    if (this.isShown(sessionId)) return this.toast(kind, text, copy);
    const listed = this.state.sessions.find((s) => s.sessionId === sessionId);
    const name = title ?? (listed ? sessionName(listed) : null);
    this.toast(kind, name ? `"${name}": ${text}` : `Another plan: ${text}`, copy);
  }

  /** A request about a session failed: said of it (sayOf), unless the
   *  daemon was not reached at all, which is no one plan's doing. */
  private failFor(sessionId: string | null, err: unknown): void {
    if (unreachable(err)) this.fail(err);
    else this.sayOf(sessionId, 'error', describeError(err));
  }

  /**
   * Put the daemon's answer in place, unless something newer has landed:
   * the live stream may already have delivered a change Claude made right
   * after this one, or another tab's drag. Never roll the page back to it.
   * `version` counts layout saves too; `seq` does not. A daemon started
   * before `version` existed sends none; fall back to seq.
   */
  private adoptPlan(sessionId: string, plan: Plan): void {
    const session = this.state.session;
    const order = (p: Plan) => p.version ?? p.seq;
    if (session && session.sessionId === sessionId && (!session.plan || order(plan) >= order(session.plan))) {
      this.set({ session: { ...session, plan } });
    }
  }

  /**
   * A sign-off for one session — the one its dialog showed, given by the
   * caller, never the one on screen when it runs: the daemon's answer, that
   * session's agent, and whether it is still on screen. What is done after
   * the answer — moving the page, saying what happened — is for the
   * session it was made on, which the user may have left by then.
   */
  private async signOff(
    to: SignOffFor,
    call: (sessionId: string) => Promise<{ plan: Plan }>,
  ): Promise<{ plan: Plan; agent: AgentInfo; shown: () => boolean; say: (kind: Toast['kind'], text: string) => void } | null> {
    const { sessionId: id, agent } = to;
    const plan = await this.send(id, call);
    if (!plan) return null;
    const shown = () => this.isShown(id);
    const say = (kind: Toast['kind'], text: string) => this.sayOf(id, kind, text, plan.title);
    return { plan, agent, shown, say };
  }

  /** Whether a session is the one on screen: selected, loaded or still loading. */
  isShown(sessionId: string | null): boolean {
    return sessionId !== null && this.state.sessionId === sessionId;
  }

  /**
   * Sign the plan off. From here it is locked and the page follows the build
   * on the board. Resolves false when the daemon refused — most often
   * because the plan moved on since the preview was made.
   */
  async submitPlan(to: SignOffFor, input: { target: BuildTarget; mode?: ExecutionMode; note: string; expect: number; hash?: string; settings?: BuildSettings }): Promise<boolean> {
    const done = await this.signOff(to, (id) => api.submitPlan(id, input));
    if (!done) return false;
    const { agent } = done;
    if (done.shown()) this.set({ tab: 'tasks', taskMode: 'board' });
    done.say(
      'success',
      input.target !== 'session'
        ? 'Plan submitted and locked. Paste the prompt where it will be built.'
        : agent.promptContext
          ? `Plan submitted and locked. Send any message in ${agent.name} to hand it the prompt.`
          : `Plan submitted and locked. Paste the prompt into ${agent.name}'s chat.`,
    );
    return true;
  }

  /** Unlock a submitted plan for changes. The design stays confirmed. */
  async reopenPlan(to: SignOffFor): Promise<boolean> {
    const done = await this.signOff(to, (id) => api.reopenPlan(id));
    if (!done) return false;
    const { plan, agent } = done;
    done.say(
      'info',
      plan.design
        ? `The tasks are open for changes again; the design stays confirmed. Tell ${agent.name} in chat once you have changed them.`
        : `The plan is open for changes again. Tell ${agent.name} in chat once you have changed it.`,
    );
    return true;
  }

  /**
   * Sign the design off. From here it is locked, and Claude gets the ask for
   * a task list with the user's next message.
   */
  async confirmDesign(to: SignOffFor, input: { note: string; expect: number; hash?: string }): Promise<boolean> {
    const done = await this.signOff(to, (id) => api.confirmDesign(id, input));
    if (!done) return false;
    const { agent } = done;
    done.say(
      'success',
      agent.promptContext
        ? `Design confirmed. Send any message in ${agent.name} to have it make the task list.`
        : `Design confirmed. Paste the prompt into ${agent.name}'s chat to have it make the task list.`,
    );
    return true;
  }

  /**
   * Queue a request to revise the plan per the open comments (#67). It
   * waits for the user's next message in the agent's chat: the page never
   * starts a turn.
   */
  async queueRevision(to: SignOffFor, input: { note: string; expect: number; hash?: string }, opts: { quiet?: boolean } = {}): Promise<boolean> {
    const done = await this.signOff(to, (id) => api.queueRevision(id, input));
    if (!done) return false;
    if (opts.quiet) return true;
    const { agent } = done;
    done.say(
      'success',
      agent.promptContext
        ? `Request queued. Send any message in ${agent.name}'s chat — "go" will do — and it goes with it.`
        : `Request queued. Paste it into ${agent.name}'s chat, or ask ${agent.name} to read the plan.`,
    );
    return true;
  }

  /** Take back a revision request the agent has not been sent. */
  async withdrawRevision(to: SignOffFor): Promise<boolean> {
    const done = await this.signOff(to, (id) => api.withdrawRevision(id));
    if (!done) return false;
    done.say('info', 'Request withdrawn: it will not be sent.');
    return true;
  }

  /** Unlock a confirmed design so it can be reshaped. */
  async reopenDesign(to: SignOffFor): Promise<boolean> {
    const done = await this.signOff(to, (id) => api.reopenDesign(id));
    if (!done) return false;
    done.say('info', `The design is open for changes again. Tell ${done.agent.name} in chat once you have changed it.`);
    return true;
  }

  /** Jump to an item from anywhere: a board card, the overview's "now". */
  focus(kind: string, id: string): void {
    const tab: Tab = kind === 'diagram' ? 'diagrams' : kind === 'task' ? 'tasks' : 'overview';
    if (kind === 'diagram') this.set({ diagramId: id });
    if (kind === 'node' || kind === 'edge') {
      // `node:<diagram>:<node>` — open that diagram; the editor selects the
      // box (or the arrow).
      const [diagramId] = id.split(':');
      this.set({ tab: 'diagrams', diagramId: diagramId ?? null, focusTarget: `${kind}:${id}` });
      return;
    }
    if (kind === 'task' && isLocked(this.state.session?.plan ?? null)) {
      // A locked plan's tasks live on the board, where its card is.
      this.set({ tab, taskMode: 'board', focusTarget: `${kind}:${id}` });
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
      this.set({ taskMode: 'outline' });
      const sessionId = this.state.session?.sessionId;
      const folded = sessionId ? this.state.collapsedTasks.get(sessionId) : undefined;
      if (sessionId && folded?.some((t) => ancestors.has(t))) this.setCollapsed(sessionId, folded.filter((t) => !ancestors.has(t)));
    }
    this.set({ tab, focusTarget: `${kind}:${id}` });
  }

  /** Jump to the item a comment or a prompt's block is about. */
  focusField(target: Target): void {
    if (target.kind === 'node' || target.kind === 'edge') {
      // `diagramId/partId`: the diagram's id never holds a slash.
      const cut = target.id.indexOf('/');
      this.focus(target.kind, `${target.id.slice(0, cut)}:${target.id.slice(cut + 1)}`);
    } else if (target.kind === 'plan') this.focus('plan', 'summary');
    else this.focus(target.kind, target.id);
  }

  openViewer(viewer: ViewerState): void {
    this.set({ viewer });
  }

  closeViewer(): void {
    this.set({ viewer: null });
  }

  openExport(): void {
    this.set({ exportOpen: true, viewer: null });
  }

  closeExport(): void {
    this.set({ exportOpen: false });
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
      statusFilter: this.state.statusFilter,
      taskMode: this.state.taskMode,
      hideDone: this.state.hideDone,
      collapsedTasks: [...this.state.collapsedTasks],
    });
  }

  /** Show only the plans with one status in the session list (#66). */
  setStatusFilter(statusFilter: PlanStatus | null): void {
    this.set({ statusFilter });
    this.persistPrefs();
  }

  setTaskMode(taskMode: TaskMode): void {
    this.set({ taskMode });
    this.persistPrefs();
  }

  toggleHideDone(): void {
    this.set({ hideDone: !this.state.hideDone });
    this.persistPrefs();
  }

  /** Fold or unfold a task in the outline of the session the asking view
   *  shows (useSessionId), whatever is on screen by then. */
  toggleTaskCollapsed(sessionId: string | null, id: string): void {
    if (!sessionId) return;
    const now = this.state.collapsedTasks.get(sessionId) ?? [];
    this.setCollapsed(sessionId, now.includes(id) ? now.filter((t) => t !== id) : [...now, id]);
  }

  /** Fold these in a session's outline. It becomes the most recently
   *  folded, and only the FOLDS_KEPT most recent sessions' folds are kept. */
  private setCollapsed(sessionId: string, tasks: string[]): void {
    const folds = new Map(this.state.collapsedTasks);
    folds.delete(sessionId);
    if (tasks.length) folds.set(sessionId, tasks);
    this.set({ collapsedTasks: new Map([...folds].slice(-FOLDS_KEPT)) });
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
      this.failFor(sessionId, err);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await api.deleteSession(sessionId);
    } catch (err) {
      this.failFor(sessionId, err);
      return;
    }
    const sessions = this.state.sessions.filter((s) => s.sessionId !== sessionId);
    pruneDrafts(sessionId, null);
    const collapsedTasks = new Map(this.state.collapsedTasks);
    collapsedTasks.delete(sessionId);
    this.set({ sessions, pinned: this.state.pinned.filter((id) => id !== sessionId), collapsedTasks });
    this.persistPrefs();
    if (this.state.sessionId === sessionId) {
      this.set({ ...SESSION_RESET, sessionId: null, session: null });
      window.location.hash = '';
      const next = listedSessions(sessions, null)[0]?.sessionId;
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
      this.toast('error', 'The daemon did not come back. Run `coplan start` in a terminal.');
      return;
    }
    this.reloadPage();
  }

  /** Overridable because jsdom will not let a test redefine `location.reload`. */
  reloadPage = (): void => window.location.reload();

  /* ---------------------------------------------------------------- *
   * Notices
   * ---------------------------------------------------------------- */

  /**
   * A settings file Coplan could not use (#52): a setting quietly ignored is
   * worse than a toast. Said once per distinct error — not again on a
   * reload, a reconnect or a switch to another session — and listed in the
   * rail's footer for as long as it is wrong. Once fixed it is forgotten, so
   * the same mistake made again is said again. "Fixed" is only known for the
   * files this page's session reads (`files`): an error in another
   * repository's file is kept as seen.
   */
  private configErrors(errors: string[], files: string[]): void {
    this.set({ configErrors: errors });
    const seen = readList(SEEN_CONFIG_ERRORS_KEY);
    for (const e of errors) {
      if (!seen.includes(e)) this.toast('error', `Coplan's config: ${e} Run coplan doctor to see every problem.`);
    }
    const fixed = (e: string) => !errors.includes(e) && files.some((f) => e.startsWith(f));
    writeList(SEEN_CONFIG_ERRORS_KEY, [...errors, ...seen.filter((e) => !errors.includes(e) && !fixed(e))]);
  }

  toast(kind: Toast['kind'], text: string, copy?: string): void {
    const toast: Toast = { id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, kind, text, ...(copy !== undefined ? { copy } : {}) };
    this.set({ toasts: [...this.state.toasts, toast] });
    if (copy === undefined) window.setTimeout(() => this.dismissToast(toast.id), kind === 'error' ? 8000 : 4000);
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

/** A session's name as the page shows it: its plan's title, else its own. */
export function sessionName(s: Pick<SessionSummary, 'planTitle' | 'title'>): string {
  return s.planTitle ?? s.title;
}

/** fetch's own failure: the daemon was not reached. */
function unreachable(err: unknown): boolean {
  return err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
}

export function describeError(err: unknown): string {
  // fetch's own wording ("Failed to fetch", "NetworkError…") says nothing to
  // a reader: the daemon could not be reached, and the edit was not saved.
  if (unreachable(err)) {
    return "Coplan's daemon is not reachable, so this was not saved. Run `coplan status` in a terminal to see why.";
  }
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
    // [session, task ids] pairs, the most recently folded last. A bare task
    // id (kept before folds were by session) is no session's: dropped.
    if (Array.isArray(saved['collapsedTasks'])) {
      const folds = saved['collapsedTasks']
        .filter((e): e is [string, unknown] => Array.isArray(e) && typeof e[0] === 'string')
        .map(([id, tasks]): [string, string[]] => [id, strings(tasks)])
        .filter(([, tasks]) => tasks.length > 0);
      prefs.collapsedTasks = new Map(folds.slice(-FOLDS_KEPT));
    }
    if (saved['taskMode'] === 'outline' || saved['taskMode'] === 'board' || saved['taskMode'] === 'boxes') prefs.taskMode = saved['taskMode'];
    if (typeof saved['hideDone'] === 'boolean') prefs.hideDone = saved['hideDone'];
    if ((PLAN_STATUSES as readonly unknown[]).includes(saved['statusFilter'])) prefs.statusFilter = saved['statusFilter'] as PlanStatus;
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
// A change request refused as its round stopped waiting is offered as one
// a plan landing let go is (Store.set).
onDroppedAfterSend((sessionId, dropped) => store.offerDroppedNow(sessionId, dropped));

/**
 * The sessions the rail lists: the ones that have used Coplan. Every session
 * with the plugin registers (its hooks have to, to notice `/coplan`), but one
 * that never asked for a plan is just someone else's chat. The session on
 * screen is listed whatever it is (opened by its link, say), so the rail
 * never loses where you are.
 */
export function listedSessions(sessions: SessionSummary[], current: string | null): SessionSummary[] {
  return sessions.filter((s) => s.engaged || s.sessionId === current);
}

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

const ShownSession = createContext<string | null>(null);

const NO_FOLDS: readonly string[] = [];

/** The tasks folded away in the outline of the plan the view shows. */
export function useCollapsedTasks(): readonly string[] {
  const sessionId = useSessionId();
  return useStore((s) => (sessionId && s.collapsedTasks.get(sessionId)) || NO_FOLDS);
}

/** The session whose plan the view shows, as it rendered: what its edits
 *  and sign-offs go to, whatever is on screen by the time they are sent. */
export function useSessionId(): string | null {
  return useContext(ShownSession);
}

/** Who a sign-off is for, as the view that makes it rendered: the session,
 *  and its agent, whose chat the toast says to go to. */
export interface SignOffFor {
  sessionId: string | null;
  agent: AgentInfo;
}

/** Around everything that shows a session's plan: the session it shows,
 *  read once here rather than by every component that edits it. */
export function SessionScope({ children }: { children: ReactNode }) {
  const sessionId = useStore((s) => s.session?.sessionId ?? null);
  return createElement(ShownSession.Provider, { value: sessionId }, children);
}

/**
 * Edits to the plan the view shows, bound to its session when the view
 * renders, not when they are sent. A save that lands after the user
 * switched sessions — an editor saving on its way out, a request still
 * queued — goes to the plan it was made on, where task ids like t3 mean
 * these tasks. Resolves with that plan as the daemon left it, or null when
 * the edits were refused.
 */
export function useCommit(): (ops: PlanOp[]) => Promise<Plan | null> {
  const sessionId = useSessionId();
  return useCallback((ops) => store.commit(ops, sessionId), [sessionId]);
}

/**
 * Whether the session this view showed when it rendered is still on screen.
 * What a view does once an answer comes (focus a row, expand a task, close
 * a preview) is for that session only: ids like t3 repeat across plans.
 */
export function useStillShown(): () => boolean {
  const sessionId = useSessionId();
  return useCallback(() => store.isShown(sessionId), [sessionId]);
}

/** One edit, by `useCommit`, for callers that only need to know it was taken. */
export function useEdit(): (op: PlanOp) => Promise<boolean> {
  const commit = useCommit();
  return useCallback(async (op) => (await commit([op])) !== null, [commit]);
}

export function usePlan() {
  return useStore((s) => s.session?.plan ?? null);
}

/** The agent behind the open session — Claude, Codex or Cursor — which is
 *  what the page calls the other side of the plan. */
export function useAgent(): AgentInfo {
  return agentInfo(useStore((s) => s.session?.agent));
}
