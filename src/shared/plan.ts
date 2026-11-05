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
  BuildSettings,
  BuildTarget,
  Change,
  CheckResult,
  ChangeKind,
  DesignSignoff,
  Diagram,
  DiagramDirection,
  DiagramEdge,
  EdgeArrows,
  DiagramEdgeInput,
  DiagramNode,
  DiagramNodeInput,
  IricStage,
  NodeKind,
  Plan,
  PlanBaseline,
  PlanInput,
  PlanOp,
  PlanOpName,
  PlanPhase,
  Section,
  Submission,
  Target,
  Task,
  TaskCounts,
  TaskInput,
  TaskListInput,
  TaskStatus,
  Thread,
} from './types.ts';
import { BUILD_TARGETS, EDGE_ARROWS, IRIC_STAGES, NODE_KINDS, TASK_STATUSES } from './types.ts';
import { cleanSettings, dependencyProblem, validReview } from './build.ts';

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
    version: 0,
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
  plan.version += 1;
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

/**
 * How many things the user changed that Claude has not read — each box,
 * task, section or comment thread counted once however many saves it took.
 * This is the number to show people; the log's length counts keystrokes.
 */
export function unreadItems(plan: Plan | null): number {
  return new Set(unreadByClaude(plan).map((c) => `${c.target.kind}:${c.target.id}`)).size;
}

/** How set_meta words a rename — and so how a rename is told apart from a
 *  summary edit, which shares the plan as its target. */
const RENAMED_PLAN = 'renamed the plan';

/** How a reopened sign-off is logged. */
export const REOPENED_DESIGN = 'reopened the design';
export const REOPENED_PLAN = 'reopened the submitted plan';

/** Where the user's unread changes are — "the "Components" diagram",
 *  "tasks", "comments" — in the order they first touched each. */
export function unreadAreas(plan: Plan | null): string[] {
  const areas: string[] = [];
  const add = (what: string) => void (areas.includes(what) || areas.push(what));
  for (const c of unreadByClaude(plan)) {
    if (['commented', 'replied', 'resolved', 'reopened'].includes(c.kind)) add('comments');
    else if (c.target.kind === 'plan' && c.kind === 'status') add(c.summary === REOPENED_DESIGN ? 'reopened the design' : 'reopened the plan');
    else if (c.target.kind === 'diagram') add(`the "${plan!.diagrams.find((d) => d.id === c.target.id)?.title ?? c.target.id}" diagram`);
    else if (c.target.kind === 'task') add('tasks');
    else if (c.target.kind === 'section') add('sections');
    else if (c.summary.startsWith(RENAMED_PLAN)) add("the plan's title");
    else add('the summary');
  }
  return areas;
}

export function markReadByClaude(plan: Plan, now = Date.now()): void {
  plan.claudeReadSeq = plan.seq;
  plan.claudeReadAt = now;
  plan.claudeBaseline = baselineOf(plan);
}

/**
 * Claude's own edits do not need reading back. When nothing the user did is
 * outstanding, move the read position past them so they never show up as
 * "since you last read".
 */
function settleClaudeRead(plan: Plan): void {
  if (unreadByClaude(plan).length > 0) return;
  plan.claudeReadSeq = plan.seq;
  plan.claudeBaseline = baselineOf(plan);
}

/**
 * Claude edited the plan while the user still has changes it has not read.
 * The baseline is "what Claude knows", so Claude's own edit belongs in it —
 * otherwise the next read would report Claude's change as the user's. Only
 * what Claude's ops actually changed is copied in, field by field; anything
 * the user changed on the same item stays different, and is reported.
 */
function foldClaudeEdit(base: PlanBaseline, before: PlanBaseline, after: PlanBaseline): PlanBaseline {
  const out = structuredClone(base);
  if (before.title !== after.title) out.title = after.title;
  if (before.summary !== after.summary) out.summary = after.summary;
  out.sections = foldList(out.sections, before.sections, after.sections, foldFields);
  out.tasks = foldList(out.tasks, before.tasks, after.tasks, foldFields);
  out.diagrams = foldList(out.diagrams, before.diagrams, after.diagrams, (o, b, a) => {
    const { nodes: _on, edges: _oe, ...meta } = o;
    const { nodes: _bn, edges: _be, ...bMeta } = b;
    const { nodes: _an, edges: _ae, ...aMeta } = a;
    return {
      ...foldFields(meta, bMeta, aMeta),
      nodes: foldList(o.nodes, b.nodes, a.nodes, foldFields),
      edges: foldEdges(o.edges, b.edges, a.edges),
    };
  });
  return out;
}

/** Copy into `o` every field that differs between `b` and `a`. */
function foldFields<T extends object>(o: T, b: T, a: T): T {
  const out = { ...o } as Record<string, unknown>;
  const was = b as Record<string, unknown>;
  const now = a as Record<string, unknown>;
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (JSON.stringify(was[key]) === JSON.stringify(now[key])) continue;
    if (now[key] === undefined) delete out[key];
    else out[key] = structuredClone(now[key]);
  }
  return out as T;
}

/** Fold a list of items with ids: what Claude added, removed, changed or
 *  reordered is applied to the baseline's copy of the list. */
function foldList<T extends { id: string }>(base: T[], before: T[], after: T[], merge: (o: T, b: T, a: T) => T): T[] {
  const has = (list: T[], id: string) => list.some((x) => x.id === id);
  let out = base.filter((x) => !(has(before, x.id) && !has(after, x.id)));
  for (const a of after) {
    const b = before.find((x) => x.id === a.id);
    const i = out.findIndex((x) => x.id === a.id);
    if (b && i >= 0 && JSON.stringify(b) !== JSON.stringify(a)) out[i] = merge(out[i]!, b, a);
  }
  const order = (list: T[]) => list.filter((x) => has(after, x.id) && has(before, x.id)).map((x) => x.id).join('\u0000');
  if (order(before) !== order(after)) {
    // Claude moved things: its order is the one it knows. (Any reorder of the
    // user's still unread is folded with it — Claude's move was made on top.)
    const at = new Map(after.map((x, i) => [x.id, i]));
    let last = -1;
    const rank = new Map(
      out.map((x) => {
        const i = at.get(x.id);
        if (i !== undefined) last = i;
        return [x.id, i ?? last + 0.5];
      }),
    );
    out = [...out].sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);
  }
  // What Claude created goes where Claude put it: just after the item it
  // follows in Claude's list, or first. Nothing else moves, so a reorder the
  // user made is still there to be reported.
  after.forEach((a, i) => {
    if (has(before, a.id) || has(out, a.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.id === after[j]!.id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, structuredClone(a));
  });
  return out;
}

/**
 * Whether two baselines say the same thing. Field order is not meaning, and
 * neither is the order arrows are listed in — only the order of things whose
 * order the plan shows: sections, diagrams, tasks and boxes.
 */
