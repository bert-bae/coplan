/**
 * The plan as Claude reads it.
 *
 * Claude never sees the browser. Everything it knows about the plan comes
 * from these renderings, so they carry every id it will need to quote back in
 * an edit, and they lead with what changed — the reason it is reading at all.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { paths } from '../shared/paths.ts';
import { planGaps, type GapSeverities } from '../shared/check.ts';
import type { BuildSettings, BuildTarget, Change, Plan, PlanBaseline, Task, Thread } from '../shared/types.ts';
import {
  baselineOf,
  countTasks,
  describeTarget,
  outline,
  planPhase,
  REOPENED_DESIGN,
  REOPENED_PLAN,
  sameContent,
  unreadAreas,
  unreadByClaude,
  proposalStaleness,
} from '../shared/plan.ts';
import { contentOf, diagramBlocks, diagramChanges, diagramToMarkdown, hang, indent, nestHeadings } from '../shared/architecture.ts';
import { BlockList, CHANGES, NOTE, TEMPLATE, blockLines, blocksText, derived, dropAll, field, joinBlocks, setting, type Block, type BlockSource } from '../shared/blocks.ts';
import {
  DEFAULT_BUILD_SETTINGS,
  REVIEW_WORDS,
  baseWords,
  branchPlan,
  buildSteps,
  hasDependencies,
  hasSubtasks,
  readinessOf,
  waitingOn,
} from '../shared/build.ts';
import {
  GLOBAL_PROJECT_FILE,
  HOOK_STAGES,
  INSTRUCTIONS_DIR,
  PROJECT_CONFIG_PATH,
  configSource,
  emptyProjectConfig,
  hasHooks,
  hookCommand,
  type InstructionPoint,
  type ProjectConfig,
} from '../shared/project.ts';
import { agentInfo, type AgentInfo, type AgentKind } from '../shared/agents.ts';

const STATUS_MARK = { todo: '[ ]', in_progress: '[~]', blocked: '[!]', done: '[x]', dropped: '[-]' } as const;

export interface RenderOptions {
  /** Address of the plan in the browser, for Claude to pass on. */
  url?: string;
  /** Only the changes and what is still open; skip the full document. */
  changesOnly?: boolean;
  /** How the repository counts each plan-check rule. */
  planCheck?: GapSeverities;
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

  const proposals = renderProposals(plan);
  if (opts.changesOnly) {
    const touched = new Set(unread.map((c) => `${c.target.kind}:${c.target.id}`));
    const threads = plan.threads.filter((t) => !t.resolved && (touched.has(`${t.target.kind}:${t.target.id}`) || lastAuthor(t) === 'user'));
    if (threads.length) out.push('', '## Comments waiting on you', ...threads.map((t) => renderThread(plan, t)));
    if (proposals.length) out.push('', ...proposals);
    return out.join('\n').trim();
  }

  out.push(...renderDocument(plan, { revs: true }));
  if (proposals.length) out.push('', ...proposals);
  const gaps = renderGaps(plan, 12, opts.planCheck);
  if (gaps.length) out.push('', ...gaps);
  return out.join('\n').trim();
}

/**
 * Claude's proposals: the ones still waiting on the user, and how the user
 * answered each since Claude last read — so an answer is heard once, where
 * Claude reads.
 */
export function renderProposals(plan: Plan): string[] {
  const all = plan.proposals ?? [];
  const open = all.filter((p) => p.status === 'open');
  // By the change log's sequence, as the rest of what Claude has read: a
  // clock that steps back, or an answer in the read's own millisecond,
  // must not swallow one.
  const answered = all.filter((p) => (p.status === 'accepted' || p.status === 'rejected') && (p.resolvedSeq ?? 0) > plan.claudeReadSeq);
  if (!open.length && !answered.length) return [];
  const out = ['## Your proposals'];
  for (const p of answered) {
    out.push(
      p.status === 'accepted'
        ? `- ${p.id} "${p.title}" — **accepted** by the user: its edits are in the plan above, as theirs.`
        : `- ${p.id} "${p.title}" — **rejected** by the user${p.note ? `: ${hang(p.note, 4)}` : '.'} The plan stays as it was.`,
    );
  }
  for (const p of open) {
    const stale = proposalStaleness(plan, p);
    out.push(
      `- ${p.id} "${p.title}" — waiting on the user (${p.ops.length} edit${p.ops.length === 1 ? '' : 's'})` +
        (stale.length ? `. ⚠ Out of date: ${stale.join(', ')} changed since, so it can no longer be accepted — withdraw it, and propose again if it still holds.` : '.'),
    );
  }
  return out;
}

/**
 * What the plan leaves open (see planGaps), as a list for Claude — cut to
 * `max` lines with a pointer to the whole list.
 */
