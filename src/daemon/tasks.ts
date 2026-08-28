import { randomUUID } from 'node:crypto';
import type { SessionStore } from './store.ts';
import { changedBetween, workingTreeFingerprints } from './git.ts';
import type { PlanStep, Task, TaskDecision, TaskNote, TaskNoteKind, TaskStatus } from '../shared/types.ts';

/**
 * The task board.
 *
 * Two properties make it worth having rather than duplicating `TodoWrite`:
 *
 *  - Files are attributed automatically. Anything edited while a task is in
 *    progress is recorded against it by the hook layer, so the board shows
 *    what actually changed per task without the model reporting it.
 *  - Blocking is first class. A task that hits an unknown moves to `blocked`
 *    and opens a question gate; when the user answers, the answer is written
 *    back onto the task as a decision. The reasoning survives the session.
 */

export function createTasks(
  store: SessionStore,
  sessionId: string,
  specs: { title: string; detail?: string; planStepId?: string }[],
  opts: { replace?: boolean } = {},
): Task[] {
  const now = Date.now();
  let created: Task[] = [];

  store.mutate(sessionId, (s) => {
    const existing = opts.replace ? [] : s.tasks;
    const base = existing.length;
    created = specs
      .filter((spec) => spec.title.trim())
      .map((spec, i) => ({
        id: randomUUID(),
        title: spec.title.trim(),
        ...(spec.detail ? { detail: spec.detail } : {}),
        ...(spec.planStepId ? { planStepId: spec.planStepId } : {}),
        status: 'todo' as TaskStatus,
        order: base + i,
        createdAt: now,
        updatedAt: now,
        notes: [],
        files: [],
        decisions: [],
      }));
    s.tasks = [...existing, ...created];
  });

  const session = store.get(sessionId);
  if (session) store.emitEvent({ type: 'tasks', sessionId, tasks: session.tasks });
  if (created.length) {
    store.addTimeline(sessionId, 'stage', `Task board created with ${created.length} task(s)`, {
      label: 'board',
    });
  }
  return created;
}

/** Seed the board from an approved plan, so the user never has to ask twice. */
export function tasksFromPlan(store: SessionStore, sessionId: string, steps: PlanStep[]): Task[] {
  const session = store.get(sessionId);
  if (!session) return [];
  const live = steps.filter((s) => s.status !== 'dropped' && s.title.trim());
  // Never clobber a board that already has progress on it.
  const started = session.tasks.some((t) => t.status !== 'todo');
  if (started) return session.tasks;

  return createTasks(
    store,
    sessionId,
    live.map((step) => ({
      title: step.title,
      ...(step.detail ? { detail: step.detail } : {}),
      planStepId: step.id,
    })),
    { replace: true },
  );
}

export interface TaskUpdate {
  status?: TaskStatus;
  title?: string;
  detail?: string;
  order?: number;
  blockedBy?: string | null;
  blockedReason?: string | null;
}

/**
 * Snapshot the working tree against the task that is starting, and attribute
 * anything that changed to the task that is stopping.
 *
 * Called on every task transition and at each turn boundary, so a card's file
 * list stays true whether the edit came from a tool call or the shell.
 */
export async function reconcileFiles(store: SessionStore, sessionId: string): Promise<void> {
  const session = store.get(sessionId);
  if (!session) return;
  const cwd = session.repoRoot ?? session.cwd;

  let after: Record<string, string>;
  try {
    after = await workingTreeFingerprints(cwd);
  } catch {
    return;
  }

  const active = session.tasks.find((t) => t.status === 'in_progress');
  const baseline = baselines.get(sessionId);

  if (baseline && baseline.taskId) {
    const changed = changedBetween(baseline.fingerprints, after);
    if (changed.length) {
      store.mutate(sessionId, (s) => {
        const task = s.tasks.find((t) => t.id === baseline.taskId);
        if (!task) return;
        for (const file of changed) {
          if (!task.files.includes(file)) task.files.push(file);
        }
        task.updatedAt = Date.now();
      });
      const updated = store.get(sessionId);
      if (updated) store.emitEvent({ type: 'tasks', sessionId, tasks: updated.tasks });
    }
  }

  // Re-baseline against whatever is in progress now.
  baselines.set(sessionId, { taskId: active?.id ?? null, fingerprints: after });
}

/** One baseline per session: the tree as it stood when the current task began. */
const baselines = new Map<string, { taskId: string | null; fingerprints: Record<string, string> }>();

export function clearBaseline(sessionId: string): void {
  baselines.delete(sessionId);
}

export function updateTask(
  store: SessionStore,
  sessionId: string,
  taskId: string,
  patch: TaskUpdate,
): Task | undefined {
  let updated: Task | undefined;
  const now = Date.now();

  store.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (patch.status && patch.status !== task.status) {
      // Only one task in progress at a time: the board is a claim about what
      // the agent is doing right now, and file attribution depends on it.
      if (patch.status === 'in_progress') {
        for (const other of s.tasks) {
          if (other.id !== taskId && other.status === 'in_progress') {
            other.status = 'todo';
            other.updatedAt = now;
          }
        }
        task.startedAt ??= now;
        // Claiming a task IS the statement that implementation has begun.
        // Relying on a separate harness_stage call meant the stage silently
        // stayed on "plan review" while work was happening.
        if (s.stage === 'plan_review' || s.stage === 'planning' || s.stage === 'idle') {
          s.stage = 'implementing';
        }
      }
      if (patch.status === 'done') task.completedAt = now;
      if (patch.status !== 'blocked') {
        delete task.blockedBy;
        delete task.blockedReason;
      }
      task.status = patch.status;
    }

    if (patch.title !== undefined) task.title = patch.title;
    if (patch.detail !== undefined) task.detail = patch.detail;
    if (patch.order !== undefined) task.order = patch.order;
    if (patch.blockedBy !== undefined) {
      if (patch.blockedBy === null) delete task.blockedBy;
      else task.blockedBy = patch.blockedBy;
    }
    if (patch.blockedReason !== undefined) {
      if (patch.blockedReason === null) delete task.blockedReason;
      else task.blockedReason = patch.blockedReason;
    }

    task.updatedAt = now;
    updated = task;
  });

  const session = store.get(sessionId);
  if (session) store.emitEvent({ type: 'tasks', sessionId, tasks: session.tasks });
  return updated;
}

