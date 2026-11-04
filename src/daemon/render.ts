/**
 * The plan as Claude reads it.
 *
 * Claude never sees the browser. Everything it knows about the plan comes
 * from these renderings, so they carry every id it will need to quote back in
 * an edit, and they lead with what changed — the reason it is reading at all.
 */
import type { BuildTarget, Change, Plan, PlanBaseline, Thread } from '../shared/types.ts';
import { baselineOf, countTasks, describeTarget, outline, planPhase, sameContent, unreadAreas, unreadByClaude } from '../shared/plan.ts';
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
  const locked = lockLine(plan);
  if (locked) out.push('', locked);

  out.push('');
  out.push(renderChanges(plan, unread, Boolean(opts.changesOnly)));

  if (opts.changesOnly) {
    const touched = new Set(unread.map((c) => `${c.target.kind}:${c.target.id}`));
    const threads = plan.threads.filter((t) => !t.resolved && (touched.has(`${t.target.kind}:${t.target.id}`) || lastAuthor(t) === 'user'));
    if (threads.length) out.push('', '## Comments waiting on you', ...threads.map((t) => renderThread(plan, t)));
    return out.join('\n').trim();
  }

  out.push(...renderDocument(plan));
  return out.join('\n').trim();
}

interface DocumentOptions {
  /** Say which parts the user wrote. Claude reads that as a cue to respect
   *  their structure; an outside agent has no use for it. */
  attribution?: boolean;
  /** Each task's detail, under it. */
  details?: boolean;
  /** Who "you" is in a comment thread: Claude, or an outside reader. */
  reader?: 'claude' | 'outside';
}

/** The plan as a document: summary, sections, architecture, tasks and the
 *  comments still open. Shared by the read-back and the build prompt. */
function renderDocument(plan: Plan, opts: DocumentOptions = {}): string[] {
  const { attribution = true, details = true, reader = 'claude' } = opts;
  const out: string[] = [];
  if (plan.summary.trim()) out.push('', '## Summary', plan.summary.trim());

  if (plan.sections.length) {
    out.push('', '## Sections');
    for (const s of plan.sections) {
      const by = attribution && s.updatedBy === 'user' ? ' _(edited by the user)_' : '';
      out.push('', `### [${s.id}] ${s.title}${by}`, s.body.trim() || '_(empty)_');
    }
  }

  if (plan.diagrams.length) {
    out.push('', '## Architecture');
    for (const d of plan.diagrams) {
      const note = attribution && d.updatedBy === 'user' ? 'last edited by the user' : undefined;
      out.push('', diagramToMarkdown(d, { tasks: plan.tasks, note }));
    }
  }

  out.push('', ...renderTasks(plan, { attribution, details }));

  const open = plan.threads.filter((t) => !t.resolved);
  if (open.length) {
    out.push('', '## Open comments');
    for (const t of open) out.push(renderThread(plan, t, reader));
  }

  out.push('', STATUS_LEGEND);
  return out;
}

const STATUS_LEGEND = `_Statuses: ${Object.entries(STATUS_MARK).map(([k, v]) => `${v} ${k}`).join(', ')}_`;

function renderTasks(plan: Plan, opts: { attribution?: boolean; details?: boolean } = {}): string[] {
  const counts = countTasks(plan);
  const out = [`## Tasks${counts.total ? ` (${counts.done}/${counts.total} done)` : ''}`];
  const rows = outline(plan);
  if (rows.length === 0) out.push('_(no tasks yet)_');
  for (const { task, depth } of rows) {
    const pad = '  '.repeat(depth);
    const by = opts.attribution !== false && task.createdBy === 'user' ? ' _(added by the user)_' : '';
    const note = task.note ? ` — ${task.note}` : '';
    out.push(`${pad}- ${STATUS_MARK[task.status]} ${task.id} ${task.title}${by}${note}`);
    if (task.files?.length) out.push(`${pad}  files: ${task.files.join(', ')}`);
    if (opts.details !== false && task.detail) for (const line of task.detail.trim().split('\n')) out.push(`${pad}  ${line}`);
  }
  return out;
}

