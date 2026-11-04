/**
 * The build, as a graph: which tasks wait on which, what can start now, what
 * can run side by side, which branch each piece of work lands on and how
 * those branches stack — and the settings the user chose for running it.
 *
 * Everything here is pure over the task list, so the daemon, the browser
 * and the tests all derive the same answers from the same plan. Nothing is
 * stored that can be worked out: a task is "ready" because everything it
 * waits on is done, not because someone said so.
 *
 * Two rules give dependencies their meaning:
 *
 * - **A parent is its subtasks.** Depending on a parent means waiting for
 *   every subtask under it; a parent is done when all of them are.
 * - **Subtasks inherit.** A task waits on what it depends on and on what
 *   each of its ancestors depends on, so "the API work waits for the cache"
 *   is said once, on the parent.
 */
import type { BuildSettings, Plan, ReviewMode, Task } from './types.ts';
import { REVIEW_MODES } from './types.ts';

type Tasks = Pick<Plan, 'tasks'>;

/** How a build runs when neither the repository nor the user said. */
export const DEFAULT_BUILD_SETTINGS: BuildSettings = { review: 'subagent', parallel: 2, maxRounds: 3 };
export const MAX_PARALLEL = 8;
export const MAX_ROUNDS = 10;

/* ------------------------------------------------------------------ *
 * The tree
 * ------------------------------------------------------------------ */

function childrenOf(plan: Tasks, id: string | null): Task[] {
  return plan.tasks.filter((t) => t.parentId === id).sort((a, b) => a.order - b.order);
}

function byId(plan: Tasks, id: string): Task | undefined {
  return plan.tasks.find((t) => t.id === id);
}

export function hasSubtasks(plan: Tasks, id: string): boolean {
  return plan.tasks.some((t) => t.parentId === id);
}

/** Nearest first. */
export function ancestorsOf(plan: Tasks, task: Task): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>([task.id]);
  let cursor = task.parentId ? byId(plan, task.parentId) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    out.push(cursor);
    seen.add(cursor.id);
    cursor = cursor.parentId ? byId(plan, cursor.parentId) : undefined;
  }
  return out;
}

/** Every leaf in outline order — the tasks that are actually worked on. */
export function leafTasks(plan: Tasks): Task[] {
  const out: Task[] = [];
  const visit = (parentId: string | null, depth: number) => {
    if (depth > 64) return;
    for (const t of childrenOf(plan, parentId)) {
      if (hasSubtasks(plan, t.id)) visit(t.id, depth + 1);
      else out.push(t);
    }
  };
  visit(null, 0);
  return out;
}

/** The leaves a task stands for: itself, or every leaf under it. */
export function leavesUnder(plan: Tasks, id: string): Task[] {
  const task = byId(plan, id);
  if (!task) return [];
  if (!hasSubtasks(plan, id)) return [task];
  const out: Task[] = [];
  const visit = (pid: string, depth: number) => {
    if (depth > 64) return;
    for (const t of childrenOf(plan, pid)) {
      if (hasSubtasks(plan, t.id)) visit(t.id, depth + 1);
      else out.push(t);
    }
  };
  visit(id, 0);
  return out;
}

/** Done means every leaf under it is done. A task that no longer exists
 *  holds nothing up. */
export function isComplete(plan: Tasks, id: string): boolean {
  if (!byId(plan, id)) return true;
  return leavesUnder(plan, id).every((t) => t.status === 'done');
}

/* ------------------------------------------------------------------ *
 * Dependencies and readiness
 * ------------------------------------------------------------------ */

/** What a task waits on: its own dependencies and every ancestor's, in that
 *  order, each once. */
export function inheritedDeps(plan: Tasks, task: Task): string[] {
  const out: string[] = [];
  for (const t of [task, ...ancestorsOf(plan, task)]) {
    for (const id of t.dependsOn ?? []) if (!out.includes(id) && byId(plan, id)) out.push(id);
  }
  return out;
}

/** The dependencies still holding a task up. */
export function waitingOn(plan: Tasks, task: Task): Task[] {
  return inheritedDeps(plan, task)
    .filter((id) => !isComplete(plan, id))
    .map((id) => byId(plan, id)!)
    .filter(Boolean);
}

/** Where a task stands for the build. `ready` and `waiting` split "to do"
 *  into what can be started now and what cannot yet. */
export type Readiness = 'done' | 'in_progress' | 'blocked' | 'ready' | 'waiting';

