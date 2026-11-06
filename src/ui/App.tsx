import { useCallback, useEffect, useRef } from 'react';
import { listedSessions, store, useStore, useSession, TAB_IDS, type Tab } from './store.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { Toasts } from './components/Toasts.tsx';
import { ConnectionBar } from './components/ConnectionBar.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { Handoff, WaitingBanner } from './components/Handoff.tsx';
import { PromptViewerHost } from './components/PromptView.tsx';
import { PhaseStrip } from './components/Submit.tsx';
import { ProposalsStrip } from './components/Proposals.tsx';
import { InlineText } from './components/Editable.tsx';
import { ProgressBar } from './components/Progress.tsx';
import { EmptyState } from './components/primitives.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { DiagramsView } from './views/DiagramsView.tsx';
import { TasksView } from './views/TasksView.tsx';
import { classNames } from './lib/format.ts';
import { countTasks, isLocked } from '../shared/plan.ts';
import { agentInfo } from '../shared/agents.ts';
import type { Plan, SessionState } from '../shared/types.ts';

const TAB_LABEL: Record<Tab, string> = {
  diagrams: 'Architecture',
  tasks: 'Tasks',
  overview: 'Overview',
};

const tabId = (id: Tab) => `tab-${id}`;
const panelId = (id: Tab) => `panel-${id}`;

/**
 * The planning workspace: one plan per Claude session, laid out to be read and
 * reorganized, and to follow Claude's progress through it. There is
 * deliberately no way to message or answer Claude from here — that happens in
 * Claude itself, and the page links there whenever Claude is waiting.
 */
export function App() {
  const session = useSession();
  const sessionId = useStore((s) => s.sessionId);
  const tab = useStore((s) => s.tab);
  const error = useStore((s) => s.error);
  const sidebarCollapsed = useStore((s) => s.collapsedSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const tabs = useRef<HTMLElement>(null);
  const plan = session?.plan ?? null;

  useDocumentTitle(session);
  useShortcuts();
  useDrawerDismiss(drawerOpen);

  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      let next: Tab | undefined;
      if (delta !== 0) next = TAB_IDS[(TAB_IDS.indexOf(tab) + delta + TAB_IDS.length) % TAB_IDS.length];
      else if (event.key === 'Home') next = TAB_IDS[0];
      else if (event.key === 'End') next = TAB_IDS[TAB_IDS.length - 1];
      if (!next) return;
      event.preventDefault();
      store.setTab(next);
      tabs.current?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus();
    },
    [tab],
  );

  return (
    <div className={classNames('app', sidebarCollapsed && 'is-sidebar-collapsed', drawerOpen && 'is-drawer-open')}>
      <a className="skip-link" href={`#${panelId(tab)}`}>
        Skip to content
      </a>
      <Sidebar />
      {drawerOpen && <button type="button" className="scrim" aria-label="Close the session list" onClick={() => store.setDrawer(false)} />}
      <main className="main" aria-label="Plan">
        {!sessionId ? (
          <NoSession error={error} />
        ) : !session ? (
          error ? <SessionUnavailable error={error} /> : <Loading />
        ) : (
          <>
            <Header session={session} />
            <ConnectionBar />
            <WaitingBanner session={session} />
            <PhaseStrip session={session} />
            {plan && <ProposalsStrip plan={plan} />}
            {!plan ? (
              <NoPlan session={session} />
            ) : (
              <>
                <nav className="tabs" role="tablist" aria-label="Plan views" ref={tabs} onKeyDown={onTabKeyDown}>
                  {TAB_IDS.map((t) => (
                    <TabButton key={t} id={t} active={tab === t} plan={plan} />
                  ))}
                </nav>
                <div className="view" key={tab} id={panelId(tab)} role="tabpanel" aria-labelledby={tabId(tab)} tabIndex={-1}>
                  <ErrorBoundary label={`${TAB_LABEL[tab]} view`} resetKey={`${sessionId}:${tab}`}>
                    {tab === 'overview' && <OverviewView />}
                    {tab === 'diagrams' && <DiagramsView />}
                    {tab === 'tasks' && <TasksView />}
                  </ErrorBoundary>
                </div>
              </>
            )}
          </>
        )}
      </main>
      <PromptViewerHost />
      <Toasts />
    </div>
  );
}

