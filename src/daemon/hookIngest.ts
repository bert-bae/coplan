import path from 'node:path';
import type { SessionStore } from './store.ts';
import type { HarnessConfig } from '../shared/config.ts';
import { currentBranch, repoRoot } from '../shared/changes.ts';
import { unreadNotice } from './render.ts';
import { resolveLink, type SessionEnv } from '../shared/link.ts';
import { DEFAULT_AGENT, agentInfo, type AgentKind } from '../shared/agents.ts';
import {
  HOOK_NOOP,
  additionalContext,
  type HookInput,
  type HookOutput,
  type NotificationInput,
  type PreToolUseInput,
  type SessionStartInput,
  type StopInput,
  type UserPromptSubmitInput,
} from '../shared/hooks.ts';
import type { SessionState, WaitingState } from '../shared/types.ts';

/**
 * Lifecycle hooks.
 *
 * The harness never holds a turn and never answers for the user. The hooks
 * keep three things honest for the browser: whether Claude is working, whether
 * it is waiting on the user (and for what), and how to link back to the
 * session so they can answer it there. Every hook answers immediately.
 */

export interface IngestContext {
  store: SessionStore;
  config: HarnessConfig;
  /** Which agent the hook came from, already read as Claude Code's events
   *  (see `agentHooks.ts`). Claude Code when unset. */
  agent?: AgentKind;
  /** Where the session runs, read from its environment by the relay. */
  env?: SessionEnv;
  /** Called when a session starts waiting on the user. */
  onWaiting?: (session: SessionState) => void;
}

/** Notifications that mean "Claude cannot go on without the user". */
const INPUT_NOTIFICATIONS = new Set(['idle_prompt', 'agent_needs_input', 'elicitation_dialog']);

/**
 * The last thing each Cursor chat said, by session. Cursor's `stop` does not
 * carry the reply the way Claude Code's `Stop` does; `afterAgentResponse`
 * comes just before it with the text.
 */
const lastReplies = new Map<string, string>();
const MAX_REPLIES = 200;

export async function ingestHook(event: string, input: HookInput, ctx: IngestContext): Promise<HookOutput> {
  const sessionId = input.session_id;
  if (!sessionId) return HOOK_NOOP;
  const agent = ctx.agent ?? DEFAULT_AGENT;
  const existing = ctx.store.ensure(sessionId, input.cwd, agent);
  if (existing.agent !== agent) ctx.store.update(sessionId, { agent });
  // Its hooks run: what `coplan doctor` checks a Codex thread for (#52).
  if (existing.hookedAt == null) ctx.store.update(sessionId, { hookedAt: Date.now() });
  applyEnv(sessionId, ctx);

  switch (event) {
    case 'SessionStart':
      return onSessionStart(sessionId, input as SessionStartInput, ctx);
    case 'SessionEnd':
      ctx.store.update(sessionId, { status: 'ended', endedAt: Date.now(), waiting: null });
      ctx.store.persistNow(sessionId);
      return HOOK_NOOP;
    case 'UserPromptSubmit':
      return onUserPromptSubmit(sessionId, input as UserPromptSubmitInput, ctx);
    case 'PreToolUse':
      return onPreToolUse(sessionId, input as PreToolUseInput, ctx);
    case 'PostToolUse': {
      if (loadsCoplan(input as PreToolUseInput)) ctx.store.engage(sessionId);
      // Any tool finishing means Claude is moving again: an answered question,
      // an approved permission. Only write when something actually changes.
      const s = ctx.store.get(sessionId);
      if (s && (s.waiting || s.status !== 'active')) ctx.store.update(sessionId, { status: 'active', waiting: null });
      return HOOK_NOOP;
    }
    case 'Notification':
      return onNotification(sessionId, input as NotificationInput, ctx);
    case 'AfterAgentResponse': {
      const text = (input as StopInput).last_assistant_message;
      if (typeof text === 'string') {
        lastReplies.delete(sessionId);
        lastReplies.set(sessionId, text);
        if (lastReplies.size > MAX_REPLIES) lastReplies.delete(lastReplies.keys().next().value!);
      }
      return HOOK_NOOP;
    }
    case 'Stop':
      return onStop(sessionId, input as StopInput, ctx);
    default:
      return HOOK_NOOP;
  }
}