export function readinessOf(plan: Tasks, task: Task): Readiness {
  if (hasSubtasks(plan, task.id)) {
    const leaves = leavesUnder(plan, task.id);
    if (leaves.every((t) => t.status === 'done')) return 'done';
    if (leaves.some((t) => t.status === 'in_progress')) return 'in_progress';
    if (leaves.some((t) => t.status === 'blocked')) return 'blocked';
    return leaves.some((t) => readinessOf(plan, t) === 'ready') ? 'ready' : 'waiting';
  }
  if (task.status === 'done') return 'done';
  if (task.status === 'in_progress') return 'in_progress';
  if (task.status === 'blocked') return 'blocked';
  return waitingOn(plan, task).length ? 'waiting' : 'ready';
}

/** Leaf tasks that can be started now, in outline order. */
export function readyTasks(plan: Tasks): Task[] {
  return leafTasks(plan).filter((t) => readinessOf(plan, t) === 'ready');
}

/** Whether any task says what it waits on. */
export function hasDependencies(plan: Tasks): boolean {
  return plan.tasks.some((t) => t.dependsOn?.length);
}

/**
 * Each leaf and the leaves it waits on. Depending on a parent is waiting on
 * every leaf under it, and a subtask waits on whatever its ancestors do.
 */
function leafGraph(plan: Tasks): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const leaf of leafTasks(plan)) {
    const on = new Set<string>();
    for (const id of inheritedDeps(plan, leaf)) for (const l of leavesUnder(plan, id)) on.add(l.id);
    graph.set(leaf.id, on);
  }
  return graph;
}

/**
 * Why the dependencies cannot be built, or null when they can: one that
 * names no task, one on the task itself or on its own parent or subtask, or
 * a loop — every task in it waiting on another, so none can ever start.
 */
export function dependencyProblem(plan: Tasks): string | null {
  const title = (id: string) => `"${byId(plan, id)?.title ?? id}"`;
  for (const t of plan.tasks) {
    for (const id of t.dependsOn ?? []) {
      if (id === t.id) return `${title(t.id)} cannot depend on itself.`;
      const dep = byId(plan, id);
      if (!dep) return `${title(t.id)} depends on "${id}", which is not a task in the plan.`;
      if (ancestorsOf(plan, t).some((a) => a.id === id)) {
        return `${title(t.id)} cannot depend on ${title(id)}: it is part of it. A task waits for subtasks by being their parent.`;
      }
      if (ancestorsOf(plan, dep).some((a) => a.id === t.id)) {
        return `${title(t.id)} cannot depend on ${title(id)}, one of its own subtasks: its other subtasks can say so instead.`;
      }
    }
  }
  const cycle = findCycle(leafGraph(plan));
  if (cycle) return `These tasks wait on each other, so none of them could ever start: ${cycle.map(title).join(' → ')}.`;
  return null;
}

function findCycle(graph: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  let found: string[] | null = null;
  const visit = (v: string): void => {
    if (found) return;
    state.set(v, 'open');
    stack.push(v);
    for (const w of graph.get(v) ?? []) {
      if (found) return;
      if (state.get(w) === 'open') {
        found = [...stack.slice(stack.indexOf(w)), w];
        return;
      }
      if (!state.has(w)) visit(w);
    }
    stack.pop();
    state.set(v, 'done');
  };
  for (const v of graph.keys()) if (!state.has(v) && !found) visit(v);
  return found;
}

/**
 * The leaves in build steps: everything in one step depends only on earlier
 * steps, so the tasks within a step can be built side by side. Done tasks
 * keep their place, so the steps read the same from start to finish.
 */
