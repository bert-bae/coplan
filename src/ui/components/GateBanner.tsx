import { store, useOpenGate, useSession, useStore, gateHeadline, tabForGate } from '../store.ts';
import { Button } from './primitives.tsx';
import { WorkingIndicator } from './StageStatus.tsx';
import { useElapsed } from '../lib/hooks.ts';
import { gateChoices, gateName, isWorking } from '../lib/stages.ts';

/**
 * The single most important state in the product: Claude has stopped and is
 * waiting on the user.
 *
 * It distinguishes three cases the old UI conflated. `gate.waiting` means a
 * turn is genuinely parked — the terminal is frozen until the user answers.
 * A gate that is open with nothing parked on it means Claude has already gone
 * idle; the answer still matters, but nothing is being held up, and saying
 * otherwise trains the user to ignore the banner. And when there is no gate
 * at all but the session is mid-turn, the banner says so rather than going
 * blank — a blank bar and a dead daemon look identical.
 */
export function GateBanner() {
  const gate = useOpenGate();
  const session = useSession();
  const tab = useStore((s) => s.tab);
  const pending = session?.pendingFeedback ?? [];
  const elapsed = useElapsed(gate?.createdAt);

  if (!gate) {
    if (pending.length > 0) {
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
    // Nothing is being asked of the user. Say which of the two very different
    // reasons that is: the agent is busy, or the agent has stopped.
    if (session && isWorking(session)) {
      return (
        <div className="gate-banner is-working" role="status">
          <span className="gate-copy">
            <WorkingIndicator session={session} verbose />
            <span className="gate-sub">Nothing is waiting on you. This updates as it goes.</span>
          </span>
        </div>
      );
    }
    return null;
  }

  // A question renders its own card directly below, carrying the same
  // headline and timer plus the controls to answer it. Two banners saying the
  // same thing is one banner too many.
  if (gate.kind === 'question') return null;

  const parked = gate.waiting;
  const choices = gateChoices(gate.kind);
  // On the gate's own tab the choices are the buttons a few centimetres
  // below, with what each one does. Repeating the labels here would be noise;
  // everywhere else they are the only hint of what answering involves.
  const elsewhere = tab !== tabForGate(gate);

  return (
    <div className={parked ? 'gate-banner is-blocking' : 'gate-banner is-open'} role="alert" aria-live="assertive">
      <span className="gate-icon" aria-hidden="true">
        {parked ? '⏸' : '◷'}
      </span>
      <div className="gate-copy">
        <strong>{gateHeadline(gate)}</strong>
        <span className="gate-sub">
          {parked ? (
            <>The terminal session is parked and will not continue until you answer · waiting {elapsed}</>
          ) : (
            <>
              Claude has gone idle with this open · opened {elapsed} ago. Your answer is still delivered when it
              next runs.
            </>
          )}
        </span>
        {/* The list is the point: it is short, and it is complete. */}
        {elsewhere && (
          <span className="gate-choices">
            Only these move it on:{' '}
            {choices.map((choice, i) => (
              <span key={choice.label}>
                {i > 0 && ' · '}
                <strong>{choice.label}</strong>
              </span>
            ))}
          </span>
        )}
      </div>
      {elsewhere ? (
        <Button variant="primary" onClick={() => store.setTab(tabForGate(gate))}>
          Answer in {gateName(gate.kind)}
        </Button>
      ) : (
        <span className="gate-here">↓ answer below</span>
      )}
    </div>
  );
}