/** What a locked plan says about itself at the top of a read. */
function lockLine(plan: Plan): string | null {
  switch (planPhase(plan)) {
    case 'planning':
      return null;
    case 'handed-off':
      return '> **Locked.** The user submitted this plan to be built outside this session; it no longer changes here.';
    case 'built':
      return '> **Built.** The user submitted this plan and every task is done. Publishing a new plan replaces it.';
    default:
      return (
        '> **Locked for building.** The user submitted this plan: build it task by task, keeping statuses true with ' +
        'harness_task_update. Only task updates and comment replies apply now; if the design has to change, ask ' +
        'the user in chat — they can reopen the plan in Coplan.'
      );
  }
}

/* ------------------------------------------------------------------ *
 * The build prompt
 * ------------------------------------------------------------------ */

/**
 * The longest build prompt handed to Claude through a hook. Claude Code
 * keeps hook output it adds to the context to about 10,000 characters and
 * moves anything longer out to a file, so the prompt stays under that.
 */
export const PROMPT_BUDGET = 9_000;

/** How every build prompt for this session begins. The hook recognises it
 *  in a message the user pasted themselves, so it is not delivered twice. */
export const BUILD_MARKER = '[cc-harness] Build the plan';

export interface BuildPrompt {
  prompt: string;
  /** Too long to quote whole: the prompt points Claude at harness_plan_read. */
  trimmed: boolean;
}

/**
 * What Claude is told when the user submits the plan: build it, and how to
 * report progress — then the plan itself, as it stands.
 *
 * For this session the prompt reaches Claude with the user's next message,
 * so it is kept within what a hook can hand over; Claude can always read the
 * rest with `harness_plan_read`. A prompt for somewhere else is pasted by
 * the user into an agent that has no harness tools, so it never mentions
 * them and is never trimmed.
 */
