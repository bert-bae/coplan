import { useEffect, useRef, useState, type ReactNode } from 'react';
import { store, useAgent, usePlan, useSession, useStore, type ViewerState, type ViewerTab } from '../store.ts';
import { api } from '../lib/api.ts';
import { classNames } from '../lib/format.ts';
import { droppedParts, type Block, type BlockSource, type SettingKey } from '../../shared/blocks.ts';
import { findPart, outline, planPhase } from '../../shared/plan.ts';
import type { Plan, Target } from '../../shared/types.ts';

/**
 * What the agent reads, shown block by block with where each block comes
 * from.
 *
 * The daemon renders everything the agent is sent — the read-back, the
 * design and build prompts, each task's brief — as blocks that name their
 * source. Here each line carries a chip for it: a field of the plan jumps
 * to that box, arrow, section or task; a config setting shows its file and
 * key; what Coplan works out says from what. The agent's bookkeeping
 * (revisions, reply hints, the legend) is hidden until asked for, and what
 * was left out to fit the budget is shown struck through.
 */

/** Where docs/CONFIG.md describes each setting. */
export const CONFIG_DOCS = 'https://github.com/bert-bae/coplan/blob/main/docs/CONFIG.md';

export function configDocs(key: string): string {
  return `${CONFIG_DOCS}#${(key.split('.')[0] ?? '').toLowerCase()}`;
}

const SETTING_LABEL: Record<SettingKey, string> = { mode: 'mode', review: 'who reviews', parallel: 'tasks at once', maxRounds: 'review rounds' };

function short(text: string, max = 28): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** An item of the plan, named as the page names it. */
export function targetLabel(plan: Plan | null, target: Target): string {
  const part = plan && (target.kind === 'node' || target.kind === 'edge') ? findPart(plan, target) : null;
  switch (target.kind) {
    case 'plan':
      return 'The plan';
    case 'section':
      return `Section · ${short(plan?.sections.find((s) => s.id === target.id)?.title ?? target.id)}`;
    case 'diagram':
      return `Diagram · ${short(plan?.diagrams.find((d) => d.id === target.id)?.title ?? target.id)}`;
    case 'node':
      return `Box · ${short(part?.node?.label ?? target.id)}`;
    case 'edge': {
      const label = (id: string) => part?.diagram.nodes.find((n) => n.id === id)?.label ?? id;
      return part?.edge ? `Arrow · ${short(`${label(part.edge.source)} → ${label(part.edge.target)}`, 34)}` : `Arrow · ${target.id}`;
    }
    case 'task': {
      const task = plan?.tasks.find((t) => t.id === target.id);
      return `Task ${target.id}${task ? ` · ${short(task.title, 24)}` : ''}`;
    }
    default:
      return target.id;
  }
}

/** What a chip says. */
export function sourceLabel(source: BlockSource, plan: Plan | null): string {
  switch (source.kind) {
    case 'field':
      return targetLabel(plan, source.target);
    case 'config': {
      const [first, ...rest] = source.files;
      return `${first ?? '.coplan/config.json'}#${source.key}${rest.length ? ` +${rest.length}` : ''}`;
    }
    case 'derived':
      return `Worked out: ${short(source.from.join(', '), 30)}`;
    case 'template':
      return 'Coplan';
    case 'changes':
      return 'Your changes';
    case 'note':
      return 'Your note';
    case 'setting':
      return `Your choice: ${SETTING_LABEL[source.key]}`;
    default:
      return '';
  }
}

/** What a chip says on hover: the whole of where the words come from. */
export function sourceTitle(source: BlockSource, plan: Plan | null): string {
  switch (source.kind) {
    case 'field':
      return `From ${targetLabel(plan, source.target).replace(' · ', ' ')} in the page — click to show it`;
    case 'config':
      return source.files.length
        ? `Set in ${source.files.join(' and ')}, key ${source.key}. Read-only here — click for what it does`
        : `Not set in any file: Coplan's default for ${source.key} (.coplan/config.json). Click for what it does`;
    case 'derived':
      return `Worked out by Coplan from ${source.from.join(', ')}`;
    case 'template':
      return "Coplan's fixed instructions";
    case 'changes':
      return 'What you changed since the agent last read the plan';
    case 'note':
      return 'What you wrote for the agent in the sign-off dialog';
    case 'setting':
      return `How the build runs — ${SETTING_LABEL[source.key]} — as chosen when the plan was submitted`;
    default:
      return '';
  }
}

const sameSource = (a: BlockSource, b: BlockSource) => JSON.stringify(a) === JSON.stringify(b);

