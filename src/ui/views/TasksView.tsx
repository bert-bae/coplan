import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { store, useAgent, usePlan, useStore } from '../store.ts';
import { AddField, InlineText, MarkdownField } from '../components/Editable.tsx';
import { CommentToggle, ThreadPanel, useThreads } from '../components/Threads.tsx';
import { Focusable } from '../components/Item.tsx';
import { KIND_GLYPH } from '../components/FlowCanvas.tsx';
import { ProgressBar, STATUS_GLYPH, STATUS_LABEL } from '../components/Progress.tsx';
import { EmptyState } from '../components/primitives.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { classNames } from '../lib/format.ts';
import { SubmitControl, REVIEW_LABEL } from '../components/Submit.tsx';
import { childrenOf, countTasks, descendants, isLocked, outline, planPhase } from '../../shared/plan.ts';
import { DEFAULT_BUILD_SETTINGS, SESSION_BRANCH, roundVerdict, stackStatus, type StackEntry, ancestorsOf, branchPlan, buildSteps, effectiveBranch, effectiveReview, hasDependencies, hasSubtasks, readinessOf, waitingOn } from '../../shared/build.ts';
import { REVIEW_MODES, TASK_STATUSES, type Diagram, type DiagramNode, type Plan, type PlanOp, type ReviewMode, type Task, type TaskStatus } from '../../shared/types.ts';

/** Clicking the status dot steps through the common path; blocked is set
 *  from the detail panel or the board, where it can carry a reason. */
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'in_progress',
  in_progress: 'done',
  blocked: 'in_progress',
  done: 'todo',
  dropped: 'todo',
};

type DropZone = 'before' | 'inside' | 'after';
type Part = { d: Diagram; n: DiagramNode };
const NO_PARTS: Part[] = [];
const DRAG_TYPE = 'application/x-harness-task';

/**
 * The breakdown. Two layouts over the same tree:
 *
 * - **Outline** is for shaping it: nest, reorder, rename, add detail. Drag a
 *   row onto another to nest it, or onto its top or bottom edge to place it
 *   beside; or use Alt+arrows on a focused row.
 * - **Board** is for following it: every leaf task in a status column, the
 *   way progress is tracked while Claude works through the plan.
 */
export function TasksView() {
  const agent = useAgent();
  const plan = usePlan();
  const mode = useStore((s) => s.taskMode);
  const hideDone = useStore((s) => s.hideDone);
  const sessionId = useStore((s) => s.sessionId);
  if (!plan) return null;
  const counts = countTasks(plan);
  // Submitted: the breakdown is final, and this view is the build moving
  // across the board — nothing on it is edited.
  if (isLocked(plan)) {
    const phase = planPhase(plan);
    return (
      <div className="view-pad">
        <div className="toolbar">
          <p className="toolbar-note">
            <span aria-hidden="true">🔒</span>{' '}
            {phase === 'handed-off'
              ? 'Exported to be built elsewhere, so these statuses do not move.'
              : phase === 'submitted'
                ? `The plan is locked. Cards move across the board once ${agent.name} starts and reports each task.`
                : `The plan is locked. Cards move across the board as ${agent.name} reports each task.`}
          </p>
          <span className="spacer" />
          <span className="toolbar-progress">
            <ProgressBar counts={counts} />
            <span className="muted">
              {counts.done}/{counts.total} done
            </span>
          </span>
        </div>
        {plan.tasks.length === 0 ? (
          <EmptyState title="No tasks" hint="This plan was submitted without a task breakdown." />
        ) : (
          <>
            <Board key={sessionId} plan={plan} readOnly />
            <BuildOrder plan={plan} collapsible />
          </>
        )}
      </div>
    );
  }
  const tasking = planPhase(plan) === 'tasking';

  return (
    <div className="view-pad">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Task layout">
          <button type="button" className={classNames('seg', mode === 'outline' && 'is-active')} aria-pressed={mode === 'outline'} onClick={() => store.setTaskMode('outline')}>
            Outline
          </button>
          <button type="button" className={classNames('seg', mode === 'board' && 'is-active')} aria-pressed={mode === 'board'} onClick={() => store.setTaskMode('board')}>
            Board
          </button>
        </div>
        {mode === 'outline' && (
          <label className="toggle">
            <input type="checkbox" checked={hideDone} onChange={() => store.toggleHideDone()} />
            Hide done
          </label>
        )}
        <span className="spacer" />
        <span className="toolbar-progress">
          <ProgressBar counts={counts} />
          <span className="muted">
            {counts.done}/{counts.total} done
          </span>
        </span>
        {tasking && <SubmitControl />}
      </div>

      {plan.tasks.length === 0 ? (
        <>
          <EmptyState title="No tasks yet" hint={`Break the work down here, or ask ${agent.name} to publish a task tree with the plan.`} />
          <AddField placeholder="Add a task…" label="New task" onAdd={(title) => store.op({ op: 'upsert_task', title })} />
        </>
      ) : mode === 'outline' ? (
        <>
          <Outline plan={plan} hideDone={hideDone} />
          <BuildOrder plan={plan} />
        </>
      ) : (
        <Board plan={plan} />
      )}
    </div>
  );
}

/**
 * The order the build will take: steps of tasks that can be built side by
 * side, and the branches the work lands on. Shown once tasks say what they
 * wait on or where they land.
 */
