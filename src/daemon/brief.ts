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
import type { BuildSettings, Plan, Task } from '../shared/types.ts';
import { countTasks, outline, planPhase } from '../shared/plan.ts';
import {
  DEFAULT_BUILD_SETTINGS,
  REVIEW_WORDS,
  ancestorsOf,
  branchPlan,
  dependents,
  effectiveBranch,
  effectiveReview,
  hasSubtasks,
  inheritedDeps,
  leafTasks,
  leavesUnder,
  readinessOf,
  sharedFiles,
  waitingOn,
} from '../shared/build.ts';
import { HOOK_STAGES, emptyProjectConfig, hasHooks, hooksFor, type ProjectConfig } from '../shared/project.ts';
import { KIND_NOUN, edgePhrase, indent } from '../shared/architecture.ts';
import { checkWords, checksSection, renderBuildOrder, stageWords } from './render.ts';

export interface BriefOptions {
  settings?: BuildSettings;
  project?: ProjectConfig;
  /** The coplan CLI on this machine, for `coplan check`. */
  bin?: string;
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
        ? `1. Run the final checks: ${final.map((h) => `${h.name} \`${h.run}\``).join('; ')}${opts.bin ? ` — or all of them with \`"${opts.bin}" check final\`` : ''}. Fix anything they find, as a task.`
        : '1. Run the repository\'s full checks (its test suite and build, as CI would) and fix anything they find, as a task.',
    );
    const { branches } = branchPlan(plan);
    out.push(
      branches.length
        ? `2. Push each branch and open the pull requests in stack order: ${branches.map((b) => `\`${b.branch}\`${b.base ? ` (onto \`${b.base}\`)` : ''}`).join(' → ')}.`
        : '2. Commit and push the work on the current branch, and open a pull request if the user wants one.',
      '3. Write the build report with harness_plan_edit {op: "report", text}: what each task did, the branches and pull requests, the checks and how they came out, anything that differs from the plan, and follow-ups.',
      '4. Give the user the final summary in chat, with the links.',
    );
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
      if (t.round && t.round >= settings.maxRounds && t.stage !== 'review') {
        out.push(`  ⚠ ${t.round} review rounds already: if this one does not pass, stop and ask the user.`);
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

  const order = renderBuildOrder(plan, project.branches.base).filter((l) => !l.startsWith('## Build order'));
  const branchesAt = order.findIndex((l) => l.startsWith('## Branches'));
  if (branchesAt >= 0) out.push('', ...order.slice(branchesAt));

  out.push(
    '',
    'Start a task with harness_task_update {task_id, status: "in_progress", stage: "implement"}, then take it through ' +
      'the iric cycle. Starting a task that still waits on another is refused.',
  );
  return out.join('\n');
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

  if (plan.summary.trim()) out.push('', '## The plan, in short', plan.summary.trim());

  // The objective.
  out.push('', '## Your objective', `**${task.title}**`);
  if (task.detail?.trim()) out.push('', task.detail.trim());
  for (const parent of path) {
    if (parent.detail?.trim()) out.push('', `From "${parent.title}", which this is part of:`, ...indent(parent.detail, 2));
  }
  if (hasSubtasks(plan, task.id)) {
    out.push('', 'Its subtasks — build them in this order, each through its own cycle:');
    for (const leaf of leavesUnder(plan, task.id)) out.push(`- [${leaf.status === 'done' ? 'x' : ' '}] ${line(leaf)}`);
  }
  const files = task.files?.length ? task.files : leavesUnder(plan, task.id).flatMap((t) => t.files ?? []);
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
  const mine = new Set([task.id, ...leavesUnder(plan, task.id).map((t) => t.id), ...ancestorsOf(plan, task).map((t) => t.id)]);
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

  // Where it lands.
  const branch = effectiveBranch(plan, task);
  out.push('', '## Branch');
  if (branch) {
    const entry = branchPlan(plan).branches.find((b) => b.branch === branch);
    const base = project.branches.base ? `\`${project.branches.base}\`` : 'the base branch';
    const from =
      entry?.needs.length && entry.needs.length > 1
        ? `It needs ${entry.needs.map((n) => `\`${n}\``).join(' and ')}: cut it from ${base} once those are merged, or from the last of them.`
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
  const stage = (name: string, what: string, hooks: ReturnType<typeof hooksFor>) => {
    out.push('', `**${name}.** ${what}`);
    if (hooks.length) for (const h of hooks) out.push(`- ${h.name}: \`${h.run}\`${h.optional ? ' (optional)' : ''}`);
  };
  const filesArg = files.length ? ` --files ${[...new Set(files)].join(',')}` : '';
  stage('Implement', 'Make the change, then run the implement checks and fix what they find:', hooksFor(project, 'implement', files));
  stage(
    'Review',
    review === 'user'
      ? 'Run the review checks, then show the user the change and ask them, with AskUserQuestion, whether it is right:'
      : review === 'skip'
        ? 'No reviewer: the review checks are the review. Run them:'
        : review === 'self'
          ? 'Read your own diff against the objective and the acceptance criteria, as a reviewer would, and run the review checks:'
          : 'A fresh subagent that did not write the change reads the diff against this brief and runs the review checks:',
    hooksFor(project, 'review', files),
  );
  out.push('', '**Refine.** Fix what the review found, run the implement checks again, and go back to review.');
  if (opts.bin && HOOK_STAGES.some((s) => hooksFor(project, s, files).length)) {
    out.push('', `Run a stage at once: \`"${opts.bin}" check implement${filesArg}\` (or \`review\`); add \`--json\` for the \`checks\` to report.`);
  } else if (!hasHooks(project)) {
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

  const threads = plan.threads.filter((t) => !t.resolved && t.target.kind === 'task' && mine.has(t.target.id));
  if (threads.length) {
    out.push('', '## Comments on it');
    for (const t of threads) {
      out.push(`- ${t.author === 'user' ? 'user' : 'planner'}: ${t.text}`);
      for (const r of t.replies) out.push(`  ↳ ${r.author === 'user' ? 'user' : 'planner'}: ${r.text}`);
    }
  }
  return out.join('\n');
}

/** The boxes a task builds — through itself, a parent or a subtask — with
 *  what each one is, what was decided and what it connects to. */
function renderParts(plan: Plan, task: Task): string[] {
  const related = new Set([task.id, ...ancestorsOf(plan, task).map((t) => t.id), ...leavesUnder(plan, task.id).map((t) => t.id)]);
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
