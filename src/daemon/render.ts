/**
 * The plan as Claude reads it.
 *
 * Claude never sees the browser. Everything it knows about the plan comes
 * from these renderings, so they carry every id it will need to quote back in
 * an edit, and they lead with what changed — the reason it is reading at all.
 */
import type { BuildSettings, BuildTarget, Change, Plan, PlanBaseline, Task, Thread } from '../shared/types.ts';
import { baselineOf, countTasks, describeTarget, outline, planPhase, sameContent, unreadAreas, unreadByClaude } from '../shared/plan.ts';
import { contentOf, diagramChanges, diagramToMarkdown, indent } from '../shared/architecture.ts';
import {
  DEFAULT_BUILD_SETTINGS,
  REVIEW_WORDS,
  branchPlan,
  buildSteps,
  hasDependencies,
  hasSubtasks,
  readinessOf,
  waitingOn,
} from '../shared/build.ts';
import { HOOK_STAGES, PROJECT_CONFIG_PATH, emptyProjectConfig, hasHooks, type ProjectConfig } from '../shared/project.ts';

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
  /** The branch the plan's branches are cut from, when the repository says. */
  base?: string | undefined;
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
  const order = renderBuildOrder(plan, opts.base);
  if (order.length) out.push('', ...order);
  if (plan.report) out.push('', '## Build report', plan.report.text.trim());

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
  // Ready or waiting means something once there is a task list to build.
  const tracking = planPhase(plan) !== 'planning';
  for (const { task, depth } of rows) {
    const pad = '  '.repeat(depth);
    const by = opts.attribution !== false && task.createdBy === 'user' ? ' _(added by the user)_' : '';
    const note = task.note ? ` — ${task.note}` : '';
    out.push(`${pad}- ${STATUS_MARK[task.status]} ${task.id} ${task.title}${taskFacts(plan, task, tracking)}${by}${note}`);
    if (task.files?.length) out.push(`${pad}  files: ${task.files.join(', ')}`);
    if (opts.details !== false && task.detail) for (const line of task.detail.trim().split('\n')) out.push(`${pad}  ${line}`);
  }
  return out;
}

/** The task list and its build order, as Claude reads them back after
 *  publishing it. */
export function renderTaskList(plan: Plan, base?: string): string {
  const order = renderBuildOrder(plan, base);
  return [...renderTasks(plan), ...(order.length ? ['', ...order] : []), '', STATUS_LEGEND].join('\n');
}

/** What a task line says besides its title: what it waits on, where it
 *  lands, how it is reviewed, and where it is in its cycle. */
export function taskFacts(plan: Plan, task: Task, tracking: boolean): string {
  const facts: string[] = [];
  if (task.dependsOn?.length) facts.push(`after ${task.dependsOn.join(', ')}`);
  if (task.branch) facts.push(`branch \`${task.branch}\``);
  if (task.review) facts.push(`review: ${task.review}`);
  if (tracking && !hasSubtasks(plan, task.id)) {
    const state = readinessOf(plan, task);
    if (state === 'ready') facts.push('ready');
    if (state === 'waiting') facts.push(`waits on ${waitingOn(plan, task).map((t) => t.id).join(', ')}`);
    if (state === 'in_progress' && task.stage) facts.push(stageWords(task));
  }
  if (task.checks?.length && task.status !== 'todo') facts.push(`checks ${checkWords(task)}`);
  return facts.length ? ` · ${facts.join(' · ')}` : '';
}

export function stageWords(task: Task): string {
  switch (task.stage) {
    case 'implement':
      return 'implementing';
    case 'review':
      return `in review${task.round ? `, round ${task.round}` : ''}`;
    case 'refine':
      return `refining${task.round ? ` after review ${task.round}` : ''}`;
    default:
      return '';
  }
}

export function checkWords(task: Task): string {
  return (task.checks ?? []).map((c) => `${c.name} ${c.ok ? '✓' : '✗'}`).join(', ');
}

/**
 * The order the build takes: steps of tasks that can be built side by side,
 * then the branches the work lands on and how they stack. Nothing when the
 * tasks say neither what they wait on nor where they land.
 */
