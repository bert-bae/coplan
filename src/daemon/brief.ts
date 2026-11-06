/**
 * What Claude reads while it builds: where the build stands, and one task's
 * brief.
 *
 * `harness_task_next` answers "what can I start now?" — the ready tasks, how
 * many to build at once, what the rest wait on — so the order comes from the
 * plan's dependencies rather than from re-reading the whole document.
 *
 * `harness_task_brief` is a single task, self-contained: its objective, the
 * parts of the architecture it builds, what it comes after and before, its
 * branch, and its implement → review → refine cycle with the exact checks.
 * It is written so Claude can hand it to a subagent as it is: the subagent
 * learns how its piece fits the whole, and where its job ends.
 */
import type { BuildSettings, ExecutionMode, Plan, Task, Thread } from '../shared/types.ts';
import { countTasks, describeTarget, findPart, outline, planPhase } from '../shared/plan.ts';
import {
  DEFAULT_BUILD_SETTINGS,
  MODE_LABEL,
  REVIEW_WORDS,
  ancestorsOf,
  branchPlan,
  SESSION_BRANCH,
  baseWords,
  roundVerdict,
  stackStatus,
  buildSteps,
  dependents,
  effectiveBranch,
  effectiveReview,
  hasSubtasks,
  inheritedDeps,
  isManaged,
  leafTasks,
  leavesUnder,
  planMode,
  readinessOf,
  sharedFiles,
  waitingOn,
} from '../shared/build.ts';
import { HOOK_STAGES, configSource, emptyProjectConfig, hasHooks, hookCommand, hooksFor, type ProjectConfig } from '../shared/project.ts';
import { hang, indent, nestHeadings } from '../shared/architecture.ts';
import { agentInfo, type AgentKind } from '../shared/agents.ts';
import {
  checkWords,
  checksBlocks,
  finalWords,
  instructionBlocks,
  partBlocks,
  pullRequestWords,
  relatedTasks,
  renderBuildOrder,
  reviewerWords,
  stageWords,
  templateLines,
} from './render.ts';
import { BlockList, TEMPLATE, derived, field, joinBlocks, setting, type Block, type BlockSource } from '../shared/blocks.ts';

export interface BriefOptions {
  /** The agent building it: how it is told to ask the user things. */
  agent?: AgentKind;
  settings?: BuildSettings;
  /** The mode before the plan is submitted; a submitted plan's own wins. */
  mode?: ExecutionMode;
  project?: ProjectConfig;
  /** The coplan CLI on this machine, for `coplan check`. */
  bin?: string;
}

function settingsOf(plan: Plan, opts: BriefOptions): BuildSettings {
  return plan.submission?.settings ?? opts.settings ?? opts.project?.settings ?? DEFAULT_BUILD_SETTINGS;
}

/** Managed or not: whether the brief and the next steps carry the cycle. */
function managedFor(plan: Plan, opts: BriefOptions): boolean {
  return isManaged(planMode(plan, opts.mode ?? opts.project?.mode ?? 'tracked'));
}

const line = (t: Task) => `${t.id} ${t.title}`;

/* ------------------------------------------------------------------ *
 * Where the build stands
 * ------------------------------------------------------------------ */

