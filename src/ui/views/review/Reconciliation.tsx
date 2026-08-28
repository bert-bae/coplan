import { useMemo } from 'react';
import { useSession, useStore } from '../../store.ts';
import { classNames, pluralize } from '../../lib/format.ts';
import type { Task } from '../../../shared/types.ts';

/**
 * Did it build what it said it would?
 *
 * The board records the files edited while each task was in progress, and the
 * diff records what actually changed. Comparing them answers the question you
 * actually have at review time, and flags a task that claims to be done but
 * touched nothing.
 */
export function Reconciliation() {
  const session = useSession();
  const diff = useStore((s) => s.diff);

  const rows = useMemo(() => {
    const changed = new Set((diff?.files ?? []).map((f) => f.path));
    return (session?.tasks ?? [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((task) => ({
        task,
        matched: task.files.filter((f) => changed.has(f)),
        missing: task.files.filter((f) => !changed.has(f)),
      }));
  }, [session?.tasks, diff?.files]);

  if (rows.length === 0) return null;

  const attributed = new Set(rows.flatMap((r) => r.task.files));
  const unattributed = (diff?.files ?? []).filter((f) => !attributed.has(f.path));
  const suspect = rows.filter((r) => r.task.status === 'done' && r.matched.length === 0);

  return (
    <section className="reconcile">
      <header className="reconcile-head">
        <strong>Plan vs. what changed</strong>
        {suspect.length > 0 && (
          <span className="pill is-draft">
            {pluralize(suspect.length, 'task')} marked done with no visible change
          </span>
        )}
      </header>

      <ul className="reconcile-list">
        {rows.map(({ task, matched }) => (
          <li key={task.id} className={classNames('reconcile-row', `is-${task.status}`)}>
            <span className="reconcile-status">{glyph(task)}</span>
            <span className="reconcile-title">{task.title}</span>
            <span className="reconcile-files">
              {matched.length === 0 ? (
                <em className="muted">no files</em>
              ) : (
                matched.map((file) => (
                  <code key={file} title={file}>
                    {file}
                  </code>
                ))
              )}
            </span>
          </li>
        ))}
      </ul>

      {unattributed.length > 0 && (
        <p className="reconcile-extra">
          {pluralize(unattributed.length, 'changed file')} not attributed to any task:{' '}
          {unattributed.slice(0, 6).map((f) => (
            <code key={f.path}>{f.path}</code>
          ))}
          {unattributed.length > 6 && <span className="muted"> +{unattributed.length - 6} more</span>}
        </p>
      )}
    </section>
  );
}

function glyph(task: Task): string {
  return { done: '\u2713', in_progress: '\u25d0', blocked: '\u23f8', todo: '\u25cb' }[task.status] ?? '\u25cb';
}
