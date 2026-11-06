import { useEffect, useRef, useState } from 'react';
import { listedSessions, store, useStore } from '../store.ts';
import { GlobalActions } from './GlobalActions.tsx';
import { classNames, relativeTime } from '../lib/format.ts';
import { agentInfo } from '../../shared/agents.ts';
import { PLAN_STATUSES, type PlanStatus, type SessionSummary } from '../../shared/types.ts';
import { PLAN_STATUS, statusTitle, summaryFacts } from '../lib/status.ts';

/** What the agent session behind the plan is doing. */
const SESSION_STATE_LABEL: Record<string, string> = {
  active: 'working',
  idle: 'idle',
  ended: 'ended',
};

/** The sessions the list shows under a status filter: all of them, or
 *  those whose plan has that status (#66). */
export function filterByStatus(sessions: SessionSummary[], status: PlanStatus | null): SessionSummary[] {
  return status ? sessions.filter((s) => summaryFacts(s).planStatus === status) : sessions;
}

/** The lifted sections are groups like any other, with reserved keys. */
const WAITING_KEY = '\u0000waiting';
const PINNED_KEY = '\u0000pinned';

interface Group {
  key: string;
  label: string;
  /** Full path, shown as the header's tooltip. Empty for the pinned group. */
  path: string;
  sessions: SessionSummary[];
}

export function Sidebar() {
  const all = useStore((s) => s.sessions);
  const current = useStore((s) => s.sessionId);
  const listed = listedSessions(all, current);
  const statusFilter = useStore((s) => s.statusFilter);
  const sessions = filterByStatus(listed, statusFilter);
  const connection = useStore((s) => s.connection);
  const collapsed = useStore((s) => s.collapsedSidebar);
  const pinned = useStore((s) => s.pinned);
  const collapsedProjects = useStore((s) => s.collapsedProjects);

  const drawerOpen = useStore((s) => s.drawerOpen);
  const groups = groupSessions(sessions, pinned);

  return (
    <aside
      className={classNames('sidebar', collapsed && 'is-collapsed', drawerOpen && 'is-drawer-open')}
      aria-label="Sessions"
    >
      <header className="sidebar-head">
        <span className="logo" aria-hidden="true">
          co
        </span>
        <div className="sidebar-brand">
          <strong>Coplan</strong>
          <span className={classNames('conn', `is-${connection}`)}>
            {connection === 'live' ? 'live' : connection === 'connecting' ? 'connecting…' : 'reconnecting…'}
          </span>
        </div>
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

      {collapsed && !drawerOpen ? (
        <CollapsedRail sessions={listed} current={current} />
      ) : (
      <nav className="session-list" aria-label="Live sessions">
        {listed.length > 0 && <StatusFilter sessions={listed} active={statusFilter} />}
        {listed.length === 0 ? (
          <p className="sidebar-empty">
            No plans yet. Type <code>/coplan</code> in a session (<code>$coplan</code> in Codex) to start one.
          </p>
        ) : sessions.length === 0 ? (
          <p className="sidebar-empty">
            No plan is {PLAN_STATUS[statusFilter!].label.toLowerCase()}.{' '}
            <button type="button" className="link" onClick={() => store.setStatusFilter(null)}>
              Show all
            </button>
          </p>
        ) : (
          groups.map((group) => (
            <ProjectGroup
              key={group.key}
              group={group}
              current={current}
              open={!collapsedProjects.includes(group.key)}
              showRepo={group.key === PINNED_KEY || group.key === WAITING_KEY}
            />
          ))
        )}
      </nav>
      )}

      <footer className="sidebar-foot">
        <GlobalActions />
      </footer>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

/**
 * One row of toggles over the list: every session, or only those whose
 * plan is Planning, In progress, Review or Done — each with how many.
 */
function StatusFilter({ sessions, active }: { sessions: SessionSummary[]; active: PlanStatus | null }) {
  const count = (status: PlanStatus) => filterByStatus(sessions, status).length;
  return (
    <div className="status-filter" role="group" aria-label="Show plans by status">
      <button type="button" className={classNames('status-filter-btn', !active && 'is-active')} aria-pressed={!active} onClick={() => store.setStatusFilter(null)}>
        All <span className="status-filter-count">{sessions.length}</span>
      </button>
      {PLAN_STATUSES.map((status) => (
        <button
          key={status}
          type="button"
          className={classNames('status-filter-btn', `is-status-${status}`, active === status && 'is-active')}
          aria-pressed={active === status}
          title={`Show only the plans that are ${PLAN_STATUS[status].label.toLowerCase()}`}
          onClick={() => store.setStatusFilter(active === status ? null : status)}
        >
          {PLAN_STATUS[status].label} <span className="status-filter-count">{count(status)}</span>
        </button>
      ))}
    </div>
  );
}

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
    // A session Claude has stopped on is the reason to look at this rail at
    // all, so it is lifted above everything, pinned or not.
    const key = session.waiting
      ? WAITING_KEY
      : pinnedSet.has(session.sessionId)
        ? PINNED_KEY
        : (session.repoRoot ?? session.cwd);
    let group = groups.get(key);
    if (!group) {
      group =
        key === WAITING_KEY
          ? { key, label: 'Waiting on you', path: '', sessions: [] }
          : key === PINNED_KEY
          ? { key, label: 'Pinned', path: '', sessions: [] }
          : {
              key,
              label: groupLabel(session),
              path: session.repoRoot ?? session.cwd,
              sessions: [],
            };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }

  // Newest session first, within a bucket and between buckets alike. Ordering
  // on creation rather than activity is the point: a rail sorted by activity
  // rearranges itself mid-click, every time any session takes a turn.
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => b.createdAt - a.createdAt);
  }
  const rank = (key: string) => (key === WAITING_KEY ? 0 : key === PINNED_KEY ? 1 : 2);
  return [...groups.values()].sort((a, b) => {
    if (rank(a.key) !== rank(b.key)) return rank(a.key) - rank(b.key);
    return (b.sessions[0]?.createdAt ?? 0) - (a.sessions[0]?.createdAt ?? 0);
  });
}

