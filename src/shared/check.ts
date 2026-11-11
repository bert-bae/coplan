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

import { SESSION_BRANCH, ancestorsOf, branchPlan, hasSubtasks } from './build.ts';
import { planPhase, threadsForRevision } from './plan.ts';
import type { DiagramNode, Plan, Target, Task } from './types.ts';

export const GAP_RULES = [
  'box-unbuilt',
  'task-builds-nothing',
  'box-undescribed',
  'task-undetailed',
  'node-id-shared',
  'branch-two-bases',
  'comment-unanswered',
] as const;
export type GapRule = (typeof GAP_RULES)[number];

/** How a rule counts, set per repository (`planCheck` in .coplan/config.json):
 *  an `error` holds Confirm design and Submit, a `warn` is listed, an `off`
 *  is not shown. Every rule is a `warn` unless the repository says. */
export const GAP_SEVERITIES = ['error', 'warn', 'off'] as const;
export type GapSeverity = (typeof GAP_SEVERITIES)[number];
export type GapSeverities = Partial<Record<GapRule, GapSeverity>>;

export interface Gap {
  rule: GapRule;
  target: Target;
  message: string;
  severity: Exclude<GapSeverity, 'off'>;
}

/** The gaps that hold the sign-off: Confirm design, and Submit. */
export function blockingGaps(plan: Plan, severities: GapSeverities = {}): Gap[] {
  return planGaps(plan, severities).filter((g) => g.severity === 'error');
}

/** Box kinds that stand for something the plan does not build. */
const NOT_BUILT = new Set(['external', 'actor', 'note']);

/**
 * A box no task builds (`box-unbuilt`): a part the plan builds, with no task
 * linked, once the plan has tasks at all. The canvas marks the same boxes
 * the check lists, from what is drawn.
 */
export function boxUnbuilt(plan: Pick<Plan, 'tasks'>, node: Pick<DiagramNode, 'kind' | 'taskIds'>): boolean {
  return plan.tasks.length > 0 && !NOT_BUILT.has(node.kind) && !node.taskIds?.length;
}

export function planGaps(plan: Plan, severities: GapSeverities = {}): Gap[] {
  const gaps: Omit<Gap, 'severity'>[] = [];
  const add = (rule: GapRule, target: Target, message: string) => gaps.push({ rule, target, message });
  const leaves = plan.tasks.filter((t) => !hasSubtasks(plan, t.id));
  const tasked = planPhase(plan) !== 'planning';

  // Boxes and tasks that do not meet: the diagram and the task list are
  // the same plan, and each should account for the other.
  // ancestorsOf stops at a parent loop, which a plan from disk may hold.
  const ancestors = (t: Task): string[] => ancestorsOf(plan, t).map((a) => a.id);
  const built = new Set<string>();
  for (const d of plan.diagrams) {
    for (const n of d.nodes) {
      const ref: Target = { kind: 'node', id: `${d.id}/${n.id}` };
      if (n.kind !== 'note' && !n.description?.trim()) {
        add('box-undescribed', ref, `Box "${n.label}" in "${d.title}" has no description: what it does, owns, and how others talk to it.`);
      }
      for (const id of n.taskIds ?? []) built.add(id);
      if (boxUnbuilt(plan, n)) {
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

  // A branch layout a stack of pull requests cannot follow. Refused when a
  // task list is made; a plan from before that was enforced can still hold
  // one. (A branch built on the unbranched tasks' work stacks on the
  // session's branch, which a stack can follow.)
  for (const b of branchPlan(plan).branches) {
    if (b.needs.length > 1) {
      const named = (n: string) => (n === SESSION_BRANCH ? 'the unbranched tasks' : `\`${n}\``);
      add(
        'branch-two-bases',
        { kind: 'plan', id: '' },
        `Branch \`${b.branch}\` needs work from ${b.needs.map(named).join(' and ')}: a pull request has one base. Put the work on one branch, or make one of those stack on the other.`,
      );
    }
  }

  // The user asked something and nobody answered: what Request revisions
  // would carry to the agent. Quoted is what the user said last, which in a
  // proposal's thread is not what opened it.
  for (const th of threadsForRevision(plan)) {
    const said = th.replies.at(-1)?.text ?? th.text;
    add('comment-unanswered', th.target, `Comment ${th.id} from the user has no answer yet: "${said.slice(0, 80)}${said.length > 80 ? '…' : ''}"`);
  }
  // What holds the sign-off first; a rule turned off is not shown at all.
  return gaps
    .map((g) => ({ ...g, severity: severities[g.rule] ?? 'warn' }))
    .filter((g): g is Gap => g.severity !== 'off')
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
