import { useEffect, useRef, useState } from 'react';
import { store, useAgent, usePlan, useSession, useStore } from '../store.ts';
import { api, type PromptPreview } from '../lib/api.ts';
import { classNames, relativeTime } from '../lib/format.ts';
import { MAX_NOTE, describeTarget, latestRevision, pendingRevision, revisionProgress, revisionStatus, threadsForRevision } from '../../shared/plan.ts';
import type { AgentInfo } from '../../shared/agents.ts';
import type { Plan, RevisionRequest, SessionState, Target } from '../../shared/types.ts';
import { PromptView } from './PromptView.tsx';
import { copyText } from '../lib/copy.ts';

/**
 * Request revisions (#67): the comments waiting on the agent, sent as one
 * explicit ask — act on each, reply in its thread, propose what is the
 * user's to decide, say what changed.
 *
 * Coplan never starts a turn. The request is queued, like a sign-off, and
 * the user's next message in the agent's chat carries it — "go" will do.
 * Where the session has a link, sending it opens the session there; in
 * Cursor, whose hooks cannot add to a message, it is copied to paste.
 */
export function RevisionControl() {
  const session = useSession();
  const plan = usePlan();
  const agent = useAgent();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!session || !plan) return null;
  const waiting = threadsForRevision(plan);
  const pending = pendingRevision(plan);
  const latest = latestRevision(plan);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <span className="revision-control">
      {latest && <RevisionState plan={plan} req={latest} agent={agent} />}
      {pending ? (
        <>
          <button
            type="button"
            className="btn btn-sm"
            title={`Pasting it into ${agent.name} works too; it is not sent twice`}
            onClick={() => void copyText(pending.prompt, `Copied — paste it into ${agent.name}'s chat.`)}
          >
            Copy request
          </button>
          <button type="button" className="link" onClick={() => void store.withdrawRevision()}>
            Withdraw
          </button>
        </>
      ) : (
        waiting.length > 0 && (
          <button
            ref={trigger}
            type="button"
            className="btn btn-sm"
            title={`Send the ${waiting.length} comment${waiting.length === 1 ? '' : 's'} waiting on ${agent.name} as one ask to revise the plan`}
            onClick={() => setOpen(true)}
          >
            Request revisions <span className="badge">{waiting.length}</span>
          </button>
        )
      )}
      {open && <RevisionDialog session={session} plan={plan} onClose={close} />}
    </span>
  );
}

const STATE_WORDS = { pending: 'pending', sent: 'sent', answered: 'answered' } as const;

/** Where the latest request stands: pending until the agent gets it, sent
 *  until every comment it carried has a reply or a proposal, answered. */
function RevisionState({ plan, req, agent }: { plan: Plan; req: RevisionRequest; agent: AgentInfo }) {
  const status = revisionStatus(plan, req);
  const { answered, total } = revisionProgress(plan, req);
  const title =
    status === 'pending'
      ? agent.promptContext
        ? `Queued ${relativeTime(req.at)}: it goes to ${agent.name} with your next message in its chat`
        : `Queued ${relativeTime(req.at)}: paste it into ${agent.name}'s chat, or ask ${agent.name} to read the plan`
      : status === 'sent'
        ? `${agent.name} got it ${relativeTime(req.deliveredAt!)}: ${answered} of ${total} comment${total === 1 ? '' : 's'} answered so far`
        : `Every comment it carried has a reply or a proposal from ${agent.name}`;
  return (
    <span className={classNames('pill', 'revision-state', `is-${status}`)} title={title} data-testid="revision-state">
      Revisions {STATE_WORDS[status]}
      {status === 'sent' && ` · ${answered}/${total}`}
    </span>
  );
}

