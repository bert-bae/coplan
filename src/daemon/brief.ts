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
import type { BuildSettings, Plan, Task, Thread } from '../shared/types.ts';
import { countTasks, describeTarget, findPart, outline, planPhase } from '../shared/plan.ts';
import {
  DEFAULT_BUILD_SETTINGS,
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
  leafTasks,
  leavesUnder,
  readinessOf,
  effectiveChecks,
  inheritedChecks,
  sharedFiles,
  skipWords,
  skippedChecks,
  waitingOn,
} from '../shared/build.ts';
import { HOOK_STAGES, emptyProjectConfig, hasHooks, hookCommand, hooksFor, shellQuote, taskHooks, type ProjectConfig } from '../shared/project.ts';
import { filesForStage, taskFiles, type Changed } from '../shared/changes.ts';
import { KIND_NOUN, edgePhrase, hang, indent, nestHeadings } from '../shared/architecture.ts';
import { agentInfo, type AgentKind } from '../shared/agents.ts';
import { checkWords, checksSection, finalWords, instructionLines, pullRequestWords, renderBuildOrder, reviewerWords, stageWords, templateLines } from './render.ts';

export interface BriefOptions {
  /** The agent building it: how it is told to ask the user things. */
  agent?: AgentKind;
  settings?: BuildSettings;
  project?: ProjectConfig;
  /** The coplan CLI on this machine, for `coplan check`. */
  bin?: string;
  /** What the task's work is diffed against at review (`git diff base...`). */
  diffBase?: string;
  /** Why what the task changed was not read: its branch is shared with
   *  other tasks (their work and its cannot be told apart), there is no base
   *  branch to compare with, or no repository. */
  diffUnread?: 'shared' | 'no-base' | 'is-base' | 'no-repo';
  /** The files the task has changed so far, when git could say. */
  changed?: Changed;
}