export function sameContent(a: PlanBaseline, b: PlanBaseline): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown, key = ''): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v));
    if (key === 'edges') items.sort();
    return `[${items.join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k], k)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function foldEdges(base: DiagramEdge[], before: DiagramEdge[], after: DiagramEdge[]): DiagramEdge[] {
  const claude = matchEdges(before, after);
  let out = [...base];
  for (const gone of claude.removed) {
    const hit = matchEdges(out, [gone]).pairs[0]?.[0];
    if (hit) out = out.filter((e) => e !== hit);
  }
  for (const [b, a] of claude.pairs) {
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    const hit = matchEdges(out, [b]).pairs[0]?.[0];
    if (hit) out = out.map((e) => (e === hit ? foldFields(e, b, a) : e));
  }
  return [...out, ...claude.added.map((e) => structuredClone(e))];
}

/** A baseline read from disk, if it is whole; otherwise none, and "since you
 *  last read" falls back to the change log rather than failing to render. */
function validBaseline(raw: unknown): PlanBaseline | undefined {
  const b = raw as Partial<PlanBaseline> | null;
  const str = (v: unknown) => typeof v === 'string';
  const list = (v: unknown, ok: (x: Record<string, unknown>) => boolean) =>
    Array.isArray(v) && v.every((x) => x !== null && typeof x === 'object' && ok(x as Record<string, unknown>));
  const whole =
    b !== null &&
    typeof b === 'object' &&
    str(b.title) &&
    str(b.summary) &&
    list(b.sections, (x) => str(x['id']) && str(x['title']) && str(x['body'])) &&
    list(b.tasks, (x) => str(x['id']) && str(x['title']) && str(x['status']) && typeof x['order'] === 'number') &&
    list(
      b.diagrams,
      (x) =>
        str(x['id']) &&
        str(x['title']) &&
        list(x['nodes'], (n) => str(n['id']) && str(n['label']) && str(n['kind'])) &&
        list(x['edges'], (e) => str(e['source']) && str(e['target'])),
    );
  return whole ? (b as PlanBaseline) : undefined;
}

/** The plan's content, as Claude would compare it: no layout, no bookkeeping. */
export function baselineOf(plan: Plan): PlanBaseline {
  return structuredClone({
    title: plan.title,
    summary: plan.summary,
    sections: plan.sections.map(({ id, title, body }) => ({ id, title, body })),
    diagrams: plan.diagrams.map((d) => ({
      id: d.id,
      title: d.title,
      ...(d.caption ? { caption: d.caption } : {}),
      nodes: d.nodes.map(({ x: _x, y: _y, ...node }) => node),
      edges: d.edges,
    })),
    tasks: plan.tasks.map(({ id, parentId, order, title, detail, status, files, note, dependsOn, branch, review }) => ({
      id,
      parentId,
      order,
      title,
      status,
      ...(detail ? { detail } : {}),
      ...(files?.length ? { files } : {}),
      ...(note ? { note } : {}),
      ...(dependsOn?.length ? { dependsOn } : {}),
      ...(branch ? { branch } : {}),
      ...(review ? { review } : {}),
    })),
  });
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
  // A finished build is history: the next plan may replace it. Until then
  // the plan is what the user signed off, and only they can reopen it.
  const finished = Boolean(prev?.submission && planPhase(prev) === 'built');
  if (prev?.submission && !finished) throw new PlanError(LOCKED_FOR_CLAUDE);
  if (prev?.design && !finished) throw new PlanError(DESIGN_LOCKED_FOR_CLAUDE);
  refuseUnread(prev, 'publish again (or use harness_plan_edit for targeted changes)');
  const title = clean(input.title, MAX_TITLE);
  if (!title) throw new PlanError('A plan needs a title.');

  const base = prev ? structuredClone(prev) : emptyPlan(title, now);
  delete base.submission;
  delete base.design;
  delete base.report;
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

  const { tasks, builds } = buildTaskTree(base, next, input.tasks, now);

  const diagrams: Diagram[] = [];
  for (const raw of input.diagrams ?? []) {
    const old = base.diagrams.find((d) => d.id === raw.id);
    const id = old ? old.id : claimIdAmong(next, 'diagram', raw.id, diagrams);
    const dTitle = clean(raw.title, MAX_TITLE) ?? 'Diagram';
    const caption = clean(raw.caption, MAX_TEXT);
    const graph = buildGraph(raw.nodes ?? [], raw.edges ?? [], old, dTitle, new Set(tasks.map((t) => t.id)));
    const direction = validDirection(raw.direction) ?? old?.direction ?? suggestDirection(graph.nodes, graph.edges);
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
  linkBuilds(next, builds, now, false);
  checkDependencies(next);
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

/**
 * Replace the task tree and nothing else: the task list Claude makes from a
 * confirmed design. The design stays exactly as the user confirmed it; each
 * box keeps the tasks it links that survive, and gains those whose `builds`
 * names it. Allowed while planning, too, to rework the planned tasks.
 */
export function publishTasks(prev: Plan | null, input: TaskListInput, now = Date.now()): { plan: Plan; changes: Change[] } {
  if (!prev) throw new PlanError('There is no plan yet. Publish the design with harness_plan_publish first.');
  if (prev.submission && planPhase(prev) === 'built') {
    // New tasks on a finished build would start a build nobody submitted.
    throw new PlanError('This plan is built. Start the next one with harness_plan_publish; its tasks are confirmed and submitted afresh.');
  }
  if (prev.submission) throw new PlanError(LOCKED_FOR_CLAUDE);
  refuseUnread(prev, 'publish the task list again');
  if (!Array.isArray(input?.tasks) || input.tasks.length === 0) throw new PlanError('The task list needs at least one task.');

  const base = structuredClone(prev);
  const next: Plan = structuredClone(prev);
  const { tasks, builds } = buildTaskTree(base, next, input.tasks, now);
  next.tasks = tasks;
  const live = new Set(tasks.map((t) => t.id));
  for (const d of next.diagrams) {
    let touched = false;
    for (const n of d.nodes) {
      if (!n.taskIds) continue;
      const kept = n.taskIds.filter((id) => live.has(id));
      if (kept.length === n.taskIds.length) continue;
      touched = true;
      if (kept.length) n.taskIds = kept;
      else delete n.taskIds;
    }
    if (touched) bumpDiagram(d, now);
  }
  linkBuilds(next, builds, now);
  checkDependencies(next);
  next.threads = base.threads.map((thread) => detachIfOrphaned(next, base, thread));

  const leaves = tasks.filter((t) => !tasks.some((c) => c.parentId === t.id)).length;
  const change = record(next, 'claude', 'published', { kind: 'plan', id: '' }, `published the task list (${leaves} task${leaves === 1 ? '' : 's'})`, now);
  markReadByClaude(next, now);
  return { plan: next, changes: [change] };
}

/** A wholesale publish written without the user's unread edits would
 *  silently discard them, which is the one thing it must never do. */
function refuseUnread(prev: Plan | null, then: string): void {
  if (!prev || unreadByClaude(prev).length === 0) return;
  throw new PlanError(
    `The user has changed ${unreadItems(prev)} item(s) in the plan since you last read it. ` +
      `Call harness_plan_read first, then ${then} so their edits are not overwritten.`,
  );
}

/**
 * Build a task tree from what Claude wrote. Ids that survive keep their
 * status, detail, note, files and links; dependencies, branch and review
 * mode left out are kept too (the user may have set them), and `[]` or `""`
 * clears them. Dependencies may name any task by the id it was written with.
 */
function buildTaskTree(
  base: Plan,
  next: Plan,
  input: TaskInput[] | undefined,
  now: number,
): { tasks: Task[]; builds: { id: string; refs: string[] }[] } {
  const tasks: Task[] = [];
  const written = new Map<string, string>();
  const deps: { task: Task; explicit: boolean; ids: string[] }[] = [];
  const builds: { id: string; refs: string[] }[] = [];
  const walk = (list: TaskInput[] | undefined, parentId: string | null, depth: number) => {
    if (!Array.isArray(list)) return;
    if (depth > 12) throw new PlanError('The task tree is nested too deeply.');
    list.forEach((raw, order) => {
      if (tasks.length >= MAX_TASKS) throw new PlanError(`A plan holds at most ${MAX_TASKS} tasks.`);
      const tTitle = clean(raw?.title, MAX_TITLE);
      if (!tTitle) throw new PlanError('Every task needs a title.');
      const old = base.tasks.find((t) => t.id === raw.id);
      const id = old && !tasks.some((t) => t.id === old.id) ? old.id : claimIdAmong(next, 'task', raw.id, tasks);
      if (typeof raw.id === 'string' && raw.id.trim()) written.set(raw.id.trim(), id);
      // A task that survives keeps its status: progress is reported through
      // harness_task_update and its gates, never by publishing over it. Only
      // a new task says where it starts.
      const status = old ? old.status : (validStatus(raw.status) ?? 'todo');
      // Left out, a task's detail is kept — as a box's prose is — so a
      // republish to restructure the tree never wipes what was written.
      const detail = raw.detail === undefined ? old?.detail : clean(raw.detail, MAX_TEXT);
      const note = clean(raw.note, MAX_TITLE * 2) ?? old?.note;
      const files = cleanList(raw.files) ?? old?.files;
      const branch = raw.branch === undefined ? old?.branch : cleanBranch(raw.branch);
      const review = raw.review === undefined ? old?.review : reviewOrThrow(raw.review, tTitle);
      const task: Task = {
        id,
        parentId,
        order,
        title: tTitle,
        ...(detail ? { detail } : {}),
        status,
        ...(files?.length ? { files } : {}),
        ...(note ? { note } : {}),
        ...(branch ? { branch } : {}),
        ...(review ? { review } : {}),
        ...(old?.stage && status === 'in_progress' ? { stage: old.stage } : {}),
        ...(old?.round ? { round: old.round } : {}),
        ...(old?.checks?.length ? { checks: old.checks } : {}),
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        createdBy: old?.createdBy ?? 'claude',
      };
      tasks.push(task);
      const explicit = raw.dependsOn !== undefined;
      deps.push({ task, explicit, ids: explicit ? (cleanList(raw.dependsOn) ?? []) : (old?.dependsOn ?? []) });
      const refs = cleanList(raw.builds);
      // Restated (even as []), it says which boxes the task builds now.
      if (raw.builds !== undefined) builds.push({ id, refs: refs ?? [] });
      walk(raw.subtasks, id, depth + 1);
    });
  };
  walk(input, null, 0);

  // Dependencies are resolved once every task has its id, so a task can
  // name one written after it.
  const kept = new Set(tasks.map((t) => t.id));
  for (const { task, explicit, ids } of deps) {
    const resolved: string[] = [];
    for (const raw of ids) {
      const id = written.get(raw) ?? (kept.has(raw) ? raw : undefined);
      if (!id) {
        // Carried over from before this publish: the task it named is gone.
        if (!explicit) continue;
        throw new PlanError(`"${task.title}" depends on "${raw}", which is not a task in this plan. Give the task it means that id.`);
      }
      if (!resolved.includes(id)) resolved.push(id);
    }
    if (resolved.length) task.dependsOn = resolved;
  }
  // A task whose content Claude changed moves to a new revision, so an
  // editor the user has open on it notices.
  for (const task of tasks) {
    const old = base.tasks.find((t) => t.id === task.id);
    if (!old) continue;
    if (old.rev !== undefined) task.rev = old.rev;
    if (old.revBy) task.revBy = { ...old.revBy };
    if (taskContent(old) !== taskContent(task)) {
      task.rev = (old.rev ?? 1) + 1;
      task.revBy = { ...old.revBy, claude: task.rev };
    }
  }
  return { tasks, builds };
}

/**
 * Link tasks to the boxes their `builds` names: a node id, or
 * `diagramId/nodeId` when the same id is in several diagrams.
 */
function linkBuilds(
  plan: Plan,
  builds: { id: string; refs: string[] }[],
  now: number,
  /** `builds` says which boxes the task builds now, so a box it no longer
   *  names loses the link. Off when the diagrams themselves declare links
   *  too (a whole publish), so the two add up. */
  replace = true,
): { linked: Part[]; unlinked: Part[] } {
  const linked: Part[] = [];
  const unlinked: Part[] = [];
  for (const { id, refs } of builds) {
    const title = plan.tasks.find((t) => t.id === id)?.title ?? id;
    const want = new Set(refs.map((ref) => {
      const { diagram, node } = findBox(plan, ref, title);
      return `${diagram.id}/${node.id}`;
    }));
    for (const diagram of plan.diagrams) {
      let touched = false;
      for (const node of diagram.nodes) {
        const has = node.taskIds?.includes(id) ?? false;
        const wanted = want.has(`${diagram.id}/${node.id}`);
        if (wanted && !has) {
          node.taskIds = [...(node.taskIds ?? []), id];
          linked.push({ diagram, node });
          touched = true;
        } else if (!wanted && has && replace) {
          const kept = node.taskIds!.filter((x) => x !== id);
          if (kept.length) node.taskIds = kept;
          else delete node.taskIds;
          unlinked.push({ diagram, node });
          touched = true;
        }
      }
      // A canvas holding the old links must reload rather than save over
      // them — but only when a link actually changed.
      if (touched) bumpDiagram(diagram, now);
    }
  }
  return { linked, unlinked };
}

type Part = { diagram: Diagram; node: DiagramNode };

/** A task's `builds` changed which boxes it is linked to: logged per
 *  diagram, as the canvas logs a link made by hand. */
function logLinks(
  { linked, unlinked }: { linked: Part[]; unlinked: Part[] },
  task: Task,
  author: Author,
  log: (kind: ChangeKind, target: Target, summary: string) => Change,
): Change[] {
  const out: Change[] = [];
  for (const diagram of new Set([...linked, ...unlinked].map((l) => l.diagram))) {
    const names = (list: Part[]) => list.filter((l) => l.diagram === diagram).map((l) => `"${l.node.label}"`);
    const facts = [
      names(linked).length ? `linked "${task.title}" to ${names(linked).join(', ')}` : '',
      names(unlinked).length ? `unlinked it from ${names(unlinked).join(', ')}` : '',
    ].filter(Boolean);
    diagram.updatedBy = author;
    out.push(log('edited', ref('diagram', diagram.id), `${facts.join(' and ')} in diagram "${diagram.title}"`.replace(/^unlinked it/, `unlinked "${task.title}"`)));
  }
  return out;
}

function findBox(plan: Plan, ref: string, title: string): { diagram: Diagram; node: DiagramNode } {
  const slash = ref.indexOf('/');
  if (slash > 0) {
    const diagram = plan.diagrams.find((d) => d.id === ref.slice(0, slash));
    const node = diagram?.nodes.find((n) => n.id === ref.slice(slash + 1));
    if (diagram && node) return { diagram, node };
    throw new PlanError(`"${title}" builds "${ref}", but there is no such box. Use "diagramId/nodeId" with ids from the plan.`);
  }
  const hits = plan.diagrams.flatMap((diagram) => diagram.nodes.filter((n) => n.id === ref).map((node) => ({ diagram, node })));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new PlanError(`"${title}" builds "${ref}", but no box has that id.`);
  throw new PlanError(
    `"${title}" builds "${ref}", which is a box in ${hits.length} diagrams — write it as ${hits.map((h) => `"${h.diagram.id}/${ref}"`).join(' or ')}.`,
  );
}

/** A diagram's links changed under it: a canvas editing it must reload. */
function bumpDiagram(d: Diagram, now: number): void {
  d.rev += 1;
  d.updatedAt = now;
}

function checkDependencies(plan: Plan): void {
  const problem = dependencyProblem(plan);
  if (problem) throw new PlanError(problem);
}

function cleanBranch(value: unknown): string | undefined {
  const name = clean(value, 120)?.replace(/\s+/g, '-');
  if (!name) return undefined;
  // What git refuses, refused here, rather than discovered at checkout.
  if (/[~^:?*[\\\x00-\x20\x7f]|\.\.|@\{|^[-/.]|[/.]$|\/\/|\.lock$/.test(name)) {
    throw new PlanError(`"${name}" is not a usable git branch name.`);
  }
  return name;
}

function reviewOrThrow(value: unknown, title: string) {
  if (value === undefined || value === '' || value === null) return undefined;
  const review = validReview(value);
  if (!review) throw new PlanError(`"${title}": review must be one of subagent, self, user or skip.`);
  return review;
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
    tasks: list<Task>(raw.tasks).map(normalizeTask),
    threads: list<Thread>(raw.threads).map((t) => ({ ...t, replies: list(t.replies) })),
    changes: list<Change>(raw.changes),
    seq: typeof raw.seq === 'number' ? raw.seq : 0,
    version: typeof raw.version === 'number' ? raw.version : typeof raw.seq === 'number' ? raw.seq : 0,
    claudeReadSeq: typeof raw.claudeReadSeq === 'number' ? raw.claudeReadSeq : 0,
    claudeReadAt: typeof raw.claudeReadAt === 'number' ? raw.claudeReadAt : null,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
  };
  const baseline = validBaseline(raw.claudeBaseline);
  if (baseline) plan.claudeBaseline = baseline;
  else delete plan.claudeBaseline;
  // A damaged submission unlocks the plan rather than locking it for good.
  const submission = validSubmission(raw.submission);
  if (submission) plan.submission = submission;
  else delete plan.submission;
  const design = validDesign(raw.design);
  if (design) plan.design = design;
  else delete plan.design;
  const report = raw.report as { text?: unknown; at?: unknown } | undefined;
  if (report && typeof report.text === 'string' && report.text && typeof report.at === 'number') plan.report = { text: report.text, at: report.at };
  else delete plan.report;
  return plan;
}

/** A task's build fields as read from disk: anything malformed is dropped,
 *  never allowed to break the dependency graph or the board. */
function normalizeTask(task: Task): Task {
  const t = { ...task } as Task & Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
  const deps = strings(t.dependsOn);
  if (deps.length) t.dependsOn = deps;
  else delete t.dependsOn;
  if (typeof t.branch !== 'string' || !t.branch) delete t.branch;
  if (!validReview(t.review)) delete t.review;
  if (!validStage(t.stage)) delete t.stage;
  if (typeof t.round !== 'number' || !(t.round > 0)) delete t.round;
  const checks = cleanChecks(t.checks);
  if (checks?.length) t.checks = checks;
  else delete t.checks;
  return t;
}

/* ------------------------------------------------------------------ *
 * Targeted edits
 * ------------------------------------------------------------------ */

/**
 * Apply a batch of ops to a copy of `plan`. All or nothing: the first op that
 * cannot apply throws, and the caller keeps the plan it had.
 */
/**
 * The fields each edit takes. Claude's edits are checked against it, so a
 * misspelt field (`depends_on`) is refused with the right names instead of
 * being ignored — an ignored field reads as "Nothing changed", which is
 * worse than an error. The MCP tool schema is checked against this table
 * in the tests.
 */
export const OP_FIELDS: { readonly [K in PlanOpName]: readonly Exclude<keyof Extract<PlanOp, { op: K }>, 'op'>[] } = {
  set_meta: ['title', 'summary'],
  upsert_section: ['id', 'title', 'body', 'index', 'expect'],
  upsert_diagram: ['id', 'title', 'nodes', 'edges', 'direction', 'caption', 'index', 'expect'],
  upsert_task: [
    'id',
    'parentId',
    'index',
    'title',
    'detail',
    'status',
    'files',
    'note',
    'dependsOn',
    'branch',
    'review',
    'stage',
    'checks',
    'builds',
    'expect',
  ],
  move_task: ['id', 'parentId', 'index'],
  move_section: ['id', 'index'],
  move_diagram: ['id', 'index'],
  upsert_node: ['diagramId', 'id', 'label', 'kind', 'detail', 'description', 'notes', 'taskIds', 'expect'],
  remove_node: ['diagramId', 'id', 'expect'],
  upsert_edge: ['diagramId', 'id', 'from', 'to', 'label', 'dashed', 'arrows', 'expect'],
  remove_edge: ['diagramId', 'id', 'from', 'to', 'expect'],
  remove: ['kind', 'id'],
  comment: ['target', 'text'],
  reply: ['threadId', 'text'],
  resolve: ['threadId', 'resolved'],
  report: ['text'],
};

/** Refuses an edit Claude sent with a field its op does not take. */
function checkOpFields(op: unknown): void {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw new PlanError('Each edit is an object with an "op" field.');
  const name = (op as { op?: unknown }).op;
  const fields = typeof name === 'string' ? (OP_FIELDS as Record<string, readonly string[]>)[name] : undefined;
  if (!fields) throw new PlanError(`Unknown edit ${JSON.stringify(name)}: use one of ${Object.keys(OP_FIELDS).join(', ')}.`);
  const unknown = Object.keys(op).filter((k) => k !== 'op' && !fields.includes(k));
  if (unknown.length) {
    throw new PlanError(
      `${name} does not take ${unknown.map((k) => `"${k}"`).join(', ')}: its fields are ${fields.join(', ')}. Nothing was changed.`,
    );
  }
}

/**
 * The items whose content the user changed since Claude last read the
 * plan, as `kind:id` — by the net effect, so edits that cancel out do not
 * count. Comments, task progress and positions are not content: Claude
 * acting on a comment it has not read yet loses nothing of the user's.
 */
function unreadContent(plan: Plan): Set<string> {
  const touched = new Set(
    unreadByClaude(plan)
      .filter((c) => c.kind === 'created' || c.kind === 'edited' || c.kind === 'deleted' || c.kind === 'published')
      .map((c) => `${c.target.kind}:${c.target.id}`),
  );
  const base = plan.claudeBaseline;
  if (!base || touched.size === 0) return touched;
  const now = baselineOf(plan);
  const content = (b: PlanBaseline, kind: string, id: string): string => {
    switch (kind) {
      case 'plan':
        return canonical({ title: b.title, summary: b.summary });
      case 'section':
        return canonical(b.sections.find((s) => s.id === id) ?? null);
      case 'diagram':
        return canonical(b.diagrams.find((d) => d.id === id) ?? null);
      case 'task': {
        const t = b.tasks.find((x) => x.id === id);
        return canonical(t ? { ...t, status: undefined, order: undefined, parentId: undefined } : null);
      }
      default:
        return '';
    }
  };
  return new Set(
    [...touched].filter((key) => {
      const at = key.indexOf(':');
      const [kind, id] = [key.slice(0, at), key.slice(at + 1)];
      return content(base, kind, id) !== content(now, kind, id);
    }),
  );
}

/** What an edit of Claude's would overwrite, as `kind:id` — or null when
 *  it only tracks progress, moves something, or talks in a thread. */
function contentTargetOf(op: PlanOp): string | null {
  const has = (...keys: string[]) => keys.some((k) => (op as unknown as Record<string, unknown>)[k] !== undefined);
  switch (op.op) {
    case 'set_meta':
      return 'plan:';
    case 'upsert_section':
      return op.id && has('title', 'body') ? `section:${op.id}` : null;
    case 'upsert_diagram':
      return op.id && has('title', 'nodes', 'edges', 'direction', 'caption') ? `diagram:${op.id}` : null;
    case 'upsert_node':
    case 'remove_node':
    case 'upsert_edge':
    case 'remove_edge':
      return `diagram:${op.diagramId}`;
    case 'upsert_task':
      // A note with a status is a progress report (harness_task_update).
      return op.id && (has('title', 'detail', 'files', 'dependsOn', 'branch', 'review') || (has('note') && !has('status', 'stage')))
        ? `task:${op.id}`
        : null;
    case 'remove':
      return `${op.kind}:${op.id}`;
    default:
      return null;
  }
}

/**
 * Claude's edit to an item the user has changed since Claude last read the
 * plan is refused, as a publish is: Claude would be writing over a version
 * it has not seen, and a diagram's node list replaces the boxes the user
 * just added. Reading the plan clears it.
 */
function refuseUnreadEdit(plan: Plan, op: PlanOp, unread: Set<string>): void {
  const target = contentTargetOf(op);
  if (!target || !unread.has(target)) return;
  const [kind, id] = target.split(':') as [Target['kind'], string];
  throw new PlanError(
    `The user changed ${describeTarget(plan, { kind, id })} since you last read the plan, so this edit was not applied — ` +
      'it could undo theirs. Call harness_plan_read to see their version, then make the edit on top of it.',
  );
}

type PartOp = Extract<PlanOp, { op: 'upsert_node' | 'remove_node' | 'upsert_edge' | 'remove_edge' }>;

/**
 * A diagram's boxes and arrows with one part changed. Untouched parts are
 * restated by id alone: upsert_diagram keeps everything a part had that an
 * edit leaves out, so nothing the user wrote on them is restated — or lost.
 */
function partEdit(d: Diagram, op: PartOp): { nodes: DiagramNodeInput[]; edges: DiagramEdgeInput[] } {
  const nodes: DiagramNodeInput[] = d.nodes.map((n) => ({ id: n.id }));
  const edges: DiagramEdgeInput[] = d.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
  const given = <K extends string>(keys: readonly K[]) =>
    Object.fromEntries(keys.filter((k) => (op as Record<string, unknown>)[k] !== undefined).map((k) => [k, (op as Record<string, unknown>)[k]]));
  switch (op.op) {
    case 'upsert_node': {
      const fields = given(['label', 'kind', 'detail', 'description', 'notes', 'taskIds'] as const);
      const at = nodes.findIndex((n) => n.id === op.id);
      if (at >= 0) nodes[at] = { id: op.id, ...fields };
      else if (!clean(op.label, 120)) throw new PlanError(`No box "${op.id}" in "${d.title}" to change; to add it, give it a label.`);
      else nodes.push({ id: op.id, ...fields });
      return { nodes, edges };
    }
    case 'remove_node': {
      if (!d.nodes.some((n) => n.id === op.id)) throw new PlanError(`No box "${op.id}" in "${d.title}".`);
      return { nodes: nodes.filter((n) => n.id !== op.id), edges: edges.filter((e) => e.source !== op.id && e.target !== op.id) };
    }
    case 'upsert_edge': {
      const style = given(['label', 'dashed', 'arrows'] as const);
      const at = op.id ? edges.findIndex((e) => e.id === op.id) : -1;
      if (at >= 0) {
        // From the arrow as it is, style and all: moved to another box it no
        // longer pairs with its old self, and would otherwise lose its label.
        const real = d.edges.find((e) => e.id === op.id)!;
        const was: DiagramEdgeInput = { id: real.id, source: real.source, target: real.target, ...(real.label ? { label: real.label } : {}), ...(real.dashed ? { dashed: true } : {}), ...(real.arrows ? { arrows: real.arrows } : {}) };
        edges[at] = { ...was, ...(op.from ? { source: op.from } : {}), ...(op.to ? { target: op.to } : {}), ...style };
      } else {
        if (!op.from || !op.to) {
          throw new PlanError(op.id ? `No arrow "${op.id}" in "${d.title}"; to add one, give from and to.` : 'A new arrow needs from and to (box ids).');
        }
        edges.push({ ...(op.id ? { id: op.id } : {}), source: op.from, target: op.to, ...style });
      }
      return { nodes, edges };
    }
    case 'remove_edge': {
      const id = arrowId(d, op);
      return { nodes, edges: edges.filter((e) => e.id !== id) };
    }
  }
}

/**
 * The arrow an op names: by id (`source->target` unless the read shows
 * another), or by its ends when only one arrow joins them that way.
 */
function arrowId(d: Diagram, op: { id?: string; from?: string; to?: string }): string {
  if (op.id) {
    if (!d.edges.some((e) => e.id === op.id)) throw new PlanError(`No arrow "${op.id}" in "${d.title}". An arrow's id is from->to unless the read shows another.`);
    return op.id;
  }
  const between = d.edges.filter((e) => e.source === op.from && e.target === op.to);
  if (between.length === 1) return between[0]!.id;
  throw new PlanError(
    between.length
      ? `${between.length} arrows run ${op.from} → ${op.to} in "${d.title}": name one by id (${between.map((e) => e.id).join(', ')}).`
      : `No arrow ${op.from ?? '?'} → ${op.to ?? '?'} in "${d.title}".`,
  );
}