export function renderGaps(plan: Plan, max = Infinity, severities: GapSeverities = {}): string[] {
  const gaps = planGaps(plan, severities);
  if (!gaps.length) return [];
  // Errors come first (planGaps sorts them), and are marked: they hold the sign-off.
  const shown = gaps.slice(0, max).map((g) => `- ${g.severity === 'error' ? '⛔ (holds Confirm and Submit) ' : ''}${g.message}`);
  if (gaps.length > max) shown.push(`- …and ${gaps.length - max} more: harness_plan_check lists them all.`);
  const errors = gaps.filter((g) => g.severity === 'error').length;
  return [`## Gaps (${gaps.length}${errors ? `, ${errors} holding the sign-off` : ''}) — what the plan leaves open`, ...shown];
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
  /** Each section's, diagram's and task's revision, for an edit's `expect`. */
  revs?: boolean;
}

/** The plan as a document — summary, sections, architecture, tasks and
 *  the comments still open — in its parts, as blocks. Shared by the
 *  read-back and the prompts. Each part starts with the blank line before
 *  it, so the parts joined are the document. */
interface DocumentParts {
  summary: Block[];
  sections: Block[];
  architecture: Block[];
  tasks: Block[];
  order: Block[];
  report: Block[];
  comments: Block[];
  legend: Block[];
}

/** Bookkeeping: which revision an item is at, for an edit's `expect`. */
const REV = derived('its revision');
/** Bookkeeping: who last edited an item, or added it. */
const WHO = derived('who last edited it');

function documentParts(plan: Plan, opts: DocumentOptions = {}): DocumentParts {
  const { attribution = true, details = true, reader = 'claude', revs = false } = opts;
  const summary = new BlockList();
  if (plan.summary.trim()) summary.gap().add('summary', field('plan'), ['## Summary', nestHeadings(plan.summary.trim(), 2)]);

  const sections = new BlockList();
  if (plan.sections.length) {
    sections.gap().add('sections', TEMPLATE, '## Sections');
    for (const s of plan.sections) {
      const me = field('section', s.id);
      sections.gap().add(`section:${s.id}`, me, `### [${s.id}] ${s.title}`);
      if (attribution && s.updatedBy === 'user') sections.inline(`section:${s.id}:by`, WHO, ' _(edited by the user)_', { bookkeeping: true });
      if (revs) sections.inline(`section:${s.id}:rev`, REV, ` _(rev ${s.rev})_`, { bookkeeping: true });
      sections.add(`section:${s.id}:body`, me, nestHeadings(s.body.trim(), 3) || '_(empty)_');
    }
  }

  const architecture = new BlockList();
  if (plan.diagrams.length) {
    architecture.gap().add('architecture', TEMPLATE, '## Architecture');
    for (const d of plan.diagrams) {
      const edited = attribution && d.updatedBy === 'user' ? 'last edited by the user' : '';
      const note = [revs ? `rev ${d.rev}` : '', edited].filter(Boolean).join(' · ') || undefined;
      architecture.gap().push(...diagramBlocks(d, { tasks: plan.tasks, note }));
    }
  }

  const tasks = new BlockList().gap().push(...taskBlocks(plan, { attribution, details, revs }));
  const order = new BlockList();
  const steps = buildOrderBlocks(plan, opts.base);
  if (steps.length) order.gap().push(...steps);

  const report = new BlockList();
  if (plan.report) {
    // The report the agent wrote, which the overview shows.
    report.gap().add('report', field('plan'), ['## Build report', plan.report.text.trim()]);
    const checks = plan.report.checks ?? [];
    if (checks.length) report.gap().add('report:checks', field('plan'), `Final checks: ${checks.map((c) => `${c.name} ${c.ok ? '✓' : `✗${c.note ? ` (${c.note})` : ''}`}`).join(', ')}`);
  }

  const comments = new BlockList();
  const open = plan.threads.filter((t) => !t.resolved);
  if (open.length) {
    comments.gap().add('comments', TEMPLATE, '## Open comments');
    for (const t of open) comments.push(...threadBlocks(plan, t, reader));
  }

  const legend = new BlockList().gap().add('legend', TEMPLATE, STATUS_LEGEND, { bookkeeping: true });
  return {
    summary: summary.blocks,
    sections: sections.blocks,
    architecture: architecture.blocks,
    tasks: tasks.blocks,
    order: order.blocks,
    report: report.blocks,
    comments: comments.blocks,
    legend: legend.blocks,
  };
}

function documentBlocks(parts: DocumentParts): Block[] {
  return [...parts.summary, ...parts.sections, ...parts.architecture, ...parts.tasks, ...parts.order, ...parts.report, ...parts.comments, ...parts.legend];
}

/** The document as lines. */
function renderDocument(plan: Plan, opts: DocumentOptions = {}): string[] {
  return blockLines(documentBlocks(documentParts(plan, opts)));
}

const STATUS_LEGEND = `_Statuses: ${Object.entries(STATUS_MARK).map(([k, v]) => `${v} ${k}`).join(', ')}_`;

