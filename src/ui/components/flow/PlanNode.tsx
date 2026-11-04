import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { Handle, NodeToolbar, Position, useEdges, useNodes, type NodeProps } from '@xyflow/react';
import { usePlan } from '../../store.ts';
import { Markdown } from '../Markdown.tsx';
import { ProgressBar, STATUS_GLYPH, STATUS_LABEL } from '../Progress.tsx';
import { classNames } from '../../lib/format.ts';
import { KIND_GLYPH, KIND_LABEL, useCanvas, type FlowData, type FlowEdge, type FlowNode } from './shared.ts';

/** How a box relates to the one in focus, said on the box. The words carry
 *  the direction, so it never rests on colour alone. */
const REL_BADGE = { to: '→ to', from: 'from →', both: '⇄ both ways', to2: '→ then', from2: 'before →' } as const;
const REL_HINT = {
  to: 'Downstream: the box in focus has an arrow to this one',
  from: 'Upstream: this box has an arrow to the one in focus',
  both: 'Connected both ways, or without a direction',
  to2: 'Two steps downstream (hold Alt)',
  from2: 'Two steps upstream (hold Alt)',
} as const;

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const;

/**
 * A box on the canvas.
 *
 * Every side has a handle, and any handle starts an arrow: arrows are drawn
 * between whichever sides face each other, so where you grab from does not
 * matter. Double-click (or F2) renames it in place. The ⓘ in its corner
 * opens a summary on hover — what the part is, what was decided about it,
 * what builds it and what it talks to — without leaving the canvas.
 */
export function PlanNode({ id, data, selected }: NodeProps<FlowNode>) {
  const api = useCanvas();
  const editing = api.editing === `node:${id}`;
  const p = data.progress;
  const state = !p ? null : p.blocked ? 'blocked' : p.inProgress ? 'in_progress' : p.done === p.total ? 'done' : 'todo';
  const summary = useHoverSummary();
  const hasStory = Boolean(data.description?.trim() || data.notes?.trim());

  return (
    <div
      className={classNames(
        'flow-node',
        `kind-${data.kind}`,
        selected && 'is-selected',
        state && `progress-${state}`,
        editing && 'is-editing',
        data.rel && `rel-${data.rel}`,
        data.dropTarget && 'is-drop-target',
      )}
      style={{ width: data.width, minHeight: data.height }}
    >
      {data.rel && data.rel !== 'focus' && (
        <span className={`flow-node-rel rel-${data.rel}`} title={REL_HINT[data.rel]}>
          {REL_BADGE[data.rel]}
        </span>
      )}
      {SIDES.map(([side, position]) => (
        <Handle key={side} id={side} type="source" position={position} className={`handle-${side}`} />
      ))}
      <div className="flow-node-head">
        <span className="flow-node-glyph" aria-hidden="true">
          {KIND_GLYPH[data.kind]}
        </span>
        {editing ? (
          <LabelInput value={data.label} seed={api.editSeed} onDone={(label) => api.finishNodeLabel(id, label)} />
        ) : (
          <span className="flow-node-label">{data.label}</span>
        )}
        <button
          type="button"
          className={classNames('flow-node-info nodrag', hasStory && 'has-story', summary.open && 'is-open')}
          aria-label={`About ${data.label}`}
          aria-expanded={summary.open}
          onMouseEnter={summary.show}
          onMouseLeave={summary.hideSoon}
          onFocus={summary.show}
          onBlur={summary.hideNow}
          onKeyDown={(e) => {
            if (e.key === 'Escape') summary.hideNow();
          }}
        >
          <InfoIcon />
        </button>
      </div>
      {data.detail && <div className="flow-node-detail">{data.detail}</div>}
      {p && (
        <div
          className="flow-node-progress"
          title={`${p.done} of ${p.total} tasks done${p.inProgress ? `, ${p.inProgress} in progress` : ''}${p.blocked ? `, ${p.blocked} blocked` : ''}`}
        >
          <ProgressBar counts={p} compact />
          <span>
            {p.done}/{p.total}
          </span>
        </div>
      )}
      <NodeToolbar isVisible={summary.open} position={summary.side} align={summary.align} offset={10} className="flow-summary-layer">
        {summary.open && <NodeSummary id={id} data={data} onEnter={summary.keep} onLeave={summary.hideSoon} />}
      </NodeToolbar>
    </div>
  );
}

/**
 * Open on hover or focus, close a moment after the pointer leaves — long
 * enough to move into the summary to scroll it. Opens below a box near the
 * top of the canvas, so it is never cut off.
 */
function useHoverSummary() {
  const [side, setSide] = useState<Position | null>(null);
  const [align, setAlign] = useState<'start' | 'center' | 'end'>('center');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const keep = () => window.clearTimeout(timer.current);
  const show = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    keep();
    const box = e.currentTarget.closest('.react-flow__node')?.getBoundingClientRect();
    const frame = e.currentTarget.closest('.react-flow')?.getBoundingClientRect();
    const roomAbove = box && frame ? box.top - frame.top : 0;
    setSide(roomAbove > 300 ? Position.Top : Position.Bottom);
    // Centred on the box unless that would push it off one side of the canvas.
    const half = 170;
    const centre = box ? box.left + box.width / 2 : 0;
    setAlign(!box || !frame ? 'center' : centre - frame.left < half ? 'start' : frame.right - centre < half ? 'end' : 'center');
  };
  const hideSoon = () => {
    keep();
    timer.current = window.setTimeout(() => setSide(null), 140);
  };
  const hideNow = () => {
    keep();
    setSide(null);
  };
  return { open: side !== null, side: side ?? Position.Top, align, show, keep, hideSoon, hideNow };
}

