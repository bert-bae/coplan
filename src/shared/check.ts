/**
 * What the plan leaves open: the checks an auditor runs before a design is
 * confirmed or a task list submitted. Each one is something the reader of
 * the plan cannot see from any one view — a box nothing builds, a task that
 * builds nothing, a node id two diagrams share.
 *
 * Pure, and shared by the daemon (harness_plan_check, the read, the
 * task-list reply) and the browser (the sign-off dialogs), so the agent and
 * the user see the same list.
 */

import { branchPlan, effectiveBranch, hasSubtasks, inheritedDeps, leavesUnder } from './build.ts';
import { planPhase } from './plan.ts';
import type { Plan, Target, Task } from './types.ts';

export const GAP_RULES = [
  'box-unbuilt',
  'task-builds-nothing',
  'box-undescribed',
  'task-undetailed',
  'node-id-shared',
  'branch-two-bases',
  'branch-on-unbranched',
  'comment-unanswered',
] as const;
export type GapRule = (typeof GAP_RULES)[number];

export interface Gap {
  rule: GapRule;
  target: Target;
  message: string;
}

/** Box kinds that stand for something the plan does not build. */
const NOT_BUILT = new Set(['external', 'actor', 'note']);

export function planGaps(plan: Plan): Gap[] {
  const gaps: Gap[] = [];
  const add = (rule: GapRule, target: Target, message: string) => gaps.push({ rule, target, message });
  const leaves = plan.tasks.filter((t) => !hasSubtasks(plan, t.id));
  const tasked = planPhase(plan) !== 'planning';

  // Boxes and tasks that do not meet: the diagram and the task list are
  // the same plan, and each should account for the other.
  const ancestors = (t: Task): string[] => {
    const out: string[] = [];
    for (let p = t.parentId; p; p = plan.tasks.find((x) => x.id === p)?.parentId ?? null) out.push(p);
    return out;
  };
  const built = new Set<string>();
  for (const d of plan.diagrams) {
    for (const n of d.nodes) {
      const ref: Target = { kind: 'node', id: `${d.id}/${n.id}` };
      if (n.kind !== 'note' && !n.description?.trim()) {
        add('box-undescribed', ref, `Box "${n.label}" in "${d.title}" has no description: what it does, owns, and how others talk to it.`);
      }
      for (const id of n.taskIds ?? []) built.add(id);
      if (plan.tasks.length && !NOT_BUILT.has(n.kind) && !n.taskIds?.length) {
        add('box-unbuilt', ref, `No task builds box "${n.label}" in "${d.title}": link the task that does, or say it already exists.`);
      }
    }
  }
  if (plan.diagrams.some((d) => d.nodes.length)) {
    for (const t of leaves) {
      if (built.has(t.id) || ancestors(t).some((a) => built.has(a))) continue;
      add('task-builds-nothing', { kind: 'task', id: t.id }, `Task ${t.id} "${t.title}" builds no box — link it to the parts it changes (builds).`);
    }
  }

  // Once the task list is being made, every task a subagent may be handed
  // has to say what done means.
  if (tasked) {
    for (const t of leaves) {
      const own = t.detail?.trim() || ancestors(t).some((a) => plan.tasks.find((x) => x.id === a)?.detail?.trim());
      if (!own) add('task-undetailed', { kind: 'task', id: t.id }, `Task ${t.id} "${t.title}" has no detail: its objective and how a reviewer knows it is done.`);
    }
  }

  // A node id in two diagrams makes `builds: ["cache"]` ambiguous.
  const seen = new Map<string, string[]>();
  for (const d of plan.diagrams) for (const n of d.nodes) seen.set(n.id, [...(seen.get(n.id) ?? []), d.id]);
  for (const [id, where] of seen) {
    if (where.length > 1) {
      add('node-id-shared', { kind: 'diagram', id: where[0]! }, `Box id "${id}" is in ${where.length} diagrams (${where.join(', ')}): a task's builds must say which, as "${where[0]}/${id}".`);
    }
  }

  // Branch layouts a stack of pull requests cannot follow.
  const { branches } = branchPlan(plan);
  for (const b of branches) {
    if (b.needs.length > 1) {
      add(
        'branch-two-bases',
        { kind: 'plan', id: '' },
        `Branch \`${b.branch}\` needs work from ${b.needs.map((n) => `\`${n}\``).join(' and ')}: a pull request has one base. Put the work on one branch, or make one of those stack on the other.`,
      );
    }
  }
  if (branches.length) {
    for (const t of leaves) {
      const mine = effectiveBranch(plan, t);
      if (!mine) continue;
      // Waiting on a parent is waiting on each of its subtasks.
      const deps = inheritedDeps(plan, t).flatMap((id) => leavesUnder(plan, id));
      for (const dep of new Set(deps)) {
        if (!effectiveBranch(plan, dep)) {
          add(
            'branch-on-unbranched',
            { kind: 'task', id: t.id },
            `Task ${t.id} on \`${mine}\` waits on ${dep.id} "${dep.title}", which has no branch: \`${mine}\` would be cut without that work. Give ${dep.id} a branch, or put both on one.`,
          );
        }
      }
    }
  }

  // The user asked something and nobody answered.
  for (const th of plan.threads) {
    const last = th.replies.at(-1)?.author ?? th.author;
    if (!th.resolved && last === 'user') add('comment-unanswered', th.target, `Comment ${th.id} from the user has no answer yet: "${th.text.slice(0, 80)}${th.text.length > 80 ? '…' : ''}"`);
  }
  return gaps;
}
