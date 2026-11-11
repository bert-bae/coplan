import type { AgentKind } from '../shared/agents.ts';
import type { HookInput, HookOutput } from '../shared/hooks.ts';

/**
 * Each agent's hooks, read as Claude Code's.
 *
 * `hookIngest` speaks Claude Code's hook contract: its event names, its
 * payload fields and its `hookSpecificOutput`. Codex adopted that contract
 * nearly whole, so its payloads pass through — except that it has no
 * `Notification`, and says it is waiting on a permission with
 * `PermissionRequest` instead, and that it refuses any output field an event
 * does not take. Cursor has its own contract: camelCase events,
 * `conversation_id` for the session, `workspace_roots` for the folder, and a
 * different output for each event. This is the one place that translates, in
 * both directions, so nothing past it needs to know which agent is on the
 * other end.
 */

export interface AgentHook {
  /** The Claude Code event this is, or null for one Coplan does not use. */
  event: string | null;
  input: HookInput;
}

/** Cursor's events, as the Claude Code events that mean the same thing. */
const CURSOR_EVENTS: Record<string, string> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit',
  afterAgentResponse: 'AfterAgentResponse',
  stop: 'Stop',
};

/** Cursor runs Claude Code's own `hooks.json` when it imports a Claude Code
 *  plugin, under Claude's event names but with its own payloads. */
const CLAUDE_EVENTS_IN_CURSOR = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

/**
 * Which agent a hook really came from. The relay says, but Cursor can run
 * the Claude Code plugin's hooks (its "third-party configs" setting), which
 * name no agent; its payloads give it away.
 */
export function hookAgent(named: AgentKind, raw: Record<string, unknown>): AgentKind {
  if (named === 'claude' && typeof raw['cursor_version'] === 'string' && typeof raw['conversation_id'] === 'string') return 'cursor';
  return named;
}

export function readAgentHook(agent: AgentKind, event: string, raw: Record<string, unknown>): AgentHook {
  if (agent === 'cursor') {
    const known = CURSOR_EVENTS[event] ?? (CLAUDE_EVENTS_IN_CURSOR.has(event) ? event : null);
    return { event: known, input: fromCursor(raw) };
  }
  if (agent === 'codex' && event === 'PermissionRequest') {
    // What Claude Code reports as a permission_prompt notification.
    const tool = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : '';
    return {
      event: 'Notification',
      input: {
        ...raw,
        notification_type: 'permission_prompt',
        message: tool ? `Codex needs your permission to use ${tool}` : 'Codex needs your permission',
      } as HookInput,
    };
  }
  return { event, input: raw as HookInput };
}

function fromCursor(raw: Record<string, unknown>): HookInput {
  const str = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  const roots = Array.isArray(raw['workspace_roots']) ? (raw['workspace_roots'] as unknown[]).filter((r) => typeof r === 'string') : [];
  // One conversation is one session: `conversation_id` is on every event,
  // where `session_id` is only on the session ones.
  const sessionId = str('conversation_id') ?? str('session_id');
  const cwd = (roots[0] as string | undefined) ?? str('cwd');
  return {
    ...raw,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    // `afterAgentResponse` carries the reply that `Stop` does not.
    ...(str('text') !== undefined && raw['last_assistant_message'] === undefined ? { last_assistant_message: str('text') } : {}),
  } as HookInput;
}

/**
 * What the agent gets back. Claude Code takes the daemon's answer as it is.
 * Codex takes the same shape but fails a hook whose output has a field the
 * event does not accept (`suppressOutput` on `PreToolUse`, anything on
 * `PermissionRequest`), so it gets only the context, or nothing. Cursor
 * takes, per event, only the fields it knows, and adds words to the context
 * only at the start of a session — never to a prompt, so a build prompt
 * cannot ride along there.
 */
export function writeAgentOutput(agent: AgentKind, event: string, output: HookOutput): unknown {
  if (agent === 'claude') return output;
  if (agent === 'codex') {
    const context = output.hookSpecificOutput?.additionalContext;
    return context && CODEX_CONTEXT_EVENTS.has(event)
      ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } }
      : {};
  }
  const context = output.hookSpecificOutput?.additionalContext;
  switch (event) {
    case 'beforeSubmitPrompt':
    case 'UserPromptSubmit':
      // Cursor documents only `continue` here. Recent builds also take
      // `additional_context`, so the "you changed the plan" line rides along
      // where it can; nothing depends on it arriving.
      return context ? { continue: true, additional_context: context } : { continue: true };
    case 'sessionStart':
    case 'SessionStart':
      return context ? { additional_context: context } : {};
    default:
      return {};
  }
}

/** The Codex events that can add to the model's context. */
const CODEX_CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
