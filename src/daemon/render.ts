/**
 * The plan as Claude reads it.
 *
 * Claude never sees the browser. Everything it knows about the plan comes
 * from these renderings, so they carry every id it will need to quote back in
 * an edit, and they lead with what changed — the reason it is reading at all.
 */
import type { Change, Diagram, Plan, Thread } from '../shared/types.ts';
import { countTasks, describeTarget, outline, unreadByClaude } from '../shared/plan.ts';

const STATUS_MARK = { todo: '[ ]', in_progress: '[~]', blocked: '[!]', done: '[x]' } as const;

export interface RenderOptions {
  /** Address of the plan in the browser, for Claude to pass on. */
  url?: string;
  /** Only the changes and what is still open; skip the full document. */
  changesOnly?: boolean;
}

export function renderPlan(plan: Plan, opts: RenderOptions = {}): string {
  const unread = unreadByClaude(plan);
  const out: string[] = [];

  out.push(`# ${plan.title}`);
  const counts = countTasks(plan);
  const meta = [
    `revision ${plan.revision}`,
    counts.total ? `tasks ${counts.done}/${counts.total} done` : 'no tasks',
    `${plan.threads.filter((t) => !t.resolved).length} open comment(s)`,
  ];
  out.push(`_${meta.join(' · ')}${opts.url ? ` · UI: ${opts.url}` : ''}_`);

  out.push('');
  out.push(renderChanges(plan, unread));

  if (opts.changesOnly) {
    const touched = new Set(unread.map((c) => `${c.target.kind}:${c.target.id}`));
    const threads = plan.threads.filter((t) => !t.resolved && (touched.has(`${t.target.kind}:${t.target.id}`) || lastAuthor(t) === 'user'));
    if (threads.length) out.push('', '## Comments waiting on you', ...threads.map((t) => renderThread(plan, t)));
    return out.join('\n').trim();
  }

  if (plan.summary.trim()) out.push('', '## Summary', plan.summary.trim());

  if (plan.sections.length) {
    out.push('', '## Sections');
    for (const s of plan.sections) {
      out.push('', `### [${s.id}] ${s.title}${s.updatedBy === 'user' ? ' _(edited by the user)_' : ''}`, s.body.trim() || '_(empty)_');
    }
  }

  if (plan.diagrams.length) {
    out.push('', '## Diagrams');
    for (const d of plan.diagrams) out.push('', ...renderDiagram(d));
  }

  out.push('', `## Tasks${counts.total ? ` (${counts.done}/${counts.total} done)` : ''}`);
  const rows = outline(plan);
  if (rows.length === 0) out.push('_(no tasks yet)_');
  for (const { task, depth } of rows) {
    const pad = '  '.repeat(depth);
    const by = task.createdBy === 'user' ? ' _(added by the user)_' : '';
    const note = task.note ? ` — ${task.note}` : '';
    out.push(`${pad}- ${STATUS_MARK[task.status]} ${task.id} ${task.title}${by}${note}`);
    if (task.files?.length) out.push(`${pad}  files: ${task.files.join(', ')}`);
    if (task.detail) for (const line of task.detail.trim().split('\n')) out.push(`${pad}  ${line}`);
  }

  const open = plan.threads.filter((t) => !t.resolved);
  if (open.length) {
    out.push('', '## Open comments');
    for (const t of open) out.push(renderThread(plan, t));
  }

  out.push('', `_Statuses: ${Object.entries(STATUS_MARK).map(([k, v]) => `${v} ${k}`).join(', ')}_`);
  return out.join('\n').trim();
}

/**
 * A diagram as text: nodes with their ids, then edges between those ids —
 * exactly the shape `upsert_diagram` takes back, so an edit is a copy, a
 * change and a paste.
 */
function renderDiagram(d: Diagram): string[] {
  const lines = [`### [${d.id}] ${d.title} _(${d.direction === 'LR' ? 'left to right' : 'top to bottom'}${d.updatedBy === 'user' ? ', edited by the user' : ''})_`];
  if (d.caption) lines.push(d.caption.trim());
  lines.push('nodes:');
  if (d.nodes.length === 0) lines.push('- _(none)_');
  for (const n of d.nodes) {
    lines.push(`- ${n.id}: "${n.label}" (${n.kind})${n.detail ? ` — ${n.detail.replace(/\n/g, ' ')}` : ''}`);
    if (n.taskIds?.length) lines.push(`  tasks: ${n.taskIds.join(', ')}`);
    if (n.notes) for (const line of n.notes.trim().split('\n')) lines.push(`  ${line}`);
  }
  if (d.edges.length) {
    lines.push('edges:');
    for (const e of d.edges) {
      lines.push(`- ${e.source} → ${e.target}${e.label ? ` "${e.label}"` : ''}${e.dashed ? ' (dashed)' : ''}`);
    }
  }
  return lines;
}

function renderChanges(plan: Plan, unread: Change[]): string {
  if (unread.length === 0) {
    return plan.claudeReadAt
      ? '## Since you last read\nNothing — the user has not changed the plan.'
      : '## Since you last read\nThis is your first read of this plan.';
  }
  const lines = [`## Since you last read — ${unread.length} change(s) by the user`];
  for (const c of unread) lines.push(`- ${c.summary} [${c.target.kind}${c.target.id ? ` ${c.target.id}` : ''}]`);
  return lines.join('\n');
}

function renderThread(plan: Plan, t: Thread): string {
  const lines = [`- [${t.id}] on ${describeTarget(plan, t.target)} — ${who(t.author)}: ${t.text}`];
  for (const r of t.replies) lines.push(`  ↳ ${who(r.author)}: ${r.text}`);
  if (lastAuthor(t) === 'user') lines.push('  → reply with harness_plan_edit {op:"reply"} once you have acted on it');
  return lines.join('\n');
}

function who(author: 'user' | 'claude'): string {
  return author === 'user' ? 'user' : 'you';
}

function lastAuthor(t: Thread): 'user' | 'claude' {
  return t.replies.length ? t.replies[t.replies.length - 1]!.author : t.author;
}

/**
 * The line slipped into Claude's context when the user next types in chat,
 * if they changed the plan in the meantime. One line: it only has to say
 * "go and read", not repeat what the read will say.
 */
export function unreadNotice(plan: Plan | null): string | null {
  const unread = unreadByClaude(plan);
  if (!plan || unread.length === 0) return null;
  const kinds = new Map<string, number>();
  for (const c of unread) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  const parts = [...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
  return (
    `[cc-harness] The user has changed the plan "${plan.title}" in the harness UI since you last read it ` +
    `(${parts}). Call harness_plan_read before acting on the plan.`
  );
}
