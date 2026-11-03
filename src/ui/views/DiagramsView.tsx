import { useEffect, useState } from 'react';
import { store, usePlan } from '../store.ts';
import { InlineText, MarkdownField } from '../components/Editable.tsx';
import { CommentToggle, ThreadPanel } from '../components/Threads.tsx';
import { Focusable, ItemActions } from '../components/Item.tsx';
import { FlowCanvas, type GraphPatch } from '../components/FlowCanvas.tsx';
import { EmptyState } from '../components/primitives.tsx';
import { classNames, relativeTime } from '../lib/format.ts';
import type { Diagram, DiagramEdgeInput, DiagramNodeInput } from '../../shared/types.ts';

/** Starting points for a new diagram. */
const TEMPLATES: { label: string; title: string; nodes: DiagramNodeInput[]; edges: DiagramEdgeInput[] }[] = [
  { label: 'Blank', title: 'New diagram', nodes: [], edges: [] },
  {
    label: 'Components',
    title: 'Components',
    nodes: [
      { id: 'client', label: 'Client', kind: 'actor' },
      { id: 'api', label: 'API', kind: 'service' },
      { id: 'db', label: 'Database', kind: 'datastore' },
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
 * The architecture, as pictures you can rearrange. Each diagram is a React
 * Flow canvas: drag boxes, draw arrows between handles, select something to
 * relabel it, Backspace to delete. Claude publishes the same nodes and edges,
 * and reads back exactly what you changed.
 */
export function DiagramsView() {
  const plan = usePlan();
  const [adding, setAdding] = useState(false);
  if (!plan) return null;

  const add = async (t: (typeof TEMPLATES)[number]) => {
    setAdding(false);
    await store.op({ op: 'upsert_diagram', title: t.title, nodes: t.nodes, edges: t.edges });
  };

  return (
    <div className="view-pad">
      <div className="toolbar">
        <p className="toolbar-hint">
          {plan.diagrams.length
            ? 'Drag boxes to arrange them, drag from a handle to connect, select to edit, Backspace to delete.'
            : 'No diagrams yet.'}
        </p>
        <span className="spacer" />
        <div className="add-menu">
          <button type="button" className="btn btn-sm" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
            + New diagram
          </button>
          {adding && (
            <div className="add-menu-list is-right" role="menu">
              {TEMPLATES.map((t) => (
                <button key={t.label} type="button" role="menuitem" className="add-menu-item" onClick={() => void add(t)}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {plan.diagrams.length === 0 ? (
        <EmptyState
          title="No diagrams yet"
          hint="Ask Claude to draw the architecture — components, data flow, boundaries — or start one from a template."
        />
      ) : (
        <div className="diagram-list">
          {plan.diagrams.map((d, i) => (
            <DiagramCard key={d.id} diagram={d} index={i} count={plan.diagrams.length} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiagramCard({ diagram, index, count }: { diagram: Diagram; index: number; count: number }) {
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState(false);
  const target = { kind: 'diagram' as const, id: diagram.id };

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !(el && (el.tagName === 'INPUT' || el.tagName === 'SELECT'))) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const save = (patch: GraphPatch) => store.op({ op: 'upsert_diagram', id: diagram.id, ...patch });

  return (
    <Focusable kind="diagram" id={diagram.id} as="article" className={classNames('diagram-card', expanded && 'is-expanded')}>
      <header className="item-head">
        <InlineText
          as="h2"
          className="section-title"
          value={diagram.title}
          label="Diagram title"
          onSave={(title) => store.op({ op: 'upsert_diagram', id: diagram.id, title })}
        />
        <span className="item-id">{diagram.id}</span>
        <span className="muted item-when">
          {diagram.nodes.length} boxes · {diagram.updatedBy === 'user' ? 'edited by you' : 'by Claude'} · {relativeTime(diagram.updatedAt)}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost" aria-pressed={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Exit full screen' : 'Full screen'}
        </button>
        <CommentToggle target={target} label={diagram.title} open={comments} onToggle={() => setComments((v) => !v)} />
        {!expanded && (
          <ItemActions
            label={diagram.title}
            index={index}
            count={count}
            onMove={(to) => store.op({ op: 'move_diagram', id: diagram.id, index: to })}
            onRemove={() => store.op({ op: 'remove', kind: 'diagram', id: diagram.id })}
          />
        )}
      </header>

      <FlowCanvas diagram={diagram} onSave={save} expanded={expanded} />

      {!expanded && (
        <MarkdownField
          className="diagram-caption"
          value={diagram.caption ?? ''}
          label={`caption of "${diagram.title}"`}
          placeholder="No caption."
          emptyAction="Add a caption"
          rows={3}
          onSave={(caption) => store.op({ op: 'upsert_diagram', id: diagram.id, caption })}
        />
      )}

      {comments && <ThreadPanel target={target} label={diagram.title} />}
    </Focusable>
  );
}