/**
 * A box or arrow op's `expect` is the diagram's rev as the caller read it —
 * before this batch. Each such op is its own diagram edit and moves the
 * rev, so it is checked here, against the plan the batch started from, and
 * not again as the batch goes on: several ops on one diagram, each with the
 * rev that was read, go through together.
 */
function expectAtStart(plan: Plan, op: PlanOp, author: Author): PlanOp {
  if (!op || typeof op !== 'object') return op;
  if (op.op !== 'upsert_node' && op.op !== 'remove_node' && op.op !== 'upsert_edge' && op.op !== 'remove_edge') return op;
  if (op.expect === undefined) return op;
  const d = plan.diagrams.find((x) => x.id === op.diagramId);
  if (d) checkRev(d, op.expect, 'diagram', author);
  const { expect: _checked, ...rest } = op;
  return rest as PlanOp;
}

/** The fields of upsert_task that report progress rather than say what
 *  the task is. Claude reports them only through harness_task_update. */
export const PROGRESS_FIELDS = ['status', 'stage', 'checks'] as const;

/**
 * Claude's progress goes through harness_task_update, which refuses what
 * would make the board untrue — starting a task that still waits, finishing
 * one whose checks fail or that was never reviewed. An upsert_task carrying
 * a status would walk straight past those gates.
 */
