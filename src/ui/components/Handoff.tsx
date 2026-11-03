import { useEffect, useState } from 'react';
import { store, usePlan, useSession } from '../store.ts';
import { api } from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import { unreadByClaude } from '../../shared/plan.ts';

/** What to paste into Claude's chat once the plan has been worked over. */
export const HANDOFF_MESSAGE =
  "I've updated the plan in the harness. Read it with harness_plan_read, take my edits, answers and comments into account, and tell me what changes.";

/**
 * The bridge back to the conversation.
 *
 * The harness never talks to Claude — that happens in Claude's own chat. What
 * the reader needs here is to know whether Claude is behind, and a quick way
 * to say "go and read it" over there.
 */
export function Handoff() {
  const plan = usePlan();
  const [viewing, setViewing] = useState(false);
  if (!plan) return null;
  const unread = unreadByClaude(plan).length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(HANDOFF_MESSAGE);
      store.toast('success', "Copied — paste it into Claude's chat.");
    } catch {
      store.toast('info', `Tell Claude: "${HANDOFF_MESSAGE}"`);
    }
  };

  return (
    <div className="handoff">
      {unread > 0 ? (
        <>
          <span className="handoff-state is-behind" title="Changes you made that Claude has not read yet">
            <span className="dot is-attention" aria-hidden="true" />
            {unread} change{unread === 1 ? '' : 's'} Claude hasn't read
          </span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void copy()} title={HANDOFF_MESSAGE}>
            Copy message for Claude
          </button>
        </>
      ) : (
        <span className="handoff-state is-current" title={plan.claudeReadAt ? `Read ${new Date(plan.claudeReadAt).toLocaleString()}` : undefined}>
          ✓ Claude is up to date{plan.claudeReadAt ? ` · read ${relativeTime(plan.claudeReadAt)}` : ''}
        </span>
      )}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setViewing(true)}>
        As Claude sees it
      </button>
      {viewing && <ClaudeView onClose={() => setViewing(false)} />}
    </div>
  );
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
