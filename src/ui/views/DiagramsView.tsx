import { useMemo, useState } from 'react';
import { store, useAgent, usePlan, useStore } from '../store.ts';
import { InlineText, MarkdownField } from '../components/Editable.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { ThreadPanel } from '../components/Threads.tsx';
import { DiagramEditor, KIND_GLYPH, KIND_LABEL, type GraphPatch } from '../components/FlowCanvas.tsx';
import { EmptyState } from '../components/primitives.tsx';
import { SubmitControl } from '../components/Submit.tsx';
import { isDesignLocked, isLocked } from '../../shared/plan.ts';
import { classNames, relativeTime } from '../lib/format.ts';
import { diagramToMarkdown } from '../../shared/architecture.ts';
import { NODE_KINDS, type Diagram, type DiagramEdgeInput, type DiagramNodeInput, type Plan, type Proposal } from '../../shared/types.ts';
import { diagramDiff, previewDiagram, previewProposal } from '../../shared/proposals.ts';
import { ProposalCard } from '../components/Proposals.tsx';
import { useReservedNames } from '../components/TaskChecks.tsx';

/** Starting points for a new diagram. */
const TEMPLATES: { label: string; title: string; nodes: DiagramNodeInput[]; edges: DiagramEdgeInput[] }[] = [
  { label: 'Blank', title: 'New diagram', nodes: [], edges: [] },
  {
    label: 'Components',
    title: 'Components',
    nodes: [
      { id: 'client', label: 'Client', kind: 'actor', description: 'Whoever calls the API: a browser, an app, another service.' },
      { id: 'api', label: 'API', kind: 'service', description: 'Takes requests, applies the rules, and reads and writes the database.' },
      { id: 'db', label: 'Database', kind: 'datastore', description: 'The system of record.' },
    ],
    edges: [
      { source: 'client', target: 'api', label: 'HTTPS' },
      { source: 'api', target: 'db', label: 'reads / writes' },
    ],
  },
  {
    label: 'Pipeline',
    title: 'Data flow',
    nodes: [
      { id: 'source', label: 'Source', kind: 'external' },
      { id: 'queue', label: 'Queue', kind: 'queue' },
      { id: 'worker', label: 'Worker', kind: 'service' },
      { id: 'store', label: 'Store', kind: 'datastore' },
    ],
    edges: [
      { source: 'source', target: 'queue', label: 'events' },
      { source: 'queue', target: 'worker' },
      { source: 'worker', target: 'store' },
    ],
  },
];

/**
 * Where the architecture is decided. One diagram at a time fills the view:
 * the canvas takes most of it, and the panel beside it edits whatever is
 * selected — or, with nothing selected, the diagram itself.
 */