export function buildPrompt(plan: Plan, opts: { target: BuildTarget; note?: string }): BuildPrompt {
  const here = opts.target === 'session';
  const note = opts.note?.trim();
  const head = here ? sessionBrief(plan) : outsideBrief(plan);
  const fromUser = note ? ['', '## From the user', ...note.split('\n').map((l) => `> ${l}`.trimEnd())] : [];
  const changes = here ? changesSinceRead(plan) : [];
  const full = [...head, ...fromUser, ...changes, ...renderDocument(plan, { attribution: here, reader: here ? 'claude' : 'outside' })];
  const text = full.join('\n').trim();
  if (!here || text.length <= PROMPT_BUDGET) return { prompt: text, trimmed: false };

  // Too long for one message: the instructions, what the user said and
  // changed, the summary and the task list — the rest is one tool call away.
  const pointer =
    `_The architecture (${plan.diagrams.length} diagram(s)), the sections and each task's detail are too long to quote ` +
    'here: call harness_plan_read for them before you start._';
  const fixed = [...head, ...fromUser, ...clip(changes, 2_500), '', pointer];
  if (plan.summary.trim()) fixed.push('', '## Summary', ...clip(plan.summary.trim().split('\n'), 1_200));
  const room = PROMPT_BUDGET - fixed.join('\n').length - STATUS_LEGEND.length - 4;
  const tasks = renderTasks(plan, { details: false });
  const kept: string[] = [];
  let used = 0;
  for (const line of tasks) {
    if (used + line.length + 1 > room - 80) {
      kept.push(`- …and ${tasks.length - kept.length} more line(s): harness_plan_read lists every task.`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { prompt: [...fixed, '', ...kept, '', STATUS_LEGEND].join('\n').trim(), trimmed: true };
}

function sessionBrief(plan: Plan): string[] {
  return [
    `${BUILD_MARKER} "${plan.title}" — the user has reviewed it in Coplan and submitted it.`,
    '',
    'The plan is final. Its architecture is locked, and from here Coplan only follows your progress on its ' +
      'task board, so keep every task\'s status true as you go:',
    '',
    '1. Work through the tasks below in order.',
    '2. When you start a task, mark it in_progress with harness_task_update. When it is finished, mark it done ' +
      'with a one-line note of what you did.',
    '3. If you are stuck, mark the task blocked with a note saying on what, and ask the user with AskUserQuestion.',
    '4. For work that is not on the plan, add a task first (harness_plan_edit, upsert_task with a parentId), then do it.',
    '5. Do not redesign as you go: the diagrams and sections can no longer be edited. If the design has to change, ' +
      'stop and ask the user in chat — they can reopen the plan in Coplan.',
  ];
}

function outsideBrief(plan: Plan): string[] {
  return [
    `Build "${plan.title}". This plan was designed and reviewed before any code was written, and this is its final version.`,
    '',
    '1. Work through the tasks below in order. Each says what it involves and which files it is expected to touch.',
    '2. Build the architecture as described: its parts, what each one does and decides, and how they connect.',
    '3. If the design turns out not to work, stop and say why rather than redesigning as you go.',
  ];
}

/** What the user changed since Claude last read, when Claude has read before. */
function changesSinceRead(plan: Plan): string[] {
  const unread = unreadByClaude(plan);
  if (!plan.claudeBaseline || unread.length === 0) return [];
  return ['', renderChanges(plan, unread, false)];
}

/** Lines, cut to about `max` characters. */
function clip(lines: string[], max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > max) {
      out.push('…');
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
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

  // The plan itself — only if the user edited it: Claude's own renames are
  // folded into the baseline, but the check costs nothing.
  const meta: string[] = [];
  const userMeta = unread.some((c) => c.target.kind === 'plan' && c.kind === 'edited');
  if (userMeta && base.title !== plan.title) meta.push(`Renamed the plan "${base.title}" → "${plan.title}".`);
  if (userMeta && base.summary.trim() !== plan.summary.trim()) {
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

  // Which diagram comes first is part of how the plan reads.
  if (unread.some((c) => c.kind === 'moved' && c.target.kind === 'diagram') && reordered(base.diagrams, plan.diagrams)) {
    block('Diagrams', [`Reordered the diagrams: ${plan.diagrams.map((d) => `"${d.title}"`).join(', ')}.`]);
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
    // Only say so when it is true. If the content differs and nothing above
    // put it into words, the log is better than silence.
    if (!sameContent(baselineOf(plan), base)) return renderChangeLog(unread);
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
  if (unread.some((c) => c.kind === 'moved' && c.target.kind === 'section') && reordered(base.sections, plan.sections)) {
    out.push(`Reordered the sections: ${plan.sections.map((s) => `"${s.title}"`).join(', ')}.`);
  }
  return out;
}

/** Whether the items two lists share come in a different order. */
function reordered(was: { id: string }[], now: { id: string }[]): boolean {
  const common = (list: { id: string }[], other: { id: string }[]) => list.map((x) => x.id).filter((id) => other.some((o) => o.id === id));
  return common(was, now).join('\u0000') !== common(now, was).join('\u0000');
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

function renderThread(plan: Plan, t: Thread, reader: 'claude' | 'outside' = 'claude'): string {
  const who = (author: 'user' | 'claude') => (author === 'user' ? 'user' : reader === 'claude' ? 'you' : 'planner');
  const lines = [`- [${t.id}] on ${describeTarget(plan, t.target)} — ${who(t.author)}: ${t.text}`];
  for (const r of t.replies) lines.push(`  ↳ ${who(r.author)}: ${r.text}`);
  if (reader === 'claude' && lastAuthor(t) === 'user') lines.push('  → reply with harness_plan_edit {op:"reply"} once you have acted on it');
  return lines.join('\n');
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