export function renderBuildOrder(plan: Plan, base?: string): string[] {
  const { branches, unbranched } = branchPlan(plan);
  if (!hasDependencies(plan) && branches.length === 0) return [];
  const out: string[] = [];
  const steps = buildSteps(plan);
  if (hasDependencies(plan) && steps.length) {
    out.push('## Build order', '_Each step needs only the steps before it; the tasks within a step can be built side by side._');
    steps.forEach((step, i) => {
      out.push(`${i + 1}. ${step.map((t) => `${STATUS_MARK[t.status]} ${t.id} ${t.title}`).join('; ')}`);
    });
  }
  if (branches.length) {
    if (out.length) out.push('');
    const from = base ? `\`${base}\`` : 'the base branch';
    out.push('## Branches', `_Each branch is one pull request. A branch whose tasks build on another branch is cut from it — a stacked pull request._`);
    for (const b of branches) {
      const ids = b.tasks.map((t) => t.id).join(', ');
      if (b.needs.length > 1) {
        out.push(`- \`${b.branch}\` needs ${b.needs.map((n) => `\`${n}\``).join(' and ')}: merge those first, then cut it from ${from} — ${ids}`);
      } else {
        out.push(`- \`${b.branch}\` from ${b.base ? `\`${b.base}\` (stacked)` : from} — ${ids}`);
      }
    }
    if (unbranched.length) out.push(`- no branch named (the session's current branch) — ${unbranched.map((t) => t.id).join(', ')}`);
  }
  return out;
}

/** What a locked plan says about itself at the top of a read. */
function lockLine(plan: Plan): string | null {
  switch (planPhase(plan)) {
    case 'planning':
      return null;
    case 'tasking':
      return (
        '> **Design confirmed.** The user confirmed the architecture, sections and summary, and they are locked. ' +
        'What changes now is the task list: build it from the design (harness_tasks_publish), then the user reviews ' +
        'and submits it. Do not start building before they do.'
      );
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

/** How every task-list prompt begins; recognised in a pasted message too. */
export const DESIGN_MARKER = '[cc-harness] The design is confirmed';

export interface PromptOptions {
  /** Anything the user added for Claude. */
  note?: string;
  /** How the build runs, as the user chose it. */
  settings?: BuildSettings;
  /** The repository's `.coplan/config.json`: its hooks and branch base. */
  project?: ProjectConfig;
  /** The coplan CLI on this machine, for `coplan check`. */
  bin?: string;
}

/**
 * What Claude is told when the user submits the plan: build it, how — the
 * order, the parallelism, each task's implement → review → refine cycle,
 * the checks — and how to report progress; then the plan itself.
 *
 * For this session the prompt reaches Claude with the user's next message,
 * so it is kept within what a hook can hand over; Claude can always read the
 * rest with `harness_plan_read`. A prompt for somewhere else is pasted by
 * the user into an agent that has no harness tools, so it never mentions
 * them and is never trimmed.
 */
export function buildPrompt(plan: Plan, opts: PromptOptions & { target: BuildTarget }): BuildPrompt {
  const here = opts.target === 'session';
  const settings = opts.settings ?? opts.project?.settings ?? DEFAULT_BUILD_SETTINGS;
  const project = opts.project ?? emptyProjectConfig();
  const head = [
    ...(here ? sessionBrief(plan, settings) : outsideBrief(plan, settings)),
    '',
    ...checksSection(project, here ? opts.bin : undefined),
  ];
  const doc = renderDocument(plan, { attribution: here, reader: here ? 'claude' : 'outside', base: project.branches.base });
  if (!here) return { prompt: [...head, ...fromUser(opts.note), ...doc].join('\n').trim(), trimmed: false };
  return fit(plan, head, fromUser(opts.note), changesSinceRead(plan), doc, project.branches.base);
}

/**
 * What Claude is told when the user confirms the design: the design is
 * settled, now make the task list the build will follow — focused tasks,
 * linked by what blocks what, landing on the branches the change needs —
 * and stop there, for the user to review and submit.
 */
export function designPrompt(plan: Plan, opts: PromptOptions = {}): BuildPrompt {
  const settings = opts.settings ?? opts.project?.settings ?? DEFAULT_BUILD_SETTINGS;
  const project = opts.project ?? emptyProjectConfig();
  const branches = project.branches.base || project.branches.prefix
    ? ` Branches are cut from \`${project.branches.base ?? 'the base branch'}\`${project.branches.prefix ? ` and named \`${project.branches.prefix}…\`` : ''}.`
    : '';
  const head = [
    `${DESIGN_MARKER} for "${plan.title}" — now break it into the task list.`,
    '',
    'The user has reviewed the design in Coplan and confirmed it: the architecture, sections and summary below are ' +
      'locked. What you make now is the task list the build will follow. The user reviews it, then submits the plan ' +
      'to start the build. Follow the coplan skill\'s guidance on the task list:',
    '',
    '1. Start from the tasks planned on the diagram. Break each into focused tasks: one objective, one area of the ' +
      'architecture, small enough to implement and review on its own. In `detail` put the objective, the acceptance ' +
      'criteria and what is out of scope; in `files` the files you expect to touch.',
    '2. Link them: `dependsOn` lists the tasks that must be done first (by id). Leave a task free of dependencies ' +
      'whenever it could be built alongside others — that is what lets the build run in parallel. A parent\'s ' +
      'dependencies hold for all its subtasks.',
    '3. Say what each task builds: `builds` names the boxes it implements (node ids), so the diagram tracks it.',
    '4. Decide how it lands. A change that is one pull request needs no `branch`. Otherwise give each group of tasks a ' +
      '`branch`: a branch whose tasks depend on another branch\'s is cut from it, as a stacked pull request.' + branches,
    `5. Each task is built implement → review → refine. Review is ${REVIEW_WORDS[settings.review]} by default; set ` +
      '`review: "user"` on risky or user-facing tasks, `"skip"` on trivial ones.',
    '6. Publish it with harness_tasks_publish — keep the ids of planned tasks you keep, so the boxes stay linked — ' +
      'then tell the user in chat that the task list is ready to review, and ask what you need decided with ' +
      'AskUserQuestion. Do not start building: the user submits the plan when the tasks are right.',
    '',
    ...checksSection(project, opts.bin, true),
  ];
  const doc = renderDocument(plan, { base: project.branches.base });
  return fit(plan, head, fromUser(opts.note), changesSinceRead(plan), doc, project.branches.base);
}

function fromUser(note: string | undefined): string[] {
  const text = note?.trim();
  return text ? ['', '## From the user', ...text.split('\n').map((l) => `> ${l}`.trimEnd())] : [];
}

/**
 * The prompt whole if it fits in one message; otherwise the instructions,
 * what the user said and changed, the summary and the task list — the rest
 * is one tool call away.
 */
function fit(plan: Plan, head: string[], said: string[], changes: string[], doc: string[], base: string | undefined): BuildPrompt {
  const text = [...head, ...said, ...changes, ...doc].join('\n').trim();
  if (text.length <= PROMPT_BUDGET) return { prompt: text, trimmed: false };

  const pointer =
    `_The architecture (${plan.diagrams.length} diagram(s)), the sections and each task's detail are too long to quote ` +
    'here: call harness_plan_read for them before you start._';
  const fixed = [...head, ...said, ...clip(changes, 2_500), '', pointer];
  if (plan.summary.trim()) fixed.push('', '## Summary', ...clip(plan.summary.trim().split('\n'), 1_200));
  const order = renderBuildOrder(plan, base);
  const orderText = order.join('\n');
  const room = PROMPT_BUDGET - fixed.join('\n').length - STATUS_LEGEND.length - 4 - (orderText.length < 1_500 ? orderText.length + 2 : 0);
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
  const tail = orderText.length < 1_500 && order.length ? ['', ...order] : [];
  return { prompt: [...fixed, '', ...kept, ...tail, '', STATUS_LEGEND].join('\n').trim(), trimmed: true };
}

function sessionBrief(plan: Plan, s: BuildSettings): string[] {
  const together =
    s.parallel > 1
      ? `build them side by side, up to ${s.parallel} at once, each by its own subagent given that task's harness_task_brief`
      : 'build them one at a time';
  const { branches } = branchPlan(plan);
  return [
    `${BUILD_MARKER} "${plan.title}" — the user has reviewed it in Coplan and submitted it.`,
    '',
    'The plan is final. Its architecture is locked, and from here Coplan follows your progress on its task board, ' +
      "so keep every task's status true as you go. Run the build with the coplan-build skill, and take each task " +
      'through the iric skill — implement → review → refine:',
    '',
    `1. Start only tasks that are ready: harness_task_next lists them, and what every other task waits on. Tasks that are ready together do not depend on each other — ${together}. harness_task_brief gives one task's focused brief: its objective, where it fits, its branch and its checks.`,
    '2. When you start a task, mark it in_progress with stage "implement" (harness_task_update) and run the implement ' +
      'checks. Set stage "review" when it goes to review, and "refine" when the review asks for changes. Report the ' +
      'checks you ran with `checks`.',
    `3. Review: ${REVIEW_WORDS[s.review]}, unless a task says otherwise. After ${s.maxRounds} review round${s.maxRounds === 1 ? '' : 's'} without passing, stop and ask the user.`,
    '4. Mark a task done only once its review passed and its review checks are green, with a one-line note of what you did.',
    '5. If you are stuck, mark the task blocked with a note saying on what, and ask the user with AskUserQuestion.',
    '6. For work that is not on the plan, add a task first (harness_plan_edit, upsert_task with a parentId), then do it.',
    ...(branches.length
      ? ['7. Land each task on its branch (see Branches below): cut a stacked branch from the one it builds on, and open the pull requests in stack order.']
      : ['7. Everything lands on the current branch: no task names a branch of its own.']),
    '8. Do not redesign as you go: the diagrams and sections can no longer be edited. If the design has to change, ' +
      'stop and ask the user in chat — they can reopen the plan in Coplan.',
    '9. When every task is done, run the final checks, write the build report (harness_plan_edit {op: "report", text}) ' +
      'and give the user the final summary: what was built, the branches and pull requests, and how it was checked.',
  ];
}

function outsideBrief(plan: Plan, s: BuildSettings): string[] {
  return [
    `Build "${plan.title}". This plan was designed and reviewed before any code was written, and this is its final version.`,
    '',
    '1. Work through the tasks below. A task starts only once everything it comes after is done; where the plan gives ' +
      'a build order, tasks in the same step do not depend on each other and can be built side by side.',
    `2. Take each task through implement → review → refine: implement it and run the implement checks; review the change (${REVIEW_WORDS[s.review]}) and run the review checks; refine until it passes. After ${s.maxRounds} round${s.maxRounds === 1 ? '' : 's'}, stop and ask.`,
    '3. Build the architecture as described: its parts, what each one does and decides, and how they connect.',
    '4. Where tasks name branches, land each task on its branch; a branch built on another is cut from it.',
    '5. If the design turns out not to work, stop and say why rather than redesigning as you go.',
    '6. When every task is done, run the final checks and summarize what was built, where, and how it was checked.',
  ];
}

/** The repository's checks, per stage — or what to do without any. */
export function checksSection(project: ProjectConfig, bin?: string, planning = false): string[] {
  const out = ['## Checks'];
  for (const e of project.errors) out.push(`- ⚠ ${e}`);
  if (!hasHooks(project)) {
    out.push(
      planning
        ? `This repository has no ${PROJECT_CONFIG_PATH} with checks. Suggest /coplan-init to the user, so the build runs the right checks instead of guessing.`
        : `No checks are configured (${PROJECT_CONFIG_PATH}). Work out what to run from the repository's scripts and CI, use the same commands for every task, and say which in each task's done note.`,
    );
    return out;
  }
  out.push(`_From ${PROJECT_CONFIG_PATH}, run from the repository root:_`);
  for (const stage of HOOK_STAGES) {
    const hooks = project.hooks[stage];
    if (!hooks.length) continue;
    const list = hooks.map((h) => `${h.name} \`${h.run}\`${h.paths ? ` (for ${h.paths.join(', ')})` : ''}${h.optional ? ' (optional)' : ''}`);
    out.push(`- ${stage}: ${list.join('; ')}`);
  }
  if (bin) out.push(`Run a whole stage with \`"${bin}" check <stage>\` — \`--files a,b\` for one task's files, \`--json\` for harness_task_update's \`checks\`.`);
  return out;
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