/** A branch's pull request as the agent last reported it, and the restack
 *  it needs when the branch below it merged. */
function PullRequest({ entry }: { entry: StackEntry | undefined }) {
  const pr = entry?.state?.pr;
  if (!pr && !entry?.restack) return null;
  const label = `PR${pr?.number ? ` #${pr.number}` : ''} ${pr?.state ?? ''}`.trim();
  return (
    <>
      {pr &&
        (pr.url ? (
          <a className={classNames('chip', 'is-pr', `is-${pr.state}`)} href={pr.url} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          <span className={classNames('chip', 'is-pr', `is-${pr.state}`)}>{label}</span>
        ))}
      {entry?.restack && (
        <span className="chip is-warning" title={entry.restack}>
          needs a restack
        </span>
      )}
    </>
  );
}

function BuildOrder({ plan, collapsible = false }: { plan: Plan; collapsible?: boolean }) {
  const { branches, unbranched } = branchPlan(plan);
  const stack = stackStatus(plan);
  if (!hasDependencies(plan) && branches.length === 0) return null;
  const steps = buildSteps(plan);
  const numbers = new Map(outline(plan).map((r) => [r.task.id, r.number]));
  const chip = (t: Task) => (
    <button
      key={t.id}
      type="button"
      className={classNames('chip', 'order-chip', `is-${readinessOf(plan, t)}`)}
      title={`${t.title} — ${STATUS_LABEL[t.status].toLowerCase()}`}
      onClick={() => store.focus('task', t.id)}
    >
      <span className="task-num">{numbers.get(t.id)}</span> {t.title}
    </button>
  );
  const body = (
    <>
      {hasDependencies(plan) && (
        <ol className="order-steps" aria-label="Build steps">
          {steps.map((step, i) => (
            <li key={i}>
              <span className="order-step">Step {i + 1}</span>
              <span className="order-tasks">{step.map(chip)}</span>
            </li>
          ))}
        </ol>
      )}
      {branches.length > 0 && (
        <ul className="order-branches" aria-label="Branches">
          {branches.map((b) => (
            <li key={b.branch}>
              <code className="head-branch">{b.branch}</code>
              <span className="muted">
                {b.needs.length > 1
                  ? ` needs ${b.needs.map((n) => (n === SESSION_BRANCH ? 'the current branch' : n)).join(' and ')}`
                  : b.base === SESSION_BRANCH
                    ? ' stacked on the current branch'
                    : b.base
                      ? ` stacked on ${b.base}`
                      : ' from the base branch'}
              </span>
              <PullRequest entry={stack.find((s) => s.branch === b.branch)} />
              <span className="order-tasks">{b.tasks.map(chip)}</span>
            </li>
          ))}
          {unbranched.length > 0 && (
            <li>
              <span className="muted">current branch</span>
              <span className="order-tasks">{unbranched.map(chip)}</span>
            </li>
          )}
        </ul>
      )}
    </>
  );
  const hint = 'Tasks in the same step wait on nothing in it, so they can be built side by side.';
  if (collapsible) {
    return (
      <details className="build-order">
        <summary className="field-label">Build order and branches</summary>
        <p className="muted order-hint">{hint}</p>
        {body}
      </details>
    );
  }
  return (
    <section className="build-order" aria-label="Build order">
      <h2 className="field-label">Build order{branches.length ? ' and branches' : ''}</h2>
      <p className="muted order-hint">{hint}</p>
      {body}
    </section>
  );
}

/** Where a task stands for the build, as a chip: ready, or what it waits on. */
function ReadinessChip({ plan, task }: { plan: Plan; task: Task }) {
  const state = readinessOf(plan, task);
  if (state === 'ready') return <span className="chip is-ready" title="Nothing it depends on is left: it can start">ready</span>;
  if (state !== 'waiting') return null;
  const numbers = new Map(outline(plan).map((r) => [r.task.id, r.number]));
  const on = waitingOn(plan, task);
  return (
    <span className="chip is-waiting" title={`Waits on ${on.map((t) => t.title).join(', ')}`}>
      waits on {on.map((t) => numbers.get(t.id) ?? t.id).join(', ')}
    </span>
  );
}

/** A task in progress: where it is in implement → review → refine, and its
 *  last checks. */
