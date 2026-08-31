import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../store.ts';
import { GlobalActions } from './GlobalActions.tsx';
import { WorkingDot } from './StageStatus.tsx';
import { classNames, relativeTime } from '../lib/format.ts';
import type { SessionSummary } from '../../shared/types.ts';

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

/** What the session itself is doing, alongside where in the pipeline it is.
 *  Stage and status answer different questions and were being conflated. */
const SESSION_STATE_LABEL: Record<string, string> = {
  active: 'working',
  waiting: 'needs you',
  idle: 'stopped',
  ended: 'ended',
};

/** The attention section is a group like any other, with a reserved key. */
const PINNED_KEY = '\u0000pinned';

/** Sessions Claude has stopped on. These are lifted to the top group whether
 *  or not they were pinned: the whole reason to look at the rail is to find
 *  the one that is blocked on you. */
function needsAttention(session: SessionSummary): boolean {
  return session.openGates > 0 || session.status === 'waiting';
}

interface Group {
  key: string;
  label: string;
  /** Full path, shown as the header's tooltip. Empty for the pinned group. */
  path: string;
  sessions: SessionSummary[];
  openGates: number;
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.sessionId);
  const connection = useStore((s) => s.connection);
  const collapsed = useStore((s) => s.collapsedSidebar);
  const pinned = useStore((s) => s.pinned);
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const soundEnabled = useStore((s) => s.soundEnabled);

  const drawerOpen = useStore((s) => s.drawerOpen);
  const groups = groupSessions(sessions, pinned);

  return (
    <aside
      className={classNames('sidebar', collapsed && 'is-collapsed', drawerOpen && 'is-drawer-open')}
      aria-label="Sessions"
    >
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
          className={classNames('icon-btn', !soundEnabled && 'is-muted')}
          title={soundEnabled ? 'Mute the alert chime' : 'Play a chime when Claude needs you'}
          aria-label={soundEnabled ? 'Mute the alert chime' : 'Play a chime when Claude needs you'}
          aria-pressed={soundEnabled}
          onClick={() => store.toggleSound()}
        >
          <span aria-hidden="true">{soundEnabled ? '🔔' : '🔕'}</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          onClick={() => store.toggleSidebar()}
        >
          <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
        </button>
      </header>

      <nav className="session-list" aria-label="Live sessions">
        {sessions.length === 0 ? (
          <p className="sidebar-empty">No sessions yet.</p>
        ) : (
          groups.map((group) => (
            <ProjectGroup
              key={group.key}
              group={group}
              current={current}
              open={!collapsedProjects.includes(group.key)}
              showRepo={group.key === PINNED_KEY}
            />
          ))
        )}
      </nav>

      <footer className="sidebar-foot">
        <GlobalActions />
      </footer>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Sessions bucketed by the repository they run in.
 *
 * Grouping is on the repo *root*, not its name: two checkouts of the same
 * project (a worktree and its main clone, say) are different working trees and
 * folding them together would make the branch column lie.
 */
export function groupSessions(sessions: SessionSummary[], pinned: string[]): Group[] {
  const pinnedSet = new Set(pinned);
  const groups = new Map<string, Group>();

  for (const session of sessions) {
    const lift = pinnedSet.has(session.sessionId) || needsAttention(session);
    const key = lift ? PINNED_KEY : (session.repoRoot ?? session.cwd);
    let group = groups.get(key);
    if (!group) {
      group =
        key === PINNED_KEY
          ? { key, label: 'Pinned / Action required', path: '', sessions: [], openGates: 0 }
          : {
              key,
              label: groupLabel(session),
              path: session.repoRoot ?? session.cwd,
              sessions: [],
              openGates: 0,
            };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.openGates += session.openGates;
  }

  // `sessions` arrives newest-first, so each bucket is already ordered. Order
  // the buckets themselves the same way, and keep pinned at the top.
  return [...groups.values()].sort((a, b) => {
    if (a.key === PINNED_KEY) return -1;
    if (b.key === PINNED_KEY) return 1;
    return (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0);
  });
}

/**
 * A worktree gets its own group — its `repoRoot` is the worktree itself — so
 * without naming it, every worktree of one repo would render the same header.
 */
function groupLabel(session: SessionSummary): string {
  const repo = session.repoName ?? basename(session.cwd) ?? 'Unknown project';
  return session.worktree ? `${repo} ⑂ ${session.worktree}` : repo;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function ProjectGroup({
  group,
  current,
  open,
  showRepo,
}: {
  group: Group;
  current: string | null;
  open: boolean;
  showRepo: boolean;
}) {
  // A collapsed group hiding the session you are looking at is disorienting,
  // and so is one hiding a session that is blocked on you.
  const holdsCurrent = group.sessions.some((s) => s.sessionId === current);
  const expanded = open || holdsCurrent;

  return (
    <section className={classNames('session-group', expanded && 'is-open')}>
      <button
        type="button"
        className="session-group-head"
        aria-expanded={expanded}
        title={group.path || undefined}
        onClick={() => store.toggleProject(group.key)}
      >
        <span className="session-group-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="session-group-name">{group.label}</span>
        {group.openGates > 0 && (
          <span className="dot is-gate" title="A session here is waiting on you" aria-label="waiting on you" />
        )}
        <span className="session-group-count">{group.sessions.length}</span>
      </button>

      {expanded && (
        <div className="session-group-body">
          {group.sessions.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              active={s.sessionId === current}
              showRepo={showRepo}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionRow({
  session,
  active,
  showRepo,
}: {
  session: SessionSummary;
  active: boolean;
  showRepo: boolean;
}) {
  const drafts = useStore((s) => s.drafts[session.sessionId]?.length ?? 0);
  const pinned = useStore((s) => s.pinned.includes(session.sessionId));
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);

  return (
    <div
      className={classNames(
        'session-row',
        active && 'is-active',
        confirming && 'is-confirming',
        needsAttention(session) && 'needs-you',
      )}
    >
      {renaming ? (
        <RenameField session={session} onDone={() => setRenaming(false)} />
      ) : (
      <button
        type="button"
        className="session-open"
        // The rail is a list of destinations; which one you are on is the
        // thing a screen reader otherwise cannot tell from the styling.
        aria-current={active ? 'true' : undefined}
        onClick={() => {
          void store.selectSession(session.sessionId);
          // On a narrow window the rail is a drawer over the content:
          // picking a session means you are done with the list.
          store.setDrawer(false);
        }}
        onDoubleClick={() => setRenaming(true)}
        title={`${session.title}\n${session.cwd}\nDouble-click to rename`}
      >
        <span className="session-name">
          {session.openGates > 0 ? (
            <span className="dot is-gate" title="Claude is waiting on you" aria-label="waiting on you" />
          ) : (
            // Motion, not a word: the rail is scanned, not read, and "active"
            // sitting still is indistinguishable from a stale page.
            session.status === 'active' && <WorkingDot title="Claude is working" />
          )}
          {session.title}
        </span>
        <span className="session-sub">
          <span className="session-stage">{STAGE_LABEL[session.stage] ?? session.stage}</span>
          <span className={classNames('session-state', `is-${session.status}`)}>
            {SESSION_STATE_LABEL[session.status] ?? session.status}
          </span>
          {session.branch && <span className="session-branch">{session.branch}</span>}
        </span>
        <span className="session-foot">
          {showRepo && session.repoName && <span className="session-repo">{groupLabel(session)}</span>}
          <span>{relativeTime(session.updatedAt)}</span>
          {drafts > 0 && <span className="pill is-draft">{drafts} draft</span>}
          {session.pendingFeedback > 0 && (
            <span className="pill is-queued">{session.pendingFeedback} queued</span>
          )}
        </span>
      </button>
      )}

      <div className="session-actions">
        <button
          type="button"
          className="icon-btn is-tiny"
          title="Rename this session"
          aria-label={`Rename ${session.title}`}
          onClick={() => setRenaming(true)}
        >
          <span aria-hidden="true">✎</span>
        </button>
        <button
          type="button"
          className={classNames('icon-btn', 'is-tiny', pinned && 'is-active')}
          aria-pressed={pinned}
          title={pinned ? 'Unpin session' : 'Pin session'}
          aria-label={pinned ? `Unpin ${session.title}` : `Pin ${session.title}`}
          onClick={() => store.togglePin(session.sessionId)}
        >
          <span aria-hidden="true">{pinned ? '★' : '☆'}</span>
        </button>
        <button
          type="button"
          className="icon-btn is-tiny is-danger"
          title="Delete session"
          aria-label={`Delete ${session.title}`}
          onClick={() => setConfirming(true)}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      {confirming && (
        <div className="session-confirm">
          <span>Delete permanently?</span>
          <div className="row-actions">
            <button
              type="button"
              className="link is-danger"
              onClick={() => {
                setConfirming(false);
                void store.deleteSession(session.sessionId);
              }}
            >
              Delete
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline rename. Commits on Enter or blur, abandons on Escape — the same
 *  contract as renaming a file in an editor. */
function RenameField({ session, onDone }: { session: SessionSummary; onDone: () => void }) {
  const [value, setValue] = useState(session.title);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
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

  return (
    <input
      ref={input}
      className="session-rename"
      value={value}
      aria-label={`Rename ${session.title}`}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') abandon();
      }}
    />
  );
}
