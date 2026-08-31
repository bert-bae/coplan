import type { ReactNode } from 'react';
import { useSession, useStore, type Tab } from '../store.ts';
import { stageStatus, gateChoices, gateName, currentActivity, type StageStatus } from '../lib/stages.ts';
import { Button } from './primitives.tsx';
import { classNames, relativeTime } from '../lib/format.ts';
import { useElapsed } from '../lib/hooks.ts';
import type { Gate, SessionState } from '../../shared/types.ts';

/**
 * The three pieces of "where am I" that every stage needs, in one file so
 * they stay worded the same everywhere.
 *
 * `StageBar` says what has happened to this stage. `RequiredAction` says what
 * — exhaustively — can be done about it. `Working` says the agent is busy and
 * nothing is expected of the reader.
 */

/* ------------------------------------------------------------------ *
 * "Claude is working"
 * ------------------------------------------------------------------ */

/**
 * The animated marker. A static label saying "working" is indistinguishable
 * from a stale page, which is the specific confusion this is here to remove:
 * if it is moving, the session is alive.
 */
export function WorkingDot({ title }: { title?: string }) {
  return <span className="working-dot" role="presentation" title={title} />;
}

export function WorkingIndicator({ session, verbose = false }: { session: SessionState; verbose?: boolean }) {
  const doing = verbose ? currentActivity(session) : null;
  return (
    <span className="working" role="status">
      <WorkingDot />
      <span className="working-text">
        Claude is working
        {doing && <span className="working-doing"> · {doing}</span>}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Stage state
 * ------------------------------------------------------------------ */

export function StageChip({ status }: { status: StageStatus }) {
  if (!status.label) return null;
  return (
    <span className={classNames('stage-chip', `tone-${status.tone}`, `is-${status.state}`)}>
      {status.state === 'working' && <WorkingDot />}
      {status.label}
    </span>
  );
}

/**
 * The strip at the top of a stage's view.
 *
 * It answers, without being opened, the question the old UI could not: was
 * this approved, was it sent back, and is anything happening about it now.
 */
export function StageBar({ tab, children }: { tab: Tab; children?: ReactNode }) {
  const session = useSession();
  if (!session) return null;
  const status = stageStatus(session, tab);
  if (status.state === 'not_started' && !children) return null;

  return (
    <div className={classNames('stage-bar', `tone-${status.tone}`, `is-${status.state}`)} role="status">
      <StageChip status={status} />
      <span className="stage-bar-detail">{status.detail}</span>
      {status.at && <span className="stage-bar-when">{relativeTime(status.at)}</span>}
      {children && <span className="stage-bar-extra">{children}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The available moves
 * ------------------------------------------------------------------ */

/**
 * The exhaustive set of moves at an open gate — as the buttons themselves.
 *
 * The complaint this answers is that the message box looks like a way forward
 * and is not one. So the fix is to name every way forward there is and say
 * that this is all of them — and to render the claim from the same table the
 * banner reads, with the buttons *inside* the list, so it cannot be a claim
 * the tab then fails to honour.
 */
export function RequiredAction({
  gate,
  onChoose,
  busy = false,
  disabled,
}: {
  gate: Gate;
  /** Called with the `GateChoice` id the user picked. */
  onChoose: (id: string) => void;
  busy?: boolean;
  /** Per-choice veto, for a move that is unavailable right now. */
  disabled?: (id: string) => boolean;
}) {
  const elapsed = useElapsed(gate.createdAt);
  const choices = gateChoices(gate.kind);

  return (
    <div className="required" role="group" aria-label={`Required: ${gateName(gate.kind)} gate`}>
      <p className="required-head">
        <span className="required-mark" aria-hidden="true">
          !
        </span>
        <span>
          <strong>Your decision is required</strong>
          <span className="required-when">{gate.waiting ? ` · parked ${elapsed}` : ` · open ${elapsed}`}</span>
        </span>
      </p>
      <p className="required-lede">
        {gate.waiting
          ? `The session is parked at the ${gateName(gate.kind)} gate. These are the only things that move it on:`
          : `The ${gateName(gate.kind)} gate is open. These are the only things that answer it:`}
      </p>
      <ul className="required-list">
        {choices.map((choice) => (
          <li key={choice.id}>
            <Button
              variant={choice.variant ?? 'default'}
              onClick={() => onChoose(choice.id)}
              disabled={busy || disabled?.(choice.id)}
            >
              {choice.label}
            </Button>
            <span className="required-effect">{choice.effect}</span>
          </li>
        ))}
      </ul>
      <p className="required-foot">
        Nothing else moves this on. A message in the box below is read as a note, not a verdict — unless you
        send it with <strong>Send now</strong>, which closes this gate and hands Claude the message instead.
      </p>
    </div>
  );
}

/** The counterpart, for a stage with no gate open on it. */
export function NoActionNeeded({ tab }: { tab: Tab }) {
  const session = useSession();
  const connection = useStore((s) => s.connection);
  if (!session) return null;
  const status = stageStatus(session, tab);

  return (
    <div className="required is-quiet" role="status">
      <p className="required-head">
        {status.state === 'working' ? (
          <WorkingIndicator session={session} />
        ) : (
          <span>
            <strong>Nothing is required from you here</strong>
          </span>
        )}
      </p>
      <p className="required-lede">
        {status.detail || 'No gate is open on this stage.'}
        {connection !== 'live' && ' · the live connection is down, so this may be out of date'}
      </p>
      <p className="required-foot">
        Anything you send is queued and reaches Claude at the end of its next turn.
      </p>
    </div>
  );
}
