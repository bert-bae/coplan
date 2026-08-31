import { useCallback, useEffect, useRef } from 'react';
import { store, useStore, useSession, useOpenGate, useDrafts, type Tab } from './store.ts';
import { Button } from './components/primitives.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { GateBanner } from './components/GateBanner.tsx';
import { QuestionGate } from './components/QuestionGate.tsx';
import { Composer } from './components/Composer.tsx';
import { Toasts } from './components/Toasts.tsx';
import { ConnectionBar } from './components/ConnectionBar.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { ActivityView } from './views/ActivityView.tsx';
import { PlanView } from './views/PlanView.tsx';
import { BoardView } from './views/BoardView.tsx';
import { ReviewView } from './views/ReviewView.tsx';
import { VerifyView } from './views/VerifyView.tsx';
import { ShipView } from './views/ShipView.tsx';
import { EmptyState } from './components/primitives.tsx';
import { WorkingDot, WorkingIndicator } from './components/StageStatus.tsx';
import { stageStatus, isWorking, type StageStatus } from './lib/stages.ts';
import { classNames, pluralize } from './lib/format.ts';
import type { SessionState } from '../shared/types.ts';

/**
 * Tabs use the same words as the stage rail. Two vocabularies for one pipeline
 * ("Build" in one place, "Progress" in another) made the user learn a mapping
 * for no reason.
 *
 * The first tab is called Conversation, not Activity: it is not only a log of
 * what happened, it is the one place you can talk to the agent. Every other
 * tab advances through its own gate.
 */
const TABS: { id: Tab; label: string }[] = [
  { id: 'timeline', label: 'Conversation' },
  { id: 'plan', label: 'Plan' },
  { id: 'board', label: 'Board' },
  { id: 'review', label: 'Review' },
  { id: 'verify', label: 'Verify' },
  { id: 'ship', label: 'Ship' },
];

/** Both halves of the ARIA tab relationship, from one id. */
const tabId = (id: Tab) => `tab-${id}`;
const panelId = (id: Tab) => `panel-${id}`;

export function App() {
  const session = useSession();
  const sessionId = useStore((s) => s.sessionId);
  const tab = useStore((s) => s.tab);
  const error = useStore((s) => s.error);
  const gate = useOpenGate();
  const drafts = useDrafts();
  const sidebarCollapsed = useStore((s) => s.collapsedSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const tabs = useRef<HTMLElement>(null);

  useDocumentTitle(session, Boolean(gate));
  useUnsavedGuard(drafts.length);
  useShortcuts();
  useDrawerDismiss(drawerOpen);

  /**
   * Arrow keys move between tabs, Home and End jump to the ends. Without this
   * a tab strip is six separate tab stops, which is both tedious and wrong:
   * the ARIA pattern is one stop for the whole strip.
   */
  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      let next: Tab | undefined;
      if (delta !== 0) {
        const index = TABS.findIndex((t) => t.id === tab);
        next = TABS[(index + delta + TABS.length) % TABS.length]?.id;
      } else if (event.key === 'Home') next = TABS[0]?.id;
      else if (event.key === 'End') next = TABS[TABS.length - 1]?.id;
      if (!next) return;

      event.preventDefault();
      store.setTab(next);
      // Selection follows focus, so focus has to follow selection too.
      tabs.current?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus();
    },
    [tab],
  );

  return (
    <div
      className={classNames(
        'app',
        sidebarCollapsed && 'is-sidebar-collapsed',
        drawerOpen && 'is-drawer-open',
      )}
    >
      <a className="skip-link" href={`#${panelId(tab)}`}>
        Skip to content
      </a>
      <Sidebar />
      {/* Only reachable under the narrow breakpoint, where the sidebar is a
          drawer laid over the content. */}
      {drawerOpen && (
        <button type="button" className="scrim" aria-label="Close the session list" onClick={() => store.setDrawer(false)} />
      )}
      <main className="main" aria-label="Session">
        {!sessionId || !session ? (
          <NoSession error={error} />
        ) : (
          <>
            <Header session={session} />
            <ConnectionBar />
            <GateBanner />
            {/* Above the tabs on purpose: a question must be answerable
                without leaving whatever the user is reading. */}
            <QuestionGate />
            <nav className="tabs" role="tablist" aria-label="Stages" ref={tabs} onKeyDown={onTabKeyDown}>
              {TABS.map((t) => (
                <TabButton key={t.id} id={t.id} label={t.label} active={tab === t.id} session={session} />
              ))}
            </nav>
            <div
              className="view"
              key={tab}
              id={panelId(tab)}
              role="tabpanel"
              aria-labelledby={tabId(tab)}
              tabIndex={-1}
            >
              {tab === 'timeline' && <ActivityView />}
              {tab === 'plan' && <PlanView />}
              {tab === 'board' && <BoardView />}
              {tab === 'review' && <ReviewView />}
              {tab === 'verify' && <VerifyView />}
              {tab === 'ship' && <ShipView />}
            </div>
            {/* The message box belongs to the Conversation, and only there.
                Everywhere else it could do nothing but queue text behind a
                gate that has its own buttons a few centimetres away, which
                read as "this is how you reply" and was never true. */}
            {tab === 'timeline' ? <Composer /> : <TalkHint />}
          </>
        )}
      </main>
      <Toasts />
      <Announcer session={session} gate={Boolean(gate)} />
    </div>
  );
}

