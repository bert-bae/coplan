import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { store, useAgent } from '../../store.ts';
import { MarkdownField } from '../Editable.tsx';
import { Markdown } from '../Markdown.tsx';
import { STATUS_GLYPH, STATUS_LABEL } from '../Progress.tsx';
import { classNames } from '../../lib/format.ts';
import { isLocked, outline } from '../../../shared/plan.ts';
import { NODE_KINDS, type NodeKind, type Plan, type Target } from '../../../shared/types.ts';
import { ThreadPanel } from '../Threads.tsx';
import { KIND_GLYPH, KIND_HINT, KIND_LABEL, type EdgePatch, type FlowEdge, type FlowNode, type NodePatch } from './shared.ts';

/**
 * The details panel beside the canvas.
 *
 * Each field is the shape of what goes in it. A name, a subtitle and an
 * arrow's label are one line, so they are inputs that save on Enter. A
 * description is a paragraph, so it is a textarea that grows as you write
 * and is always ready to type into — no edit button to find first. Notes
 * and decisions are long-form markdown, so they render as markdown and open
 * into an editor.
 */

/* ------------------------------------------------------------------ *
 * Fields
 * ------------------------------------------------------------------ */

/**
 * A field's draft. While the user is in the field it is theirs: a change the
 * agent publishes to the same box never replaces what they have not saved,
 * and `changed` says one came in. Out of the field it follows the plan, so a
 * save the plan refused or reshaped shows as the plan has it.
 */
function useFieldDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const startedAt = useRef(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  return {
    draft,
    setDraft,
    changed: editing && value !== startedAt.current && draft.trim() !== value.trim(),
    enter: () => {
      startedAt.current = value;
      setEditing(true);
    },
    leave: () => setEditing(false),
    /** Escape: take the plan's text, the newer one if it changed. */
    revert: () => setDraft(value),
  };
}

/** Said in the field when the agent changed it while the user was typing. */
function ChangedWhileTyping() {
  return (
    <span className="md-conflict" role="alert">
      This changed while you were typing. Leaving the field keeps your text; Esc takes the new one.
    </span>
  );
}

/** One line. Saves on Enter or leaving the field; Escape puts it back. */
export function CommitInput({
  value,
  label,
  placeholder,
  className,
  maxLength,
  onCommit,
}: {
  value: string;
  label: string;
  placeholder?: string;
  className?: string;
  maxLength?: number;
  onCommit: (v: string) => void;
}) {
  const { draft, setDraft, changed, enter, leave, revert } = useFieldDraft(value);
  const live = useRef({ draft, value, onCommit });
  live.current = { draft, value, onCommit };
  // Switching to another box unmounts the field without a blur in some
  // browsers; whatever was typed is saved all the same.
  useEffect(
    () => () => {
      const { draft, value, onCommit } = live.current;
      if (draft.trim() !== value.trim()) onCommit(draft.trim());
    },
    [],
  );
  const commit = () => {
    if (draft.trim() === value.trim()) return;
    onCommit(draft.trim());
    // Saved: an unmount in the same render (a session switch blurs, then
    // removes the view) has nothing left to save.
    live.current.value = draft.trim();
  };
  return (
    <>
      <input
        className={classNames('input', className)}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={enter}
        onBlur={() => {
          commit();
          leave();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            revert();
          }
        }}
      />
      {changed && <ChangedWhileTyping />}
    </>
  );
}

/**
 * A paragraph. Grows with its text, saves when you leave it or press
 * ⌘/Ctrl+Enter; Escape puts it back. Plain Enter is a new line.
 */