export function renderNext(plan: Plan, opts: BriefOptions = {}): string {
  const settings = settingsOf(plan, opts);
  const project = opts.project ?? emptyProjectConfig();
  const leaves = leafTasks(plan);
  const counts = countTasks(plan);
  const phase = planPhase(plan);
  const out: string[] = [];

  if (leaves.length === 0) {
    return `# "${plan.title}" has no tasks yet\nPublish the task list with harness_tasks_publish (or tasks with harness_plan_publish while designing).`;
  }

  if (counts.done === counts.total) {
    out.push(`# Every task in "${plan.title}" is done (${counts.total})`, '', 'Finish the build:', '');
    const final = project.hooks.final;
    out.push(
      final.length
        ? `1. Run the final checks: ${final.map((h) => `${h.name} \`${hookCommand(h)}\``).join('; ')}${opts.bin ? ` — or all of them with \`"${opts.bin}" check final\`` : ''}. Fix anything they find, as a task.`
        : '1. Run the repository\'s full checks (its test suite and build, as CI would) and fix anything they find, as a task.',
    );
    const { branches } = branchPlan(plan);
    out.push(
      branches.length
        ? `2. Push each branch, in stack order: ${branches
            .map((b) => `\`${b.branch}\`${b.base === SESSION_BRANCH ? ' (onto the branch you are on)' : b.base ? ` (onto \`${b.base}\`)` : ''}`)
            .join(' → ')}. ${pullRequestWords(project)} Record each pull request with harness_branch_update {branch, pr_url, pr_number, pr_state}, so the board ` +
          'shows the stack.'
        : `2. Commit and push the work on the current branch. ${pullRequestWords(project)}`,
      `3. Write the build report with harness_plan_edit {ops: [{op: "report", text, checks}]}: what each task did, the branches and pull requests, anything that differs from the plan, and follow-ups — with the final checks as they came out in \`checks\`. The plan is built once it is in.${finalWords(project)}`,
      '4. Give the user the final summary in chat, with the links.',
    );
    out.push(...templateLines(project));
    out.push(...renderStack(plan, project.branches.base));
    if (plan.report) out.push('', `_A build report was written ${new Date(plan.report.at).toISOString().slice(0, 16).replace('T', ' ')}; writing it again replaces it._`);
    return out.join('\n');
  }

  const managed = managedFor(plan, opts);
  out.push(`# Next in "${plan.title}"`);
  out.push(
    managed
      ? `_tasks ${counts.done}/${counts.total} done · up to ${settings.parallel} at once · review: ${settings.review} · at most ${settings.maxRounds} review round${settings.maxRounds === 1 ? '' : 's'}_`
      : `_tasks ${counts.done}/${counts.total} done · ${MODE_LABEL.tracked}: how each task is built and checked is yours to decide_`,
  );
  if (phase === 'planning' || phase === 'tasking') {
    out.push('', `> The plan is not submitted yet (${phase === 'planning' ? 'the design is still open' : 'the task list is being shaped'}). This is how the build would start; do not build until the user submits it.`);
  }

  const by = (state: string) => leaves.filter((t) => readinessOf(plan, t) === state);
  const ready = by('ready');
  const active = by('in_progress');
  const waiting = by('waiting');
  const blocked = by('blocked');

  const describe = (t: Task) => {
    const facts: string[] = [];
    const branch = effectiveBranch(plan, t);
    if (branch) facts.push(`branch \`${branch}\``);
    const review = effectiveReview(plan, t, settings.review);
    if (review !== settings.review) facts.push(`review: ${review}`);
    if (t.files?.length) facts.push(`${t.files.length} file${t.files.length === 1 ? '' : 's'}`);
    return facts.length ? ` · ${facts.join(' · ')}` : '';
  };

  if (active.length) {
    out.push('', `## In progress (${active.length})`);
    for (const t of active) {
      const state = [t.stage ? stageWords(t) : '', t.checks?.length ? `checks ${checkWords(t)}` : ''].filter(Boolean).join(' · ');
      out.push(`- ${line(t)}${state ? ` — ${state}` : ''}${t.note ? ` — ${t.note}` : ''}`);
      if (!managed) continue;
      // The verdict on its current round, if one is in: what to do next.
      const mode = effectiveReview(plan, t, settings.review);
      const verdict = roundVerdict(t, mode);
      if (verdict) {
        const who = verdict.by === 'user' ? 'the user' : 'review';
        out.push(`  ${verdict.verdict === 'pass' ? `✓ passed by ${who}: mark it done` : `✗ ${who} asked for changes: refine`}${verdict.summary ? ` — ${verdict.summary}` : ''}.`);
      } else if (t.stage === 'review' && mode === 'user') {
        out.push('  ⏸ waiting on the user\'s review: ask them; they can approve it in Coplan.');
      }
      if (t.round && t.round >= settings.maxRounds && t.stage !== 'review') {
        out.push(`  ⚠ ${t.round} of ${settings.maxRounds} review rounds used: another needs the user's go-ahead (user_approved).`);
      }
    }
  }

  const room = Math.max(0, settings.parallel - active.length);
  if (ready.length) {
    out.push('', `## Ready to start (${ready.length})`);
    for (const t of ready) out.push(`- ${line(t)}${describe(t)}`);
    const clashes: string[] = [];
    const busy = [...active, ...ready];
    for (let i = 0; i < busy.length; i++) {
      for (let j = i + 1; j < busy.length; j++) {
        const files = sharedFiles(busy[i]!, busy[j]!);
        if (files.length && ready.includes(busy[j]!)) clashes.push(`${busy[i]!.id} and ${busy[j]!.id} both touch ${files.slice(0, 3).join(', ')}`);
      }
    }
    const advice = !managed
      ? ready.length === 1
        ? '_Start it now._'
        : '_None of these waits on another: start them in whatever order, and as many at once, as suits you._'
      : room === 0
        ? `_${active.length} task${active.length === 1 ? ' is' : 's are'} already in progress, the most this build runs at once (${settings.parallel}). Start the next when one is done._`
        : settings.parallel === 1
          ? '_Build one at a time: start the first, and come back here when it is done._'
          : ready.length === 1 || room === 1
            ? `_Start ${ready.length === 1 ? 'it' : 'the first'} now${active.length ? ', alongside what is in progress' : ''} — by a subagent given its harness_task_brief, or yourself._`
            : `_None of these waits on another. Start up to ${Math.min(room, ready.length)} now, each by its own subagent given its harness_task_brief${
                branchPlan(plan).branches.length ? ' — in its own worktree when it is on a different branch' : ''
              }._`;
    out.push(advice);
    if (clashes.length) out.push(`_Not at the same time in one working tree: ${clashes.join('; ')}._`);
  } else if (!active.length) {
    out.push('', '## Nothing can start', blocked.length ? 'Every remaining task is blocked or waits on a blocked one: resolve the blocks with the user.' : 'Every remaining task waits on another.');
  }

  if (waiting.length) {
    out.push('', `## Waiting (${waiting.length})`);
    for (const t of waiting) out.push(`- ${line(t)} — waits on ${waitingOn(plan, t).map((d) => d.id).join(', ')}`);
  }
  if (blocked.length) {
    out.push('', `## Blocked (${blocked.length})`);
    for (const t of blocked) out.push(`- ${line(t)}${t.note ? ` — ${t.note}` : ''}`);
  }

  // Pull requests opened as branches finish: the branches whose tasks are
  // all done and that have none yet.
  const { open, tool } = project.pullRequests;
  if (open === 'auto' && tool !== 'none') {
    const finished = (branch: string) => leaves.filter((t) => effectiveBranch(plan, t) === branch).every((t) => t.status === 'done' || t.status === 'dropped');
    // A stacked branch's pull request goes against the one below it, so that
    // one is opened first: until then, the branch above waits, done or not.
    // Every branch it needs, not only the one it is cut from: a branch built
    // on two (a layout the plan check flags) waits for both.
    const below = (b: { needs: string[] }) => b.needs.every((n) => n === SESSION_BRANCH || Boolean(plan.branches?.[n]?.pr));
    const due = branchPlan(plan).branches.filter((b) => !plan.branches?.[b.branch]?.pr && finished(b.branch) && below(b));
    if (due.length) {
      out.push('', `## Ready for a pull request (${due.length})`, ...due.map((b) => `- \`${b.branch}\`: every task on it is done.`), pullRequestWords(project), ...templateLines(project));
    }
  }

  // Once a pull request is out, the stack as it stands; before, the plan.
  if (plan.branches && Object.keys(plan.branches).length) out.push(...renderStack(plan, project.branches.base));
  else {
    const order = renderBuildOrder(plan, project.branches.base).filter((l) => !l.startsWith('## Build order'));
    const branchesAt = order.findIndex((l) => l.startsWith('## Branches'));
    if (branchesAt >= 0) out.push('', ...order.slice(branchesAt));
  }

  out.push(
    '',
    managed
      ? 'Start a task with harness_task_update {task_id, status: "in_progress", stage: "implement"}, then take it through ' +
          'the iric cycle. Starting a task that still waits on another is refused.'
      : 'Start a task with harness_task_update {task_id, status: "in_progress"}, and mark it "done" with a one-line note ' +
          'once it is finished. Starting a task that still waits on another is refused.',
  );
  return out.join('\n');
}

