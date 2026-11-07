import { awaitingUserReview, currentTask, planPhase, planStatus, statusOfPhase } from '../../shared/plan.ts';
import type { Plan, PlanPhase, PlanStatus, SessionSummary } from '../../shared/types.ts';

/**
 * The four statuses, as the page shows them (#66): one word for each, the
 * same in the header, the session list and the strip under the header.
 * This is the one map; the seven phases are the detail under it.
 */
export const PLAN_STATUS: Record<PlanStatus, { label: string; mark: string }> = {
  planning: { label: 'Planning', mark: '✎' },
  in_progress: { label: 'In progress', mark: '▶' },
  review: { label: 'Review', mark: '⏸' },
  done: { label: 'Done', mark: '✓' },
};

/** What a status is worked out from: a session's summary carries these,
 *  and a plan gives them (`statusFacts`). */
export interface StatusFacts {
  planStatus: PlanStatus;
  phase: PlanPhase;
  /** The task the agent is on. */
  current: string | null;
  /** Tasks a Managed build holds for the user's own review. */
  awaitingReview: number;
}

export function statusFacts(plan: Plan | null): StatusFacts {
  return {
    planStatus: planStatus(plan),
    phase: planPhase(plan),
    current: currentTask(plan)?.title ?? null,
    awaitingReview: awaitingUserReview(plan).length,
  };
}

/** A session's row, as status facts. A summary always carries its status;
 *  one that does not is read from its phase. */
export function summaryFacts(s: SessionSummary): StatusFacts {
  return {
    planStatus: s.planStatus ?? statusOfPhase(s.phase, (s.awaitingReview ?? 0) > 0),
    phase: s.phase,
    current: s.current,
    awaitingReview: s.awaitingReview ?? 0,
  };
}

/** The detail under a status, in a few words: what the phase is, the task
 *  the agent is on, or what waits on the user. Empty while designing. */
export function statusDetail(facts: StatusFacts, agent: string): string {
  if (facts.planStatus === 'review' && facts.awaitingReview) {
    return `${facts.awaitingReview} task${facts.awaitingReview === 1 ? ' waits' : 's wait'} on your review`;
  }
  switch (facts.phase) {
    case 'tasking':
      return 'design confirmed';
    case 'submitted':
      return `waiting for ${agent}`;
    case 'building':
      return facts.current ? `on ${facts.current}` : 'building';
    case 'finalizing':
      return 'final checks and report';
    case 'built':
      return 'built';
    case 'handed-off':
      return 'exported';
    default:
      return '';
  }
}

/** The status and its detail in a sentence, for a tooltip. */
export function statusTitle(facts: StatusFacts, agent: string): string {
  if (facts.planStatus === 'review' && facts.awaitingReview) {
    return `Review: ${statusDetail(facts, agent)} — approve it on the board, or tell ${agent} in chat`;
  }
  switch (facts.phase) {
    case 'planning':
      return 'Planning: the design is open';
    case 'tasking':
      return 'Planning: the design is confirmed, and the task list is being made and shaped';
    case 'submitted':
      return `In progress: submitted, waiting for ${agent} to pick it up`;
    case 'building':
      return `In progress: ${agent} is building it${facts.current ? ` — now ${facts.current}` : ''}`;
    case 'finalizing':
      return `Review: every task is done; ${agent} is running the final checks and writing the report for you`;
    case 'built':
      return 'Done: every task is built, and the report is in';
    default:
      return 'Done: exported, to be built somewhere else';
  }
}

/** "In progress · on Wire up": the status, then its detail. */
export function statusWords(facts: StatusFacts, agent: string): string {
  const detail = statusDetail(facts, agent);
  return `${PLAN_STATUS[facts.planStatus].label}${detail ? ` · ${detail}` : ''}`;
}
