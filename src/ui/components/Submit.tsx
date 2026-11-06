import { useEffect, useRef, useState, type ReactNode } from 'react';
import { store, useAgent, usePlan, useSession, useStore } from '../store.ts';
import { api, type PromptPreview, type ProjectSummary } from '../lib/api.ts';
import { OpenInClaude } from './Handoff.tsx';
import { ProgressBar } from './Progress.tsx';
import { classNames, relativeTime } from '../lib/format.ts';
import { MAX_NOTE, countTasks, currentTask, planPhase, unreadAreas } from '../../shared/plan.ts';
import { MAX_PARALLEL, MAX_ROUNDS, branchPlan, buildSteps, hasDependencies, readyTasks } from '../../shared/build.ts';
import { blockingGaps, planGaps, type GapSeverities } from '../../shared/check.ts';
import { REVIEW_MODES, type BuildSettings, type BuildTarget, type Plan, type PlanPhase, type ReviewMode, type SessionState } from '../../shared/types.ts';
import { agentInfo, type AgentInfo } from '../../shared/agents.ts';
import { droppedParts, type ConfigRow } from '../../shared/blocks.ts';
import { CONFIG_DOCS, PromptView, configDocs } from './PromptView.tsx';
import type { Target } from '../../shared/types.ts';

/**
 * Signing the plan off, in two steps.
 *
 * **Confirm the design.** The architecture view is where the design is
 * finished, so it is where it is confirmed. The user reads the exact ask
 * the agent will get — make the task list from this design — and confirming
 * locks the architecture, sections and summary.
 *
 * **Submit the plan.** Once the agent has made the task list and the user has
 * shaped it, they choose how the build runs — who reviews each task, how
 * many run at once, how many review rounds before the agent asks — read the
 * exact build prompt, and submit. From then on the page only follows the
 * build as tasks move across the board.
 *
 * In both, the daemon builds the prompt, so the preview is the prompt, not
 * an imitation of it. Where the agent's hooks cannot hand a prompt over
 * with the user's next message (Cursor), signing off copies it to paste.
 */

function targets(agent: AgentInfo): { id: BuildTarget; label: string; hint: string }[] {
  return [
    {
      id: 'session',
      label: `This ${agent.name} session`,
      hint: agent.promptContext
        ? `Your next message in its chat carries this prompt, and the board follows each task as ${agent.name} works through it.`
        : `The prompt is copied for you to paste into this ${agent.name} chat, and the board follows each task as ${agent.name} works through it.`,
    },
    {
      id: 'elsewhere',
      label: 'Somewhere else',
      hint: 'Copy the prompt into the agent that will build it. The plan is locked all the same, but its progress cannot be followed here.',
    },
  ];
}

export const REVIEW_LABEL: Record<ReviewMode, string> = {
  subagent: 'Independent reviewer',
  self: 'Self-review',
  user: 'You review',
  skip: 'Checks only',
};

function reviewHint(mode: ReviewMode, agent: string): string {
  switch (mode) {
    case 'subagent':
      return 'A fresh subagent that did not write the change reviews each task and runs the checks.';
    case 'self':
      return `${agent} reviews its own change against the task, and runs the checks.`;
    case 'user':
      return `${agent} stops after each task and asks you to approve it in chat.`;
    default:
      return "The repository's checks are the only review. For small, low-risk plans.";
  }
}

/** How long typing in the note waits before the preview is rebuilt. */
const NOTE_SETTLE_MS = 300;

/** The arch bar's main action: confirm the design, then submit the plan;
 *  what the plan is once it is past both. */