/** The stack as it stands — each branch, what it is cut from, its pull
 *  request — and what needs doing where a branch below merged. */
function renderStack(plan: Plan, repoBase: string | undefined): string[] {
  const stack = stackStatus(plan, repoBase);
  if (!stack.length) return [];
  const out = ['', '## Branches and pull requests'];
  for (const s of stack) {
    const onto = s.state?.base ? `\`${s.state.base}\`` : baseWords(s.base, repoBase);
    const pr = s.state?.pr
      ? `pull request${s.state.pr.number ? ` #${s.state.pr.number}` : ''} ${s.state.pr.state}${s.state.pr.url ? ` — ${s.state.pr.url}` : ''}`
      : 'no pull request yet';
    out.push(`- \`${s.branch}\` onto ${onto}: ${pr}`);
    if (s.restack) out.push(`  ⚠ ${s.restack}`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * One task
 * ------------------------------------------------------------------ */

export function renderBrief(plan: Plan, task: Task, opts: BriefOptions = {}): string {
  return joinBlocks(briefBlocks(plan, task, opts));
}

/**
 * One task's brief as blocks, each naming its source: the task and its
 * parents, the plan's summary and sections, the boxes it builds, what it
 * comes after, the repository's checks and words, and Coplan's own
 * instructions. Joined, they are what harness_task_brief returns.
 */
export function briefBlocks(plan: Plan, task: Task, opts: BriefOptions = {}): Block[] {
  const settings = settingsOf(plan, opts);
  const project = opts.project ?? emptyProjectConfig();
  // The build settings: as the user chose them at submit, or the config's.
  const chosen = Boolean(plan.submission?.settings ?? opts.settings);
  const settingSource = (key: 'review' | 'maxRounds'): BlockSource => (chosen ? setting(key) : configSource(project, `iric.${key}`));
  const me = field('task', task.id);
  const b = new BlockList();
  const path = ancestorsOf(plan, task).reverse();
  const number = outline(plan).find((r) => r.task.id === task.id)?.number;

  b.add('heading', me, `# Task ${task.id}: ${task.title}`);
  b.add(
    'context',
    derived("the plan's title", 'where the task sits in the outline'),
    `_Part of "${plan.title}"${number ? ` · task ${number}` : ''}${path.length ? ` · under ${path.map((t) => `"${t.title}"`).join(' › ')}` : ''}. ` +
      'This brief is everything needed to build this task — and where its job ends._',
  );

  if (plan.summary.trim()) b.gap().add('summary', field('plan'), ['## The plan, in short', nestHeadings(plan.summary.trim(), 2)]);

  // The plan's own prose — context, risks, what is out of scope — holds for
  // every task: a subagent given only this brief must have it too.
  const sections = plan.sections.filter((s) => s.body.trim());
  if (sections.length) {
    b.gap().add('sections', TEMPLATE, '## From the plan');
    let room = SECTIONS_BUDGET;
    let left = false;
    for (const s of sections) {
      const body = nestHeadings(s.body.trim(), 3);
      if (room <= 0) {
        // Past the budget: left out, and pointed to.
        left = true;
        b.add(`section:${s.id}`, field('section', s.id), [`### ${s.title}`, body], { dropped: true });
        continue;
      }
      const { text, cut } = clipProse(body, Math.min(SECTION_MAX, room));
      b.gap().add(`section:${s.id}`, field('section', s.id), [`### ${s.title}`, text], cut ? { cut: true } : {});
      room -= text.length;
      if (cut) left = true;
    }
    if (left) b.gap().add('sections:more', TEMPLATE, '_…more of the plan than fits here: harness_plan_read {peek: true} has all of it._');
  }

  // The objective.
  b.gap().add('objective', me, ['## Your objective', `**${task.title}**`]);
  if (task.detail?.trim()) b.gap().add('objective:detail', me, task.detail.trim());
  for (const parent of path) {
    if (parent.detail?.trim()) b.gap().add(`parent:${parent.id}`, field('task', parent.id), [`From "${parent.title}", which this is part of:`, ...indent(parent.detail, 2)]);
  }
  if (hasSubtasks(plan, task.id)) {
    // In build order — what waits on another comes after it — not outline order.
    const rank = new Map(buildSteps(plan).flatMap((step, i) => step.map((t) => [t.id, i] as const)));
    const leaves = leavesUnder(plan, task.id).map((t, i) => ({ t, i })).sort((a, b) => (rank.get(a.t.id) ?? 0) - (rank.get(b.t.id) ?? 0) || a.i - b.i);
    b.gap().add('subtasks', TEMPLATE, `Its subtasks — build them in this order${managedFor(plan, opts) ? ', each through its own cycle' : ''}:`);
    for (const { t: leaf } of leaves) b.add(`subtask:${leaf.id}`, field('task', leaf.id), `- [${leaf.status === 'done' ? 'x' : ' '}] ${line(leaf)}`);
  }
  const files = task.files?.length ? task.files : leavesUnder(plan, task.id).flatMap((t) => t.files ?? []);
  if (files.length) b.gap().add('files', task.files?.length ? me : derived("its subtasks' files"), `Files you expect to touch: ${[...new Set(files)].join(', ')}`);

  // Where it fits.
  const fits = partBlocks(plan, task);
  const before = inheritedDeps(plan, task).map((id) => plan.tasks.find((t) => t.id === id)!).filter(Boolean);
  const after = dependents(plan, task);
  if (fits.length || before.length || after.length) {
    b.gap().add('fits', TEMPLATE, '## Where it fits');
    if (fits.length) b.add('parts', TEMPLATE, 'It builds these parts of the architecture:').push(...fits);
    if (before.length) {
      b.gap().add('comes-after', TEMPLATE, 'It comes after — build on what these did:');
      for (const t of before) {
        const done = leavesUnder(plan, t.id).every((l) => l.status === 'done');
        const branch = effectiveBranch(plan, t);
        b.add(`comes-after:${t.id}`, field('task', t.id), `- ${done ? '[x]' : '[ ] NOT DONE YET —'} ${line(t)}${t.note ? ` — ${t.note}` : ''}${branch ? ` · on \`${branch}\`` : ''}`);
      }
    }
    if (after.length) {
      b.gap().add('waited-on', derived('the tasks that come after it (dependsOn)'), `Waiting on it: ${after.map(line).join('; ')}. Leave their work to them, but do not make it harder.`);
    }
  }

  const waits = waitingOn(plan, task);
  if (waits.length && task.status !== 'done') {
    b.gap().add('waits', derived('what it comes after, and how far each is'), `> ⚠ This task cannot start yet: it waits on ${waits.map(line).join('; ')}.`);
  }

  // The edges of the job.
  const mine = relatedTasks(plan, task);
  const neighbours = leafTasks(plan).filter((t) => !mine.has(t.id) && t.status !== 'done' && (readinessOf(plan, t) === 'in_progress' || sharedFiles(task, t).length));
  b.gap().add('scope', TEMPLATE, [
    '## Stay in scope',
    'Build what this task describes and nothing more — the plan gives other parts to other tasks. If you find work ' +
      'outside it, say so in your report instead of doing it; it becomes a task of its own.',
  ]);
  for (const t of neighbours) {
    const shared = sharedFiles(task, t);
    b.add(`neighbour:${t.id}`, field('task', t.id), `- ${line(t)}${readinessOf(plan, t) === 'in_progress' ? ' is being built right now' : ''}${shared.length ? ` — also touches ${shared.join(', ')}` : ''}.`);
  }

  b.push(...instructionBlocks(project, 'brief'));

  // Where it lands.
  const branch = effectiveBranch(plan, task);
  b.gap().add('branch', TEMPLATE, '## Branch');
  if (branch) {
    const entry = branchPlan(plan).branches.find((e) => e.branch === branch);
    const base = project.branches.base ? `\`${project.branches.base}\`` : 'the base branch';
    const from =
      entry?.needs.length && entry.needs.length > 1
        ? // Refused when the task list is made; only an older plan has one.
          `It needs work from ${entry.needs.length} branches, which one pull request cannot stack on: stop and ask the user how to land it.`
        : entry?.base === SESSION_BRANCH
          ? `Cut it from the branch you are on, where the tasks with no branch land (a stacked branch: it builds on that work), not from ${base}.`
          : entry?.base
            ? `Cut it from \`${entry.base}\` (a stacked branch: it builds on that work), not from ${base}.`
            : `Cut it from ${base} if it does not exist yet.`;
    b.add('branch:where', derived("each task's branch", ...(project.branches.base ? ['the base branch (branches.base)'] : [])), `Commit this task's work on \`${branch}\`. ${from}`);
  } else {
    b.add('branch:where', derived("each task's branch"), 'No branch is named for it: work on the current branch.');
  }

  if (!managedFor(plan, opts)) b.push(...trackedChecks(plan, task, project, files, opts.bin));
  else {
    // The cycle.
    const review = effectiveReview(plan, task, settings.review);
    const reviewFrom = [task, ...ancestorsOf(plan, task)].find((t) => t.review);
    b.gap().add('cycle', TEMPLATE, '## The cycle: implement → review → refine');
    b.add('cycle:mode', TEMPLATE, 'Review: ')
      .inline('cycle:mode:review', reviewFrom ? field('task', reviewFrom.id) : settingSource('review'), `${REVIEW_WORDS[review]}${review !== settings.review ? ' (set on this task)' : ''}`)
      .inline('cycle:mode:rounds', settingSource('maxRounds'), `. At most ${settings.maxRounds} review round${settings.maxRounds === 1 ? '' : 's'} before stopping to ask the user.`);
    const stage = (key: 'implement' | 'review', name: string, what: string, hooks: ReturnType<typeof hooksFor>, model = '') => {
      b.gap().add(`cycle:${key}`, TEMPLATE, `**${name}.** ${what}`).inline(`cycle:${key}:model`, configSource(project, 'review.model'), model);
      if (hooks.length) b.add(`cycle:${key}:checks`, configSource(project, `hooks.${key}`), hooks.map((h) => `- ${h.name}: \`${hookCommand(h)}\`${h.optional ? ' (optional)' : ''}`));
    };
    const filesArg = files.length ? ` --files ${[...new Set(files)].join(',')}` : '';
    stage('implement', 'Implement', 'Make the change, then run the implement checks and fix what they find:', hooksFor(project, 'implement', files));
    stage(
      'review',
      'Review',
      review === 'user'
        ? `Run the review checks, then show the user the change and ask them, with ${agentInfo(opts.agent).askWith}, whether it is right:`
        : review === 'skip'
          ? 'No reviewer: the review checks are the review. Run them:'
          : review === 'self'
            ? 'Read your own diff against the objective and the acceptance criteria, as a reviewer would, and run the review checks:'
            : 'A fresh subagent that did not write the change reads the diff against this brief and runs the review checks.',
      hooksFor(project, 'review', files),
      review === 'subagent' ? reviewerWords(project) : '',
    );
    // What a reviewer looks for here, whoever reviews.
    if (review !== 'skip') b.push(...instructionBlocks(project, 'review', '### What the review checks here'));
    b.gap().add('cycle:refine', TEMPLATE, '**Refine.** Fix what the review found, run the implement checks again, and go back to review.');
    if (opts.bin && HOOK_STAGES.some((s) => hooksFor(project, s, files).length)) {
      b.gap().add('cycle:run', TEMPLATE, `Run a stage at once: \`"${opts.bin}" check implement${filesArg}\` (or \`review\`); add \`--json\` for the \`checks\` to report.`);
    } else if (!hasHooks(project)) {
      // What to do without checks, under the cycle rather than a heading of its own.
      for (const block of checksBlocks(project)) b.gap().add(block.id, block.source, block.text.split('\n').slice(1));
    }
    b.gap().add(
      'report',
      TEMPLATE,
      `Report each step with harness_task_update {task_id: "${task.id}", stage: "implement" | "review" | "refine", checks: [{name, ok, note}]}, ` +
        'and status "done" with a one-line note once the review passed. A subagent without the Coplan tools reports ' +
        'back to the agent that gave it this brief instead: what it changed, the checks and how they came out, and anything left.',
    );
  }
  if (task.stage || task.round || task.checks?.length) {
    b.gap().add(
      'now',
      derived('where the task is in its cycle, as the agent reported it'),
      `_Now: ${[task.stage ? stageWords(task) : task.status.replace('_', ' '), task.checks?.length ? `checks ${checkWords(task)}` : ''].filter(Boolean).join(' · ')}._`,
    );
  }

  // Every open comment that bears on it: on the task, on the plan as a
  // whole, and on the design it builds — its diagrams, its boxes, and the
  // arrows to and from them. "Don't use Redis here" on a box is as much
  // part of the brief as the task's own detail.
  const { diagrams, nodes } = designOf(plan, task);
  const bears = (t: Thread): boolean => {
    const { kind, id } = t.target;
    if (kind === 'task') return mine.has(id);
    // Every brief quotes every section, so a comment on one bears on all.
    if (kind === 'plan' || kind === 'section') return true;
    if (kind === 'diagram') return diagrams.has(id);
    if (kind === 'node') return nodes.has(id);
    if (kind === 'edge') {
      const part = findPart(plan, t.target);
      return Boolean(part?.edge && (nodes.has(`${part.diagram.id}/${part.edge.source}`) || nodes.has(`${part.diagram.id}/${part.edge.target}`)));
    }
    return false;
  };
  const threads = plan.threads.filter((t) => !t.resolved && bears(t));
  if (threads.length) {
    b.gap().add('comments', TEMPLATE, '## Open comments on it and its design');
    for (const t of threads) {
      const on = t.target.kind === 'task' && mine.has(t.target.id) ? '' : ` _(on ${describeTarget(plan, t.target)})_`;
      const lines = [`- ${t.author === 'user' ? 'user' : 'planner'}${on}: ${hang(t.text, 4)}`];
      for (const r of t.replies) lines.push(`  ↳ ${r.author === 'user' ? 'user' : 'planner'}: ${hang(r.text, 4)}`);
      b.add(`thread:${t.id}`, { kind: 'field', target: t.target }, lines);
    }
  }
  return b.blocks;
}

/**
 * A Tracked task's checks and how to report it: the repository's checks
 * for its files, and its status as it goes — no cycle, no review mode,
 * no round limit. How it is built and checked is the agent's call.
 */
function trackedChecks(plan: Plan, task: Task, project: ProjectConfig, files: string[], bin?: string): Block[] {
  const b = new BlockList();
  const stages = (['implement', 'review'] as const).filter((st) => hooksFor(project, st, files).length);
  if (stages.length) {
    b.gap().add('checks', TEMPLATE, ["## Checks", "The repository's checks for this task's files:"]);
    for (const st of stages) {
      b.add(`checks:${st}`, configSource(project, `hooks.${st}`), `- ${st}: ${hooksFor(project, st, files).map((h) => `${h.name} \`${hookCommand(h)}\`${h.optional ? ' (optional)' : ''}`).join('; ')}`);
    }
    const filesArg = files.length ? ` --files ${[...new Set(files)].join(',')}` : '';
    if (bin) b.gap().add('checks:run', TEMPLATE, `Run a stage at once: \`"${bin}" check implement${filesArg}\` (or \`review\`); add \`--json\` for the \`checks\` to report.`);
  } else if (!hasHooks(project)) {
    b.gap().push(...checksBlocks(project));
  }
  b.push(...instructionBlocks(project, 'review', '### What a review checks here'));
  b.gap().add(
    'report',
    TEMPLATE,
    `Report it with harness_task_update {task_id: "${task.id}", status: "in_progress" | "done" | "blocked", checks: [{name, ok, note}], note}: ` +
      '"done" with a one-line note of what you did, "blocked" with what it waits on. A subagent without the Coplan tools ' +
      'reports back to the agent that gave it this brief instead: what it changed, the checks and how they came out, and anything left.',
  );
  return b.blocks;
}

/** How much of the plan's sections a brief quotes: each, and in all. */
const SECTION_MAX = 1_200;
const SECTIONS_BUDGET = 3_000;

/**
 * Markdown cut to about `max` characters, at a line, and never inside a
 * code block: a fence left open would turn the rest of the brief into code.
 */
function clipProse(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > max && kept.length) break;
    kept.push(line);
    used += line.length + 1;
  }
  const fences = kept.filter((l) => /^ {0,3}(```|~~~)/.test(l)).length;
  if (fences % 2) kept.push('```');
  return { text: `${kept.join('\n').trimEnd()}\n…`, cut: true };
}

/** The diagrams and boxes (`diagramId/nodeId`) a task builds — through
 *  itself, a parent or a subtask. */
function designOf(plan: Plan, task: Task): { diagrams: Set<string>; nodes: Set<string> } {
  const related = relatedTasks(plan, task);
  const diagrams = new Set<string>();
  const nodes = new Set<string>();
  for (const d of plan.diagrams) {
    for (const n of d.nodes) {
      if (!n.taskIds?.some((id) => related.has(id))) continue;
      diagrams.add(d.id);
      nodes.add(`${d.id}/${n.id}`);
    }
  }
  return { diagrams, nodes };
}