/** Keep the session's link current. Remote Control can be switched on (or
 *  off) mid-session, so every event re-reads it. */
function applyEnv(sessionId: string, ctx: IngestContext): void {
  if (!ctx.env) return;
  const { surface, link } = resolveLink(ctx.env, ctx.agent ?? DEFAULT_AGENT, sessionId);
  const s = ctx.store.get(sessionId);
  if (!s) return;
  if (s.surface === surface && JSON.stringify(s.link) === JSON.stringify(link)) return;
  ctx.store.update(sessionId, { surface, link });
}

async function onSessionStart(sessionId: string, input: SessionStartInput, ctx: IngestContext): Promise<HookOutput> {
  // A payload that names no folder leaves the one known, or none: the
  // daemon's own is some other session's repository.
  const cwd = input.cwd || ctx.store.get(sessionId)?.cwd || '';
  const session = ctx.store.ensure(sessionId, cwd);
  const [root, branch] = await Promise.all([repoRoot(cwd), currentBranch(cwd)]);
  ctx.store.update(sessionId, {
    cwd,
    repoRoot: root,
    branch,
    status: 'active',
    waiting: null,
    endedAt: undefined,
    title: session.titleLocked ? session.title : path.basename(root ?? cwd) || session.title,
  });
  return HOOK_NOOP;
}

