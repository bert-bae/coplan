import { useMemo, useState } from 'react';
import { store, useEdit, useAgent, usePlan, useStore } from '../store.ts';
import { AddField, InlineText, MarkdownField } from '../components/Editable.tsx';
import { CommentToggle, ThreadPanel, useCommentsShown } from '../components/Threads.tsx';
import { Focusable, ItemActions } from '../components/Item.tsx';
import { ProgressBar } from '../components/Progress.tsx';
import { SubmitControl } from '../components/Submit.tsx';
import { scrollBehavior } from '../lib/motion.ts';
import { FLOW_LABEL, childrenOf, countTasks, currentTask, hasTaskList, isDesignLocked, isLocked, planFlow, planPhase, type FlowStep } from '../../shared/plan.ts';
import { KIND_NOUN } from '../../shared/architecture.ts';
import { boxUnbuilt } from '../../shared/check.ts';
import { Markdown } from '../components/Markdown.tsx';
import { SkippedChecks } from '../components/TaskChecks.tsx';
import { partsByTask } from '../lib/tasks.ts';
import { classNames, relativeTime } from '../lib/format.ts';
import type { Plan, Section, TaskStatus } from '../../shared/types.ts';

/**
 * The first thing the user reads: how the plan gets built and where it is,
 * the agent's understanding of the problem and how it approaches it, then
 * the architecture broken into the parts the tasks build, and the tasks —
 * so why the plan is shaped as it is comes before its detail. The prose
 * sections follow, in the order the user wants to read them.
 */
export function OverviewView() {
  const edit = useEdit();
  const plan = usePlan();
  const agent = useAgent();
  const generalShown = useCommentsShown({ kind: 'plan', id: '' });
  if (!plan) return null;
  const designLocked = isDesignLocked(plan);
  const counts = countTasks(plan);
  // Progress means something once there is some, or the build is on.
  const progressing = isLocked(plan) || counts.done + counts.inProgress + counts.blocked > 0;
  return (
    <div className="view-pad doc">
      <FlowStrip plan={plan} />

      {/* A confirmed or submitted design reads the same, but every control
          in it is off. Comments stay open until the plan is submitted: a
          section locks what it says, not its comments (SectionCard). */}
      <fieldset className="lockable" disabled={designLocked}>
        <Focusable kind="plan" id="summary" className="doc-block understanding" labelledBy="summary-head">
          <h2 id="summary-head" className="doc-label">
            {agent.name}'s understanding and approach
          </h2>
          <MarkdownField
            value={plan.summary}
            label="the plan summary"
            placeholder={`${agent.name} has not said how it understands the problem yet.`}
            emptyAction="Write one"
            draftKey="summary"
            onSave={(summary) => edit({ op: 'set_meta', summary })}
          />
        </Focusable>
      </fieldset>

      {plan.report && (
        <section className="doc-block report" aria-labelledby="report-head">
          <h2 id="report-head" className="doc-label">
            Build report <span className="muted">· {relativeTime(plan.report.at)}</span>
          </h2>
          <Markdown source={plan.report.text} />
          <SkippedChecks plan={plan} />
        </section>
      )}

      {progressing && <Glance plan={plan} />}

      {plan.diagrams.length > 0 && <Breakdown plan={plan} />}

      <TaskPlan plan={plan} />

      {plan.sections.map((section, i) => (
        <SectionCard key={section.id} section={section} index={i} count={plan.sections.length} locked={designLocked} />
      ))}

      {!designLocked && (
        <div className="doc-add">
          <AddField
            placeholder="New section title — e.g. Data model, Risks, Out of scope"
            label="New section title"
            onAdd={(title) => edit({ op: 'upsert_section', title, body: '' })}
          />
        </div>
      )}

      {generalShown && (
        <fieldset className="lockable" disabled={isLocked(plan)}>
          <section className="doc-block" aria-labelledby="general-head">
            <h2 id="general-head" className="doc-label">
              General comments
            </h2>
            <ThreadPanel target={{ kind: 'plan', id: '' }} label="the plan" />
          </section>
        </fieldset>
      )}
    </div>
  );
}

const STEP_HINT: Record<FlowStep, string> = {
  architecture: 'Reshape the design, then confirm it',
  tasklist: 'Focused tasks: what blocks what, where each lands',
  build: 'Each task implemented, reviewed and checked',
};

function openStep(step: FlowStep): void {
  if (step === 'architecture') store.setTab('diagrams');
  else store.set({ tab: 'tasks', taskMode: step === 'build' ? 'board' : 'outline' });
}

/**
 * How the plan gets built, step by step, and the one it is on — with the
 * sign-off that moves it on. Architecture first leads into the task list,
 * and the task list into the build; a plan with no architecture starts at
 * its task list.
 */
