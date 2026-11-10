import { descendants, outline } from '../../shared/plan.ts';
import { ancestorsOf, droppedWhole, hasSubtasks, readinessOf } from '../../shared/build.ts';
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

/** The outline's rows by task id: what boxRows numbers and indents by. */
export type Numbered = Map<string, ReturnType<typeof outline>[number]>;

export function numbered(rows: ReturnType<typeof outline>): Numbered {
  return new Map(rows.map((r) => [r.task.id, r]));
}

/** `rows`: this plan's outline, numbered once where many boxes are listed. */
export function boxRows(plan: Plan | null, taskIds: string[] | undefined, rows: Numbered | null = null): BoxRow[] {
  if (!plan || !taskIds?.length) return [];
  rows ??= numbered(outline(plan));
  const linked = new Set(taskIds);
  const seen = new Set<string>();
  const out: BoxRow[] = [];
  for (const id of taskIds) {
    const task = plan.tasks.find((t) => t.id === id);
    // A task linked with one above it is listed under that one, where it sits.
    if (!task || seen.has(id) || ancestorsOf(plan, task).some((a) => linked.has(a.id))) continue;
    const base = rows.get(id)?.depth ?? 0;
    for (const t of [task, ...descendants(plan, task.id)]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const at = rows.get(t.id);
      out.push({ task: t, number: at?.number ?? t.id, depth: (at?.depth ?? base) - base, direct: linked.has(t.id), status: shownStatus(plan, t) });
    }
  }
  return out;
}

/** A task's status as the page shows it: a parent's is its subtasks',
 *  rolled up the way harness_task_next does — and dropped when every one
 *  was, as the briefs say, not done. */
export function shownStatus(plan: Pick<Plan, 'tasks'>, task: Task): TaskStatus {
  if (!hasSubtasks(plan, task.id)) return task.status;
  if (droppedWhole(plan, task.id)) return 'dropped';
  const r = readinessOf(plan, task);
  return r === 'ready' || r === 'waiting' ? 'todo' : r;
}
