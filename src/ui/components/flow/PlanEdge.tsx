import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, useInternalNode, type EdgeProps, type InternalNode } from '@xyflow/react';
import { classNames } from '../../lib/format.ts';
import { clipToRect, facingSides, loopPath, midpoint, sidePoint, splinePath, type Rect, type Side } from '../../lib/geometry.ts';
import { samePoint } from '../../lib/layout.ts';
import { LabelInput } from './PlanNode.tsx';
import { useCanvas, type FlowEdge, type FlowNode } from './shared.ts';

const POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

/**
 * An arrow on the canvas. It follows the route the automatic layout gave it
 * for as long as both of its boxes stay where that layout put them, and runs
 * between their facing sides once either is moved. Its label sits on the
 * canvas as text — double-click it, or the arrow, to edit it there.
 */
export function PlanEdge({ id, source, target, data, markerEnd, markerStart, selected, style }: EdgeProps<FlowEdge>) {
  const api = useCanvas();
  const from = useInternalNode<FlowNode>(source);
  const to = useInternalNode<FlowNode>(target);
  if (!from || !to) return null;
  const a = rectOf(from);
  const b = rectOf(to);
  if (!a.width || !b.width) return null;

  let path: string;
  let label: { x: number; y: number };
  /** Where the arrow meets each box, for the grips that move its ends. */
  let ends: [{ x: number; y: number }, { x: number; y: number }] | null = null;
  const route = data?.route;
  if (source === target) {
    ({ path, label } = loopPath(a));
  } else if (route && route.points.length >= 2 && samePoint(route.from, a) && samePoint(route.to, b)) {
    // Dagre's ends sit on its estimate of each box; put them on the real one.
    const pts = route.points.map((p) => ({ ...p }));
    pts[0] = clipToRect(a, pts[1]!);
    pts[pts.length - 1] = clipToRect(b, pts[pts.length - 2]!);
    path = splinePath(pts);
    label = route.label ?? midpoint(pts);
    ends = [pts[0]!, pts[pts.length - 1]!];
  } else {
    const [sa, sb] = facingSides(a, b, api.direction);
    const lane = data?.lane ?? 0;
    const s = sidePoint(a, sa, lane);
    const t = sidePoint(b, sb, lane);
    const [p, lx, ly] = getBezierPath({ sourceX: s.x, sourceY: s.y, sourcePosition: POSITION[sa], targetX: t.x, targetY: t.y, targetPosition: POSITION[sb], curvature: 0.3 });
    path = p;
    label = { x: lx, y: ly };
    ends = [s, t];
  }

  const editing = api.editing === `edge:${id}`;
  const text = data?.label;
  const rel = data?.rel;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={style}
        interactionWidth={22}
        className={classNames(rel && `rel-${rel}`, data?.dropTarget && 'is-drop-target')}
      />
      {data?.grips && ends && (
        <EdgeLabelRenderer>
          {(['source', 'target'] as const).map((end, i) => (
            <button
              key={end}
              type="button"
              className={`flow-edge-grip nodrag nopan is-${end}`}
              style={{ transform: `translate(-50%, -50%) translate(${ends![i]!.x}px, ${ends![i]!.y}px)` }}
              aria-label={end === 'source' ? 'Drag to move where this arrow starts' : 'Drag to move where this arrow ends'}
              title={end === 'source' ? 'Drag onto another box to start the arrow there' : 'Drag onto another box to end the arrow there'}
              onPointerEnter={() => api.hoverEdge(id)}
              onPointerLeave={() => api.hoverEdge(null)}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                api.startReconnect(id, end, e);
              }}
            />
          ))}
        </EdgeLabelRenderer>
      )}
      {(text || editing) && (
        <EdgeLabelRenderer>
          <div
            className={classNames(
              'flow-edge-label nodrag nopan',
              selected && 'is-selected',
              data?.dashed && 'is-dashed',
              editing && 'is-editing',
              rel && `rel-${rel}`,
              data?.dim && 'is-dim',
            )}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
            onClick={() => api.selectEdge(id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              api.startEditing(`edge:${id}`);
            }}
            title="Double-click to edit"
          >
            {editing ? (
              <LabelInput value={text ?? ''} className="flow-edge-input" placeholder="What flows along it" onDone={(v) => api.finishEdgeLabel(id, v)} />
            ) : (
              text
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function rectOf(n: InternalNode<FlowNode>): Rect {
  return {
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    width: n.measured.width ?? n.width ?? n.data.width,
    height: n.measured.height ?? n.height ?? n.data.height,
  };
}