function TabButton({ id, active, plan }: { id: Tab; active: boolean; plan: Plan }) {
  const badge = tabBadge(id, plan);
  return (
    <button
      type="button"
      role="tab"
      id={tabId(id)}
      aria-selected={active}
      aria-controls={panelId(id)}
      tabIndex={active ? 0 : -1}
      className={classNames('tab', active && 'is-active')}
      onClick={() => store.setTab(id)}
    >
      {TAB_LABEL[id]}
      {badge && (
        <>
          <span className={classNames('tab-badge', `is-${badge.tone}`)} aria-hidden="true">
            {badge.text}
          </span>
          <span className="sr-only">{badge.label}</span>
        </>
      )}
    </button>
  );
}

/** A tab says, without being opened, whether there is something in it for you. */
function tabBadge(id: Tab, plan: Plan): { text: string; tone: 'neutral' | 'accent' | 'warning'; label: string } | null {
  switch (id) {
    case 'diagrams':
      return plan.diagrams.length ? { text: String(plan.diagrams.length), tone: 'neutral', label: `${plan.diagrams.length} diagrams` } : null;
    case 'tasks': {
      const c = countTasks(plan);
      return c.total ? { text: `${c.done}/${c.total}`, tone: 'neutral', label: `${c.done} of ${c.total} done` } : null;
    }
    default:
      return null;
  }
}

function Header({ session }: { session: SessionState }) {
  const saving = useStore((s) => s.saving);
  const plan = session.plan;
  const counts = countTasks(plan);
  const agent = agentInfo(session.agent);

  return (
    <header className="head">
      <div className="head-main">
        <SessionsToggle />
        {plan ? (
          <InlineText
            as="h1"
            className="head-title"
            value={plan.title}
            label="Plan title"
            readOnly={isLocked(plan)}
            onSave={(title) => store.op({ op: 'set_meta', title })}
          />
        ) : (
          <h1 className="head-title">{session.title}</h1>
        )}
        {saving > 0 && <span className="muted head-saving">saving…</span>}
        <span className="spacer" />
        <Handoff />
        <ThemeToggle />
      </div>
      <div className="head-meta">
        <span className={classNames('head-status', `is-${session.waiting ? 'waiting' : session.status}`)} title={`The ${agent.product} session this plan belongs to`}>
          {session.waiting
            ? `${agent.name} is waiting on you`
            : session.status === 'active'
              ? `${agent.name} is working`
              : session.status === 'idle'
                ? `${agent.name} is idle`
                : 'session ended'}
        </span>
        {plan && plan.title !== session.title && <span className="head-stat">{session.title}</span>}
        {session.branch && <code className="head-branch">{session.branch}</code>}
        {counts.total > 0 && (
          <span className="head-progress">
            <ProgressBar counts={counts} compact />
            <span className="head-stat">
              {counts.done}/{counts.total} tasks
            </span>
          </span>
        )}
        <span className="head-path" title={session.cwd}>
          {session.cwd}
        </span>
      </div>
    </header>
  );
}

/**
 * Shows and hides the session list. On a wide window that folds the sidebar
 * to a rail of initials, giving the plan the width; under the drawer
 * breakpoint it opens the drawer instead.
 */