function IricBadges({ task }: { task: Task }) {
  const checks = task.checks ?? [];
  const failed = checks.filter((c) => !c.ok);
  return (
    <>
      {task.status === 'in_progress' && task.stage && (
        <span className={classNames('chip', 'stage-chip', `is-${task.stage}`)} title="Where it is in its implement → review → refine cycle">
          {task.stage === 'implement' ? 'implementing' : task.stage === 'review' ? `in review${task.round ? ` · round ${task.round}` : ''}` : 'refining'}
        </span>
      )}
      {checks.length > 0 && task.status !== 'todo' && (
        <span
          className={classNames('chip', failed.length ? 'is-check-fail' : 'is-check-ok')}
          title={checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.note ? ` — ${c.note}` : ''}`).join('\n')}
        >
          {failed.length ? `✗ ${failed.map((c) => c.name).join(', ')}` : `✓ ${checks.length} check${checks.length === 1 ? '' : 's'}`}
        </span>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Outline
 * ------------------------------------------------------------------ */

function Outline({ plan, hideDone }: { plan: Plan; hideDone: boolean }) {
  const collapsed = useStore((s) => s.collapsedTasks);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hint, setHint] = useState<{ id: string; zone: DropZone } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);

  // Which boxes each task builds, worked out once for the whole outline.
  const partsByTask = useMemo(() => {
    const map = new Map<string, Part[]>();
    for (const d of plan.diagrams) {
      for (const n of d.nodes) {
        for (const t of n.taskIds ?? []) map.set(t, [...(map.get(t) ?? []), { d, n }]);
      }
    }
    return map;
  }, [plan.diagrams]);

  const numbers = useMemo(() => new Map(outline(plan).map((r) => [r.task.id, r.number])), [plan]);
  const tracking = planPhase(plan) !== 'planning';
  const rows = useMemo(() => {
    const hidden = new Set<string>();
    for (const id of collapsed) for (const d of descendants(plan, id)) hidden.add(d.id);
    return outline(plan).filter(({ task }) => !hidden.has(task.id) && !(hideDone && task.status === 'done' && !hasChildren(plan, task.id)));
  }, [plan, collapsed, hideDone]);

  /** Where a drop on `target` in `zone` puts the dragged task. */
  const dropOp = (draggedId: string, target: Task, zone: DropZone): PlanOp | null => {
    if (draggedId === target.id || descendants(plan, draggedId).some((d) => d.id === target.id)) return null;
    if (zone === 'inside') return { op: 'move_task', id: draggedId, parentId: target.id, index: Number.MAX_SAFE_INTEGER };
    const siblings = childrenOf(plan, target.parentId).filter((t) => t.id !== draggedId);
    const at = siblings.findIndex((t) => t.id === target.id);
    return { op: 'move_task', id: draggedId, parentId: target.parentId, index: zone === 'before' ? at : at + 1 };
  };

  const onDragOver = (e: DragEvent, target: Task) => {
    if (!dragging) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    const zone: DropZone = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
    if (!dropOp(dragging, target, zone)) {
      setHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (hint?.id !== target.id || hint.zone !== zone) setHint({ id: target.id, zone });
  };

  const onDrop = (e: DragEvent, target: Task) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_TYPE) || dragging;
    const zone = hint?.id === target.id ? hint.zone : null;
    setHint(null);
    setDragging(null);
    if (!id || !zone) return;
    const op = dropOp(id, target, zone);
    if (!op) return;
    if (zone === 'inside' && collapsed.includes(target.id)) store.toggleTaskCollapsed(target.id);
    void store.op(op);
  };

  return (
    <div className="task-outline">
      <div className="outline-rows" role="tree" aria-label="Task tree">
        {rows.map(({ task, depth, number }) => (
          <TaskRow
            key={task.id}
            plan={plan}
            task={task}
            depth={depth}
            number={number}
            expanded={expanded === task.id}
            onToggleExpanded={() => setExpanded((cur) => (cur === task.id ? null : task.id))}
            dragging={dragging === task.id}
            dropZone={hint?.id === task.id ? hint.zone : null}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, task.id);
              e.dataTransfer.setData('text/plain', task.title);
              e.dataTransfer.effectAllowed = 'move';
              setDragging(task.id);
            }}
            onDragEnd={() => {
              setDragging(null);
              setHint(null);
            }}
            onDragOver={(e) => onDragOver(e, task)}
            onDragLeave={() => setHint((h) => (h?.id === task.id ? null : h))}
            onDrop={(e) => onDrop(e, task)}
            addingSubtask={addingUnder === task.id}
            onAddSubtask={() => setAddingUnder(task.id)}
            onCloseAdd={() => setAddingUnder(null)}
            parts={partsByTask.get(task.id) ?? NO_PARTS}
            numbers={numbers}
            tracking={tracking}
          />
        ))}
      </div>
      <AddField placeholder="Add a top-level task…" label="New top-level task" onAdd={(title) => store.op({ op: 'upsert_task', title })} />
      <p className="outline-help muted">
        Drag a row onto another to nest it, or to its top or bottom edge to place it beside. With a row focused: Alt+↑/↓
        reorders, Alt+→ nests under the row above, Alt+← moves it out a level.
      </p>
    </div>
  );
}

function TaskRow(props: {
  plan: Plan;
  task: Task;
  depth: number;
  number: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  dragging: boolean;
  dropZone: DropZone | null;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  addingSubtask: boolean;
  onAddSubtask: () => void;
  onCloseAdd: () => void;
  /** The parts of the architecture this task builds. */
  parts: Part[];
  /** Outline numbers by task id, to name dependencies the way rows do. */
  numbers: Map<string, string>;
  /** The design is confirmed: say which tasks are ready. */
  tracking: boolean;
}) {
  const { plan, task, depth, number, expanded } = props;
  const collapsed = useStore((s) => s.collapsedTasks.includes(task.id));
  const [comments, setComments] = useState(false);
  const kids = childrenOf(plan, task.id);
  const sub = kids.length ? countTasks({ tasks: [task, ...descendants(plan, task.id)] }) : null;
  const threads = useThreads({ kind: 'task', id: task.id });
  const target = { kind: 'task' as const, id: task.id };
  const parts = props.parts;

  const siblings = childrenOf(plan, task.parentId);
  const index = siblings.findIndex((t) => t.id === task.id);
  const parent = task.parentId ? plan.tasks.find((t) => t.id === task.parentId) : undefined;

  const moves = {
    up: index > 0 ? ({ op: 'move_task', id: task.id, parentId: task.parentId, index: index - 1 } as PlanOp) : null,
    down: index < siblings.length - 1 ? ({ op: 'move_task', id: task.id, parentId: task.parentId, index: index + 1 } as PlanOp) : null,
    // Nest under the sibling above, at the end of its subtasks.
    indent: index > 0 ? ({ op: 'move_task', id: task.id, parentId: siblings[index - 1]!.id, index: Number.MAX_SAFE_INTEGER } as PlanOp) : null,
    // Out one level, right after the old parent.
    outdent: parent
      ? ({
          op: 'move_task',
          id: task.id,
          parentId: parent.parentId,
          index: childrenOf(plan, parent.parentId).findIndex((t) => t.id === parent.id) + 1,
        } as PlanOp)
      : null,
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || isTyping(e.target)) return;
    const op =
      e.key === 'ArrowUp' ? moves.up : e.key === 'ArrowDown' ? moves.down : e.key === 'ArrowRight' ? moves.indent : e.key === 'ArrowLeft' ? moves.outdent : null;
    if (!op) return;
    e.preventDefault();
    void store.op(op).then(() => {
      // Keep the keyboard on the row it moved.
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`#task-${task.id} .task-line`)?.focus());
    });
  };

  return (
    <Focusable kind="task" id={task.id} as="div" className={classNames('task', `is-${task.status}`, props.dragging && 'is-dragging')}>
      <div
        className={classNames('task-line', props.dropZone && `drop-${props.dropZone}`)}
        style={{ ['--depth' as string]: depth }}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={kids.length ? !collapsed : undefined}
        aria-label={`${number} ${task.title}, ${STATUS_LABEL[task.status]}`}
        tabIndex={0}
        draggable
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
        onKeyDown={onKeyDown}
      >
        <span className="drag-handle" aria-hidden="true" title="Drag to move">
          ⋮⋮
        </span>
        {kids.length ? (
          <button
            type="button"
            className="twisty"
            aria-label={collapsed ? `Show subtasks of ${task.title}` : `Hide subtasks of ${task.title}`}
            onClick={() => store.toggleTaskCollapsed(task.id)}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="twisty is-leaf" aria-hidden="true" />
        )}
        {kids.length ? <DerivedStatus plan={plan} task={task} /> : <StatusDot task={task} />}
        <span className="task-num">{number}</span>
        <InlineText
          className="task-title"
          value={task.title}
          label="Task title"
          version={revOf(task)}
          onSave={(title, rev) => store.op({ op: 'upsert_task', id: task.id, title, ...expecting(rev) })}
        />
        <span className="task-badges">
          {sub && (
            <span className="chip" title={`${sub.done} of ${sub.total} subtasks done`}>
              {sub.done}/{sub.total}
            </span>
          )}
          {task.note && (
            <span className={classNames('chip is-note', task.status === 'blocked' && 'is-warning')} title={task.note}>
              {task.note}
            </span>
          )}
          {task.files?.length ? <span className="chip" title={task.files.join('\n')}>{task.files.length} file{task.files.length === 1 ? '' : 's'}</span> : null}
          {task.dependsOn?.length ? (
            <span className="chip is-dep" title={`Starts after ${task.dependsOn.map((id) => plan.tasks.find((t) => t.id === id)?.title ?? id).join(', ')}`}>
              after {task.dependsOn.map((id) => props.numbers.get(id) ?? id).join(', ')}
            </span>
          ) : null}
          {task.branch && (
            <span className="chip is-branch" title={`Lands on the branch ${task.branch}`}>
              <span aria-hidden="true">⎇</span> {task.branch}
            </span>
          )}
          {task.review && <span className="chip" title="How this task is reviewed">review: {REVIEW_LABEL[task.review].toLowerCase()}</span>}
          {props.tracking && !kids.length && <ReadinessChip plan={plan} task={task} />}
          {parts.map(({ d, n }) => (
            <button
              key={`${d.id}:${n.id}`}
              type="button"
              className="chip is-part"
              title={`Builds "${n.label}" in ${d.title} — show it`}
              onClick={() => store.focus('node', `${d.id}:${n.id}`)}
            >
              <span aria-hidden="true">{KIND_GLYPH[n.kind]}</span> {n.label}
            </button>
          ))}
          {task.createdBy === 'user' && <span className="chip is-you">added by you</span>}
          {task.addedInBuild && (
            <span className="chip is-note" title="Found during the build: not part of the plan you submitted">
              added during the build
            </span>
          )}
        </span>
        <span className="spacer" />
        <span className="task-actions">
          <button type="button" className="icon-btn is-tiny" title="Add subtask" aria-label={`Add a subtask to ${task.title}`} onClick={props.onAddSubtask}>
            <span aria-hidden="true">＋</span>
          </button>
          <MoveButton op={moves.outdent} glyph="←" label={`Move ${task.title} out a level`} />
          <MoveButton op={moves.indent} glyph="→" label={`Nest ${task.title} under the task above`} />
          <MoveButton op={moves.up} glyph="↑" label={`Move ${task.title} up`} />
          <MoveButton op={moves.down} glyph="↓" label={`Move ${task.title} down`} />
        </span>
        <BriefButton task={task} />
        <CommentToggle target={target} label={task.title} open={comments} onToggle={() => setComments((v) => !v)} />
        <button
          type="button"
          className={classNames('icon-btn is-tiny', expanded && 'is-active', (Boolean(task.detail) || threads.length > 0) && 'has-detail')}
          aria-expanded={expanded}
          title="Details"
          aria-label={`Details of ${task.title}`}
          onClick={props.onToggleExpanded}
        >
          <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
        </button>
      </div>

      {(expanded || comments) && (
        <div className="task-detail" style={{ ['--depth' as string]: depth }}>
          {expanded && <TaskDetail plan={plan} task={task} />}
          {comments && <ThreadPanel target={target} label={task.title} />}
        </div>
      )}

      {props.addingSubtask && (
        <div className="task-add-sub" style={{ ['--depth' as string]: depth + 1 }}>
          <AddField
            placeholder={`Subtask of "${task.title}"…`}
            label={`New subtask of ${task.title}`}
            autoFocus
            onCancel={props.onCloseAdd}
            onAdd={async (title) => {
              const ok = await store.op({ op: 'upsert_task', parentId: task.id, title });
              if (ok && collapsed) store.toggleTaskCollapsed(task.id);
              return ok;
            }}
          />
        </div>
      )}
    </Focusable>
  );
}

