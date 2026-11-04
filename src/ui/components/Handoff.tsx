import { useEffect, useState } from 'react';
import { store, usePlan, useSession } from '../store.ts';
import { api } from '../lib/api.ts';
import { classNames, relativeTime } from '../lib/format.ts';
import { isLocked, unreadAreas } from '../../shared/plan.ts';
import type { SessionLink, SessionState, WaitingState } from '../../shared/types.ts';

/** What to tell Claude once the plan has been worked over. */
export const HANDOFF_MESSAGE =
  "I've updated the plan in the harness. Read it with harness_plan_read, take my edits and comments into account, and tell me what changes.";

/**
 * The bridge back to Claude.
 *
 * The harness never talks to Claude and never answers for the user. All it
 * can do is say when Claude is behind or waiting, and take the user to the
 * session — in the Claude desktop app when the session can be addressed, and
 * otherwise by putting the words on their clipboard.
 */
export function Handoff() {
  const session = useSession();
  const plan = usePlan();
  const [viewing, setViewing] = useState(false);
  if (!session) return null;
  // No count: one box edited forty times and forty boxes are both "changes",
  // and Claude reads the net result either way. Say where instead.
  const areas = unreadAreas(plan);
  // Once the plan is submitted, the strip under the header says where the
  // build stands; "Claude hasn't read your changes" no longer applies.
  const locked = isLocked(plan);
  const unread = locked ? 0 : areas.length;

  return (
    <div className="handoff">
      {plan &&
        !locked &&
        (unread > 0 ? (
          <span className="handoff-state is-behind" title={`You changed ${areas.join(', ')} since Claude last read the plan`}>
            <span className="dot is-attention" aria-hidden="true" />
            Claude hasn't read your changes
          </span>
        ) : (
          <span className="handoff-state is-current" title={plan.claudeReadAt ? `Read ${new Date(plan.claudeReadAt).toLocaleString()}` : undefined}>
            ✓ Claude is up to date{plan.claudeReadAt ? ` · read ${relativeTime(plan.claudeReadAt)}` : ''}
          </span>
        ))}
      {/* Without a link, the fallback copies "read my changes" — the wrong
          words for a submitted plan; the strip below offers its prompt. */}
      {(!locked || session.link) && <OpenInClaude session={session} primary={unread > 0} />}
      {plan && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setViewing(true)}>
          As Claude sees it
        </button>
      )}
      {viewing && <ClaudeView onClose={() => setViewing(false)} />}
    </div>
  );
}

/**
 * Opens the session in Claude. With no link — a local session without Remote
 * Control — the best the harness can do is the message to type there.
 */
export function OpenInClaude({
  session,
  primary,
  label = 'Open in Claude',
}: {
  session: SessionState;
  primary?: boolean;
  label?: string;
}) {
  if (session.link) return <ClaudeLinks link={session.link} primary={primary} label={label} />;
  return (
    <button
      type="button"
      className={classNames('btn btn-sm', primary && 'btn-primary')}
      title={`${whereItRuns(session)} has no link the harness can open. Copies a message to paste there instead.`}
      onClick={() => void copyHandoff()}
    >
      Copy message for Claude
    </button>
  );
}

function ClaudeLinks({ link, primary, label }: { link: SessionLink; primary?: boolean; label: string }) {
  return (
    <span className="claude-links">
      <a className={classNames('btn btn-sm', primary && 'btn-primary')} href={link.app} title="Open this session in the Claude desktop app">
        {label}
      </a>
      <a className="link claude-web" href={link.web} target="_blank" rel="noreferrer" title="Open this session on claude.ai">
        web
      </a>
    </span>
  );
}

/**
 * Claude is stopped on the user. The question is shown so they know what is
 * being asked, but it is answered in Claude — there is deliberately no way to
 * answer it here.
 */
export function WaitingBanner({ session }: { session: SessionState }) {
  const waiting = session.waiting;
  if (!waiting) return null;
  return (
    <section className={classNames('waiting', `is-${waiting.kind}`)} role="status" aria-label="Claude is waiting on you">
      <div className="waiting-body">
        <p className="waiting-head">
          <span className="dot is-attention" aria-hidden="true" />
          {HEADLINE[waiting.kind]}
          <span className="muted"> · {relativeTime(waiting.since)}</span>
        </p>
        {waiting.questions?.length ? (
          <ol className="waiting-questions">
            {waiting.questions.map((q, i) => (
              <li key={i}>
                {q.header && <span className="qchip">{q.header}</span>} <strong>{q.question}</strong>
                {q.options.length > 0 && (
                  <span className="waiting-options">
                    {q.multiSelect ? 'choose any: ' : 'choose one: '}
                    {q.options.join(' · ')}
                  </span>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="waiting-text">{waiting.text}</p>
        )}
        {!session.link && <p className="waiting-hint">{noLinkHint(session)}</p>}
      </div>
      <OpenInClaude session={session} primary label={waiting.kind === 'permission' ? 'Decide in Claude' : 'Answer in Claude'} />
    </section>
  );
}

const HEADLINE: Record<WaitingState['kind'], string> = {
  question: 'Claude is asking you',
  permission: 'Claude needs your permission',
  input: 'Claude is waiting for your reply',
};

function whereItRuns(session: SessionState): string {
  return session.surface === 'desktop' ? 'This desktop session' : session.surface === 'cli' ? 'This terminal session' : 'This session';
}

function noLinkHint(session: SessionState): string {
  const where = session.surface === 'desktop' ? 'in the Claude desktop app' : session.surface === 'cli' ? 'in your terminal' : 'where the session is running';
  return `Answer it ${where}. Turn on Remote Control there (/remote-control) and this becomes a link that opens the session directly.`;
}

async function copyHandoff(): Promise<void> {
  try {
    await navigator.clipboard.writeText(HANDOFF_MESSAGE);
    store.toast('success', "Copied — paste it into Claude's chat.");
  } catch {
    store.toast('info', `Tell Claude: "${HANDOFF_MESSAGE}"`);
  }
}

/** The plan rendered exactly as `harness_plan_read` returns it. Opening this
 *  does not count as Claude reading it. */
function ClaudeView({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const plan = usePlan();
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let live = true;
    api
      .planText(session.sessionId)
      .then((t) => live && setText(t))
      .catch((err: unknown) => live && setText(`Could not load: ${(err as Error).message}`));
    return () => {
      live = false;
    };
  }, [session?.sessionId, plan?.seq]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="The plan as Claude reads it">
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={onClose} />
      <div className="lightbox-body is-text">
        <header className="item-head">
          <h2 className="section-title">What Claude reads</h2>
          <span className="muted">the output of harness_plan_read</span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <pre className="claude-text">{text ?? 'Loading…'}</pre>
      </div>
    </div>
  );
}
