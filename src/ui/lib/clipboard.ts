import { EDGE_ARROWS, NODE_KINDS, type DiagramEdge, type DiagramNode, type NodeKind } from '../../shared/types.ts';

/**
 * Copy and paste on the canvas.
 *
 * A copied selection is boxes — everything written on them, and where they
 * sat relative to each other — plus the arrows that run between them. It
 * travels as JSON text on the system clipboard, so it pastes into another
 * diagram, another plan or another tab; anything that is not a selection is
 * left to the browser.
 */

export const CLIP_KIND = 'cc-harness/diagram-selection';

export type ClipNode = Pick<DiagramNode, 'id' | 'label' | 'kind' | 'detail' | 'description' | 'notes' | 'taskIds'> & { x: number; y: number };
export type ClipEdge = Pick<DiagramEdge, 'source' | 'target' | 'label' | 'dashed' | 'arrows'>;

export interface Clip {
  kind: typeof CLIP_KIND;
  version: 1;
  nodes: ClipNode[];
  edges: ClipEdge[];
}

/** The selection as a clip. Arrows come along only when both ends do. */
export function toClip(nodes: ClipNode[], edges: ClipEdge[]): Clip | null {
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  return {
    kind: CLIP_KIND,
    version: 1,
    nodes: nodes.map((n) => strip({ ...n })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => strip({ ...e })),
  };
}

export function serializeClip(clip: Clip): string {
  return JSON.stringify(clip);
}

/** A clip from clipboard text, or null for anything else. Checked field by
 *  field: the clipboard is shared with every other app. */
export function parseClip(text: string | null | undefined): Clip | null {
  if (!text || !text.includes(CLIP_KIND)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as Partial<Clip> | null;
  if (!r || r.kind !== CLIP_KIND || !Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const nodes: ClipNode[] = [];
  for (const n of r.nodes.slice(0, 120) as unknown[]) {
    const o = n as Record<string, unknown>;
    const id = str(o?.['id'], 60);
    if (!id || nodes.some((x) => x.id === id)) continue;
    nodes.push(
      strip({
        id,
        label: str(o['label'], 120) ?? id,
        kind: (NODE_KINDS as readonly string[]).includes(o['kind'] as string) ? (o['kind'] as NodeKind) : 'component',
        detail: str(o['detail'], 400),
        description: str(o['description'], 4000),
        notes: str(o['notes'], 20_000),
        taskIds: Array.isArray(o['taskIds']) ? (o['taskIds'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
        x: num(o['x']),
        y: num(o['y']),
      }),
    );
  }
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const edges: ClipEdge[] = [];
  for (const e of r.edges.slice(0, 300) as unknown[]) {
    const o = e as Record<string, unknown>;
    const source = str(o?.['source'], 60);
    const target = str(o?.['target'], 60);
    if (!source || !target || !ids.has(source) || !ids.has(target)) continue;
    const arrows = (EDGE_ARROWS as readonly string[]).includes(o['arrows'] as string) ? (o['arrows'] as ClipEdge['arrows']) : undefined;
    edges.push(strip({ source, target, label: str(o['label'], 120), dashed: o['dashed'] === true ? true : undefined, arrows: arrows === ('end' as string) ? undefined : arrows }));
  }
  return { kind: CLIP_KIND, version: 1, nodes, edges };
}

export interface Pasted {
  nodes: ClipNode[];
  edges: ClipEdge[];
}

/**
 * The clip as new boxes for a diagram: ids that collide get a suffix
 * (`cache` → `cache-2`), links to tasks the plan does not have are dropped,
 * and the group is moved by `offset`, keeping its shape.
 */
export function pasteClip(clip: Clip, taken: Iterable<string>, tasks: Set<string>, offset: { x: number; y: number }): Pasted {
  const used = new Set(taken);
  const ids = new Map<string, string>();
  for (const n of clip.nodes) {
    const id = freeId(n.id, used);
    used.add(id);
    ids.set(n.id, id);
  }
  const nodes = clip.nodes.map((n) =>
    strip({
      ...n,
      id: ids.get(n.id)!,
      taskIds: n.taskIds?.filter((t) => tasks.has(t)),
      x: Math.round(n.x + offset.x),
      y: Math.round(n.y + offset.y),
    }),
  );
  const edges = clip.edges.map((e) => ({ ...e, source: ids.get(e.source)!, target: ids.get(e.target)! }));
  return { nodes, edges };
}

/** The top-left corner of a clip's boxes. */
export function clipOrigin(clip: Clip): { x: number; y: number } {
  return { x: Math.min(...clip.nodes.map((n) => n.x)), y: Math.min(...clip.nodes.map((n) => n.y)) };
}

/** `cache` → `cache-2` → `cache-3`, keeping within the 60-character id limit. */
export function freeId(wanted: string, used: Set<string>): string {
  if (!used.has(wanted)) return wanted;
  const base = wanted.replace(/-\d+$/, '').slice(0, 54);
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

function strip<T extends object>(o: T): T {
  for (const key of Object.keys(o) as (keyof T)[]) {
    const v = o[key];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete o[key];
  }
  return o;
}
