import type { SessionLink, SessionSurface } from './types.ts';

/**
 * How to get back to a session, from the environment its hooks run in.
 *
 * Questions are answered in Claude, not in the harness, so the harness needs
 * a link to the session. What is documented:
 *
 * - Cloud sessions carry their id (`CLAUDE_CODE_REMOTE_SESSION_ID`, `cse_…`),
 *   reachable at `https://claude.ai/code/session_…`. Some environments only
 *   expose it inside `CLAUDE_CODE_REMOTE_SDK_URL`, so that is read too.
 * - A local session with Remote Control on carries
 *   `CLAUDE_CODE_BRIDGE_SESSION_ID` (`session_…`), reachable the same way.
 * - The desktop app registers `claude://` and mirrors claude.ai paths, so the
 *   same path under `claude://claude.ai/` opens it there.
 *
 * A local session without Remote Control has no documented link of any kind,
 * so it gets none rather than a guess that opens the wrong thing.
 */

export interface SessionEnv {
  remoteSessionId?: string | null;
  remoteSdkUrl?: string | null;
  bridgeSessionId?: string | null;
  entrypoint?: string | null;
}

const ID = /^[A-Za-z0-9_-]{6,128}$/;

export function resolveLink(env: SessionEnv): { surface: SessionSurface; link: SessionLink | null } {
  const cloud = cloudSessionId(env);
  if (cloud) return { surface: 'cloud', link: linkFor(cloud, 'cloud') };

  const local = surfaceFromEntrypoint(env.entrypoint);
  const bridge = (env.bridgeSessionId ?? '').trim();
  if (bridge && ID.test(bridge)) {
    const id = bridge.startsWith('session_') ? bridge : `session_${bridge.replace(/^cse_/, '')}`;
    return { surface: local, link: linkFor(id, 'remote-control') };
  }
  return { surface: local, link: null };
}

function cloudSessionId(env: SessionEnv): string | null {
  const direct = (env.remoteSessionId ?? '').trim();
  const fromUrl = /\/sessions\/(cse_[A-Za-z0-9]+)/.exec(env.remoteSdkUrl ?? '')?.[1] ?? '';
  const raw = direct || fromUrl;
  if (!raw || !ID.test(raw)) return null;
  return raw.startsWith('session_') ? raw : `session_${raw.replace(/^cse_/, '')}`;
}

function surfaceFromEntrypoint(entrypoint: string | null | undefined): SessionSurface {
  const value = (entrypoint ?? '').toLowerCase();
  if (!value) return 'unknown';
  if (value.includes('desktop')) return 'desktop';
  if (value === 'cli') return 'cli';
  return 'unknown';
}

function linkFor(sessionId: string, via: SessionLink['via']): SessionLink {
  const path = `claude.ai/code/${sessionId}`;
  return { app: `claude://${path}`, web: `https://${path}`, via };
}
