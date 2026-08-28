import { useEffect, useState } from 'react';
import { store, useOpenGate, useSession, gateHeadline, tabForGate } from '../store.ts';
import { Button } from './primitives.tsx';
import { duration } from '../lib/format.ts';

/**
 * The single most important state in the product: Claude has stopped and is
 * waiting on the user.
 *
 * It distinguishes two cases the old UI conflated. `gate.waiting` means a
 * turn is genuinely parked — the terminal is frozen until the user answers.
 * A gate that is open with nothing parked on it means Claude has already gone
 * idle; the answer still matters, but nothing is being held up, and saying
 * otherwise trains the user to ignore the banner.
 */
export function GateBanner() {
  const gate = useOpenGate();
  const session = useSession();
  const pending = session?.pendingFeedback ?? [];
  const elapsed = useElapsed(gate?.createdAt);

  if (!gate) {
    if (pending.length === 0) return null;
    return (
      <div className="gate-banner is-queued" role="status">
        <span className="gate-icon" aria-hidden="true">
          ✉
        </span>
        <div className="gate-copy">
          <strong>
            {pending.length} message{pending.length === 1 ? '' : 's'} queued
          </strong>
          <span className="gate-sub">
            {session?.status === 'idle'
              ? 'Claude has finished its turn. These reach it when the session next runs — prompt it in the terminal, or wait for its next turn.'
              : 'Delivered at the end of the turn Claude is running now.'}
          </span>
        </div>
      </div>
    );
  }

  const parked = gate.waiting;

  return (
    <div className={parked ? 'gate-banner is-blocking' : 'gate-banner is-open'} role="alert" aria-live="assertive">
      <span className="gate-icon" aria-hidden="true">
        {parked ? '⏸' : '◷'}
      </span>
      <div className="gate-copy">
        <strong>{gateHeadline(gate)}</strong>
        <span className="gate-sub">
          {parked ? (
            <>
              The terminal session is parked and will not continue until you answer · waiting {elapsed}
            </>
          ) : (
            <>
              Claude has gone idle with this open · opened {elapsed} ago. Your answer is still delivered when it
              next runs.
            </>
          )}
        </span>
      </div>
      <Button variant="primary" onClick={() => store.setTab(tabForGate(gate))}>
        Answer
      </Button>
    </div>
  );
}

/** Counts up, so a parked session visibly costs the user time. */
function useElapsed(since?: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  if (!since) return '';
  return duration(now - since);
}
