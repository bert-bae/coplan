import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionMode, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react';
import { toPng } from 'html-to-image';
import { store } from '../store.ts';
import { planDocument } from '../../artifact/render.ts';
import type { Diagram, Plan } from '../../shared/types.ts';
import { PlanNode } from './flow/PlanNode.tsx';
import { PlanEdge } from './flow/PlanEdge.tsx';
import { toFlow } from './flow/convert.ts';
import { CanvasContext, type CanvasApi } from './flow/shared.ts';

const nodeTypes = { plan: PlanNode };
const edgeTypes = { plan: PlanEdge };
const PAD = 40;
const noop = () => {};

/**
 * Saves the overview and architecture as a PDF: each diagram is drawn off
 * screen, read-only, and taken as a PNG, then the document goes to the
 * browser's print dialog, where "Save as PDF" writes the file.
 */
export function PdfExport({ plan, onDone }: { plan: Plan; onDone: () => void }) {
  return (
    <Snapshots
      plan={plan}
      diagrams={plan.diagrams}
      onDone={(pictures) => {
        printHtml(planDocument(plan, pictures));
        onDone();
      }}
    />
  );
}

/** Saves one diagram as a `.png` file, named after it. */
export function PngExport({ plan, diagram, onDone }: { plan: Plan; diagram: Diagram; onDone: () => void }) {
  return (
    <Snapshots
      plan={plan}
      diagrams={[diagram]}
      onDone={(pictures) => {
        const png = pictures.get(diagram.id);
        if (png) {
          const a = document.createElement('a');
          a.href = png;
          a.download = `${diagram.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'diagram'}.png`;
          a.click();
        } else store.toast('error', 'Could not draw the diagram as a picture.');
        onDone();
      }}
    />
  );
}

/** Draws each diagram off screen, one at a time, and hands over their PNGs by diagram id. */
function Snapshots({ plan, diagrams, onDone }: { plan: Plan; diagrams: Diagram[]; onDone: (pictures: Map<string, string>) => void }) {
  const [pictures] = useState(() => new Map<string, string>());
  const [at, setAt] = useState(0);
  const diagram = diagrams[at];
  const done = useRef(false);

  useEffect(() => {
    // Once: the plan or onDone can change while the parent re-renders.
    if (diagram || done.current) return;
    done.current = true;
    onDone(pictures);
  }, [diagram, pictures, onDone]);

  if (!diagram) return null;
  return (
    // Off screen, but laid out: React Flow measures the boxes before the edges can be drawn.
    <div aria-hidden="true" style={{ position: 'fixed', left: -100_000, top: 0, width: 1600, height: 1000 }}>
      <ReactFlowProvider key={diagram.id}>
        <Snapshot
          diagram={diagram}
          plan={plan}
          onPicture={(png) => {
            if (png) pictures.set(diagram.id, png);
            setAt((i) => i + 1);
          }}
        />
      </ReactFlowProvider>
    </div>
  );
}

function Snapshot({ diagram, plan, onPicture }: { diagram: Diagram; plan: Plan; onPicture: (png: string | null) => void }) {
  const { nodes, edges } = useMemo(() => {
    const flow = toFlow(diagram, plan);
    // html-to-image copies an <svg>'s children without their stylesheet rules: the stroke has to be inline.
    const stroke = getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim() || 'gray';
    return { nodes: flow.nodes, edges: flow.edges.map((e) => ({ ...e, style: { ...e.style, stroke, strokeWidth: 1.25 } })) };
  }, [diagram, plan]);
  const flow = useReactFlow();
  const ready = useNodesInitialized();
  const box = useRef<HTMLDivElement>(null);
  const api = useMemo<CanvasApi>(
    () => ({
      direction: diagram.direction,
      editing: null,
      editSeed: null,
      tasksOpen: null,
      tasksEditable: false,
      startEditing: noop,
      startReconnect: noop,
      hoverEdge: noop,
      finishNodeLabel: noop,
      finishEdgeLabel: noop,
      selectEdge: noop,
      showTasks: noop,
      unlinkTask: noop,
      addTask: async () => false,
    }),
    [diagram.direction],
  );

  useEffect(() => {
    if (nodes.length && !ready) return;
    let live = true;
    let frame = 0;
    let tries = 0;
    const take = () => {
      const viewport = box.current?.querySelector<HTMLElement>('.react-flow__viewport');
      if (!viewport || !nodes.length) return onPicture(null);
      // Arrows draw a few frames after the boxes are measured; give up waiting after ~1s.
      if (viewport.querySelectorAll('.react-flow__edge').length < edges.length && ++tries < 60) {
        frame = requestAnimationFrame(take);
        return;
      }
      const b = flow.getNodesBounds(nodes.map((n) => n.id));
      const width = b.width + PAD * 2;
      const height = b.height + PAD * 2;
      toPng(viewport, {
        width,
        height,
        pixelRatio: 2,
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        filter: (el) => !(el instanceof Element && el.classList.contains('react-flow__handle')),
        style: { width: `${width}px`, height: `${height}px`, transform: `translate(${PAD - b.x}px, ${PAD - b.y}px)` },
      })
        .then((png) => live && onPicture(png))
        .catch(() => live && onPicture(null));
    };
    frame = requestAnimationFrame(take);
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
    // onPicture changes every render; the picture is taken once, when ready.
  }, [ready, nodes, edges, flow]);

  return (
    <CanvasContext.Provider value={api}>
      <div ref={box} style={{ width: '100%', height: '100%' }}>
        <ReactFlow defaultNodes={nodes} defaultEdges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} connectionMode={ConnectionMode.Loose} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }} />
      </div>
    </CanvasContext.Provider>
  );
}

/** Prints the document from a hidden frame, so no popup blocker gets in the way. */
function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return frame.remove();
    win.addEventListener('afterprint', () => frame.remove());
    win.focus();
    win.print();
  };
  frame.srcdoc = html;
  document.body.append(frame);
  store.toast('success', 'Choose "Save as PDF" in the print dialog.');
}
