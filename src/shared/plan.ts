/**
 * The plan document: every way it can change, and every way it is read back.
 *
 * All edits — the user's in the browser and Claude's over MCP — go through
 * `applyOps`, so the change log is written in exactly one place and "what did
 * the user change since Claude last looked" is always answerable. Functions
 * here are pure over a `Plan` value: the store clones, applies, and commits
 * only when every op in a batch succeeded.
 */
import type {
  Author,
  Change,
  ChangeKind,
  Diagram,
  DiagramDirection,
  DiagramEdge,
  DiagramEdgeInput,
  DiagramNode,
  DiagramNodeInput,
  NodeKind,
  Plan,
  PlanInput,
  PlanOp,
  Section,
  Target,
  Task,
  TaskCounts,
  TaskInput,
  TaskStatus,
  Thread,
} from './types.ts';
import { NODE_KINDS, TASK_STATUSES } from './types.ts';

/** Raised for an op that cannot apply. The message is shown verbatim to
 *  whoever sent it — the user in a toast, Claude in a tool result. */
export class PlanError extends Error {}

/** The change log is for catching up, not an audit trail. */
export const MAX_CHANGES = 500;
const MAX_TITLE = 200;
const MAX_TEXT = 20_000;
const MAX_TASKS = 400;
const MAX_SECTIONS = 60;
const MAX_DIAGRAMS = 40;
const MAX_THREADS = 500;
const MAX_REPLIES = 200;

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export function emptyPlan(title = 'Untitled plan', now = Date.now()): Plan {
  return {
    title,
    summary: '',
    sections: [],
    diagrams: [],
    tasks: [],
    threads: [],
    changes: [],
    seq: 0,
    claudeReadSeq: 0,
    claudeReadAt: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Ids are short and readable — `t4`, `q2`, `d1` — because Claude quotes them
 * back in every edit and the user sees them on the page. They are never
 * reused within a plan, so a comment can never end up attached to a
 * different item that happens to get the same id later.
 */
const PREFIX = { section: 's', diagram: 'd', task: 't', thread: 'c' } as const;
type IdKind = keyof typeof PREFIX;

function nextId(plan: Plan, kind: IdKind): string {
  const prefix = PREFIX[kind];
  let max = 0;
  const scan = (id: string) => {
    if (!id.startsWith(prefix)) return;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  };
  // Scanning the change log as well as the live items is what makes ids
  // never-reused: a deleted `t4` still appears in the log.
  for (const s of plan.sections) scan(s.id);
  for (const d of plan.diagrams) scan(d.id);
  for (const t of plan.tasks) scan(t.id);
  for (const c of plan.threads) scan(c.id);
  for (const ch of plan.changes) scan(ch.target.id);
  return `${prefix}${max + 1}`;
}

function idTaken(plan: Plan, id: string): boolean {
  return (
    plan.sections.some((s) => s.id === id) ||
    plan.diagrams.some((d) => d.id === id) ||
    plan.tasks.some((t) => t.id === id) ||
    plan.threads.some((c) => c.id === id)
  );
}

/** Honour an id the caller chose when it is usable, else mint one. */
function claimId(plan: Plan, kind: IdKind, wanted: string | undefined): string {
  const id = clean(wanted, 40);
  if (id && /^[A-Za-z0-9_.-]+$/.test(id) && !idTaken(plan, id)) return id;
  return nextId(plan, kind);
}

/* ------------------------------------------------------------------ *
 * The change log
 * ------------------------------------------------------------------ */

function record(plan: Plan, author: Author, kind: ChangeKind, target: Target, summary: string, now: number): Change {
  plan.seq += 1;
  const change: Change = { seq: plan.seq, ts: now, author, kind, target, summary };
  plan.changes.push(change);
  if (plan.changes.length > MAX_CHANGES) plan.changes.splice(0, plan.changes.length - MAX_CHANGES);
  plan.updatedAt = now;
  return change;
}

/** User changes Claude has not read yet. */
export function unreadByClaude(plan: Plan | null): Change[] {
  if (!plan) return [];
  return plan.changes.filter((c) => c.seq > plan.claudeReadSeq && c.author === 'user');
}

export function markReadByClaude(plan: Plan, now = Date.now()): void {
  plan.claudeReadSeq = plan.seq;
  plan.claudeReadAt = now;
}

/**
 * Claude's own edits do not need reading back. When nothing the user did is
 * outstanding, move the read position past them so they never show up as
 * "since you last read".
 */
function settleClaudeRead(plan: Plan): void {
  if (unreadByClaude(plan).length === 0) plan.claudeReadSeq = plan.seq;
}

/* ------------------------------------------------------------------ *
 * Publishing the whole plan
 * ------------------------------------------------------------------ */

/**
 * Replace the plan's content with what Claude wrote, keeping everything the
 * user attached to items that survive: comments, positions, and statuses Claude
 * did not restate.
 *
 * Refused while the user has changes Claude has not read. A wholesale publish
 * written without them would silently discard the user's edits, which is the
 * one thing this tool must never do.
 */
export function publishPlan(prev: Plan | null, input: PlanInput, now = Date.now()): { plan: Plan; changes: Change[] } {
  if (prev && unreadByClaude(prev).length > 0) {
    throw new PlanError(
      `The user has made ${unreadByClaude(prev).length} change(s) to the plan since you last read it. ` +
        'Call harness_plan_read first, then publish again (or use harness_plan_edit for targeted changes) ' +
        'so their edits are not overwritten.',
    );
  }
  const title = clean(input.title, MAX_TITLE);
  if (!title) throw new PlanError('A plan needs a title.');

  const base = prev ? structuredClone(prev) : emptyPlan(title, now);
  // Ids are minted against everything the plan has ever held, so build into
  // a working copy that still remembers the old items until the end.
  const next: Plan = { ...base, title, summary: clean(input.summary, MAX_TEXT) ?? base.summary };

  if ((input.sections?.length ?? 0) > MAX_SECTIONS) throw new PlanError(`A plan holds at most ${MAX_SECTIONS} sections.`);
  if ((input.diagrams?.length ?? 0) > MAX_DIAGRAMS) throw new PlanError(`A plan holds at most ${MAX_DIAGRAMS} diagrams.`);
  const sections: Section[] = [];
  for (const raw of input.sections ?? []) {
    const old = base.sections.find((s) => s.id === raw.id);
    const id = old ? old.id : claimIdAmong(next, 'section', raw.id, sections);
    const body = clean(raw.body, MAX_TEXT) ?? '';
    const sTitle = clean(raw.title, MAX_TITLE) ?? 'Untitled';
    const same = old && old.title === sTitle && old.body === body;
    sections.push({
      id,
      title: sTitle,
      body,
      rev: same ? old.rev : (old?.rev ?? 0) + 1,
      updatedAt: same ? old.updatedAt : now,
      updatedBy: same ? old.updatedBy : 'claude',
    });
  }

  const tasks: Task[] = [];
  const walk = (list: TaskInput[] | undefined, parentId: string | null) => {
    (list ?? []).forEach((raw, order) => {
      if (tasks.length >= MAX_TASKS) throw new PlanError(`A plan holds at most ${MAX_TASKS} tasks.`);
      const tTitle = clean(raw?.title, MAX_TITLE);
      if (!tTitle) throw new PlanError('Every task needs a title.');
      const old = base.tasks.find((t) => t.id === raw.id);
      const id = old && !tasks.some((t) => t.id === old.id) ? old.id : claimIdAmong(next, 'task', raw.id, tasks);
      const status = validStatus(raw.status) ?? old?.status ?? 'todo';
      const detail = clean(raw.detail, MAX_TEXT);
      const note = clean(raw.note, MAX_TITLE * 2) ?? old?.note;
      const files = cleanList(raw.files) ?? old?.files;
      tasks.push({
        id,
        parentId,
        order,
        title: tTitle,
        ...(detail ? { detail } : {}),
        status,
        ...(files?.length ? { files } : {}),
        ...(note ? { note } : {}),
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        createdBy: old?.createdBy ?? 'claude',
      });
      walk(raw.subtasks, id);
    });
  };
  walk(input.tasks, null);

  const diagrams: Diagram[] = [];
  for (const raw of input.diagrams ?? []) {
    const old = base.diagrams.find((d) => d.id === raw.id);
    const id = old ? old.id : claimIdAmong(next, 'diagram', raw.id, diagrams);
    const dTitle = clean(raw.title, MAX_TITLE) ?? 'Diagram';
    const caption = clean(raw.caption, MAX_TEXT);
    const graph = buildGraph(raw.nodes ?? [], raw.edges ?? [], old, dTitle, new Set(tasks.map((t) => t.id)));
    const direction = validDirection(raw.direction) ?? old?.direction ?? 'LR';
    const same =
      old &&
      old.title === dTitle &&
      old.caption === caption &&
      old.direction === direction &&
      JSON.stringify([old.nodes, old.edges]) === JSON.stringify([graph.nodes, graph.edges]);
    diagrams.push({
      id,
      title: dTitle,
      rev: same ? old.rev : (old?.rev ?? 0) + 1,
      ...graph,
      direction,
      ...(caption ? { caption } : {}),
      updatedAt: same ? old.updatedAt : now,
      updatedBy: same ? old.updatedBy : 'claude',
    });
  }

  next.sections = sections;
  next.diagrams = diagrams;
  next.tasks = tasks;
  next.threads = base.threads.map((thread) => detachIfOrphaned(next, base, thread));
  next.revision = base.revision + 1;
  if (!prev) next.createdAt = now;

  const change = record(
    next,
    'claude',
    'published',
    { kind: 'plan', id: '' },
    prev ? `published revision ${next.revision} of the plan` : 'published the plan',
    now,
  );
  markReadByClaude(next, now);
  return { plan: next, changes: [change] };
}

/** `claimId`, but also avoiding ids already handed out in this publish. */
function claimIdAmong(
  plan: Plan,
  kind: 'section' | 'diagram' | 'task',
  wanted: string | undefined,
  fresh: { id: string }[],
): string {
  const key = ({ section: 'sections', diagram: 'diagrams', task: 'tasks' } as const)[kind];
  const probe = { ...plan, [key]: [...(plan[key] as { id: string }[]), ...fresh] } as Plan;
  return claimId(probe, kind, wanted);
}

/** A comment whose item was removed is kept, re-homed on the plan itself,
 *  and labelled with what it used to be about. */
function detachIfOrphaned(plan: Plan, before: Plan, thread: Thread): Thread {
  if (targetExists(plan, thread.target)) return thread;
  const label = describeTarget(before, thread.target);
  return { ...thread, target: { kind: 'plan', id: '' }, text: `(on removed ${label}) ${thread.text}` };
}

/**
 * Bring a plan read from disk into shape: every list present, every revision
 * counter set. A plan written by any earlier build, or a hand-edited one, must
 * load rather than throw — a throw on load is a plan the next save overwrites.
 */
export function normalizePlan(raw: Partial<Plan> & Record<string, unknown>, fallbackTitle: string): Plan {
  const now = Date.now();
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const plan: Plan = {
    ...emptyPlan(typeof raw.title === 'string' && raw.title ? raw.title : fallbackTitle, now),
    ...raw,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    sections: list<Section>(raw.sections).map((s) => ({ ...s, rev: typeof s.rev === 'number' ? s.rev : 1 })),
    diagrams: list<Diagram>(raw.diagrams).map((d) => ({
      ...d,
      rev: typeof d.rev === 'number' ? d.rev : 1,
      nodes: list(d.nodes),
      edges: list(d.edges),
      direction: d.direction === 'TB' ? 'TB' : 'LR',
    })),
    tasks: list<Task>(raw.tasks),
    threads: list<Thread>(raw.threads).map((t) => ({ ...t, replies: list(t.replies) })),
    changes: list<Change>(raw.changes),
    seq: typeof raw.seq === 'number' ? raw.seq : 0,
    claudeReadSeq: typeof raw.claudeReadSeq === 'number' ? raw.claudeReadSeq : 0,
    claudeReadAt: typeof raw.claudeReadAt === 'number' ? raw.claudeReadAt : null,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
  };
  return plan;
}

/* ------------------------------------------------------------------ *
 * Targeted edits
 * ------------------------------------------------------------------ */

/**
 * Apply a batch of ops to a copy of `plan`. All or nothing: the first op that
 * cannot apply throws, and the caller keeps the plan it had.
 */
export function applyOps(
  plan: Plan,
  ops: PlanOp[],
  author: Author,
  now = Date.now(),
): { plan: Plan; changes: Change[] } {
  if (!Array.isArray(ops) || ops.length === 0) throw new PlanError('No edits were given.');
  const next = structuredClone(plan);
  const changes: Change[] = [];
  ops.forEach((op, i) => {
    try {
      changes.push(...applyOne(next, op, author, now));
    } catch (err) {
      if (err instanceof PlanError && ops.length > 1) {
        throw new PlanError(`Edit ${i + 1} (${(op as { op?: string })?.op ?? '?'}): ${err.message}`);
      }
      throw err;
    }
  });
  if (author === 'claude') settleClaudeRead(next);
  return { plan: next, changes };
}

function applyOne(plan: Plan, op: PlanOp, author: Author, now: number): Change[] {
  const log = (kind: ChangeKind, target: Target, summary: string) => record(plan, author, kind, target, summary, now);

  switch (op?.op) {
    case 'set_meta': {
      const out: Change[] = [];
      const title = clean(op.title, MAX_TITLE);
      if (title && title !== plan.title) {
        plan.title = title;
        out.push(log('edited', { kind: 'plan', id: '' }, `renamed the plan to "${title}"`));
      }
      if (typeof op.summary === 'string' && op.summary !== plan.summary) {
        plan.summary = clean(op.summary, MAX_TEXT) ?? '';
        out.push(log('edited', { kind: 'plan', id: '' }, 'edited the plan summary'));
      }
      return out;
    }

    case 'upsert_section': {
      const existing = op.id ? plan.sections.find((s) => s.id === op.id) : undefined;
      if (existing) {
        checkRev(existing, op.expect, 'section', author);
        const title = clean(op.title, MAX_TITLE);
        const body = typeof op.body === 'string' ? clean(op.body, MAX_TEXT) ?? '' : undefined;
        const changed = (title && title !== existing.title) || (body !== undefined && body !== existing.body);
        if (typeof op.index === 'number') moveInList(plan.sections, existing.id, op.index);
        if (!changed) return [];
        if (title) existing.title = title;
        if (body !== undefined) existing.body = body;
        existing.rev += 1;
        existing.updatedAt = now;
        existing.updatedBy = author;
        return [log('edited', ref('section', existing.id), `edited section "${existing.title}"`)];
      }
      const title = clean(op.title, MAX_TITLE);
      if (!title) throw new PlanError(op.id ? `No section "${op.id}".` : 'A new section needs a title.');
      if (plan.sections.length >= MAX_SECTIONS) throw new PlanError(`A plan holds at most ${MAX_SECTIONS} sections.`);
      const section: Section = {
        id: claimId(plan, 'section', op.id),
        title,
        body: clean(op.body, MAX_TEXT) ?? '',
        rev: 1,
        updatedAt: now,
        updatedBy: author,
      };
      insertAt(plan.sections, section, op.index);
      return [log('created', ref('section', section.id), `added section "${title}"`)];
    }

    case 'upsert_diagram': {
      const existing = op.id ? plan.diagrams.find((d) => d.id === op.id) : undefined;
      if (existing) {
        checkRev(existing, op.expect, 'diagram', author);
        const before = structuredClone(existing);
        const title = clean(op.title, MAX_TITLE);
        if (title) existing.title = title;
        if (op.nodes || op.edges) {
          const graph = buildGraph(op.nodes ?? existing.nodes, op.edges ?? existing.edges, existing, existing.title, taskIdSet(plan));
          existing.nodes = graph.nodes;
          existing.edges = graph.edges;
        }
        const direction = validDirection(op.direction);
        if (direction) existing.direction = direction;
        if (typeof op.caption === 'string') setOptional(existing, 'caption', clean(op.caption, MAX_TEXT));
        if (typeof op.index === 'number') moveInList(plan.diagrams, existing.id, op.index);
        const what = describeDiagramEdit(before, existing);
        if (!what) return [];
        existing.rev += 1;
        existing.updatedAt = now;
        existing.updatedBy = author;
        // Dragging boxes around is layout, not content: logged, but as a move.
        const kind: ChangeKind = what.startsWith('rearranged') ? 'moved' : 'edited';
        return [log(kind, ref('diagram', existing.id), `${what} in diagram "${existing.title}"`)];
      }
      if (op.id) throw new PlanError(`No diagram "${op.id}".`);
      if (plan.diagrams.length >= MAX_DIAGRAMS) throw new PlanError(`A plan holds at most ${MAX_DIAGRAMS} diagrams.`);
      const title = clean(op.title, MAX_TITLE) ?? 'Diagram';
      const caption = clean(op.caption, MAX_TEXT);
      const diagram: Diagram = {
        id: claimId(plan, 'diagram', undefined),
        title,
        rev: 1,
        ...buildGraph(op.nodes ?? [], op.edges ?? [], undefined, title, taskIdSet(plan)),
        direction: validDirection(op.direction) ?? 'LR',
        ...(caption ? { caption } : {}),
        updatedAt: now,
        updatedBy: author,
      };
      insertAt(plan.diagrams, diagram, op.index);
      return [log('created', ref('diagram', diagram.id), `added diagram "${title}"`)];
    }

    case 'upsert_task': {
      const existing = op.id ? findTask(plan, op.id) : undefined;
      if (existing) return editTask(plan, existing, op, author, now, log);

      const title = clean(op.title, MAX_TITLE);
      if (!title) throw new PlanError(op.id ? `No task "${op.id}".` : 'A new task needs a title.');
      if (plan.tasks.length >= MAX_TASKS) throw new PlanError(`A plan holds at most ${MAX_TASKS} tasks.`);
      const parentId = op.parentId ? requireTask(plan, op.parentId).id : null;
      const detail = clean(op.detail, MAX_TEXT);
      const note = clean(op.note, MAX_TITLE * 2);
      const files = cleanList(op.files);
      const task: Task = {
        id: claimId(plan, 'task', op.id),
        parentId,
        order: Number.MAX_SAFE_INTEGER,
        title,
        ...(detail ? { detail } : {}),
        status: validStatus(op.status) ?? 'todo',
        ...(files?.length ? { files } : {}),
        ...(note ? { note } : {}),
        createdAt: now,
        updatedAt: now,
        createdBy: author,
      };
      plan.tasks.push(task);
      placeAmongSiblings(plan, task, op.index);
      const where = parentId ? ` under "${requireTask(plan, parentId).title}"` : '';
      return [log('created', ref('task', task.id), `added task "${title}"${where}`)];
    }

    case 'move_task': {
      const task = requireTask(plan, op.id);
      const parentId = op.parentId ? requireTask(plan, op.parentId).id : null;
      if (parentId && (parentId === task.id || isDescendant(plan, parentId, task.id))) {
        throw new PlanError(`Cannot move "${task.title}" inside itself.`);
      }
      const from = task.parentId;
      task.parentId = parentId;
      task.updatedAt = now;
      normalizeSiblings(plan, from);
      placeAmongSiblings(plan, task, op.index);
      const where = parentId ? `under "${requireTask(plan, parentId).title}"` : 'to the top level';
      const summary = from === parentId ? `reordered "${task.title}"` : `moved "${task.title}" ${where}`;
      return [log('moved', ref('task', task.id), summary)];
    }

    case 'move_section': {
      const section = plan.sections.find((s) => s.id === op.id);
      if (!section) throw new PlanError(`No section "${op.id}".`);
      moveInList(plan.sections, section.id, op.index);
      return [log('moved', ref('section', section.id), `reordered section "${section.title}"`)];
    }

    case 'move_diagram': {
      const diagram = plan.diagrams.find((d) => d.id === op.id);
      if (!diagram) throw new PlanError(`No diagram "${op.id}".`);
      moveInList(plan.diagrams, diagram.id, op.index);
      return [log('moved', ref('diagram', diagram.id), `reordered diagram "${diagram.title}"`)];
    }

    case 'remove':
      return removeItem(plan, op.kind, op.id, log);

    case 'comment': {
      const target = normalizeTarget(op.target);
      if (!targetExists(plan, target)) throw new PlanError(`Nothing to comment on at ${target.kind} "${target.id}".`);
      const text = clean(op.text, MAX_TEXT);
      if (!text) throw new PlanError('A comment needs text.');
      if (plan.threads.length >= MAX_THREADS) throw new PlanError(`A plan holds at most ${MAX_THREADS} comment threads.`);
      const thread: Thread = {
        id: claimId(plan, 'thread', undefined),
        target,
        author,
        text,
        ts: now,
        resolved: false,
        replies: [],
      };
      plan.threads.push(thread);
      return [log('commented', target, `commented on ${describeTarget(plan, target)}: ${short(text, 80)}`)];
    }

    case 'reply': {
      const thread = plan.threads.find((c) => c.id === op.threadId);
      if (!thread) throw new PlanError(`No comment thread "${op.threadId}".`);
      const text = clean(op.text, MAX_TEXT);
      if (!text) throw new PlanError('A reply needs text.');
      if (thread.replies.length >= MAX_REPLIES) throw new PlanError('This thread is full; start a new comment.');
      thread.replies.push({ id: `${thread.id}.${thread.replies.length + 1}`, author, text, ts: now });
      return [log('replied', thread.target, `replied on ${describeTarget(plan, thread.target)}: ${short(text, 80)}`)];
    }

    case 'resolve': {
      const thread = plan.threads.find((c) => c.id === op.threadId);
      if (!thread) throw new PlanError(`No comment thread "${op.threadId}".`);
      const resolved = op.resolved !== false;
      if (thread.resolved === resolved) return [];
      thread.resolved = resolved;
      return [
        log(
          resolved ? 'resolved' : 'reopened',
          thread.target,
          `${resolved ? 'resolved' : 'reopened'} a comment on ${describeTarget(plan, thread.target)}`,
        ),
      ];
    }

    default:
      throw new PlanError(`Unknown edit "${(op as { op?: unknown })?.op}".`);
  }
}

function editTask(
  plan: Plan,
  task: Task,
  op: Extract<PlanOp, { op: 'upsert_task' }>,
  author: Author,
  now: number,
  log: (kind: ChangeKind, target: Target, summary: string) => Change,
): Change[] {
  const out: Change[] = [];
  const edited: string[] = [];
  const title = clean(op.title, MAX_TITLE);
  if (title && title !== task.title) {
    task.title = title;
    edited.push('title');
  }
  if (typeof op.detail === 'string' && op.detail !== (task.detail ?? '')) {
    setOptional(task, 'detail', clean(op.detail, MAX_TEXT));
    edited.push('detail');
  }
  if (op.files) {
    setOptional(task, 'files', cleanList(op.files)?.length ? cleanList(op.files) : undefined);
    edited.push('files');
  }
  if (typeof op.note === 'string') {
    setOptional(task, 'note', clean(op.note, MAX_TITLE * 2));
    if (!op.status) edited.push('note');
  }
  if (op.status !== undefined) {
    const status = validStatus(op.status);
    if (!status) throw new PlanError(`"${op.status}" is not a task status (${TASK_STATUSES.join(', ')}).`);
    if (status !== task.status) {
      task.status = status;
      task.updatedAt = now;
      const note = task.note && typeof op.note === 'string' ? ` — ${short(task.note, 80)}` : '';
      out.push(log('status', ref('task', task.id), `marked "${task.title}" ${STATUS_WORDS[status]}${note}`));
    }
  }
  if (edited.length) {
    task.updatedAt = now;
    out.push(log('edited', ref('task', task.id), `edited the ${edited.join(', ')} of "${task.title}"`));
  }
  if (typeof op.index === 'number') placeAmongSiblings(plan, task, op.index);
  void author;
  return out;
}

function removeItem(
  plan: Plan,
  kind: string,
  id: string,
  log: (kind: ChangeKind, target: Target, summary: string) => Change,
): Change[] {
  const before = structuredClone(plan);
  let summary: string;
  switch (kind) {
    case 'section': {
      const s = plan.sections.find((x) => x.id === id);
      if (!s) throw new PlanError(`No section "${id}".`);
      plan.sections = plan.sections.filter((x) => x.id !== id);
      summary = `removed section "${s.title}"`;
      break;
    }
    case 'diagram': {
      const d = plan.diagrams.find((x) => x.id === id);
      if (!d) throw new PlanError(`No diagram "${id}".`);
      plan.diagrams = plan.diagrams.filter((x) => x.id !== id);
      summary = `removed diagram "${d.title}"`;
      break;
    }
    case 'task': {
      const t = requireTask(plan, id);
      const doomed = new Set([t.id, ...descendants(plan, t.id).map((d) => d.id)]);
      plan.tasks = plan.tasks.filter((x) => !doomed.has(x.id));
      normalizeSiblings(plan, t.parentId);
      for (const d of plan.diagrams) {
        for (const n of d.nodes) {
          if (!n.taskIds) continue;
          n.taskIds = n.taskIds.filter((id) => !doomed.has(id));
          if (n.taskIds.length === 0) delete n.taskIds;
        }
      }
      const extra = doomed.size > 1 ? ` and its ${doomed.size - 1} subtask(s)` : '';
      summary = `removed task "${t.title}"${extra}`;
      break;
    }
    default:
      throw new PlanError(`Cannot remove a "${kind}".`);
  }
  plan.threads = plan.threads.map((t) => detachIfOrphaned(plan, before, t));
  return [log('deleted', { kind: kind as Target['kind'], id }, summary)];
}

/* ------------------------------------------------------------------ *
 * Diagrams
 * ------------------------------------------------------------------ */

const MAX_NODES = 120;
const MAX_EDGES = 300;

/**
 * Validate a graph and normalize it. Node ids must be unique and every edge
 * must join two nodes that exist — an edge to nowhere is almost always a typo
 * in a node id, and saying so is more useful than drawing half a diagram.
 * Positions survive a rewrite: a node that keeps its id and comes without
 * coordinates stays where the user put it.
 */
function buildGraph(
  rawNodes: DiagramNodeInput[],
  rawEdges: DiagramEdgeInput[],
  old: Diagram | undefined,
  title: string,
  taskIds: Set<string>,
): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) throw new PlanError(`Diagram "${title}": nodes and edges must be lists.`);
  if (rawNodes.length > MAX_NODES) throw new PlanError(`Diagram "${title}" has more than ${MAX_NODES} nodes.`);
  if (rawEdges.length > MAX_EDGES) throw new PlanError(`Diagram "${title}" has more than ${MAX_EDGES} edges.`);

  const nodes: DiagramNode[] = [];
  for (const raw of rawNodes) {
    const id = clean(raw?.id, 60);
    if (!id) throw new PlanError(`Diagram "${title}": every node needs an id.`);
    if (nodes.some((n) => n.id === id)) throw new PlanError(`Diagram "${title}": node id "${id}" is used twice.`);
    const prev = old?.nodes.find((n) => n.id === id);
    const detail = clean(raw.detail, 400);
    const notes = raw.notes === undefined ? prev?.notes : clean(raw.notes, MAX_TEXT);
    const links = raw.taskIds === undefined ? prev?.taskIds : cleanList(raw.taskIds);
    for (const t of links ?? []) {
      if (!taskIds.has(t)) throw new PlanError(`Diagram "${title}": node "${id}" links task "${t}", which is not in the plan.`);
    }
    const x = finite(raw.x) ?? prev?.x;
    const y = finite(raw.y) ?? prev?.y;
    nodes.push({
      id,
      label: clean(raw.label, 120) ?? prev?.label ?? id,
      kind: validKind(raw.kind) ?? prev?.kind ?? 'component',
      ...(detail ? { detail } : {}),
      ...(notes ? { notes } : {}),
      ...(links?.length ? { taskIds: [...new Set(links)] } : {}),
      ...(x !== undefined && y !== undefined ? { x: Math.round(x), y: Math.round(y) } : {}),
    });
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges: DiagramEdge[] = [];
  for (const raw of rawEdges) {
    const source = clean(raw?.source, 60);
    const target = clean(raw?.target, 60);
    if (!source || !target) throw new PlanError(`Diagram "${title}": every edge needs a source and a target.`);
    for (const end of [source, target]) {
      if (!ids.has(end)) throw new PlanError(`Diagram "${title}": an edge refers to node "${end}", which is not in the diagram.`);
    }
    let id = clean(raw.id, 80) ?? `${source}->${target}`;
    for (let n = 2; edges.some((e) => e.id === id); n++) id = `${source}->${target}#${n}`;
    const label = clean(raw.label, 120);
    edges.push({ id, source, target, ...(label ? { label } : {}), ...(raw.dashed ? { dashed: true } : {}) });
  }
  return { nodes, edges };
}

/** What changed in a diagram, in words — what Claude reads in the change log. */
function describeDiagramEdit(before: Diagram, after: Diagram): string | null {
  const parts: string[] = [];
  if (before.title !== after.title) parts.push(`renamed it from "${before.title}"`);
  const label = (d: Diagram, id: string) => d.nodes.find((n) => n.id === id)?.label ?? id;
  const added = after.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
  const removed = before.nodes.filter((n) => !after.nodes.some((a) => a.id === n.id));
  const changed = after.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.label !== n.label || b.kind !== n.kind || (b.detail ?? '') !== (n.detail ?? '') || (b.notes ?? '') !== (n.notes ?? ''));
  });
  const relinked = after.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.taskIds ?? []).join() !== (n.taskIds ?? []).join();
  });
  const moved = after.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.x !== n.x || b.y !== n.y);
  });
  const edgeKey = (e: DiagramEdge) => `${e.source}->${e.target}`;
  const linked = after.edges.filter((e) => !before.edges.some((b) => edgeKey(b) === edgeKey(e)));
  const unlinked = before.edges.filter((e) => !after.edges.some((a) => edgeKey(a) === edgeKey(e)));
  const relabeled = after.edges.filter((e) => {
    const b = before.edges.find((x) => edgeKey(x) === edgeKey(e));
    return b && ((b.label ?? '') !== (e.label ?? '') || Boolean(b.dashed) !== Boolean(e.dashed));
  });
  const list = (items: string[]) => (items.length > 3 ? `${items.slice(0, 3).join(', ')} and ${items.length - 3} more` : items.join(', '));

  if (added.length) parts.push(`added ${list(added.map((n) => `"${n.label}"`))}`);
  if (removed.length) parts.push(`removed ${list(removed.map((n) => `"${n.label}"`))}`);
  if (changed.length) parts.push(`edited ${list(changed.map((n) => `"${n.label}"`))}`);
  if (relinked.length) parts.push(`changed the tasks behind ${list(relinked.map((n) => `"${n.label}"`))}`);
  if (linked.length) parts.push(`connected ${list(linked.map((e) => `${label(after, e.source)} → ${label(after, e.target)}`))}`);
  if (unlinked.length) parts.push(`disconnected ${list(unlinked.map((e) => `${label(before, e.source)} → ${label(before, e.target)}`))}`);
  if (relabeled.length) parts.push(`relabelled ${list(relabeled.map((e) => `${label(after, e.source)} → ${label(after, e.target)}`))}`);
  if (before.direction !== after.direction) parts.push(`turned it ${after.direction === 'LR' ? 'left-to-right' : 'top-to-bottom'}`);
  if ((before.caption ?? '') !== (after.caption ?? '')) parts.push('edited the caption');
  if (parts.length) return parts.join('; ');
  if (moved.length) return `rearranged ${moved.length} node(s)`;
  return null;
}