function refuseProgress(op: PlanOp): void {
  if (op.op !== 'upsert_task') return;
  const given = PROGRESS_FIELDS.filter((k) => op[k] !== undefined);
  if (!given.length) return;
  throw new PlanError(
    `upsert_task does not set ${given.join(', ')}: report progress with harness_task_update {task_id, status, stage, checks, note}, ` +
      'which checks what the task waits on and how its checks came out. A new task starts as todo.',
  );
}

export function applyOps(
  plan: Plan,
  ops: PlanOp[],
  author: Author,
  now = Date.now(),
  /** `tracking`: Claude's progress report, already through harness_task_update's gates. */
  opts: { tracking?: boolean } = {},
): { plan: Plan; changes: Change[] } {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new PlanError('No edits were given: pass them as {ops: [{op: "upsert_task", id: "t3", note: "…"}, …]}.');
  }
  if (plan.submission) checkLocked(ops, author);
  else if (plan.design) checkDesignLocked(ops, author);
  const next = structuredClone(plan);
  const changes: Change[] = [];
  const unread = author === 'claude' ? unreadContent(plan) : null;
  ops.forEach((op, i) => {
    try {
      if (author === 'claude') {
        checkOpFields(op);
        if (!opts.tracking) refuseProgress(op);
        refuseUnreadEdit(plan, op, unread!);
      }
      changes.push(...applyOne(next, expectAtStart(plan, op, author), author, now));
    } catch (err) {
      if (err instanceof PlanError && ops.length > 1) {
        throw new PlanError(`Edit ${i + 1} (${(op as { op?: string })?.op ?? '?'}): ${err.message}`);
      }
      throw err;
    }
  });
  // Dependencies are checked on the batch as a whole, so a task and the one
  // it waits on can be added together in either order. A problem the plan
  // already had (written by an older build) does not block unrelated edits.
  if (ops.some((op) => TASK_SHAPE_OPS.has((op as { op?: string })?.op ?? '') || (op as { kind?: string })?.kind === 'task')) {
    const problem = dependencyProblem(next);
    if (problem && problem !== dependencyProblem(plan)) throw new PlanError(problem);
  }
  // A comment on a box or an arrow an edit took away is kept, on the plan,
  // saying what it was about — as for any removed item.
  next.threads = next.threads.map((t) => (t.target.kind === 'node' || t.target.kind === 'edge' ? detachIfOrphaned(next, plan, t) : t));
  if (author === 'claude') {
    if (next.claudeBaseline && unreadByClaude(next).length > 0) {
      next.claudeBaseline = foldClaudeEdit(next.claudeBaseline, baselineOf(plan), baselineOf(next));
    }
    settleClaudeRead(next);
  }
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
        out.push(log('edited', { kind: 'plan', id: '' }, `${RENAMED_PLAN} to "${title}"`));
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
        const at = plan.sections.indexOf(existing);
        if (typeof op.index === 'number') moveInList(plan.sections, existing.id, op.index);
        // A reorder alone is still a change: logged, so the version moves
        // and a preview made before it is refused.
        if (!changed) {
          return plan.sections.indexOf(existing) !== at ? [log('moved', ref('section', existing.id), `reordered section "${existing.title}"`)] : [];
        }
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
        const at = plan.diagrams.indexOf(existing);
        if (typeof op.index === 'number') moveInList(plan.diagrams, existing.id, op.index);
        // A confirmed design can still be laid out, and its boxes linked to
        // the tasks that build them — but not redesigned.
        if (plan.design && designWithoutLinks(before) !== designWithoutLinks(existing)) {
          throw new PlanError(author === 'user' ? DESIGN_LOCKED_FOR_USER : DESIGN_LOCKED_FOR_CLAUDE);
        }
        const what = describeDiagramEdit(before, existing);
        const relaid = layoutChanged(before, existing);
        if (!what && !relaid) {
          // A reorder alone is still a change, as for sections.
          return plan.diagrams.indexOf(existing) !== at ? [log('moved', ref('diagram', existing.id), `reordered diagram "${existing.title}"`)] : [];
        }
        existing.rev += 1;
        existing.updatedAt = now;
        // Dragging boxes around, or flipping which way the diagram is drawn,
        // is presentation, not design. It is saved — and moves the revision,
        // so a stale editor is still refused, and the plan's version, so a
        // page can tell it from the save before — but it is not a change
        // anyone needs to read about.
        if (!what) {
          plan.version += 1;
          plan.updatedAt = now;
          return [];
        }
        existing.updatedBy = author;
        const summary = what === EDITED_DESIGN ? `edited diagram "${existing.title}"` : `${what} in diagram "${existing.title}"`;
        return [log('edited', ref('diagram', existing.id), summary)];
      }
      if (op.id) throw new PlanError(`No diagram "${op.id}".`);
      if (plan.diagrams.length >= MAX_DIAGRAMS) throw new PlanError(`A plan holds at most ${MAX_DIAGRAMS} diagrams.`);
      const title = clean(op.title, MAX_TITLE) ?? 'Diagram';
      const caption = clean(op.caption, MAX_TEXT);
      const graph = buildGraph(op.nodes ?? [], op.edges ?? [], undefined, title, taskIdSet(plan));
      const diagram: Diagram = {
        id: claimId(plan, 'diagram', undefined),
        title,
        rev: 1,
        ...graph,
        direction: validDirection(op.direction) ?? suggestDirection(graph.nodes, graph.edges),
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
      const dependsOn = cleanList(op.dependsOn);
      const branch = cleanBranch(op.branch);
      const review = reviewOrThrow(op.review, title);
      const stage = op.stage === undefined ? undefined : stageOrThrow(op.stage);
      const checks = cleanChecks(op.checks);
      const status = validStatus(op.status) ?? (stage ? 'in_progress' : 'todo');
      const task: Task = {
        id: claimId(plan, 'task', op.id),
        parentId,
        order: Number.MAX_SAFE_INTEGER,
        title,
        ...(detail ? { detail } : {}),
        status,
        ...(files?.length ? { files } : {}),
        ...(note ? { note } : {}),
        ...(dependsOn?.length ? { dependsOn: [...new Set(dependsOn)] } : {}),
        ...(branch ? { branch } : {}),
        ...(review ? { review } : {}),
        ...(stage && status === 'in_progress' ? { stage, ...(stage === 'review' ? { round: 1 } : {}) } : {}),
        ...(checks?.length ? { checks } : {}),
        createdAt: now,
        updatedAt: now,
        createdBy: author,
      };
      plan.tasks.push(task);
      placeAmongSiblings(plan, task, op.index);
      const where = parentId ? ` under "${requireTask(plan, parentId).title}"` : '';
      const created = log('created', ref('task', task.id), `added task "${title}"${where}`);
      const linked = op.builds?.length ? linkBuilds(plan, [{ id: task.id, refs: cleanList(op.builds) ?? [] }], now) : { linked: [], unlinked: [] };
      return [created, ...logLinks(linked, task, author, log)];
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

    // One box or arrow at a time. Each is the diagram's current boxes and
    // arrows with that one change, applied as upsert_diagram — so it is
    // checked, locked and logged exactly as a whole-diagram edit is, and
    // nothing else in the diagram is restated (or lost).
    case 'upsert_node':
    case 'remove_node':
    case 'upsert_edge':
    case 'remove_edge': {
      const d = plan.diagrams.find((x) => x.id === op.diagramId);
      if (!d) throw new PlanError(`No diagram "${op.diagramId}". The read lists each diagram's id.`);
      const { nodes, edges } = partEdit(d, op);
      return applyOne(plan, { op: 'upsert_diagram', id: d.id, nodes, edges, ...(op.expect !== undefined ? { expect: op.expect } : {}) }, author, now);
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

    case 'report': {
      const text = clean(op.text, MAX_TEXT);
      if (!text) throw new PlanError('A report needs text.');
      if (plan.report?.text === text) return [];
      plan.report = { text, at: now };
      return [log('edited', { kind: 'plan', id: '' }, 'wrote the build report')];
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
  checkTaskRev(task, op.expect, author);
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
    const files = cleanList(op.files);
    if ((files ?? []).join('\n') !== (task.files ?? []).join('\n')) {
      setOptional(task, 'files', files?.length ? files : undefined);
      edited.push('files');
    }
  }
  if (typeof op.note === 'string') {
    const note = clean(op.note, MAX_TITLE * 2);
    if (note !== task.note) {
      setOptional(task, 'note', note);
      if (!op.status && !op.stage) edited.push('note');
    }
  }
  if (Array.isArray(op.dependsOn)) {
    // Checked with the whole batch, so a dependency can be added with it.
    const deps = [...new Set(cleanList(op.dependsOn) ?? [])];
    if (deps.join() !== (task.dependsOn ?? []).join()) {
      setOptional(task, 'dependsOn', deps.length ? deps : undefined);
      edited.push('dependencies');
    }
  }
  if (typeof op.branch === 'string') {
    const branch = cleanBranch(op.branch);
    if (branch !== task.branch) {
      setOptional(task, 'branch', branch);
      edited.push('branch');
    }
  }
  if (op.review !== undefined) {
    const review = reviewOrThrow(op.review, task.title);
    if (review !== task.review) {
      setOptional(task, 'review', review);
      edited.push('review');
    }
  }

  // Moving to a stage of the cycle means the task is being worked on.
  const stage = op.stage === undefined ? undefined : stageOrThrow(op.stage);
  const wanted = op.status ?? (stage && task.status !== 'in_progress' ? 'in_progress' : undefined);
  if (wanted !== undefined) {
    const status = validStatus(wanted);
    if (!status) throw new PlanError(`"${wanted}" is not a task status (${TASK_STATUSES.join(', ')}).`);
    if (status !== task.status) {
      task.status = status;
      task.updatedAt = now;
      const note = task.note && typeof op.note === 'string' ? ` — ${short(task.note, 80)}` : '';
      out.push(log('status', ref('task', task.id), `marked "${task.title}" ${STATUS_WORDS[status]}${note}`));
    }
    // Finished, or back in the pile: no longer anywhere in the cycle.
    if (status === 'done' || status === 'todo') delete task.stage;
    // Put back in the pile by the user, it starts its cycle over: the rounds
    // and checks of the work it had are not this work's. Claude cannot do
    // that to itself — it would be a way round the round limit.
    if (status === 'todo' && author === 'user') {
      delete task.round;
      delete task.checks;
    }
  }
  const progress: string[] = [];
  // Going into review is a round. Reporting review again while in it —
  // with the review checks, say — is the same round.
  if (stage && task.status !== 'done' && task.status !== 'todo' && stage !== task.stage) {
    task.stage = stage;
    if (stage === 'review') task.round = (task.round ?? 0) + 1;
    progress.push(stage === 'review' ? `in review (round ${task.round})` : STAGE_WORDS[stage]);
  }
  const checks = op.checks === undefined ? undefined : cleanChecks(op.checks);
  if (checks) {
    // Merged by name: a refine that re-runs only the typecheck must not
    // erase the test failure the review found.
    if (checks.length) task.checks = mergeChecks(task.checks, checks);
    else delete task.checks;
    if (checks.length) progress.push(`checks ${checks.map((c) => `${c.name} ${c.ok ? '✓' : '✗'}`).join(', ')}`);
  }
  if (progress.length) {
    task.updatedAt = now;
    out.push(log('status', ref('task', task.id), `"${task.title}": ${progress.join('; ')}`));
  }

  if (edited.length) {
    task.updatedAt = now;
    task.rev = (task.rev ?? 1) + 1;
    task.revBy = { ...task.revBy, [author]: task.rev };
    out.push(log('edited', ref('task', task.id), `edited the ${edited.join(', ')} of "${task.title}"`));
  }
  // Given, builds says which boxes the task builds now ([] unlinks it).
  if (op.builds !== undefined) out.push(...logLinks(linkBuilds(plan, [{ id: task.id, refs: cleanList(op.builds) ?? [] }], now), task, author, log));
  if (typeof op.index === 'number') placeAmongSiblings(plan, task, op.index);
  return out;
}

const STAGE_WORDS: Record<IricStage, string> = {
  implement: 'implementing',
  review: 'in review',
  refine: 'refining after review',
};

export function validStage(value: unknown): IricStage | undefined {
  return (IRIC_STAGES as readonly string[]).includes(value as string) ? (value as IricStage) : undefined;
}

function stageOrThrow(value: unknown): IricStage {
  const stage = validStage(value);
  if (!stage) throw new PlanError(`"${String(value)}" is not a stage (${IRIC_STAGES.join(', ')}).`);
  return stage;
}

/** Check results as reported: each with a name, at most a few dozen. */
export function cleanChecks(value: unknown): CheckResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CheckResult[] = [];
  for (const raw of value.slice(0, 40)) {
    const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = clean(rec['name'], 80);
    if (!name || typeof rec['ok'] !== 'boolean') continue;
    const note = clean(rec['note'], 300);
    out.push({ name, ok: rec['ok'], ...(note ? { note } : {}) });
  }
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
      // Nothing waits on work that is no longer in the plan.
      for (const other of plan.tasks) {
        if (!other.dependsOn?.some((id) => doomed.has(id))) continue;
        const kept = other.dependsOn.filter((id) => !doomed.has(id));
        if (kept.length) other.dependsOn = kept;
        else delete other.dependsOn;
      }
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
      throw new PlanError(
        kind === 'node' || kind === 'edge'
          ? 'remove takes a section, diagram or task: remove a box with remove_node {diagramId, id} (its arrows go ' +
              'with it), an arrow with remove_edge {diagramId, id} or {diagramId, from, to}.'
          : `Cannot remove a "${kind}": remove takes kind section, diagram or task.`,
      );
  }
  plan.threads = plan.threads.map((t) => detachIfOrphaned(plan, before, t));
  return [log('deleted', { kind: kind as Target['kind'], id }, summary)];
}

