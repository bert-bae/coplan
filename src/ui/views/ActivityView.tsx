import { useEffect, useRef, useState } from 'react';
import { useSession } from '../store.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Panel, EmptyState } from '../components/primitives.tsx';
import { classNames, clockTime, pluralize, relativeTime } from '../lib/format.ts';
import type { TimelineEvent } from '../../shared/types.ts';

const ICON: Record<string, string> = {
  assistant: '●', thinking: '◦', tool: '›', stage: '▸', note: '·', user: '»',
  feedback: '✎', notification: '!', gate: '⏸', check: '✓', ship: '⇧', error: '✗',
};

/** Progress and the session feed together: what has been done, and what is
 *  happening now. They were separate tabs and were always read together. */
export function ActivityView() {
  const session = useSession();
  const [showThinking, setShowThinking] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const events = (session?.timeline ?? []).filter((e) => showThinking || e.kind !== 'thinking');

  useEffect(() => {
    if (pinned.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [events.length]);

  if (!session) return null;

  const done = session.todos.filter((t) => t.status === 'completed').length;
  const percent = session.todos.length ? Math.round((done / session.todos.length) * 100) : 0;

  return (
    <div className="activity">
      <div className="activity-main">
        {/* The question card is rendered above the tab strip, by App, so it
            stays reachable from every view. */}
        <div className="feed-head">
          <strong>Activity</strong>
          <label className="toggle">
            <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} />
            show reasoning
          </label>
        </div>
        <div
          className="feed"
          ref={feed}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {events.length === 0 ? (
            <EmptyState title="Nothing yet" hint="Claude's output appears here as it works." />
          ) : (
            events.map((event) => <Event key={event.id} event={event} />)
          )}
        </div>
      </div>

      <aside className="activity-side">
        <Panel title="Progress">
          {session.todos.length === 0 ? (
            <p className="muted">No task list yet.</p>
          ) : (
            <>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <p className="progress-label">{done} of {session.todos.length} tasks complete</p>
              <ul className="todo-list">
                {session.todos.map((todo, i) => (
                  <li key={i} className={classNames('todo', `is-${todo.status}`)}>
                    <span className="todo-mark">
                      {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'}
                    </span>
                    <span>{todo.content}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel title={`Files touched · ${session.files.length}`}>
          {session.files.length === 0 ? (
            <p className="muted">Nothing changed yet.</p>
          ) : (
            <ul className="touch-list">
              {[...session.files]
                .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
                .map((file) => (
                  <li key={file.path}>
                    <code title={file.path}>{file.path}</code>
                    <span className="muted">{pluralize(file.edits, 'edit')} · {relativeTime(file.lastTouchedAt)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Commands · ${session.commands.length}`}>
          {session.commands.length === 0 ? (
            <p className="muted">No shell commands yet.</p>
          ) : (
            <ul className="cmd-list">
              {[...session.commands].slice(-25).reverse().map((run) => (
                <li key={run.id} className={run.ok ? 'is-ok' : 'is-failed'}>
                  <code>{run.command}</code>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </aside>
    </div>
  );
}

/**
 * Kinds whose text is written for a human and may carry markdown or the
 * XML-ish blocks Claude Code injects. Everything else — tool payloads, check
 * output, stack traces — is machine text, where preserving the exact bytes
 * matters more than formatting them.
 */
const PROSE_KINDS = new Set<TimelineEvent['kind']>([
  'assistant',
  'user',
  'feedback',
  'thinking',
  'note',
  'notification',
  'gate',
  'ship',
]);

function Event({ event }: { event: TimelineEvent }) {
  const prose = PROSE_KINDS.has(event.kind);
  return (
    <article className={classNames('event', `is-${event.kind}`)}>
      <span className="event-icon" title={event.kind}>{ICON[event.kind] ?? '·'}</span>
      <div className="event-body">
        <div className="event-meta">
          {event.label && <span className="event-label">{event.label}</span>}
          <time>{clockTime(event.ts)}</time>
        </div>
        {prose ? <Markdown source={event.text} /> : <pre className="event-text">{event.text}</pre>}
      </div>
    </article>
  );
}
