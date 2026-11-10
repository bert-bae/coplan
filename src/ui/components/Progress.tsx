import type { Plan, Task, TaskCounts, TaskStatus } from '../../shared/types.ts';
import { hasSubtasks } from '../../shared/build.ts';
import { classNames } from '../lib/format.ts';
import { shownStatus } from '../lib/tasks.ts';

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

/**
 * A task's status as a dot to read, not click. A parent has no status of its
 * own to set — what is built, and what the agent reports, is its subtasks —
 * so its dot is theirs, rolled up (shownStatus), and says so.
 *
 * `status`: as shown, when the caller has it already. `named`: the label
 * says whose it is. `tooltip`: off where a tooltip is already open.
 */
export function TaskStatusDot({
  plan,
  task,
  status,
  named = false,
  tooltip = true,
}: {
  plan: Pick<Plan, 'tasks'>;
  task: Task;
  status?: TaskStatus;
  named?: boolean;
  tooltip?: boolean;
}) {
  const parent = hasSubtasks(plan, task.id);
  const shown = status ?? (parent ? shownStatus(plan, task) : task.status);
  const label = `${named ? `${task.title}: ` : ''}${STATUS_LABEL[shown]}${parent ? ', from its subtasks' : ''}`;
  return (
    <span className={classNames('status-dot is-static', `is-${shown}`)} role="img" title={tooltip ? label : undefined} aria-label={label}>
      <span aria-hidden="true">{STATUS_GLYPH[shown]}</span>
    </span>
  );
}
