/**
 * The plan as Claude reads it.
 *
 * Claude never sees the browser. Everything it knows about the plan comes
 * from these renderings, so they carry every id it will need to quote back in
 * an edit, and they lead with what changed — the reason it is reading at all.
 */
import type { Change, Plan, PlanBaseline, Thread } from '../shared/types.ts';
import { countTasks, describeTarget, outline, unreadAreas, unreadByClaude } from '../shared/plan.ts';
import { contentOf, diagramChanges, diagramToMarkdown, indent } from '../shared/architecture.ts';

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
  out.push(renderChanges(plan, unread, Boolean(opts.changesOnly)));

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
    out.push('', '## Architecture');
    for (const d of plan.diagrams) {
      out.push('', diagramToMarkdown(d, { tasks: plan.tasks, note: d.updatedBy === 'user' ? 'last edited by the user' : undefined }));
    }
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
 * What the user changed since Claude last read, as the net difference
 * between the plan Claude read and the plan now.
 *
 * The change log records every step — each drag, each keystroke-sized save —
 * which is the wrong grain for Claude: it needs where the user ended up, not
 * how they got there. So the log is only used to find which items the user
 * touched, and each of those is compared with what Claude last saw. Layout
 * is never part of it.
 */
function renderChanges(plan: Plan, unread: Change[], changesOnly: boolean): string {
  if (unread.length === 0) {
    return plan.claudeReadAt
      ? '## Since you last read\nNothing — the user has not changed the plan.'
      : '## Since you last read\nThis is your first read of this plan.';
  }
  const base = plan.claudeBaseline;
  if (!base) return renderChangeLog(unread);

  const touched = (kind: string) => new Set(unread.filter((c) => c.target.kind === kind).map((c) => c.target.id));
  const opts = { withText: changesOnly };
  const blocks: string[] = [];
  const block = (title: string, lines: string[]) => {
    if (lines.length) blocks.push(`**${title}**\n${lines.map((l) => (l.startsWith(' ') || l === '' ? l : `- ${l}`)).join('\n')}`);
  };

  // The plan itself.
  const meta: string[] = [];
  if (base.title !== plan.title) meta.push(`Renamed the plan "${base.title}" → "${plan.title}".`);
  if (base.summary.trim() !== plan.summary.trim()) {
    meta.push(plan.summary.trim() ? 'Edited the summary.' : 'Removed the summary.');
    if (changesOnly && plan.summary.trim()) meta.push(...indent(plan.summary, 2));
  }
  block('Plan', meta);

  // Architecture: per diagram, the design difference.
  for (const id of touched('diagram')) {
    const was = base.diagrams.find((d) => d.id === id);
    const now = plan.diagrams.find((d) => d.id === id);
    if (!was && now) {
      block(`New diagram [${now.id}] "${now.title}"`, [
        `${now.nodes.length} part(s), ${now.edges.length} connection(s)${changesOnly ? ':' : ' — described in full below.'}`,
        ...(changesOnly ? indent(diagramToMarkdown(contentOf(now), { tasks: plan.tasks, level: 4 }), 2) : []),
      ]);
    } else if (was && !now) {
      block(`Diagram "${was.title}"`, ['Removed the diagram.']);
    } else if (was && now) {
      block(`Diagram [${now.id}] "${now.title}"`, diagramChanges(contentOf(was), contentOf(now), opts));
    }
  }

  block('Tasks', taskChanges(base, plan, touched('task'), changesOnly));
  block('Sections', sectionChanges(base, plan, touched('section'), unread, changesOnly));

  // Comments are events, not state: each one is news.
  const said = unread.filter((c) => ['commented', 'replied', 'resolved', 'reopened'].includes(c.kind)).map((c) => `${capital(c.summary)}.`);
  block('Comments', [...new Set(said)]);

  const lead = changesOnly
    ? '_The net effect of their edits — not each step, and not where boxes were moved on the canvas._'
    : '_The net effect of their edits — not each step, and not where boxes were moved on the canvas. The full plan follows._';
  if (!blocks.length) {
    return `## Since you last read\nThe user made edits, but they cancel out: the plan's content is what you last read.`;
  }
  return ['## Since you last read — what the user changed', lead, '', blocks.join('\n\n')].join('\n');
}

type BaseTask = PlanBaseline['tasks'][number];

