import type { SessionStore } from './store.ts';
import type { FeedbackItem, Gate, GateResult, ReviewThread } from '../shared/types.ts';

/**
 * Long-poll primitives.
 *
 * There is no way to wake a stopped Claude Code session from outside — no
 * socket, no IPC, no CLI verb — so a verdict can only resume a turn while the
 * `Stop` hook that would end that turn is still running. {@link waitAtGate}
 * is that window, and it is what makes answering in the browser move the
 * session on by itself. It is bounded and never renews: on expiry the turn
 * ends for good and the verdict rides the user's next message instead.
 *
 * {@link waitForGate} sits behind the `harness_await` escape hatch and
 * {@link waitForFeedback} behind the opt-in `holdIdleSessions`.
 *
 * Every wait is bounded — the hook's own timeout is a hard wall clock, so a
 * call that never returned would be killed rather than resumed. Returning
 * `null` on expiry lets the caller decide what to do.
 */

export interface WaitOptions {
  timeoutMs: number;
  /** Resolves early when the HTTP client hangs up. */
  signal?: AbortSignal;
}

export function waitForGate(
  store: SessionStore,
  sessionId: string,
  gateId: string,
  opts: WaitOptions,
): Promise<GateResult | null> {
  const existing = store.getGate(sessionId, gateId);
  if (existing && existing.status !== 'open') {
    return Promise.resolve(existing.result ?? null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: GateResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      store.off('gate:resolved', onResolved);
      store.off('gate:cancelled', onCancelled);
      opts.signal?.removeEventListener('abort', onAbort);
      store.setGateWaiting(sessionId, gateId, false);
      resolve(value);
    };

    const onResolved = (payload: { sessionId: string; gate: Gate }) => {
      if (payload.sessionId !== sessionId || payload.gate.id !== gateId) return;
      finish(payload.gate.result ?? null);
    };
    // A superseded gate will never resolve; stop holding the turn for it.
    const onCancelled = (payload: { sessionId: string; gate: Gate }) => {
      if (payload.sessionId !== sessionId || payload.gate.id !== gateId) return;
      finish(null);
    };
    const onAbort = () => finish(null);

    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    timer.unref?.();
    store.on('gate:resolved', onResolved);
    store.on('gate:cancelled', onCancelled);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    store.setGateWaiting(sessionId, gateId, true);
  });
}

/**
 * What woke a parked turn up.
 *
 * A turn parked on a gate has two legitimate reasons to resume: the gate was
 * answered, or the user typed something in the UI while it was open. Holding
 * only for the gate is what made a message queued in the browser sit unread
 * behind a step nobody had got round to answering.
 */
export type Resume =
  | { kind: 'gate'; gate: Gate }
  | { kind: 'feedback'; items: FeedbackItem[] };

/**
 * Hold the turn open on one gate, for one bounded window.
 *
 * This is the only mechanism by which answering in the browser moves the
 * session on by itself: a stopped CLI session cannot be woken from outside,
 * so the verdict has to arrive while the `Stop` hook that would end the turn
 * is still running. Returning `null` means the window closed with nothing to
 * say — the caller lets the turn end, and the verdict is delivered with the
 * user's next message instead. It must never re-park: a hold that renews
 * itself is what made the session unable to stop at all.
 */
