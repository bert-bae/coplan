import { useEffect, useRef, useState } from 'react';
import { store, useSession, useOpenGate, useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import { Button, EmptyState, Explain } from '../components/primitives.tsx';
import { classNames, duration } from '../lib/format.ts';
import type { CheckRun } from '../../shared/types.ts';

/** Verification: run the project's checks and sign off on the result. */
export function VerifyView() {
  const session = useSession();
  const gate = useOpenGate();
  const sessionId = useStore((s) => s.sessionId);
  const [command, setCommand] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  if (!session || !sessionId) return null;

  const failing = session.checks.filter((c) => c.status === 'failed');
  const running = session.checks.some((c) => c.status === 'running');
  const unrun = session.checks.filter((c) => c.status === 'pending');

  const add = async () => {
    const value = command.trim();
    if (!value) return;
    try {
      await api.addCheck(sessionId, value);
      setCommand('');
    } catch (err) {
      store.fail(err);
    }
  };

  const submit = async (verdict: 'approved' | 'changes_requested') => {
    setBusy(true);
    try {
      if (gate) {
        await api.resolveGate(sessionId, gate.id, { verdict, comment: notes.trim() });
        store.toast('success', verdict === 'approved' ? 'Signed off — Claude is resuming.' : 'Sent to Claude.');
      } else {
        await api.feedback(sessionId, { text: notes.trim() || 'Verification notes', origin: 'checks' });
        store.toast('success', "Queued for Claude's next turn.");
      }
      setNotes('');
    } catch (err) {
      store.fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="verify">
      <div className="verify-main">
        <div className="verify-bar">
          <strong>Checks</strong>
          <span className="muted">
            {session.checks.length === 0
              ? 'none configured'
              : failing.length
                ? `${failing.length} failing`
                : running
                  ? 'running…'
                  : unrun.length
                    ? `${unrun.length} not run`
                    : 'all passing'}
          </span>
          <span className="spacer" />
          <Button onClick={() => void api.runChecks(sessionId).catch((e: unknown) => store.fail(e))}>
            Run all
          </Button>
        </div>

        <div className="check-add">
          <input
            className="input"
            value={command}
            placeholder="npm test"
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          />
          <Button variant="ghost" onClick={() => void add()} disabled={!command.trim()}>
            Add check
          </Button>
        </div>

        {session.checks.length === 0 ? (
          <EmptyState
            title="No checks configured"
            hint={
              <>
                Add one above, or set them per repo in <code>.claude/harness.json</code> under{' '}
                <code>stages.verification.checks</code>.
              </>
            }
          />
        ) : (
          session.checks.map((check) => <Check key={check.id} check={check} sessionId={sessionId} />)
        )}
      </div>

      <aside className="verify-side">
        <h3 className="panel-title">Sign-off</h3>
        {failing.length > 0 && (
          <p className="warn-note">
            {failing.length} check{failing.length === 1 ? '' : 's'} failing. Signing off anyway tells Claude to
            move on.
          </p>
        )}
        {gate ? (
          <Explain>Claude is parked here. Your verdict resumes it.</Explain>
        ) : (
          <Explain>No gate is open, so this is queued for Claude's next turn.</Explain>
        )}
        <textarea
          className="input"
          rows={4}
          value={notes}
          placeholder="Testing notes (optional)"
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="row-actions">
          <Button variant="primary" onClick={() => void submit('approved')} disabled={busy}>
            Looks verified
          </Button>
          <Button onClick={() => void submit('changes_requested')} disabled={busy}>
            Not ready
          </Button>
        </div>
      </aside>
    </div>
  );
}

function Check({ check, sessionId }: { check: CheckRun; sessionId: string }) {
  const [open, setOpen] = useState(check.status === 'failed');
  const log = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  // Append-only in practice: only scroll when the user is already at the end.
  useEffect(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [check.output]);

  useEffect(() => {
    if (check.status === 'failed') setOpen(true);
  }, [check.status]);

  const elapsed =
    check.startedAt && check.finishedAt ? duration(check.finishedAt - check.startedAt) : null;

  return (
    <section className={classNames('check', `is-${check.status}`)}>
      <header className="check-head">
        <span className="check-mark">{mark(check.status)}</span>
        <code className="check-cmd">{check.command}</code>
        <span className="spacer" />
        {elapsed && <span className="muted">{elapsed}</span>}
        {check.exitCode !== undefined && check.status === 'failed' && (
          <span className="muted">exit {check.exitCode}</span>
        )}
        {check.status === 'running' ? (
          <button className="link" onClick={() => void api.cancelCheck(sessionId, check.id).catch(() => {})}>
            cancel
          </button>
        ) : (
          <button
            className="link"
            onClick={() => void api.runChecks(sessionId, check.id).catch((e: unknown) => store.fail(e))}
          >
            run
          </button>
        )}
        {check.output && (
          <button className="link" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide output' : 'show output'}
          </button>
        )}
      </header>
      {open && check.output && (
        <pre
          className="check-output"
          ref={log}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {check.output}
        </pre>
      )}
    </section>
  );
}

function mark(status: CheckRun['status']): string {
  return { passed: '✓', failed: '✗', running: '⟳', pending: '○', skipped: '–' }[status] ?? '○';
}