/* ------------------------------------------------------------------ *
 * Submitting the plan
 * ------------------------------------------------------------------ */

/** The longest note the user can hand Claude with a submission. */
export const MAX_NOTE = 4_000;

/** What Claude may still do to a locked plan: track the work it is doing,
 *  and answer comments. Everything else is the design the user signed off. */
const TRACKING_OPS: ReadonlySet<string> = new Set(['upsert_task', 'comment', 'reply', 'resolve', 'report']);

/** Ops that can change which task waits on which. */
const TASK_SHAPE_OPS: ReadonlySet<string> = new Set(['upsert_task', 'move_task']);

const LOCKED_FOR_USER = 'The plan has been submitted to be built, so it is locked. Reopen it to make changes.';
const LOCKED_FOR_CLAUDE =
  'The user has submitted this plan to be built, so it is locked: only task updates (harness_task_update, or ' +
  'upsert_task to add work you discover), comments (comment, reply, resolve) and the build report apply. If the ' +
  'design has to change, ask the user in chat — they can reopen the plan in Coplan.';
const DESIGN_LOCKED_FOR_USER =
  'The design is confirmed, so the architecture, sections and summary are locked — only the tasks, the boxes they ' +
  'build and comments change now. Reopen the design to change it.';
const DESIGN_LOCKED_FOR_CLAUDE =
  'The user has confirmed the design, so the architecture, sections and summary are locked. Build the task list ' +
  'from it: harness_tasks_publish, or upsert_task / move_task / remove with harness_plan_edit (a task\'s `builds` ' +
  'links it to boxes). If the design itself has to change, ask the user in chat — they can reopen the design in Coplan.';

