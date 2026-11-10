/**
 * Claude Code hook payloads, narrowed to the events the harness subscribes to.
 *
 * The hook contract is owned by the CLI, not by us, so every field is treated
 * as optional at runtime and validated on ingest. `bin/harness doctor` replays
 * recorded payloads against the daemon to catch drift in this contract.
 */

export interface HookInputBase {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
}

export interface SessionStartInput extends HookInputBase {
  start_reason?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | string;
}

export interface SessionEndInput extends HookInputBase {
  end_reason?: string;
}

export interface UserPromptSubmitInput extends HookInputBase {
  user_input?: string;
  prompt?: string;
}

export interface PreToolUseInput extends HookInputBase {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
}

export interface PostToolUseInput extends PreToolUseInput {
  tool_output?: unknown;
  tool_response?: unknown;
}

export interface PostToolUseFailureInput extends PreToolUseInput {
  error?: string;
}

export interface NotificationInput extends HookInputBase {
  notification_type?: string;
  notification_data?: Record<string, unknown>;
  message?: string;
}

export interface StopInput extends HookInputBase {
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  stop_reason?: string;
}

export type HookInput =
  | SessionStartInput
  | SessionEndInput
  | UserPromptSubmitInput
  | PreToolUseInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | NotificationInput
  | StopInput;

/**
 * Hook output. The harness only ever returns a no-op or extra prompt context:
 * it never blocks a turn or holds one open.
 */
export interface HookOutput {
  decision?: 'block' | 'approve';
  reason?: string;
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    decision?: 'block' | 'approve';
    reason?: string;
    additionalContext?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

export function additionalContext(event: string, text: string): HookOutput {
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text,
    },
  };
}

/** The do-nothing response. Every failure path in the relay returns this. */
export const HOOK_NOOP: HookOutput = { suppressOutput: true };