/** What the composer would have been, on the tabs that do not have one. */
function TalkHint() {
  const session = useSession();
  const pending = session?.pendingFeedback.length ?? 0;

  return (
    <div className="talk-hint">
      <span>
        This stage moves on through the buttons above.
        {pending > 0 && ` ${pending} message${pending === 1 ? '' : 's'} already queued.`}
      </span>
      <span className="spacer" />
      <Button size="sm" variant="ghost" onClick={() => store.setTab('timeline')}>
        Say something instead →
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TabButton({
  id,
  label,
  active,
  session,
}: {
  id: Tab;
  label: string;
  active: boolean;
  session: SessionState;
}) {
  const drafts = useDrafts();
  const status = stageStatus(session, id);
  const badge = tabBadge(id, session, status, drafts.length);

  return (
    <button
      type="button"
      role="tab"
      id={tabId(id)}
      aria-selected={active}
      aria-controls={panelId(id)}
      // One tab stop for the whole strip; the arrow keys move within it.
      tabIndex={active ? 0 : -1}
      className={classNames('tab', active && 'is-active', `is-${status.state}`)}
      // The tooltip carries the sentence the badge cannot: what state this
      // stage is in and why.
      title={status.detail ? `${label} — ${status.label}: ${status.detail}` : label}
      onClick={() => store.setTab(id)}
    >
      {label}
      {/* The badge is a glyph — a bare "✓" or "!" reads as nothing to a
          screen reader, so the meaning is carried as text beside it and the
          glyph itself is hidden. `aria-label` on a span cannot do this job:
          it is ignored on a generic element. */}
      {badge &&
        (badge.tone === 'working' ? (
          <>
            <WorkingDot title="Claude is working" />
            <span className="sr-only">Claude is working</span>
          </>
        ) : (
          <>
            <span className={classNames('tab-badge', `is-${badge.tone}`)} aria-hidden="true">
              {badge.text}
            </span>
            <span className="sr-only">{badge.label}</span>
          </>
        ))}
    </button>
  );
}

/**
 * A tab should say, without being opened, whether it needs attention — and
 * equally whether it has already been dealt with. An approved stage that
 * looks identical to an untouched one is the whole reason the pipeline felt
 * unreadable.
 */
function tabBadge(
  id: Tab,
  session: SessionState,
  status: StageStatus,
  draftCount: number,
): { text: string; tone: 'accent' | 'warning' | 'danger' | 'success' | 'working'; label: string } | null {
  // Unsent work of the user's own outranks the stage's own state: it is the
  // only badge that means "you will lose something".
  if (id === 'review' && draftCount) {
    return { text: String(draftCount), tone: 'accent', label: `${draftCount} unsent comment(s)` };
  }
  if (id === 'verify') {
    const failed = session.checks.filter((c) => c.status === 'failed').length;
    if (failed) return { text: String(failed), tone: 'danger', label: `${failed} failing check(s)` };
  }
  if (id === 'board' && status.state !== 'awaiting' && session.tasks.length > 0) {
    const open = session.tasks.filter((t) => t.status !== 'done').length;
    if (open > 0) return { text: String(open), tone: 'accent', label: `${open} card(s) open` };
  }
  // Liveness is the Conversation's subject, so the animation lives on that
  // tab alone.
  // A stage tab pulsing for the twenty minutes after its verdict was given
  // would say "look here" about a page with nothing on it to do.
  if (id === 'timeline' && status.state !== 'awaiting' && isWorking(session)) {
    return { text: '', tone: 'working', label: 'Claude is working' };
  }

  switch (status.state) {
    case 'awaiting':
      return { text: id === 'timeline' ? '?' : '!', tone: 'warning', label: 'waiting on you' };
    // A stage being acted on still shows the verdict that set it going: that
    // is the thing the reader is trying to remember.
    case 'working':
      return status.tone === 'warning'
        ? { text: '↻', tone: 'warning', label: 'changes requested — Claude is working' }
        : { text: '✓', tone: 'success', label: `${status.label.toLowerCase()} — Claude is working` };
    case 'changes':
      return { text: '↻', tone: 'warning', label: 'changes requested' };
    case 'rejected':
      return { text: '✕', tone: 'danger', label: 'rejected' };
    case 'approved':
    case 'done':
      return { text: '✓', tone: 'success', label: status.label.toLowerCase() };
    default:
      return null;
  }
}

function Header({ session }: { session: SessionState }) {
  const done = session.todos.filter((t) => t.status === 'completed').length;
  const drawerOpen = useStore((s) => s.drawerOpen);

  return (
    <header className="head">
      <div className="head-main">
        {/* CSS decides whether this exists at all: it is `display: none`
            until the sidebar becomes a drawer. */}
        <button
          type="button"
          className="icon-btn drawer-toggle"
          aria-label="Open the session list"
          aria-expanded={drawerOpen}
          onClick={() => store.setDrawer(true)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <h1 className="head-title" title={session.cwd}>
          {session.title}
        </h1>
        {session.worktree && (
          <code className="head-worktree" title={`Working in worktree ${session.worktree.path}`}>
            ⑂ {session.worktree.name}
          </code>
        )}
        {session.branch && <code className="head-branch">{session.branch}</code>}
        <span className={classNames('head-status', `is-${session.status}`)}>
          {isWorking(session) ? <WorkingIndicator session={session} verbose /> : statusLabel(session)}
        </span>
        <span className="spacer" />
        <ThemeToggle />
      </div>
      <div className="head-meta">
        {session.todos.length > 0 && (
          <span className="head-stat">
            {done}/{session.todos.length} tasks
          </span>
        )}
        {session.files.length > 0 && <span className="head-stat">{pluralize(session.files.length, 'file')}</span>}
        {session.usage && session.usage.outputTokens > 0 && (
          <span className="head-stat" title={usageTooltip(session)}>
            {formatTokens(session.usage.outputTokens)} out
          </span>
        )}
        <span className="head-path" title={session.cwd}>
          {session.cwd}
        </span>
      </div>
    </header>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Spend attributed to the stage that was live when it was incurred. */
function usageTooltip(session: SessionState): string {
  const usage = session.usage;
  if (!usage) return '';
  const byStage = Object.entries(usage.byStage)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([stage, v]) => `  ${stage}: ${formatTokens(v)}`)
    .join('\n');
  return `Output tokens by stage:\n${byStage}\n\nInput (incl. cache): ${formatTokens(usage.inputTokens)}`;
}

function statusLabel(session: SessionState): string {
  switch (session.status) {
    case 'active':
      return 'working';
    case 'waiting':
      return 'waiting on you';
    case 'idle':
      return 'idle';
    case 'ended':
      return 'ended';
  }
}

function NoSession({ error }: { error: string | null }) {
  return (
    <div className="view">
      <EmptyState
        title="No session yet"
        hint={
          <>
            Start Claude Code in a project with the harness enabled, then run <code>/harness</code>. Sessions
            appear here the moment they register.
            {error && <span className="error-text"> · {error}</span>}
          </>
        }
        action={
          <p className="empty-hint">
            If a session is running and nothing shows up, the hooks are not firing — run{' '}
            <code>harness doctor</code>.
          </p>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ambient behaviour
 * ------------------------------------------------------------------ */

/** The tab title is the only signal that reaches a user in another window. */
function useDocumentTitle(session: SessionState | null, blocked: boolean): void {
  useEffect(() => {
    const name = session?.title ?? 'cc-harness';
    document.title = blocked ? `● ${name} — waiting on you` : name;
  }, [session?.title, blocked]);
}

/** Unsubmitted comments are the user's own writing. Never lose them silently. */
function useUnsavedGuard(draftCount: number): void {
  useEffect(() => {
    if (draftCount === 0) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [draftCount]);
}

/**
 * One always-mounted polite live region.
 *
 * A region that is inserted at the same moment its text appears is usually
 * missed — assistive tech watches regions it already knows about. So it is
 * mounted empty for the life of the app and only its text changes.
 */
function Announcer({ session, gate }: { session: SessionState | null; gate: boolean }) {
  const message = !session
    ? ''
    : gate
      ? `${session.title}: Claude is waiting on you.`
      : session.status === 'active'
        ? `${session.title}: Claude is working.`
        : '';

  return (
    <p className="sr-only" role="status" aria-live="polite">
      {message}
    </p>
  );
}

/** Escape closes the drawer, and so does a resize past the breakpoint that
 *  created it — a drawer still latched open on a wide window would sit on top
 *  of the sidebar it duplicates. */
function useDrawerDismiss(open: boolean): void {
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') store.setDrawer(false);
    };
    const onResize = () => {
      if (window.innerWidth > 900) store.setDrawer(false);
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);
}

function useShortcuts(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      const map: Record<string, Tab> = {
        '1': 'timeline',
        '2': 'plan',
        '3': 'board',
        '4': 'review',
        '5': 'verify',
        '6': 'ship',
      };
      const tab = map[event.key];
      if (tab) {
        event.preventDefault();
        store.setTab(tab);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
