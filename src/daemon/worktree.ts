import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

/**
 * Resolving where a worktree-isolated session actually works.
 *
 * The CLI can relocate a session into `<repo>/.claude/worktrees/<name>` after
 * it has started, but the `cwd` on every hook payload keeps naming the
 * directory the session was launched in. Believing it would point the diff,
 * the checks, and the ship stage at the wrong tree — and a `git push` from the
 * ship stage would then run against the wrong branch.
 *
 * The transcript is the one place that records the move. Two entry types carry
 * it: `worktree-state`, which is the full picture, and `relocated`, which is
 * just the new directory and is also what a session emits on its way back out.
 */

export interface WorktreeRecord {
  path: string;
  name: string;
  originalCwd: string | null;
  originalBranch: string | null;
  /** HEAD in the original tree when the session moved in — the commit the
   *  worktree's branch was forked from, and so the right base for its diff. */
  originalHeadCommit: string | null;
}

/**
 * Folds transcript entries into "which worktree is this session in, if any".
 *
 * Stateful because `relocated` on its own cannot be read: the same entry means
 * "entered a worktree" or "left one" depending on the `worktree-state` that
 * came before it.
 */
export class WorktreeResolver {
  private resolved: WorktreeRecord | null = null;
  private context: WorktreeRecord | null = null;

  /** The worktree the session is in as of the last entry fed in. */
  get current(): WorktreeRecord | null {
    return this.resolved;
  }

  /** Feed one transcript entry. True when the resolved worktree changed. */
  consume(entry: Record<string, unknown>): boolean {
    const before = this.resolved?.path ?? null;

    switch (entry['type']) {
      case 'worktree-state': {
        const record = parseWorktreeSession(entry['worktreeSession']);
        // A cleared `worktreeSession` is the CLI saying the session is out.
        this.context = record;
        this.resolved = record;
        break;
      }
      case 'relocated': {
        const to = asPath(entry['relocatedCwd']);
        if (!to) break;
        // Back where it started: the session has left the worktree.
        if (this.context && to === this.context.originalCwd) {
          this.resolved = null;
          break;
        }
        this.resolved =
          this.context && this.context.path === to
            ? this.context
            : {
                path: to,
                name: path.basename(to),
                originalCwd: null,
                originalBranch: null,
                originalHeadCommit: null,
              };
        break;
      }
      default:
        return false;
    }

    return (this.resolved?.path ?? null) !== before;
  }
}

/**
 * Read a transcript from the beginning and return the worktree it ends in.
 *
 * Needed because the tailer normally starts at the end of the file: a daemon
 * that restarts, or attaches to a session already in progress, would otherwise
 * never see the relocation that happened before it was watching. Streamed a
 * line at a time so a large transcript costs time but not memory.
 */
export async function scanTranscriptForWorktree(file: string): Promise<WorktreeRecord | null> {
  const resolver = new WorktreeResolver();
  try {
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        // Most of a transcript is messages and tool results. Skipping the JSON
        // parse unless the line mentions one of the two entry types keeps a
        // full scan of a multi-megabyte file cheap.
        if (!line.includes('"relocated') && !line.includes('"worktree-state"')) continue;
        try {
          resolver.consume(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* a partially-written line */
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  } catch {
    return null;
  }
  return resolver.current;
}

function parseWorktreeSession(value: unknown): WorktreeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const worktreePath = asPath(rec['worktreePath']);
  if (!worktreePath) return null;
  return {
    path: worktreePath,
    name: asString(rec['worktreeName']) ?? path.basename(worktreePath),
    originalCwd: asPath(rec['originalCwd']) ?? asPath(rec['preEnterOriginalCwd']),
    originalBranch: asString(rec['originalBranch']),
    originalHeadCommit: asString(rec['originalHeadCommit']),
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Absolute paths only: a relative one cannot be resolved without knowing the
 *  cwd it was relative to, and guessing would anchor git somewhere arbitrary. */
function asPath(value: unknown): string | null {
  const str = asString(value);
  return str && path.isAbsolute(str) ? path.normalize(str) : null;
}

export const _internals = { parseWorktreeSession };
