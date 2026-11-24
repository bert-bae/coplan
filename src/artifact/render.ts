/**
 * A headless plan as a page (#headless): what an agent the user's browser
 * cannot reach — a cloud agent — publishes as an Artifact for the user to
 * review. The overview, each diagram drawn as a picture, the task list. It
 * is read-only: the user answers and signs off in chat, and the agent
 * publishes the page again.
 *
 * Pure: it returns HTML, so it runs the same in a test as in the page.
 */
import { renderMarkdown } from '../ui/lib/markdown.ts';
import { diagramMermaid, tasksMermaid } from '../shared/mermaid.ts';
import { KIND_NOUN } from '../shared/architecture.ts';
import { SESSION_BRANCH, branchPlan, buildSteps, hasDependencies } from '../shared/build.ts';
import { FLOW_LABEL, childrenOf, countTasks, nextInChat, planFlow, planPhase } from '../shared/plan.ts';
import { NODE_KINDS, type Diagram, type NodeKind, type Plan, type PlanInput, type PlanPhase, type Task, type TaskInput, type TaskStatus } from '../shared/types.ts';

/** A sign-off the agent records on the user's word in chat. */
interface WrittenSignoff {
  userSaid?: string;
  at?: number | string;
}

/**
 * The plan as the agent writes it into the page when Coplan's tools cannot
 * be reached: what `harness_plan_publish` takes, with each task's status
 * and the user's sign-offs.
 */
export type WrittenPlan = PlanInput & {
  design?: WrittenSignoff;
  submission?: WrittenSignoff;
  report?: { text: string };
};

/** What the page's `#plan` block holds: the daemon's stored plan, or one
 *  the agent wrote. `agent` names who the user talks to. */
export type PageData = (Plan | WrittenPlan) & { agent?: string };

const time = (at: number | string | undefined): number => (typeof at === 'string' ? Date.parse(at) : (at ?? 0)) || 0;

/**
 * The plan a page shows. A written plan is laid out as Coplan stores one —
 * tasks flat under their parents, each box listing the tasks that build it —
 * without the publish's checks: the page only draws it.
 */
