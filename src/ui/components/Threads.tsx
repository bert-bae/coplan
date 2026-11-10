import { useRef, useState } from 'react';
import { useAgent, useEdit, usePlan, useSessionId } from '../store.ts';
import { draftKey, openDrafts } from '../lib/drafts.ts';
import { Markdown } from './Markdown.tsx';
import { isComposing } from '../lib/keys.ts';
import { classNames, relativeTime } from '../lib/format.ts';
import { threadWaitsOn } from '../../shared/plan.ts';
import type { Author, Target, Thread } from '../../shared/types.ts';

/**
 * Comments, anchored to one item of the plan.
 *
 * A comment is a note on the plan, not a message to Claude: it sits here
 * until the user tells Claude (in chat) to read the plan — or sends the
 * comments waiting on it as one ask with *Request revisions*, which their
 * next message in chat carries (Revisions.tsx) — at which point Claude
 * sees it, acts on it, and replies in the thread.
 */

export function useThreads(target: Target): Thread[] {
  const plan = usePlan();
  return (plan?.threads ?? []).filter((t) => t.target.kind === target.kind && t.target.id === target.id);
}

/** The speech-bubble toggle that sits in an item's header. */
export function CommentToggle({
  target,
  open,
  onToggle,
  label,
}: {
  target: Target;
  open: boolean;
  onToggle: () => void;
  label: string;
}) {
  const threads = useThreads(target);
  const unresolved = threads.filter((t) => !t.resolved).length;
  const waiting = threads.some((t) => threadWaitsOn(t) === 'user');
  return (
    <button
      type="button"
      className={classNames('comment-toggle', open && 'is-active', unresolved > 0 && 'has-comments', waiting && 'has-reply')}
      aria-expanded={open}
      title={unresolved ? `${unresolved} open comment(s)` : 'Comment'}
      aria-label={unresolved ? `${unresolved} open comment(s) on ${label}` : `Comment on ${label}`}
      onClick={onToggle}
    >
      <span aria-hidden="true">💬</span>
      {unresolved > 0 && <span className="comment-count">{unresolved}</span>}
    </button>
  );
}

export function ThreadPanel({ target, label }: { target: Target; label: string }) {
  const edit = useEdit();
  const threads = useThreads(target);
  const [showResolved, setShowResolved] = useState(false);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  return (
    <div className="threads" aria-label={`Comments on ${label}`}>
      {open.map((t) => (
        <ThreadView key={t.id} thread={t} />
      ))}
      {resolved.length > 0 && (
        <button type="button" className="link threads-resolved" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
        </button>
      )}
      {showResolved && resolved.map((t) => <ThreadView key={t.id} thread={t} />)}
      <Composer
        field={`comment:${target.kind}:${target.id}`}
        placeholder={open.length ? 'Add another comment…' : `Comment on ${label}…`}
        label={`New comment on ${label}`}
        onSend={(text) => edit({ op: 'comment', target, text })}
      />
    </div>
  );
}

function ThreadView({ thread }: { thread: Thread }) {
  const edit = useEdit();
  const agent = useAgent();
  const field = `reply:${thread.id}`;
  const key = draftKey(useSessionId(), field);
  // A reply left half written (its view went) opens again with it.
  const [replying, setReplying] = useState(() => openDrafts.has(key));
  return (
    <article className={classNames('thread', thread.resolved && 'is-resolved')}>
      <Entry author={thread.author} text={thread.text} ts={thread.ts} />
      {thread.replies.map((r) => (
        <Entry key={r.id} author={r.author} text={r.text} ts={r.ts} reply />
      ))}
      <div className="thread-actions">
        {!thread.resolved && (
          // Opens it: Cancel or Escape closes it, and drops what was written.
          <button type="button" className="link" onClick={() => setReplying(true)}>
            Reply
          </button>
        )}
        <button type="button" className="link" onClick={() => void edit({ op: 'resolve', threadId: thread.id, resolved: !thread.resolved })}>
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
        {threadWaitsOn(thread) === 'claude' && <span className="muted">{agent.name} sees this when it next reads the plan, or with <em>Request revisions</em></span>}
      </div>
      {replying && (
        <Composer
          field={field}
          placeholder="Reply…"
          label="Reply"
          autoFocus
          onSend={async (text) => {
            const ok = await edit({ op: 'reply', threadId: thread.id, text });
            if (ok) setReplying(false);
            return ok;
          }}
          onCancel={() => setReplying(false)}
        />
      )}
    </article>
  );
}

function Entry({ author, text, ts, reply }: { author: Author; text: string; ts: number; reply?: boolean }) {
  return (
    <div className={classNames('thread-entry', reply && 'is-reply', `by-${author}`)}>
      <div className="thread-meta">
        <AuthorBadge author={author} />
        <span className="muted">{relativeTime(ts)}</span>
      </div>
      <Markdown source={text} />
    </div>
  );
}

export function AuthorBadge({ author }: { author: Author }) {
  const agent = useAgent();
  return <span className={classNames('author', `is-${author}`)}>{author === 'user' ? 'You' : agent.name}</span>;
}

function Composer({
  field,
  placeholder,
  label,
  onSend,
  autoFocus,
  onCancel,
}: {
  /** Names it among the kept drafts (drafts.ts): `comment:…` or `reply:…`. */
  field: string;
  placeholder: string;
  label: string;
  onSend: (text: string) => Promise<boolean>;
  autoFocus?: boolean;
  onCancel?: () => void;
}) {
  const [text, setText] = useKeptText(field);
  const latest = useRef(text);
  latest.current = text;
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onSend(value);
    setBusy(false);
    // Sent: cleared, unless more was typed while it went.
    if (ok && latest.current.trim() === value) setText('');
  };
  const cancel = onCancel && (() => {
    setText('');
    onCancel();
  });
  return (
    <div className="thread-composer">
      <textarea
        className="input"
        rows={text.includes('\n') ? 4 : 2}
        value={text}
        placeholder={placeholder}
        aria-label={label}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opened on request
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape' && cancel) {
            e.stopPropagation();
            cancel();
          }
        }}
      />
      <div className="thread-composer-foot">
        <span className="muted">⌘/Ctrl+Enter</span>
        <span className="spacer" />
        {cancel && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={!text.trim() || busy} onClick={() => void send()}>
          Comment
        </button>
      </div>
    </div>
  );
}

/**
 * Text being written that is saved only when sent, kept among the open
 * drafts while it holds any, so it outlives its view and closing the page
 * asks first. It is the session's on screen: another session, another text.
 */
function useKeptText(field: string): [string, (next: string) => void] {
  const key = draftKey(useSessionId(), field);
  const [held, setHeld] = useState(() => ({ key, text: openDrafts.get(key)?.draft ?? '' }));
  if (held.key !== key) setHeld({ key, text: openDrafts.get(key)?.draft ?? '' });
  const set = (next: string) => {
    setHeld({ key, text: next });
    if (next.trim()) openDrafts.set(key, { draft: next, version: undefined, value: '' });
    else openDrafts.delete(key);
  };
  return [held.key === key ? held.text : (openDrafts.get(key)?.draft ?? ''), set];
}