/** The task list, one task to a block: its line, its files, its detail. */
function taskBlocks(plan: Plan, opts: { attribution?: boolean; details?: boolean; revs?: boolean } = {}): Block[] {
  const counts = countTasks(plan);
  const b = new BlockList();
  b.add('tasks', derived('the tasks and their statuses'), `## Tasks${counts.total ? ` (${counts.done}/${counts.total} done)` : ''}`);
  const rows = outline(plan);
  if (rows.length === 0) b.add('tasks:none', derived('the tasks'), '_(no tasks yet)_');
  // Ready or waiting means something once there is a task list to build.
  const tracking = planPhase(plan) !== 'planning';
  for (const { task, depth } of rows) {
    const pad = '  '.repeat(depth);
    const me = field('task', task.id);
    const key = `task:${task.id}`;
    b.add(key, me, `${pad}- ${STATUS_MARK[task.status]} ${task.id} ${task.title}${taskFacts(plan, task, tracking)}`);
    if (opts.attribution !== false && task.createdBy === 'user') b.inline(`${key}:by`, WHO, ' _(added by the user)_', { bookkeeping: true });
    if (task.note) b.inline(`${key}:note`, me, ` — ${task.note}`);
    if (opts.revs) b.inline(`${key}:rev`, REV, ` · rev ${task.rev ?? 1}`, { bookkeeping: true });
    if (task.files?.length) b.add(`${key}:files`, me, `${pad}  files: ${task.files.join(', ')}`);
    if (opts.details !== false && task.detail) b.add(`${key}:detail`, me, task.detail.trim().split('\n').map((line) => `${pad}  ${line}`));
  }
  return b.blocks;
}