export function planOf(data: PageData, now = Date.now()): Plan {
  // Only a stored plan counts its changes.
  if (typeof (data as Plan).seq === 'number') return data as Plan;
  const w = data as WrittenPlan;
  const diagrams: Diagram[] = (w.diagrams ?? []).map((d, i) => ({
    id: d.id ?? `d${i + 1}`,
    title: d.title,
    ...(d.caption ? { caption: d.caption } : {}),
    direction: d.direction ?? 'LR',
    nodes: (d.nodes ?? []).map((n) => ({
      ...n,
      label: n.label ?? n.id,
      kind: (NODE_KINDS as readonly string[]).includes(n.kind ?? '') ? (n.kind as NodeKind) : 'component',
      taskIds: [...(n.taskIds ?? [])],
    })),
    edges: (d.edges ?? []).map((e, j) => ({ ...e, id: e.id ?? `e${j + 1}`, arrows: e.arrows === 'both' || e.arrows === 'none' ? e.arrows : undefined })),
    rev: 1,
    updatedAt: 0,
    updatedBy: 'claude',
  }));
  const tasks: Task[] = [];
  const walk = (list: TaskInput[], parentId: string | null) =>
    list.forEach((t, order) => {
      const id = t.id ?? `${parentId ? `${parentId}.` : 't'}${order + 1}`;
      const { subtasks, builds, ...rest } = t;
      tasks.push({ ...rest, id, parentId, order, status: t.status ?? 'todo', createdAt: 0, updatedAt: 0, createdBy: 'claude' });
      // A box by its id, or `diagramId/nodeId` where the id is in several.
      for (const ref of builds ?? []) {
        const [dId, nId] = ref.includes('/') ? ref.split('/') : [undefined, ref];
        for (const d of diagrams) if (!dId || d.id === dId) for (const n of d.nodes) if (n.id === nId && !n.taskIds!.includes(id)) n.taskIds!.push(id);
      }
      walk(subtasks ?? [], id);
    });
  walk(w.tasks ?? [], null);
  const plan: Plan = {
    title: w.title,
    ...(w.mode ? { mode: w.mode } : {}),
    summary: w.summary ?? '',
    sections: (w.sections ?? []).map((s, i) => ({ id: s.id ?? `s${i + 1}`, title: s.title, body: s.body, rev: 1, updatedAt: 0, updatedBy: 'claude' })),
    diagrams,
    tasks,
    threads: [],
    changes: [],
    seq: 0,
    version: 0,
    claudeReadSeq: 0,
    claudeReadAt: null,
    revision: 1,
    createdAt: 0,
    updatedAt: 0, // a written plan says nothing of when it changed
  };
  const { design, submission, report } = w;
  if (design) plan.design = { prompt: '', via: 'chat', ...design, at: time(design.at), deliveredAt: now };
  if (submission) plan.submission = { prompt: '', target: 'session', via: 'chat', ...submission, at: time(submission.at), deliveredAt: now };
  if (report?.text) plan.report = { text: report.text, at: now };
  return plan;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const md = (text: string | undefined) => (text?.trim() ? `<div class="md">${renderMarkdown(text.trim())}</div>` : '');
const id = (value: string) => `<code class="ref">${esc(value)}</code>`;
/** A Mermaid graph without its fence, for the page to draw. */
const graph = (fenced: string[]) => `<div class="graph"><pre class="mermaid">${esc(fenced.slice(1, -1).join('\n'))}</pre></div>`;

const PHASE: Record<PlanPhase, string> = {
  planning: 'Ready for your review',
  tasking: 'Design confirmed',
  submitted: 'Building',
  building: 'Building',
  finalizing: 'Final checks',
  landing: 'Pull requests open',
  built: 'Built',
  'handed-off': 'Handed off',
};

const STATUS: Record<TaskStatus, [mark: string, word: string]> = {
  todo: ['○', 'to do'],
  in_progress: ['▶', 'in progress'],
  blocked: ['⛔', 'blocked'],
  done: ['✓', 'done'],
  dropped: ['✗', 'dropped'],
};

/** The page's body: the plan's head, then Overview, Architecture and Tasks. */
export function planPage(plan: Plan, agent = 'the agent'): string {
  const phase = planPhase(plan);
  const { steps, at } = planFlow(plan);
  const counts = countTasks(plan);
  const ideas = plan.mode === 'architect' && phase === 'planning';
  const hasDiagrams = plan.diagrams.length > 0;
  const sections: [string, string][] = [['overview', 'Overview']];
  if (hasDiagrams) sections.push(['architecture', 'Architecture']);
  if (plan.tasks.length) sections.push(['tasks', ideas ? 'Task ideas' : 'Tasks']);

  const flow = steps
    .map((s) => {
      const state = s === at ? (phase === 'built' ? 'done' : 'now') : steps.indexOf(s) < steps.indexOf(at) ? 'done' : '';
      return `<li class="${state}">${esc(FLOW_LABEL[s])}</li>`;
    })
    .join('');
  const said = [
    plan.design?.userSaid ? `<p class="said">Design confirmed in chat${when(plan.design.at)}: “${esc(plan.design.userSaid)}”</p>` : '',
    plan.submission?.userSaid ? `<p class="said">Build started in chat${when(plan.submission.at)}: “${esc(plan.submission.userSaid)}”</p>` : '',
  ].join('');
  const glance = [
    hasDiagrams && `${plan.diagrams.length} diagram${plan.diagrams.length === 1 ? '' : 's'}`,
    counts.total && `${counts.total} task${counts.total === 1 ? '' : 's'}${counts.done ? `, ${counts.done} done` : ''}`,
    plan.updatedAt && `updated ${new Date(plan.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  ].filter(Boolean);

  return `
<header class="head">
  <p class="eyebrow">Coplan plan · ${plan.mode === 'tasklist' ? 'straight to the task list' : 'architecture first'}</p>
  <h1>${esc(plan.title)}</h1>
  <ol class="flow" aria-label="Where the plan is">${flow}</ol>
  ${glance.length ? `<p class="glance">${glance.join(' · ')}</p>` : ''}
</header>
<nav class="bar" aria-label="Sections">
  <div class="bar-in">
    ${sections.map(([key, label]) => `<a href="#${key}">${label}</a>`).join('')}
    <span class="pill phase-${phase}">${PHASE[phase]}</span>
  </div>
</nav>
<aside class="next" aria-label="What to do next">
  <p><strong>Next:</strong> ${esc(nextInChat(plan, agent))}</p>
  ${said}
  <p class="hint">This page is a view of the plan. Ask for changes in chat and name what you mean by its id — ${id(plan.tasks[0]?.id ?? 't1')}, ${id(plan.diagrams[0] ? `${plan.diagrams[0].id}/${plan.diagrams[0].nodes[0]?.id ?? 'box'}` : 'd1/box')} — and ${esc(agent)} publishes it again.</p>
</aside>
<main>
  ${overview(plan)}
  ${hasDiagrams ? architecture(plan) : ''}
  ${plan.tasks.length ? tasks(plan, ideas) : ''}
</main>
<footer class="foot">Made with Coplan. Read-only: every change goes through chat.</footer>`;
}

/**
 * The overview and architecture as a standalone document to print as a PDF,
 * each diagram the PNG in `pictures` (by diagram id). Notes are opened:
 * paper cannot.
 */
export function planDocument(plan: Plan, pictures: ReadonlyMap<string, string>): string {
  const picture = (d: Diagram) => {
    const src = pictures.get(d.id);
    return src ? `<div class="graph"><img src="${esc(src)}" alt="${esc(`${d.title}: ${d.nodes.length} parts, ${d.edges.length} connections`)}"></div>` : '';
  };
  const counts = countTasks(plan);
  const meta = [
    PHASE[planPhase(plan)],
    plan.diagrams.length && `${plan.diagrams.length} diagram${plan.diagrams.length === 1 ? '' : 's'}`,
    counts.total && `${counts.total} task${counts.total === 1 ? '' : 's'}`,
    plan.updatedAt && `Updated ${new Date(plan.updatedAt).toISOString().slice(0, 10)}`,
  ].filter(Boolean);
  const footer = plan.title.replace(/[\\"]/g, '').replace(/\s+/g, ' ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(plan.title)}</title><style>${PRINT_CSS}
@page { @bottom-left { content: "${footer.replace(/[<>&]/g, '')}"; font-size: 8pt; color: #66707e; } }</style></head><body>
<header class="cover">
<p class="eyebrow">Coplan plan</p>
<h1>${esc(plan.title)}</h1>
<p class="meta">${meta.join(' · ')}</p>
</header>
${overview(plan)}
${plan.diagrams.length ? architecture(plan, picture, true) : ''}
${plan.tasks.length ? printTasks(plan) : ''}
</body></html>`.replace(/<details>/g, '<details open>');
}

/** The task list for paper: nested, by title, with what each waits on and where it lands. */
function printTasks(plan: Plan): string {
  const title = (taskId: string) => plan.tasks.find((t) => t.id === taskId)?.title ?? taskId;
  const item = (t: Task): string => {
    const kids = childrenOf(plan, t.id);
    const meta = [STATUS[t.status][1], t.dependsOn?.length && `after ${t.dependsOn.map((d) => esc(title(d))).join(', ')}`, t.branch && `branch <code>${esc(t.branch)}</code>`].filter(Boolean);
    return `<li class="task"><strong>${esc(t.title)}</strong> <span class="muted">${meta.join(' · ')}</span>${md(t.detail)}${kids.length ? `<ol>${kids.map(item).join('')}</ol>` : ''}</li>`;
  };
  return `<section id="tasks"><h2>Tasks</h2><ol class="tasks">${childrenOf(plan, null).map(item).join('')}</ol></section>`;
}

const PRINT_CSS = `
:root { --ink: #16202e; --body: #2b3544; --muted: #66707e; --rule: #e1e5ea; --accent: #2b59c3; --wash: #f4f6f9; --band: #14213d; }
* { box-sizing: border-box; }
body { font: 10pt/1.6 "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--body); margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.cover { background: var(--band); color: #fff; margin: 0 0 22pt; padding: 26pt 26pt 24pt; border-radius: 8pt; }
.eyebrow { margin: 0 0 10pt; font-size: 8pt; letter-spacing: 0.18em; text-transform: uppercase; color: #8fb0ff; font-weight: 700; }
h1 { font-size: 28pt; line-height: 1.12; margin: 0 0 12pt; letter-spacing: -0.02em; color: #fff; max-width: 5.5in; }
.meta { margin: 0; color: #aeb9cc; font-size: 9pt; letter-spacing: 0.02em; }
h2 { font-size: 9pt; letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent); margin: 28pt 0 10pt; padding-bottom: 6pt; border-bottom: 1px solid var(--rule); }
h3 { font-size: 13pt; margin: 18pt 0 4pt; color: var(--ink); letter-spacing: -0.01em; }
h4 { font-size: 8pt; margin: 14pt 0 6pt; text-transform: uppercase; letter-spacing: 0.14em; color: var(--muted); }
h2, h3, h4 { break-after: avoid; }
p { margin: 0 0 7pt; orphans: 3; widows: 3; }
strong { color: var(--ink); }
.muted, .kind { color: var(--muted); }
code { font: 0.86em ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--wash); border-radius: 3px; padding: 1pt 3.5pt; color: var(--ink); }
pre { white-space: pre-wrap; background: var(--wash); border: 1px solid var(--rule); border-radius: 4px; padding: 8pt 10pt; break-inside: avoid; }
pre code { background: none; padding: 0; }
ul, ol { padding-left: 15pt; margin: 0 0 7pt; } li::marker { color: var(--accent); }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; break-inside: avoid; font-size: 9pt; }
th, td { border-bottom: 1px solid var(--rule); padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: 7.5pt; letter-spacing: 0.1em; text-transform: uppercase; border-bottom: 1.5px solid var(--ink); }
blockquote { margin: 8pt 0; padding: 2pt 0 2pt 12pt; border-left: 3px solid var(--accent); color: var(--muted); font-style: italic; }
.graph { break-inside: avoid; margin: 8pt 0 14pt; padding: 14pt; text-align: center; background: var(--wash); border-radius: 8pt; }
.graph img { max-width: 100%; max-height: 5.5in; }
.parts, .links { padding-left: 0; list-style: none; }
.parts { display: grid; gap: 8pt; }
.part { break-inside: avoid; padding: 9pt 11pt; border: 1px solid var(--rule); border-radius: 6px; }
.part-head strong { font-size: 10.5pt; color: var(--ink); }
.kind { margin-left: 4pt; font-size: 8pt; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; color: var(--accent); }
.part p { margin: 3pt 0 0; font-size: 9.5pt; }
.part .md > :last-child { margin-bottom: 0; }
.built-by { padding-top: 5pt; margin-top: 6pt !important; border-top: 1px dashed var(--rule); font-size: 8.5pt !important; color: var(--muted); }
.links li { padding: 2.5pt 0; border-bottom: 1px solid var(--rule); font-size: 9.5pt; }
details { margin: 6pt 0 0; font-size: 9.5pt; }
summary { list-style: none; font-weight: 700; font-size: 8pt; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
summary::-webkit-details-marker { display: none; }
.diagram { margin-top: 6pt; }
.tasks { list-style: none; padding-left: 0; } .tasks ol { list-style: none; padding-left: 14pt; } .task { margin: 5pt 0; break-inside: avoid; } .task .md { font-size: 9pt; }
@page { margin: 0.7in 0.75in; @bottom-right { content: counter(page); font-size: 8pt; color: #66707e; } }`;

const when = (at: number) => (at ? ` on ${new Date(at).toISOString().slice(0, 10)}` : '');

export function overview(plan: Plan): string {
  return `<section id="overview">
  <h2>Overview</h2>
  ${plan.report ? `<h3>Build report</h3>${md(plan.report.text)}` : ''}
  <h3>Understanding and approach</h3>
  ${md(plan.summary) || '<p class="muted">No summary yet.</p>'}
  ${plan.sections.map((s) => `<h3>${esc(s.title)}</h3>${md(s.body)}`).join('')}
</section>`;
}

/** `picture` draws a diagram; the page's default is Mermaid. */
export function architecture(plan: Plan, picture: (d: Diagram) => string = (d) => graph(diagramMermaid(d)), print = false): string {
  // On paper the ids are chat handles nobody can type: names only.
  const ref = (value: string) => (print ? '' : id(value));
  const title = (taskId: string) => plan.tasks.find((t) => t.id === taskId)?.title;
  const diagrams = plan.diagrams.map((d) => {
    const label = new Map(d.nodes.map((n) => [n.id, n.label]));
    const parts = d.nodes.map(
      (n) => `<li class="part">
        <div class="part-head"><strong>${esc(n.label)}</strong> <span class="kind">${KIND_NOUN[n.kind] ?? n.kind}</span> ${ref(`${d.id}/${n.id}`)}</div>
        ${n.detail ? `<p class="muted">${esc(n.detail)}</p>` : ''}
        ${md(n.description)}
        ${n.notes?.trim() ? `<details><summary>Decisions and notes</summary>${md(n.notes)}</details>` : ''}
        ${n.taskIds?.length ? `<p class="built-by">${print ? 'Built by' : 'Built by'} ${n.taskIds.map((t) => `${ref(t)} ${esc(title(t) ?? '')}`.trim()).join(', ')}</p>` : ''}
      </li>`,
    );
    const links = d.edges
      .filter((e) => label.has(e.source) && label.has(e.target))
      .map((e) => {
        const arrow = e.arrows === 'both' ? '↔' : e.arrows === 'none' ? '—' : '→';
        return `<li>${esc(label.get(e.source)!)} ${arrow} ${esc(label.get(e.target)!)}${e.label ? `: ${esc(e.label)}` : ''}${e.dashed ? ' <span class="muted">(dashed: async or optional)</span>' : ''}</li>`;
      });
    return `<article class="diagram" id="diagram-${esc(d.id)}">
      <h3>${esc(d.title)} ${ref(d.id)}</h3>
      ${d.caption ? `<p class="muted">${esc(d.caption)}</p>` : ''}
      ${picture(d)}
      <h4>Parts${print ? ` · ${esc(d.title)}` : ''}</h4><ul class="parts">${parts.join('')}</ul>
      ${links.length ? `<h4>Connections</h4><ul class="links">${links.join('')}</ul>` : ''}
    </article>`;
  });
  return `<section id="architecture"><h2>Architecture</h2>${diagrams.join('')}</section>`;
}

function tasks(plan: Plan, ideas: boolean): string {
  const counts = countTasks(plan);
  const builds = (t: Task) =>
    plan.diagrams.flatMap((d) => d.nodes.filter((n) => n.taskIds?.includes(t.id)).map((n) => `${esc(n.label)} ${id(`${d.id}/${n.id}`)}`));
  const item = (t: Task): string => {
    const [mark, word] = STATUS[t.status];
    const children = childrenOf(plan, t.id);
    const meta = [
      t.dependsOn?.length && `Waits on ${t.dependsOn.map(id).join(' ')}`,
      builds(t).length && `Builds ${builds(t).join(', ')}`,
      t.files?.length && `Files ${t.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}`,
    ].filter(Boolean);
    return `<li class="task s-${t.status}" id="task-${esc(t.id)}">
      <div class="task-head">
        <span class="status" title="${word}"><span aria-hidden="true">${mark}</span> ${word}</span>
        ${id(t.id)} <strong>${esc(t.title)}</strong>
        ${t.branch ? `<span class="branch">${esc(t.branch)}</span>` : ''}
      </div>
      ${meta.length ? `<p class="task-meta">${meta.join(' · ')}</p>` : ''}
      ${md(t.detail)}
      ${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}
      ${children.length ? `<ol class="tasks">${children.map(item).join('')}</ol>` : ''}
    </li>`;
  };
  const steps = hasDependencies(plan) ? buildSteps(plan) : [];
  const { branches } = branchPlan(plan);
  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  return `<section id="tasks">
  <h2>${ideas ? 'Task ideas' : 'Task list'}</h2>
  ${ideas ? '<p class="muted">The main pieces of work, kept coarse. The detailed task list is made from the design once you confirm it.</p>' : ''}
  ${counts.done || plan.submission ? `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Tasks done"><span style="width:${pct}%"></span></div><p class="muted">${counts.done} of ${counts.total} done</p>` : ''}
  ${steps.length > 1 ? `<h3>What waits on what</h3>${graph(tasksMermaid(plan))}<h4>Build order</h4><ol class="steps">${steps.map((s) => `<li>${s.map((t) => id(t.id)).join(' ')}${s.length > 1 ? ' <span class="muted">side by side</span>' : ''}</li>`).join('')}</ol>` : ''}
  ${branches.length ? `<h4>Branches</h4><ul class="links">${branches.map((b) => `<li><span class="branch">${esc(b.branch)}</span> ${b.base === SESSION_BRANCH ? 'stacked on the unbranched work' : b.base ? `stacked on <span class="branch">${esc(b.base)}</span>` : 'from the base branch'}: ${b.tasks.map((t) => id(t.id)).join(' ')}</li>`).join('')}</ul>` : ''}
  <ol class="tasks top">${childrenOf(plan, null).map(item).join('')}</ol>
</section>`;
}
