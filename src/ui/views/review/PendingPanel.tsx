import { useMemo, useState } from 'react';
import { store, useDrafts, useStore } from '../../store.ts';
import { api } from '../../lib/api.ts';
import { Button } from '../../components/primitives.tsx';
import { lineRef, pluralize } from '../../lib/format.ts';
import { Reconciliation } from './Reconciliation.tsx';
import type { Gate, ReviewThread } from '../../../shared/types.ts';

/**
 * Everything the user has written but not sent, in one place.
 *
 * Previously the only trace of a pending comment was a bubble inside whichever
 * file happened to be open and a bare count at the bottom of the page — so
 * four comments across three files could not be seen, edited or removed
 * without hunting for each one.
 */
export function PendingPanel({
  gate,
  onJump,
  onClose,
}: {
  gate: Gate | null;
  onJump: (thread: ReviewThread) => void;
  onClose: () => void;
}) {
  const drafts = useDrafts();
  const sessionId = useStore((s) => s.sessionId);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<null | 'approved' | 'changes_requested'>(null);

  const grouped = useMemo(() => groupByFile(drafts), [drafts]);

  const submit = async (verdict: 'approved' | 'changes_requested') => {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      if (gate) {
        await api.resolveGate(sessionId, gate.id, {
          verdict,
          comment: summary.trim(),
          threads: drafts,
        });
        store.toast(
          'success',
          verdict === 'approved'
            ? `Approved${drafts.length ? ` with ${pluralize(drafts.length, 'comment')}` : ''} — Claude is resuming.`
            : `Sent ${pluralize(drafts.length, 'comment')} — Claude is resuming.`,
        );
      } else {
        await api.feedback(sessionId, {
          text: summary.trim() || (verdict === 'approved' ? 'Looks good.' : 'Please address these comments.'),
          origin: 'diff',
          threads: drafts,
        });
        store.toast('success', `Queued ${pluralize(drafts.length, 'comment')} for Claude's next turn.`);
      }
      store.clearDrafts();
      setSummary('');
      setConfirming(null);
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };

  const request = (verdict: 'approved' | 'changes_requested') => {
    // Approving while comments are pending is almost always a mistake — they
    // do get sent, but the user probably meant to request changes.
    if (verdict === 'approved' && drafts.length > 0) setConfirming('approved');
    else void submit(verdict);
  };

  return (
    <aside className="pending" aria-label="Your review">
      <header className="pending-head">
        <strong>Your review</strong>
        <span className="muted">
          {drafts.length === 0 ? 'no comments yet' : pluralize(drafts.length, 'comment')}
        </span>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={onClose} title="Hide this panel">
          ›
        </button>
      </header>

      <div className="pending-body">
        <Reconciliation />
        {drafts.length === 0 ? (
          <p className="pending-empty">
            Click a line in the diff to comment on it. Comments collect here and are sent together when you
            submit.
          </p>
        ) : (
          grouped.map(([file, threads]) => (
            <div className="pending-group" key={file}>
              <div className="pending-file" title={file}>
                {file}
              </div>
              {threads.map((thread) => (
                <div className="pending-item" key={thread.id}>
                  <button type="button" className="pending-jump" onClick={() => onJump(thread)}>
                    <span className="pending-ref">
                      L{thread.startLine}
                      {thread.endLine !== thread.startLine ? `–${thread.endLine}` : ''}
                    </span>
                    <span className="pending-body-text">{thread.body}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn is-danger"
                    title="Remove this comment"
                    onClick={() => store.removeDraft(thread.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <footer className="pending-foot">
        {gate ? (
          <p className="explain">
            Submitting resumes the parked session. Claude receives your summary and every comment above, each
            with the lines you selected.
          </p>
        ) : (
          <p className="explain">
            No gate is open, so this is queued and reaches Claude at the end of its next turn.
          </p>
        )}
        <textarea
          className="input"
          rows={2}
          value={summary}
          placeholder="Summary for Claude (optional)"
          onChange={(e) => setSummary(e.target.value)}
        />
        {confirming === 'approved' ? (
          <div className="pending-confirm">
            <span>
              Approve with {pluralize(drafts.length, 'unsent comment')}? They will be sent, but approving tells
              Claude to move on.
            </span>
            <div className="row-actions">
              <Button size="sm" variant="primary" onClick={() => void submit('approved')} disabled={busy}>
                Approve anyway
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="pending-actions">
            <Button onClick={() => request('changes_requested')} disabled={busy}>
              {busy ? 'Sending…' : 'Request changes'}
            </Button>
            <Button variant="primary" onClick={() => request('approved')} disabled={busy}>
              Approve
            </Button>
          </div>
        )}
      </footer>
    </aside>
  );
}

function groupByFile(threads: ReviewThread[]): [string, ReviewThread[]][] {
  const map = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    const bucket = map.get(thread.file);
    if (bucket) bucket.push(thread);
    else map.set(thread.file, [thread]);
  }
  for (const bucket of map.values()) bucket.sort((a, b) => a.startLine - b.startLine);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}