/** What a confirmed design still lets anyone do: work on the tasks, link
 *  them to boxes (checked inside upsert_diagram), and talk about it. */
const TASKING_OPS: ReadonlySet<string> = new Set(['upsert_task', 'move_task', 'upsert_diagram', 'upsert_node', 'comment', 'reply', 'resolve', 'report']);

/** Where the plan is in its life. */
export function planPhase(plan: Pick<Plan, 'submission' | 'tasks' | 'design'> | null): PlanPhase {
  const submission = plan?.submission;
  if (!submission) return plan?.design ? 'tasking' : 'planning';
  if (submission.target === 'elsewhere') return 'handed-off';
  if (!submission.deliveredAt) return 'submitted';
  const counts = countTasks(plan);
  return counts.total > 0 && counts.done === counts.total ? 'built' : 'building';
}

/** Whether the plan is locked against editing. */
export function isLocked(plan: Pick<Plan, 'submission'> | null): boolean {
  return Boolean(plan?.submission);
}

/** Whether the design — diagrams, sections, summary — is locked: confirmed,
 *  or submitted. */
export function isDesignLocked(plan: Pick<Plan, 'submission' | 'design'> | null): boolean {
  return Boolean(plan?.design || plan?.submission);
}

function checkLocked(ops: PlanOp[], author: Author): void {
  if (author === 'user') throw new PlanError(LOCKED_FOR_USER);
  const refused = ops.find((op) => !TRACKING_OPS.has((op as { op?: string })?.op ?? ''));
  if (refused) throw new PlanError(`${LOCKED_FOR_CLAUDE} (Refused: ${(refused as { op?: string })?.op ?? 'an edit'}.)`);
}

function checkDesignLocked(ops: PlanOp[], author: Author): void {
  const refused = ops.find((raw) => {
    const op = raw as { op?: string; kind?: string; id?: string; summary?: unknown; title?: unknown };
    if (op.op === 'remove') return op.kind !== 'task';
    // The title names the plan; the summary is part of its design.
    if (op.op === 'set_meta') return op.summary !== undefined;
    // Moving a diagram is part of how the design reads, like move_diagram.
    if (op.op === 'upsert_diagram') return !op.id || typeof (raw as { index?: unknown }).index === 'number';
    return !TASKING_OPS.has(op.op ?? '');
  });
  if (!refused) return;
  const name = (refused as { op?: string })?.op ?? 'an edit';
  throw new PlanError(author === 'user' ? DESIGN_LOCKED_FOR_USER : `${DESIGN_LOCKED_FOR_CLAUDE} (Refused: ${name}.)`);
}

/** A diagram's design with its task links left out: what a confirmed
 *  design must keep. */
function designWithoutLinks(d: Diagram): string {
  return JSON.stringify([d.title, d.caption ?? '', d.nodes.map(({ x: _x, y: _y, taskIds: _t, ...n }) => n), d.edges]);
}

export function validTarget(value: unknown): BuildTarget | undefined {
  return (BUILD_TARGETS as readonly string[]).includes(value as string) ? (value as BuildTarget) : undefined;
}

/** A note as the user typed it, bounded; undefined when there is none. */
export function cleanNote(value: unknown): string | undefined {
  return clean(value, MAX_NOTE);
}

/**
 * Lock the plan for building. `prompt` is what the user previewed: it is
 * stored as it was shown, so what reaches Claude is exactly that.
 */
export function submitPlan(
  plan: Plan,
  input: { target: BuildTarget; prompt: string; note?: string; trimmed?: boolean; settings?: BuildSettings },
  now = Date.now(),
): Plan {
  if (plan.submission) throw new PlanError('The plan has already been submitted.');
  if (!plan.design) {
    throw new PlanError('Confirm the design first: the task list is made from the confirmed design, and then the plan is submitted.');
  }
  if (!input.prompt.trim()) throw new PlanError('There is no prompt to submit.');
  const next = structuredClone(plan);
  const note = cleanNote(input.note);
  next.submission = {
    at: now,
    target: input.target,
    ...(note ? { note } : {}),
    prompt: input.prompt,
    ...(input.trimmed ? { trimmed: true } : {}),
    ...(input.settings ? { settings: cleanSettings(input.settings) } : {}),
    deliveredAt: null,
  };
  next.version += 1;
  next.updatedAt = now;
  return next;
}