export function buildSteps(plan: Tasks): Task[][] {
  const graph = leafGraph(plan);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // a loop: dependencyProblem reports it
    visiting.add(id);
    let d = 0;
    for (const on of graph.get(id) ?? []) if (on !== id) d = Math.max(d, depthOf(on) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const steps: Task[][] = [];
  for (const leaf of leafTasks(plan)) {
    const d = depthOf(leaf.id);
    (steps[d] ??= []).push(leaf);
  }
  return steps.filter((s) => s?.length);
}

/** Files two tasks both expect to touch: built at once in one working tree,
 *  they would trip over each other. */
export function sharedFiles(a: Task, b: Task): string[] {
  const theirs = new Set(b.files ?? []);
  return (a.files ?? []).filter((f) => theirs.has(f));
}

/** Leaves that come after a task: those waiting on it, directly or through
 *  a parent. */
export function dependents(plan: Tasks, task: Task): Task[] {
  const mine = new Set(leavesUnder(plan, task.id).map((t) => t.id));
  return leafTasks(plan).filter((leaf) => !mine.has(leaf.id) && inheritedDeps(plan, leaf).some((id) => leavesUnder(plan, id).some((l) => mine.has(l.id))));
}

/* ------------------------------------------------------------------ *
 * Branches
 * ------------------------------------------------------------------ */

/** The branch a task's work lands on: its own, or the nearest ancestor's. */
export function effectiveBranch(plan: Tasks, task: Task): string | null {
  for (const t of [task, ...ancestorsOf(plan, task)]) if (t.branch) return t.branch;
  return null;
}

export interface BranchPlan {
  branch: string;
  /** The branch it is cut from: another branch of this plan when it stacks
   *  on one, else null for the repository's base branch. */
  base: string | null;
  /** Every other branch of the plan it needs work from. More than one means
   *  it cannot simply stack: merge those first. */
  needs: string[];
  /** Its leaf tasks, in build order. */
  tasks: Task[];
}

/**
 * The branches the plan lands on and how they stack: a branch whose tasks
 * wait on work in another branch is cut from that branch, so its pull
 * request shows only its own change. Ordered so every branch comes after
 * the ones it stacks on. Empty when no task names a branch: one change, on
 * whatever branch the session is on.
 */
export function branchPlan(plan: Tasks): { branches: BranchPlan[]; unbranched: Task[] } {
  const order = buildSteps(plan).flat();
  const of = new Map(order.map((t) => [t.id, effectiveBranch(plan, t)]));
  const unbranched = order.filter((t) => !of.get(t.id));
  if (unbranched.length === order.length) return { branches: [], unbranched: [] };

  const byBranch = new Map<string, BranchPlan>();
  for (const t of order) {
    const branch = of.get(t.id);
    if (!branch) continue;
    let entry = byBranch.get(branch);
    if (!entry) byBranch.set(branch, (entry = { branch, base: null, needs: [], tasks: [] }));
    entry.tasks.push(t);
    for (const id of inheritedDeps(plan, t)) {
      for (const leaf of leavesUnder(plan, id)) {
        const other = of.get(leaf.id);
        if (other && other !== branch && !entry.needs.includes(other)) entry.needs.push(other);
      }
    }
  }
  const branches = [...byBranch.values()];
  for (const b of branches) b.base = b.needs.length === 1 ? b.needs[0]! : null;

  // Stack order: a branch after the ones it needs. Ties keep build order.
  const placed: BranchPlan[] = [];
  const visiting = new Set<string>();
  const place = (b: BranchPlan) => {
    if (placed.includes(b) || visiting.has(b.branch)) return;
    visiting.add(b.branch);
    for (const n of b.needs) {
      const dep = byBranch.get(n);
      if (dep) place(dep);
    }
    visiting.delete(b.branch);
    placed.push(b);
  };
  for (const b of branches) place(b);
  return { branches: placed, unbranched };
}

/* ------------------------------------------------------------------ *
 * Review
 * ------------------------------------------------------------------ */

export function validReview(value: unknown): ReviewMode | undefined {
  return (REVIEW_MODES as readonly string[]).includes(value as string) ? (value as ReviewMode) : undefined;
}

/** How a task is reviewed: its own setting, the nearest ancestor's, or the
 *  build's default. */
export function effectiveReview(plan: Tasks, task: Task, fallback: ReviewMode): ReviewMode {
  for (const t of [task, ...ancestorsOf(plan, task)]) if (t.review) return t.review;
  return fallback;
}

/** Settings as sent by a page or read from a config file, made whole. */
export function cleanSettings(raw: unknown, fallback: BuildSettings = DEFAULT_BUILD_SETTINGS): BuildSettings {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
  return {
    review: validReview(rec['review']) ?? fallback.review,
    parallel: int(rec['parallel'], 1, MAX_PARALLEL, fallback.parallel),
    maxRounds: int(rec['maxRounds'], 1, MAX_ROUNDS, fallback.maxRounds),
  };
}

export const REVIEW_WORDS: Record<ReviewMode, string> = {
  subagent: 'an independent reviewer (a fresh subagent)',
  self: 'self-review',
  user: 'the user, before it is marked done',
  skip: 'checks only, no review',
};
