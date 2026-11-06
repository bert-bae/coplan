import { useState } from 'react';
import { store, useAgent, usePlan } from '../store.ts';
import { AddField, InlineText, MarkdownField } from '../components/Editable.tsx';
import { CommentToggle, ThreadPanel } from '../components/Threads.tsx';
import { Focusable, ItemActions } from '../components/Item.tsx';
import { ProgressBar } from '../components/Progress.tsx';
import { scrollBehavior } from '../lib/motion.ts';
import { countTasks, currentTask, isDesignLocked, isLocked } from '../../shared/plan.ts';
import { Markdown } from '../components/Markdown.tsx';
import { relativeTime } from '../lib/format.ts';
import type { Plan, Section } from '../../shared/types.ts';

/**
 * The plan as a document: what is being built and why, then the prose
 * sections — context, architecture, risks — in the order the user wants to
 * read them. The tiles at the top are where Claude has got to, at a glance,
 * and each one is a way into the tab that holds the detail.
 */
export function OverviewView() {
  const plan = usePlan();
  if (!plan) return null;
  return (
    <div className="view-pad doc">
      <Glance plan={plan} />

      {plan.report && (
        <section className="doc-block report" aria-labelledby="report-head">
          <h2 id="report-head" className="doc-label">
            Build report <span className="muted">· {relativeTime(plan.report.at)}</span>
          </h2>
          <Markdown source={plan.report.text} />
        </section>
      )}

      {/* A confirmed or submitted design reads the same, but every control
          in it is off. Comments stay open until the plan is submitted. */}
      <fieldset className="lockable" disabled={isDesignLocked(plan)}>
      <Focusable kind="plan" id="summary" className="doc-block" labelledBy="summary-head">
        <h2 id="summary-head" className="doc-label">
          Summary
        </h2>
        <MarkdownField
          value={plan.summary}
          label="the plan summary"
          placeholder="No summary yet."
          emptyAction="Write one"
          onSave={(summary) => store.op({ op: 'set_meta', summary })}
        />
      </Focusable>

      {plan.sections.map((section, i) => (
        <SectionCard key={section.id} section={section} index={i} count={plan.sections.length} />
      ))}

      {!isDesignLocked(plan) && (
        <div className="doc-add">
          <AddField
            placeholder="New section title — e.g. Data model, Risks, Out of scope"
            label="New section title"
            onAdd={(title) => store.op({ op: 'upsert_section', title, body: '' })}
          />
        </div>
      )}

      </fieldset>

      {(!isLocked(plan) || plan.threads.some((t) => t.target.kind === 'plan')) && (
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
      <button type="button" role="listitem" className="glance-tile" onClick={() => store.setTab('diagrams')}>
        <span className="glance-label">Diagrams</span>
        <span className="glance-value">{plan.diagrams.length}</span>
        <span className="glance-sub">{plan.diagrams.map((d) => d.title).slice(0, 2).join(', ') || 'none yet'}</span>
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

function SectionCard({ section, index, count }: { section: Section; index: number; count: number }) {
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
          onSave={(title) => store.op({ op: 'upsert_section', id: section.id, title })}
        />
        <span className="item-id">{section.id}</span>
        <span className="spacer" />
        <CommentToggle target={target} label={section.title} open={comments} onToggle={() => setComments((v) => !v)} />
        <ItemActions
          label={section.title}
          index={index}
          count={count}
          onMove={(to) => store.op({ op: 'move_section', id: section.id, index: to })}
          onRemove={() => store.op({ op: 'remove', kind: 'section', id: section.id })}
        />
      </header>
      <MarkdownField
        value={section.body}
        label={`section "${section.title}"`}
        rows={8}
        version={section.rev}
        onSave={(body, rev) => store.op({ op: 'upsert_section', id: section.id, body, ...(rev !== undefined ? { expect: rev } : {}) })}
      />
      {comments && <ThreadPanel target={target} label={section.title} />}
    </Focusable>
  );
}
