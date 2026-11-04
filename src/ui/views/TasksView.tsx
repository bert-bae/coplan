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
import { childrenOf, countTasks, descendants, isLocked, outline, planPhase } from '../../shared/plan.ts';
import { TASK_STATUSES, type Diagram, type DiagramNode, type Plan, type PlanOp, type Task, type TaskStatus } from '../../shared/types.ts';

/** Clicking the status dot steps through the common path; blocked is set
 *  from the detail panel or the board, where it can carry a reason. */
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'in_progress',
  in_progress: 'done',
  blocked: 'in_progress',
  done: 'todo',
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
              ? 'Handed off to be built elsewhere, so these statuses do not move.'
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
        {plan.tasks.length === 0 ? <EmptyState title="No tasks" hint="This plan was submitted without a task breakdown." /> : <Board key={sessionId} plan={plan} readOnly />}
      </div>
    );
  }

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
      </div>

      {plan.tasks.length === 0 ? (
        <>
          <EmptyState title="No tasks yet" hint={`Break the work down here, or ask ${agent.name} to publish a task tree with the plan.`} />
          <AddField placeholder="Add a task…" label="New task" onAdd={(title) => store.op({ op: 'upsert_task', title })} />
        </>
      ) : mode === 'outline' ? (
        <Outline plan={plan} hideDone={hideDone} />
      ) : (
        <Board plan={plan} />
      )}
    </div>
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
        <StatusDot task={task} />
        <span className="task-num">{number}</span>
        <InlineText
          className="task-title"
          value={task.title}
          label="Task title"
          onSave={(title) => store.op({ op: 'upsert_task', id: task.id, title })}
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
        <StatusPicker task={task} />
      </div>
      <div className="field-row">
        <span className="field-label">Note</span>
        <InlineText
          className="task-note"
          value={task.note ?? ''}
          placeholder="One line — what it's blocked on, or what was done"
          label="Status note"
          onSave={(note) => store.op({ op: 'upsert_task', id: task.id, note })}
        />
      </div>
      <div className="field-col">
        <span className="field-label">Detail</span>
        <MarkdownField
          value={task.detail ?? ''}
          label={`detail of "${task.title}"`}
          placeholder="No detail yet."
          emptyAction="Add approach or acceptance criteria"
          onSave={(detail) => store.op({ op: 'upsert_task', id: task.id, detail })}
        />
      </div>
      <div className="field-col">
        <span className="field-label">Files</span>
        <FilesField task={task} />
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

/** Expected files, one per line. */
function FilesField({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState((task.files ?? []).join('\n'));
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
          onClick={() => {
            setEditing(false);
            void store.op({ op: 'upsert_task', id: task.id, files: draft.split('\n').map((f) => f.trim()).filter(Boolean) });
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
      {TASK_STATUSES.map((status) => {
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
      {open && (
        <div className="board-more">
          {task.detail?.trim() && <Markdown source={task.detail} />}
          {task.files?.length ? <p className="board-files mono">{task.files.join(', ')}</p> : null}
        </div>
      )}
      <footer className="board-foot">
        <span className="item-id">{task.id}</span>
        {arrived && <span className="pill is-moved">just moved</span>}
        <span className="spacer" />
        <span className={classNames('board-state', `is-${task.status}`)}>{STATUS_LABEL[task.status]}</span>
      </footer>
    </Focusable>
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
  return plan.tasks.some((t) => t.parentId === id);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}
