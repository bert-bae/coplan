import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SessionStore } from './store.ts';
import type { HarnessConfig } from '../shared/config.ts';
import { TranscriptTailer } from './transcript.ts';
import { waitForFeedback, waitForGate, renderFeedback, renderGateResult } from './gates.ts';
import { currentBranch, headCommit, repoRoot } from './git.ts';
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

export interface IngestContext {
  store: SessionStore;
  config: HarnessConfig;
  uiUrl: (sessionId: string) => string;
  tailers: Map<string, TranscriptTailer>;
  signal?: AbortSignal;
}

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
  const cwd = input.cwd || process.cwd();
  const session = ctx.store.ensure(sessionId, cwd);

  const root = await repoRoot(cwd);
  const [branch, head] = await Promise.all([
    currentBranch(root ?? cwd),
    headCommit(root ?? cwd),
  ]);

  ctx.store.update(sessionId, {
    cwd,
    repoRoot: root,
    branch,
    // Preserve the original start commit across resume/compact restarts.
    startCommit: session.startCommit ?? head,
    transcriptPath: input.transcript_path ?? session.transcriptPath,
    status: 'active',
    title: session.title === sessionId.slice(0, 8) ? path.basename(root ?? cwd) : session.title,
    ...(input.start_reason === 'clear' ? { stage: 'idle' as const } : {}),
  });

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

  // Anything the user queued in the UI rides along with their prompt.
  const drained = ctx.store.drainFeedback(sessionId);
  if (drained.length > 0) {
    return additionalContext('UserPromptSubmit', renderFeedback(drained));
  }
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
        const rel = s.repoRoot ? path.relative(s.repoRoot, file) || file : file;
        const existing = s.files.find((f) => f.path === rel);
        const now = Date.now();
        if (existing) {
          existing.edits++;
          existing.lastTouchedAt = now;
          if (!existing.tools.includes(tool)) existing.tools.push(tool);
        } else {
          s.files.push({ path: rel, edits: 1, firstTouchedAt: now, lastTouchedAt: now, tools: [tool] });
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
      if (s.commands.length > 200) s.commands.splice(0, s.commands.length - 200);
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
 * If an open gate exists, the turn is held here until the user resolves it in
 * the UI, then Claude is resumed with their verdict. Sessions that aren't
 * using the harness fall straight through, so this is invisible to them.
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
    ctx.store.update(sessionId, { status: 'active' });
    return stopBlock(renderFeedback(drained));
  }

  // The user may have answered the gate while Claude was still finishing its
  // turn. That verdict is not "feedback" and no waiter is left to receive it,
  // so deliver it here or it would be lost.
  const answered = ctx.store.undeliveredGate(sessionId);
  if (answered) {
    ctx.store.markGateDelivered(sessionId, answered.id);
    ctx.store.update(sessionId, { status: 'active' });
    return stopBlock(renderGateResult(answered));
  }

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

  // Park: hold the turn open while the user works through the gate in the UI.
  // Say so in the terminal — otherwise this looks like a nine-minute hang and
  // the user reaches for Ctrl+C.
  ctx.store.update(sessionId, { status: 'waiting' });
  const result = await waitForGate(ctx.store, sessionId, gate.id, {
    timeoutMs: ctx.config.stopHoldSeconds * 1000,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  if (result) {
    ctx.store.markGateDelivered(sessionId, gate.id);
    ctx.store.update(sessionId, { status: 'active' });
    return stopBlock(renderGateResult({ ...gate, status: 'resolved', result }));
  }


  // Hold expired with the gate still open. Also check for feedback that
  // landed in the same instant, then hand control back with a short nudge so
  // the model re-parks instead of wandering off.
  const late = ctx.store.drainFeedback(sessionId);
  if (late.length > 0) {
    ctx.store.update(sessionId, { status: 'active' });
    return stopBlock(renderFeedback(late));
  }

  if (input.stop_hook_active) {
    ctx.store.update(sessionId, { status: 'idle' });
    return HOOK_NOOP;
  }

  ctx.store.update(sessionId, { status: 'waiting' });
  return stopBlock(
    `[cc-harness] Still waiting on the user at the "${gate.kind}" gate. ` +
      `Call harness_await({ gate_id: "${gate.id}" }) to keep waiting. Do not start new work.`,
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function attachTailer(sessionId: string, ctx: IngestContext, fromStart = false): void {
  const session = ctx.store.get(sessionId);
  if (!session?.transcriptPath || ctx.tailers.has(sessionId)) return;
  const tailer = new TranscriptTailer(session.transcriptPath, (update) => {
    if (update.title) ctx.store.update(sessionId, { title: update.title });
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
