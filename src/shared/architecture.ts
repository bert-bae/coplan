/**
 * Diagrams as words.
 *
 * A diagram on the canvas is boxes, arrows and coordinates. What Claude needs
 * is the system it describes: which parts there are, what each one is for,
 * what was decided about it, and what talks to what. This module is the one
 * translation between the two, used for everything Claude reads and for
 * "Copy as Markdown" in the browser, so both always say the same thing.
 *
 * Two rules hold throughout:
 *
 * - **Only the design, never the drawing.** Positions, the layout direction
 *   and revision counters say nothing about the architecture and are never
 *   rendered.
 * - **Final state, not history.** A change summary compares what Claude last
 *   read with what is there now. A box added and deleted again, or renamed
 *   three times, is reported once in its final form — or not at all.
 *
 * Everything here is pure, so it renders the same in the daemon, the browser
 * and the tests.
 */
import type { Diagram, DiagramEdge, DiagramNode, NodeKind, PlanBaseline, Task } from './types.ts';
import { flowRanks, matchEdges } from './plan.ts';

/** What each kind of box is, in words. */
export const KIND_NOUN: Record<NodeKind, string> = {
  component: 'component',
  service: 'service',
  datastore: 'data store',
  queue: 'queue',
  external: 'external system',
  actor: 'actor',
  note: 'note',
};

const STATUS_MARK = { todo: '[ ]', in_progress: '[~]', blocked: '[!]', done: '[x]', dropped: '[-]' } as const;

/** The parts of a diagram the translation reads: no layout. */
export type DiagramContent = Pick<Diagram, 'id' | 'title' | 'caption' | 'edges'> & {
  nodes: Omit<DiagramNode, 'x' | 'y'>[];
};

export interface ArchitectureOptions {
  /** Tasks, so a box can name the tasks that build it and their status. */
  tasks?: Pick<Task, 'id' | 'title' | 'status'>[];
  /** Heading level for the diagram's title. Default 3. */
  level?: number;
  /** Show ids (`api`, `t2`) so the text can be quoted back in an edit.
   *  Default true; off for prose meant for people. */
  ids?: boolean;
  /** A line under the heading, e.g. "edited by the user". */
  note?: string;
}

/**
 * The whole diagram as an architecture description, in markdown.
 *
 * Parts come in the order the flow reaches them — where requests enter
 * first, the stores they end in last — so the list reads like a walk through
 * the system. Each part carries its role, its description, the decisions
 * recorded on it and the tasks that build it. Connections follow, one per
 * line, each with what flows along it.
 */
