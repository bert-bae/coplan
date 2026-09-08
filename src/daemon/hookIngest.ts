import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SessionStore } from './store.ts';
import type { HarnessConfig } from '../shared/config.ts';
import { TranscriptTailer } from './transcript.ts';
import { waitAtGate, waitForFeedback, renderFeedback, renderGateResult, type Resume } from './gates.ts';
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
import type { FeedbackItem, TodoItem } from '../shared/types.ts';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Ring buffer for the recorded shell history, on both the ok and error paths. */
const MAX_COMMANDS = 200;
/** Distinct files tracked per session. A repo-wide refactor is not a leak,
 *  but an unbounded list persisted on every mutation is. */
const MAX_TOUCHED_FILES = 500;
/**
 * Ceiling on any `Stop` hold, in seconds.
 *
 * `bin/hook-relay.sh` gives `Stop` 570s of curl and `hooks/hooks.json` gives
 * it 600s, so a hold configured past that is not a longer wait — it is a wait
 * whose answer is thrown away, because the relay is killed before the daemon
 * can hand the verdict back. Staying inside the relay's window means the
 * worst case is still a clean stop.
 */
const MAX_HOLD_SECONDS = 540;
/**
 * The gate a session has already spent a hold on, keyed by session.
 *
 * A hold that ends in a message rather than a verdict leaves the gate open,
 * so the next `Stop` would hold on it again — and a user chatting while they
 * think could chain blocks indefinitely, each one drawing on the CLI's
 * consecutive-block allowance. One hold per gate bounds that: after it the
 * session stops properly, and what the user says next arrives as an ordinary
 * prompt. A verdict clears the entry, because the next gate is a new question.
 */
