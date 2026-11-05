import type { TaskCounts, TaskStatus } from '../../shared/types.ts';
import { classNames } from '../lib/format.ts';

/** Done, in progress and blocked as one stacked bar. */
export function ProgressBar({ counts, compact }: { counts: TaskCounts; compact?: boolean }) {
  const total = Math.max(1, counts.total);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <span
      className={classNames('progress', compact && 'is-compact')}
      role="img"
      aria-label={`${counts.done} of ${counts.total} tasks done${counts.inProgress ? `, ${counts.inProgress} in progress` : ''}${counts.blocked ? `, ${counts.blocked} blocked` : ''}`}
    >
      <span className="progress-seg is-done" style={{ width: pct(counts.done) }} />
      <span className="progress-seg is-in_progress" style={{ width: pct(counts.inProgress) }} />
      <span className="progress-seg is-blocked" style={{ width: pct(counts.blocked) }} />
    </span>
  );
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  dropped: 'Dropped',
};

export const STATUS_GLYPH: Record<TaskStatus, string> = {
  todo: '',
  in_progress: '',
  blocked: '!',
  done: '✓',
  dropped: '–',
};
