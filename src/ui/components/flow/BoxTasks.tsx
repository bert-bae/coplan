import { forwardRef, useEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { store, useEdit, usePlan, useStore } from '../../store.ts';
import { AddField, InlineText } from '../Editable.tsx';
import { ProgressBar, TaskStatusDot } from '../Progress.tsx';
import { classNames } from '../../lib/format.ts';
import { isComposing } from '../../lib/keys.ts';
import { boxRows } from '../../lib/tasks.ts';
import { boxUnbuilt } from '../../../shared/check.ts';
import type { Task } from '../../../shared/types.ts';
import { useCanvas, type FlowData } from './shared.ts';

/**
 * What needs to be done for a box, on the box.
 *
 * Every box but a note carries a chip with the count of the tasks that
 * build it — `☐ 0` before any do — and the chip opens the box's checklist:
 * each task with its status, its brief, and, until the plan is submitted, a
 * field to add one (it builds this box), its title to rename and a way to
 * unlink it. A box the plan check would list as built by no task says so
 * beside the chip, unless the repository turns that rule off.
 */

/** Tells React Flow that keys, drags and the wheel here are not the box's or
 *  the canvas's: Enter and Space do not select the box, arrows do not move
 *  it, Backspace does not delete it, and the list scrolls without zooming. */
const OWN_KEYS = 'nokey nodrag nopan nowheel';

/** The chip's words: what it counts, for the eye and for a screen reader. */
function chipText(data: FlowData, linked: number): { shown: string; said: string; glyph: string } {
  const p = data.progress;
  if (!linked || !p) return { shown: '0', said: 'no tasks yet', glyph: '☐' };
  const all = p.total > 0 && p.done === p.total;
  const parts = [`${p.done} of ${p.total} done`, p.inProgress ? `${p.inProgress} in progress` : '', p.blocked ? `${p.blocked} blocked` : ''].filter(Boolean);
  return { shown: `${p.done}/${p.total}`, said: parts.join(', '), glyph: all ? '☑' : '☐' };
}

/**
 * The foot of a box: the task chip, the progress of those tasks, and the
 * "no task" marker. Nothing for a note, which is not a part of the system —
 * unless tasks were linked to one anyway, whose progress it still shows.
 */
export const BoxFoot = forwardRef<HTMLButtonElement, { id: string; data: FlowData }>(function BoxFoot({ id, data }, chip) {
  const api = useCanvas();
  const plan = usePlan();
  const severity = useStore((s) => s.planCheck['box-unbuilt']);
  const p = data.progress;
  if (data.kind === 'note') {
    if (!p) return null;
    return (
      <div className="flow-node-foot">
        <ProgressBar counts={p} compact />
        <span className="flow-node-count">
          {p.done}/{p.total}
        </span>
      </div>
    );
  }
  const linked = (data.taskIds ?? []).filter((t) => plan?.tasks.some((x) => x.id === t)).length;
  const open = api.tasksOpen === id;
  const text = chipText(data, linked);
  const gap = severity !== 'off' && plan !== null && boxUnbuilt(plan, data);
  return (
    <div className="flow-node-foot">
      <button
        ref={chip}
        type="button"
        className={classNames('flow-task-chip', OWN_KEYS, !linked && 'is-empty', open && 'is-open', text.glyph === '☑' && 'is-done')}
        aria-label={`Tasks for ${data.label}: ${text.said}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={linked ? `The tasks that build ${data.label}: ${text.said}` : `No task builds ${data.label} yet${api.tasksEditable ? ' — open to add one' : ''}`}
        onClick={(e) => {
          // A click on the chip is not a click on the box's label to rename.
          e.stopPropagation();
          api.showTasks(open ? null : id);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden="true" className="flow-task-glyph">
          {text.glyph}
        </span>
        <span aria-hidden="true">{text.shown}</span>
      </button>
      {p && linked > 0 && <ProgressBar counts={p} compact />}
      {gap && (
        <span
          className={classNames('flow-node-gap', severity === 'error' && 'is-error')}
          title={`No task builds this box: link the task that does, or say it already exists.${severity === 'error' ? ' This repository holds the sign-off until it is fixed.' : ''}`}
        >
          no task
        </span>
      )}
    </div>
  );
});

/**
 * A box's checklist, floating beside it at its real size. Opens with the
 * keyboard in it — on the field to add a task when tasks can be added —
 * and closes on Escape (back to the chip), on a click elsewhere, or when
 * the keyboard leaves it.
 */
export function BoxTasks({ id, data, chip }: { id: string; data: FlowData; chip: RefObject<HTMLButtonElement | null> }) {
  const edit = useEdit();
  const api = useCanvas();
  const plan = usePlan();
  const panel = useRef<HTMLDivElement>(null);
  const rows = boxRows(plan, data.taskIds);
  const editable = api.tasksEditable;
  const p = data.progress;

  const close = (refocus: boolean) => {
    api.showTasks(null);
    if (refocus) chip.current?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    (el.querySelector<HTMLInputElement>('.add-field input') ?? el).focus();
    const away = (e: PointerEvent) => {
      const to = e.target as Node | null;
      if (to && !el.contains(to) && !chip.current?.contains(to)) closeRef.current(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
    // Once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    // Escape that drops an input method's choice is its own (lib/keys.ts).
    if (isComposing(e) || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };
  // Leaving by the keyboard closes it; focus dropped by a control that went
  // away (a task unlinked, a title saved) does not.
  const onBlur = (e: FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && !panel.current?.contains(to) && !chip.current?.contains(to)) close(false);
  };

  const brief = (task: Task) => {
    // Back to the chip first, so closing the viewer returns there.
    close(true);
    store.openViewer({ tab: 'brief', taskId: task.id });
  };

  const unlink = (task: Task) => {
    api.unlinkTask(id, task.id);
    window.requestAnimationFrame(() => (panel.current?.querySelector<HTMLInputElement>('.add-field input') ?? panel.current)?.focus());
  };

  return (
    <div
      ref={panel}
      className={classNames('flow-tasks', OWN_KEYS)}
      role="dialog"
      aria-label={`Tasks for ${data.label}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <header className="flow-tasks-head">
        <span className="panel-kicker">Tasks</span>
        <span className="flow-tasks-title">{data.label}</span>
        <span className="spacer" />
        {p && rows.length > 0 && (
          <span className="flow-tasks-progress">
            <ProgressBar counts={p} compact /> {p.done}/{p.total}
          </span>
        )}
        <button type="button" className="icon-btn is-tiny" aria-label={`Close the tasks for ${data.label}`} onClick={() => close(true)}>
          ×
        </button>
      </header>
      {rows.length ? (
        <ul className="flow-tasks-list" aria-label={`Tasks that build ${data.label}`}>
          {rows.map(({ task, number, depth, direct, status }) => (
            <li key={task.id} className={classNames('flow-tasks-row', `is-${status}`)} style={{ ['--depth' as string]: depth }}>
              <TaskStatusDot plan={plan!} task={task} status={status} />
              <button
                type="button"
                className="link task-num"
                title="Show it in the Tasks view"
                aria-label={`Show task ${number} in the Tasks view`}
                onClick={() => {
                  close(false);
                  store.focus('task', task.id);
                }}
              >
                {number}
              </button>
              <InlineText
                className="flow-tasks-name"
                value={task.title}
                label={`Title of task ${number}`}
                readOnly={!editable}
                version={task.rev ?? 1}
                onSave={(title, rev) => edit({ op: 'upsert_task', id: task.id, title, ...(rev === undefined ? {} : { expect: rev }) })}
              />
              <button type="button" className="link task-brief" aria-label={`Brief for ${task.title}`} title="What the agent building it is given" onClick={() => brief(task)}>
                Brief
              </button>
              {editable && direct ? (
                <button
                  type="button"
                  className="icon-btn is-tiny"
                  aria-label={`Unlink ${task.title} from ${data.label}`}
                  title="Unlink it from this box. The task stays in the plan."
                  onClick={() => unlink(task)}
                >
                  ×
                </button>
              ) : (
                editable && <span className="flow-tasks-via" title="Builds this box through the linked task it is under" aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flow-tasks-empty">{editable ? 'No task builds this box yet.' : 'No task builds this box.'}</p>
      )}
      {editable && (
        <>
          <AddField placeholder="Add a task…" label={`New task for ${data.label}`} onAdd={(title) => api.addTask(id, title)} />
          <p className="flow-tasks-hint">A task added here builds this box.</p>
        </>
      )}
    </div>
  );
}