async function onUserPromptSubmit(sessionId: string, input: UserPromptSubmitInput, ctx: IngestContext): Promise<HookOutput> {
  // The user has answered, in Claude, whatever was being waited on.
  const session = ctx.store.update(sessionId, { status: 'active', waiting: null });
  if (!session) return HOOK_NOOP;
  const typed = String(input.prompt ?? input.user_input ?? '');
  if (asksForCoplan(typed)) ctx.store.engage(sessionId);

  // The user signed something off for this session — the design, to be
  // broken into tasks, or the plan, to be built: their message is what
  // carries the prompt. Not subject to `promptNotice` — signing off was the
  // request to send it. A message that already holds the prompt (they pasted
  // it) is left as it is.
  //
  // A revision request the user queued from the page (#67) rides along the
  // same way: one explicit ask, sent once. One prompt to a message, as each
  // is the most a hook may add (PROMPT_BUDGET): queued with a sign-off, the
  // request waits for the message after.
  if (!agentInfo(ctx.agent).promptContext) {
    // An agent whose hooks cannot be relied on to add to a prompt (Cursor)
    // gets the prompt by the user pasting it, or from its next
    // harness_plan_read. All this hook can do is notice the paste, so it is
    // not sent twice.
    const pending = ctx.store.pending(sessionId);
    if (pending && holdsPrompt(typed, pending.prompt)) ctx.store.deliver(sessionId);
    const revision = ctx.store.pendingRevision(sessionId);
    if (revision && holdsPrompt(typed, revision.prompt)) ctx.store.deliverRevision(sessionId);
  } else {
    const handed = ctx.store.deliver(sessionId);
    const revision = handed ? null : ctx.store.deliverRevision(sessionId);
    if (handed || revision) {
      // The user can still act after signing off (edit tasks after the
      // design, comment, reject a proposal after submitting); that is not in
      // the prompt, so it stays unread and the agent is told to read it.
      const later = ctx.store.get(sessionId)?.plan;
      const notice = later && ctx.config.promptNotice ? unreadNotice(later) : null;
      const text = [
        handed && !holdsPrompt(typed, handed.prompt) ? handed.prompt : '',
        revision && !holdsPrompt(typed, revision.prompt) ? revision.prompt : '',
        notice ?? '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return text ? additionalContext('UserPromptSubmit', text) : HOOK_NOOP;
    }
  }

  if (!ctx.config.promptNotice) return HOOK_NOOP;
  const notice = unreadNotice(session.plan);
  return notice ? additionalContext('UserPromptSubmit', notice) : HOOK_NOOP;
}

/**
 * The message starts Coplan: `/coplan` in Claude Code and Cursor (Claude Code
 * may spell it `/coplan:coplan`, naming the plugin), at the start of the
 * message as a command is; `$coplan` in Codex, which takes a skill anywhere
 * in the message. `/coplan-open` and the other commands do not count: they
 * look at Coplan, they do not plan in it.
 */
export function asksForCoplan(prompt: string): boolean {
  return /^\s*\/(?:coplan:)?coplan(?![\w:/-])|(?:^|\s)\$coplan(?![\w:/-])/.test(prompt);
}

/** The agent loaded a Coplan skill itself (Claude Code's `Skill` tool), as it
 *  does when asked to "plan this in Coplan" in so many words. */
function loadsCoplan(input: PreToolUseInput): boolean {
  if (input.tool_name !== 'Skill') return false;
  const name = String(input.tool_input?.['skill'] ?? '');
  return /^(?:coplan:)?coplan(?:-build)?$/.test(name);
}

/**
 * The message already carries this prompt: the user pasted it. Matched on
 * the whole prompt (whitespace aside), not its opening marker, so pasting
 * an older prompt for the same plan never stands in for the newer one.
 */
function holdsPrompt(typed: string, prompt: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const want = norm(prompt);
  return want.length > 0 && norm(typed).includes(want);
}

function onPreToolUse(sessionId: string, input: PreToolUseInput, ctx: IngestContext): HookOutput {
  // AskUserQuestion in Claude Code, request_user_input in Codex, AskQuestion
  // in Cursor: the same structured question, under each agent's name.
  if (!agentInfo(ctx.agent).askTools.includes(input.tool_name ?? '')) return HOOK_NOOP;
  const questions = readQuestions(input.tool_input);
  if (questions.length === 0) return HOOK_NOOP;
  setWaiting(sessionId, ctx, {
    kind: 'question',
    text: questions.map((q) => q.question).join(' · '),
    questions,
    since: Date.now(),
  });
  return HOOK_NOOP;
}

function onNotification(sessionId: string, input: NotificationInput, ctx: IngestContext): HookOutput {
  const type = input.notification_type ?? '';
  const text = clip(input.message ?? '') || 'Claude is waiting for your input.';
  const current = ctx.store.get(sessionId)?.waiting;
  if (type === 'permission_prompt') {
    setWaiting(sessionId, ctx, { kind: 'permission', text, since: Date.now() });
  } else if (INPUT_NOTIFICATIONS.has(type) && current?.kind !== 'question') {
    // An idle reminder must not replace the question it is reminding about.
    if (!current) setWaiting(sessionId, ctx, { kind: 'input', text, since: Date.now() });
  }
  return HOOK_NOOP;
}

function onStop(sessionId: string, input: StopInput, ctx: IngestContext): HookOutput {
  // A turn that ends on a question is waiting on an answer even though no
  // tool asked it. Claude is told to use AskUserQuestion, but prose happens.
  const reply = input.last_assistant_message ?? lastReplies.get(sessionId);
  lastReplies.delete(sessionId);
  const asked = trailingQuestion(reply);
  ctx.store.update(sessionId, {
    status: 'idle',
    waiting: asked ? { kind: 'input', text: asked, since: Date.now() } : null,
  });
  if (asked) ctx.onWaiting?.(ctx.store.get(sessionId)!);
  return HOOK_NOOP;
}

function setWaiting(sessionId: string, ctx: IngestContext, waiting: WaitingState): void {
  const before = ctx.store.get(sessionId)?.waiting;
  const session = ctx.store.update(sessionId, { waiting });
  if (session && !before) ctx.onWaiting?.(session);
}

/** `AskUserQuestion`'s `tool_input.questions`, normalized and bounded. */
function readQuestions(raw: unknown): NonNullable<WaitingState['questions']> {
  const list = (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 6)
    .map((q) => {
      const rec = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
      const question = clip(String(rec['question'] ?? ''));
      const header = clip(String(rec['header'] ?? ''), 40);
      const options = (Array.isArray(rec['options']) ? rec['options'] : [])
        .map((o) => clip(typeof o === 'string' ? o : String((o as Record<string, unknown>)?.['label'] ?? ''), 80))
        .filter(Boolean)
        .slice(0, 8);
      return { question, ...(header ? { header } : {}), options, ...(rec['multiSelect'] === true ? { multiSelect: true } : {}) };
    })
    .filter((q) => q.question);
}

/** The last paragraph of a message, when it ends in a question. */
function trailingQuestion(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const last = message.trim().split(/\n\s*\n/).pop()?.trim() ?? '';
  return last.endsWith('?') ? clip(last.replace(/[*_`#>]/g, '')) : null;
}

function clip(text: string, max = 300): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
