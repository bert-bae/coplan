import { store, useStore } from '../store.ts';
import { classNames, relativeTime } from '../lib/format.ts';
import type { SessionSummary } from '../../shared/types.ts';

declare const __HARNESS_VERSION__: string;

const STAGE_LABEL: Record<string, string> = {
  idle: 'Idle',
  planning: 'Planning',
  plan_review: 'Plan review',
  implementing: 'Building',
  code_review: 'Code review',
  verification: 'Verifying',
  ship: 'Shipping',
  done: 'Done',
};

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.sessionId);
  const connection = useStore((s) => s.connection);
  const collapsed = useStore((s) => s.collapsedSidebar);

  return (
    <aside className={classNames('sidebar', collapsed && 'is-collapsed')}>
      <header className="sidebar-head">
        <span className="logo" aria-hidden="true">
          cc
        </span>
        <div className="sidebar-brand">
          <strong>harness</strong>
          <span className={classNames('conn', `is-${connection}`)}>
            {connection === 'live' ? 'live' : connection === 'connecting' ? 'connecting…' : 'reconnecting…'}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => store.toggleSidebar()}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </header>

      <nav className="session-list">
        {sessions.length === 0 ? (
          <p className="sidebar-empty">No sessions yet.</p>
        ) : (
          sessions.map((s) => <SessionRow key={s.sessionId} session={s} active={s.sessionId === current} />)
        )}
      </nav>

      <footer className="sidebar-foot">
        <span>v{typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : 'dev'}</span>
      </footer>
    </aside>
  );
}

function SessionRow({ session, active }: { session: SessionSummary; active: boolean }) {
  const drafts = useStore((s) => s.drafts[session.sessionId]?.length ?? 0);

  return (
    <button
      type="button"
      className={classNames('session-row', active && 'is-active')}
      onClick={() => void store.selectSession(session.sessionId)}
    >
      <span className="session-name">
        {session.openGates > 0 && (
          <span className="dot is-gate" title="Claude is waiting on you" aria-label="waiting on you" />
        )}
        {session.repoName ?? session.title}
      </span>
      <span className="session-sub">
        <span className="session-stage">{STAGE_LABEL[session.stage] ?? session.stage}</span>
        {session.branch && <span className="session-branch">{session.branch}</span>}
      </span>
      <span className="session-foot">
        <span>{relativeTime(session.updatedAt)}</span>
        {drafts > 0 && <span className="pill is-draft">{drafts} draft</span>}
        {session.pendingFeedback > 0 && <span className="pill is-queued">{session.pendingFeedback} queued</span>}
      </span>
    </button>
  );
}