function groupLabel(session: SessionSummary): string {
  return session.repoName ?? basename(session.cwd) ?? 'Unknown project';
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
  // A collapsed group hiding the session you are looking at is disorienting.
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
  const pinned = useStore((s) => s.pinned.includes(session.sessionId));
  // Which agent a row belongs to is only worth a word once there is more
  // than one kind in the list.
  const mixed = useStore((s) => listedSessions(s.sessions, s.sessionId).some((other) => other.agent !== session.agent));
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const agent = agentInfo(session.agent);
  const facts = summaryFacts(session);
  // The session's own name under the plan's, unless it is only the folder
  // the group header (or, in a lifted group, the foot) already names.
  const stage = session.planTitle && session.planTitle !== session.title && session.title !== groupLabel(session) ? session.title : null;

  return (
    <div
      className={classNames(
        'session-row',
        active && 'is-active',
        confirming && 'is-confirming',
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
        title={[session.title, session.branch && `on ${session.branch}`, session.cwd, 'Double-click to rename'].filter(Boolean).join('\n')}
      >
        <span className="session-name">
          {session.waiting ? (
            <span className="dot is-attention" title={`${agent.name} is waiting on you`} aria-label={`${agent.name} is waiting on you`} />
          ) : (
            session.status === 'active' && (
              <span className="working-dot" title={`${agent.name} is working`} aria-label={`${agent.name} is working`} />
            )
          )}
          <span className="session-title">{session.planTitle ?? session.title}</span>
        </span>
        {session.waiting ? (
          <span className="session-waiting">{session.waiting.text}</span>
        ) : (
          session.current && <span className="session-now">now: {session.current}</span>
        )}
        <span className="session-sub">
          {stage && <span className="session-stage">{stage}</span>}
          {!session.planTitle && <span className="session-stage">no plan yet</span>}
          {mixed && <span className={classNames('session-agent', `is-${agent.kind}`)}>{agent.name}</span>}
          <span className={classNames('session-state', `is-${session.status}`)}>
            {SESSION_STATE_LABEL[session.status] ?? session.status}
          </span>
          {session.branch && <span className="session-branch">{session.branch}</span>}
        </span>
        <span className="session-foot">
          {showRepo && session.repoName && <span className="session-repo">{groupLabel(session)}</span>}
          {session.tasks.total > 0 && (
            <span title={`${session.tasks.done} of ${session.tasks.total} tasks done`}>
              {session.tasks.done}/{session.tasks.total} tasks
            </span>
          )}
          <span>{relativeTime(session.updatedAt)}</span>
          {facts.planStatus === 'planning' && session.unreadByClaude > 0 && (
            <span className="pill is-draft" title={`You changed the plan since ${agent.name} last read it`}>
              unread
            </span>
          )}
          <span className={classNames('pill', 'status-pill', `is-status-${facts.planStatus}`)} title={statusTitle(facts, agent.name)}>
            {PLAN_STATUS[facts.planStatus].label}
          </span>
        </span>
      </button>
      )}

      {session.waiting && session.link && !renaming && (
        <a className="session-answer btn btn-sm btn-primary" href={session.link.app} title={`Open this session in ${agent.app}`}>
          Answer in {agent.name}
        </a>
      )}

      {/* Absent while renaming: the field takes the whole row. */}
      {!renaming && (
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
      )}

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
    // Focused explicitly: the button that opened it has just gone.
    input.current?.focus();
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

/**
 * The rail folded down to one column of initials, so the plan gets the width
 * without losing the way to other sessions — or the signal that one of them
 * is waiting on you.
 */
function CollapsedRail({ sessions, current }: { sessions: SessionSummary[]; current: string | null }) {
  const ordered = [...sessions].sort((a, b) => Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || b.createdAt - a.createdAt);
  return (
    <nav className="session-rail" aria-label="Sessions">
      {ordered.map((s) => {
        const name = s.planTitle ?? s.title;
        return (
          <button
            key={s.sessionId}
            type="button"
            className={classNames('rail-item', s.sessionId === current && 'is-active', s.waiting && 'is-waiting')}
            aria-current={s.sessionId === current ? 'true' : undefined}
            title={`${name}${s.waiting ? ` — waiting on you: ${s.waiting.text}` : s.current ? ` — now: ${s.current}` : ''}`}
            aria-label={`${name}${s.waiting ? ', waiting on you' : ''}`}
            onClick={() => void store.selectSession(s.sessionId)}
          >
            <span aria-hidden="true">{initials(name)}</span>
            {s.waiting && <span className="rail-dot is-attention" aria-hidden="true" />}
            {!s.waiting && s.status === 'active' && <span className="rail-dot is-working" aria-hidden="true" />}
          </button>
        );
      })}
    </nav>
  );
}

const MINOR_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'in', 'on', 'with']);

function initials(name: string): string {
  const all = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !MINOR_WORDS.has(w.toLowerCase()));
  if (words.length === 0) words.push(...all);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}
