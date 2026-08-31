import { useState } from 'react';
import { store, useOpenGate, useSession, useDrafts } from '../store.ts';
import { api } from '../lib/api.ts';
import { Button } from './primitives.tsx';
import { tabForGate } from '../store.ts';
import { gateName } from '../lib/stages.ts';
import type { SessionState } from '../../shared/types.ts';

/**
 * The message box.
 *
 * This used to silently resolve whatever gate was open with a
 * `changes_requested` verdict — so "looks good, go ahead" registered as a
 * rejection and threw away any line comments in progress. It now only ever
 * queues a message, and says plainly where that message goes and when it
 * arrives. Answering a gate is a separate, deliberate act.
 *
 * The one thing it *can* do to a gate is drop it. A queued message parked
 * behind an open gate can wait the full nine-minute hold before Claude sees
 * it, which is exactly backwards when the reason for typing was "stop, do
 * this instead" — so "Send now" closes the gate and wakes the session on the
 * message. It is a separate button, never the default, and it says what it
 * costs.
 */
export function Composer() {
  const session = useSession();
  const gate = useOpenGate();
  const drafts = useDrafts();
  const [text, setText] = useState('');
  const [sending, setSending] = useState<null | 'queue' | 'now'>(null);

  if (!session) return null;

  const send = async (interrupt: boolean) => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(interrupt ? 'now' : 'queue');
    try {
      const result = await api.feedback(session.sessionId, {
        text: body,
        origin: 'timeline',
        ...(interrupt ? { interrupt: true } : {}),
      });
      setText('');
      store.toast('success', deliveryToast(session, result.delivery, result.skippedGate));
    } catch (err) {
      store.fail(err);
    } finally {
      setSending(null);
    }
  };

  const busy = sending !== null;

  return (
    <div className="composer">
      {gate && (
        <div className="composer-notice">
          <span>
            Claude is waiting at the <strong>{gateName(gate.kind)}</strong> gate. A message here does{' '}
            <em>not</em> answer it — use <strong>Send now</strong> to drop the gate and send anyway.
          </span>
          <button
            type="button"
            className="link"
            onClick={() => {
              // A question is answered in place, above the tabs; every other
              // gate is answered in its own tab.
              if (gate.kind === 'question') store.focusGate();
              else store.setTab(tabForGate(gate));
            }}
          >
            {gate.kind === 'question' ? 'Answer it above →' : 'Go answer the gate →'}
          </button>
        </div>
      )}
      <div className="composer-row">
        <textarea
          className="composer-input"
          rows={2}
          value={text}
          placeholder={gate ? 'Message this session (does not answer the gate)…' : 'Message this session…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send(false);
          }}
        />
        <div className="composer-side">
          <div className="row-actions">
            <Button variant="primary" onClick={() => void send(false)} disabled={!text.trim() || busy}>
              {sending === 'queue' ? 'Sending…' : gate ? 'Queue message' : 'Send message'}
            </Button>
            {/* Only offered when there is something to skip past. */}
            {gate && (
              <Button
                onClick={() => void send(true)}
                disabled={!text.trim() || busy}
                title={
                  gate.waiting
                    ? `Close the ${gateName(gate.kind)} gate and hand Claude this message straight away`
                    : `Close the ${gateName(gate.kind)} gate. Nothing is parked on it, so the message waits for the next turn`
                }
              >
                {sending === 'now' ? 'Sending…' : 'Send now'}
              </Button>
            )}
          </div>
          <span className="composer-hint">{deliveryHint(session.status, Boolean(gate))}</span>
        </div>
      </div>
      {drafts.length > 0 && (
        <p className="composer-warn">
          You have {drafts.length} unsent line comment{drafts.length === 1 ? '' : 's'}. A message here does not
          include them — submit your review to send those.
        </p>
      )}
    </div>
  );
}

function deliveryToast(session: SessionState, delivery: string, skipped?: string): string {
  const which = skipped ? `${skipped.replace('_', ' ')} gate` : 'gate';
  if (delivery === 'interrupted') {
    return `Sent — the ${which} was closed and Claude has your message.`;
  }
  // A gate can be closed with nothing parked on it: the demand for a verdict
  // goes away, but there is no turn to wake.
  if (skipped) {
    return `The ${which} was closed. Nothing was running, so your message waits for the next turn.`;
  }
  return session.status === 'idle'
    ? 'Queued. Claude receives it the next time the session runs.'
    : 'Queued — Claude receives it at the end of this turn.';
}

function deliveryHint(status: string, gated: boolean): string {
  if (gated) return '⌘↵ queues · Send now skips the gate';
  switch (status) {
    case 'active':
      return '⌘↵ · arrives at the end of this turn';
    case 'waiting':
      return '⌘↵ · queued until the session next runs';
    case 'ended':
      return 'this session has ended';
    default:
      return '⌘↵ · queued for the next turn';
  }
}
