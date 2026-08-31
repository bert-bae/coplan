import { useEffect } from 'react';
import { store, useStore, useSession, useOpenGate, useDrafts, type Tab } from './store.ts';
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
 */
const TABS: { id: Tab; label: string }[] = [
  { id: 'timeline', label: 'Activity' },
  { id: 'plan', label: 'Plan' },
  { id: 'board', label: 'Board' },
  { id: 'review', label: 'Review' },
  { id: 'verify', label: 'Verify' },
  { id: 'ship', label: 'Ship' },
];

export function App() {
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

  return (
    <div className={classNames('app', sidebarCollapsed && 'is-sidebar-collapsed')}>
      <Sidebar />
      <main className="main">
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
            <nav className="tabs" role="tablist">
              {TABS.map((t) => (
                <TabButton key={t.id} id={t.id} label={t.label} active={tab === t.id} session={session} />
              ))}
            </nav>
            <div className="view" key={tab}>
              {tab === 'timeline' && <ActivityView />}
              {tab === 'plan' && <PlanView />}
              {tab === 'board' && <BoardView />}
              {tab === 'review' && <ReviewView />}
              {tab === 'verify' && <VerifyView />}
              {tab === 'ship' && <ShipView />}
            </div>
            <Composer />
          </>
        )}
      </main>
      <Toasts />
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
      aria-selected={active}
      className={classNames('tab', active && 'is-active', `is-${status.state}`)}
      // The tooltip carries the sentence the badge cannot: what state this
      // stage is in and why.
      title={status.detail ? `${label} — ${status.label}: ${status.detail}` : label}
      onClick={() => store.setTab(id)}
    >
      {label}
      {badge &&
        (badge.tone === 'working' ? (
          <WorkingDot title="Claude is working" />
        ) : (
          <span className={classNames('tab-badge', `is-${badge.tone}`)} aria-label={badge.label}>
            {badge.text}
          </span>
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
  // Liveness is Activity's subject, so the animation lives on that tab alone.
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

  return (
    <header className="head">
      <div className="head-main">
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
