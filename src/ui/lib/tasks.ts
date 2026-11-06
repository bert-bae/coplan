import { descendants, outline } from '../../shared/plan.ts';
import { hasSubtasks, readinessOf } from '../../shared/build.ts';
import type { Plan, Task, TaskStatus } from '../../shared/types.ts';

/**
 * The tasks that build a box, as a box's list shows them — on the canvas and
 * in the Tasks view's "By box": each task linked to the box, followed by its
 * subtasks, which build the box through it. Numbered as the outline numbers
 * them, and indented from the linked task.
 */
export interface BoxRow {
  task: Task;
  number: string;
  depth: number;
  /** Linked to the box itself, rather than through its parent. */
  direct: boolean;
  status: TaskStatus;
}

export function boxRows(plan: Plan | null, taskIds: string[] | undefined): BoxRow[] {
  if (!plan || !taskIds?.length) return [];
  const rows = new Map(outline(plan).map((r) => [r.task.id, r]));
  const seen = new Set<string>();
  const out: BoxRow[] = [];
  for (const id of taskIds) {
    const task = plan.tasks.find((t) => t.id === id);
    if (!task || seen.has(id)) continue;
    const base = rows.get(id)?.depth ?? 0;
    for (const t of [task, ...descendants(plan, task.id)]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const at = rows.get(t.id);
      out.push({ task: t, number: at?.number ?? t.id, depth: (at?.depth ?? base) - base, direct: t.id === id, status: shownStatus(plan, t) });
    }
  }
  return out;
}

/** A task's status as the page shows it: a parent's is its subtasks', rolled
 *  up the way harness_task_next and the briefs do. */
export function shownStatus(plan: Pick<Plan, 'tasks'>, task: Task): TaskStatus {
  if (!hasSubtasks(plan, task.id)) return task.status;
  const r = readinessOf(plan, task);
  return r === 'ready' || r === 'waiting' ? 'todo' : r;
}