function NodeSummary({ id, data, onEnter, onLeave }: { id: string; data: FlowData; onEnter: () => void; onLeave: () => void }) {
  const plan = usePlan();
  const edges = useEdges<FlowEdge>();
  const nodes = useNodes<FlowNode>();
  const name = (nid: string) => nodes.find((n) => n.id === nid)?.data.label ?? nid;
  const out = edges.filter((e) => e.source === id && e.target !== id);
  const into = edges.filter((e) => e.target === id && e.source !== id);
  const tasks = (data.taskIds ?? []).map((t) => plan?.tasks.find((x) => x.id === t)).filter((t) => t !== undefined);
  const SHOWN = 5;
  const hidden = Math.max(0, out.length - SHOWN) + Math.max(0, into.length - SHOWN);

  return (
    <div className="flow-summary" role="tooltip" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <header className="flow-summary-head">
        <span className={classNames('kind-swatch', `kind-${data.kind}`)} aria-hidden="true">
          {KIND_GLYPH[data.kind]}
        </span>
        <span className="panel-kicker">{KIND_LABEL[data.kind]}</span>
      </header>
      <p className="flow-summary-title">{data.label}</p>
      {data.detail && <p className="flow-summary-detail">{data.detail}</p>}

      {data.description?.trim() ? (
        <div className="flow-summary-body">
          <Markdown source={data.description} />
        </div>
      ) : (
        <p className="flow-summary-empty">No description yet. Select the box to write what it does.</p>
      )}

      {data.notes?.trim() && (
        <section className="flow-summary-section">
          <p className="flow-summary-label">Decisions</p>
          <div className="flow-summary-notes">
            <Markdown source={data.notes} />
          </div>
        </section>
      )}

      {tasks.length > 0 && (
        <section className="flow-summary-section">
          <p className="flow-summary-label">
            Built by
            {data.progress && (
              <span className="flow-summary-progress">
                <ProgressBar counts={data.progress} compact /> {data.progress.done}/{data.progress.total}
              </span>
            )}
          </p>
          <ul className="flow-summary-list">
            {tasks.slice(0, SHOWN).map((t) => (
              <li key={t.id}>
                <span className={classNames('status-dot is-static', `is-${t.status}`)} aria-label={STATUS_LABEL[t.status]}>
                  {STATUS_GLYPH[t.status]}
                </span>
                {t.title}
              </li>
            ))}
            {tasks.length > SHOWN && <li className="muted">and {tasks.length - SHOWN} more</li>}
          </ul>
        </section>
      )}

      {(out.length > 0 || into.length > 0) && (
        <section className="flow-summary-section">
          <p className="flow-summary-label">Connections</p>
          <ul className="flow-summary-list">
            {out.slice(0, SHOWN).map((e) => (
              <li key={e.id}>
                <span aria-hidden="true">{e.data?.arrows === 'both' ? '↔' : '→'}</span> {name(e.target)}
                {e.data?.label && <span className="muted"> · {e.data.label}</span>}
              </li>
            ))}
            {into.slice(0, SHOWN).map((e) => (
              <li key={e.id}>
                <span aria-hidden="true">{e.data?.arrows === 'both' ? '↔' : '←'}</span> {name(e.source)}
                {e.data?.label && <span className="muted"> · {e.data.label}</span>}
              </li>
            ))}
            {hidden > 0 && <li className="muted">and {hidden} more</li>}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The label as an input, on the box itself. Enter or leaving saves; Escape
 *  puts it back. */
export function LabelInput({
  value,
  seed,
  onDone,
  className = 'flow-node-input',
  placeholder,
}: {
  value: string;
  /** Typed over the old label, spreadsheet-style, with the caret after it. */
  seed?: string | null;
  onDone: (v: string | null) => void;
  className?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(seed ?? value);
  const seeded = useRef(Boolean(seed));
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // A box React Flow has not measured yet is hidden, and a hidden input
    // cannot take focus — keep trying for a few frames until it shows.
    let tries = 0;
    let frame = 0;
    const grab = () => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el) {
        if (tries++ < 20) frame = window.requestAnimationFrame(grab);
      } else if (seeded.current) el.setSelectionRange(el.value.length, el.value.length);
      else el.select();
    };
    grab();
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      className={classNames(className, 'nodrag nopan')}
      value={draft}
      aria-label="Rename"
      placeholder={placeholder}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(draft);
        if (e.key === 'Escape') finish(null);
        // Tab finishes the name and stays on the canvas, ready for the next
        // Tab to add the next box — not off to the next control on the page.
        if (e.key === 'Tab') {
          e.preventDefault();
          finish(draft);
        }
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="7.25" y="7" width="1.5" height="4.6" rx="0.75" fill="currentColor" />
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
    </svg>
  );
}