export function SubmitControl() {
  const plan = usePlan();
  const agent = useAgent();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!plan) return null;
  const phase = planPhase(plan);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  if (phase === 'planning') {
    return (
      <>
        <button
          ref={trigger}
          type="button"
          className="btn btn-sm btn-primary"
          title={`Read what ${agent.name} will be asked, then lock the design so ${agent.name} can break it into a task list`}
          onClick={() => setOpen(true)}
        >
          Confirm design
        </button>
        {open && <ConfirmDesignDialog onClose={close} />}
      </>
    );
  }

  if (phase === 'tasking') {
    return (
      <span className="lock-control">
        <span className="lock-chip is-tasking" title="The design is locked; the tasks can still change">
          <span aria-hidden="true">✓</span> {PHASE_CHIP.tasking}
        </span>
        <button
          ref={trigger}
          type="button"
          className="btn btn-sm btn-primary"
          title={`Choose how the build runs, read the prompt ${agent.name} will be given, then lock the plan and hand it over`}
          onClick={() => setOpen(true)}
        >
          Review &amp; submit plan
        </button>
        {open && <SubmitDialog onClose={close} />}
      </span>
    );
  }

  return (
    <span className="lock-control">
      <span className={classNames('lock-chip', `is-${phase}`)} title="Submitted plans cannot be edited; reopen it to change it">
        <span aria-hidden="true">🔒</span> {PHASE_CHIP[phase]}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={!plan.submission}
        onClick={() =>
          plan.submission &&
          store.openViewer({
            tab: 'prompt',
            sent: {
              title: 'The submitted prompt',
              prompt: plan.submission.prompt,
              meta: `submitted ${relativeTime(plan.submission.at)} · ${
                plan.submission.deliveredAt
                  ? `${agent.name} got it ${relativeTime(plan.submission.deliveredAt)}`
                  : plan.submission.target === 'session'
                    ? agent.promptContext
                      ? `Not delivered yet: it goes with your next message in ${agent.name}`
                      : `Not delivered yet: paste it into ${agent.name}'s chat`
                    : 'Handed off to build elsewhere'
              }`,
            },
          })
        }
      >
        View prompt
      </button>
    </span>
  );
}

const PHASE_CHIP: Record<Exclude<PlanPhase, 'planning'>, string> = {
  tasking: 'Design confirmed',
  submitted: 'Submitted',
  building: 'Locked · building',
  finalizing: 'Locked · finishing',
  built: 'Built',
  'handed-off': 'Locked · handed off',
};

/* ------------------------------------------------------------------ *
 * The dialogs
 * ------------------------------------------------------------------ */

/** Escape closes, unless something is being sent. */
function useEscape(onClose: () => void, busy = false): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, busy]);
}

/**
 * What the user wrote for the agent in a dialog not yet signed off, by
 * session and dialog: following a field from the prompt closes the dialog,
 * and opening it again finds the note where it was left.
 */
const drafts = new Map<string, string>();

function useDraft(key: string): [string, (note: string) => void, () => void] {
  const [note, setNote] = useState(() => drafts.get(key) ?? '');
  const set = (value: string) => {
    setNote(value);
    if (value) drafts.set(key, value);
    else drafts.delete(key);
  };
  return [note, set, () => drafts.delete(key)];
}

/** Show a field a prompt quotes, from a sign-off dialog. */
function followField(onClose: () => void): (target: Target) => void {
  return (target) => {
    onClose();
    store.focusField(target);
  };
}

/** The note, settled a moment after the last keystroke. */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), NOTE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return settled;
}

/**
 * What the plan leaves open — the same list the agent gets from
 * harness_plan_check — so the user signs off knowing it. A warning, not a
 * gate (some gaps are deliberate: a box that already exists) — unless the
 * repository counts a rule as an error (`planCheck`), which holds the
 * sign-off until it is fixed.
 */
function GapList({ plan, severities }: { plan: Plan; severities: GapSeverities | undefined }) {
  const gaps = planGaps(plan, severities);
  if (!gaps.length) return null;
  const errors = gaps.filter((g) => g.severity === 'error').length;
  return (
    <details className="field submit-gaps" open={errors > 0}>
      <summary className="field-label">
        {gaps.length} gap{gaps.length === 1 ? '' : 's'} the plan leaves open
        {errors ? ` — ${errors === 1 ? 'one is an error' : `${errors} are errors`} in this repository, to fix first` : ''}
      </summary>
      <ul className="plain-list">
        {gaps.map((g, i) => (
          <li key={`${g.rule}:${g.target.kind}:${g.target.id}:${i}`} className={g.severity === 'error' ? 'submit-gap-error' : 'muted'}>
            {g.severity === 'error' ? <strong>Error: </strong> : null}
            {g.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Gaps the repository counts as errors: they hold Confirm and Submit. */
function heldBy(plan: Plan, preview: PromptPreview | null): number {
  return blockingGaps(plan, preview?.project?.planCheck).length;
}

/** The shared frame: the choices on the left, the prompt on the right. */
function ReviewFrame(props: {
  id: string;
  title: string;
  plan: Plan;
  busy: boolean;
  onClose: () => void;
  side: ReactNode;
  previewLabel: string;
  preview: PromptPreview | null;
  current: boolean;
  error: string | null;
  /** Show a field the prompt quotes: the dialog closes to show it. */
  onField: (target: Target) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.focus();
  }, []);
  const { preview } = props;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-labelledby={props.id}>
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={props.onClose} disabled={props.busy} />
      <div className="lightbox-body submit" ref={body} tabIndex={-1}>
        <header className="item-head">
          <h2 className="section-title" id={props.id}>
            {props.title}
          </h2>
          <span className="muted">{props.plan.title}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose} disabled={props.busy}>
            ×
          </button>
        </header>
        <div className="submit-grid">
          <div className="submit-side">
            <GapList plan={props.plan} severities={props.preview?.project?.planCheck} />
            {props.side}
          </div>
          <section className="submit-preview" aria-label="The prompt">
            <header className="submit-preview-head">
              <span className="field-label">{props.previewLabel}</span>
              {preview && (
                <span className="muted submit-count">
                  {preview.prompt.length.toLocaleString()} characters
                  {!props.current && ' · updating…'}
                </span>
              )}
              <span className="spacer" />
              <button type="button" className="btn btn-sm" disabled={!preview} onClick={() => preview && void copyText(preview.prompt, 'Copied the prompt.')}>
                Copy
              </button>
            </header>
            {props.error ? (
              <p className="error-text" role="alert">
                Could not build the prompt: {props.error}
              </p>
            ) : (
              <PromptView
                blocks={preview?.blocks}
                text={preview?.prompt ?? 'Building the prompt…'}
                className={classNames('submit-prompt', !props.current && 'is-stale')}
                testId="prompt-preview"
                onField={props.busy ? undefined : props.onField}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDesignDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const plan = usePlan();
  const agent = useAgent();
  const sessionId = useStore((s) => s.sessionId);
  const [note, setNote, clearDraft] = useDraft(`${sessionId}:design`);
  const settled = useSettled(note);
  const [shown, setShown] = useState<{ preview: PromptPreview; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An edit still on its way (the canvas, a field) is not in the prompt yet.
  const unsaved = useStore((s) => s.saving > 0 || s.canvasSaving);
  const version = plan?.version ?? 0;
  // The prompt also moves when the agent reads the plan (its "since you
  // last read" part), which is not a new version — and after a refused
  // confirm, whatever moved it is fetched again.
  const readAt = plan?.claudeReadAt ?? 0;
  const [refresh, setRefresh] = useState(0);
  useEscape(onClose, busy);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    api
      .designPreview(sessionId, settled)
      .then((preview) => {
        if (!live) return;
        setShown({ preview, note: settled });
        setError(null);
      })
      .catch((err: unknown) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [sessionId, settled, version, readAt, refresh]);

  if (!session || !plan) return null;
  const current = Boolean(shown && shown.note === note && shown.preview.version >= version);
  const preview = shown?.preview ?? null;

  const confirm = async () => {
    if (!preview || !current) return;
    setBusy(true);
    // Where no hook can hand the prompt over (Cursor), the user pastes it.
    if (!agent.promptContext) await copyText(preview.prompt, `Copied — paste it into ${agent.name}'s chat.`);
    const ok = await store.confirmDesign({ note, expect: preview.version, ...(preview.hash ? { hash: preview.hash } : {}) });
    setBusy(false);
    if (ok) {
      clearDraft();
      onClose();
    }
    else setRefresh((n) => n + 1);
  };

  const held = heldBy(plan, preview) > 0;
  return (
    <ReviewFrame
      id="confirm-title"
      title="Confirm the design"
      plan={plan}
      busy={busy}
      onClose={onClose}
      previewLabel={`What ${agent.name} will be asked`}
      preview={preview}
      current={current}
      error={error}
      onField={followField(onClose)}
      side={
        <>
          <DesignChecklist session={session} plan={plan} project={preview?.project} left={preview?.trimmed ? leftOut(preview) : null} />
          <ConfigList rows={preview?.project?.config} />
          <label className="field">
            <span className="field-label">Anything else for {agent.name}?</span>
            <textarea
              className="input"
              rows={3}
              maxLength={preview?.maxNote ?? MAX_NOTE}
              value={note}
              placeholder="Optional — how finely to split the work, which parts to land as separate pull requests."
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <p className="explain">
            Confirming <strong>locks the design</strong> — the diagrams, sections and summary.{' '}
            {agent.promptContext ? `${agent.name} gets it with your next message in chat` : `You paste it into ${agent.name}'s chat`} and
            it breaks the planned tasks into the task list: focused tasks, what blocks what, and which branch each lands on. You
            shape that list, then submit the plan to start the build.
          </p>
          <div className="submit-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!current || busy || unsaved || held} title={unsaved ? 'Saving your last edit first…' : held ? 'Fix the gaps this repository counts as errors first' : undefined} onClick={() => void confirm()}>
              {busy ? 'Confirming…' : agent.promptContext ? 'Confirm design' : 'Copy and confirm design'}
            </button>
          </div>
        </>
      }
    />
  );
}

interface Shown {
  preview: PromptPreview;
  target: BuildTarget;
  note: string;
  /** The settings it was asked for with; '' for the repository's defaults. */
  key: string;
}

const settingsKey = (s: BuildSettings | null) => (s ? `${s.review}:${s.parallel}:${s.maxRounds}` : '');

export function SubmitDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const plan = usePlan();
  const agent = useAgent();
  const sessionId = useStore((s) => s.sessionId);
  const [target, setTarget] = useState<BuildTarget>('session');
  const [note, setNote, clearDraft] = useDraft(`${sessionId}:submit`);
  const settled = useSettled(note);
  // Null until the first preview says what the repository's defaults are.
  const [settings, setSettings] = useState<BuildSettings | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // An edit still on its way (the canvas, a field) is not in the prompt yet.
  const unsaved = useStore((s) => s.saving > 0 || s.canvasSaving);
  const version = plan?.version ?? 0;
  // As for the design: the agent reading the plan moves the prompt without
  // a new version, and a refused submit fetches it again.
  const readAt = plan?.claudeReadAt ?? 0;
  const [refresh, setRefresh] = useState(0);
  const key = settingsKey(settings);
  useEscape(onClose, submitting);

  // Rebuilt whenever what it is built from changes: the choices, the note,
  // or the plan itself (the agent can still move it while this is open).
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    api
      .promptPreview(sessionId, target, settled, settings ?? undefined)
      .then((preview) => {
        if (!live) return;
        setShown({ preview, target, note: settled, key });
        if (!settings && preview.settings) setSettings(preview.settings);
        setError(null);
      })
      .catch((err: unknown) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
    // `settings` is read through `key`, which says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, target, settled, version, key, readAt, refresh]);

  if (!session || !plan) return null;

  // What is on screen is what is sent: the button waits until the preview
  // matches the choices, the note and the plan.
  const current = Boolean(shown && shown.target === target && shown.note === note && shown.key === key && shown.preview.version >= version);
  const preview = shown?.preview ?? null;

  const submit = async () => {
    if (!preview || !current) return;
    setSubmitting(true);
    // Where no hook can hand the prompt over (Cursor), the user pastes it.
    if (target === 'elsewhere' || !agent.promptContext) {
      await copyText(preview.prompt, target === 'session' ? `Copied — paste it into ${agent.name}'s chat.` : 'Copied the prompt.');
    }
    const ok = await store.submitPlan({ target, note, expect: preview.version, ...(preview.hash ? { hash: preview.hash } : {}), ...(settings ? { settings } : {}) });
    setSubmitting(false);
    if (ok) {
      clearDraft();
      onClose();
    }
    else setRefresh((n) => n + 1);
  };

  const held = heldBy(plan, preview) > 0;
  return (
    <ReviewFrame
      id="submit-title"
      title="Submit the plan"
      plan={plan}
      busy={submitting}
      onClose={onClose}
      previewLabel={target === 'session' ? `The prompt ${agent.name} will get` : 'The prompt to paste'}
      preview={preview}
      current={current}
      error={error}
      onField={followField(onClose)}
      side={
        <>
          <Checklist
            session={session}
            plan={plan}
            target={target}
            project={preview?.project}
            left={preview?.trimmed && shown?.target === 'session' ? leftOut(preview) : null}
          />

          <fieldset className="submit-targets">
            <legend className="field-label">Who builds it?</legend>
            {targets(agent).map((t) => (
              <label key={t.id} className={classNames('submit-target', target === t.id && 'is-active')}>
                <input type="radio" name="build-target" value={t.id} checked={target === t.id} onChange={() => setTarget(t.id)} />
                <span>
                  <strong>{t.label}</strong>
                  <span className="submit-target-hint">{t.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {settings && <SettingsFields settings={settings} onChange={setSettings} />}

          <ConfigList rows={preview?.project?.config} />

          <label className="field">
            <span className="field-label">Anything else for {agent.name}?</span>
            <textarea
              className="input"
              rows={3}
              maxLength={preview?.maxNote ?? MAX_NOTE}
              value={note}
              placeholder="Optional — where to start, what to leave alone, how to test it."
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <p className="explain">
            Submitting <strong>locks the plan</strong>: the tasks can no longer be edited, and the page follows the build on
            the task board. You can reopen it if something has to change.
          </p>

          <div className="submit-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!current || submitting || unsaved || held} title={unsaved ? 'Saving your last edit first…' : held ? 'Fix the gaps this repository counts as errors first' : undefined} onClick={() => void submit()}>
              {submitting ? 'Submitting…' : target === 'session' && agent.promptContext ? 'Submit and lock' : 'Copy, submit and lock'}
            </button>
          </div>
        </>
      }
    />
  );
}

/** The user's control over the build: each task's implement → review →
 *  refine cycle, and how much runs at once. */
function SettingsFields({ settings, onChange }: { settings: BuildSettings; onChange: (s: BuildSettings) => void }) {
  const agent = useAgent();
  const number = (value: string, lo: number, hi: number, fallback: number) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  };
  return (
    <fieldset className="submit-settings">
      <legend className="field-label">How each task is built</legend>
      <p className="submit-target-hint">Every task goes implement → review → refine before it is done.</p>
      <div className="segmented is-small" role="radiogroup" aria-label="Who reviews each task">
        {REVIEW_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={settings.review === mode}
            className={classNames('seg', settings.review === mode && 'is-active')}
            title={reviewHint(mode, agent.name)}
            onClick={() => onChange({ ...settings, review: mode })}
          >
            {REVIEW_LABEL[mode]}
          </button>
        ))}
      </div>
      <p className="submit-target-hint">{reviewHint(settings.review, agent.name)}</p>
      <div className="settings-numbers">
        <label className="field-inline">
          <input
            className="input input-number"
            type="number"
            min={1}
            max={MAX_PARALLEL}
            value={settings.parallel}
            onChange={(e) => onChange({ ...settings, parallel: number(e.target.value, 1, MAX_PARALLEL, settings.parallel) })}
          />
          <span>{settings.parallel === 1 ? 'task at a time' : 'tasks at once, each by its own subagent'}</span>
        </label>
        <label className="field-inline">
          <input
            className="input input-number"
            type="number"
            min={1}
            max={MAX_ROUNDS}
            value={settings.maxRounds}
            onChange={(e) => onChange({ ...settings, maxRounds: number(e.target.value, 1, MAX_ROUNDS, settings.maxRounds) })}
          />
          <span>
            review round{settings.maxRounds === 1 ? '' : 's'}, then {agent.name} asks you
          </span>
        </label>
      </div>
    </fieldset>
  );
}

type Note = { tone: 'info' | 'warn'; text: ReactNode };

function NoteList({ summary, notes }: { summary: ReactNode; notes: Note[] }) {
  return (
    <div className="submit-check">
      <p className="submit-summary">{summary}</p>
      {notes.length > 0 && (
        <ul className="submit-notes">
          {notes.map((n, i) => (
            <li key={i} className={`is-${n.tone}`}>
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sessionNotes(session: SessionState, plan: Plan, notes: Note[]): void {
  const agent = agentInfo(session.agent);
  const unread = unreadAreas(plan);
  if (session.status === 'ended') notes.push({ tone: 'warn', text: `This session has ended. Resume it in ${agent.name} to carry on here.` });
  if (session.waiting) {
    notes.push({
      tone: 'warn',
      text: agent.promptContext
        ? `${agent.name} is waiting on you in chat. Answer it there; the prompt goes with the next message you type.`
        : `${agent.name} is waiting on you in chat. Answer it there before you paste the prompt.`,
    });
  }
  if (unread.length) notes.push({ tone: 'info', text: `${agent.name} has not read your latest changes (${unread.join(', ')}). The prompt lists them first.` });
}

function checksNote(project: ProjectSummary | undefined, notes: Note[], agent: AgentInfo): void {
  if (!project) return;
  for (const e of project.errors) notes.push({ tone: 'warn', text: e });
  const stages = (['implement', 'review', 'final'] as const).filter((s) => project.checks[s].length);
  if (!project.file || !stages.length) {
    notes.push({
      tone: 'info',
      text: (
        <>
          No checks are set up for this repository (<code>.coplan/config.json</code>), so {agent.name} picks what to run.
          Run <code>coplan init</code> (or <code>/coplan-init</code> in Claude Code) to set them.
        </>
      ),
    });
  }
}

function DesignChecklist({ session, plan, project, left }: { session: SessionState; plan: Plan; project: ProjectSummary | undefined; left: string | null }) {
  const boxes = plan.diagrams.flatMap((d) => d.nodes.filter((n) => n.kind !== 'note'));
  const bare = boxes.filter((n) => !n.description?.trim());
  const counts = countTasks(plan);
  const linked = new Set(boxes.flatMap((n) => n.taskIds ?? []));
  const open = plan.threads.filter((t) => !t.resolved).length;
  const notes: Note[] = [];
  const agent = agentInfo(session.agent);
  if (plan.diagrams.length === 0) notes.push({ tone: 'warn', text: `There is no diagram: ${agent.name} will make the task list from the sections alone.` });
  if (bare.length) {
    notes.push({ tone: 'info', text: `${bare.length} box${bare.length === 1 ? ' has' : 'es have'} no description: ${bare.slice(0, 3).map((n) => n.label).join(', ')}${bare.length > 3 ? ', …' : ''}.` });
  }
  if (counts.total && boxes.length && linked.size === 0) notes.push({ tone: 'info', text: 'No box is linked to a planned task yet.' });
  if (open) notes.push({ tone: 'info', text: `${open} open comment${open === 1 ? '' : 's'} go${open === 1 ? 'es' : ''} with the design.` });
  sessionNotes(session, plan, notes);
  checksNote(project, notes, agent);
  if (left !== null) notes.push({ tone: 'info', text: `The design is longer than fits in one message${left}, so ${agent.name} reads the rest with harness_plan_read.` });
  return (
    <NoteList
      summary={`${plan.diagrams.length} diagram${plan.diagrams.length === 1 ? '' : 's'} · ${boxes.length} box${boxes.length === 1 ? '' : 'es'} · ${plan.tasks.length} planned task${plan.tasks.length === 1 ? '' : 's'}`}
      notes={notes}
    />
  );
}

/** What is worth knowing before locking the plan. */
function Checklist({
  session,
  plan,
  target,
  project,
  left,
}: {
  session: SessionState;
  plan: Plan;
  target: BuildTarget;
  project: ProjectSummary | undefined;
  /** What the prompt leaves out to fit, in words; null when it fits. */
  left: string | null;
}) {
  const counts = countTasks(plan);
  const steps = buildSteps(plan).length;
  const { branches } = branchPlan(plan);
  const ready = readyTasks(plan).length;
  const open = plan.threads.filter((t) => !t.resolved).length;
  const notes: Note[] = [];
  if (counts.total === 0) notes.push({ tone: 'warn', text: 'There are no tasks, so there will be nothing to follow on the board.' });
  else if (!hasDependencies(plan) && counts.total > 1) {
    notes.push({ tone: 'info', text: 'No task says what it depends on, so every task is free to start — and to run alongside the others.' });
  } else if (counts.total) {
    notes.push({ tone: 'info', text: `${ready} task${ready === 1 ? '' : 's'} can start right away; the rest follow in ${steps} step${steps === 1 ? '' : 's'}.` });
  }
  if (branches.length) {
    const stacked = branches.filter((b) => b.base).length;
    notes.push({ tone: 'info', text: `Lands on ${branches.length} branch${branches.length === 1 ? '' : 'es'}${stacked ? `, ${stacked} stacked on another` : ''}: ${branches.map((b) => b.branch).join(', ')}.` });
  }
  if (target === 'session') sessionNotes(session, plan, notes);
  checksNote(project, notes, agentInfo(session.agent));
  if (open) notes.push({ tone: 'info', text: `${open} open comment${open === 1 ? '' : 's'} go${open === 1 ? 'es' : ''} with the plan.` });
  if (left !== null) {
    notes.push({
      tone: 'info',
      text: `The plan is longer than fits in one message${left}, so ${agentInfo(session.agent).name} reads it with harness_plan_read.`,
    });
  }
  const boxes = plan.diagrams.reduce((n, d) => n + d.nodes.length, 0);
  return (
    <NoteList
      summary={
        <>
          {plan.diagrams.length} diagram{plan.diagrams.length === 1 ? '' : 's'} · {boxes} box{boxes === 1 ? '' : 'es'} · {counts.total} task
          {counts.total === 1 ? '' : 's'}
          {counts.done ? ` (${counts.done} already done)` : ''}
        </>
      }
      notes={notes}
    />
  );
}

/** What a prompt cut to fit leaves out, as the end of a sentence: ": it
 *  leaves out 3 sections and the architecture (2 diagrams)". */
function leftOut(preview: PromptPreview): string {
  const parts = droppedParts(preview.blocks ?? []);
  if (!parts.length) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `: it leaves out ${list}`;
}

/**
 * The config settings the prompt is made with, read-only: what each is set
 * to, grouped by the file that sets it, each with its key. The files are
 * shared with the team on purpose, so they are changed there, not here.
 */
function ConfigList({ rows }: { rows: ConfigRow[] | undefined }) {
  if (!rows?.length) return null;
  const groups = new Map<string, ConfigRow[]>();
  for (const r of rows) {
    const where = r.files.join(' + ');
    groups.set(where, [...(groups.get(where) ?? []), r]);
  }
  // What a file sets first; what nothing sets, and so is Coplan's default, last.
  const ordered = [...groups].sort(([a], [b]) => Number(!a) - Number(!b));
  return (
    <section className="field submit-config" aria-label="Set in config">
      <header className="submit-config-head">
        <span className="field-label">Set in config</span>
        <a className="link" href={CONFIG_DOCS} target="_blank" rel="noreferrer">
          Where to change these
        </a>
      </header>
      {ordered.map(([where, list]) => (
        <div key={where} className="config-group">
          <p className="config-file">{where ? <code>{where}</code> : <>Not set: Coplan&apos;s defaults</>}</p>
          <dl className="config-rows">
            {list.map((r) => (
              <div key={r.key} className="config-row" data-key={r.key}>
                <dt>
                  {r.label}
                  <a className="config-key" href={configDocs(r.key)} target="_blank" rel="noreferrer" title={`${where || '.coplan/config.json'}#${r.key} — what it does, in docs/CONFIG.md`}>
                    {where ? '' : '.coplan/config.json'}#{r.key}
                  </a>
                </dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * After signing off
 * ------------------------------------------------------------------ */

/**
 * Where the plan stands, under the header on every view once the design is
 * confirmed — and, while the agent has not picked a prompt up, how to hand it
 * over.
 */
export function PhaseStrip({ session }: { session: SessionState }) {
  const plan = session.plan;
  const phase = planPhase(plan);
  if (!plan || phase === 'planning') return null;
  if (phase === 'tasking') return <TaskingStrip session={session} plan={plan} />;
  return <BuildStrip session={session} plan={plan} phase={phase} />;
}

function TaskingStrip({ session, plan }: { session: SessionState; plan: Plan }) {
  const tab = useStore((s) => s.tab);
  const agent = agentInfo(session.agent);
  const [confirming, setConfirming] = useState(false);
  const design = plan.design!;
  // The task list the agent published since the design was confirmed.
  const listed = plan.changes.some((c) => c.kind === 'published' && c.ts >= design.at && c.summary.startsWith('published the task list'));
  const counts = countTasks(plan);
  const steps = buildSteps(plan).length;

  let head: string;
  let text: ReactNode;
  if (!design.deliveredAt) {
    head = `Design confirmed — waiting for ${agent.name}`;
    text = !agent.promptContext ? (
      <>
        Paste the prompt into {agent.name}'s chat — or ask it to <q>make the task list</q>, and it picks the design up with
        harness_plan_read.
      </>
    ) : session.status === 'ended' ? (
      `This session has ended. Resume it in ${agent.name}, then send any message: the design goes with it.`
    ) : (
      <>
        Send any message in {agent.name}'s chat — <q>go</q> will do — and Coplan hands it the design to break into a task list.
      </>
    );
  } else if (!listed) {
    head = `Design confirmed — ${agent.name} is making the task list`;
    text = `${agent.name} has the design and is breaking it into focused tasks, what blocks what, and where each lands.`;
  } else {
    head = 'Design confirmed — the task list is ready to review';
    text = (
      <>
        {counts.total} task{counts.total === 1 ? '' : 's'} in {steps} build step{steps === 1 ? '' : 's'}. Shape them in Tasks, then{' '}
        <strong>Review &amp; submit</strong> to start the build.
      </>
    );
  }

  return (
    <section className="phase is-tasking" aria-label="The design">
      <div className="phase-body">
        <p className="phase-head">
          <span aria-hidden="true">✓</span> {head}
          <span className="muted"> · confirmed {relativeTime(design.at)}</span>
        </p>
        <p className="phase-text">{text}</p>
      </div>
      <div className="phase-actions">
        {confirming ? (
          <span className="item-confirm">
            Unlock the design? The tasks stay as they are.
            <button
              type="button"
              className="link is-danger"
              onClick={() => {
                setConfirming(false);
                void store.reopenDesign();
              }}
            >
              Reopen design
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </span>
        ) : (
          <>
            {!design.deliveredAt && session.link && <OpenInClaude session={session} primary />}
            {!design.deliveredAt && (
              <button
                type="button"
                className={classNames('btn btn-sm', (!session.link || !agent.promptContext) && 'btn-primary')}
                title={`Pasting it into ${agent.name} works too; it is not sent twice`}
                onClick={() => void copyText(design.prompt, `Copied — paste it into ${agent.name}'s chat.`)}
              >
                Copy prompt
              </button>
            )}
            {design.deliveredAt && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  store.openViewer({
                    tab: 'prompt',
                    sent: {
                      title: `The confirmed design, as ${agent.name} got it`,
                      prompt: design.prompt,
                      meta: `confirmed ${relativeTime(design.at)}${design.deliveredAt ? ` · ${agent.name} got it ${relativeTime(design.deliveredAt)}` : ''}`,
                    },
                  })
                }
              >
                View prompt
              </button>
            )}
            {listed && tab !== 'tasks' && (
              <button type="button" className="btn btn-sm" onClick={() => store.set({ tab: 'tasks', taskMode: 'outline' })}>
                Review the tasks
              </button>
            )}
            <button type="button" className="link" onClick={() => setConfirming(true)}>
              Reopen design
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** Where the build stands, and — before the agent has the prompt — how to hand it over. */
function BuildStrip({ session, plan, phase }: { session: SessionState; plan: Plan; phase: PlanPhase }) {
  const tab = useStore((s) => s.tab);
  const agent = agentInfo(session.agent);
  const [confirming, setConfirming] = useState(false);
  const submission = plan.submission;
  if (!submission) return null;
  const counts = countTasks(plan);
  const now = currentTask(plan);
  const blocked = plan.tasks.filter((t) => t.status === 'blocked' && !plan.tasks.some((c) => c.parentId === t.id));

  let head: string;
  let text: ReactNode;
  switch (phase) {
    case 'submitted':
      head = `Submitted — waiting for ${agent.name} to start`;
      text = !agent.promptContext ? (
        <>
          Paste the prompt into {agent.name}'s chat — or ask it to <q>build the plan</q>, and it picks the prompt up with
          harness_plan_read.
        </>
      ) : session.status === 'ended' ? (
        `This session has ended. Resume it in ${agent.name}, then send any message: the prompt goes with it.`
      ) : (
        <>
          Send any message in {agent.name}'s chat — <q>go</q> will do — and Coplan hands it the build prompt with it.
        </>
      );
      break;
    case 'building':
      head = 'Building';
      text = now ? (
        <>
          {agent.name} is on <strong>{now.title}</strong>
          {now.stage ? ` — ${now.stage === 'review' ? `in review${now.round ? `, round ${now.round}` : ''}` : now.stage === 'refine' ? 'refining' : 'implementing'}` : ''}
          {now.note ? ` — ${now.note}` : ''}
        </>
      ) : blocked.length ? (
        `${blocked.length} task${blocked.length === 1 ? ' is' : 's are'} blocked: ${blocked[0]!.title}${blocked[0]!.note ? ` — ${blocked[0]!.note}` : ''}`
      ) : (
        `${agent.name} has the plan. No task is in progress right now.`
      );
      break;
    case 'finalizing':
      head = 'Finishing';
      text = `Every task is done (${counts.total}). ${agent.name} is running the final checks, opening the pull requests and writing the build report.`;
      break;
    case 'built':
      head = 'Built';
      text = plan.report ? `Every task is done (${counts.total}), and ${agent.name} wrote the build report.` : `Every task is done (${counts.total}).`;
      break;
    default:
      head = 'Handed off';
      text = 'The prompt was copied to build somewhere else, so progress is not followed here.';
  }

  return (
    // A region, not a live one: the board announces each move as it happens.
    <section className={classNames('phase', `is-${phase}`)} aria-label="The build">
      <div className="phase-body">
        <p className="phase-head">
          <span aria-hidden="true">🔒</span> {head}
          <span className="muted"> · submitted {relativeTime(submission.at)}</span>
        </p>
        <p className="phase-text">{text}</p>
      </div>
      {counts.total > 0 && phase !== 'handed-off' && (
        <span className="phase-progress">
          <ProgressBar counts={counts} compact />
          <span className="muted">
            {counts.done}/{counts.total}
          </span>
        </span>
      )}
      <div className="phase-actions">
        {confirming ? (
          <span className="item-confirm">
            {submission.deliveredAt
              ? `Unlock the tasks? The design stays confirmed, and ${agent.name} keeps building until you tell it otherwise in chat.`
              : 'Withdraw the submission?'}
            <button
              type="button"
              className="link is-danger"
              onClick={() => {
                setConfirming(false);
                void store.reopenPlan();
              }}
            >
              {submission.deliveredAt ? 'Reopen' : 'Withdraw'}
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </span>
        ) : (
          <>
            {phase === 'submitted' && session.link && <OpenInClaude session={session} primary />}
            {(phase === 'submitted' || phase === 'handed-off') && (
              <button
                type="button"
                className={classNames('btn btn-sm', phase === 'submitted' && (!session.link || !agent.promptContext) && 'btn-primary')}
                title={phase === 'submitted' ? `Pasting it into ${agent.name} works too; it is not sent twice` : undefined}
                onClick={() =>
                  void copyText(submission.prompt, phase === 'submitted' ? `Copied — paste it into ${agent.name}'s chat.` : 'Copied the prompt.')
                }
              >
                Copy prompt
              </button>
            )}
            {(phase === 'building' || phase === 'finalizing' || phase === 'built') && tab !== 'tasks' && (
              <button type="button" className="btn btn-sm" onClick={() => store.set({ tab: 'tasks', taskMode: 'board' })}>
                Follow on the board
              </button>
            )}
            {phase === 'built' && plan.report && tab !== 'overview' && (
              <button type="button" className="btn btn-sm" onClick={() => store.set({ tab: 'overview' })}>
                Read the report
              </button>
            )}
            <button type="button" className="link" onClick={() => setConfirming(true)}>
              {submission.deliveredAt ? 'Reopen for changes' : 'Withdraw'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

async function copyText(text: string, ok: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    store.toast('success', ok);
  } catch {
    store.toast('error', 'The browser would not let the page use the clipboard. Select the prompt and copy it instead.');
  }
}
