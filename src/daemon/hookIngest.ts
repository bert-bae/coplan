import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SessionStore } from './store.ts';
import type { HarnessConfig } from '../shared/config.ts';
import { TranscriptTailer } from './transcript.ts';
import { waitForFeedback, waitForResume, renderFeedback, renderGateResult } from './gates.ts';
import { currentBranch, headCommit, mainWorktreeRoot, repoRoot } from './git.ts';
import { scanTranscriptForWorktree, type WorktreeRecord } from './worktree.ts';
import { attributeFile, clearBaseline, reconcileFiles } from './tasks.ts';
import {
  HOOK_NOOP,
  additionalContext,
  stopBlock,
  type HookInput,
  type HookOutput,
  type NotificationInput,
  type PostToolUseFailureInput,
  type PostToolUseInput,
  type SessionEndInput,
  type SessionStartInput,
  type StopInput,
  type UserPromptSubmitInput,
} from '../shared/hooks.ts';
import type { TodoItem } from '../shared/types.ts';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Ring buffer for the recorded shell history, on both the ok and error paths. */
const MAX_COMMANDS = 200;
/** Distinct files tracked per session. A repo-wide refactor is not a leak,
 *  but an unbounded list persisted on every mutation is. */
const MAX_TOUCHED_FILES = 500;
/** Sessions whose park has expired, and on which gate. Keyed by session id so
 *  a hold that rolls over is counted rather than restarted. */
const holds = new Map<string, { gateId: string; rounds: number }>();

export interface IngestContext {
  store: SessionStore;
  config: HarnessConfig;
  uiUrl: (sessionId: string) => string;
  tailers: Map<string, TranscriptTailer>;
  signal?: AbortSignal;
}

/** Sessions whose transcript has already been scanned for a relocation, so a
 *  full scan happens at most once per session per daemon. */
const worktreeScanned = new Set<string>();
/** Bound it: the daemon can run for weeks and session ids are never reused. */
const MAX_SCANNED = 500;

/**
 * Translate one hook payload into state changes, and decide what (if
 * anything) to hand back to Claude.
 *
 * Every path must be safe to fail: a thrown error here would surface as a
 * hook error in the user's session, so the caller wraps this and falls back
 * to a no-op.
 */