/**
 * Refuse a save made against a revision that has since moved on. Both sides
 * edit the same plan, and a whole-body save from a stale editor would quietly
 * throw away the other side's change — the one failure a shared plan must
 * not have. The caller reloads and tries again with the latest in front of it.
 */
function checkRev(item: { rev: number; title: string; updatedBy: Author }, expect: unknown, kind: string, author: Author): void {
  if (typeof expect !== 'number' || expect === item.rev) return;
  const who = item.updatedBy === author ? 'another edit' : item.updatedBy === 'claude' ? 'Claude' : 'the user';
  throw new PlanError(
    `${kind[0]!.toUpperCase()}${kind.slice(1)} "${item.title}" was changed by ${who} while this edit was open, so it was not saved. ` +
      'It now shows the latest version.',
  );
}

function taskIdSet(plan: Pick<Plan, 'tasks'>): Set<string> {
  return new Set(plan.tasks.map((t) => t.id));
}

function validKind(value: unknown): NodeKind | undefined {
  return (NODE_KINDS as readonly string[]).includes(value as string) ? (value as NodeKind) : undefined;
}

function validDirection(value: unknown): DiagramDirection | undefined {
  return value === 'LR' || value === 'TB' ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * Task tree helpers
 * ------------------------------------------------------------------ */

function findTask(plan: Plan, id: string): Task | undefined {
  return plan.tasks.find((t) => t.id === id);
}

function requireTask(plan: Plan, id: string): Task {
  const task = findTask(plan, id);
  if (!task) throw new PlanError(`No task "${id}".`);
  return task;
}

export function childrenOf(plan: Pick<Plan, 'tasks'>, parentId: string | null): Task[] {
  return plan.tasks.filter((t) => t.parentId === parentId).sort((a, b) => a.order - b.order);
}

export function descendants(plan: Pick<Plan, 'tasks'>, id: string): Task[] {
  const out: Task[] = [];
  const visit = (pid: string) => {
    for (const child of childrenOf(plan, pid)) {
      out.push(child);
      visit(child.id);
    }
  };
  visit(id);
  return out;
}

function isDescendant(plan: Plan, candidate: string, ancestor: string): boolean {
  return descendants(plan, ancestor).some((t) => t.id === candidate);
}

function normalizeSiblings(plan: Plan, parentId: string | null): void {
  childrenOf(plan, parentId).forEach((t, i) => {
    t.order = i;
  });
}

/** Put `task` at `index` among its siblings (end when omitted). */
function placeAmongSiblings(plan: Plan, task: Task, index: number | undefined): void {
  const siblings = childrenOf(plan, task.parentId).filter((t) => t.id !== task.id);
  const at = index === undefined ? siblings.length : clampIndex(index, siblings.length);
  siblings.splice(at, 0, task);
  siblings.forEach((t, i) => {
    t.order = i;
  });
}

/** Depth-first order with outline numbers ("1", "1.2", "1.2.1"). */
export function outline(plan: Pick<Plan, 'tasks'>): { task: Task; depth: number; number: string }[] {
  const out: { task: Task; depth: number; number: string }[] = [];
  const visit = (parentId: string | null, depth: number, prefix: string) => {
    childrenOf(plan, parentId).forEach((task, i) => {
      const number = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push({ task, depth, number });
      visit(task.id, depth + 1, number);
    });
  };
  visit(null, 0, '');
  return out;
}

/**
 * Progress counts leaves only: a parent is a heading over its subtasks, and
 * counting it as well would make one finished subtask look like two.
 */
export function countTasks(plan: Pick<Plan, 'tasks'> | null): TaskCounts {
  const counts: TaskCounts = { total: 0, done: 0, inProgress: 0, blocked: 0 };
  if (!plan) return counts;
  const parents = new Set(plan.tasks.map((t) => t.parentId).filter(Boolean));
  for (const t of plan.tasks) {
    if (parents.has(t.id)) continue;
    counts.total++;
    if (t.status === 'done') counts.done++;
    else if (t.status === 'in_progress') counts.inProgress++;
    else if (t.status === 'blocked') counts.blocked++;
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const STATUS_WORDS: Record<TaskStatus, string> = {
  todo: 'to do',
  in_progress: 'in progress',
  blocked: 'blocked',
  done: 'done',
};

function ref(kind: Target['kind'], id: string): Target {
  return { kind, id };
}

function normalizeTarget(raw: unknown): Target {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = String(rec['kind'] ?? 'plan') as Target['kind'];
  return { kind, id: kind === 'plan' ? '' : String(rec['id'] ?? '') };
}

export function targetExists(plan: Plan, target: Target): boolean {
  switch (target.kind) {
    case 'plan':
      return true;
    case 'section':
      return plan.sections.some((s) => s.id === target.id);
    case 'diagram':
      return plan.diagrams.some((d) => d.id === target.id);
    case 'task':
      return plan.tasks.some((t) => t.id === target.id);
    default:
      return false;
  }
}

export function describeTarget(plan: Plan, target: Target): string {
  switch (target.kind) {
    case 'plan':
      return 'the plan';
    case 'section': {
      const s = plan.sections.find((x) => x.id === target.id);
      return s ? `section "${s.title}"` : `section ${target.id}`;
    }
    case 'diagram': {
      const d = plan.diagrams.find((x) => x.id === target.id);
      return d ? `diagram "${d.title}"` : `diagram ${target.id}`;
    }
    case 'task': {
      const t = plan.tasks.find((x) => x.id === target.id);
      return t ? `task "${t.title}"` : `task ${target.id}`;
    }
    default:
      return 'an item';
  }
}

function validStatus(value: unknown): TaskStatus | undefined {
  return (TASK_STATUSES as readonly string[]).includes(value as string) ? (value as TaskStatus) : undefined;
}

/** Trim and bound a string; `undefined` for anything empty or not a string. */
function clean(value: unknown, max: number, trim = true): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = (trim ? value.trim() : value.replace(/\s+$/, '')).slice(0, max);
  return out.trim() ? out : undefined;
}

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((v) => (typeof v === 'string' ? v.trim().slice(0, 300) : ''))
    .filter(Boolean)
    .slice(0, 50);
}

function setOptional<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined || value === null || value === '') delete obj[key];
  else obj[key] = value;
}

function insertAt<T>(list: T[], item: T, index: number | undefined): void {
  if (index === undefined) list.push(item);
  else list.splice(clampIndex(index, list.length), 0, item);
}

function moveInList<T extends { id: string }>(list: T[], id: string, index: number): void {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return;
  const [item] = list.splice(from, 1);
  list.splice(clampIndex(index, list.length), 0, item!);
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

export function short(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The task Claude is working on: the first one in progress, in outline order. */
export function currentTask(plan: Pick<Plan, 'tasks'> | null): Task | null {
  if (!plan) return null;
  return outline(plan).find((r) => r.task.status === 'in_progress' && !plan.tasks.some((t) => t.parentId === r.task.id))?.task ?? null;
}