function RevisionDialog({ session, plan, onClose }: { session: SessionState; plan: Plan; onClose: () => void }) {
  const agent = useAgent();
  const sessionId = useStore((s) => s.sessionId);
  const [note, setNote] = useState('');
  const [shown, setShown] = useState<{ preview: PromptPreview & { threadIds: string[] }; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const version = plan.version;

  useEffect(() => {
    body.current?.focus();
  }, []);
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

  // Rebuilt as the note is typed and as the comments move: what is on
  // screen is what is sent.
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .revisionPreview(sessionId, note)
        .then((preview) => {
          if (!live) return;
          setShown({ preview, note });
          setError(null);
        })
        .catch((err: unknown) => live && setError((err as Error).message));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [sessionId, note, version, refresh]);

  const preview = shown?.preview ?? null;
  const current = Boolean(shown && shown.note === note && shown.preview.version >= version);
  const comments = (preview?.threadIds ?? []).map((id) => plan.threads.find((t) => t.id === id)).filter((t) => t !== undefined);

  const send = async (): Promise<boolean> => {
    if (!preview || !current) return false;
    setBusy(true);
    if (!agent.promptContext) await copyText(preview.prompt, `Copied — paste it into ${agent.name}'s chat.`);
    const ok = await store.queueRevision({ note, expect: preview.version, ...(preview.hash ? { hash: preview.hash } : {}) }, { quiet: !agent.promptContext });
    setBusy(false);
    if (ok) onClose();
    else setRefresh((n) => n + 1);
    return ok;
  };

  const disabled = !current || busy || !comments.length;
  const label = busy ? 'Queuing…' : agent.promptContext ? (session.link ? `Queue and open in ${agent.name}` : 'Queue request') : 'Copy and queue request';
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-labelledby="revise-title">
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={onClose} disabled={busy} />
      <div className="lightbox-body submit" ref={body} tabIndex={-1}>
        <header className="item-head">
          <h2 className="section-title" id="revise-title">
            Request revisions
          </h2>
          <span className="muted">{plan.title}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>
        <div className="submit-grid">
          <div className="submit-side">
            <div className="submit-check">
              <p className="submit-summary">
                {comments.length} comment{comments.length === 1 ? '' : 's'} waiting on {agent.name}
              </p>
              <ul className="submit-notes revision-comments">
                {comments.map((t) => (
                  <li key={t.id} className="is-info">
                    <strong>{describeTarget(plan, t.target)}</strong>: {t.replies.at(-1)?.text ?? t.text}
                  </li>
                ))}
              </ul>
            </div>
            <label className="field">
              <span className="field-label">Anything else for {agent.name}?</span>
              <textarea
                className="input"
                rows={3}
                maxLength={preview?.maxNote ?? MAX_NOTE}
                value={note}
                placeholder="Optional — what matters most, what to leave alone."
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <p className="explain">
              {agent.name} acts on each comment, replies in its thread, proposes what is yours to decide, then says what changed.
              Coplan never starts a turn: {agent.promptContext ? <>the request goes with your next message in {agent.name}'s chat — <q>go</q> will do — once.</> : <>paste it into {agent.name}'s chat, or ask {agent.name} to read the plan, and it gets it once.</>}{' '}
              It shows here as pending, then sent, then answered once every comment has a reply or a proposal.
            </p>
            <div className="submit-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              {agent.promptContext && session.link ? (
                // The link "Answer in …" uses: queued as it opens the session.
                <a
                  className={classNames('btn btn-primary', disabled && 'is-disabled')}
                  href={session.link.app}
                  aria-disabled={disabled}
                  onClick={(e) => {
                    if (disabled) {
                      e.preventDefault();
                      return;
                    }
                    void send();
                  }}
                >
                  {label}
                </a>
              ) : (
                <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void send()}>
                  {label}
                </button>
              )}
            </div>
          </div>
          <section className="submit-preview" aria-label="The request">
            <header className="submit-preview-head">
              <span className="field-label">What {agent.name} will be sent</span>
              {preview && <span className="muted submit-count">{preview.prompt.length.toLocaleString()} characters{!current && ' · updating…'}</span>}
            </header>
            {error ? (
              <p className="error-text" role="alert">
                Could not build the request: {error}
              </p>
            ) : (
              <PromptView
                blocks={preview?.blocks}
                text={preview?.prompt ?? 'Building the request…'}
                className={classNames('submit-prompt', !current && 'is-stale')}
                testId="revision-preview"
                onField={
                  busy
                    ? undefined
                    : (target: Target) => {
                        onClose();
                        store.focusField(target);
                      }
                }
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