const heldOnce = new Map<string, string>();
/** Bound it: the daemon runs for weeks and session ids are never reused. */
const MAX_HELD = 500;

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
  heldOnce.delete(sessionId);
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
  const answered = ctx.store.undeliveredGates(sessionId);
  for (const gate of answered) ctx.store.markGateDelivered(sessionId, gate.id);
  const text = [
    ...answered.map(renderGateResult),
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
 * Anything the user has already said is handed over here, and the turn is
 * resumed to carry it. An open gate then holds the turn for one bounded
 * window: a stopped CLI session cannot be woken from outside, so this is the
 * only moment at which answering in the browser can move the session on by
 * itself, and without it a click in the UI did nothing until the user went
 * back to the terminal and typed.
 *
 * The window is single-round. The version that re-blocked on expiry, for
 * `gateHoldRounds × stopHoldSeconds`, left the CLI structurally unable to
 * stop for over half an hour and spent a turn per rollover; expiring into a
 * plain stop costs one window and no turns, and the verdict still rides
 * whatever the user types next (see {@link onUserPromptSubmit}).
 *
 * Sessions that aren't using the harness fall straight through, so this is
 * invisible to them.
 */
async function onStop(sessionId: string, input: StopInput, ctx: IngestContext): Promise<HookOutput> {
  const session = ctx.store.ensure(sessionId, input.cwd);
  attachTailer(sessionId, ctx);

  // A turn boundary is the natural moment to true up what each task touched.
  if (session.tasks.some((t) => t.status === 'in_progress')) {
    await reconcileFiles(ctx.store, sessionId).catch(() => {});
  }

  // Anything the user has already said goes out immediately — and all of it
  // on the same turn. Delivering only the message and leaving the verdict for
  // the next Stop left Claude working on a comment while the answer it was
  // waiting for sat in the store, and cost a second block to hand over.
  const early = deliverPending(sessionId, ctx);
  if (early) return early;

  const gate = ctx.store.activeGate(sessionId);

  // Already blocked once with nothing new to say: let the turn end rather
  // than burn through the CLI's consecutive-block allowance.
  if (input.stop_hook_active && !gate) {
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
    ctx.store.update(sessionId, { status: 'idle' });
    return HOOK_NOOP;
  }

  // A gate is open. Hold the turn for one bounded window so that answering in
  // the browser resumes the session by itself — there is no other moment at
  // which it can, because a stopped CLI session cannot be woken from outside.
  ctx.store.update(sessionId, { status: 'waiting' });
  // `stop_hook_active` alone is too blunt to gate this on: it stays true for
  // the whole continuation chain, so keying off it would give the hold to the
  // first gate of a run and to none of the others. What has to be bounded is
  // narrower — chatting to a session while one gate stays open would
  // otherwise hold, block, hold, block indefinitely on that gate, and every
  // block draws on the CLI's consecutive-block allowance. So a gate gets one
  // hold that ends in a message; after that it stops, and the next thing the
  // user says reaches it as an ordinary prompt.
  const spent = heldOnce.get(sessionId) === gate.id && input.stop_hook_active === true;
  const hold = spent ? 0 : Math.min(ctx.config.gateHoldSeconds, MAX_HOLD_SECONDS);
  if (hold > 0) {
    const resumed = await waitAtGate(ctx.store, sessionId, gate.id, {
      timeoutMs: hold * 1000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const delivered = resumed ? renderResume(sessionId, resumed, ctx) : null;
    if (delivered) {
      // A verdict closes the gate, so the next hold is a fresh question. A
      // message leaves it open, and that is the one worth counting.
      if (resumed?.kind === 'feedback') {
        if (heldOnce.size >= MAX_HELD) heldOnce.clear();
        heldOnce.set(sessionId, gate.id);
      } else {
        heldOnce.delete(sessionId);
      }
      ctx.store.update(sessionId, { status: 'active' });
      return stopBlock(delivered);
    }
  }

  // The window closed with nothing to say — or there is no window. Either
  // way the turn ends here and Claude stops; nothing re-parks, because a hold
  // that renews itself is what left the CLI unable to stop at all. The
  // verdict reaches the session through `onUserPromptSubmit` instead.
  //
  // Only a gate still standing makes this `waiting`: the hold can also end
  // because the gate was skipped, and a session with nothing left to answer
  // must not go on asking for the user's attention.
  ctx.store.update(sessionId, { status: ctx.store.activeGate(sessionId) ? 'waiting' : 'idle' });
  return HOOK_NOOP;
}

/**
 * Hand over everything the user has already said, as one message.
 *
 * A queued message and an answered gate are separate things that can both be
 * waiting at the same moment, and they used to be delivered by two mutually
 * exclusive branches — so the one that lost sat undelivered for a whole extra
 * round. Returns `null` when there is nothing pending.
 */
function deliverPending(sessionId: string, ctx: IngestContext): HookOutput | null {
  const drained = ctx.store.drainFeedback(sessionId);
  const answered = ctx.store.undeliveredGates(sessionId);
  if (drained.length === 0 && answered.length === 0) return null;

  const parts: string[] = [];
  for (const gate of answered) {
    ctx.store.markGateDelivered(sessionId, gate.id);
    parts.push(renderGateResult(gate));
  }
  // "Still parked" only if a gate is genuinely still open after all this; a
  // verdict just delivered means the step it belonged to is closed.
  if (drained.length > 0) parts.push(renderMessages(sessionId, drained, ctx));
  ctx.store.update(sessionId, { status: 'active' });
  return stopBlock(parts.join('\n\n'));
}

/** Turn whatever ended the hold into the text that resumes the turn. */
function renderResume(sessionId: string, resumed: Resume, ctx: IngestContext): string | null {
  if (resumed.kind === 'feedback') return renderMessages(sessionId, resumed.items, ctx);

  const gate = resumed.gate;
  if (gate.result) {
    ctx.store.markGateDelivered(sessionId, gate.id);
    return renderGateResult(gate);
  }

  // The gate ended without a verdict. "Send now" queues its message before
  // closing the gate, so look for that before concluding there is nothing to
  // say — otherwise the message it was replaced with would be left behind.
  const queued = ctx.store.drainFeedback(sessionId);
  if (queued.length > 0) return renderMessages(sessionId, queued, ctx);

  // Cancelled with nothing behind it, or superseded by a newer gate. Only a
  // turn ending can re-arm this hook, so let it end rather than block with
  // nothing to say — the newer gate gets its own window on the next Stop.
  return null;
}

/**
 * The user's messages, plus a note if they are not the verdict.
 *
 * A message that arrives with a gate still open is not an answer to it, and
 * saying so is what stops the model treating "actually, check X first" as
 * approval. A gate that has since been answered or skipped gets no such note.
 */
function renderMessages(sessionId: string, items: FeedbackItem[], ctx: IngestContext): string {
  const open = ctx.store.activeGate(sessionId);
  return renderFeedback(items) + (open ? stillParked(open.kind) : '');
}

/** Appended when feedback arrives while a gate is still open, so the model
 *  answers the message without treating it as the verdict. */
function stillParked(kind: string): string {
  return (
    `\n[cc-harness] The "${kind}" gate is still open — this message is not a verdict. ` +
    `Respond to it, then end your turn — answering it is still the user's move.`
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