function SourceChip({ source, plan, onField }: { source: BlockSource; plan: Plan | null; onField?: ((target: Target) => void) | undefined }) {
  const label = sourceLabel(source, plan);
  const title = sourceTitle(source, plan);
  if (source.kind === 'field' && onField) {
    return (
      <button type="button" className="pv-chip is-field" title={title} onClick={() => onField(source.target)}>
        {label}
      </button>
    );
  }
  if (source.kind === 'config') {
    return (
      <a className={classNames('pv-chip is-config', !source.files.length && 'is-default')} href={configDocs(source.key)} target="_blank" rel="noreferrer" title={title}>
        {label}
      </a>
    );
  }
  return (
    <span className={classNames('pv-chip', `is-${source.kind}`)} title={title}>
      {label}
    </span>
  );
}

/** One line as the agent reads it: the block that starts it and the
 *  inline blocks that continue it. */
interface Row {
  head: Block;
  rest: Block[];
}

function rowsOf(blocks: readonly Block[]): Row[] {
  const rows: Row[] = [];
  for (const b of blocks) {
    const last = rows[rows.length - 1];
    if (b.inline && last) last.rest.push(b);
    else rows.push({ head: b, rest: [] });
  }
  return rows;
}

/**
 * Blocks with their sources. Without blocks (a prompt kept only as it was
 * sent) the text alone.
 */
