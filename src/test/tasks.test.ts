import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxRows, numbered, shownStatus } from '../ui/lib/tasks.ts';
import { outline, publishPlan } from '../shared/plan.ts';
import type { Task, TaskStatus } from '../shared/types.ts';

/** A task's status as the page shows it: a parent's is its subtasks'. */

const task = (id: string, status: TaskStatus, parentId: string | null = null, dependsOn?: string[]): Task =>
  ({ id, title: id, status, parentId, order: 0, ...(dependsOn ? { dependsOn } : {}) }) as Task;
/** p over subtasks of these statuses, with a further subtask under the first (two levels). */
const parent = (...statuses: TaskStatus[]) => {
  const tasks = [task('p', 'todo'), ...statuses.map((s, i) => task(`c${i}`, s, i === 0 ? 'mid' : 'p')), task('mid', 'todo', 'p')];
  return { tasks, shown: shownStatus({ tasks }, tasks[0]!) };
};

test("a parent shows what its subtasks add up to, whatever its own status says", () => {
  assert.equal(parent('dropped', 'dropped').shown, 'dropped', 'all dropped: dropped, not done');
  assert.equal(parent('done', 'dropped').shown, 'done', 'all settled, some built: done');
  assert.equal(parent('done', 'in_progress', 'blocked').shown, 'in_progress', 'one under way');
  assert.equal(parent('done', 'blocked', 'todo').shown, 'blocked', 'one blocked, none under way');
  assert.equal(parent('done', 'todo').shown, 'todo');
});

test('a subtask waiting on another is to do, as a ready one is', () => {
  const tasks = [task('p', 'done'), task('a', 'todo', 'p'), task('b', 'todo', 'p', ['a'])];
  assert.equal(shownStatus({ tasks }, tasks[0]!), 'todo');
});

test('a task with no subtasks shows its own status', () => {
  for (const s of ['todo', 'in_progress', 'blocked', 'done', 'dropped'] as const) {
    const tasks = [task('t', s)];
    assert.equal(shownStatus({ tasks }, tasks[0]!), s);
  }
});

test("a box's rows are the same whether the outline is numbered for it or once for many", () => {
  const plan = publishPlan(null, {
    title: 'x',
    tasks: [{ id: 't1', title: 'API', subtasks: [{ id: 't2', title: 'Routes', subtasks: [{ id: 't3', title: 'Auth' }] }] }, { id: 't4', title: 'Docs' }],
  }).plan;
  const rows = numbered(outline(plan));
  for (const ids of [['t1'], ['t2'], ['t4', 't1']]) {
    const each = boxRows(plan, ids);
    assert.deepEqual(boxRows(plan, ids, rows), each, ids.join());
    assert.ok(each.length > 0);
  }
  assert.deepEqual(boxRows(plan, ['t2']).map((r) => [r.number, r.depth]), [['1.1', 0], ['1.1.1', 1]], 'numbered as the outline, indented from the linked task');
});

test("a box linking a task and its subtask lists the subtask under it, linked in its own right", () => {
  const plan = publishPlan(null, {
    title: 'x',
    tasks: [{ id: 't1', title: 'API', subtasks: [{ id: 't2', title: 'Routes', subtasks: [{ id: 't3', title: 'Auth' }] }] }, { id: 't4', title: 'Docs' }],
  }).plan;
  // Each row: the task, its indent, and whether the box links it itself (it can be unlinked).
  const shape = (ids: string[]) => boxRows(plan, ids).map((r) => [r.task.id, r.depth, r.direct]);
  const both = [['t1', 0, true], ['t2', 1, true], ['t3', 2, false]];
  assert.deepEqual(shape(['t1', 't2']), both);
  assert.deepEqual(shape(['t2', 't1']), both, 'whichever was linked first: never above its parent');
  assert.deepEqual(shape(['t3', 't4', 't1']), [['t4', 0, true], ['t1', 0, true], ['t2', 1, false], ['t3', 2, true]], 'a subtask further down');
});
