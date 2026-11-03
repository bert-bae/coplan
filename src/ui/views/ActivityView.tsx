import { useState } from 'react';
import { store, usePlan } from '../store.ts';
import { AuthorBadge } from '../components/Threads.tsx';
import { EmptyState } from '../components/primitives.tsx';
import { classNames, clockTime, relativeTime } from '../lib/format.ts';
import { targetExists } from '../../shared/plan.ts';
import type { Author, Change } from '../../shared/types.ts';

type Filter = 'all' | Author;

/**
 * The change log: who changed what, newest first, with a line marking how far
 * Claude has read. Everything above that line by "You" is what Claude has not
 * seen yet — which is the whole question when deciding whether to go back to
 * the chat and tell it to read the plan.
 */
export function ActivityView() {
  const plan = usePlan();
  const [filter, setFilter] = useState<Filter>('all');
  if (!plan) return null;

  const changes = [...plan.changes].reverse().filter((c) => filter === 'all' || c.author === filter);
  const markerAt = changes.findIndex((c) => c.seq <= plan.claudeReadSeq);

  return (
    <div className="view-pad">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show changes by">
          {(['all', 'user', 'claude'] as Filter[]).map((f) => (
            <button key={f} type="button" className={classNames('seg', filter === f && 'is-active')} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Everyone' : f === 'user' ? 'You' : 'Claude'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="muted">{plan.claudeReadAt ? `Claude last read the plan ${relativeTime(plan.claudeReadAt)}` : 'Claude has not read the plan back yet'}</span>
      </div>

      {changes.length === 0 ? (
        <EmptyState title="No changes yet" />
      ) : (
        <ol className="activity">
          {changes.map((c, i) => (
            <Row key={c.seq} change={c} marker={i === markerAt && i > 0} exists={targetExists(plan, c.target)} unread={c.seq > plan.claudeReadSeq && c.author === 'user'} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Row({ change, marker, exists, unread }: { change: Change; marker: boolean; exists: boolean; unread: boolean }) {
  const linkable = exists && change.target.kind !== 'plan' && change.kind !== 'deleted';
  return (
    <>
      {marker && (
        <li className="activity-marker" aria-label="Claude has read everything below this line">
          <span>Claude has read everything below</span>
        </li>
      )}
      <li className={classNames('activity-row', `by-${change.author}`, unread && 'is-unread')}>
        <AuthorBadge author={change.author} />
        <span className="activity-text">{change.summary}</span>
        {linkable && (
          <button type="button" className="link" onClick={() => store.focus(change.target.kind, change.target.id)}>
            Show
          </button>
        )}
        <span className="spacer" />
        {unread && <span className="chip is-warning">unread by Claude</span>}
        <time className="muted" dateTime={new Date(change.ts).toISOString()} title={new Date(change.ts).toLocaleString()}>
          {relativeTime(change.ts)} · {clockTime(change.ts)}
        </time>
      </li>
    </>
  );
}
