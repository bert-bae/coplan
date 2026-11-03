import { useEffect, useState } from 'react';
import { store, usePlan } from '../store.ts';
import { InlineText, MarkdownField } from '../components/Editable.tsx';
import { AuthorBadge, CommentToggle, ThreadPanel } from '../components/Threads.tsx';
import { Focusable } from '../components/Item.tsx';
import { EmptyState } from '../components/primitives.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { classNames, relativeTime } from '../lib/format.ts';
import type { Plan, Question } from '../../shared/types.ts';

type Filter = 'open' | 'answered' | 'all';

/**
 * Open decisions, both ways round.
 *
 * Claude's questions are the ones it needs settled before it can build; the
 * user answers them here, at their own pace, and nothing is sent anywhere —
 * Claude reads the answers when it is next told to read the plan. The user can
 * ask Claude things the same way, and its answers land here too.
 */
export function QuestionsView() {
  const plan = usePlan();
  const [filter, setFilter] = useState<Filter>('open');
  if (!plan) return null;

  const shown = plan.questions.filter((q) => (filter === 'all' ? true : filter === 'open' ? !q.answer : Boolean(q.answer)));
  // Claude's open questions first: they are the ones holding the plan up.
  shown.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  const counts = {
    open: plan.questions.filter((q) => !q.answer).length,
    answered: plan.questions.filter((q) => q.answer).length,
    all: plan.questions.length,
  };

  return (
    <div className="view-pad questions">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Show questions">
          {(['open', 'answered', 'all'] as Filter[]).map((f) => (
            <button key={f} type="button" className={classNames('seg', filter === f && 'is-active')} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'open' ? 'Open' : f === 'answered' ? 'Answered' : 'All'} <span className="seg-count">{counts[f]}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={filter === 'open' ? 'No open questions' : 'Nothing here'}
          hint={filter === 'open' && counts.all ? 'Every question has an answer.' : 'Questions Claude needs settled before it builds appear here.'}
        />
      ) : (
        <div className="question-list">
          {shown.map((q) => (
            <QuestionCard key={q.id} plan={plan} question={q} />
          ))}
        </div>
      )}

      <AskClaude />
    </div>
  );
}

function rank(q: Question): number {
  if (!q.answer && q.askedBy === 'claude') return 0;
  if (!q.answer) return 1;
  return 2;
}

function QuestionCard({ plan, question }: { plan: Plan; question: Question }) {
  const [selected, setSelected] = useState<string[]>(question.answer?.selected ?? []);
  const [text, setText] = useState(question.answer?.text ?? '');
  const [comments, setComments] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const answer = question.answer;
  const task = question.taskId ? plan.tasks.find((t) => t.id === question.taskId) : undefined;
  const target = { kind: 'question' as const, id: question.id };
  const forYou = question.askedBy === 'claude';

  // Follow the saved answer when it changes underneath (e.g. Claude answered).
  useEffect(() => {
    setSelected(question.answer?.selected ?? []);
    setText(question.answer?.text ?? '');
  }, [question.answer?.at]);

  const dirty = (answer?.text ?? '') !== text || (answer?.selected ?? []).join('\u0000') !== selected.join('\u0000');
  const pick = (label: string) => {
    if (question.multiSelect) setSelected((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]));
    else setSelected((cur) => (cur[0] === label ? [] : [label]));
  };
  const save = () => void store.op({ op: 'answer', id: question.id, selected, text });

  return (
    <Focusable kind="question" id={question.id} as="article" className={classNames('question-card', answer ? 'is-answered' : 'is-open', forYou && 'is-for-you')}>
      <header className="item-head">
        {question.header && <span className="qchip">{question.header}</span>}
        <span className="muted">
          {forYou ? 'Claude asks' : 'You asked'} · {relativeTime(question.createdAt)}
        </span>
        {task && (
          <button type="button" className="chip" onClick={() => store.focus('task', task.id)}>
            holds up: {task.title}
          </button>
        )}
        <span className="spacer" />
        <CommentToggle target={target} label={question.question} open={comments} onToggle={() => setComments((v) => !v)} />
        {confirming ? (
          <span className="item-confirm">
            Remove?
            <button type="button" className="link is-danger" onClick={() => void store.op({ op: 'remove', kind: 'question', id: question.id })}>
              Remove
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="icon-btn is-tiny is-danger" aria-label={`Remove question ${question.question}`} onClick={() => setConfirming(true)}>
            ×
          </button>
        )}
      </header>

      <InlineText
        as="h2"
        className="question-text"
        value={question.question}
        label="Question"
        onSave={(q) => store.op({ op: 'upsert_question', id: question.id, question: q })}
      />
      {question.context && <Markdown source={question.context} className="question-context" />}

      {forYou || answer ? (
        <>
          {question.options.length > 0 && (
            <div className="qoptions" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
              {question.options.map((o) => {
                const on = selected.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    role={question.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    className={classNames('qoption', on && 'is-selected')}
                    onClick={() => pick(o.label)}
                  >
                    <span className={classNames('qoption-mark', question.multiSelect && 'is-multi')} aria-hidden="true">
                      {on ? '✓' : ''}
                    </span>
                    <span className="qoption-body">
                      <span className="qoption-label">{o.label}</span>
                      {o.description && <span className="qoption-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <textarea
            className="input"
            rows={2}
            value={text}
            aria-label={`Answer to: ${question.question}`}
            placeholder={question.options.length ? 'Add a note, or answer in your own words…' : 'Your answer…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && dirty) {
                e.preventDefault();
                save();
              }
            }}
          />
          <footer className="question-foot">
            {answer ? (
              <span className="muted">
                <AuthorBadge author={answer.by} /> answered {relativeTime(answer.at)}
              </span>
            ) : (
              <span className="muted">Saved to the plan. Claude reads it when you next ask it to.</span>
            )}
            <span className="spacer" />
            {answer && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void store.op({ op: 'clear_answer', id: question.id })}>
                Reopen
              </button>
            )}
            <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || (!text.trim() && selected.length === 0)} onClick={save}>
              {answer ? 'Update answer' : 'Save answer'}
            </button>
          </footer>
        </>
      ) : (
        <p className="question-waiting">Waiting for Claude. It sees this question the next time you ask it to read the plan.</p>
      )}

      {comments && <ThreadPanel target={target} label={question.question} />}
    </Focusable>
  );
}

function AskClaude() {
  const [question, setQuestion] = useState('');
  const [context, setContext] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn ask-open" onClick={() => setOpen(true)}>
        + Ask Claude a question
      </button>
    );
  }
  return (
    <form
      className="ask"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!question.trim()) return;
        const ok = await store.op({ op: 'upsert_question', question, ...(context.trim() ? { context } : {}) });
        if (ok) {
          setQuestion('');
          setContext('');
          setOpen(false);
        }
      }}
    >
      <h2 className="doc-label">Ask Claude</h2>
      <input className="input" value={question} autoFocus placeholder="What should Claude look into or decide?" aria-label="Question for Claude" onChange={(e) => setQuestion(e.target.value)} />
      <MarkdownField value={context} label="context for the question" placeholder="No context." emptyAction="Add context" rows={3} onSave={setContext} />
      <div className="md-field-foot">
        <span className="muted">Claude answers it here when it next reads the plan.</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!question.trim()}>
          Add question
        </button>
      </div>
    </form>
  );
}
