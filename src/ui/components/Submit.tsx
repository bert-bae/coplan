import { useEffect, useRef, useState, type ReactNode } from 'react';
import { store, useAgent, usePlan, useSession, useStore } from '../store.ts';
import { api, type PromptPreview } from '../lib/api.ts';
import { OpenInClaude } from './Handoff.tsx';
import { ProgressBar } from './Progress.tsx';
import { classNames, relativeTime } from '../lib/format.ts';
import { MAX_NOTE, countTasks, currentTask, planPhase, unreadAreas } from '../../shared/plan.ts';
import { agentInfo, type AgentInfo } from '../../shared/agents.ts';
import type { BuildTarget, Plan, PlanPhase, SessionState } from '../../shared/types.ts';

/**
 * Signing the plan off.
 *
 * The architecture view is where the plan is finished, so it is where it is
 * submitted from. Before anything is locked the user reads the exact prompt
 * Claude will be given — the daemon builds it, so the preview is the prompt,
 * not an imitation of it. Submitting locks the plan; from then on the page
 * only follows the build as tasks move across the board.
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

/** How long typing in the note waits before the preview is rebuilt. */
const NOTE_SETTLE_MS = 300;

/** The arch bar's main action while planning; what the plan is once it is not. */
export function SubmitControl() {
  const plan = usePlan();
  const agent = useAgent();
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!plan) return null;
  const phase = planPhase(plan);

  if (phase !== 'planning') {
    return (
      <span className="lock-control">
        <span className={classNames('lock-chip', `is-${phase}`)} title="Submitted plans cannot be edited; reopen it to change it">
          <span aria-hidden="true">🔒</span> {PHASE_CHIP[phase]}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => setViewing(true)}>
          View prompt
        </button>
        {viewing && <SubmittedPrompt plan={plan} onClose={() => setViewing(false)} />}
      </span>
    );
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn-sm btn-primary"
        title={`Read the prompt ${agent.name} will be given, then lock the plan and hand it over to be built`}
        onClick={() => setOpen(true)}
      >
        Review &amp; submit plan
      </button>
      {open && (
        <SubmitDialog
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}

const PHASE_CHIP: Record<Exclude<PlanPhase, 'planning'>, string> = {
  submitted: 'Submitted',
  building: 'Locked · building',
  built: 'Built',
  'handed-off': 'Locked · handed off',
};

/* ------------------------------------------------------------------ *
 * The review
 * ------------------------------------------------------------------ */

interface Shown {
  preview: PromptPreview;
  target: BuildTarget;
  note: string;
}

export function SubmitDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const plan = usePlan();
  const agent = useAgent();
  const sessionId = useStore((s) => s.sessionId);
  const [target, setTarget] = useState<BuildTarget>('session');
  const [note, setNote] = useState('');
  const [settled, setSettled] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const version = plan?.version ?? 0;

  useEffect(() => {
    body.current?.focus();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(note), NOTE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [note]);

  // Rebuilt whenever what it is built from changes: the choice, the note,
  // or the plan itself (Claude can still move it while this is open).
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    api
      .promptPreview(sessionId, target, settled)
      .then((preview) => {
        if (!live) return;
        setShown({ preview, target, note: settled });
        setError(null);
      })
      .catch((err: unknown) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [sessionId, target, settled, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, submitting]);

  if (!session || !plan) return null;

  // What is on screen is what is sent: the button waits until the preview
  // matches the choice, the note and the plan.
  const current = Boolean(shown && shown.target === target && shown.note === note && shown.preview.version >= version);
  const preview = shown?.preview ?? null;

  const submit = async () => {
    if (!preview || !current) return;
    setSubmitting(true);
    // Where no hook can hand the prompt over (Cursor), the user pastes it.
    const paste = target === 'elsewhere' || !agent.promptContext;
    if (paste) {
      await copyText(preview.prompt, target === 'session' ? `Copied — paste it into ${agent.name}'s chat.` : 'Copied the prompt.');
    }
    const ok = await store.submitPlan({ target, note, expect: preview.version });
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-labelledby="submit-title">
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={onClose} disabled={submitting} />
      <div className="lightbox-body submit" ref={body} tabIndex={-1}>
        <header className="item-head">
          <h2 className="section-title" id="submit-title">
            Submit the plan
          </h2>
          <span className="muted">{plan.title}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={submitting}>
            ×
          </button>
        </header>

        <div className="submit-grid">
          <div className="submit-side">
            <Checklist session={session} plan={plan} target={target} trimmed={Boolean(preview?.trimmed && shown?.target === 'session')} />

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
              Submitting <strong>locks the plan</strong>: the diagrams, tasks and sections can no longer be edited, and the
              page follows the build on the task board. You can reopen it if something has to change.
            </p>

            <div className="submit-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={!current || submitting} onClick={() => void submit()}>
                {submitting ? 'Submitting…' : target === 'session' && agent.promptContext ? 'Submit and lock' : 'Copy, submit and lock'}
              </button>
            </div>
          </div>

          <section className="submit-preview" aria-label="The prompt">
            <header className="submit-preview-head">
              <span className="field-label">{target === 'session' ? `The prompt ${agent.name} will get` : 'The prompt to paste'}</span>
              {preview && (
                <span className="muted submit-count">
                  {preview.prompt.length.toLocaleString()} characters
                  {!current && ' · updating…'}
                </span>
              )}
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-sm"
                disabled={!preview}
                onClick={() => preview && void copyText(preview.prompt, 'Copied the prompt.')}
              >
                Copy
              </button>
            </header>
            {error ? (
              <p className="error-text" role="alert">
                Could not build the prompt: {error}
              </p>
            ) : (
              <pre className={classNames('claude-text', 'submit-prompt', !current && 'is-stale')} data-testid="prompt-preview">
                {preview?.prompt ?? 'Building the prompt…'}
              </pre>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** What is worth knowing before locking the plan. */
function Checklist({ session, plan, target, trimmed }: { session: SessionState; plan: Plan; target: BuildTarget; trimmed: boolean }) {
  const agent = agentInfo(session.agent);
  const counts = countTasks(plan);
  const boxes = plan.diagrams.reduce((n, d) => n + d.nodes.length, 0);
  const open = plan.threads.filter((t) => !t.resolved).length;
  const unread = unreadAreas(plan);
  const notes: { tone: 'info' | 'warn'; text: ReactNode }[] = [];
  if (counts.total === 0) notes.push({ tone: 'warn', text: 'There are no tasks, so there will be nothing to follow on the board.' });
  if (target === 'session' && session.status === 'ended') {
    notes.push({ tone: 'warn', text: `This session has ended. Resume it in ${agent.name} to build here, or choose somewhere else.` });
  }
  if (target === 'session' && session.waiting) {
    notes.push({
      tone: 'warn',
      text: agent.promptContext
        ? `${agent.name} is waiting on you in chat. Answer it there; the prompt goes with the next message you type.`
        : `${agent.name} is waiting on you in chat. Answer it there before you paste the prompt.`,
    });
  }
  if (target === 'session' && unread.length) {
    notes.push({ tone: 'info', text: `${agent.name} has not read your latest changes (${unread.join(', ')}). The prompt lists them first.` });
  }
  if (open) notes.push({ tone: 'info', text: `${open} open comment${open === 1 ? '' : 's'} go${open === 1 ? 'es' : ''} with the plan.` });
  if (trimmed) {
    notes.push({
      tone: 'info',
      text: `The plan is longer than fits in one message, so the prompt carries the task list and ${agent.name} reads the rest with harness_plan_read.`,
    });
  }
  return (
    <div className="submit-check">
      <p className="submit-summary">
        {plan.diagrams.length} diagram{plan.diagrams.length === 1 ? '' : 's'} · {boxes} box{boxes === 1 ? '' : 'es'} · {counts.total} task
        {counts.total === 1 ? '' : 's'}
        {counts.done ? ` (${counts.done} already done)` : ''}
      </p>
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

/** The prompt as it was submitted, for reading back or copying again. */
function SubmittedPrompt({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const agent = useAgent();
  const submission = plan.submission;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  if (!submission) return null;
  const delivered = submission.deliveredAt
    ? `${agent.name} got it ${relativeTime(submission.deliveredAt)}`
    : submission.target === 'session'
      ? agent.promptContext
        ? `Not delivered yet: it goes with your next message in ${agent.name}`
        : `Not delivered yet: paste it into ${agent.name}'s chat`
      : 'Handed off to build elsewhere';
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-labelledby="submitted-title">
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={onClose} />
      <div className="lightbox-body is-text">
        <header className="item-head">
          <h2 className="section-title" id="submitted-title">
            The submitted prompt
          </h2>
          <span className="muted">
            submitted {relativeTime(submission.at)} · {delivered}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => void copyText(submission.prompt, 'Copied the prompt.')}>
            Copy
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <pre className="claude-text">{submission.prompt}</pre>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * After submitting
 * ------------------------------------------------------------------ */

/**
 * Where the build stands, under the header on every view once the plan is
 * submitted — and, while Claude has not picked it up, how to hand it over.
 */
export function PhaseStrip({ session }: { session: SessionState }) {
  const tab = useStore((s) => s.tab);
  const agent = agentInfo(session.agent);
  const [confirming, setConfirming] = useState(false);
  const plan = session.plan;
  const phase = planPhase(plan);
  if (!plan?.submission || phase === 'planning') return null;
  const submission = plan.submission;
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
          {now.note ? ` — ${now.note}` : ''}
        </>
      ) : blocked.length ? (
        `${blocked.length} task${blocked.length === 1 ? ' is' : 's are'} blocked: ${blocked[0]!.title}${blocked[0]!.note ? ` — ${blocked[0]!.note}` : ''}`
      ) : (
        `${agent.name} has the plan. No task is in progress right now.`
      );
      break;
    case 'built':
      head = 'Built';
      text = `Every task is done (${counts.total}).`;
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
            {submission.deliveredAt ? `Unlock the plan? ${agent.name} keeps building until you tell it otherwise in chat.` : 'Withdraw the submission?'}
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
            {(phase === 'building' || phase === 'built') && tab !== 'tasks' && (
              <button type="button" className="btn btn-sm" onClick={() => store.set({ tab: 'tasks', taskMode: 'board' })}>
                Follow on the board
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
