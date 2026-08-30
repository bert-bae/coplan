import { useState } from 'react';
import { store, useOpenGate, useSession, useDrafts } from '../store.ts';
import { api } from '../lib/api.ts';
import { Button } from './primitives.tsx';
import { tabForGate } from '../store.ts';

/**
 * The message box.
 *
 * This used to silently resolve whatever gate was open with a
 * `changes_requested` verdict — so "looks good, go ahead" registered as a
 * rejection and threw away any line comments in progress. It now only ever
 * queues a message, and says plainly where that message goes and when it
 * arrives. Answering a gate is a separate, deliberate act.
 */
export function Composer() {
  const session = useSession();
  const gate = useOpenGate();
  const drafts = useDrafts();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  if (!session) return null;

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await api.feedback(session.sessionId, { text: body, origin: 'timeline' });
      setText('');
      store.toast(
        'success',
        session.status === 'idle'
          ? 'Queued. Claude receives it the next time the session runs.'
          : 'Sent — Claude receives it at the end of this turn.',
      );
    } catch (err) {
      store.fail(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      {gate && (
        <div className="composer-notice">
          <span>
            Claude is waiting at the <strong>{gateLabel(gate.kind)}</strong> gate. A message here does{' '}
            <em>not</em> answer it.
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
          placeholder="Message this session…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send();
          }}
        />
        <div className="composer-side">
          <Button variant="primary" onClick={() => void send()} disabled={!text.trim() || sending}>
            {sending ? 'Sending…' : 'Send message'}
          </Button>
          <span className="composer-hint">{deliveryHint(session.status)}</span>
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

function deliveryHint(status: string): string {
  switch (status) {
    case 'active':
      return '⌘↵ · arrives at the end of this turn';
    case 'waiting':
      return '⌘↵ · queued until the gate is answered';
    case 'ended':
      return 'this session has ended';
    default:
      return '⌘↵ · queued for the next turn';
  }
}

function gateLabel(kind: string): string {
  return kind.replace('_', ' ');
}