export function addNote(
  store: SessionStore,
  sessionId: string,
  taskId: string,
  kind: TaskNoteKind,
  text: string,
): TaskNote | undefined {
  const note: TaskNote = { id: randomUUID(), ts: Date.now(), kind, text };
  let ok = false;

  store.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.notes.push(note);
    task.updatedAt = note.ts;
    ok = true;
  });

  if (!ok) return undefined;
  const session = store.get(sessionId);
  if (session) store.emitEvent({ type: 'tasks', sessionId, tasks: session.tasks });
  return note;
}

/** Record the answer to a blocking question against the task that asked it. */
export function recordDecision(
  store: SessionStore,
  sessionId: string,
  gateId: string,
  answer: string,
): TaskDecision | undefined {
  let decision: TaskDecision | undefined;

  store.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.blockedBy === gateId);
    if (!task) return;
    decision = {
      id: randomUUID(),
      ts: Date.now(),
      question: task.blockedReason ?? 'Question',
      answer,
    };
    task.decisions.push(decision);
    task.notes.push({
      id: randomUUID(),
      ts: decision.ts,
      kind: 'decision',
      text: `${decision.question} → ${answer}`,
    });
    task.status = 'in_progress';
    delete task.blockedBy;
    delete task.blockedReason;
    task.updatedAt = decision.ts;
  });

  const session = store.get(sessionId);
  if (session && decision) store.emitEvent({ type: 'tasks', sessionId, tasks: session.tasks });
  return decision;
}

/**
 * Attribute an edited file to whatever task is in progress.
 *
 * Called from the PostToolUse hook, so the board's record of what changed is
 * observed rather than reported.
 */
export function attributeFile(store: SessionStore, sessionId: string, relPath: string): void {
  const session = store.get(sessionId);
  if (!session) return;
  const active = session.tasks.find((t) => t.status === 'in_progress');
  if (!active || active.files.includes(relPath)) return;

  store.mutate(sessionId, (s) => {
    const task = s.tasks.find((t) => t.id === active.id);
    if (task && !task.files.includes(relPath)) {
      task.files.push(relPath);
      task.updatedAt = Date.now();
    }
  });
  const updated = store.get(sessionId);
  if (updated) store.emitEvent({ type: 'tasks', sessionId, tasks: updated.tasks });
}

export function reorderTasks(store: SessionStore, sessionId: string, orderedIds: string[]): Task[] {
  store.mutate(sessionId, (s) => {
    const index = new Map(orderedIds.map((id, i) => [id, i]));
    for (const task of s.tasks) {
      const position = index.get(task.id);
      if (position !== undefined) task.order = position;
    }
    s.tasks.sort((a, b) => a.order - b.order);
  });
  const session = store.get(sessionId);
  if (session) store.emitEvent({ type: 'tasks', sessionId, tasks: session.tasks });
  return session?.tasks ?? [];
}

/* ------------------------------------------------------------------ *
 * Rendering for the model
 * ------------------------------------------------------------------ */

export function summarizeBoard(tasks: Task[]): string {
  if (tasks.length === 0) return 'No tasks on the board.';
  const by = (status: TaskStatus) => tasks.filter((t) => t.status === status);
  const active = by('in_progress')[0];
  const blocked = by('blocked');

  const lines = [
    `Board: ${by('done').length} done · ${by('in_progress').length} in progress · ` +
      `${blocked.length} blocked · ${by('todo').length} to do`,
  ];
  if (active) lines.push(`Now: ${active.title}`);
  for (const task of blocked) {
    lines.push(`BLOCKED: ${task.title} — ${task.blockedReason ?? 'waiting on the user'}`);
  }
  const next = by('todo')[0];
  if (!active && !blocked.length && next) lines.push(`Next: ${next.title}`);
  return lines.join('\n');
}

/** The board as Claude should see it when resuming. */
export function renderBoard(tasks: Task[]): string {
  if (tasks.length === 0) return '[cc-harness] The task board is empty.';
  const order: TaskStatus[] = ['in_progress', 'blocked', 'todo', 'done'];
  const label: Record<TaskStatus, string> = {
    in_progress: 'IN PROGRESS',
    blocked: 'BLOCKED',
    todo: 'TODO',
    done: 'DONE',
  };

  const parts: string[] = [];
  for (const status of order) {
    const group = tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order);
    if (group.length === 0) continue;
    parts.push(`\n${label[status]}`);
    for (const task of group) {
      parts.push(`• [${task.id.slice(0, 8)}] ${task.title}`);
      if (task.blockedReason) parts.push(`    waiting on: ${task.blockedReason}`);
      if (task.files.length) parts.push(`    files: ${task.files.join(', ')}`);
      for (const decision of task.decisions) {
        parts.push(`    decided: ${decision.question} → ${decision.answer}`);
      }
      const changes = task.notes.filter((n) => n.kind === 'change');
      for (const note of changes.slice(-3)) parts.push(`    ${note.text}`);
    }
  }
  return parts.join('\n').trim();
}
