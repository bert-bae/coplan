import { useEffect, useRef, useState } from 'react';
import { store, useStore, useQuestionGate } from '../store.ts';
import { api } from '../lib/api.ts';
import { Button } from './primitives.tsx';
import { classNames } from '../lib/format.ts';
import { useElapsed } from '../lib/hooks.ts';
import { scrollBehavior } from '../lib/motion.ts';
import { verdictToast } from '../lib/stages.ts';
import type { Gate, GateQuestion } from '../../shared/types.ts';

/**
 * Claude's question, answerable from anywhere in the app.
 *
 * This used to live inside the Activity tab, which meant the composer's "go
 * answer the gate" pointed at a card the user had to hunt for on another
 * screen — the reason a parked session felt un-actionable. It now sits above
 * the tab strip, so the answer is always one click away no matter what is
 * being read underneath it.
 *
 * Two shapes are rendered. A bare list of suggested answers stays a row of
 * one-click buttons, because for most questions that is the whole
 * interaction. Anything the model marked up — option descriptions,
 * multi-select, several questions at once — becomes a form with an explicit
 * submit, since a click can no longer mean "and I'm done".
 */
export function QuestionGate() {
  const gate = useQuestionGate();
  const sessionId = useStore((s) => s.sessionId);
  const focus = useStore((s) => s.gateFocus);
  const root = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(gate?.createdAt);

  // The composer's link and the banner's button both ask for this. Scrolling
  // alone left a keyboard user exactly where they were, staring at a card
  // they had just asked to be taken to — so focus moves with the scroll.
  useEffect(() => {
    if (focus === 0) return;
    root.current?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
    root.current?.focus({ preventScroll: true });
  }, [focus]);

  if (!gate || !sessionId) return null;

  const questions = gate.meta?.questions ?? [];

  return (
    <div className="question-card" ref={root} tabIndex={-1} role="region" aria-label="Question from Claude">
      <h3>
        {gate.waiting ? 'Claude is asking — the session is parked' : 'Claude is asking'}
        <span className="question-elapsed">
          {gate.waiting ? `waiting ${elapsed}` : `asked ${elapsed} ago`}
        </span>
      </h3>
      {questions.length > 0 ? (
        <QuestionForm key={gate.id} gate={gate} questions={questions} sessionId={sessionId} />
      ) : (
        <QuickAnswer key={gate.id} gate={gate} sessionId={sessionId} />
      )}
      {/* The message box below looks like it would do, and does not. */}
      <p className="question-foot">
        Answering here is the only thing that moves this on. A message in the box at the bottom is
        queued behind this question unless you send it with <strong>Send now</strong>.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Simple form: one question, optional one-click answers
 * ------------------------------------------------------------------ */

function QuickAnswer({ gate, sessionId }: { gate: Gate; sessionId: string }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const options = gate.meta?.options ?? [];

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.resolveGate(sessionId, gate.id, { verdict: 'answered', comment: body });
      store.toast('success', verdictToast(gate, 'Answer sent'));
      setAnswer('');
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
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
        aria-label={`Your answer to: ${gate.prompt}`}
        value={answer}
        placeholder={options.length ? 'Or answer in your own words…' : 'Your answer…'}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send(answer);
        }}
      />
      <div className="row-actions">
        <Button variant="primary" onClick={() => void send(answer)} disabled={!answer.trim() || busy}>
          Send answer
        </Button>
        <span className="muted">⌘↵</span>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Structured form: up to four questions, rich options
 * ------------------------------------------------------------------ */

/** Chosen option labels per question id; the free-text box is a pseudo-option. */
type Selection = Record<string, string[]>;

const OTHER = '__other__';

function QuestionForm({
  gate,
  questions,
  sessionId,
}: {
  gate: Gate;
  questions: GateQuestion[];
  sessionId: string;
}) {
  const [picked, setPicked] = useState<Selection>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const answerFor = (q: GateQuestion): string => {
    const labels = (picked[q.id] ?? []).filter((l) => l !== OTHER);
    const free = (picked[q.id] ?? []).includes(OTHER) ? (other[q.id] ?? '').trim() : '';
    return [...labels, free].filter(Boolean).join(', ');
  };

  // Every question needs an answer: a half-filled form handed to Claude is
  // worse than no answer, because it reads as a decision that was made.
  const answers = Object.fromEntries(questions.map((q) => [q.id, answerFor(q)]));
  const complete = questions.every((q) => answers[q.id]);

  const toggle = (q: GateQuestion, label: string) => {
    setPicked((current) => {
      const existing = current[q.id] ?? [];
      if (!q.multiSelect) return { ...current, [q.id]: existing[0] === label ? [] : [label] };
      return {
        ...current,
        [q.id]: existing.includes(label) ? existing.filter((l) => l !== label) : [...existing, label],
      };
    });
  };

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    try {
      await api.resolveGate(sessionId, gate.id, { verdict: 'answered', answers });
      store.toast('success', verdictToast(gate, 'Answers sent'));
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {questions.map((q) => {
        const selected = picked[q.id] ?? [];
        return (
          <fieldset className="qblock" key={q.id}>
            <legend className="qblock-legend">
              {q.header && <span className="qblock-chip">{q.header}</span>}
              <span className="question-text">{q.question}</span>
              {q.multiSelect && <span className="muted"> · pick any</span>}
            </legend>
            <div className="qoptions">
              {q.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={classNames('qoption', selected.includes(option.label) && 'is-selected')}
                  aria-pressed={selected.includes(option.label)}
                  disabled={busy}
                  onClick={() => toggle(q, option.label)}
                >
                  <span className="qoption-mark" aria-hidden="true">
                    {selected.includes(option.label) ? '●' : '○'}
                  </span>
                  <span className="qoption-body">
                    <span className="qoption-label">{option.label}</span>
                    {option.description && <span className="qoption-desc">{option.description}</span>}
                  </span>
                </button>
              ))}
              <button
                type="button"
                className={classNames('qoption', 'is-other', selected.includes(OTHER) && 'is-selected')}
                aria-pressed={selected.includes(OTHER)}
                disabled={busy}
                onClick={() => toggle(q, OTHER)}
              >
                <span className="qoption-mark" aria-hidden="true">
                  {selected.includes(OTHER) ? '●' : '○'}
                </span>
                <span className="qoption-body">
                  <span className="qoption-label">Something else</span>
                </span>
              </button>
            </div>
            {selected.includes(OTHER) && (
              <input
                className="input"
                autoFocus
                value={other[q.id] ?? ''}
                placeholder="Your answer…"
                aria-label={`Your own answer to: ${q.question}`}
                onChange={(e) => setOther((current) => ({ ...current, [q.id]: e.target.value }))}
              />
            )}
          </fieldset>
        );
      })}
      <div className="row-actions">
        <Button variant="primary" onClick={() => void submit()} disabled={!complete || busy}>
          {busy ? 'Sending…' : questions.length > 1 ? 'Send answers' : 'Send answer'}
        </Button>
        {!complete && (
          <span className="muted">
            {questions.length > 1 ? 'Answer every question to send.' : 'Pick an option to send.'}
          </span>
        )}
      </div>
    </>
  );
}