/** Unlock a submitted plan so the tasks can be changed again. The design
 *  stays confirmed; reopening that is a step of its own. */
export function reopenPlan(plan: Plan, now = Date.now()): Plan {
  if (!plan.submission) throw new PlanError('The plan is not locked.');
  const next = structuredClone(plan);
  delete next.submission;
  // Logged as the user's change, so Claude hears the plan is open again
  // instead of finding out when an edit it no longer needs to hold back
  // is refused — or not at all.
  record(next, 'user', 'status', { kind: 'plan', id: '' }, REOPENED_PLAN, now);
  return next;
}

/**
 * The user confirms the design. `prompt` is what they previewed — the ask
 * for a task list — and it reaches Claude with their next message, as is.
 */
export function confirmDesign(plan: Plan, input: { prompt: string; note?: string; trimmed?: boolean }, now = Date.now()): Plan {
  if (plan.submission) throw new PlanError('The plan has already been submitted.');
  if (plan.design) throw new PlanError('The design is already confirmed.');
  if (!input.prompt.trim()) throw new PlanError('There is no prompt to send.');
  const next = structuredClone(plan);
  const note = cleanNote(input.note);
  next.design = {
    at: now,
    seq: plan.seq,
    ...(note ? { note } : {}),
    prompt: input.prompt,
    ...(input.trimmed ? { trimmed: true } : {}),
    deliveredAt: null,
  };
  next.version += 1;
  next.updatedAt = now;
  return next;
}

/** Unlock a confirmed design so it can be reshaped. The tasks stay. */
export function reopenDesign(plan: Plan, now = Date.now()): Plan {
  if (plan.submission) throw new PlanError('The plan is submitted. Reopen it first, then the design.');
  if (!plan.design) throw new PlanError('The design is not confirmed.');
  const next = structuredClone(plan);
  delete next.design;
  record(next, 'user', 'status', { kind: 'plan', id: '' }, REOPENED_DESIGN, now);
  return next;
}

/** The ask for a task list reached Claude, carrying the design: that is
 *  Claude reading the plan. */
export function markDesignDelivered(plan: Plan, now = Date.now()): Plan {
  if (!plan.design || plan.design.deliveredAt || plan.submission) return plan;
  const next = structuredClone(plan);
  next.design!.deliveredAt = now;
  // The prompt was written when the design was confirmed. Anything the
  // user changed since — tasks, comments — is not in it, so it stays unread
  // and Claude is told to read it.
  const confirmedAt = plan.design.seq ?? plan.seq;
  if (!plan.design.trimmed && !unreadByClaude(plan).some((c) => c.seq > confirmedAt)) markReadByClaude(next, now);
  next.version += 1;
  next.updatedAt = now;
  return next;
}

/**
 * The prompt has reached Claude. It carries the whole plan as submitted —
 * or, when that was too long, tells Claude to read it — so this is Claude's
 * read of the plan too.
 */
export function markDelivered(plan: Plan, now = Date.now()): Plan {
  // Only this session is ever handed the prompt.
  if (!plan.submission || plan.submission.target !== 'session' || plan.submission.deliveredAt) return plan;
  const next = structuredClone(plan);
  next.submission!.deliveredAt = now;
  // The build prompt carries the design too: a task-list ask not yet sent
  // has nothing left to say.
  if (next.design && !next.design.deliveredAt) next.design.deliveredAt = now;
  // A trimmed prompt points Claude at harness_plan_read for what it could
  // not quote — the user's changes among them — so it is not Claude's read:
  // that read is, and it still has them to show.
  if (!plan.submission.trimmed) markReadByClaude(next, now);
  next.version += 1;
  next.updatedAt = now;
  return next;
}

function validSubmission(raw: unknown): Submission | undefined {
  const s = raw as Partial<Submission> | null;
  if (!s || typeof s !== 'object') return undefined;
  const target = validTarget(s.target);
  if (!target || typeof s.at !== 'number' || typeof s.prompt !== 'string' || !s.prompt) return undefined;
  return {
    at: s.at,
    target,
    ...(typeof s.note === 'string' && s.note ? { note: s.note } : {}),
    prompt: s.prompt,
    ...(s.trimmed === true ? { trimmed: true } : {}),
    ...(s.settings && typeof s.settings === 'object' ? { settings: cleanSettings(s.settings) } : {}),
    deliveredAt: typeof s.deliveredAt === 'number' ? s.deliveredAt : null,
  };
}

function validDesign(raw: unknown): DesignSignoff | undefined {
  const d = raw as Partial<DesignSignoff> | null;
  if (!d || typeof d !== 'object' || typeof d.at !== 'number' || typeof d.prompt !== 'string' || !d.prompt) return undefined;
  return {
    at: d.at,
    ...(typeof d.seq === 'number' ? { seq: d.seq } : {}),
    ...(typeof d.note === 'string' && d.note ? { note: d.note } : {}),
    prompt: d.prompt,
    ...(d.trimmed === true ? { trimmed: true } : {}),
    deliveredAt: typeof d.deliveredAt === 'number' ? d.deliveredAt : null,
  };
}

/* ------------------------------------------------------------------ *
 * Diagrams
 * ------------------------------------------------------------------ */

const MAX_NODES = 120;
const MAX_EDGES = 300;
const MAX_DESCRIPTION = 4_000;

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
    const detail = raw.detail === undefined ? prev?.detail : clean(raw.detail, 400);
    // Prose survives an edit that leaves it out, so Claude can rewire a
    // diagram without restating what the user wrote on every box.
    const description = raw.description === undefined ? prev?.description : clean(raw.description, MAX_DESCRIPTION);
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
      ...(description ? { description } : {}),
      ...(notes ? { notes } : {}),
      ...(links?.length ? { taskIds: [...new Set(links)] } : {}),
      ...(x !== undefined && y !== undefined ? { x: Math.round(x), y: Math.round(y) } : {}),
    });
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges: DiagramEdge[] = [];
  const cleaned = rawEdges.map((raw) => {
    const source = clean(raw?.source, 60);
    const target = clean(raw?.target, 60);
    if (!source || !target) throw new PlanError(`Diagram "${title}": every edge needs a source and a target.`);
    for (const end of [source, target]) {
      if (!ids.has(end)) throw new PlanError(`Diagram "${title}": an edge refers to node "${end}", which is not in the diagram.`);
    }
    return { raw, source, target, id: clean(raw.id, 80), label: raw.label === undefined ? undefined : (clean(raw.label, 120) ?? '') };
  });
  // Like a box's prose, an arrow's label and style survive an edit that
  // leaves them out — so Claude can rewire a diagram from the read without
  // undoing how the user drew each arrow. Sending them clears or sets them.
  const prevOf = new Map(matchEdges(old?.edges ?? [], cleaned).pairs.map(([b, a]) => [a, b]));
  for (const c of cleaned) {
    const { raw, source, target } = c;
    const prev = prevOf.get(c);
    // The same arrow keeps its id — and so its comments — when an edit
    // restates it without one.
    let id = c.id ?? prev?.id ?? `${source}->${target}`;
    for (let n = 2; edges.some((e) => e.id === id); n++) id = `${source}->${target}#${n}`;
    const label = c.label === undefined ? prev?.label : c.label || undefined;
    const dashed = raw.dashed === undefined ? prev?.dashed : raw.dashed === true;
    const arrows = raw.arrows === undefined ? prev?.arrows : validArrows(raw.arrows);
    edges.push({
      id,
      source,
      target,
      ...(label ? { label } : {}),
      ...(dashed ? { dashed: true } : {}),
      ...(arrows && arrows !== 'end' ? { arrows } : {}),
    });
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
    return (
      b &&
      (b.label !== n.label ||
        b.kind !== n.kind ||
        (b.detail ?? '') !== (n.detail ?? '') ||
        (b.description ?? '') !== (n.description ?? '') ||
        (b.notes ?? '') !== (n.notes ?? ''))
    );
  });
  const relinked = after.nodes.filter((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.taskIds ?? []).join() !== (n.taskIds ?? []).join();
  });
  const matched = matchEdges(before.edges, after.edges);
  const linked = matched.added;
  const unlinked = matched.removed;
  const relabeled = matched.pairs
    .filter(([b, e]) => (b.label ?? '') !== (e.label ?? '') || Boolean(b.dashed) !== Boolean(e.dashed) || (b.arrows ?? 'end') !== (e.arrows ?? 'end'))
    .map(([, e]) => e);
  const list = (items: string[]) => (items.length > 3 ? `${items.slice(0, 3).join(', ')} and ${items.length - 3} more` : items.join(', '));

  if (added.length) parts.push(`added ${list(added.map((n) => `"${n.label}"`))}`);
  if (removed.length) parts.push(`removed ${list(removed.map((n) => `"${n.label}"`))}`);
  if (changed.length) parts.push(`edited ${list(changed.map((n) => `"${n.label}"`))}`);
  if (relinked.length) parts.push(`changed the tasks behind ${list(relinked.map((n) => `"${n.label}"`))}`);
  if (linked.length) parts.push(`connected ${list(linked.map((e) => `${label(after, e.source)} → ${label(after, e.target)}`))}`);
  if (unlinked.length) parts.push(`disconnected ${list(unlinked.map((e) => `${label(before, e.source)} → ${label(before, e.target)}`))}`);
  if (relabeled.length) parts.push(`relabelled ${list(relabeled.map((e) => `${label(after, e.source)} → ${label(after, e.target)}`))}`);
  if ((before.caption ?? '') !== (after.caption ?? '')) parts.push('edited the caption');
  if (parts.length) return parts.join('; ');
  // Anything else that differs is still a change to the design, and must
  // move the revision and reach Claude even if it has no words of its own.
  return designOf(before) !== designOf(after) ? EDITED_DESIGN : null;
}