export function PromptView({
  blocks,
  text,
  onField,
  testId,
  className,
}: {
  blocks?: Block[] | undefined;
  text: string;
  /** Show a field in the page; a field chip is inert without it. */
  onField?: ((target: Target) => void) | undefined;
  testId?: string;
  className?: string;
}) {
  const plan = usePlan();
  const showAll = useStore((s) => s.showBookkeeping);
  if (!blocks?.length) {
    return (
      <pre className={classNames('claude-text', className)} data-testid={testId}>
        {text}
      </pre>
    );
  }
  const rows = rowsOf(blocks);
  const hidden = blocks.filter((b) => b.bookkeeping && !b.dropped).length;
  const left = droppedParts(blocks);
  let previous: BlockSource | null = null;
  let droppedRun = false;
  const shown: ReactNode[] = [];
  for (const row of rows) {
    const parts = [row.head, ...row.rest].filter((b) => showAll || !b.bookkeeping);
    if (!parts.length) continue;
    const first = parts[0]!;
    const lead = /^\n*/.exec(first.text)?.[0].length ?? 0;
    // A chip where the source changes; the inline parts from elsewhere always.
    const head = previous && sameSource(previous, first.source) ? null : first.source;
    const others = parts.slice(1).filter((b, i, all) => b.source.kind !== 'template' && !sameSource(b.source, first.source) && all.findIndex((x) => sameSource(x.source, b.source)) === i);
    previous = first.source;
    const dropped = Boolean(row.head.dropped);
    const startsRun = dropped && !droppedRun;
    droppedRun = dropped;
    shown.push(
      <div
        key={row.head.id}
        className={classNames('pv-row', dropped && 'is-dropped', row.head.bookkeeping && 'is-bookkeeping', lead > 0 && 'has-gap')}
        data-block={row.head.id}
      >
        <div className="pv-src">
          {head && <SourceChip source={head} plan={plan} onField={onField} />}
          {others.map((b) => (
            <SourceChip key={b.id} source={b.source} plan={plan} onField={onField} />
          ))}
        </div>
        <div className="pv-text">
          {startsRun && <span className="pv-left">Left out to fit — the agent reads this with harness_plan_read</span>}
          {parts.map((b, i) => (
            <span
              key={b.id}
              className={classNames('pv-seg', i > 0 && b.source.kind !== 'template' && `is-${b.source.kind}`, b.bookkeeping && 'is-bookkeeping')}
              title={i > 0 && b.source.kind !== 'template' ? sourceTitle(b.source, plan) : undefined}
            >
              {i === 0 ? b.text.replace(/^\n+/, '') : b.text}
            </span>
          ))}
          {row.head.cut && <span className="pv-cut">cut to fit</span>}
        </div>
      </div>,
    );
  }
  return (
    <div className="pv">
      <div className="pv-tools">
        <label className="pv-toggle">
          <input type="checkbox" checked={showAll} onChange={(e) => store.set({ showBookkeeping: e.target.checked })} />
          Agent bookkeeping{hidden ? ` (${hidden})` : ''}
        </label>
        {left.length > 0 && <span className="pv-left-summary">Left out to fit: {left.join(', ')}</span>}
      </div>
      <div className={classNames('pv-doc', className)} data-testid={testId}>
        {shown}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The viewer
 * ------------------------------------------------------------------ */

const TAB_LABEL: Record<ViewerTab, string> = { readback: 'Read-back', prompt: 'Next prompt', brief: 'Task brief' };

interface Shown {
  key: string;
  text: string;
  blocks?: Block[];
}

/** The viewer, wherever it was opened from: the header, "View prompt", a
 *  task's Brief. Rendered once, by the app. */
export function PromptViewerHost() {
  const viewer = useStore((s) => s.viewer);
  const sessionId = useStore((s) => s.sessionId);
  if (!viewer || !sessionId) return null;
  return <PromptViewer key={`${sessionId}:${viewer.tab}:${viewer.taskId ?? ''}:${viewer.sent?.title ?? ''}`} viewer={viewer} />;
}

/** Show a field of the plan from the viewer: close it, and go there. */
function showField(target: Target): void {
  store.closeViewer();
  store.focusField(target);
}

function PromptViewer({ viewer }: { viewer: ViewerState }) {
  const session = useSession();
  const plan = usePlan();
  const agent = useAgent();
  const [tab, setTab] = useState<ViewerTab>(viewer.tab);
  const rows = plan ? outline(plan) : [];
  const [taskId, setTaskId] = useState<string>(viewer.taskId ?? rows.find((r) => !plan?.tasks.some((t) => t.parentId === r.task.id))?.task.id ?? rows[0]?.task.id ?? '');
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const phase = planPhase(plan);
  const sessionId = session?.sessionId ?? '';
  // What the text is made from: the plan, and the agent reading it.
  const stamp = `${plan?.seq ?? 0}:${plan?.version ?? 0}:${plan?.claudeReadAt ?? 0}`;
  const sent = viewer.sent ?? (phase !== 'planning' && phase !== 'tasking' && plan?.submission ? { title: 'The submitted prompt', prompt: plan.submission.prompt, meta: '' } : undefined);
  const key = `${tab}:${taskId}:${stamp}`;

  useEffect(() => {
    body.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        store.closeViewer();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (!sessionId || !plan) return;
    let live = true;
    const load = async (): Promise<Shown> => {
      if (tab === 'readback') return { key, ...(await api.readback(sessionId)) };
      if (tab === 'brief') return { key, ...(await api.brief(sessionId, taskId)) };
      if (sent) return { key, text: sent.prompt };
      const preview = phase === 'planning' ? await api.designPreview(sessionId, '') : await api.promptPreview(sessionId, null, '');
      return { key, text: preview.prompt, ...(preview.blocks ? { blocks: preview.blocks } : {}) };
    };
    if (tab === 'brief' && !taskId) {
      setShown({ key, text: 'There are no tasks yet.' });
      return;
    }
    load()
      .then((s) => {
        if (!live) return;
        setShown(s);
        setError(null);
      })
      .catch((err: unknown) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
    // `sent` and `phase` are read through `key` and `stamp`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, key]);

  if (!session || !plan) return null;
  const current = shown?.key === key;
  const about =
    tab === 'readback'
      ? `What harness_plan_read returns, as ${agent.name} would read it now. Looking here does not count as ${agent.name} reading it.`
      : tab === 'brief'
        ? `What harness_task_brief gives the agent that builds this task — and the subagent it hands the task to.`
        : sent
          ? `${sent.title}, exactly as it was sent${sent.meta ? ` · ${sent.meta}` : ''}. Each part's source was shown before you signed it off.`
          : phase === 'planning'
            ? `What Confirm design would send ${agent.name} now, without a note.`
            : `What Submit would send ${agent.name} now, with the repository's defaults and no note.`;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`What ${agent.name} reads`}>
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={() => store.closeViewer()} />
      <div className="lightbox-body is-text pv-viewer" ref={body} tabIndex={-1}>
        <header className="item-head">
          <h2 className="section-title">What {agent.name} reads</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={!shown} onClick={() => shown && void copy(shown.text)}>
            Copy
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => store.closeViewer()}>
            ×
          </button>
        </header>
        <div className="pv-tabs" role="tablist" aria-label="What to show">
          {(['readback', 'prompt', 'brief'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={classNames('pv-tab', tab === t && 'is-active')}
              onClick={() => setTab(t)}
            >
              {t === 'prompt' && sent ? 'Sent prompt' : TAB_LABEL[t]}
            </button>
          ))}
          {tab === 'brief' && rows.length > 0 && (
            <select className="input pv-task" aria-label="Task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              {rows.map(({ task, number, depth }) => (
                <option key={task.id} value={task.id}>
                  {`${'  '.repeat(depth)}${number} ${task.title}`}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="muted pv-about">{about}</p>
        {error ? (
          <p className="error-text" role="alert">
            Could not load it: {error}
          </p>
        ) : (
          <div className={classNames(!current && 'is-stale')}>
            <PromptView blocks={shown?.blocks} text={shown?.text ?? 'Loading…'} onField={showField} testId="viewer-text" />
          </div>
        )}
      </div>
    </div>
  );
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    store.toast('success', 'Copied.');
  } catch {
    store.toast('error', 'The browser would not let the page use the clipboard. Select the text and copy it instead.');
  }
}
