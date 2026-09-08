import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { store, useSession, useGateOfKind, useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import { Button, EmptyState, Explain } from '../components/primitives.tsx';
import { StageBar, RequiredAction, NoActionNeeded } from '../components/StageStatus.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { classNames, pluralize } from '../lib/format.ts';
import { verdictExplain, verdictToast } from '../lib/stages.ts';
import type { PlanStep } from '../../shared/types.ts';

/**
 * Plan review.
 *
 * The user's working copy is theirs: a revision published by Claude no longer
 * silently overwrites edits in progress — it offers the new revision and lets
 * the user decide.
 */
export function PlanView() {
  const session = useSession();
  const gate = useGateOfKind('plan');
  const sessionId = useStore((s) => s.sessionId);
  const plan = session?.plan ?? null;

  const [steps, setSteps] = useState<PlanStep[]>(() => plan?.steps.map(clone) ?? []);
  const [baseRevision, setBaseRevision] = useState(plan?.revision ?? 0);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const dirty = useRef(false);

  // Adopt a new revision automatically only when the user has not started
  // editing; otherwise offer it.
  const incoming = plan && plan.revision !== baseRevision ? plan : null;
  useEffect(() => {
    if (!plan) return;
    if (plan.revision === baseRevision) return;
    if (dirty.current) return;
    setSteps(plan.steps.map(clone));
    setBaseRevision(plan.revision);
  }, [plan, baseRevision]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = useMemo(() => steps.map((s) => s.id), [steps]);

  if (!plan) {
    return (
      <div className="view-pad">
        <EmptyState
          title="No plan published yet"
          hint={
            <>
              Ask Claude to run <code>/harness</code>, or call <code>harness_publish_plan</code>. The plan
              appears here for you to edit and approve before it starts building.
            </>
          }
        />
      </div>
    );
  }

  const edit = (fn: (draft: PlanStep[]) => PlanStep[]) => {
    dirty.current = true;
    setSteps((current) => fn(current));
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    edit((current) => {
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
    setAnnouncement(`Step moved to position ${to + 1} of ${steps.length}`);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = steps.findIndex((s) => s.id === active.id);
    const to = steps.findIndex((s) => s.id === over.id);
    if (from < 0 || to < 0) return;
    move(from, to);
  };

  const submit = async (verdict: 'approved' | 'changes_requested' | 'rejected') => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      if (gate) {
        await api.resolveGate(sessionId, gate.id, { verdict, comment: summary.trim(), steps });
        store.toast('success', verdictToast(gate, verdict === 'approved' ? 'Plan approved' : 'Sent to Claude'));
      } else {
        await api.feedback(sessionId, { text: describeEdits(plan.steps, steps, summary.trim()), origin: 'plan' });
        store.toast('success', "Queued for Claude's next turn.");
      }
      setSummary('');
      dirty.current = false;
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };

  const live = steps.filter((s) => s.status !== 'dropped');

  return (
    <div className="plan">
      <div className="plan-main">
        <StageBar tab="plan" />
        <header className="plan-head">
          <h2>{plan.title}</h2>
          <span className="muted">revision {plan.revision}</span>
        </header>
        {plan.summary && <p className="plan-summary">{plan.summary}</p>}
        {plan.markdown && <Markdown source={plan.markdown} />}

        {incoming && (
          <div className="plan-incoming">
            <span>
              Claude published revision {incoming.revision} while you were editing. Your edits are still here.
            </span>
            <div className="row-actions">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setSteps(incoming.steps.map(clone));
                  setBaseRevision(incoming.revision);
                  dirty.current = false;
                }}
              >
                Load the new revision
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setBaseRevision(incoming.revision)}>
                Keep my edits
              </Button>
            </div>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ol className="plan-steps">
              {steps.map((step, index) => (
                <SortableStep
                  key={step.id}
                  step={step}
                  index={index}
                  total={steps.length}
                  onMove={move}
                  onChange={(patch) =>
                    edit((current) => current.map((s) => (s.id === step.id ? { ...s, ...patch } : s)))
                  }
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>

        <Button
          variant="ghost"
          onClick={() =>
            edit((current) => [...current, { id: newStepId(current), title: '', status: 'pending' }])
          }
        >
          + Add a step
        </Button>

        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>

      <aside className="plan-side">
        <h3 className="panel-title">Your response</h3>
        {gate && (
          <Explain>
            {verdictExplain(gate, 'Approving')} Claude gets the plan exactly as you have edited it —{' '}
            {pluralize(live.length, 'step')}
            {steps.length !== live.length && `, ${steps.length - live.length} dropped`}.
          </Explain>
        )}
        <textarea
          className="input"
          rows={4}
          value={summary}
          placeholder="Anything to add? (optional)"
          onChange={(e) => setSummary(e.target.value)}
        />
        {/* Without a gate there is no verdict to give: offering "Approve"
            when nothing asked for approval is what made the pipeline feel
            like it had invisible steps. */}
        {gate ? (
          <RequiredAction
            gate={gate}
            busy={busy}
            onChoose={(id) =>
              void submit(id === 'approve' ? 'approved' : id === 'reject' ? 'rejected' : 'changes_requested')
            }
          />
        ) : (
          <>
            <NoActionNeeded tab="plan" />
            <div className="plan-actions">
              <Button variant="primary" onClick={() => void submit('changes_requested')} disabled={busy}>
                Send these notes
              </Button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SortableStep({
  step,
  index,
  total,
  onMove,
  onChange,
}: {
  step: PlanStep;
  index: number;
  total: number;
  onMove: (from: number, to: number) => void;
  onChange: (patch: Partial<PlanStep>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id,
  });
  const dropped = step.status === 'dropped';

  return (
    <li
      ref={setNodeRef}
      className={classNames('plan-step', dropped && 'is-dropped', isDragging && 'is-dragging')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="step-handle-col">
        {/* Drag for speed, arrows for keyboard and discoverability. */}
        <button
          type="button"
          className="step-grip"
          aria-label={`Reorder step ${index + 1}`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <span className="step-index">{index + 1}</span>
      </div>

      <div className="step-main">
        <input
          className="step-title"
          value={step.title}
          placeholder="Describe this step"
          onChange={(e) => onChange({ title: e.target.value })}
        />
        {step.detail && <p className="step-detail">{step.detail}</p>}
        <input
          className="step-comment"
          value={step.comment ?? ''}
          placeholder="Note on this step (optional)"
          onChange={(e) => onChange({ comment: e.target.value || undefined })}
        />
      </div>

      <div className="step-actions">
        <button type="button" className="icon-btn" title="Move up" onClick={() => onMove(index, index - 1)}>
          ↑
        </button>
        <button type="button" className="icon-btn" title="Move down" onClick={() => onMove(index, index + 1)}>
          ↓
        </button>
        <button
          type="button"
          className={classNames('icon-btn', dropped && 'is-active')}
          title={dropped ? 'Keep this step' : 'Drop this step'}
          onClick={() => onChange({ status: dropped ? 'pending' : 'dropped' })}
        >
          {dropped ? '⟲' : '✕'}
        </button>
      </div>
      <span className="sr-only">{`Step ${index + 1} of ${total}`}</span>
    </li>
  );
}

function clone(step: PlanStep): PlanStep {
  return { ...step };
}

/** Ids must stay unique after drops and re-adds, or dnd-kit and the server
 *  both start confusing steps for one another. */
function newStepId(steps: PlanStep[]): string {
  let n = steps.length + 1;
  const taken = new Set(steps.map((s) => s.id));
  while (taken.has(`u${n}`)) n++;
  return `u${n}`;
}

/** Without a gate there is no structured channel, so describe the edits. */
function describeEdits(original: PlanStep[], edited: PlanStep[], note: string): string {
  const lines: string[] = [];
  if (note) lines.push(note);

  const dropped = edited.filter((s) => s.status === 'dropped');
  if (dropped.length) {
    lines.push('Drop these steps:');
    for (const s of dropped) lines.push(`- ${s.title}`);
  }
  const commented = edited.filter((s) => s.comment);
  if (commented.length) {
    lines.push('Comments on steps:');
    for (const s of commented) lines.push(`- ${s.title}: ${s.comment}`);
  }
  const before = original.map((s) => s.title).join('|');
  const after = edited.filter((s) => s.status !== 'dropped').map((s) => s.title).join('|');
  if (before !== after) {
    lines.push('Revised plan:');
    edited
      .filter((s) => s.status !== 'dropped')
      .forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
  }
  return lines.join('\n') || 'No changes.';
}