/** A change to a diagram's design with no more specific words for it. */
const EDITED_DESIGN = 'edited';

/** A diagram's design, as a string to compare: everything but layout. */
function designOf(d: Diagram): string {
  return JSON.stringify([d.title, d.caption ?? '', d.nodes.map(({ x: _x, y: _y, ...n }) => n), d.edges]);
}

/**
 * Pair up the arrows of two versions of a diagram. An arrow keeps its
 * identity by id where both versions have it between the same boxes; the
 * rest pair up by their ends — same label first — so two arrows between the
 * same two boxes are never mistaken for each other.
 */
type EdgeLike = { id?: string | undefined; source: string; target: string; label?: string | undefined };

export function matchEdges<B extends EdgeLike, A extends EdgeLike>(
  before: readonly B[],
  after: readonly A[],
): { pairs: [B, A][]; removed: B[]; added: A[] } {
  const pairs: [B, A][] = [];
  const left = [...before];
  const right = [...after];
  const take = (same: (b: B, a: A) => boolean) => {
    for (let i = 0; i < left.length; ) {
      const j = right.findIndex((a) => same(left[i]!, a));
      if (j < 0) {
        i++;
        continue;
      }
      pairs.push([left[i]!, right[j]!]);
      left.splice(i, 1);
      right.splice(j, 1);
    }
  };
  const ends = (b: B, a: A) => b.source === a.source && b.target === a.target;
  take((b, a) => b.id !== undefined && b.id === a.id && ends(b, a));
  take((b, a) => ends(b, a) && (b.label ?? '') === (a.label ?? ''));
  take(ends);
  return { pairs, removed: left, added: right };
}

/** Whether only the drawing changed: where boxes sit, which way it flows. */
function layoutChanged(before: Diagram, after: Diagram): boolean {
  if (before.direction !== after.direction) return true;
  return after.nodes.some((n) => {
    const b = before.nodes.find((x) => x.id === n.id);
    return b && (b.x !== n.x || b.y !== n.y);
  });
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

/**
 * A task edit made against revision `expect` is refused when the *other*
 * side changed what the task says since — the user saving over Claude's
 * newer text, or the other way round. One side's own quick successive
 * saves (ticking dependencies one after another) never trip it, and
 * progress (status, stage, checks) is not part of the revision.
 */
/** The latest result of each check: a new report replaces the one of the
 *  same name and leaves the others as they were. */
export function mergeChecks(before: readonly CheckResult[] | undefined, reported: readonly CheckResult[]): CheckResult[] {
  const out = [...(before ?? [])];
  for (const c of reported) {
    const at = out.findIndex((x) => x.name === c.name);
    if (at === -1) out.push(c);
    else out[at] = c;
  }
  return out;
}

/** What a task says, as one comparable string: the fields its `rev` counts. */
function taskContent(t: Task): string {
  return JSON.stringify([t.title, t.detail ?? '', t.note ?? '', t.files ?? [], t.dependsOn ?? [], t.branch ?? '', t.review ?? '']);
}

function checkTaskRev(task: Task, expect: unknown, author: Author): void {
  if (typeof expect !== 'number') return;
  const other: Author = author === 'user' ? 'claude' : 'user';
  const theirs = task.revBy?.[other];
  if (theirs === undefined || theirs <= expect) return;
  throw new PlanError(
    `Task "${task.title}" was changed by ${other === 'claude' ? 'Claude' : 'the user'} while this edit was open, so it was not saved. ` +
      (author === 'claude' ? 'Read the plan again (harness_plan_read), then redo the edit.' : 'It now shows the latest version.'),
  );
}

function taskIdSet(plan: Pick<Plan, 'tasks'>): Set<string> {
  return new Set(plan.tasks.map((t) => t.id));
}

/** A value from a fixed list, or undefined when none was given. A value
 *  that is not on the list is refused rather than quietly dropped: the
 *  author meant something, and should hear it did not land. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if ((allowed as readonly unknown[]).includes(value)) return value as T;
  throw new PlanError(`${JSON.stringify(value)} is not ${what}: use one of ${allowed.join(', ')}.`);
}

function validKind(value: unknown): NodeKind | undefined {
  return oneOf(value, NODE_KINDS, 'a box kind');
}

function validDirection(value: unknown): DiagramDirection | undefined {
  return oneOf(value, ['LR', 'TB'] as const, 'a diagram direction');
}

function validArrows(value: unknown): EdgeArrows | undefined {
  return oneOf(value, EDGE_ARROWS, 'an arrow style');
}

/**
 * Which way a diagram reads best, for when nobody said.
 *
 * Left to right is the natural reading order, so it wins unless the graph is
 * so long and narrow that, laid out that way, it would have to be shrunk
 * until its labels are unreadable — then top to bottom keeps it legible.
 * Estimated from the depth and breadth of the flow; the canvas does the real
 * layout.
 */
export function suggestDirection(
  nodes: readonly { id: string }[],
  edges: readonly { source: string; target: string }[],
): DiagramDirection {
  const ranks = flowRanks(nodes, edges);
  if (ranks.size === 0) return 'LR';
  const perRank = new Map<number, number>();
  for (const r of ranks.values()) perRank.set(r, (perRank.get(r) ?? 0) + 1);
  const depth = Math.max(...perRank.keys()) + 1;
  const breadth = Math.max(...perRank.values());
  // Rough footprint of each layout in pixels, against a typical canvas. A
  // rank is a box plus the gap that carries the arrows; a lane is a box plus
  // the space beside it.
  const fit = (w: number, h: number) => Math.min(1, 1000 / w, 680 / h);
  const lr = fit(depth * 300, breadth * 110);
  const tb = fit(breadth * 250, depth * 150);
  return tb > lr * 1.1 ? 'TB' : 'LR';
}

/** Each connected node's step along the flow: the longest chain of arrows
 *  leading to it, with arrows that close a cycle ignored. Unconnected nodes
 *  have no rank. */
export function flowRanks(nodes: readonly { id: string }[], edges: readonly { source: string; target: string }[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  const connected: string[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    for (const end of [e.source, e.target]) {
      if (!seen.has(end)) connected.push(end);
      seen.add(end);
    }
  }
  // Depth-first, dropping back edges, so the order below is topological.
  const state = new Map<string, 'open' | 'done'>();
  const order: string[] = [];
  const forward = new Map<string, string[]>();
  const visit = (v: string): void => {
    state.set(v, 'open');
    const keep: string[] = [];
    for (const w of out.get(v) ?? []) {
      if (state.get(w) === 'open') continue;
      keep.push(w);
      if (!state.has(w)) visit(w);
    }
    forward.set(v, keep);
    state.set(v, 'done');
    order.push(v);
  };
  for (const v of connected) if (!state.has(v)) visit(v);
  const rank = new Map<string, number>(connected.map((v) => [v, 0]));
  for (const v of order.reverse()) {
    for (const w of forward.get(v) ?? []) rank.set(w, Math.max(rank.get(w) ?? 0, rank.get(v)! + 1));
  }
  return rank;
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
    case 'node':
      return Boolean(findPart(plan, target)?.node);
    case 'edge':
      return Boolean(findPart(plan, target)?.edge);
    default:
      return false;
  }
}

/** The box or arrow a `node` / `edge` target names (`diagramId/partId`). */
export function findPart(
  plan: Pick<Plan, 'diagrams'>,
  target: Target,
): { diagram: Diagram; node?: DiagramNode; edge?: DiagramEdge } | null {
  const at = target.id.indexOf('/');
  if (at <= 0) return null;
  const diagram = plan.diagrams.find((d) => d.id === target.id.slice(0, at));
  if (!diagram) return null;
  const id = target.id.slice(at + 1);
  if (target.kind === 'node') {
    const node = diagram.nodes.find((n) => n.id === id);
    return node ? { diagram, node } : null;
  }
  if (target.kind === 'edge') {
    const edge = diagram.edges.find((e) => e.id === id);
    return edge ? { diagram, edge } : null;
  }
  return null;
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
    case 'node': {
      const part = findPart(plan, target);
      return part?.node ? `box "${part.node.label}" (${target.id}) in diagram "${part.diagram.title}"` : `box ${target.id}`;
    }
    case 'edge': {
      const part = findPart(plan, target);
      if (!part?.edge) return `arrow ${target.id}`;
      const label = (id: string) => part.diagram.nodes.find((n) => n.id === id)?.label ?? id;
      return `arrow ${label(part.edge.source)} → ${label(part.edge.target)} (${target.id}) in diagram "${part.diagram.title}"`;
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