export function diagramToMarkdown(diagram: DiagramContent, opts: ArchitectureOptions = {}): string {
  const ids = opts.ids ?? true;
  const hashes = '#'.repeat(Math.min(6, Math.max(1, opts.level ?? 3)));
  const out: string[] = [`${hashes} ${ids ? `[${diagram.id}] ` : ''}${diagram.title}`];
  if (opts.note) out.push(`_${opts.note}_`);
  if (diagram.caption?.trim()) out.push('', diagram.caption.trim());

  const nodes = diagram.nodes;
  if (nodes.length === 0) {
    out.push('', '_No parts yet._');
    return out.join('\n');
  }

  const label = labeller(diagram);
  const ref = (n: { id: string; label: string }) => (ids ? `${n.label} (\`${n.id}\`)` : n.label);
  const { ordered, notes, isolated } = flowOrder(diagram);

  const shape = shapeOf(diagram, ordered);
  if (shape) out.push('', shape);

  if (ordered.length) {
    out.push('', '**Parts**');
    for (const n of ordered) out.push(...renderPart(n, opts, ids));
  }
  if (isolated.length) {
    out.push('', `_Not connected to anything yet: ${isolated.map((n) => n.label).join(', ')}._`);
  }

  if (diagram.edges.length) {
    out.push('', '**Connections**');
    const rank = new Map(ordered.map((n, i) => [n.id, i]));
    const edges = [...diagram.edges].sort(
      (a, b) => (rank.get(a.source) ?? 1e9) - (rank.get(b.source) ?? 1e9) || (rank.get(a.target) ?? 1e9) - (rank.get(b.target) ?? 1e9),
    );
    // An arrow's id is `source->target` unless it says otherwise (a second
    // arrow between the same boxes, one drawn in the browser).
    const own = (e: DiagramEdge) => (e.id !== `${e.source}->${e.target}` ? ` (arrow \`${e.id}\`)` : '');
    for (const e of edges) out.push(`- ${edgePhrase(e, label)}${ids ? ` \`${e.source} ${ARROW[e.arrows ?? 'end']} ${e.target}\`${own(e)}` : ''}`);
  }

  if (notes.length) {
    out.push('', '**Notes on the diagram**');
    for (const n of notes) {
      out.push(`- ${ref(n)}`);
      for (const text of [n.detail, n.description, n.notes]) if (text?.trim()) out.push(...indent(text, 2));
    }
  }
  return out.join('\n');
}

function renderPart(n: DiagramContent['nodes'][number], opts: ArchitectureOptions, ids: boolean): string[] {
  const head = `- **${n.label}**${ids ? ` \`${n.id}\`` : ''} — ${KIND_NOUN[n.kind]}${n.detail ? `: ${oneLine(n.detail)}` : ''}`;
  const lines = [head];
  if (n.description?.trim()) lines.push(...indent(n.description, 2));
  if (n.notes?.trim()) lines.push('  Decisions:', ...indent(n.notes, 4));
  if (n.taskIds?.length) {
    const named = n.taskIds.map((id) => {
      const task = opts.tasks?.find((t) => t.id === id);
      if (!task) return ids ? id : null;
      return `${STATUS_MARK[task.status]} ${ids ? `${id} ` : ''}${task.title}`;
    });
    const list = named.filter(Boolean);
    if (list.length) lines.push(`  Built by: ${list.join('; ')}`);
  }
  return lines;
}

const ARROW = { end: '→', both: '↔', none: '—' } as const;

/** "API gateway → Orders API: REST (dashed: optional, async or future)" */
export function edgePhrase(e: Pick<DiagramEdge, 'source' | 'target' | 'label' | 'dashed' | 'arrows'>, label: (id: string) => string): string {
  const flags = [e.dashed ? 'dashed: optional, async or future' : '', e.arrows === 'none' ? 'no direction' : ''].filter(Boolean);
  return `${label(e.source)} ${ARROW[e.arrows ?? 'end']} ${label(e.target)}${e.label ? `: ${oneLine(e.label)}` : ''}${flags.length ? ` (${flags.join('; ')})` : ''}`;
}

/** One line on the system's outline: where it starts, where state lives,
 *  what it leans on outside itself. */
function shapeOf(diagram: DiagramContent, ordered: DiagramContent['nodes']): string | null {
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const e of diagram.edges) {
    if (e.source === e.target) continue;
    outgoing.add(e.source);
    incoming.add(e.target);
    if (e.arrows === 'both' || e.arrows === 'none') {
      outgoing.add(e.target);
      incoming.add(e.source);
    }
  }
  const names = (pick: (n: DiagramContent['nodes'][number]) => boolean) => ordered.filter(pick).map((n) => n.label);
  const parts: [string, string[]][] = [
    ['Entry points', names((n) => outgoing.has(n.id) && !incoming.has(n.id))],
    ['Data stores', names((n) => n.kind === 'datastore')],
    ['Queues', names((n) => n.kind === 'queue')],
    ['External systems', names((n) => n.kind === 'external')],
  ];
  const said = parts.filter(([, list]) => list.length).map(([what, list]) => `${what}: ${list.join(', ')}.`);
  return said.length ? said.join(' ') : null;
}

/**
 * Parts in flow order: connected ones by how far along the flow they sit
 * (ties keep the order they were written in), then unconnected ones. Notes
 * are annotations rather than parts, and are kept apart.
 */
export function flowOrder(diagram: Pick<DiagramContent, 'nodes' | 'edges'>): {
  ordered: DiagramContent['nodes'];
  notes: DiagramContent['nodes'];
  isolated: DiagramContent['nodes'];
} {
  const ranks = flowRanks(diagram.nodes, diagram.edges);
  const index = new Map(diagram.nodes.map((n, i) => [n.id, i]));
  const parts = diagram.nodes.filter((n) => n.kind !== 'note');
  const connected = parts.filter((n) => ranks.has(n.id)).sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)! || index.get(a.id)! - index.get(b.id)!);
  const isolated = parts.filter((n) => !ranks.has(n.id));
  return { ordered: [...connected, ...isolated], notes: diagram.nodes.filter((n) => n.kind === 'note'), isolated };
}

/* ------------------------------------------------------------------ *
 * What changed, as a net difference
 * ------------------------------------------------------------------ */

export interface DiffOptions {
  /** Quote the new text of edited prose. Off when the full document follows
   *  anyway, where repeating it would only make the read longer. */
  withText?: boolean;
  ids?: boolean;
}

/**
 * How a diagram's design differs between two versions, one line per fact.
 * Empty when only the drawing changed.
 */
export function diagramChanges(before: DiagramContent, after: DiagramContent, opts: DiffOptions = {}): string[] {
  const ids = opts.ids ?? true;
  const out: string[] = [];
  const named = (id: string) => after.nodes.find((n) => n.id === id)?.label ?? before.nodes.find((n) => n.id === id)?.label ?? id;
  // A connection names its ends by label — and by id too when two boxes
  // share a label, or "Connected API → Cache" would not say which Cache.
  const counts = new Map<string, number>();
  for (const n of new Map([...before.nodes, ...after.nodes].map((n) => [n.id, n])).values()) counts.set(named(n.id), (counts.get(named(n.id)) ?? 0) + 1);
  const label = (id: string) => (ids && (counts.get(named(id)) ?? 0) > 1 ? `${named(id)} (\`${id}\`)` : named(id));
  const ref = (n: { id: string; label: string }) => (ids ? `${n.label} (\`${n.id}\`)` : n.label);

  if (before.title !== after.title) out.push(`Renamed the diagram "${before.title}" → "${after.title}".`);
  if ((before.caption ?? '') !== (after.caption ?? '')) out.push(...prose('Edited the caption', after.caption, opts));

  // Grouped so the summary reads the way a reviewer would say it: what is
  // new, what is gone, what is different, and then how they are wired.
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const n of after.nodes) {
    const b = before.nodes.find((x) => x.id === n.id);
    if (!b) {
      added.push(`Added ${ref(n)} — ${KIND_NOUN[n.kind]}${n.detail ? `: ${oneLine(n.detail)}` : ''}.`);
      if (opts.withText) {
        if (n.description?.trim()) added.push(...indent(n.description, 2));
        if (n.notes?.trim()) added.push('  Decisions:', ...indent(n.notes, 4));
      }
      continue;
    }
    const facts: string[] = [];
    if (b.label !== n.label) facts.push(`renamed from "${b.label}"`);
    if (b.kind !== n.kind) facts.push(`now a ${KIND_NOUN[n.kind]} (was a ${KIND_NOUN[b.kind]})`);
    if ((b.detail ?? '') !== (n.detail ?? '')) facts.push(n.detail ? `subtitle "${oneLine(n.detail)}"` : 'subtitle removed');
    const texts: [string, string | undefined, string | undefined][] = [
      ['description', b.description, n.description],
      ['decisions', b.notes, n.notes],
    ];
    const editedText = texts.filter(([, was, now]) => (was ?? '').trim() !== (now ?? '').trim());
    for (const [what, , now] of editedText) facts.push(now?.trim() ? `${what} edited` : `${what} removed`);
    const was = b.taskIds ?? [];
    const now = n.taskIds ?? [];
    if ([...was].sort().join() !== [...now].sort().join()) facts.push(now.length ? `built by ${now.join(', ')}${was.length ? ` (was ${was.join(', ')})` : ''}` : 'no longer linked to tasks');
    if (!facts.length) continue;
    changed.push(`Changed ${ref(n)}: ${facts.join('; ')}.`);
    if (opts.withText) {
      for (const [what, , text] of editedText) {
        if (text?.trim()) changed.push(`  ${what[0]!.toUpperCase()}${what.slice(1)} now:`, ...indent(text, 4));
      }
    }
  }
  for (const b of before.nodes) {
    if (!after.nodes.some((n) => n.id === b.id)) removed.push(`Removed ${ref(b)}.`);
  }
  out.push(...added, ...removed, ...changed);

  // Connections pair up by identity, then by their ends (see matchEdges):
  // a redrawn arrow between the same two parts is the same connection, and
  // two arrows between the same parts stay two.
  const { pairs, removed: cut, added: drawn } = matchEdges(before.edges, after.edges);
  const connected: string[] = [];
  const disconnected: string[] = [];
  const restyled: string[] = [];
  const unclaimed = [...drawn];
  for (const e of cut) {
    // Gone one way and new the other way between the same parts: reversed.
    // Each new arrow can only be the reversal of one old one.
    const back = (a: DiagramEdge) => a.source === e.target && a.target === e.source;
    const same = unclaimed.findIndex((a) => back(a) && (a.label ?? '') === (e.label ?? ''));
    const k = same >= 0 ? same : unclaimed.findIndex(back);
    if (k >= 0) {
      const [now] = unclaimed.splice(k, 1);
      restyled.push(`Reversed ${label(e.source)} → ${label(e.target)}: it now runs ${edgePhrase(now!, label)}.`);
    } else {
      disconnected.push(`Disconnected ${edgePhrase(e, label)}.`);
    }
  }
  for (const e of unclaimed) connected.push(`Connected ${edgePhrase(e, label)}.`);
  for (const [b, e] of pairs) {
    const facts: string[] = [];
    if ((b.label ?? '') !== (e.label ?? '')) facts.push(e.label ? `now labelled "${oneLine(e.label)}"` : 'label removed');
    if (Boolean(b.dashed) !== Boolean(e.dashed)) facts.push(e.dashed ? 'now dashed (optional, async or future)' : 'now solid');
    if ((b.arrows ?? 'end') !== (e.arrows ?? 'end')) facts.push({ end: 'now one way', both: 'now both ways', none: 'now without direction' }[e.arrows ?? 'end']);
    if (facts.length) restyled.push(`Changed ${label(e.source)} → ${label(e.target)}: ${facts.join('; ')}.`);
  }
  out.push(...connected, ...disconnected, ...restyled);
  return out;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** The diagram's content as a baseline holds it. */
export function contentOf(diagram: Diagram | PlanBaseline['diagrams'][number]): DiagramContent {
  return {
    id: diagram.id,
    title: diagram.title,
    ...(diagram.caption ? { caption: diagram.caption } : {}),
    nodes: diagram.nodes.map(({ x: _x, y: _y, ...n }: DiagramNode) => n),
    edges: diagram.edges,
  };
}

function labeller(diagram: Pick<DiagramContent, 'nodes'>): (id: string) => string {
  const names = new Map(diagram.nodes.map((n) => [n.id, n.label]));
  return (id) => names.get(id) ?? id;
}

function prose(what: string, text: string | undefined, opts: DiffOptions): string[] {
  if (!text?.trim()) return [`${what.replace(/^Edited/, 'Removed')}.`];
  return opts.withText ? [`${what}:`, ...indent(text, 2)] : [`${what}.`];
}

export function indent(text: string, by: number): string[] {
  const pad = ' '.repeat(by);
  // Indented under a list item, a heading the user wrote would still read
  // as one of the document's own: it is kept as bold text instead.
  return nestHeadings(text.trim(), 6)
    .split('\n')
    .map((line) => (line.trim() ? `${pad}${line.trimEnd()}` : ''));
}

/** Text that continues a list item: its first line as is, the rest
 *  indented `by`, so a multi-line comment stays inside its item. */
export function hang(text: string, by: number): string {
  return nestHeadings(text.trim(), 6)
    .split('\n')
    .map((line, i) => (i === 0 || !line.trim() ? line.trimEnd() : `${' '.repeat(by)}${line.trimEnd()}`))
    .join('\n');
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * User prose placed under one of the document's headings, at level
 * `under`: its own headings move down below that level, so a section body
 * holding "## Tasks" cannot start a second Tasks part of the prompt. Past
 * level 6 a heading becomes bold text. Code blocks are left alone.
 */
export function nestHeadings(text: string, under: number): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(```|~~~)/.exec(line)?.[1];
      if (marker && (!fence || fence === marker)) {
        fence = fence ? null : marker;
        return line;
      }
      if (fence) return line;
      const m = HEADING.exec(line);
      if (!m) return line;
      const level = m[1]!.length + under;
      return level <= 6 ? `${'#'.repeat(level)} ${m[2]}` : `**${m[2]}**`;
    })
    .join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}