function FlowStrip({ plan }: { plan: Plan }) {
  const { steps, at } = planFlow(plan);
  const phase = planPhase(plan);
  const finished = phase === 'built' || phase === 'handed-off';
  const current = steps.indexOf(at);
  return (
    <section className="doc-block plan-flow" aria-labelledby="pflow-head">
      <div className="pflow-head">
        <h2 id="pflow-head" className="doc-label">
          How this plan gets built
        </h2>
        <span className="spacer" />
        <SubmitControl />
      </div>
      <ol className="pflow-steps">
        {steps.map((step, i) => {
          const state = finished || i < current ? 'done' : i === current ? 'current' : 'next';
          return (
            <li key={step} className={classNames('pflow-step', `is-${state}`)} aria-current={state === 'current' ? 'step' : undefined}>
              <button type="button" className="pflow-btn" onClick={() => openStep(step)}>
                <span className="pflow-num" aria-hidden="true">
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span className="pflow-text">
                  <span className="pflow-title">{FLOW_LABEL[step]}</span>
                  <span className="pflow-hint">{STEP_HINT[step]}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="pflow-why">
        {steps[0] === 'architecture'
          ? 'Architecture first: the design is agreed before the task list is made from it, so every task builds a part of that design — then the task list is built.'
          : 'Straight to the task list: the work sits in one area, where a diagram would add nothing — shape the tasks, then build them.'}
      </p>
    </section>
  );
}

/** Each diagram as the parts it is made of, and the tasks that build each:
 *  how the task list follows from the design. */
function Breakdown({ plan }: { plan: Plan }) {
  // "no task" where the plan check would say so, as the canvas does.
  const severity = useStore((s) => s.planCheck['box-unbuilt']);
  return (
    <section className="doc-block" aria-labelledby="breakdown-head">
      <h2 id="breakdown-head" className="doc-label">
        Architecture breakdown
      </h2>
      <p className="ov-lead">Each part names the tasks that build it: that is how the task list is made from the design.</p>
      {plan.diagrams.map((d) => (
        <article key={d.id} className="ov-diagram">
          <header className="ov-diagram-head">
            <button type="button" className="link ov-diagram-title" onClick={() => store.focus('diagram', d.id)}>
              {d.title}
            </button>
            <span className="muted">
              {d.nodes.length} part{d.nodes.length === 1 ? '' : 's'} · {d.edges.length} connection{d.edges.length === 1 ? '' : 's'}
            </span>
          </header>
          {d.caption?.trim() && <p className="ov-caption">{d.caption}</p>}
          <ul className="ov-parts">
            {d.nodes
              .filter((n) => n.kind !== 'note')
              .map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="ov-part"
                    title={n.description ?? n.label}
                    onClick={() => store.focus('node', `${d.id}:${n.id}`)}
                  >
                    <span className="ov-part-label">{n.label}</span>
                    <span className="ov-part-kind">{KIND_NOUN[n.kind]}</span>
                    {n.taskIds?.length ? (
                      <span className="ov-part-tasks">{n.taskIds.join(', ')}</span>
                    ) : severity !== 'off' && boxUnbuilt(plan, n) ? (
                      <span className="ov-part-tasks is-none">no task</span>
                    ) : null}
                  </button>
                </li>
              ))}
          </ul>
        </article>
      ))}
    </section>
  );
}

const STATUS_MARK: Record<TaskStatus, string> = { todo: '○', in_progress: '◐', blocked: '!', done: '✓', dropped: '–' };
const STATUS_WORD: Record<TaskStatus, string> = { todo: 'to do', in_progress: 'in progress', blocked: 'blocked', done: 'done', dropped: 'dropped' };

/** The top of the task tree: the ideas on the design while it is open, the
 *  task list once there is one — what each builds and what it comes after. */
function TaskPlan({ plan }: { plan: Plan }) {
  const ideas = !hasTaskList(plan);
  const top = childrenOf(plan, null);
  const counts = countTasks(plan);
  const parts = useMemo(() => partsByTask(plan.diagrams), [plan.diagrams]);
  return (
    <section className="doc-block" aria-labelledby="taskplan-head">
      <h2 id="taskplan-head" className="doc-label">
        {ideas ? 'Task ideas' : 'Task list'}
        {counts.total > 0 && <span className="muted"> · {ideas ? `${counts.total} planned` : `${counts.done}/${counts.total} done`}</span>}
      </h2>
      {ideas && plan.diagrams.length > 0 && (
        <p className="ov-lead">Coarse on purpose: once the design is confirmed, the task list is made from these, split into focused tasks.</p>
      )}
      {top.length === 0 ? (
        <p className="muted">No tasks yet.</p>
      ) : (
        <ol className="ov-tasks">
          {top.map((t) => {
            const subtasks = childrenOf(plan, t.id).length;
            const builds = (parts.get(t.id) ?? []).map((p) => p.n.label);
            return (
              <li key={t.id} className={classNames('ov-task', `is-${t.status}`)}>
                <span className="ov-task-mark" title={STATUS_WORD[t.status]} aria-label={STATUS_WORD[t.status]}>
                  {STATUS_MARK[t.status]}
                </span>
                <button type="button" className="ov-task-title" onClick={() => store.focus('task', t.id)}>
                  {t.title}
                </button>
                <span className="ov-task-meta">
                  <span className="item-id">{t.id}</span>
                  {subtasks > 0 && <span>{subtasks} subtask{subtasks === 1 ? '' : 's'}</span>}
                  {t.dependsOn?.length ? <span>after {t.dependsOn.join(', ')}</span> : null}
                  {builds.length > 0 && <span>builds {builds.join(', ')}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Glance({ plan }: { plan: Plan }) {
  const agent = useAgent();
  const counts = countTasks(plan);
  const openThreads = plan.threads.filter((t) => !t.resolved).length;
  const now = currentTask(plan);
  const blocked = plan.tasks.filter((t) => t.status === 'blocked');
  return (
    <div className="glance" role="list" aria-label="Plan at a glance">
      <button type="button" role="listitem" className="glance-tile" onClick={() => store.setTab('tasks')}>
        <span className="glance-label">Tasks</span>
        <span className="glance-value">
          {counts.done}
          <span className="glance-of">/{counts.total}</span>
        </span>
        <ProgressBar counts={counts} />
        <span className="glance-sub">
          {counts.inProgress ? `${counts.inProgress} in progress` : counts.total ? 'none in progress' : 'no tasks yet'}
          {counts.blocked ? ` · ${counts.blocked} blocked` : ''}
        </span>
      </button>
      <button
        type="button"
        role="listitem"
        className={blocked.length ? 'glance-tile is-attention' : 'glance-tile'}
        onClick={() => {
          const target = now ?? blocked[0];
          if (target) store.focus('task', target.id);
          else store.setTab('tasks');
        }}
      >
        <span className="glance-label">{now ? `${agent.name} is on` : blocked.length ? 'Blocked' : 'Now'}</span>
        <span className="glance-now">{now?.title ?? blocked[0]?.title ?? (counts.total && counts.done === counts.total ? 'All done' : 'Nothing in progress')}</span>
        <span className="glance-sub">{now?.note ?? blocked[0]?.note ?? (blocked.length > 1 ? `${blocked.length} tasks blocked` : ' ')}</span>
      </button>
      <button
        type="button"
        role="listitem"
        className="glance-tile"
        onClick={() => document.getElementById('general-head')?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })}
      >
        <span className="glance-label">Open comments</span>
        <span className="glance-value">{openThreads}</span>
        <span className="glance-sub">revision {plan.revision || 'draft'}</span>
      </button>
    </div>
  );
}

function SectionCard({ section, index, count, locked }: { section: Section; index: number; count: number; locked: boolean }) {
  const edit = useEdit();
  const [comments, setComments] = useState(false);
  const target = { kind: 'section' as const, id: section.id };
  return (
    <Focusable kind="section" id={section.id} className="doc-block section-card">
      <header className="item-head">
        <InlineText
          as="h2"
          className="section-title"
          value={section.title}
          label="Section title"
          lockedBy="design"
          readOnly={locked}
          onSave={(title) => edit({ op: 'upsert_section', id: section.id, title })}
        />
        <span className="item-id">{section.id}</span>
        <span className="spacer" />
        <CommentToggle target={target} label={section.title} open={comments} onToggle={() => setComments((v) => !v)} />
        {!locked && (
          <ItemActions
            label={section.title}
            index={index}
            count={count}
            onMove={(to) => edit({ op: 'move_section', id: section.id, index: to })}
            onRemove={() => edit({ op: 'remove', kind: 'section', id: section.id })}
          />
        )}
      </header>
      <fieldset className="lockable" disabled={locked}>
        <MarkdownField
          value={section.body}
          label={`section "${section.title}"`}
          rows={8}
          version={section.rev}
          draftKey={`section:${section.id}`}
          onSave={(body, rev) => edit({ op: 'upsert_section', id: section.id, body, ...(rev !== undefined ? { expect: rev } : {}) })}
        />
      </fieldset>
      {comments && <ThreadPanel target={target} label={section.title} />}
    </Focusable>
  );
}
