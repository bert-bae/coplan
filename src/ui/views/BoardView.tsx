import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { store, useSession, useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import { EmptyState, Explain } from '../components/primitives.tsx';
import { StageBar, WorkingIndicator } from '../components/StageStatus.tsx';
import { isWorking } from '../lib/stages.ts';
import { classNames, duration, pluralize, relativeTime } from '../lib/format.ts';
import { TASK_STATUSES, type Task, type TaskStatus } from '../../shared/types.ts';

const COLUMNS: { status: TaskStatus; label: string; hint: string }[] = [
  { status: 'todo', label: 'To do', hint: 'Queued — not started' },
  { status: 'in_progress', label: 'In progress', hint: 'What Claude is doing right now' },
  { status: 'blocked', label: 'Blocked', hint: 'Waiting on an answer from you' },
  { status: 'done', label: 'Done', hint: 'Finished, with a record of what changed' },
];

/**
 * The task board.
 *
 * It answers the question the activity feed cannot: where in the work is the
 * agent, and what has each piece actually touched. Cards carry the files the
 * daemon observed being edited while that task was in progress, and the
 * decisions taken after asking the user — so the reasoning behind a change
 * outlives the session.
 */
export function BoardView() {
  const session = useSession();
  const sessionId = useStore((s) => s.sessionId);
  const [dragging, setDragging] = useState<Task | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const tasks = session?.tasks ?? [];
  const byStatus = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>(TASK_STATUSES.map((s) => [s, []]));
    for (const task of [...tasks].sort((a, b) => a.order - b.order)) {
      map.get(task.status)?.push(task);
    }
    return map;
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  if (!session || !sessionId) return null;

  if (tasks.length === 0) {
    return (
      <div className="view-pad">
        <EmptyState
          title="No task board yet"
          hint={
            <>
              Approving a plan fills the board automatically — one card per step. Claude can also add
              subtasks it discovers while working.
            </>
          }
        />
      </div>
    );
  }

  const move = async (task: Task, status: TaskStatus) => {
    if (task.status === status) return;
    try {
      await api.updateTask(sessionId, task.id, { status });
      store.toast('info', `Moved “${task.title}” to ${status.replace('_', ' ')} — Claude will be told.`);
    } catch (err) {
      store.fail(err);
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;
    const task = tasks.find((t) => t.id === active.id);
    if (!task) return;
    const target = String(over.id);
    const status = TASK_STATUSES.find((s) => s === target)
      ?? tasks.find((t) => t.id === target)?.status;
    if (status) void move(task, status);
  };

  const onDragStart = (event: DragStartEvent) => {
    setDragging(tasks.find((t) => t.id === event.active.id) ?? null);
  };

  const done = byStatus.get('done')?.length ?? 0;
  const blocked = byStatus.get('blocked') ?? [];

  return (
    <div className="board">
      <StageBar tab="board" />
      <div className="board-bar">
        <strong>Task board</strong>
        <span className="muted">
          {done}/{tasks.length} done
          {blocked.length > 0 && ` · ${blocked.length} blocked`}
        </span>
        {isWorking(session) && <WorkingIndicator session={session} verbose />}
        <span className="spacer" />
        <Explain>Drag a card to redirect Claude — it is told when you move one.</Explain>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="board-columns">
          {COLUMNS.map((column) => (
            <Column
              key={column.status}
              status={column.status}
              label={column.label}
              hint={column.hint}
              tasks={byStatus.get(column.status) ?? []}
              expanded={expanded}
              onExpand={(id) => setExpanded((current) => (current === id ? null : id))}
            />
          ))}
        </div>
        <DragOverlay>{dragging ? <Card task={dragging} overlay /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({
  status,
  label,
  hint,
  tasks,
  expanded,
  onExpand,
}: {
  status: TaskStatus;
  label: string;
  hint: string;
  tasks: Task[];
  expanded: string | null;
  onExpand: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section className={classNames('board-column', `is-${status}`, isOver && 'is-over')} ref={setNodeRef}>
      <header className="board-column-head">
        <span className="board-column-name">{label}</span>
        <span className="board-count">{tasks.length}</span>
      </header>
      <p className="board-column-hint">{hint}</p>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="board-cards">
          {tasks.length === 0 ? (
            <p className="board-empty">Nothing here</p>
          ) : (
            tasks.map((task) => (
              <SortableCard
                key={task.id}
                task={task}
                expanded={expanded === task.id}
                onExpand={() => onExpand(task.id)}
              />
            ))
          )}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableCard({
  task,
  expanded,
  onExpand,
}: {
  task: Task;
  expanded: boolean;
  onExpand: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={classNames(isDragging && 'is-source')}
      {...attributes}
      {...listeners}
    >
      <Card task={task} expanded={expanded} onExpand={onExpand} />
    </div>
  );
}

function Card({
  task,
  expanded,
  onExpand,
  overlay,
}: {
  task: Task;
  expanded?: boolean;
  onExpand?: () => void;
  overlay?: boolean;
}) {
  const changes = task.notes.filter((n) => n.kind === 'change');
  const elapsed =
    task.status === 'in_progress' && task.startedAt ? duration(Date.now() - task.startedAt) : null;

  return (
    <article className={classNames('board-card', `is-${task.status}`, overlay && 'is-overlay')}>
      <header className="board-card-head">
        <span className="board-card-title">{task.title}</span>
        {elapsed && <span className="board-card-elapsed">{elapsed}</span>}
      </header>

      {task.detail && <p className="board-card-detail">{task.detail}</p>}

      {task.status === 'blocked' && task.blockedReason && (
        <p className="board-card-blocked">
          <strong>Waiting on you:</strong> {task.blockedReason}
        </p>
      )}

      <div className="board-card-meta">
        {task.files.length > 0 && (
          <span title={task.files.join('\n')}>{pluralize(task.files.length, 'file')}</span>
        )}
        {changes.length > 0 && <span>{pluralize(changes.length, 'note')}</span>}
        {task.decisions.length > 0 && (
          <span className="board-card-decisions">{pluralize(task.decisions.length, 'decision')}</span>
        )}
        {task.completedAt && <span className="muted">{relativeTime(task.completedAt)}</span>}
        {onExpand && (task.files.length > 0 || task.notes.length > 0) && (
          <button
            type="button"
            className="link"
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {expanded ? 'less' : 'details'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="board-card-body">
          {task.files.length > 0 && (
            <>
              <h4>Files changed</h4>
              <ul className="board-files">
                {task.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {task.decisions.length > 0 && (
            <>
              <h4>Decisions</h4>
              <ul className="board-decisions">
                {task.decisions.map((d) => (
                  <li key={d.id}>
                    <span className="board-question">{d.question}</span>
                    <span className="board-answer">→ {d.answer}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {task.notes.length > 0 && (
            <>
              <h4>Record</h4>
              <ul className="board-notes">
                {task.notes.map((note) => (
                  <li key={note.id} className={`is-${note.kind}`}>
                    <span className="board-note-kind">{note.kind}</span>
                    {note.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </article>
  );
}
