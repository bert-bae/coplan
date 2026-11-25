import { useState } from 'react';
import { store, useAgent, useEdit, usePlan, useSessionId } from '../store.ts';
import { Markdown } from './Markdown.tsx';
import { isLocked, pendingRevision, threadWaitsOn } from '../../shared/plan.ts';
import type { Thread } from '../../shared/types.ts';

/**
 * The questions the agent cannot settle itself, at the top of the Overview.
 * An answer is a reply in the decision's thread; sending them is the same
 * ask as "Request revisions", so the agent re-plans from the answers.
 */
export function Decisions() {
  const plan = usePlan();
  const agent = useAgent();
  const sessionId = useSessionId();
  const open = plan?.threads.filter((t) => t.decision && !t.resolved) ?? [];
  if (!plan || isLocked(plan) || !open.length) return null;
  const answered = open.filter((t) => threadWaitsOn(t) === 'claude').length;
  const queued = pendingRevision(plan);
  return (
    <section className="doc-block decisions" aria-labelledby="decisions-head">
      <div className="pflow-head">
        <h2 id="decisions-head" className="doc-label">
          Open decisions <span className="muted">· {answered}/{open.length} answered</span>
        </h2>
        <span className="spacer" />
        {queued ? (
          <span className="muted">Queued: it goes with your next message to {agent.name}</span>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!answered}
            onClick={() => void store.queueRevision({ sessionId, agent }, { note: '', expect: plan.version })}
          >
            Send answers to {agent.name}
          </button>
        )}
      </div>
      <p className="ov-lead">{agent.name} will not decide these for you. Answer them, then send: the architecture and tasks are revised from your answers.</p>
      {open.map((t) => (
        <Decision key={t.id} thread={t} />
      ))}
    </section>
  );
}

function Decision({ thread }: { thread: Thread }) {
  const edit = useEdit();
  const [text, setText] = useState('');
  const answer = (value: string) => edit({ op: 'reply', threadId: thread.id, text: value });
  const last = thread.replies.at(-1);
  // Answered while the user has the last word: shown as a tag in place of the composer.
  const mine = last?.author === 'user' ? last.text : undefined;
  const revert = async (editIt: boolean) => {
    if (await edit({ op: 'unreply', threadId: thread.id }) && editIt && mine) setText(mine);
  };
  return (
    <article className="thread">
      <Markdown source={thread.text} />
      {thread.replies.slice(0, mine === undefined ? undefined : -1).map((r) => (
        <p key={r.id} className="muted">
          {r.author === 'user' ? 'You' : 'Agent'}: {r.text}
        </p>
      ))}
      {mine !== undefined ? (
        <div className="thread-actions">
          <span className="chip is-you decision-tag" data-testid="decision-tag">
            <span aria-hidden="true">✓</span> {mine}
            <button type="button" className="link" aria-label="Edit answer" onClick={() => void revert(true)}>
              Edit
            </button>
            <button type="button" className="icon-btn" aria-label="Remove answer" onClick={() => void revert(false)}>
              ×
            </button>
          </span>
        </div>
      ) : (
        <>
          {!!thread.decision?.options.length && (
            <div className="thread-actions">
              {thread.decision.options.map((o) => (
                <button key={o} type="button" className="btn btn-sm" onClick={() => void answer(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="thread-composer">
            <textarea
              className="input"
              rows={2}
              value={text}
              aria-label="Your answer"
              placeholder={thread.decision?.options.length ? 'Or answer in your own words…' : 'Your answer…'}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!text.trim()}
              onClick={async () => {
                if (await answer(text.trim())) setText('');
              }}
            >
              Answer
            </button>
          </div>
        </>
      )}
    </article>
  );
}
