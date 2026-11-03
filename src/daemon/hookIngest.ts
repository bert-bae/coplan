import path from 'node:path';
import type { SessionStore } from './store.ts';
import type { HarnessConfig } from '../shared/config.ts';
import { currentBranch, repoRoot } from './git.ts';
import { unreadNotice } from './render.ts';
import {
  HOOK_NOOP,
  additionalContext,
  type HookInput,
  type HookOutput,
  type SessionEndInput,
  type SessionStartInput,
  type UserPromptSubmitInput,
} from '../shared/hooks.ts';

/**
 * Lifecycle hooks, and nothing else.
 *
 * The harness does not watch Claude work and never holds a turn open: the
 * hooks only register a session, keep its working/idle/ended state honest for
 * the rail, and — when the user types in chat after changing the plan — slip
 * one line into the prompt saying so. Every hook answers immediately.
 */

export interface IngestContext {
  store: SessionStore;
  config: HarnessConfig;
}

export async function ingestHook(event: string, input: HookInput, ctx: IngestContext): Promise<HookOutput> {
  const sessionId = input.session_id;
  if (!sessionId) return HOOK_NOOP;

  switch (event) {
    case 'SessionStart':
      return onSessionStart(sessionId, input as SessionStartInput, ctx);
    case 'SessionEnd':
      ctx.store.ensure(sessionId, input.cwd);
      ctx.store.update(sessionId, { status: 'ended', endedAt: Date.now() });
      ctx.store.persistNow(sessionId);
      void (input as SessionEndInput);
      return HOOK_NOOP;
    case 'UserPromptSubmit':
      return onUserPromptSubmit(sessionId, input as UserPromptSubmitInput, ctx);
    case 'Stop':
      ctx.store.ensure(sessionId, input.cwd);
      ctx.store.update(sessionId, { status: 'idle' });
      return HOOK_NOOP;
    default:
      ctx.store.ensure(sessionId, input.cwd);
      return HOOK_NOOP;
  }
}

async function onSessionStart(sessionId: string, input: SessionStartInput, ctx: IngestContext): Promise<HookOutput> {
  const cwd = input.cwd || process.cwd();
  const session = ctx.store.ensure(sessionId, cwd);
  const root = await repoRoot(cwd);
  const branch = await currentBranch(root ?? cwd);
  ctx.store.update(sessionId, {
    cwd,
    repoRoot: root,
    branch,
    status: 'active',
    endedAt: undefined,
    // A fresh session is named after its project until the user (or the
    // plan's own title, which the rail prefers) says otherwise.
    title: session.titleLocked ? session.title : path.basename(root ?? cwd) || session.title,
  });
  return HOOK_NOOP;
}

async function onUserPromptSubmit(
  sessionId: string,
  input: UserPromptSubmitInput,
  ctx: IngestContext,
): Promise<HookOutput> {
  const session = ctx.store.ensure(sessionId, input.cwd);
  ctx.store.update(sessionId, { status: 'active' });
  if (!ctx.config.promptNotice) return HOOK_NOOP;
  const notice = unreadNotice(session.plan);
  return notice ? additionalContext('UserPromptSubmit', notice) : HOOK_NOOP;
}