function renderTasks(plan: Plan, opts: { attribution?: boolean; details?: boolean; revs?: boolean } = {}): string[] {
  return blockLines(taskBlocks(plan, opts));
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
export function buildOrderBlocks(plan: Plan, base?: string): Block[] {
  const { branches, unbranched } = branchPlan(plan);
  if (!hasDependencies(plan) && branches.length === 0) return [];
  const b = new BlockList();
  const steps = buildSteps(plan);
  if (hasDependencies(plan) && steps.length) {
    b.add('build-order', derived('what each task comes after (dependsOn)'), [
      '## Build order',
      '_Each step needs only the steps before it; the tasks within a step can be built side by side._',
      ...steps.map((step, i) => `${i + 1}. ${step.map((t) => `${STATUS_MARK[t.status]} ${t.id} ${t.title}`).join('; ')}`),
    ]);
  }
  if (branches.length) {
    if (b.length) b.gap();
    const lines = ['## Branches', `_Each branch is one pull request. A branch whose tasks build on another branch is cut from it — a stacked pull request._`];
    for (const br of branches) {
      const ids = br.tasks.map((t) => t.id).join(', ');
      if (br.needs.length > 1) {
        // Refused when the task list is made; only an older plan has one.
        lines.push(`- \`${br.branch}\` needs work from ${br.needs.length} branches, which one pull request cannot: harness_plan_check says how to fix it — ${ids}`);
      } else {
        const pr = plan.branches?.[br.branch]?.pr;
        const prText = pr ? ` · pull request${pr.number ? ` #${pr.number}` : ''} ${pr.state}` : '';
        lines.push(`- \`${br.branch}\` from ${baseWords(br.base, base)} — ${ids}${prText}`);
      }
    }
    if (unbranched.length) lines.push(`- no branch named (the session's current branch) — ${unbranched.map((t) => t.id).join(', ')}`);
    b.add('branches', derived("each task's branch", ...(base ? ['the base branch (branches.base)'] : [])), lines);
  }
  return b.blocks;
}

export function renderBuildOrder(plan: Plan, base?: string): string[] {
  return blockLines(buildOrderBlocks(plan, base));
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
    case 'finalizing':
      return (
        '> **Every task is done — finish the build.** Run the final checks, push the branches and open the pull ' +
        'requests (record each with harness_branch_update), then write the build report; harness_task_next says how. ' +
        'The plan is built once the report is in.'
      );
    case 'built':
      return '> **Built.** The user submitted this plan and every task is done. Publishing a new plan replaces it.';
    default:
      return (
        '> **Locked for building.** The user submitted this plan: build it task by task, keeping statuses true with ' +
        'harness_task_update. Only task updates, comments and replies apply now; if the design has to change, ask ' +
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

/**
 * A fingerprint of a prompt. The preview hands it to the page, and the
 * sign-off hands it back: the prompt is rebuilt at sign-off, and if
 * anything it is made from moved since the preview — the agent reading the
 * plan in between, the repository's checks — the user would sign off on
 * text they never read. The version alone does not catch those.
 */
export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

export const PROMPT_MOVED = (what: 'submit' | 'confirm') =>
  `The prompt changed since you previewed it (the agent read the plan, or the repository's checks changed). The preview now ` +
  `shows what would be sent — read it, then ${what} again.`;

/** How every build prompt for this session begins. The hook recognises it
 *  in a message the user pasted themselves, so it is not delivered twice. */
export const BUILD_MARKER = '[cc-harness] Build the plan';

export interface BuildPrompt {
  prompt: string;
  /** Too long to quote whole: the prompt points Claude at harness_plan_read. */
  trimmed: boolean;
  /** The prompt as blocks, each naming its source: joined, they are
   *  `prompt`. What was left out to fit is among them, marked dropped. */
  blocks: Block[];
}

/** How every task-list prompt begins; recognised in a pasted message too. */
export const DESIGN_MARKER = '[cc-harness] The design is confirmed';

export interface PromptOptions {
  /** The agent the prompt is for: how it is told to ask the user things. */
  agent?: AgentKind;
  /** Anything the user added for the agent. */
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
  const chosen = settingSources(opts.settings !== undefined, project);
  const head = new BlockList()
    .push(...(here ? sessionBrief(plan, settings, agentInfo(opts.agent), project, chosen) : outsideBrief(plan, settings, project, chosen)))
    .push(...instructionBlocks(project, 'build', undefined, PROMPT_INSTRUCTIONS))
    .gap()
    .push(...checksBlocks(project, here ? opts.bin : undefined)).blocks;
  const doc = documentParts(plan, { attribution: here, reader: here ? 'claude' : 'outside', base: project.branches.base });
  if (!here) {
    const blocks = [...head, ...fromUser(opts.note), ...documentBlocks(doc)];
    return { prompt: blocksText(blocks), trimmed: false, blocks };
  }
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
  const chosen = settingSources(opts.settings !== undefined, project);
  const branches = project.branches.base || project.branches.prefix
    ? ` Branches are cut from \`${project.branches.base ?? 'the base branch'}\`${project.branches.prefix ? ` and named \`${project.branches.prefix}…\`` : ''}.`
    : '';
  const b = new BlockList();
  b.add('intro', TEMPLATE, `${DESIGN_MARKER} for "`)
    .inline('title', field('plan'), plan.title)
    .inline('intro:end', TEMPLATE, '" — now break it into the task list.');
  b.gap().add(
    'lead',
    TEMPLATE,
    'The user has reviewed the design in Coplan and confirmed it: the architecture, sections and summary below are ' +
      'locked. What you make now is the task list the build will follow. The user reviews it, then submits the plan ' +
      'to start the build. Follow the coplan skill\'s guidance on the task list:',
  );
  b.gap().add(
    'step-1',
    TEMPLATE,
    '1. Start from the tasks planned on the diagram. Break each into focused tasks: one objective, one area of the ' +
      'architecture, small enough to implement and review on its own. In `detail` put the objective, the acceptance ' +
      'criteria and what is out of scope; in `files` the files you expect to touch.',
  );
  b.add(
    'step-2',
    TEMPLATE,
    '2. Link them: `dependsOn` lists the tasks that must be done first (by id). Leave a task free of dependencies ' +
      'whenever it could be built alongside others — that is what lets the build run in parallel. A parent\'s ' +
      'dependencies hold for all its subtasks.',
  );
  b.add('step-3', TEMPLATE, '3. Say what each task builds: `builds` names the boxes it implements (node ids), so the diagram tracks it.');
  b.add(
    'step-4',
    TEMPLATE,
    '4. Decide how it lands. A change that is one pull request needs no `branch`. Otherwise give each group of tasks a ' +
      '`branch`: a branch whose tasks depend on another branch\'s is cut from it, as a stacked pull request.',
  ).inline('step-4:branches', configSource(project, 'branches'), branches);
  b.add('step-5', TEMPLATE, '5. Each task is built implement → review → refine. Review is ')
    .inline('step-5:review', chosen('review'), REVIEW_WORDS[settings.review])
    .inline('step-5:end', TEMPLATE, ' by default; set `review: "user"` on risky or user-facing tasks, `"skip"` on trivial ones.');
  b.add(
    'step-6',
    TEMPLATE,
    '6. Publish it with harness_tasks_publish — keep the ids of planned tasks you keep, so the boxes stay linked — ' +
      'then tell the user in chat that the task list is ready to review, and ask what you need decided with ' +
      `${agentInfo(opts.agent).askWith}. Do not start building: the user submits the plan when the tasks are right.`,
  );
  b.push(...instructionBlocks(project, 'design', undefined, PROMPT_INSTRUCTIONS));
  b.gap().push(...checksBlocks(project, opts.bin, true));
  const doc = documentParts(plan, { base: project.branches.base });
  return fit(plan, b.blocks, fromUser(opts.note), changesSinceRead(plan), doc, project.branches.base);
}

/** Where each build setting a prompt names comes from: the Submit dialog,
 *  when the user chose it there, or else the config's defaults (`iric`). */
type SettingSources = (key: 'review' | 'parallel' | 'maxRounds') => BlockSource;

function settingSources(chosen: boolean, project: ProjectConfig): SettingSources {
  return (key) => (chosen ? setting(key) : configSource(project, `iric.${key}`));
}

function fromUser(note: string | undefined): Block[] {
  const text = note?.trim();
  if (!text) return [];
  return new BlockList().gap().add('note', NOTE, ['## From the user', ...text.split('\n').map((l) => `> ${l}`.trimEnd())]).blocks;
}

/**
 * The prompt whole if it fits in one message; otherwise the instructions,
 * what the user said and changed, the summary and the task list — the rest
 * is one tool call away. What is left out stays among the blocks, marked
 * dropped, so the page can show it.
 */
function fit(plan: Plan, head: Block[], said: Block[], changes: Block[], doc: DocumentParts, base: string | undefined): BuildPrompt {
  const whole = [...head, ...said, ...changes, ...documentBlocks(doc)];
  const text = blocksText(whole);
  if (text.length <= PROMPT_BUDGET) return { prompt: text, trimmed: false, blocks: whole };

  const pointer =
    `_The architecture (${plan.diagrams.length} diagram(s)), the sections and each task's detail are too long to quote ` +
    'here: call harness_plan_read for them before you start._';
  // The instructions and what the user wrote are kept whole. What is left
  // goes to what they changed first — it is what Claude must act on — then
  // the summary, then the task list, each cut to the room that is left.
  const fixed = new BlockList().push(...head, ...said);
  const length = () => joinBlocks(fixed.blocks).length;
  const room0 = () => PROMPT_BUDGET - length() - STATUS_LEGEND.length - 4;
  // The fixed part, a blank line and the pointer.
  const spare = PROMPT_BUDGET - (length() + 2 + pointer.length) - STATUS_LEGEND.length - 300;
  const changed = clipLines(blockLines(changes), Math.max(300, Math.min(2_500, Math.floor(spare * 0.6))));
  for (const block of changes) {
    if (changed.kept.length) fixed.push({ ...block, text: changed.kept.join('\n'), ...(changed.cut ? { cut: true as const } : {}) });
    else fixed.push({ ...block, dropped: true });
  }
  if (changed.cut) fixed.add('changes:more', TEMPLATE, CHANGES_CUT);
  fixed.gap().add('pointer', TEMPLATE, pointer);

  const summaryRoom = Math.min(1_200, room0() - 300);
  if (plan.summary.trim() && summaryRoom > 150) {
    const { kept, cut } = clipLines(nestHeadings(plan.summary.trim(), 2).split('\n'), summaryRoom);
    fixed.gap().add('summary', field('plan'), ['## Summary', ...kept, ...(cut ? ['…'] : [])], cut ? { cut: true } : {});
  } else fixed.push(...dropAll(doc.summary));
  // The design is what harness_plan_read is for.
  fixed.push(...dropAll(doc.sections), ...dropAll(doc.architecture));

  const order = buildOrderBlocks(plan, base);
  const orderText = joinBlocks(order);
  const withOrder = orderText.length < 1_500 && orderText.length + 2 < room0() - 300;
  const room = room0() - (withOrder ? orderText.length + 2 : 0);

  // The task list without the details, cut at a line: each task's line and
  // its files are lines of their own. A detail is never quoted here.
  type Item = { line: Block[]; text: string } | { detail: Block };
  const items: Item[] = [];
  for (const block of taskBlocks(plan)) {
    const last = items[items.length - 1];
    if (block.id.endsWith(':detail')) items.push({ detail: block });
    else if (block.inline && last && 'line' in last) last.line.push(block);
    else items.push({ line: [block], text: '' });
  }
  const total = items.filter((i) => 'line' in i).length;
  const rest = new BlockList().gap();
  let used = 0;
  let kept = 0;
  let full = false;
  for (const item of items) {
    if ('detail' in item) {
      rest.push({ ...item.detail, dropped: true });
      continue;
    }
    const line = joinBlocks(item.line);
    if (!full && used + line.length + 1 > room - 80) {
      full = true;
      rest.add('tasks:more', TEMPLATE, `- …and ${total - kept} more line(s): harness_plan_read lists every task.`);
    }
    if (full) rest.push(...dropAll(item.line));
    else {
      rest.push(...item.line);
      used += line.length + 1;
      kept++;
    }
  }
  if (withOrder && order.length) rest.gap().push(...order);
  else rest.push(...dropAll(order));
  rest.push(...dropAll(doc.report), ...dropAll(doc.comments));
  rest.gap().add('legend', TEMPLATE, STATUS_LEGEND, { bookkeeping: true });
  const blocks = [...fixed.blocks, ...rest.blocks];
  return { prompt: blocksText(blocks), trimmed: true, blocks };
}

function sessionBrief(plan: Plan, s: BuildSettings, agent: AgentInfo, project: ProjectConfig, chosen: SettingSources): Block[] {
  const together =
    s.parallel > 1
      ? `build them side by side, up to ${s.parallel} at once, each by its own subagent given that task's harness_task_brief`
      : 'build them one at a time';
  const { branches } = branchPlan(plan);
  const b = new BlockList();
  b.add('intro', TEMPLATE, `${BUILD_MARKER} "`)
    .inline('title', field('plan'), plan.title)
    .inline('intro:end', TEMPLATE, '" — the user has reviewed it in Coplan and submitted it.');
  b.gap().add(
    'lead',
    TEMPLATE,
    'The plan is final. Its architecture is locked, and from here Coplan follows your progress on its task board, ' +
      "so keep every task's status true as you go. Run the build with the coplan-build skill, and take each task " +
      'through the iric skill — implement → review → refine:',
  );
  b.gap().add('step-1', TEMPLATE, '1. Start only tasks that are ready: harness_task_next lists them, and what every other task waits on. Tasks that are ready together do not depend on each other — ')
    .inline('step-1:parallel', chosen('parallel'), together)
    .inline('step-1:end', TEMPLATE, ". harness_task_brief gives one task's focused brief: its objective, where it fits, its branch and its checks.");
  b.add(
    'step-2',
    TEMPLATE,
    '2. When you start a task, mark it in_progress with stage "implement" (harness_task_update) and run the implement ' +
      'checks. Set stage "review" when it goes to review, and "refine" when the review asks for changes. Report the ' +
      'checks you ran with `checks`.',
  );
  b.add('step-3', TEMPLATE, '3. Review: ')
    .inline('step-3:review', chosen('review'), REVIEW_WORDS[s.review])
    .inline('step-3:end', TEMPLATE, ', unless a task says otherwise.')
    .inline('step-3:model', configSource(project, 'review.model'), s.review === 'subagent' ? reviewerWords(project) : '')
    .inline('step-3:rounds', chosen('maxRounds'), ` After ${s.maxRounds} review round${s.maxRounds === 1 ? '' : 's'} without passing, stop and ask the user.`);
  b.add('step-4', TEMPLATE, '4. Mark a task done only once its review passed and its review checks are green, with a one-line note of what you did.');
  b.add('step-5', TEMPLATE, `5. If you are stuck, mark the task blocked with a note saying on what, and ask the user with ${agent.askWith}.`);
  b.add('step-6', TEMPLATE, '6. For work that is not on the plan, add a task first (harness_plan_edit, upsert_task with a parentId), then do it.');
  b.add(
    'step-7',
    TEMPLATE,
    branches.length
      ? '7. Land each task on its branch (see Branches below): cut a stacked branch from the one it builds on. '
      : '7. Everything lands on the current branch: no task names a branch of its own. ',
  ).inline('step-7:pull-requests', configSource(project, 'pullRequests'), pullRequestWords(project, { pointer: true }));
  b.add(
    'step-8',
    TEMPLATE,
    '8. Do not redesign as you go: the diagrams and sections can no longer be edited. If the design has to change, ' +
      'stop and ask the user in chat — they can reopen the plan in Coplan.',
  );
  b.add(
    'step-9',
    TEMPLATE,
    '9. When every task is done, run the final checks, write the build report (harness_plan_edit {ops: [{op: "report", text, checks}]}) ' +
      'and give the user the final summary: what was built, the branches and pull requests, and how it was checked.',
  ).inline('step-9:final', configSource(project, 'final.blocking'), finalWords(project));
  return b.blocks;
}

function outsideBrief(plan: Plan, s: BuildSettings, project: ProjectConfig, chosen: SettingSources): Block[] {
  const b = new BlockList();
  b.add('intro', TEMPLATE, 'Build "')
    .inline('title', field('plan'), plan.title)
    .inline('intro:end', TEMPLATE, '". This plan was designed and reviewed before any code was written, and this is its final version.');
  b.gap().add(
    'step-1',
    TEMPLATE,
    '1. Work through the tasks below. A task starts only once everything it comes after is done; where the plan gives ' +
      'a build order, tasks in the same step do not depend on each other and can be built side by side.',
  );
  b.add('step-2', TEMPLATE, '2. Take each task through implement → review → refine: implement it and run the implement checks; review the change (')
    .inline('step-2:review', chosen('review'), REVIEW_WORDS[s.review])
    .inline('step-2:end', TEMPLATE, ') and run the review checks; refine until it passes.')
    .inline('step-2:rounds', chosen('maxRounds'), ` After ${s.maxRounds} round${s.maxRounds === 1 ? '' : 's'}, stop and ask.`);
  b.add('step-3', TEMPLATE, '3. Build the architecture as described: its parts, what each one does and decides, and how they connect.');
  b.add('step-4', TEMPLATE, '4. Where tasks name branches, land each task on its branch; a branch built on another is cut from it. ')
    .inline('step-4:pull-requests', configSource(project, 'pullRequests'), pullRequestWords(project));
  b.add('step-5', TEMPLATE, '5. If the design turns out not to work, stop and say why rather than redesigning as you go.');
  b.add('step-6', TEMPLATE, '6. When every task is done, run the final checks and summarize what was built, where, and how it was checked.')
    .inline('step-6:final', configSource(project, 'final.blocking'), project.final.blocking ? ' Do not call the build finished while a final check fails.' : '');
  // No harness_task_next out there: the template comes with the prompt.
  b.push(...templateBlocks(project));
  return b.blocks;
}

/** The repository's checks, per stage — or what to do without any. */
export function checksBlocks(project: ProjectConfig, bin?: string, planning = false): Block[] {
  const b = new BlockList();
  const head = ['## Checks', ...[...project.errors, ...project.warnings].map((e) => `- ⚠ ${e}`)];
  if (!hasHooks(project)) {
    head.push(
      planning
        ? `This repository has no ${PROJECT_CONFIG_PATH} with checks. Suggest /coplan-init to the user, so the build runs the right checks instead of guessing.`
        : `No checks are configured (${PROJECT_CONFIG_PATH}). Work out what to run from the repository's scripts and CI, use the same commands for every task, and say which in each task's done note.`,
    );
    return b.add('checks', configSource(project, 'hooks'), head).blocks;
  }
  b.add('checks', configSource(project, 'hooks'), [...head, `_From ${PROJECT_CONFIG_PATH}, run from the repository root:_`]);
  for (const stage of HOOK_STAGES) {
    const hooks = project.hooks[stage];
    if (!hooks.length) continue;
    const list = hooks.map((h) => `${h.name} \`${hookCommand(h)}\`${h.paths ? ` (for ${h.paths.join(', ')})` : ''}${h.optional ? ' (optional)' : ''}`);
    b.add(`checks:${stage}`, configSource(project, `hooks.${stage}`), `- ${stage}: ${list.join('; ')}`);
  }
  if (bin) b.add('checks:run', TEMPLATE, `Run a whole stage with \`"${bin}" check <stage>\` — \`--files a,b\` for one task's files, \`--json\` for harness_task_update's \`checks\`.`);
  return b.blocks;
}

export function checksSection(project: ProjectConfig, bin?: string, planning = false): string[] {
  return blockLines(checksBlocks(project, bin, planning));
}

/** How the build's pull requests are opened, as the repository says
 *  (`pullRequests` in .coplan/config.json). */
export function pullRequestWords(project: ProjectConfig, opts: { pointer?: boolean } = {}): string {
  const { tool, open } = project.pullRequests;
  if (open === 'never') return 'Do not open pull requests: push the branches, and list each in the report with what it carries.';
  if (tool === 'none') return 'Push the branches, and leave opening the pull requests to the user: list each in the report with what it carries and what it stacks on.';
  const how =
    tool === 'graphite'
      ? 'with Graphite: track each branch on the one below it (`gt track`), and open the stack with `gt submit --stack`'
      : 'with `gh pr create`, each against the branch below it (the base branch for the bottom one)';
  const when = open === 'auto' ? 'as soon as a branch\'s tasks are done' : 'once the user says to: ask them first';
  return `Open the pull requests ${how}, ${when}.${opts.pointer && project.pullRequests.template ? ` Write each description from the pull request template (${project.pullRequests.templateFile}), which harness_task_next shows when one is due.` : ''}`;
}

/** The pull request template (the repository's, or the user's own), to fill in for each one. */
export function templateBlocks(project: ProjectConfig): Block[] {
  const { template, templateFile } = project.pullRequests;
  if (!template) return [];
  return new BlockList()
    .gap()
    .add('pull-request-template', configSource(project, 'pullRequests.template'), [
      `### Each pull request's description`,
      `Fill in the pull request template (${templateFile}) from the tasks the pull request carries, their checks and their review:`,
      '',
      '~~~~markdown',
      template,
      '~~~~',
    ]).blocks;
}

export function templateLines(project: ProjectConfig): string[] {
  return blockLines(templateBlocks(project));
}

/** The standing words the user and the repository add at one point. */
export function instructionBlocks(project: ProjectConfig, point: InstructionPoint, heading = '## Standing instructions', max = Infinity): Block[] {
  const whole = project.instructions[point];
  if (!whole) return [];
  // A prompt a hook hands over has a budget, and these sit in the part of it
  // that is never trimmed: past `max`, the rest is pointed to, not lost.
  const cut = whole.length > max;
  const text = cut ? `${whole.slice(0, max).replace(/\s+\S*$/, '')} …` : whole;
  return new BlockList().gap().add(
    `instructions:${point}`,
    configSource(project, `instructions.${point}`),
    [
      heading,
      '_From the user\'s and the repository\'s Coplan config; they hold for all of this._',
      '',
      nestHeadings(text, heading.startsWith('###') ? 3 : 2),
      ...(cut ? ['', `_Cut to fit here: the whole text is \`instructions.${point}\` in .coplan/config.json and ${path.join(paths.configDir(), GLOBAL_PROJECT_FILE)} (or ${INSTRUCTIONS_DIR}/${point}.md beside it)._`] : []),
    ],
    cut ? { cut: true } : {},
  ).blocks;
}

export function instructionLines(project: ProjectConfig, point: InstructionPoint, heading = '## Standing instructions', max = Infinity): string[] {
  return blockLines(instructionBlocks(project, point, heading, max));
}

/** How much of the standing instructions a prompt carries, within its budget. */
const PROMPT_INSTRUCTIONS = 1_500;

/** Who reviews, with the model the repository names for it. */
export function reviewerWords(project: ProjectConfig): string {
  return project.review.model ? ` Run the reviewer on the \`${project.review.model}\` model.` : '';
}

/** What a failing final check does to the report. */
export function finalWords(project: ProjectConfig): string {
  const held = project.hooks.final.filter((h) => !h.optional);
  if (!project.final.blocking || !held.length) return '';
  return ` The report is refused until it carries every final check (${held.map((h) => h.name).join(', ')}) passing, in \`checks\`.`;
}

/** What the user changed since Claude last read, when Claude has read before. */
function changesSinceRead(plan: Plan): Block[] {
  const unread = unreadByClaude(plan);
  if (!plan.claudeBaseline || unread.length === 0) return [];
  // As lines, so a long summary is cut between changes, never dropped whole.
  return new BlockList().gap().add('changes', CHANGES, renderChanges(plan, unread, false).split('\n')).blocks;
}

/** Where a change summary too long for the prompt is cut. */
const CHANGES_CUT = '- …and more than fits here: harness_plan_read {changes_only: true} lists every change the user made.';

/** Lines, kept while they fit in about `max` characters. */
function clipLines(lines: string[], max: number): { kept: string[]; cut: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > max) return { kept, cut: true };
    kept.push(line);
    used += line.length + 1;
  }
  return { kept, cut: false };
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
  // Reopening a sign-off is state, not content: say where it stands now.
  const reopened = unread.filter((c) => c.target.kind === 'plan' && c.kind === 'status').map((c) => c.summary);
  if (reopened.includes(REOPENED_PLAN)) {
    meta.push(
      plan.submission
        ? 'Reopened the submitted plan, then submitted it again.'
        : 'Reopened the submitted plan: it is no longer locked, and the tasks can change again. Do not build until they submit it again.',
    );
  }
  if (reopened.includes(REOPENED_DESIGN)) {
    meta.push(
      plan.design
        ? 'Reopened the design, then confirmed it again.'
        : 'Reopened the design: it is no longer confirmed, so the architecture can change again. Wait for them to confirm it before making the task list.',
    );
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

  // So is the user's verdict on a task they review: it decides what the
  // agent does next — mark it done, or refine.
  const verdicts = unread
    .filter((c) => c.kind === 'status' && c.target.kind === 'task' && / in review round \d+/.test(c.summary))
    .map((c) => `${capital(c.summary)}.`);
  block('Reviews', verdicts);

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
    // What a task waits on, where it lands and who reviews it are the
    // user's build decisions: every one of them is news.
    const deps = (t: { dependsOn?: string[] }) => [...(t.dependsOn ?? [])].sort().join(', ');
    if (deps(was) !== deps(now)) facts.push(`now waits on ${deps(now) || 'nothing'} (was ${deps(was) || 'nothing'})`);
    if ((was.branch ?? '') !== (now.branch ?? '')) {
      facts.push(`branch ${was.branch ? `\`${was.branch}\`` : 'inherited'} → ${now.branch ? `\`${now.branch}\`` : 'inherited'}`);
    }
    if ((was.review ?? '') !== (now.review ?? '')) facts.push(`review ${was.review ?? 'default'} → ${now.review ?? 'default'}`);
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

/** One open comment, on the item it is about; the hint on how to reply
 *  is the agent's bookkeeping. */
function threadBlocks(plan: Plan, t: Thread, reader: 'claude' | 'outside' = 'claude'): Block[] {
  const who = (author: 'user' | 'claude') => (author === 'user' ? 'user' : reader === 'claude' ? 'you' : 'planner');
  const lines = [`- [${t.id}] on ${describeTarget(plan, t.target)} — ${who(t.author)}: ${hang(t.text, 4)}`];
  for (const r of t.replies) lines.push(`  ↳ ${who(r.author)}: ${hang(r.text, 4)}`);
  const b = new BlockList().add(`thread:${t.id}`, { kind: 'field', target: t.target }, lines);
  if (reader === 'claude' && lastAuthor(t) === 'user') {
    b.add(`thread:${t.id}:reply`, TEMPLATE, `  → reply with harness_plan_edit {ops: [{op: "reply", threadId: "${t.id}", text}]} once you have acted on it`, { bookkeeping: true });
  }
  return b.blocks;
}

function renderThread(plan: Plan, t: Thread, reader: 'claude' | 'outside' = 'claude'): string {
  return joinBlocks(threadBlocks(plan, t, reader));
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
