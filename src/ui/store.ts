import { useSyncExternalStore } from 'react';
import { api, eventsUrl, Unauthorized, type ProjectChecks } from './lib/api.ts';

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
  /** Tasks whose subtasks are folded away in the outline, by id. */
  collapsedTasks: string[];
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
  collapsedTasks: [],
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
  private retries = 0;
  private connectAttempt = 0;

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
    // The token was already taken out of the address bar, by `lib/api.ts`.
    try {
      const { sessions } = await api.sessions();
      this.set({ sessions });
      const target = readHash() ?? listedSessions(sessions, null)[0]?.sessionId ?? null;
      if (target) await this.selectSession(target, false);
    } catch (err) {
      this.set({ error: describeError(err) });
    }

    // Selecting a session opens the stream; with none to select, open it for
    // the session list alone.
    if (!this.source) this.connect();
    // Closing or reloading with an edit still on its way would lose it
    // without a word: the browser asks first.
    window.addEventListener('beforeunload', (e) => {
      if (this.state.saving > 0 || this.state.canvasSaving) {
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
    if (updateHash) window.location.hash = `#/session/${id}`;
    this.set({ sessionId: id, session: null, planCheck: {}, diagramId: null, error: null, exportOpen: false });
    this.connect();
    try {
      const { session, planCheck, configErrors, projectChecks } = await api.session(id);
      // Clicking through the rail quickly: only the last choice may land.
      if (this.state.sessionId === id) this.set({ session: this.newest(session), planCheck: planCheck ?? {}, projectChecks: projectChecks ?? NO_CHECKS });
      this.sayConfigErrors(configErrors);
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
    void eventsUrl(this.state.sessionId)
      .then((url) => {
        if (attempt !== this.connectAttempt) return;
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
      const { session, planCheck, configErrors, projectChecks } = await api.session(this.state.sessionId);
      if (session.sessionId === this.state.sessionId) this.set({ session: this.newest(session), planCheck: planCheck ?? {}, projectChecks: projectChecks ?? NO_CHECKS });
      this.sayConfigErrors(configErrors);
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

  /** Put the daemon's answer in place, unless something newer has landed. */
  private adoptPlan(sessionId: string, plan: Plan): void {
    const session = this.state.session;
    const order = (p: Plan) => p.version ?? p.seq;
    if (session && session.sessionId === sessionId && (!session.plan || order(plan) >= order(session.plan))) {
      this.set({ session: { ...session, plan } });
    }
  }

  /**
   * Sign the plan off. From here it is locked and the page follows the build
   * on the board. Resolves false when the daemon refused — most often
   * because the plan moved on since the preview was made.
   */
  async submitPlan(input: { target: BuildTarget; mode?: ExecutionMode; note: string; expect: number; hash?: string; settings?: BuildSettings }): Promise<boolean> {
    const id = this.state.sessionId;
    if (!id) return false;
    try {
      const { plan } = await api.submitPlan(id, input);
      this.adoptPlan(id, plan);
      this.set({ tab: 'tasks', taskMode: 'board' });
      const agent = agentInfo(this.state.session?.agent);
      this.toast(
        'success',
        input.target !== 'session'
          ? 'Plan submitted and locked. Paste the prompt where it will be built.'
          : agent.promptContext
            ? `Plan submitted and locked. Send any message in ${agent.name} to hand it the prompt.`
            : `Plan submitted and locked. Paste the prompt into ${agent.name}'s chat.`,
      );
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** Unlock a submitted plan for changes. The design stays confirmed. */
  async reopenPlan(): Promise<boolean> {
    const id = this.state.sessionId;
    if (!id) return false;
    try {
      const { plan } = await api.reopenPlan(id);
      this.adoptPlan(id, plan);
      const name = agentInfo(this.state.session?.agent).name;
      this.toast(
        'info',
        plan.design
          ? `The tasks are open for changes again; the design stays confirmed. Tell ${name} in chat once you have changed them.`
          : `The plan is open for changes again. Tell ${name} in chat once you have changed it.`,
      );
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /**
   * Sign the design off. From here it is locked, and Claude gets the ask for
   * a task list with the user's next message.
   */
  async confirmDesign(input: { note: string; expect: number; hash?: string }): Promise<boolean> {
    const id = this.state.sessionId;
    if (!id) return false;
    try {
      const { plan } = await api.confirmDesign(id, input);
      this.adoptPlan(id, plan);
      const agent = agentInfo(this.state.session?.agent);
      this.toast(
        'success',
        agent.promptContext
          ? `Design confirmed. Send any message in ${agent.name} to have it make the task list.`
          : `Design confirmed. Paste the prompt into ${agent.name}'s chat to have it make the task list.`,
      );
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /**
   * Queue a request to revise the plan per the open comments (#67). It
   * waits for the user's next message in the agent's chat: the page never
   * starts a turn.
   */
  async queueRevision(input: { note: string; expect: number; hash?: string }, opts: { quiet?: boolean } = {}): Promise<boolean> {
    const id = this.state.sessionId;
    if (!id) return false;
    try {
      const { plan } = await api.queueRevision(id, input);
      this.adoptPlan(id, plan);
      const agent = agentInfo(this.state.session?.agent);
      if (!opts.quiet) {
        this.toast(
          'success',
          agent.promptContext
            ? `Request queued. Send any message in ${agent.name}'s chat — "go" will do — and it goes with it.`
            : `Request queued. Paste it into ${agent.name}'s chat, or ask ${agent.name} to read the plan.`,
        );
      }
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** Take back a revision request the agent has not been sent. */
  async withdrawRevision(): Promise<boolean> {
    const id = this.state.sessionId;
    if (!id) return false;
    try {
      const { plan } = await api.withdrawRevision(id);
      this.adoptPlan(id, plan);
      this.toast('info', 'Request withdrawn: it will not be sent.');
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  /** Unlock a confirmed design so it can be reshaped. */
  async reopenDesign(): Promise<boolean> {
    const id = this.state.sessionId;
    if (!id) return false;
    try {
      const { plan } = await api.reopenDesign(id);
      this.adoptPlan(id, plan);
      this.toast('info', `The design is open for changes again. Tell ${agentInfo(this.state.session?.agent).name} in chat once you have changed it.`);
      return true;
    } catch (err) {
      this.fail(err);
      return false;
    }
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
      this.set({ collapsedTasks: this.state.collapsedTasks.filter((t) => !ancestors.has(t)), taskMode: 'outline' });
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
      collapsedTasks: this.state.collapsedTasks,
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

  /** Harness config errors already said on this page: each is said once. */
  private saidConfigErrors = new Set<string>();

  /** Say what is wrong with the harness config, once per distinct error
   *  (#52): a setting that is quietly ignored is worse than a toast. */
  private sayConfigErrors(errors: string[] | undefined): void {
    for (const e of errors ?? []) {
      if (this.saidConfigErrors.has(e)) continue;
      this.saidConfigErrors.add(e);
      this.toast('error', `Coplan's config: ${e} Run coplan doctor to see every problem.`);
    }
  }

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
  // fetch's own wording ("Failed to fetch", "NetworkError…") says nothing to
  // a reader: the daemon could not be reached, and the edit was not saved.
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) {
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
    if (Array.isArray(saved['collapsedTasks'])) prefs.collapsedTasks = strings(saved['collapsedTasks']);
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

export function usePlan() {
  return useStore((s) => s.session?.plan ?? null);
}

/** The agent behind the open session — Claude, Codex or Cursor — which is
 *  what the page calls the other side of the plan. */
export function useAgent(): AgentInfo {
  return agentInfo(useStore((s) => s.session?.agent));
}