export function CommitTextArea({
  value,
  label,
  placeholder,
  minRows = 3,
  maxLength,
  onCommit,
}: {
  value: string;
  label: string;
  placeholder?: string;
  minRows?: number;
  maxLength?: number;
  onCommit: (v: string) => void;
}) {
  const { draft, setDraft, changed, enter, leave, revert } = useFieldDraft(value);
  const area = useRef<HTMLTextAreaElement>(null);
  const live = useRef({ draft, value, onCommit });
  live.current = { draft, value, onCommit };
  useEffect(
    () => () => {
      const { draft, value, onCommit } = live.current;
      if (draft.trim() !== value.trim()) onCommit(draft.trim());
    },
    [],
  );
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight + 2, 420)}px`;
  }, [draft]);
  const commit = () => {
    if (draft.trim() === value.trim()) return;
    onCommit(draft.trim());
    live.current.value = draft.trim();
  };
  return (
    <>
      <textarea
        ref={area}
        className="input text-area"
        value={draft}
        rows={minRows}
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={enter}
        onBlur={() => {
          commit();
          leave();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
            area.current?.blur();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            revert();
          }
        }}
      />
      {changed && <ChangedWhileTyping />}
    </>
  );
}

function KindPicker({ value, onChange, label }: { value: NodeKind | null; onChange: (k: NodeKind) => void; label: string }) {
  return (
    <div className="kind-picker" role="radiogroup" aria-label={label}>
      {NODE_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          aria-label={KIND_LABEL[k]}
          title={`${KIND_LABEL[k]} — ${KIND_HINT[k]}`}
          className={classNames('kind-option', `kind-${k}`, value === k && 'is-active')}
          onClick={() => onChange(k)}
        >
          <span className="kind-swatch" aria-hidden="true">
            {KIND_GLYPH[k]}
          </span>
        </button>
      ))}
      <span className="kind-picker-name">{value ? KIND_LABEL[value] : 'Mixed'}</span>
    </div>
  );
}

function Segmented<T extends string>({ value, options, label, onChange }: { value: T; options: [T, string, string][]; label: string; onChange: (v: T) => void }) {
  return (
    <div className="segmented is-small" role="radiogroup" aria-label={label}>
      {options.map(([v, text, title]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} title={title} className={classNames('seg', value === v && 'is-active')} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A box
 * ------------------------------------------------------------------ */

export function NodePanel({
  node,
  nodes,
  edges,
  plan,
  onChange,
  onSelect,
  onConnect,
  onDisconnect,
  onAddConnected,
  onDuplicate,
  onRemove,
  onClose,
  commentTarget,
  diagramId,
}: {
  node: FlowNode;
  nodes: FlowNode[];
  edges: FlowEdge[];
  plan: Plan;
  /** The diagram the box is in: names its notes' kept draft. */
  diagramId: string;
  /** Where comments on this box live, once it is saved. */
  commentTarget?: Target;
  onChange: (patch: NodePatch) => void;
  onSelect: (kind: 'node' | 'edge', id: string) => void;
  onConnect: (target: string) => void;
  onDisconnect: (edgeId: string) => void;
  onAddConnected: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const agent = useAgent();
  const [confirming, setConfirming] = useState(false);
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const outgoing = edges.filter((e) => e.source === node.id);
  const incoming = edges.filter((e) => e.target === node.id && e.source !== node.id);
  const linked = node.data.taskIds ?? [];
  const rows = outline(plan);
  const linkable = rows.filter((r) => !linked.includes(r.task.id));
  const unconnected = nodes.filter((n) => n.id !== node.id && !outgoing.some((e) => e.target === n.id));

  return (
    <div className="arch-panel-body" aria-label={`Details of ${node.data.label}`}>
      <header className="panel-top">
        <span className={classNames('kind-swatch', `kind-${node.data.kind}`)} aria-hidden="true">
          {KIND_GLYPH[node.data.kind]}
        </span>
        <span className="panel-kicker">{KIND_LABEL[node.data.kind]}</span>
        <span className="item-id" title={`Id — how ${agent.name} refers to this box`}>
          {node.id}
        </span>
        <span className="spacer" />
        <button type="button" className="icon-btn is-tiny" aria-label="Close details" title="Back to the diagram" onClick={onClose}>
          ×
        </button>
      </header>

      <CommitInput
        className="panel-title-input"
        value={node.data.label}
        label="Box label"
        maxLength={120}
        onCommit={(label) => label && onChange({ label })}
      />

      <div className="field">
        <span className="field-label">Kind</span>
        <KindPicker value={node.data.kind} label="Kind" onChange={(kind) => onChange({ kind })} />
      </div>

      <label className="field">
        <span className="field-label">
          On the box <span className="field-aside">a few words: technology or role</span>
        </span>
        <CommitInput value={node.data.detail ?? ''} label="Box detail" placeholder="e.g. Redis, read-through" maxLength={80} onCommit={(detail) => onChange({ detail })} />
      </label>

      <label className="field">
        <span className="field-label">
          Description <span className="field-aside">shown when hovering ⓘ</span>
        </span>
        <CommitTextArea
          value={node.data.description ?? ''}
          label={`Description of ${node.data.label}`}
          placeholder="What this part does, what it owns, and how other parts talk to it."
          maxLength={4000}
          onCommit={(description) => onChange({ description })}
        />
      </label>

      <div className="field">
        <span className="field-label">Notes and decisions</span>
        <MarkdownField
          value={node.data.notes ?? ''}
          label={`notes on ${node.data.label}`}
          placeholder="What was decided about this part, and why."
          emptyAction="Add a decision"
          rows={6}
          draftKey={`notes:${diagramId}/${node.id}`}
          onSave={(notes) => onChange({ notes })}
        />
      </div>

      <div className="field">
        <span className="field-label">Built by</span>
        {linked.length > 0 ? (
          <ul className="panel-tasks">
            {linked.map((id) => {
              const task = plan.tasks.find((t) => t.id === id);
              if (!task) return null;
              return (
                <li key={id}>
                  <span className={classNames('status-dot is-static', `is-${task.status}`)} title={STATUS_LABEL[task.status]} aria-label={STATUS_LABEL[task.status]}>
                    {STATUS_GLYPH[task.status]}
                  </span>
                  <button type="button" className="link panel-task" onClick={() => store.focus('task', id)}>
                    {task.title}
                  </button>
                  <button type="button" className="icon-btn is-tiny" aria-label={`Unlink ${task.title}`} title="Unlink" onClick={() => onChange({ taskIds: linked.filter((t) => t !== id) })}>
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted panel-empty">No tasks linked. Link the tasks that build this part to see its progress on the box.</p>
        )}
        {linkable.length > 0 && (
          <select className="input" aria-label={`Link a task to ${node.data.label}`} value="" onChange={(e) => e.target.value && onChange({ taskIds: [...linked, e.target.value] })}>
            <option value="">Link a task…</option>
            {linkable.map(({ task, number, depth }) => (
              <option key={task.id} value={task.id}>
                {' '.repeat(depth * 3)}
                {number} {task.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {commentTarget && <PartComments plan={plan} target={commentTarget} label={node.data.label} />}

      <div className="field">
        <span className="field-label">Connections</span>
        {outgoing.length + incoming.length > 0 ? (
          <ul className="panel-links">
            {outgoing.map((e) => (
              <li key={e.id}>
                <button type="button" className="link" onClick={() => onSelect('edge', e.id)}>
                  {e.data?.arrows === 'both' ? '↔' : '→'} {name(e.target)}
                </button>
                {e.data?.label && <span className="muted"> {e.data.label}</span>}
                <span className="spacer" />
                <button type="button" className="icon-btn is-tiny" aria-label={`Remove connection to ${name(e.target)}`} title="Disconnect" onClick={() => onDisconnect(e.id)}>
                  ×
                </button>
              </li>
            ))}
            {incoming.map((e) => (
              <li key={e.id}>
                <button type="button" className="link" onClick={() => onSelect('edge', e.id)}>
                  {e.data?.arrows === 'both' ? '↔' : '←'} {name(e.source)}
                </button>
                {e.data?.label && <span className="muted"> {e.data.label}</span>}
                <span className="spacer" />
                <button type="button" className="icon-btn is-tiny" aria-label={`Remove connection from ${name(e.source)}`} title="Disconnect" onClick={() => onDisconnect(e.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted panel-empty">Not connected. Drag from any edge of the box to another box, or into space for a new one.</p>
        )}
        <div className="row-actions">
          {unconnected.length > 0 && (
            <select className="input" aria-label={`Connect ${node.data.label} to`} value="" onChange={(e) => e.target.value && onConnect(e.target.value)}>
              <option value="">Connect to…</option>
              {unconnected.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.data.label}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-sm" onClick={onAddConnected} title="A new box, connected from this one">
            + Connected box
          </button>
        </div>
      </div>

      <footer className="panel-foot">
        <button type="button" className="link" onClick={onDuplicate} title="⌘/Ctrl+D">
          Duplicate
        </button>
        <span className="spacer" />
        {confirming ? (
          <span className="item-confirm">
            Delete this box and its arrows?
            <button type="button" className="link is-danger" onClick={onRemove}>
              Delete
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="link is-danger" onClick={() => setConfirming(true)}>
            Delete box
          </button>
        )}
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * An arrow
 * ------------------------------------------------------------------ */

export function EdgePanel({
  edge,
  nodes,
  plan,
  commentTarget,
  onChange,
  onReverse,
  onSelect,
  onRemove,
  onClose,
}: {
  edge: FlowEdge;
  nodes: FlowNode[];
  plan?: Plan;
  /** Where comments on this arrow live, once it is saved. */
  commentTarget?: Target;
  onChange: (patch: EdgePatch) => void;
  onReverse: () => void;
  onSelect: (kind: 'node' | 'edge', id: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const ends = (which: 'source' | 'target') => (
    <select className="input" aria-label={which === 'source' ? 'From' : 'To'} value={edge[which]} onChange={(e) => onChange({ [which]: e.target.value })}>
      {nodes.map((n) => (
        <option key={n.id} value={n.id} disabled={n.id === (which === 'source' ? edge.target : edge.source)}>
          {n.data.label}
        </option>
      ))}
    </select>
  );
  return (
    <div className="arch-panel-body" aria-label="Details of the selected arrow">
      <header className="panel-top">
        <span className="panel-kicker">Connection</span>
        <span className="spacer" />
        <button type="button" className="icon-btn is-tiny" aria-label="Close details" title="Back to the diagram" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="panel-edge">
        <button type="button" className="link" onClick={() => onSelect('node', edge.source)}>
          {name(edge.source)}
        </button>
        <span aria-hidden="true"> {edge.data?.arrows === 'both' ? '↔' : edge.data?.arrows === 'none' ? '—' : '→'} </span>
        <button type="button" className="link" onClick={() => onSelect('node', edge.target)}>
          {name(edge.target)}
        </button>
      </p>

      <label className="field">
        <span className="field-label">What flows along it</span>
        <CommitInput value={edge.data?.label ?? ''} label="Arrow label" placeholder="e.g. REST, publishes events" maxLength={120} onCommit={(label) => onChange({ label })} />
      </label>

      <div className="field">
        <span className="field-label">Joins</span>
        <div className="edge-ends">
          {ends('source')}
          <button type="button" className="icon-btn" aria-label="Reverse direction" title="Reverse direction" onClick={onReverse}>
            ⇄
          </button>
          {ends('target')}
        </div>
      </div>

      <div className="field-row">
        <div className="field-col">
          <span className="field-label">Line</span>
          <Segmented
            label="Line"
            value={edge.data?.dashed ? 'dashed' : 'solid'}
            options={[
              ['solid', 'Solid', 'A connection that is always there'],
              ['dashed', 'Dashed', 'Optional, async or future'],
            ]}
            onChange={(v) => onChange({ dashed: v === 'dashed' })}
          />
        </div>
        <div className="field-col">
          <span className="field-label">Arrowheads</span>
          <Segmented
            label="Arrowheads"
            value={edge.data?.arrows ?? 'end'}
            options={[
              ['end', '→', 'One way, from the first box to the second'],
              ['both', '↔', 'Both ways'],
              ['none', '—', 'No direction'],
            ]}
            onChange={(v) => onChange({ arrows: v === 'end' ? undefined : v })}
          />
        </div>
      </div>

      <p className="panel-hint">Or drag either end of the arrow on the canvas onto another box.</p>

      {commentTarget && <PartComments plan={plan} target={commentTarget} label={`${name(edge.source)} → ${name(edge.target)}`} />}

      <footer className="panel-foot">
        <button type="button" className="link is-danger" onClick={onRemove}>
          Delete connection
        </button>
      </footer>
    </div>
  );
}

/**
 * Comments on one box or arrow — where a remark about "this cache" belongs,
 * rather than on the whole diagram. Shown while the plan can be commented
 * on, and afterwards wherever there are comments to read.
 */
function PartComments({ plan, target, label }: { plan: Plan | undefined; target: Target; label: string }) {
  const any = plan?.threads.some((t) => t.target.kind === target.kind && t.target.id === target.id);
  if (!plan || (isLocked(plan) && !any)) return null;
  return (
    <div className="field">
      <span className="field-label">Comments</span>
      <ThreadPanel target={target} label={label} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Several at once
 * ------------------------------------------------------------------ */

export function SelectionPanel({
  nodes,
  edges,
  onKind,
  onCopy,
  onDuplicate,
  onRemove,
  onClose,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  onKind: (kind: NodeKind) => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const kinds = new Set(nodes.map((n) => n.data.kind));
  const kind = kinds.size === 1 ? [...kinds][0]! : null;
  return (
    <div className="arch-panel-body" aria-label="Details of the selection">
      <header className="panel-top">
        <span className="panel-kicker">Selection</span>
        <span className="spacer" />
        <button type="button" className="icon-btn is-tiny" aria-label="Clear selection" title="Clear selection" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="panel-hint">
        {nodes.length} box{nodes.length === 1 ? '' : 'es'} and {edges.length} arrow{edges.length === 1 ? '' : 's'} selected.
      </p>
      {nodes.length > 0 && (
        <div className="field">
          <span className="field-label">Kind of every box</span>
          <KindPicker value={kind} label="Kind of every selected box" onChange={onKind} />
        </div>
      )}
      <div className="row-actions">
        {nodes.length > 0 && (
          <>
            <button type="button" className="btn btn-sm" onClick={onCopy} title="⌘/Ctrl+C">
              Copy
            </button>
            <button type="button" className="btn btn-sm" onClick={onDuplicate} title="⌘/Ctrl+D">
              Duplicate
            </button>
          </>
        )}
        <button type="button" className="btn btn-sm btn-danger" onClick={onRemove}>
          Delete selection
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A submitted plan: reading, not editing
 * ------------------------------------------------------------------ */

/**
 * What the panel shows once the plan is submitted. The design is final, so
 * nothing here edits it; what is still live is how far the tasks behind
 * each box have got, and every task jumps to its card on the board.
 */
export function ReadOnlyPanel({
  nodes,
  edges,
  selectedNodes,
  selectedEdges,
  plan,
  onSelect,
  onClose,
  onLinkTasks,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNodes: FlowNode[];
  selectedEdges: FlowEdge[];
  plan: Plan;
  onSelect: (kind: 'node' | 'edge', id: string) => void;
  onClose: () => void;
  /** Set while the design is confirmed and the tasks are still being shaped. */
  onLinkTasks?: (nodeId: string, taskIds: string[]) => void;
}) {
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const close = (
    <button type="button" className="icon-btn is-tiny" aria-label="Close details" title="Back to the diagram" onClick={onClose}>
      ×
    </button>
  );

  if (selectedNodes.length === 1 && selectedEdges.length === 0) {
    const node = selectedNodes[0]!;
    const outgoing = edges.filter((e) => e.source === node.id);
    const incoming = edges.filter((e) => e.target === node.id && e.source !== node.id);
    const tasks = (node.data.taskIds ?? []).map((id) => plan.tasks.find((t) => t.id === id)).filter((t) => t !== undefined);
    return (
      <div className="arch-panel-body is-readonly" aria-label={`Details of ${node.data.label}`}>
        <header className="panel-top">
          <span className={classNames('kind-swatch', `kind-${node.data.kind}`)} aria-hidden="true">
            {KIND_GLYPH[node.data.kind]}
          </span>
          <span className="panel-kicker">{KIND_LABEL[node.data.kind]}</span>
          <span className="item-id">{node.id}</span>
          <span className="spacer" />
          {close}
        </header>
        <h2 className="panel-title">{node.data.label}</h2>
        {node.data.detail && <p className="panel-hint">{node.data.detail}</p>}
        {node.data.description && (
          <div className="field">
            <span className="field-label">Description</span>
            <Markdown source={node.data.description} />
          </div>
        )}
        {node.data.notes && (
          <div className="field">
            <span className="field-label">Notes and decisions</span>
            <Markdown source={node.data.notes} />
          </div>
        )}
        <div className="field">
          <span className="field-label">Built by</span>
          {tasks.length ? (
            <ul className="panel-tasks">
              {tasks.map((task) => (
                <li key={task.id}>
                  <span className={classNames('status-dot is-static', `is-${task.status}`)} title={STATUS_LABEL[task.status]} aria-label={STATUS_LABEL[task.status]}>
                    {STATUS_GLYPH[task.status]}
                  </span>
                  <button
                    type="button"
                    className="link panel-task"
                    title={onLinkTasks ? 'Show it in the task list' : 'Show it on the board'}
                    onClick={() => store.focus('task', task.id)}
                  >
                    {task.title}
                  </button>
                  {onLinkTasks && (
                    <button
                      type="button"
                      className="icon-btn is-tiny"
                      aria-label={`Unlink ${task.title}`}
                      title="Unlink"
                      onClick={() => onLinkTasks(node.id, (node.data.taskIds ?? []).filter((t) => t !== task.id))}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted panel-empty">No tasks are linked to this part.</p>
          )}
          {onLinkTasks && (
            <select
              className="input"
              aria-label={`Link a task to ${node.data.label}`}
              value=""
              onChange={(e) => e.target.value && onLinkTasks(node.id, [...(node.data.taskIds ?? []), e.target.value])}
            >
              <option value="">Link a task…</option>
              {outline(plan)
                .filter((r) => !(node.data.taskIds ?? []).includes(r.task.id))
                .map(({ task, number, depth }) => (
                  <option key={task.id} value={task.id}>
                    {' '.repeat(depth * 3)}
                    {number} {task.title}
                  </option>
                ))}
            </select>
          )}
        </div>
        {outgoing.length + incoming.length > 0 && (
          <div className="field">
            <span className="field-label">Connections</span>
            <ul className="panel-links">
              {outgoing.map((e) => (
                <li key={e.id}>
                  <button type="button" className="link" onClick={() => onSelect('edge', e.id)}>
                    {e.data?.arrows === 'both' ? '↔' : '→'} {name(e.target)}
                  </button>
                  {e.data?.label && <span className="muted"> {e.data.label}</span>}
                </li>
              ))}
              {incoming.map((e) => (
                <li key={e.id}>
                  <button type="button" className="link" onClick={() => onSelect('edge', e.id)}>
                    {e.data?.arrows === 'both' ? '↔' : '←'} {name(e.source)}
                  </button>
                  {e.data?.label && <span className="muted"> {e.data.label}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (selectedEdges.length === 1 && selectedNodes.length === 0) {
    const edge = selectedEdges[0]!;
    const how = edge.data?.arrows === 'both' ? 'both ways' : edge.data?.arrows === 'none' ? 'no direction' : 'one way';
    return (
      <div className="arch-panel-body is-readonly" aria-label="Details of the connection">
        <header className="panel-top">
          <span className="panel-kicker">Connection</span>
          <span className="spacer" />
          {close}
        </header>
        <h2 className="panel-title">
          <button type="button" className="link" onClick={() => onSelect('node', edge.source)}>
            {name(edge.source)}
          </button>{' '}
          {edge.data?.arrows === 'both' ? '↔' : edge.data?.arrows === 'none' ? '—' : '→'}{' '}
          <button type="button" className="link" onClick={() => onSelect('node', edge.target)}>
            {name(edge.target)}
          </button>
        </h2>
        <p className="panel-hint">
          {edge.data?.label ? `Carries: ${edge.data.label}. ` : ''}
          {edge.data?.dashed ? 'Dashed: optional, async or later. ' : ''}
          {how[0]!.toUpperCase() + how.slice(1)}.
        </p>
      </div>
    );
  }

  return (
    <div className="arch-panel-body is-readonly" aria-label="Selection">
      <header className="panel-top">
        <span className="panel-kicker">Selection</span>
        <span className="spacer" />
        {close}
      </header>
      <p className="panel-hint">
        {selectedNodes.length} box{selectedNodes.length === 1 ? '' : 'es'} and {selectedEdges.length} arrow{selectedEdges.length === 1 ? '' : 's'} selected. Select
        one to read about it.
      </p>
    </div>
  );
}