function TaskDetail({ plan, task }: { plan: Plan; task: Task }) {
  const agent = useAgent();
  const [confirming, setConfirming] = useState(false);
  const subtasks = descendants(plan, task.id).length;
  return (
    <div className="task-detail-body">
      <div className="field-row">
        <span className="field-label">Status</span>
        {hasSubtasks(plan, task.id) ? <span className="muted">Follows its subtasks.</span> : <StatusPicker task={task} />}
      </div>
      <div className="field-row">
        <span className="field-label">Note</span>
        <InlineText
          className="task-note"
          value={task.note ?? ''}
          placeholder="One line — what it's blocked on, or what was done"
          label="Status note"
          version={revOf(task)}
          onSave={(note, rev) => store.op({ op: 'upsert_task', id: task.id, note, ...expecting(rev) })}
        />
      </div>
      <div className="field-col">
        <span className="field-label">Detail</span>
        <MarkdownField
          value={task.detail ?? ''}
          label={`detail of "${task.title}"`}
          placeholder="No detail yet."
          emptyAction="Add approach or acceptance criteria"
          version={revOf(task)}
          onSave={(detail, rev) => store.op({ op: 'upsert_task', id: task.id, detail, ...expecting(rev) })}
        />
      </div>
      <div className="field-col">
        <span className="field-label">Files</span>
        <FilesField task={task} />
      </div>
      <div className="field-col">
        <span className="field-label">Starts after</span>
        <DependsField plan={plan} task={task} />
      </div>
      <div className="field-row">
        <span className="field-label">Branch</span>
        <InlineText
          className="task-branch mono"
          value={task.branch ?? ''}
          placeholder={(() => {
            const inherited = task.parentId ? effectiveBranch(plan, plan.tasks.find((t) => t.id === task.parentId)!) : null;
            return inherited ? `${inherited} (from its parent)` : 'the current branch';
          })()}
          label="Branch"
          version={revOf(task)}
          onSave={(branch, rev) => store.op({ op: 'upsert_task', id: task.id, branch, ...expecting(rev) })}
        />
      </div>
      <div className="field-row">
        <span className="field-label">Review</span>
        <ReviewPicker task={task} />
      </div>
      <div className="task-detail-foot">
        <span className="muted">
          {task.id} · {task.createdBy === 'user' ? 'added by you' : `added by ${agent.name}`}
        </span>
        <span className="spacer" />
        {confirming ? (
          <span className="item-confirm">
            Remove{subtasks ? ` with ${subtasks} subtask(s)` : ''}?
            <button type="button" className="link is-danger" onClick={() => void store.op({ op: 'remove', kind: 'task', id: task.id })}>
              Remove
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="link is-danger" onClick={() => setConfirming(true)}>
            Remove task
          </button>
        )}
      </div>
    </div>
  );
}