function settingsOf(plan: Plan, opts: BriefOptions): BuildSettings {
  return plan.submission?.settings ?? opts.settings ?? opts.project?.settings ?? DEFAULT_BUILD_SETTINGS;
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
    // A gate the user took away is part of how the build was checked.
    const skipped = skippedChecks(plan);
    if (skipped.length) {
      out.push(
        '',
        `Checks the user skipped on tasks — say so in the report and the summary: ${skipped.map(({ task, skips }) => `${task.id} "${task.title}": ${skipWords(skips)}`).join('; ')}.`,
      );
    }
    out.push(...templateLines(project));
    out.push(...renderStack(plan, project.branches.base));
    if (plan.report) out.push('', `_A build report was written ${new Date(plan.report.at).toISOString().slice(0, 16).replace('T', ' ')}; writing it again replaces it._`);
    return out.join('\n');
  }

  out.push(`# Next in "${plan.title}"`);
  out.push(
    `_tasks ${counts.done}/${counts.total} done · up to ${settings.parallel} at once · review: ${settings.review} · at most ${settings.maxRounds} review round${settings.maxRounds === 1 ? '' : 's'}_`,
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
    const advice =
      room === 0
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
    'Start a task with harness_task_update {task_id, status: "in_progress", stage: "implement"}, then take it through ' +
      'the iric cycle. Starting a task that still waits on another is refused.',
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
  const settings = settingsOf(plan, opts);
  const project = opts.project ?? emptyProjectConfig();
  const out: string[] = [];
  const path = ancestorsOf(plan, task).reverse();
  const number = outline(plan).find((r) => r.task.id === task.id)?.number;

  out.push(`# Task ${task.id}: ${task.title}`);
  out.push(
    `_Part of "${plan.title}"${number ? ` · task ${number}` : ''}${path.length ? ` · under ${path.map((t) => `"${t.title}"`).join(' › ')}` : ''}. ` +
      'This brief is everything needed to build this task — and where its job ends._',
  );

  if (plan.summary.trim()) out.push('', '## The plan, in short', nestHeadings(plan.summary.trim(), 2));

  // The plan's own prose — context, risks, what is out of scope — holds for
  // every task: a subagent given only this brief must have it too.
  const sections = plan.sections.filter((s) => s.body.trim());
  if (sections.length) {
    out.push('', '## From the plan');
    let room = SECTIONS_BUDGET;
    let left = false;
    for (const s of sections) {
      if (room <= 0) {
        left = true;
        break;
      }
      const body = nestHeadings(s.body.trim(), 3);
      const { text, cut } = clipProse(body, Math.min(SECTION_MAX, room));
      out.push('', `### ${s.title}`, text);
      room -= text.length;
      if (cut) left = true;
    }
    if (left) out.push('', '_…more of the plan than fits here: harness_plan_read {peek: true} has all of it._');
  }

  // The objective.
  out.push('', '## Your objective', `**${task.title}**`);
  if (task.detail?.trim()) out.push('', task.detail.trim());
  for (const parent of path) {
    if (parent.detail?.trim()) out.push('', `From "${parent.title}", which this is part of:`, ...indent(parent.detail, 2));
  }
  if (hasSubtasks(plan, task.id)) {
    out.push('', 'Its subtasks — build them in this order, each through its own cycle:');
    // In build order — what waits on another comes after it — not outline order.
    const rank = new Map(buildSteps(plan).flatMap((step, i) => step.map((t) => [t.id, i] as const)));
    const leaves = leavesUnder(plan, task.id).map((t, i) => ({ t, i })).sort((a, b) => (rank.get(a.t.id) ?? 0) - (rank.get(b.t.id) ?? 0) || a.i - b.i);
    for (const { t: leaf } of leaves) out.push(`- [${leaf.status === 'done' ? 'x' : ' '}] ${line(leaf)}`);
  }
  const files = taskFiles(plan, task);
  if (files.length) out.push('', `Files you expect to touch: ${[...new Set(files)].join(', ')}`);

  // Where it fits.
  const fits = renderParts(plan, task);
  const before = inheritedDeps(plan, task).map((id) => plan.tasks.find((t) => t.id === id)!).filter(Boolean);
  const after = dependents(plan, task);
  if (fits.length || before.length || after.length) {
    out.push('', '## Where it fits');
    if (fits.length) out.push('It builds these parts of the architecture:', ...fits);
    if (before.length) {
      out.push('', 'It comes after — build on what these did:');
      for (const t of before) {
        const done = leavesUnder(plan, t.id).every((l) => l.status === 'done');
        const branch = effectiveBranch(plan, t);
        out.push(`- ${done ? '[x]' : '[ ] NOT DONE YET —'} ${line(t)}${t.note ? ` — ${t.note}` : ''}${branch ? ` · on \`${branch}\`` : ''}`);
      }
    }
    if (after.length) out.push('', `Waiting on it: ${after.map(line).join('; ')}. Leave their work to them, but do not make it harder.`);
  }

  const waits = waitingOn(plan, task);
  if (waits.length && task.status !== 'done') {
    out.push('', `> ⚠ This task cannot start yet: it waits on ${waits.map(line).join('; ')}.`);
  }

  // The edges of the job.
  const mine = relatedTasks(plan, task);
  const neighbours = leafTasks(plan).filter((t) => !mine.has(t.id) && t.status !== 'done' && (readinessOf(plan, t) === 'in_progress' || sharedFiles(task, t).length));
  out.push('', '## Stay in scope');
  out.push(
    'Build what this task describes and nothing more — the plan gives other parts to other tasks. If you find work ' +
      'outside it, say so in your report instead of doing it; it becomes a task of its own.',
  );
  for (const t of neighbours) {
    const shared = sharedFiles(task, t);
    out.push(`- ${line(t)}${readinessOf(plan, t) === 'in_progress' ? ' is being built right now' : ''}${shared.length ? ` — also touches ${shared.join(', ')}` : ''}.`);
  }

  out.push(...instructionLines(project, 'brief'));

  // Where it lands.
  const branch = effectiveBranch(plan, task);
  out.push('', '## Branch');
  if (branch) {
    const entry = branchPlan(plan).branches.find((b) => b.branch === branch);
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
    out.push(`Commit this task's work on \`${branch}\`. ${from}`);
  } else {
    out.push('No branch is named for it: work on the current branch.');
  }

  // The cycle.
  const review = effectiveReview(plan, task, settings.review);
  out.push('', '## The cycle: implement → review → refine');
  out.push(`Review: ${REVIEW_WORDS[review]}${review !== settings.review ? ' (set on this task)' : ''}. At most ${settings.maxRounds} review round${settings.maxRounds === 1 ? '' : 's'} before stopping to ask the user.`);
  // The task's own checks run with the repository's; the ones the user
  // skipped on it are said, not dropped from sight.
  const checks = effectiveChecks(plan, task);
  const own = new Set((checks.addChecks ?? []).map((c) => c.name));
  // Said of the check that holds — the task's own, or one set above it —
  // as effectiveChecks chose it.
  const inherited = inheritedChecks(plan, task);
  const whose = (name: string) => {
    const held = checks.addChecks?.find((c) => c.name === name);
    if (!held) return '';
    if (task.addChecks?.includes(held)) return " (this task's own)";
    const above = inherited.find((i) => i.check === held)?.from;
    return above ? ` (set on "${above.title}", above this task)` : '';
  };
  const stage = (name: string, what: string, hooks: ReturnType<typeof hooksFor>) => {
    out.push('', `**${name}.** ${what}`);
    if (hooks.length) for (const h of hooks) out.push(`- ${h.name}: \`${hookCommand(h)}\`${h.optional ? ' (optional)' : ''}${whose(h.name)}`);
  };
  // Every part of the command quoted: file and branch names are the plan's,
  // and the agent runs what the brief says.
  const filesArg = files.length ? ` --files ${shellQuote([...new Set(files)].join(','))}` : '';
  stage('Implement', 'Make the change, then run the implement checks and fix what they find:', taskHooks(project, 'implement', files, checks));
  // Review is matched against what the task changed as well as what it
  // expected to: a hook for a file it touched anyway is part of its gate.
  const reviewHooks = taskHooks(project, 'review', filesForStage('review', files, opts.changed), checks);
  stage(
    'Review',
    review === 'user'
      ? `Run the review checks, then show the user the change and ask them, with ${agentInfo(opts.agent).askWith}, whether it is right:`
      : review === 'skip'
        ? 'No reviewer: the review checks are the review. Run them:'
        : review === 'self'
          ? 'Read your own diff against the objective and the acceptance criteria, as a reviewer would, and run the review checks:'
          : `A fresh subagent that did not write the change reads the diff against this brief and runs the review checks.${reviewerWords(project)}`,
    reviewHooks,
  );
  const skips = checks.skipChecks ?? [];
  const skippedNames = new Set(skips.map((s) => s.name));
  const ifTouched = files.length ? project.hooks.review.filter((h) => h.paths?.length && !reviewHooks.includes(h) && !skippedNames.has(h.name)) : [];
  if (ifTouched.length) {
    out.push(
      opts.diffUnread === 'shared'
        ? 'These apply too if your change touches their files — this task shares its branch with other tasks, so what it changed is not read from git: run them yourself if it does, and report them:'
        : opts.diffUnread === 'no-base'
          ? 'These apply too if your change touches their files — no base branch was found to compare with (set `branches.base` in .coplan/config.json): run them yourself if it does:'
          : opts.diffUnread === 'is-base'
            ? "These apply too if your change touches their files — this task's branch is the base branch itself, so there is nothing to compare it with: run them yourself if it does:"
          : opts.diffUnread === 'no-repo'
            ? 'These apply too if your change touches their files — this folder is not a git repository, so what the task changed is not read: run them yourself if it does:'
          : `These apply too once the change touches their files — matched against what you changed${opts.diffBase ? ` since \`${opts.diffBase}\`` : ''}, not only the files above:`,
      ...ifTouched.map((h) => `- ${h.name} (${h.paths!.join(', ')}): \`${hookCommand(h)}\`${h.optional ? ' (optional)' : ''}`),
    );
  }
  if (skips.length) {
    // Any of the repository's implement or review checks, whatever its
    // paths: the user may skip one this task's files do not reach yet.
    const real = new Set([...[...project.hooks.implement, ...project.hooks.review].map((h) => h.name), ...inherited.map(({ check }) => check.name)]);
    out.push(
      '',
      `**Skipped on this task by the user:** ${skips.map((s) => `${skipWords([s])}${real.has(s.name) ? '' : ' — no check of the repository has that name'}`).join('; ')}. ` +
        'They do not gate it: do not run them for it, and say in your report that they were skipped.',
    );
  }
  // What a reviewer looks for here, whoever reviews.
  if (review !== 'skip') out.push(...instructionLines(project, 'review', '### What the review checks here'));
  out.push('', '**Refine.** Fix what the review found, run the implement checks again, and go back to review.');
  if (opts.bin && (reviewHooks.length || HOOK_STAGES.some((s) => hooksFor(project, s, files).length))) {
    const baseArg = !filesArg
      ? ''
      : opts.diffUnread === 'shared' || opts.diffUnread === 'no-repo' || opts.diffUnread === 'is-base'
        ? ' --no-diff'
        : opts.diffBase
          ? ` --base ${shellQuote(opts.diffBase)}`
          : '';
    // One --skip per check, quoted: a name may hold a space ("go test").
    // `--skip=<name>`: a name may also start with dashes ("--ci").
    const skipArg = skips.map((s) => ` ${shellQuote(`--skip=${s.name}`)}`).join('');
    out.push(
      '',
      `Run a stage at once: \`"${opts.bin}" check implement${filesArg}${skipArg}\`, and \`"${opts.bin}" check review${filesArg}${baseArg}${skipArg}\`` +
        `${filesArg ? ' (it adds the hooks for the files you changed)' : ''}; add \`--json\` for the \`checks\` to report.` +
        (own.size ? ` It runs the repository's checks: run the ones set on this task (${[...own].join(', ')}) as listed above.` : ''),
    );
  } else if (!hasHooks(project) && !own.size) {
    // Nothing set anywhere: say so, and what to run instead. A task with
    // checks of its own has them listed above, and is held to them.
    out.push('', ...checksSection(project).slice(1));
  }
  out.push(
    '',
    `Report each step with harness_task_update {task_id: "${task.id}", stage: "implement" | "review" | "refine", checks: [{name, ok, note}]}, ` +
      'and status "done" with a one-line note once the review passed. A subagent without the Coplan tools reports ' +
      'back to the agent that gave it this brief instead: what it changed, the checks and how they came out, and anything left.',
  );
  if (task.stage || task.round || task.checks?.length) {
    out.push('', `_Now: ${[task.stage ? stageWords(task) : task.status.replace('_', ' '), task.checks?.length ? `checks ${checkWords(task)}` : ''].filter(Boolean).join(' · ')}._`);
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
    out.push('', '## Open comments on it and its design');
    for (const t of threads) {
      const on = t.target.kind === 'task' && mine.has(t.target.id) ? '' : ` _(on ${describeTarget(plan, t.target)})_`;
      out.push(`- ${t.author === 'user' ? 'user' : 'planner'}${on}: ${hang(t.text, 4)}`);
      for (const r of t.replies) out.push(`  ↳ ${r.author === 'user' ? 'user' : 'planner'}: ${hang(r.text, 4)}`);
    }
  }
  return out.join('\n');
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

/** The task, its parents and the subtasks under it: the work a brief is
 *  about, for the boxes it builds and the comments that bear on it. */
function relatedTasks(plan: Plan, task: Task): Set<string> {
  return new Set([task.id, ...ancestorsOf(plan, task).map((t) => t.id), ...leavesUnder(plan, task.id).map((t) => t.id)]);
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

/** The boxes a task builds — through itself, a parent or a subtask — with
 *  what each one is, what was decided and what it connects to. */
function renderParts(plan: Plan, task: Task): string[] {
  const related = relatedTasks(plan, task);
  const out: string[] = [];
  for (const d of plan.diagrams) {
    const label = (id: string) => d.nodes.find((n) => n.id === id)?.label ?? id;
    for (const n of d.nodes) {
      if (!n.taskIds?.some((id) => related.has(id))) continue;
      out.push(`- **${n.label}** \`${n.id}\` in "${d.title}" — ${KIND_NOUN[n.kind]}${n.detail ? `: ${n.detail}` : ''}`);
      if (n.description?.trim()) out.push(...indent(n.description, 2));
      if (n.notes?.trim()) out.push('  Decisions:', ...indent(n.notes, 4));
      const edges = d.edges.filter((e) => e.source === n.id || e.target === n.id);
      if (edges.length) out.push(`  Connections: ${edges.map((e) => edgePhrase(e, label)).join('; ')}`);
      const others = (n.taskIds ?? []).filter((id) => !related.has(id));
      if (others.length) out.push(`  Also built by: ${others.map((id) => plan.tasks.find((t) => t.id === id)).filter(Boolean).map((t) => line(t!)).join('; ')}`);
    }
  }
  return out;
}