export function waitAtGate(
  store: SessionStore,
  sessionId: string,
  gateId: string,
  opts: WaitOptions,
): Promise<Resume | null> {
  const existing = store.getGate(sessionId, gateId);
  if (existing && existing.status !== 'open') {
    return Promise.resolve({ kind: 'gate', gate: existing });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Resume | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      store.off('gate:resolved', onGate);
      store.off('gate:cancelled', onGate);
      store.off('feedback:queued', onQueued);
      opts.signal?.removeEventListener('abort', onAbort);
      // Not `setGateWaiting(false)`: that promotes the session to `active`,
      // which is a lie when the window merely expired. `onStop` sets the real
      // status on every path out of here.
      store.clearGateWaiting(sessionId, gateId);
      resolve(value);
    };

    // Resolved and cancelled both end the wait: a superseded or skipped gate
    // will never produce a verdict, and holding for one that cannot arrive is
    // the whole failure this is meant to avoid.
    const onGate = (payload: { sessionId: string; gate: Gate }) => {
      if (payload.sessionId !== sessionId || payload.gate.id !== gateId) return;
      finish({ kind: 'gate', gate: payload.gate });
    };
    // A message typed in the browser wakes the turn too, so an open gate does
    // not leave the queue stuck behind a step nobody has answered.
    const onQueued = (payload: { sessionId: string }) => {
      if (payload.sessionId !== sessionId) return;
      const items = store.drainFeedback(sessionId);
      if (items.length === 0) return;
      finish({ kind: 'feedback', items });
    };
    const onAbort = () => finish(null);

    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    timer.unref?.();
    store.on('gate:resolved', onGate);
    store.on('gate:cancelled', onGate);
    store.on('feedback:queued', onQueued);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    store.setGateWaiting(sessionId, gateId, true);
  });
}

/**
 * Wait for any async comment. Used by the `Stop` hook to hold a finished turn
 * open long enough for the user to react to what just happened.
 */