function taskChanges(base: PlanBaseline, plan: Plan, ids: Set<string>, withText: boolean): string[] {
  const out: string[] = [];
  const titleOf = (id: string | null) => (id ? (plan.tasks.find((t) => t.id === id)?.title ?? base.tasks.find((t) => t.id === id)?.title ?? id) : null);
  const where = (parentId: string | null) => (parentId ? `under "${titleOf(parentId)}"` : 'at the top level');
  const place = (tasks: BaseTask[], t: BaseTask) =>
    tasks
      .filter((x) => x.parentId === t.parentId)
      .sort((a, b) => a.order - b.order)
      .findIndex((x) => x.id === t.id);
  for (const id of ids) {
    const was = base.tasks.find((t) => t.id === id);
    const now = plan.tasks.find((t) => t.id === id);
    if (!was && now) {
      out.push(`Added ${now.id} "${now.title}" ${where(now.parentId)}.`);
      if (withText && now.detail?.trim()) out.push(...indent(now.detail, 2));
      continue;
    }
    if (was && !now) {
      out.push(`Removed ${was.id} "${was.title}".`);
      continue;
    }
    if (!was || !now) continue;
    const facts: string[] = [];
    if (was.title !== now.title) facts.push(`renamed from "${was.title}"`);
    if (was.parentId !== now.parentId) facts.push(`moved ${where(now.parentId)}`);
    else if (place(base.tasks, was) !== place(plan.tasks, now)) facts.push(`moved to position ${place(plan.tasks, now) + 1} ${where(now.parentId)}`);
    if (was.status !== now.status) facts.push(`status ${was.status} → ${now.status}`);
    if ((was.detail ?? '').trim() !== (now.detail ?? '').trim()) facts.push(now.detail?.trim() ? 'detail edited' : 'detail removed');
    if ((was.files ?? []).join() !== (now.files ?? []).join()) facts.push(`files now ${now.files?.join(', ') || 'none'}`);
    if ((was.note ?? '') !== (now.note ?? '')) facts.push(now.note ? `note "${now.note}"` : 'note removed');
    if (!facts.length) continue;
    out.push(`Changed ${now.id} "${now.title}": ${facts.join('; ')}.`);
    if (withText && (was.detail ?? '').trim() !== (now.detail ?? '').trim() && now.detail?.trim()) out.push('  Detail now:', ...indent(now.detail, 4));
  }
  return out;
}

function sectionChanges(base: PlanBaseline, plan: Plan, ids: Set<string>, unread: Change[], withText: boolean): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const was = base.sections.find((s) => s.id === id);
    const now = plan.sections.find((s) => s.id === id);
    if (!was && now) {
      out.push(`Added [${now.id}] "${now.title}".`);
      if (withText && now.body.trim()) out.push(...indent(now.body, 2));
    } else if (was && !now) {
      out.push(`Removed "${was.title}".`);
    } else if (was && now) {
      const facts: string[] = [];
      if (was.title !== now.title) facts.push(`renamed from "${was.title}"`);
      if (was.body.trim() !== now.body.trim()) facts.push('text edited');
      if (facts.length) out.push(`Changed [${now.id}] "${now.title}": ${facts.join('; ')}.`);
      if (withText && was.body.trim() !== now.body.trim()) out.push(...indent(now.body, 2));
    }
  }
  const order = (list: { id: string }[]) => list.map((s) => s.id).filter((id) => base.sections.some((s) => s.id === id) && plan.sections.some((s) => s.id === id));
  if (unread.some((c) => c.kind === 'moved' && c.target.kind === 'section') && order(base.sections).join() !== order(plan.sections).join()) {
    out.push(`Reordered the sections: ${plan.sections.map((s) => `"${s.title}"`).join(', ')}.`);
  }
  return out;
}

/** For a plan saved before baselines existed: the log, without layout noise
 *  and without repeating itself. */
function renderChangeLog(unread: Change[]): string {
  const lines = [...new Set(unread.filter((c) => !/^rearranged \d+ node/.test(c.summary)).map((c) => `- ${c.summary} [${c.target.kind}${c.target.id ? ` ${c.target.id}` : ''}]`))];
  return [`## Since you last read — ${lines.length} change(s) by the user`, ...lines].join('\n');
}

function capital(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
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
  // Where, not how often: one save or forty, it is the same thing to read.
  const areas = unreadAreas(plan);
  if (!plan || areas.length === 0) return null;
  return (
    `[cc-harness] The user has changed the plan "${plan.title}" in the harness UI since you last read it ` +
    `(${areas.join(', ')}). Call harness_plan_read before acting on the plan.`
  );
}
