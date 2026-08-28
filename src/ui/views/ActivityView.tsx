import { useEffect, useRef, useState } from 'react';
import { useSession, useStore, store } from '../store.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Panel, EmptyState } from '../components/primitives.tsx';
import { api } from '../lib/api.ts';
import { Button } from '../components/primitives.tsx';
import { classNames, clockTime, pluralize, relativeTime } from '../lib/format.ts';
import type { Gate, TimelineEvent } from '../../shared/types.ts';

const ICON: Record<string, string> = {
  assistant: '●', thinking: '◦', tool: '›', stage: '▸', note: '·', user: '»',
  feedback: '✎', notification: '!', gate: '⏸', check: '✓', ship: '⇧', error: '✗',
};

/** Progress and the session feed together: what has been done, and what is
 *  happening now. They were separate tabs and were always read together. */
export function ActivityView() {
  const session = useSession();
  const [showThinking, setShowThinking] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const events = (session?.timeline ?? []).filter((e) => showThinking || e.kind !== 'thinking');

  useEffect(() => {
    if (pinned.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [events.length]);

  if (!session) return null;

  const gate = session.gates.find((g) => g.status === 'open' && g.kind === 'question');
  const done = session.todos.filter((t) => t.status === 'completed').length;
  const percent = session.todos.length ? Math.round((done / session.todos.length) * 100) : 0;

  return (
    <div className="activity">
      <div className="activity-main">
        {gate && <QuestionCard gate={gate} sessionId={session.sessionId} />}
        <div className="feed-head">
          <strong>Activity</strong>
          <label className="toggle">
            <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} />
            show reasoning
          </label>
        </div>
        <div
          className="feed"
          ref={feed}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {events.length === 0 ? (
            <EmptyState title="Nothing yet" hint="Claude's output appears here as it works." />
          ) : (
            events.map((event) => <Event key={event.id} event={event} />)
          )}
        </div>
      </div>

      <aside className="activity-side">
        <Panel title="Progress">
          {session.todos.length === 0 ? (
            <p className="muted">No task list yet.</p>
          ) : (
            <>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <p className="progress-label">{done} of {session.todos.length} tasks complete</p>
              <ul className="todo-list">
                {session.todos.map((todo, i) => (
                  <li key={i} className={classNames('todo', `is-${todo.status}`)}>
                    <span className="todo-mark">
                      {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'}
                    </span>
                    <span>{todo.content}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel title={`Files touched · ${session.files.length}`}>
          {session.files.length === 0 ? (
            <p className="muted">Nothing changed yet.</p>
          ) : (
            <ul className="touch-list">
              {[...session.files]
                .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
                .map((file) => (
                  <li key={file.path}>
                    <code title={file.path}>{file.path}</code>
                    <span className="muted">{pluralize(file.edits, 'edit')} · {relativeTime(file.lastTouchedAt)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Commands · ${session.commands.length}`}>
          {session.commands.length === 0 ? (
            <p className="muted">No shell commands yet.</p>
          ) : (
            <ul className="cmd-list">
              {[...session.commands].slice(-25).reverse().map((run) => (
                <li key={run.id} className={run.ok ? 'is-ok' : 'is-failed'}>
                  <code>{run.command}</code>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </aside>
    </div>
  );
}

function Event({ event }: { event: TimelineEvent }) {
  const prose = event.kind === 'assistant' || event.kind === 'user' || event.kind === 'feedback';
  return (
    <article className={classNames('event', `is-${event.kind}`)}>
      <span className="event-icon" title={event.kind}>{ICON[event.kind] ?? '·'}</span>
      <div className="event-body">
        <div className="event-meta">
          {event.label && <span className="event-label">{event.label}</span>}
          <time>{clockTime(event.ts)}</time>
        </div>
        {prose ? <Markdown source={event.text} /> : <pre className="event-text">{event.text}</pre>}
      </div>
    </article>
  );
}

/** Claude asked something. This is the path that used to dead-end in prose. */
function QuestionCard({ gate, sessionId }: { gate: Gate; sessionId: string }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const options = gate.meta?.options ?? [];

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.resolveGate(sessionId, gate.id, { verdict: 'answered', comment: body });
      store.toast('success', 'Answer sent — Claude is resuming.');
      setAnswer('');
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="question-card">
      <h3>Claude is asking</h3>
      <p className="question-text">{gate.prompt}</p>
      {options.length > 0 && (
        <div className="question-options">
          {options.map((option) => (
            <Button key={option} onClick={() => void send(option)} disabled={busy}>
              {option}
            </Button>
          ))}
        </div>
      )}
      <textarea
        className="input"
        rows={3}
        value={answer}
        placeholder="Your answer…"
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send(answer); }}
      />
      <div className="row-actions">
        <Button variant="primary" onClick={() => void send(answer)} disabled={!answer.trim() || busy}>
          Send answer
        </Button>
      </div>
    </div>
  );
}