export function waitForFeedback(
  store: SessionStore,
  sessionId: string,
  opts: WaitOptions,
): Promise<FeedbackItem[] | null> {
  const session = store.get(sessionId);
  if (session && session.pendingFeedback.length > 0) {
    return Promise.resolve(store.drainFeedback(sessionId));
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: FeedbackItem[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      store.off('feedback:queued', onQueued);
      store.off('gate:resolved', onGate);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };

    const onQueued = (payload: { sessionId: string }) => {
      if (payload.sessionId !== sessionId) return;
      finish(store.drainFeedback(sessionId));
    };
    // A gate resolving is also a reason to wake the turn up.
    const onGate = (payload: { sessionId: string; gate: Gate }) => {
      if (payload.sessionId !== sessionId) return;
      finish(gateAsFeedback(payload.gate));
    };
    const onAbort = () => finish(null);

    const timer = setTimeout(() => finish(null), opts.timeoutMs);
    timer.unref?.();
    store.on('feedback:queued', onQueued);
    store.on('gate:resolved', onGate);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function gateAsFeedback(gate: Gate): FeedbackItem[] {
  const result = gate.result;
  if (!result) return [];
  return [
    {
      id: gate.id,
      createdAt: result.resolvedAt,
      origin: gate.kind === 'code_review' ? 'diff' : gate.kind === 'plan' ? 'plan' : 'timeline',
      text: result.comment ?? `Gate ${gate.kind}: ${result.verdict}`,
      ...(result.threads?.length ? { threads: result.threads } : {}),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Rendering feedback for the model
 * ------------------------------------------------------------------ */

/**
 * Turn UI feedback into the text Claude actually receives.
 *
 * Kept compact and unambiguous on purpose: this string is the entire cost of
 * the feedback loop in tokens, and it has to read as an instruction, not as a
 * data dump.
 */
export function renderFeedback(items: FeedbackItem[]): string {
  if (items.length === 0) return '';
  // A skipped gate changes what this message *is*: not a note to fold into
  // the current step, but a redirection away from it. Saying so first stops
  // the model re-parking on a gate that no longer exists.
  const skipped = items.find((item) => item.skippedGate)?.skippedGate;
  const parts: string[] = [
    skipped
      ? `[cc-harness] The user skipped the ${skipped.kind.replace('_', ' ')} gate ` +
        `("${skipped.prompt}") and sent this message instead. That gate is closed — do not wait on it:`
      : '[cc-harness] The user submitted feedback in the review UI:',
  ];

  for (const item of items) {
    if (item.text) parts.push(`\n${item.text}`);
    for (const thread of item.threads ?? []) {
      parts.push(renderThread(thread));
    }
  }
  if (skipped) {
    parts.push(
      '\nAct on the message above instead of the step you were waiting on. Publish a new gate when you ' +
        'reach the next point that needs the user.',
    );
    return parts.join('\n');
  }
  parts.push(
    '\nAddress each comment, then reply to it with harness_reply({ thread_id, text }) saying what you ' +
      'changed or why you disagree. When they are all answered, call harness_publish_diff again so the ' +
      'user can re-review.',
  );
  return parts.join('\n');
}

export function renderThread(thread: ReviewThread): string {
  const range =
    thread.startLine === thread.endLine ? `${thread.startLine}` : `${thread.startLine}-${thread.endLine}`;
  // The id is here so the model can reply into this exact thread.
  const lines = [`\n• [${thread.id}] ${thread.file}:${range} (${thread.side === 'old' ? 'before' : 'after'})`];
  if (thread.excerpt) {
    lines.push('  ```');
    for (const l of thread.excerpt.split('\n')) lines.push(`  ${l}`);
    lines.push('  ```');
  }
  lines.push(`  → ${thread.body}`);
  return lines.join('\n');
}

export function renderGateResult(gate: Gate): string {
  const result = gate.result;
  if (!result) return `[cc-harness] Gate ${gate.kind} is still open.`;

  const header: Record<string, string> = {
    approved: 'approved',
    changes_requested: 'requested changes',
    rejected: 'rejected this',
    answered: 'answered',
  };
  const parts = [`[cc-harness] The user ${header[result.verdict] ?? result.verdict} at the ${gate.kind} gate.`];

  if (result.comment) parts.push(`\n${result.comment}`);

  if (result.steps?.length) {
    const edited = result.steps.filter((s) => s.comment || s.status === 'dropped');
    if (edited.length) {
      parts.push('\nPlan changes:');
      for (const step of edited) {
        if (step.status === 'dropped') parts.push(`• DROP — ${step.title}`);
        else parts.push(`• ${step.title}\n  → ${step.comment}`);
      }
    }
    parts.push(`\nApproved plan (${result.steps.filter((s) => s.status !== 'dropped').length} steps):`);
    for (const [i, step] of result.steps.filter((s) => s.status !== 'dropped').entries()) {
      parts.push(`${i + 1}. ${step.title}${step.detail ? ` — ${step.detail}` : ''}`);
    }
  }

  for (const thread of result.threads ?? []) parts.push(renderThread(thread));

  if (result.ship) {
    const ship = result.ship;
    parts.push(
      `\nShip: provider=${ship.provider} steps=${ship.steps.join(' → ')}` +
        `${ship.branch ? ` branch=${ship.branch}` : ''}${ship.baseBranch ? ` base=${ship.baseBranch}` : ''}`,
    );
    if (ship.outcome) {
      parts.push(ship.outcome.ok ? `Result: ${ship.outcome.output}` : `FAILED: ${ship.outcome.output}`);
      if (ship.outcome.url) parts.push(`URL: ${ship.outcome.url}`);
    }
    if (ship.directive) {
      // The daemon cannot call the session's MCP servers, so this step is
      // Claude's to perform. Give it everything it needs, verbatim.
      parts.push(
        `\nACTION REQUIRED — the user chose an MCP-backed provider, so you must open the pull request yourself:`,
        ship.directive,
        `\nTitle (use verbatim):\n${ship.title}`,
        `\nBody (use verbatim):\n${ship.body}`,
        `\nThen report the resulting URL with harness_note.`,
      );
    }
  }

  if (result.verdict === 'approved') {
    parts.push('\nProceed with the next stage.');
  } else if (result.verdict === 'changes_requested') {
    parts.push(
      result.threads?.length
        ? '\nAddress each comment above, then reply to it with harness_reply({ thread_id, text }).'
        : '\nAddress the feedback above before moving on.',
    );
  } else if (result.verdict === 'rejected') {
    parts.push('\nStop and wait for further direction from the user.');
  }

  return parts.join('\n');
}