export async function ingestHook(event: string, input: HookInput, ctx: IngestContext): Promise<HookOutput> {
  const sessionId = input.session_id;
  if (!sessionId) return HOOK_NOOP;

  switch (event) {
    case 'SessionStart':
      return onSessionStart(sessionId, input as SessionStartInput, ctx);
    case 'SessionEnd':
      return onSessionEnd(sessionId, input as SessionEndInput, ctx);
    case 'UserPromptSubmit':
      return onUserPromptSubmit(sessionId, input as UserPromptSubmitInput, ctx);
    case 'PostToolUse':
      return onPostToolUse(sessionId, input as PostToolUseInput, ctx);
    case 'PostToolUseFailure':
      return onPostToolUseFailure(sessionId, input as PostToolUseFailureInput, ctx);
    case 'Notification':
      return onNotification(sessionId, input as NotificationInput, ctx);
    case 'Stop':
      return onStop(sessionId, input as StopInput, ctx);
    default:
      // Unknown events still register the session so it shows up in the UI.
      ctx.store.ensure(sessionId, input.cwd);
      return HOOK_NOOP;
  }
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function onSessionStart(
  sessionId: string,
  input: SessionStartInput,
  ctx: IngestContext,
): Promise<HookOutput> {
  const launchedIn = input.cwd || process.cwd();
  const session = ctx.store.ensure(sessionId, launchedIn);

  // `SessionStart` fires again on resume, compact and `/clear`, and its `cwd`
  // is always the directory the session was launched in — never the worktree a
  // long-running session has since moved into. Re-anchoring on it here would
  // undo the relocation every time the context was compacted.
  const cwd = session.worktree?.path ?? launchedIn;
  const root = await repoRoot(cwd);
  const [branch, head] = await Promise.all([
    currentBranch(root ?? cwd),
    headCommit(root ?? cwd),
  ]);
  const named = session.worktree?.mainRoot ?? root ?? cwd;

  ctx.store.update(sessionId, {
    cwd,
    repoRoot: root,
    branch,
    // Preserve the original start commit across resume/compact restarts.
    startCommit: session.startCommit ?? head,
    transcriptPath: input.transcript_path ?? session.transcriptPath,
    status: 'active',
    title: session.title === sessionId.slice(0, 8) ? path.basename(named) : session.title,
    ...(input.start_reason === 'clear' ? { stage: 'idle' as const } : {}),
  });

  // The transcript is the only place a relocation is recorded, so a session
  // resumed from inside a worktree is only recognised here. Await it:
  // everything the session goes on to diff, check and ship runs against
  // whichever tree wins.
  await resolveWorktree(sessionId, ctx);

  attachTailer(sessionId, ctx, input.start_reason === 'resume');

  ctx.store.addTimeline(sessionId, 'note', `Session ${input.start_reason ?? 'started'}`, {
    label: 'session',
  });

  return HOOK_NOOP;
}

async function onSessionEnd(
  sessionId: string,
  input: SessionEndInput,
  ctx: IngestContext,
): Promise<HookOutput> {
  ctx.tailers.get(sessionId)?.close();
  ctx.tailers.delete(sessionId);
  worktreeScanned.delete(sessionId);
  holds.delete(sessionId);
  clearBaseline(sessionId);
  ctx.store.update(sessionId, { status: 'ended', endedAt: Date.now() });
  ctx.store.addTimeline(sessionId, 'note', `Session ended (${input.end_reason ?? 'unknown'})`, {
    label: 'session',
  });
  ctx.store.persistNow(sessionId);
  return HOOK_NOOP;
}

async function onUserPromptSubmit(
  sessionId: string,
  input: UserPromptSubmitInput,
  ctx: IngestContext,
): Promise<HookOutput> {
  const session = ctx.store.ensure(sessionId, input.cwd);
  ctx.store.update(sessionId, {
    status: 'active',
    transcriptPath: input.transcript_path ?? session.transcriptPath,
    stats: { ...session.stats, turns: session.stats.turns + 1 },
  });
  attachTailer(sessionId, ctx);

  // Anything the user queued in the UI rides along with their prompt — and so
  // does a verdict that landed after the harness gave up holding the turn,
  // which is otherwise the one way an answer can sit undelivered.
  const drained = ctx.store.drainFeedback(sessionId);
  const answered = ctx.store.undeliveredGate(sessionId);
  if (answered) ctx.store.markGateDelivered(sessionId, answered.id);
  const text = [
    answered ? renderGateResult(answered) : '',
    drained.length > 0 ? renderFeedback(drained) : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (text) return additionalContext('UserPromptSubmit', text);
  return HOOK_NOOP;
}

async function onPostToolUse(
  sessionId: string,
  input: PostToolUseInput,
  ctx: IngestContext,
): Promise<HookOutput> {
  const session = ctx.store.ensure(sessionId, input.cwd);
  const tool = input.tool_name ?? 'tool';
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  let touched: string | null = null;

  ctx.store.mutate(sessionId, (s) => {
    s.stats.toolCalls++;

    if (tool === 'TodoWrite') {
      const todos = normalizeTodos(toolInput['todos']);
      if (todos) s.todos = todos;
      return;
    }

    if (EDIT_TOOLS.has(tool)) {
      const file = typeof toolInput['file_path'] === 'string'
        ? toolInput['file_path']
        : typeof toolInput['notebook_path'] === 'string'
          ? toolInput['notebook_path']
          : null;
      if (file) {
        // Anything outside the session's tree keeps its absolute path: a
        // `../../…` relative path matches nothing in the diff and would be
        // attributed to a file that does not exist.
        const rel = s.repoRoot ? relativeWithin(s.repoRoot, file) : file;
        const existing = s.files.find((f) => f.path === rel);
        const now = Date.now();
        if (existing) {
          existing.edits++;
          existing.lastTouchedAt = now;
          if (!existing.tools.includes(tool)) existing.tools.push(tool);
        } else {
          s.files.push({ path: rel, edits: 1, firstTouchedAt: now, lastTouchedAt: now, tools: [tool] });
          if (s.files.length > MAX_TOUCHED_FILES) s.files.splice(0, s.files.length - MAX_TOUCHED_FILES);
        }
        s.stats.edits++;
        touched = rel;
      }
      return;
    }

    if (tool === 'Bash') {
      const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
      if (!command) return;
      s.commands.push({
        id: randomUUID(),
        command,
        description: typeof toolInput['description'] === 'string' ? toolInput['description'] : undefined,
        startedAt: Date.now(),
        ok: true,
        preview: previewOutput(input.tool_output ?? input.tool_response),
      });
      if (s.commands.length > MAX_COMMANDS) s.commands.splice(0, s.commands.length - MAX_COMMANDS);
    }
  });

  // The board records what changed per task without the model reporting it.
  if (touched) attributeFile(ctx.store, sessionId, touched);

  void session;
  return HOOK_NOOP;
}

async function onPostToolUseFailure(
  sessionId: string,
  input: PostToolUseFailureInput,
  ctx: IngestContext,
): Promise<HookOutput> {
  ctx.store.ensure(sessionId, input.cwd);
  const tool = input.tool_name ?? 'tool';
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  if (tool === 'Bash' && typeof toolInput['command'] === 'string') {
    ctx.store.mutate(sessionId, (s) => {
      s.commands.push({
        id: randomUUID(),
        command: toolInput['command'] as string,
        startedAt: Date.now(),
        ok: false,
        preview: (input.error ?? '').slice(0, 400),
      });
      // Same ring buffer as the success path, which used to be the only one
      // that trimmed — a session with many failing commands grew unbounded.
      if (s.commands.length > MAX_COMMANDS) s.commands.splice(0, s.commands.length - MAX_COMMANDS);
    });
  }
  ctx.store.addTimeline(sessionId, 'error', `${tool} failed: ${(input.error ?? '').slice(0, 300)}`, {
    label: tool,
  });
  return HOOK_NOOP;
}

async function onNotification(
  sessionId: string,
  input: NotificationInput,
  ctx: IngestContext,
): Promise<HookOutput> {
  ctx.store.ensure(sessionId, input.cwd);
  const kind = input.notification_type ?? 'notification';
  const text = input.message ?? summarizeNotification(input);
  ctx.store.addTimeline(sessionId, 'notification', text, { label: kind });
  if (kind === 'idle_prompt') {
    ctx.store.update(sessionId, { status: 'idle' });
  }
  return HOOK_NOOP;
}

/**
 * The turn boundary — and the harness's main injection point.
 *
 * This is where waiting happens. When a gate is open, the model's job is to
 * end its turn; the hook parks here on the daemon's side until the user acts
 * in the UI, and then resumes the session with their verdict as its next
 * input. Nothing polls, so a wait of an hour costs the same as a wait of a
 * second. Sessions that aren't using the harness fall straight through, so
 * this is invisible to them.
 */
async function onStop(sessionId: string, input: StopInput, ctx: IngestContext): Promise<HookOutput> {
  const session = ctx.store.ensure(sessionId, input.cwd);
  attachTailer(sessionId, ctx);

  // A turn boundary is the natural moment to true up what each task touched.
  if (session.tasks.some((t) => t.status === 'in_progress')) {
    await reconcileFiles(ctx.store, sessionId).catch(() => {});
  }

  // Feedback that arrived mid-turn goes out immediately, in every case.
  const drained = ctx.store.drainFeedback(sessionId);
  if (drained.length > 0) {
    holds.delete(sessionId);
    const open = ctx.store.activeGate(sessionId);
    ctx.store.update(sessionId, { status: 'active' });
    return stopBlock(renderFeedback(drained) + (open ? stillParked(open.kind) : ''));
  }

  // The user may have answered the gate while Claude was still finishing its
  // turn. That verdict is not "feedback" and no waiter is left to receive it,
  // so deliver it here or it would be lost.
  const answered = ctx.store.undeliveredGate(sessionId);
  if (answered) {
    holds.delete(sessionId);
    ctx.store.markGateDelivered(sessionId, answered.id);
    ctx.store.update(sessionId, { status: 'active' });
    return stopBlock(renderGateResult(answered));
  }

  const gate = ctx.store.activeGate(sessionId);

  // Already blocked once with nothing new to say: let the turn end rather
  // than burn through the CLI's consecutive-block allowance.
  if (input.stop_hook_active && !gate) {
    holds.delete(sessionId);
    ctx.store.update(sessionId, { status: 'idle' });
    return HOOK_NOOP;
  }

  if (!gate) {
    // No gate. Normally the turn ends here — but a session the user is
    // driving from the browser can be held open so a message typed there
    // still reaches it. Opt-in, because it occupies the terminal.
    if (ctx.config.holdIdleSessions && session.stage !== 'idle' && !input.stop_hook_active) {
      ctx.store.update(sessionId, { status: 'waiting' });
      const late = await waitForFeedback(ctx.store, sessionId, {
        timeoutMs: ctx.config.stopHoldSeconds * 1000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (late?.length) {
        ctx.store.update(sessionId, { status: 'active' });
        return stopBlock(renderFeedback(late));
      }
    }
    holds.delete(sessionId);
    ctx.store.update(sessionId, { status: 'idle' });
    return HOOK_NOOP;
  }

  // Park. The turn is over and the model is not holding anything open: the
  // wait lives here, in the daemon, until the user acts in the UI. That is
  // what replaced `harness_await` polling — no tool call, no token, and no
  // "still waiting" line per minute of the user's thinking time.
  ctx.store.update(sessionId, { status: 'waiting' });
  const signal = await waitForResume(ctx.store, sessionId, gate.id, {
    timeoutMs: ctx.config.stopHoldSeconds * 1000,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  if (signal?.kind === 'gate') {
    holds.delete(sessionId);
    if (signal.gate.result) {
      ctx.store.markGateDelivered(sessionId, gate.id);
      ctx.store.update(sessionId, { status: 'active' });
      return stopBlock(renderGateResult(signal.gate));
    }

    // Cancelled, with no verdict to hand over. "Send now" gets here when the
    // cancellation beats the message into the queue, so look for it before
    // deciding there is nothing to say.
    const queued = ctx.store.drainFeedback(sessionId);
    if (queued.length > 0) {
      ctx.store.update(sessionId, { status: 'active' });
      return stopBlock(renderFeedback(queued));
    }
    // Superseded by a newer gate: there is something to park on after all,
    // and only a turn ending can re-arm this hook.
    const current = ctx.store.activeGate(sessionId);
    if (current) {
      ctx.store.update(sessionId, { status: 'waiting' });
      return stopBlock(
        `[cc-harness] The "${gate.kind}" gate was replaced by a newer "${current.kind}" gate. ` +
          `End your turn again — the harness parks on that one and resumes you with its verdict.`,
      );
    }
    ctx.store.update(sessionId, { status: 'idle' });
    return HOOK_NOOP;
  }

  // A message typed in the browser wakes the turn too, so an open gate no
  // longer blocks the queue behind it. "Send now" closes the gate on its way
  // through, and `renderFeedback` says so itself — appending "still parked"
  // there would contradict it.
  if (signal?.kind === 'feedback' && signal.items.length > 0) {
    holds.delete(sessionId);
    ctx.store.update(sessionId, { status: 'active' });
    const skipped = signal.items.some((item) => item.skippedGate);
    return stopBlock(renderFeedback(signal.items) + (skipped ? '' : stillParked(gate.kind)));
  }

  // The window expired with the gate still open. Re-parking means ending
  // another turn, which is the one unavoidable cost: a single short turn per
  // window instead of a poll every couple of minutes. Bounded, so a session
  // nobody comes back to does not hold the terminal indefinitely.
  const round = (holds.get(sessionId)?.gateId === gate.id ? holds.get(sessionId)!.rounds : 0) + 1;
  const limit = ctx.config.gateHoldRounds;
  if (limit > 0 && round > limit) {
    holds.delete(sessionId);
    ctx.store.update(sessionId, { status: 'idle' });
    ctx.store.addTimeline(
      sessionId,
      'note',
      `Stopped holding the turn at the "${gate.kind}" gate after ` +
        `${Math.round((limit * ctx.config.stopHoldSeconds) / 60)} minutes. Answer it in the UI — ` +
        `the verdict is delivered with your next message to the session.`,
      { label: 'gate' },
    );
    return HOOK_NOOP;
  }

  holds.set(sessionId, { gateId: gate.id, rounds: round });
  ctx.store.update(sessionId, { status: 'waiting' });
  return stopBlock(
    `[cc-harness] Still parked at the "${gate.kind}" gate — the user has not answered yet. ` +
      `Do not call a tool and do not start new work: end your turn again, immediately. ` +
      `The harness re-parks the session and resumes you the moment they answer.`,
  );
}

/** Appended when feedback arrives while a gate is still open, so the model
 *  answers the message without treating it as the verdict. */
function stillParked(kind: string): string {
  return (
    `\n[cc-harness] The "${kind}" gate is still open — this message is not a verdict. ` +
    `Respond to it, then end your turn to park again.`
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Find out whether the session is working somewhere other than where it was
 * launched, and re-anchor it if so.
 *
 * Runs at most once per session: after this the tailer keeps the answer
 * current, and re-reading a multi-megabyte transcript on every hook would not.
 */
async function resolveWorktree(sessionId: string, ctx: IngestContext): Promise<void> {
  if (worktreeScanned.has(sessionId)) return;
  const transcript = ctx.store.get(sessionId)?.transcriptPath;
  // Nothing to scan yet — a brand-new session's transcript is written after
  // `SessionStart`. The tailer sees the relocation live in that case.
  if (!transcript) return;
  if (worktreeScanned.size >= MAX_SCANNED) worktreeScanned.clear();
  worktreeScanned.add(sessionId);
  await applyWorktree(sessionId, ctx, await scanTranscriptForWorktree(transcript));
}

/**
 * Point a session's git state at the tree it is actually working in.
 *
 * `repoRoot` is what every git operation in the daemon runs against — the
 * diff, the working-tree fingerprints behind task attribution, the checks, and
 * the commit and push in the ship stage. Leaving it on the launch directory
 * while the session edits a worktree does not merely show the wrong diff: the
 * ship stage would commit and push the wrong branch.
 */
async function applyWorktree(
  sessionId: string,
  ctx: IngestContext,
  worktree: WorktreeRecord | null,
): Promise<void> {
  const session = ctx.store.get(sessionId);
  if (!session) return;
  const previous = session.worktree ?? null;
  if ((worktree?.path ?? null) === (previous?.path ?? null)) return;

  // Leaving a worktree puts the session back where it came from.
  const target = worktree?.path ?? previous?.originalCwd ?? session.cwd;
  const root = (await repoRoot(target)) ?? target;
  const [branch, head, mainRoot] = await Promise.all([
    currentBranch(root),
    headCommit(root),
    worktree ? mainWorktreeRoot(root) : Promise.resolve(null),
  ]);

  ctx.store.update(sessionId, {
    cwd: target,
    repoRoot: root,
    branch,
    // The commit the worktree forked from is the right base for its review;
    // the one recorded at session start belongs to the tree it just left.
    startCommit: worktree
      ? worktree.originalHeadCommit ?? head
      : previous?.originalHeadCommit ?? session.startCommit ?? head,
    worktree: worktree
      ? {
          path: worktree.path,
          name: worktree.name,
          mainRoot,
          originalCwd: worktree.originalCwd ?? previous?.originalCwd ?? session.cwd,
          originalBranch: worktree.originalBranch ?? previous?.originalBranch ?? null,
          originalHeadCommit:
            worktree.originalHeadCommit ?? previous?.originalHeadCommit ?? session.startCommit,
        }
      : null,
  });

  ctx.store.addTimeline(
    sessionId,
    'note',
    worktree
      ? `Working in worktree ${worktree.name} (${target})`
      : `Left the worktree; back in ${target}`,
    { label: 'worktree' },
  );

  // The old tree's diff and the file baseline both describe somewhere else.
  ctx.store.clearDiff(sessionId);
  clearBaseline(sessionId);
}

/** `path.relative` outside `root` yields `../…`, which names nothing in the
 *  diff. Such a file keeps its absolute path instead. */
function relativeWithin(root: string, file: string): string {
  const rel = path.relative(root, file);
  if (!rel) return file;
  return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
}

function attachTailer(sessionId: string, ctx: IngestContext, fromStart = false): void {
  const session = ctx.store.get(sessionId);
  if (!session?.transcriptPath || ctx.tailers.has(sessionId)) return;
  const tailer = new TranscriptTailer(session.transcriptPath, (update) => {
    // The CLI names the conversation itself, but a name the user typed in
    // the UI outranks it — otherwise a rename is undone seconds later.
    if (update.title && !ctx.store.get(sessionId)?.titleLocked) {
      ctx.store.update(sessionId, { title: update.title });
    }
    // An `EnterWorktree` or `ExitWorktree` mid-session moves the whole tree
    // out from under the harness, so it is applied before anything else.
    if ('worktree' in update) void applyWorktree(sessionId, ctx, update.worktree ?? null);
    if (update.events.length) ctx.store.addTimelineBatch(sessionId, update.events);
    if (update.usage) {
      ctx.store.mutate(sessionId, (s) => {
        const usage = s.usage ?? { inputTokens: 0, outputTokens: 0, byStage: {} };
        usage.inputTokens += update.usage!.inputTokens;
        usage.outputTokens += update.usage!.outputTokens;
        // Attribute spend to whatever stage was live when it was incurred.
        usage.byStage[s.stage] = (usage.byStage[s.stage] ?? 0) + update.usage!.outputTokens;
        s.usage = usage;
      });
    }
  });
  ctx.tailers.set(sessionId, tailer);
  tailer.start(fromStart);

  // A daemon that starts mid-session attaches at the end of the transcript and
  // so never sees a relocation that already happened. This catches up on it
  // without blocking the hook that got us here.
  void resolveWorktree(sessionId, ctx).catch(() => {});
}

function normalizeTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const out: TodoItem[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const content = typeof item['content'] === 'string' ? item['content'] : null;
    if (!content) continue;
    const status = item['status'];
    out.push({
      content,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
      ...(typeof item['activeForm'] === 'string' ? { activeForm: item['activeForm'] } : {}),
    });
  }
  return out;
}

function previewOutput(output: unknown): string | undefined {
  if (typeof output === 'string') return output.slice(0, 400);
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    const text = rec['stdout'] ?? rec['output'] ?? rec['content'];
    if (typeof text === 'string') return text.slice(0, 400);
  }
  return undefined;
}

function summarizeNotification(input: NotificationInput): string {
  const data = input.notification_data;
  if (data && typeof data === 'object') {
    const message = (data as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  return input.notification_type ?? 'notification';
}
