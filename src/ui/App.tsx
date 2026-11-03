import { useCallback, useEffect, useRef } from 'react';
import { store, useStore, useSession, TAB_IDS, type Tab } from './store.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { Toasts } from './components/Toasts.tsx';
import { ConnectionBar } from './components/ConnectionBar.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { Handoff } from './components/Handoff.tsx';
import { InlineText } from './components/Editable.tsx';
import { ProgressBar } from './components/Progress.tsx';
import { EmptyState } from './components/primitives.tsx';
import { OverviewView } from './views/OverviewView.tsx';
import { DiagramsView } from './views/DiagramsView.tsx';
import { TasksView } from './views/TasksView.tsx';
import { QuestionsView } from './views/QuestionsView.tsx';
import { ActivityView } from './views/ActivityView.tsx';
import { classNames } from './lib/format.ts';
import { countTasks, unreadByClaude } from '../shared/plan.ts';
import type { Plan, SessionState } from '../shared/types.ts';

const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  diagrams: 'Diagrams',
  tasks: 'Tasks',
  questions: 'Questions',
  activity: 'Activity',
};

const tabId = (id: Tab) => `tab-${id}`;
const panelId = (id: Tab) => `panel-${id}`;

/**
 * The planning workspace: one plan per Claude session, laid out to be read,
 * reorganized and argued with. There is deliberately no way to message Claude
 * from here — that happens in Claude's own chat, and the header says when
 * Claude is behind on what changed.
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
        {!sessionId || !session ? (
          <NoSession error={error} />
        ) : (
          <>
            <Header session={session} />
            <ConnectionBar />
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
                  {tab === 'overview' && <OverviewView />}
                  {tab === 'diagrams' && <DiagramsView />}
                  {tab === 'tasks' && <TasksView />}
                  {tab === 'questions' && <QuestionsView />}
                  {tab === 'activity' && <ActivityView />}
                </div>
              </>
            )}
          </>
        )}
      </main>
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
    case 'questions': {
      const forYou = plan.questions.filter((q) => !q.answer && q.askedBy === 'claude').length;
      if (forYou) return { text: String(forYou), tone: 'warning', label: `${forYou} question(s) from Claude to answer` };
      const open = plan.questions.filter((q) => !q.answer).length;
      return open ? { text: String(open), tone: 'neutral', label: `${open} open question(s)` } : null;
    }
    case 'activity': {
      const unread = unreadByClaude(plan).length;
      return unread ? { text: String(unread), tone: 'accent', label: `${unread} change(s) Claude has not read` } : null;
    }
    default:
      return null;
  }
}

function Header({ session }: { session: SessionState }) {
  const drawerOpen = useStore((s) => s.drawerOpen);
  const saving = useStore((s) => s.saving);
  const plan = session.plan;
  const counts = countTasks(plan);

  return (
    <header className="head">
      <div className="head-main">
        <button
          type="button"
          className="icon-btn drawer-toggle"
          aria-label="Open the session list"
          aria-expanded={drawerOpen}
          onClick={() => store.setDrawer(true)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        {plan ? (
          <InlineText
            as="h1"
            className="head-title"
            value={plan.title}
            label="Plan title"
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
        <span className={classNames('head-status', `is-${session.status}`)} title="The Claude session this plan belongs to">
          {session.status === 'active' ? 'Claude is working' : session.status === 'idle' ? 'Claude is idle' : 'session ended'}
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

function NoPlan({ session }: { session: SessionState }) {
  return (
    <div className="view">
      <EmptyState
        title="No plan yet"
        hint={
          <>
            In Claude's chat, run <code>/harness &lt;what you want to build&gt;</code>. Claude investigates the code, then
            publishes its plan here — architecture, diagrams, a task breakdown and the questions it needs answered.
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

function NoSession({ error }: { error: string | null }) {
  return (
    <div className="view">
      <EmptyState
        title="No session yet"
        hint={
          <>
            Start Claude Code in a project with the harness enabled, then run <code>/harness</code>. Sessions appear here the
            moment they register.
            {error && <span className="error-text"> · {error}</span>}
          </>
        }
        action={
          <p className="empty-hint">
            If a session is running and nothing shows up, the hooks are not firing — run <code>harness doctor</code>.
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
  const title = session?.plan?.title ?? session?.title ?? 'cc-harness';
  useEffect(() => {
    document.title = `${title} — plan`;
  }, [title]);
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

/** 1–5 switch tabs, when the keyboard is not busy typing. */
function useShortcuts(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
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
