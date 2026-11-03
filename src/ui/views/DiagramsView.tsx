import { useState } from 'react';
import { store, usePlan, useStore } from '../store.ts';
import { InlineText, MarkdownField } from '../components/Editable.tsx';
import { ThreadPanel } from '../components/Threads.tsx';
import { DiagramEditor, KIND_GLYPH, KIND_LABEL, type GraphPatch } from '../components/FlowCanvas.tsx';
import { EmptyState } from '../components/primitives.tsx';
import { classNames, relativeTime } from '../lib/format.ts';
import { diagramToMarkdown } from '../../shared/architecture.ts';
import { NODE_KINDS, type Diagram, type DiagramEdgeInput, type DiagramNodeInput, type Plan } from '../../shared/types.ts';

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
  const plan = usePlan();
  const chosen = useStore((s) => s.diagramId);
  if (!plan) return null;
  const diagram = plan.diagrams.find((d) => d.id === chosen) ?? plan.diagrams[0] ?? null;

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
        <NewDiagram />
        <span className="spacer" />
        <p className="toolbar-hint">
          Double-click to add a box · drag from a box's edge to connect · ⓘ for a summary · <kbd>⌘C</kbd> <kbd>⌘V</kbd> copy and paste ·{' '}
          <kbd>⌫</kbd> deletes
        </p>
      </div>

      {diagram ? (
        <DiagramEditor
          key={diagram.id}
          diagram={diagram}
          plan={plan}
          onSave={async (patch: GraphPatch) => {
            const plan = await store.commit([{ op: 'upsert_diagram', id: diagram.id, ...patch }]);
            return plan?.diagrams.find((d) => d.id === diagram.id)?.rev ?? null;
          }}
          aside={<DiagramPanel plan={plan} diagram={diagram} />}
        />
      ) : (
        <div className="view-pad">
          <EmptyState
            title="No diagrams yet"
            hint="Ask Claude to draw the architecture — components, data flow, boundaries — or start one from a template."
          />
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
function DiagramPanel({ plan, diagram }: { plan: Plan; diagram: Diagram }) {
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
          {diagram.updatedBy === 'user' ? 'edited by you' : 'by Claude'} · {relativeTime(diagram.updatedAt)}
        </span>
      </header>
      <InlineText
        as="h2"
        className="panel-title"
        value={diagram.title}
        label="Diagram title"
        onSave={(title) => store.op({ op: 'upsert_diagram', id: diagram.id, title })}
      />
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
      <p className="panel-hint">
        {diagram.nodes.length} boxes, {diagram.edges.length} arrows{linked ? `, ${linked} tracking tasks` : ''}. Select a box
        to edit its details, decisions and the tasks that build it.
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-sm"
          title="The diagram as Claude reads it: every part, what it does and what was decided, then every connection"
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
      <div className="field">
        <span className="field-label">Comments</span>
        <ThreadPanel target={{ kind: 'diagram', id: diagram.id }} label={diagram.title} />
      </div>
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
    </div>
  );
}