/** What a task waits on: chips to remove, a list to add from. A task can
 *  wait on anything but itself, its own parents and its own subtasks. */
function DependsField({ plan, task }: { plan: Plan; task: Task }) {
  const deps = task.dependsOn ?? [];
  const excluded = new Set([task.id, ...deps, ...ancestorsOf(plan, task).map((t) => t.id), ...descendants(plan, task.id).map((t) => t.id)]);
  const rows = outline(plan);
  const numbers = new Map(rows.map((r) => [r.task.id, r.number]));
  // Made against what is on screen: if the agent changed the list since,
  // the whole-list save is refused rather than undoing its change.
  const set = (dependsOn: string[]) => void store.op({ op: 'upsert_task', id: task.id, dependsOn, expect: revOf(task) });
  const inherited = ancestorsOf(plan, task).flatMap((a) => (a.dependsOn ?? []).map((id) => ({ via: a, id })));
  return (
    <div className="depends">
      {deps.length ? (
        <ul className="depends-list">
          {deps.map((id) => {
            const dep = plan.tasks.find((t) => t.id === id);
            return (
              <li key={id} className="chip is-dep">
                <button type="button" className="link" onClick={() => store.focus('task', id)}>
                  {numbers.get(id)} {dep?.title ?? id}
                </button>
                <button type="button" className="icon-btn is-tiny" aria-label={`Stop waiting on ${dep?.title ?? id}`} title="Remove" onClick={() => set(deps.filter((d) => d !== id))}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="muted">{inherited.length ? '' : 'Nothing — it can start whenever the build reaches it.'}</span>
      )}
      {inherited.length > 0 && (
        <span className="muted depends-inherited">
          Also waits on {inherited.map(({ id }) => numbers.get(id) ?? id).join(', ')} through {[...new Set(inherited.map(({ via }) => `"${via.title}"`))].join(', ')}.
        </span>
      )}
      <select className="input" aria-label={`Add a task ${task.title} waits on`} value="" onChange={(e) => e.target.value && set([...deps, e.target.value])}>
        <option value="">Wait on another task…</option>
        {rows
          .filter((r) => !excluded.has(r.task.id))
          .map(({ task: t, number, depth }) => (
            <option key={t.id} value={t.id}>
              {' '.repeat(depth * 3)}
              {number} {t.title}
            </option>
          ))}
      </select>
    </div>
  );
}

function ReviewPicker({ task }: { task: Task }) {
  const options: (ReviewMode | '')[] = ['', ...REVIEW_MODES];
  return (
    <div className="segmented is-small" role="radiogroup" aria-label={`How ${task.title} is reviewed`}>
      {options.map((mode) => (
        <button
          key={mode || 'default'}
          type="button"
          role="radio"
          aria-checked={(task.review ?? '') === mode}
          className={classNames('seg', (task.review ?? '') === mode && 'is-active')}
          title={mode ? undefined : "The build's default, or its parent's"}
          onClick={() => void store.op({ op: 'upsert_task', id: task.id, review: mode, expect: revOf(task) })}
        >
          {mode ? REVIEW_LABEL[mode] : 'Default'}
        </button>
      ))}
    </div>
  );
}

/** Expected files, one per line. */
function FilesField({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState((task.files ?? []).join('\n'));
  const [startedAt, setStartedAt] = useState(revOf(task));
  const latest = useRef(revOf(task));
  latest.current = revOf(task);
  if (!editing) {
    return (
      <div className="files">
        {task.files?.length ? (
          <ul className="plain-list mono">
            {task.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <span className="muted">None listed.</span>
        )}{' '}
        <button
          type="button"
          className="link"
          onClick={() => {
            setDraft((task.files ?? []).join('\n'));
            setStartedAt(revOf(task));
            setEditing(true);
          }}
        >
          Edit
        </button>
      </div>
    );
  }
  return (
    <div className="md-field is-editing">
      <textarea className="input mono" rows={4} value={draft} aria-label="Files, one per line" onChange={(e) => setDraft(e.target.value)} />
      <div className="md-field-foot">
        <span className="muted">One path per line</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={async () => {
            const files = draft.split('\n').map((f) => f.trim()).filter(Boolean);
            // Refused when changed underneath: stay open, with the text.
            if (await store.op({ op: 'upsert_task', id: task.id, files, expect: startedAt })) setEditing(false);
            else setStartedAt(latest.current);
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function MoveButton({ op, glyph, label }: { op: PlanOp | null; glyph: string; label: string }) {
  return (
    <button type="button" className="icon-btn is-tiny" disabled={!op} title={label} aria-label={label} onClick={() => op && void store.op(op)}>
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

/** Where a parent's subtasks stand: done when all are, blocked or in
 *  progress when any is. A parent has no status of its own to set — what
 *  is built, and what the agent reports, is its subtasks. */
function derivedStatus(plan: Plan, task: Task): TaskStatus {
  // The same roll-up harness_task_next and the briefs use, so the board and
  // the agent never disagree about a parent.
  const r = readinessOf(plan, task);
  return r === 'ready' || r === 'waiting' ? 'todo' : r;
}

function DerivedStatus({ plan, task }: { plan: Plan; task: Task }) {
  const status = derivedStatus(plan, task);
  return (
    <span
      className={classNames('status-dot', 'is-static', `is-${status}`)}
      role="img"
      title={`${STATUS_LABEL[status]}, from its subtasks`}
      aria-label={`${task.title}: ${STATUS_LABEL[status]}, from its subtasks`}
    >
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
    </span>
  );
}

function StatusDot({ task }: { task: Task }) {
  const next = NEXT_STATUS[task.status];
  return (
    <button
      type="button"
      className={classNames('status-dot', `is-${task.status}`)}
      title={`${STATUS_LABEL[task.status]} — click to mark ${STATUS_LABEL[next].toLowerCase()}`}
      aria-label={`${task.title}: ${STATUS_LABEL[task.status]}. Mark ${STATUS_LABEL[next].toLowerCase()}`}
      onClick={() => void store.op({ op: 'upsert_task', id: task.id, status: next })}
    >
      <span aria-hidden="true">{STATUS_GLYPH[task.status]}</span>
    </button>
  );
}

function StatusPicker({ task }: { task: Task }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={`Status of ${task.title}`}>
      {TASK_STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={task.status === s}
          className={classNames('seg', `status-${s}`, task.status === s && 'is-active')}
          onClick={() => void store.op({ op: 'upsert_task', id: task.id, status: s })}
        >
          {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Board
 * ------------------------------------------------------------------ */

function Board({ plan, readOnly = false }: { plan: Plan; readOnly?: boolean }) {
  const [over, setOver] = useState<TaskStatus | null>(null);
  const { arrived, announcement } = useArrivals(plan);
  // Leaves only: a parent is a heading, and its progress is its subtasks'.
  const leaves = outline(plan)
    .map((r) => r.task)
    .filter((t) => !hasChildren(plan, t.id));

  return (
    <div className={classNames('board', readOnly && 'is-readonly')}>
      {TASK_STATUSES.filter((s) => s !== 'dropped' || leaves.some((t) => t.status === 'dropped')).map((status) => {
        const cards = leaves.filter((t) => t.status === status);
        return (
          <section
            key={status}
            className={classNames('board-col', `is-${status}`, over === status && 'is-over')}
            aria-label={STATUS_LABEL[status]}
            onDragOver={(e) => {
              if (readOnly || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              setOver(status);
            }}
            onDragLeave={() => setOver((cur) => (cur === status ? null : cur))}
            onDrop={(e) => {
              if (readOnly) return;
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData(DRAG_TYPE);
              const task = plan.tasks.find((t) => t.id === id);
              if (task && task.status !== status) void store.op({ op: 'upsert_task', id, status });
            }}
          >
            <header className="board-col-head">
              <span className={classNames('status-dot is-static', `is-${status}`)} aria-hidden="true">
                {STATUS_GLYPH[status]}
              </span>
              <h2>{STATUS_LABEL[status]}</h2>
              <span className="board-count">{cards.length}</span>
            </header>
            <div className="board-cards">
              {cards.map((task) =>
                readOnly ? (
                  <TrackedCard key={task.id} plan={plan} task={task} arrived={arrived.has(task.id)} />
                ) : (
                  <BoardCard key={task.id} plan={plan} task={task} />
                ),
              )}
              {cards.length === 0 && <p className="board-empty">{readOnly ? 'Nothing here yet' : 'Drop tasks here'}</p>}
            </div>
          </section>
        );
      })}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/** How long a card that just moved column stands out. */
const ARRIVAL_MS = 2400;

/**
 * Which tasks just changed column, so the eye can follow a card from one to
 * the next — and the same moves, in words, for a screen reader. The first
 * render is the board as it is: nothing has moved yet.
 */
function useArrivals(plan: Plan): { arrived: Set<string>; announcement: string } {
  const last = useRef<Map<string, TaskStatus> | null>(null);
  const timers = useRef(new Set<number>());
  const [arrived, setArrived] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState('');
  const key = plan.tasks.map((t) => `${t.id}:${t.status}`).join('|');

  useEffect(() => {
    const before = last.current;
    last.current = new Map(plan.tasks.map((t) => [t.id, t.status]));
    if (!before) return;
    const moved = plan.tasks.filter((t) => before.has(t.id) && before.get(t.id) !== t.status && !hasChildren(plan, t.id));
    if (!moved.length) return;
    const ids = moved.map((t) => t.id);
    setArrived((cur) => new Set([...cur, ...ids]));
    setAnnouncement(moved.map((t) => `${t.title}: ${STATUS_LABEL[t.status].toLowerCase()}`).join('. '));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setArrived((cur) => {
        const next = new Set(cur);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, ARRIVAL_MS);
    timers.current.add(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on statuses
  }, [key]);

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );
  return { arrived, announcement };
}

/** A card on a submitted plan's board: read, never moved by hand. Opens to
 *  show what the task involves. */
function TrackedCard({ plan, task, arrived }: { plan: Plan; task: Task; arrived: boolean }) {
  const agent = useAgent();
  const [open, setOpen] = useState(false);
  const path: string[] = [];
  let cursor = task.parentId ? plan.tasks.find((t) => t.id === task.parentId) : undefined;
  while (cursor) {
    path.unshift(cursor.title);
    cursor = cursor.parentId ? plan.tasks.find((t) => t.id === cursor!.parentId) : undefined;
  }
  const more = Boolean(task.detail?.trim() || task.files?.length);
  return (
    <Focusable kind="task" id={task.id} as="article" className={classNames('board-card', 'is-tracked', `is-${task.status}`, arrived && 'is-arrived')}>
      {path.length > 0 && <p className="board-path">{path.join(' › ')}</p>}
      <p className="board-title-row">
        {task.status === 'in_progress' && <span className="working-dot" title={`${agent.name} is on it`} aria-label={`${agent.name} is on it`} />}
        {more ? (
          <button type="button" className="board-title" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {task.title}
          </button>
        ) : (
          <span className="board-title">{task.title}</span>
        )}
      </p>
      {task.note && <p className="board-note">{task.note}</p>}
      <p className="board-chips">
        <IricBadges task={task} />
        {task.status === 'todo' && <ReadinessChip plan={plan} task={task} />}
        {effectiveBranch(plan, task) && <span className="chip is-branch">⎇ {effectiveBranch(plan, task)}</span>}
      </p>
      {open && (
        <div className="board-more">
          {task.detail?.trim() && <Markdown source={task.detail} />}
          {task.files?.length ? <p className="board-files mono">{task.files.join(', ')}</p> : null}
        </div>
      )}
      <ReviewHistory task={task} />
      <UserReview plan={plan} task={task} />
      <footer className="board-foot">
        <span className="item-id">{task.id}</span>
        {arrived && <span className="pill is-moved">just moved</span>}
        <span className="spacer" />
        <BriefButton task={task} />
        <span className={classNames('board-state', `is-${task.status}`)}>{STATUS_LABEL[task.status]}</span>
      </footer>
    </Focusable>
  );
}

/** One click to what the agent building this task is given: its brief,
 *  exactly as harness_task_brief returns it. */
function BriefButton({ task }: { task: Task }) {
  return (
    <button
      type="button"
      className="link task-brief"
      title={`What the agent building "${task.title}" is given — its brief, with where each part comes from`}
      aria-label={`Brief for ${task.title}`}
      onClick={() => store.openViewer({ tab: 'brief', taskId: task.id })}
    >
      Brief
    </button>
  );
}

/** Each review round's verdict, newest last. */
function ReviewHistory({ task }: { task: Task }) {
  if (!task.reviews?.length) return null;
  return (
    <ul className="board-reviews plain-list" aria-label={`Reviews of ${task.title}`}>
      {task.reviews.map((r, i) => (
        <li key={`${r.round}:${i}`} className={classNames('muted', r.verdict === 'pass' ? 'is-pass' : 'is-changes')}>
          Round {r.round}: {r.verdict === 'pass' ? 'passed' : 'changes asked'} by {r.by === 'user' ? 'you' : 'the agent'}
          {r.summary ? ` — ${r.summary}` : ''}
        </li>
      ))}
    </ul>
  );
}

/**
 * The user's verdict on a task they review, while it is in review: the
 * agent cannot mark it done without their pass — given here, or in chat.
 */
function UserReview({ plan, task }: { plan: Plan; task: Task }) {
  const agent = useAgent();
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState('');
  const mode = effectiveReview(plan, task, plan.submission?.settings?.review ?? DEFAULT_BUILD_SETTINGS.review);
  if (mode !== 'user' || task.stage !== 'review') return null;
  const decided = roundVerdict(task, 'user');
  if (decided) return null;
  const send = async (verdict: 'pass' | 'changes', summary?: string) => {
    const ok = await store.op({ op: 'review_task', id: task.id, verdict, ...(summary ? { summary } : {}) });
    if (ok) setAsking(false);
  };
  return (
    <div className="board-review" role="group" aria-label={`Your review of ${task.title}`}>
      <span className="field-label">Your review — round {task.round}</span>
      {asking ? (
        <>
          <input className="input" value={why} placeholder={`What should ${agent.name} change?`} aria-label="What to change" onChange={(e) => setWhy(e.target.value)} />
          <span className="board-review-actions">
            <button type="button" className="btn btn-sm" disabled={!why.trim()} onClick={() => void send('changes', why.trim())}>
              Send
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </span>
        </>
      ) : (
        <span className="board-review-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void send('pass')}>
            Approve
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setAsking(true)}>
            Request changes
          </button>
        </span>
      )}
    </div>
  );
}

function BoardCard({ plan, task }: { plan: Plan; task: Task }) {
  const path: string[] = [];
  let cursor = task.parentId ? plan.tasks.find((t) => t.id === task.parentId) : undefined;
  while (cursor) {
    path.unshift(cursor.title);
    cursor = cursor.parentId ? plan.tasks.find((t) => t.id === cursor!.parentId) : undefined;
  }
  const comments = plan.threads.filter((t) => !t.resolved && t.target.kind === 'task' && t.target.id === task.id).length;
  return (
    <article
      className={classNames('board-card', `is-${task.status}`)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, task.id);
        e.dataTransfer.setData('text/plain', task.title);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      {path.length > 0 && <p className="board-path">{path.join(' › ')}</p>}
      <button type="button" className="board-title" onClick={() => store.focus('task', task.id)}>
        {task.title}
      </button>
      {task.note && <p className="board-note">{task.note}</p>}
      {planPhase(plan) !== 'planning' && task.status === 'todo' && (
        <p className="board-chips">
          <ReadinessChip plan={plan} task={task} />
        </p>
      )}
      <footer className="board-foot">
        <span className="item-id">{task.id}</span>
        {comments > 0 && <span className="chip">💬 {comments}</span>}
        <span className="spacer" />
        <label className="sr-only" htmlFor={`status-${task.id}`}>
          Status of {task.title}
        </label>
        <select
          id={`status-${task.id}`}
          className="board-status"
          value={task.status}
          onChange={(e) => void store.op({ op: 'upsert_task', id: task.id, status: e.target.value as TaskStatus })}
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------------ */

function hasChildren(plan: Pick<Plan, 'tasks'>, id: string): boolean {
  return hasSubtasks(plan, id);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}

/** A task's content revision; tasks written before it existed are at 1. */
function revOf(task: Task): number {
  return task.rev ?? 1;
}

/** The `expect` for an edit made against `rev`, when one was captured. */
function expecting(rev: number | undefined): { expect?: number } {
  return rev === undefined ? {} : { expect: rev };
}
