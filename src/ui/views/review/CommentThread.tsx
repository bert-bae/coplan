import { useState } from 'react';
import { store, useStore } from '../../store.ts';
import { api } from '../../lib/api.ts';
import { Button } from '../../components/primitives.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import { classNames, lineRef, relativeTime } from '../../lib/format.ts';
import type { ReviewThread as Thread } from '../../../shared/types.ts';

/**
 * A comment anchored to a line range.
 *
 * Draft and sent are visually distinct on purpose: "has Claude seen this yet"
 * is the highest-stakes distinction in the review, and a border-colour swap
 * was not enough to carry it.
 */
export function CommentThread({ thread }: { thread: Thread }) {
  const isDraft = !thread.deliveredAt;
  const sessionId = useStore((s) => s.sessionId);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(thread.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');

  const sendReply = async () => {
    const text = reply.trim();
    if (!text || !sessionId) return;
    try {
      await api.replyToThread(sessionId, thread.id, text);
      setReply('');
      setReplying(false);
      store.toast('success', 'Reply queued for Claude.');
    } catch (err) {
      store.fail(err);
    }
  };

  const toggleResolved = async () => {
    if (!sessionId) return;
    try {
      await api.resolveThread(sessionId, thread.id, !thread.resolved);
    } catch (err) {
      store.fail(err);
    }
  };

  const save = () => {
    const next = body.trim();
    if (!next) return;
    store.updateDraft(thread.id, next);
    setEditing(false);
  };

  return (
    <div className={classNames('dthread', isDraft ? 'is-draft' : 'is-sent', thread.resolved && 'is-resolved')}>
      <article className="dthread-card">
        <header className="dthread-head">
          <span className="dthread-ref">{lineRef(thread.file, thread.startLine, thread.endLine)}</span>
          {isDraft ? (
            <span className="pill is-draft">Not sent yet</span>
          ) : (
            <span className="pill is-sent" title={new Date(thread.deliveredAt!).toLocaleString()}>
              Sent {relativeTime(thread.deliveredAt!)}
            </span>
          )}
          {thread.resolved && <span className="pill is-resolved">Addressed in a later revision</span>}
          <span className="spacer" />
          {isDraft && !editing && (
            <>
              <button type="button" className="link" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="link is-danger" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            </>
          )}
          {!isDraft && (
            <>
              <button type="button" className="link" onClick={() => setReplying((v) => !v)}>
                Reply
              </button>
              <button type="button" className="link" onClick={() => void toggleResolved()}>
                {thread.resolved ? 'Reopen' : 'Resolve'}
              </button>
            </>
          )}
        </header>

        {editing ? (
          <div className="dthread-edit">
            <textarea
              className="input"
              rows={3}
              value={body}
              autoFocus
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
                if (e.key === 'Escape') {
                  setBody(thread.body);
                  setEditing(false);
                }
              }}
            />
            <div className="row-actions">
              <Button size="sm" variant="primary" onClick={save} disabled={!body.trim()}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBody(thread.body);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Markdown source={thread.body} className="dthread-body" />
        )}

        {(thread.replies?.length ?? 0) > 0 && (
          <ul className="dthread-replies">
            {thread.replies!.map((r) => (
              <li key={r.id} className={classNames('dthread-reply', `is-${r.author}`)}>
                <span className="dthread-author">{r.author === 'claude' ? 'Claude' : 'You'}</span>
                <Markdown source={r.text} className="dthread-reply-body" />
              </li>
            ))}
          </ul>
        )}

        {replying && (
          <div className="dthread-edit">
            <textarea
              className="input"
              rows={2}
              value={reply}
              autoFocus
              placeholder="Reply to this thread…"
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void sendReply();
                if (e.key === 'Escape') setReplying(false);
              }}
            />
            <div className="row-actions">
              <Button size="sm" variant="primary" onClick={() => void sendReply()} disabled={!reply.trim()}>
                Send reply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {confirmingDelete && (
          <div className="dthread-confirm">
            <span>Delete this comment? It has not been sent.</span>
            <Button size="sm" variant="danger" onClick={() => store.removeDraft(thread.id)}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Keep
            </Button>
          </div>
        )}
      </article>
    </div>
  );
}