export function DiagramsView() {
  const agent = useAgent();
  const plan = usePlan();
  const chosen = useStore((s) => s.diagramId);
  const sessionId = useStore((s) => s.sessionId);
  const previewId = useStore((s) => s.proposalPreview);
  const proposal = plan?.proposals?.find((p) => p.id === previewId && p.status === 'open') ?? null;
  const reserved = useReservedNames();
  const preview = useMemo(() => (plan && proposal && reserved ? previewProposal(plan, proposal, { layout: true, reserved }) : null), [plan, proposal, reserved]);
  if (!plan) return null;
  if (proposal && preview?.after) return <ProposalPreviewView plan={plan} proposal={proposal} after={preview.after} chosen={chosen} />;
  const diagram = plan.diagrams.find((d) => d.id === chosen) ?? plan.diagrams[0] ?? null;
  // Confirmed or submitted: the design is settled, and the canvas only shows
  // it — boxes still fill up as the tasks that build them get done. While
  // the task list is being shaped, boxes can still be linked to tasks.
  const locked = isDesignLocked(plan);
  const tasking = locked && !isLocked(plan);

  return (
    <div className="arch">
      <div className="arch-bar">
        <nav className="arch-tabs" aria-label="Diagrams">
          {plan.diagrams.map((d) => (
            <button
              key={d.id}
              type="button"
              className={classNames('arch-tab', d.id === diagram?.id && 'is-active')}
              aria-current={d.id === diagram?.id ? 'true' : undefined}
              onClick={() => store.set({ diagramId: d.id })}
            >
              {d.title}
              <span className="arch-tab-count">{d.nodes.length}</span>
            </button>
          ))}
        </nav>
        {!locked && <NewDiagram />}
        <span className="spacer" />
        {tasking ? (
          <p className="toolbar-hint">The design is confirmed · select a box to link the tasks that build it</p>
        ) : locked ? (
          <p className="toolbar-hint">Hover a box to see its connections · each box fills up as the tasks that build it get done</p>
        ) : (
          <p className="toolbar-hint">
            Right-click for everything · <kbd>Tab</kbd> adds the next box · drag from a box's edge to connect ·{' '}
            <kbd>?</kbd> all shortcuts
          </p>
        )}
        <SubmitControl />
      </div>

      {diagram ? (
        <DiagramEditor
          // Every plan's first diagram is d1: keyed by the session too, so
          // switching sessions starts a fresh canvas rather than reusing one
          // full of the last plan's boxes.
          key={`${sessionId}:${diagram.id}`}
          diagram={diagram}
          plan={plan}
          readOnly={locked}
          {...(tasking
            ? {
                lockNote: 'The design is confirmed; reopen it to change the design. Task links can still change.',
                onLinkTasks: (nodeId: string, taskIds: string[]) => {
                  const nodes = diagram.nodes.map((n) => (n.id === nodeId ? { ...n, taskIds } : n));
                  // Against the diagram on screen, so links the agent added since are not undone.
                  void store.commit([{ op: 'upsert_diagram', id: diagram.id, nodes, expect: diagram.rev }], sessionId);
                },
              }
            : {})}
          onSave={async (patch: GraphPatch) => {
            const plan = await store.commit([{ op: 'upsert_diagram', id: diagram.id, ...patch }], sessionId);
            return plan?.diagrams.find((d) => d.id === diagram.id)?.rev ?? null;
          }}
          aside={<DiagramPanel plan={plan} diagram={diagram} locked={locked} />}
        />
      ) : (
        <div className="view-pad">
          <EmptyState
            title="No diagrams yet"
            hint={
              locked
                ? 'This plan was submitted without a diagram.'
                : `Ask ${agent.name} to draw the architecture — components, data flow, boundaries — or start one from a template.`
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * A proposal shown on the canvas: the diagram as it would be with it —
 * what it adds, changes and takes away marked — read-only, beside its
 * Accept and Reject. Nothing is saved from here.
 */
function ProposalPreviewView({ plan, proposal, after, chosen }: { plan: Plan; proposal: Proposal; after: Plan; chosen: string | null }) {
  const sessionId = useStore((s) => s.sessionId);
  // Every diagram either way: one the proposal removes is still shown, as an
  // empty diagram after it, so everything on it reads as removed.
  const gone = plan.diagrams.filter((d) => !after.diagrams.some((x) => x.id === d.id)).map((d) => ({ ...d, nodes: [], edges: [] }));
  const shown = [...after.diagrams, ...gone];
  const diagram = shown.find((d) => d.id === chosen) ?? shown[0] ?? null;
  const before = diagram ? plan.diagrams.find((d) => d.id === diagram.id) : undefined;
  const diff = useMemo(() => (diagram ? diagramDiff(before, diagram) : null), [before, diagram]);
  return (
    <div className="arch is-previewing">
      <div className="arch-bar">
        <nav className="arch-tabs" aria-label="Diagrams">
          {shown.map((d) => (
            <button
              key={d.id}
              type="button"
              className={classNames('arch-tab', d.id === diagram?.id && 'is-active')}
              aria-current={d.id === diagram?.id ? 'true' : undefined}
              onClick={() => store.set({ diagramId: d.id })}
            >
              {d.title}
              {!plan.diagrams.some((x) => x.id === d.id) && <span className="arch-tab-count">new</span>}
              {gone.some((x) => x.id === d.id) && <span className="arch-tab-count">removed</span>}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <p className="toolbar-hint" role="status">
          Previewing <strong>{proposal.id}</strong>: the plan as it would be. <span className="diff-key diff-key-added">added</span>{' '}
          <span className="diff-key diff-key-changed">changed</span> <span className="diff-key diff-key-removed">removed</span>
        </p>
        <button type="button" className="btn btn-sm" onClick={() => store.set({ proposalPreview: null })}>
          Close preview
        </button>
      </div>
      {diagram && diff ? (
        <DiagramEditor
          key={`${sessionId}:preview:${proposal.id}:${diagram.id}:${plan.version}`}
          diagram={previewDiagram(diagram, diff)}
          plan={after}
          readOnly
          lockNote={`A preview of ${proposal.id}: accept it to make it so`}
          diff={diff}
          onSave={async () => null}
          aside={
            <div className="arch-panel-body">
              <ProposalCard plan={plan} proposal={proposal} compact />
            </div>
          }
        />
      ) : (
        <div className="view-pad">
          <ProposalCard plan={plan} proposal={proposal} compact />
        </div>
      )}
    </div>
  );
}

function NewDiagram() {
  const [open, setOpen] = useState(false);
  const add = async (t: (typeof TEMPLATES)[number]) => {
    setOpen(false);
    const before = new Set(store.getState().session?.plan?.diagrams.map((d) => d.id));
    if (await store.op({ op: 'upsert_diagram', title: t.title, nodes: t.nodes, edges: t.edges })) {
      const made = store.getState().session?.plan?.diagrams.find((d) => !before.has(d.id));
      if (made) store.set({ diagramId: made.id });
    }
  };
  return (
    <div className="add-menu">
      <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        + New diagram
      </button>
      {open && (
        <div className="add-menu-list" role="menu">
          {TEMPLATES.map((t) => (
            <button key={t.label} type="button" role="menuitem" className="add-menu-item" onClick={() => void add(t)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The panel with nothing selected: the diagram as a whole. */
function DiagramPanel({ plan, diagram, locked }: { plan: Plan; diagram: Diagram; locked: boolean }) {
  const agent = useAgent();
  const [confirming, setConfirming] = useState(false);
  const index = plan.diagrams.findIndex((d) => d.id === diagram.id);
  const linked = diagram.nodes.filter((n) => n.taskIds?.length).length;
  return (
    <div className="arch-panel-body" aria-label={`About ${diagram.title}`}>
      <header className="panel-top">
        <span className="panel-kicker">Diagram</span>
        <span className="item-id">{diagram.id}</span>
        <span className="spacer" />
        <span className="muted panel-meta">
          {locked ? 'locked' : `${diagram.updatedBy === 'user' ? 'edited by you' : `by ${agent.name}`} · ${relativeTime(diagram.updatedAt)}`}
        </span>
      </header>
      <InlineText
        as="h2"
        className="panel-title"
        value={diagram.title}
        label="Diagram title"
        readOnly={locked}
        onSave={(title) => store.op({ op: 'upsert_diagram', id: diagram.id, title })}
      />
      {locked ? (
        diagram.caption ? (
          <Markdown source={diagram.caption} />
        ) : null
      ) : (
      <MarkdownField
        value={diagram.caption ?? ''}
        label={`caption of "${diagram.title}"`}
        placeholder="What this diagram shows."
        emptyAction="Describe it"
        rows={3}
        // No revision check: the diagram's revision moves with every drag on
        // the canvas, so it would flag the user's own layout edits as a
        // conflict. A caption is short and only ever edited here.
        onSave={(caption) => store.op({ op: 'upsert_diagram', id: diagram.id, caption })}
      />
      )}
      <p className="panel-hint">
        {diagram.nodes.length} boxes, {diagram.edges.length} arrows{linked ? `, ${linked} tracking tasks` : ''}.{' '}
        {isLocked(plan)
          ? 'The plan is submitted, so this is the final design. Select a box to read its details and how far the tasks that build it have got.'
          : locked
            ? 'The design is confirmed. Select a box to read it and link the tasks that build it.'
            : 'Select a box to edit its details, decisions and the tasks that build it.'}
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-sm"
          title={`The diagram as ${agent.name} reads it: every part, what it does and what was decided, then every connection`}
          onClick={() => {
            const text = diagramToMarkdown(diagram, { tasks: plan.tasks });
            void navigator.clipboard
              ?.writeText(text)
              .then(() => store.toast('success', 'Copied the diagram as Markdown.'))
              .catch(() => store.toast('error', 'The browser would not let the page use the clipboard.'));
          }}
        >
          Copy as Markdown
        </button>
      </div>
      <ul className="kind-legend" aria-label="Box kinds">
        {NODE_KINDS.map((k) => (
          <li key={k}>
            <span className={classNames('kind-swatch', `kind-${k}`)} aria-hidden="true">
              {KIND_GLYPH[k]}
            </span>
            {KIND_LABEL[k]}
          </li>
        ))}
      </ul>
      {/* Locked, comments are read, not written: show them only if there are any. */}
      {(!isLocked(plan) || plan.threads.some((t) => t.target.kind === 'diagram' && t.target.id === diagram.id)) && (
        <fieldset className="lockable" disabled={isLocked(plan)}>
          <div className="field">
            <span className="field-label">Comments</span>
            <ThreadPanel target={{ kind: 'diagram', id: diagram.id }} label={diagram.title} />
          </div>
        </fieldset>
      )}
      {!locked && (
      <footer className="panel-foot">
        <button type="button" className="link" disabled={index <= 0} onClick={() => void store.op({ op: 'move_diagram', id: diagram.id, index: index - 1 })}>
          Move left
        </button>
        <button
          type="button"
          className="link"
          disabled={index >= plan.diagrams.length - 1}
          onClick={() => void store.op({ op: 'move_diagram', id: diagram.id, index: index + 1 })}
        >
          Move right
        </button>
        <span className="spacer" />
        {confirming ? (
          <span className="item-confirm">
            Remove?
            <button type="button" className="link is-danger" onClick={() => void store.op({ op: 'remove', kind: 'diagram', id: diagram.id })}>
              Remove
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="link is-danger" onClick={() => setConfirming(true)}>
            Remove diagram
          </button>
        )}
      </footer>
      )}
    </div>
  );
}
