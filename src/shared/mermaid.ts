/**
 * The plan as Mermaid graphs, for a headless plan's Markdown (#headless):
 * where no browser can reach the page, the coding agent's app renders these
 * in the plan file instead. Each diagram is drawn as the canvas draws it —
 * a shape for each kind of box, its arrows — with the tasks that build each
 * box named on it; the task list is drawn as what waits on what.
 *
 * Ids are the graph's own (`n0`, `t0`), never the plan's: a plan's ids may
 * be words Mermaid reserves (`end`) or hold characters it reads as syntax.
 */
import { childrenOf } from './plan.ts';
import type { Diagram, NodeKind, Plan, TaskStatus } from './types.ts';

/** Each kind of box as a Mermaid shape: before and after its label. */
const SHAPE: Record<NodeKind, [string, string]> = {
  component: ['["', '"]'],
  service: ['("', '")'],
  datastore: ['[("', '")]'],
  queue: ['[["', '"]]'],
  external: ['{{"', '"}}'],
  actor: ['(["', '"])'],
  note: ['>"', '"]'],
};

const MARK: Record<TaskStatus, string> = { todo: '', in_progress: '▶ ', blocked: '⛔ ', done: '✓ ', dropped: '✗ ' };

/** Colours that read in a light and a dark renderer alike: each sets its text. */
const STATUS_CLASSES = [
  'classDef done fill:#dcfce9,stroke:#1a7f37,color:#0f3d1f',
  'classDef in_progress fill:#e2ecfd,stroke:#1f6feb,color:#0b2a5b',
  'classDef blocked fill:#fff5cc,stroke:#bf8700,color:#4d3700',
  'classDef dropped fill:#eff2f6,stroke:#98a4b3,color:#525c6a,stroke-dasharray:4 3',
];

/** Text safe inside a quoted Mermaid label: one line, with what Mermaid
 *  reads as syntax or markup written as its entity. */
export function mermaidText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/`/g, '#96;')
    .replace(/\|/g, '#124;');
}

/** One diagram as a Mermaid flowchart, fenced. */
export function diagramMermaid(diagram: Pick<Diagram, 'nodes' | 'edges' | 'direction'>): string[] {
  const id = new Map(diagram.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ['```mermaid', `flowchart ${diagram.direction === 'TB' ? 'TB' : 'LR'}`];
  for (const n of diagram.nodes) {
    const [open, close] = SHAPE[n.kind] ?? SHAPE.component;
    const label = [n.label, n.detail, n.taskIds?.length ? `tasks: ${n.taskIds.join(', ')}` : '']
      .filter((part): part is string => Boolean(part?.trim()))
      .map(mermaidText)
      .join('<br/>');
    lines.push(`  ${id.get(n.id)}${open}${label}${close}`);
  }
  for (const e of diagram.edges) {
    const from = id.get(e.source);
    const to = id.get(e.target);
    if (!from || !to) continue;
    const line = e.dashed ? '-.-' : '--';
    const arrow = e.arrows === 'none' ? (e.dashed ? '-.-' : '---') : `${e.arrows === 'both' ? '<' : ''}${line}>`;
    lines.push(`  ${from} ${arrow}${e.label?.trim() ? `|"${mermaidText(e.label)}"|` : ''} ${to}`);
  }
  lines.push('```');
  return lines;
}

/**
 * The task list as a Mermaid flowchart, fenced: each task a box, a task
 * with subtasks a group around them, an arrow from what a task waits on to
 * the task, and its status as its colour and mark. Empty with no tasks.
 */
export function tasksMermaid(plan: Pick<Plan, 'tasks'>): string[] {
  if (!plan.tasks.length) return [];
  const id = new Map(plan.tasks.map((t, i) => [t.id, `t${i}`]));
  const lines = ['```mermaid', 'flowchart LR'];
  const used = new Set<string>();
  // A parent loop from a damaged plan stops at the first task seen twice.
  const walk = (parentId: string | null, pad: string) => {
    for (const t of childrenOf(plan, parentId)) {
      if (used.has(t.id)) continue;
      used.add(t.id);
      const label = mermaidText(`${t.id} · ${t.title}`);
      if (plan.tasks.some((c) => c.parentId === t.id)) {
        lines.push(`${pad}subgraph ${id.get(t.id)}["${MARK[t.status]}${label}"]`);
        walk(t.id, `${pad}  `);
        lines.push(`${pad}end`);
      } else {
        lines.push(`${pad}${id.get(t.id)}["${MARK[t.status]}${label}"]${t.status === 'todo' ? '' : `:::${t.status}`}`);
      }
    }
  };
  walk(null, '  ');
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (id.has(dep) && used.has(dep) && used.has(t.id)) lines.push(`  ${id.get(dep)} --> ${id.get(t.id)}`);
    }
  }
  lines.push(...STATUS_CLASSES.map((c) => `  ${c}`), '```');
  return lines;
}