function SessionsToggle() {
  const collapsed = useStore((s) => s.collapsedSidebar);
  const drawerOpen = useStore((s) => s.drawerOpen);
  const narrow = () => window.innerWidth <= 900;
  const label = collapsed ? 'Show sessions' : 'Hide sessions';
  return (
    <button
      type="button"
      className="icon-btn sessions-toggle"
      title={`${label} ( [ )`}
      aria-label={label}
      aria-expanded={narrow() ? drawerOpen : !collapsed}
      onClick={() => (narrow() ? store.setDrawer(true) : store.toggleSidebar())}
    >
      <span aria-hidden="true">☰</span>
    </button>
  );
}

/** How a user asks each agent for a plan: a slash command in Claude Code
 *  and Cursor, a skill mention in Codex. */
const START_PLAN: Record<SessionState['agent'], string> = {
  claude: '/coplan <what you want to build>',
  codex: '$coplan <what you want to build>',
  cursor: '/coplan <what you want to build>',
};

function NoPlan({ session }: { session: SessionState }) {
  const agent = agentInfo(session.agent);
  return (
    <div className="view">
      <EmptyState
        title="No plan yet"
        hint={
          <>
            In {agent.name}'s chat, run <code>{START_PLAN[agent.kind]}</code>. {agent.name} investigates the code, then
            publishes its plan here — the architecture, diagrams and a task breakdown — and asks what it needs to know
            in the chat.
          </>
        }
        action={
          <button type="button" className="btn" onClick={() => void store.op({ op: 'set_meta', title: session.title || 'Untitled plan' })}>
            Start a plan by hand
          </button>
        }
      />
    </div>
  );
}

function Loading() {
  return (
    <div className="view">
      <div className="loading" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        Loading the plan…
      </div>
    </div>
  );
}

/** The session asked for cannot be shown: deleted, expired, or the page has
 *  lost its credentials. Say which, and offer the way on. */
function SessionUnavailable({ error }: { error: string }) {
  const sessions = useStore((s) => s.sessions);
  const unauthorized = /401|unauthorized/i.test(error);
  const other = listedSessions(sessions, null)[0];
  return (
    <div className="view">
      <EmptyState
        title={unauthorized ? 'This page is not signed in to Coplan' : 'This session is not available'}
        hint={
          unauthorized ? (
            <>
              Open Coplan with <code>/coplan-open</code> in Claude Code or Cursor, <code>$coplan-open</code> in Codex, or{' '}
              <code>coplan open</code> in a terminal — the link it prints carries the key this page needs.
            </>
          ) : (
            <>It may have been deleted, or it ended long enough ago to be cleaned up. ({error})</>
          )
        }
        action={
          !unauthorized && other ? (
            <button type="button" className="btn" onClick={() => void store.selectSession(other.sessionId)}>
              Open {other.planTitle ?? other.title}
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

function NoSession({ error }: { error: string | null }) {
  if (error && /401|unauthorized/i.test(error)) return <SessionUnavailable error={error} />;
  return (
    <div className="view">
      <EmptyState
        title="No session yet"
        hint={
          <>
            Start Claude Code, Codex or Cursor in a project with Coplan enabled, then ask for a plan:{' '}
            <code>/coplan</code> in Claude Code and Cursor, <code>$coplan</code> in Codex. The session appears here as soon
            as you do.
            {error && <span className="error-text"> · {error}</span>}
          </>
        }
        action={
          <p className="empty-hint">
            If a session is running and nothing shows up, the hooks are not firing — run <code>coplan doctor</code>.
          </p>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ambient behaviour
 * ------------------------------------------------------------------ */

function useDocumentTitle(session: SessionState | null): void {
  const title = session?.plan?.title ?? session?.title ?? 'Coplan';
  const waiting = Boolean(session?.waiting);
  const name = agentInfo(session?.agent).name;
  useEffect(() => {
    // The tab title is the only signal that reaches a user in another window.
    document.title = waiting ? `● ${title} — ${name} is waiting` : `${title} — plan`;
  }, [title, waiting, name]);
}

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

/** 1–3 switch tabs, when the keyboard is not busy typing. */
function useShortcuts(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      // Not behind an open dialog: the page under it should hold still.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.key === '[') {
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
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
