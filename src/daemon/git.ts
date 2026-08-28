import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseUnifiedDiff } from '../shared/diffparse.ts';
import type { DiffFile, DiffPayload, ReviewRoundSnapshot } from '../shared/types.ts';

const exec = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

export async function git(cwd: string, args: string[], timeout = 20_000): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd, timeout, maxBuffer: MAX_BUFFER });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', '--show-toplevel']);
  return res.ok ? res.stdout.trim() || null : null;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = res.stdout.trim();
  return res.ok && name && name !== 'HEAD' ? name : null;
}

export async function headCommit(cwd: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', 'HEAD']);
  return res.ok ? res.stdout.trim() || null : null;
}

/**
 * The branch a PR would target. Tries the remote's default, then common
 * names, then falls back to whatever HEAD is.
 */
export async function defaultBranch(cwd: string): Promise<string | null> {
  const symbolic = await git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic.ok) {
    const ref = symbolic.stdout.trim();
    const name = ref.split('/').pop();
    if (name) return name;
  }
  for (const candidate of ['main', 'master', 'develop']) {
    const res = await git(cwd, ['rev-parse', '--verify', '--quiet', candidate]);
    if (res.ok && res.stdout.trim()) return candidate;
  }
  return null;
}

/**
 * Pick the ref to diff against.
 *
 * Order: explicit → merge-base with the default branch → the commit the
 * session started at → HEAD. The session-start commit is what makes the
 * review view useful on a branch that was already ahead of main.
 */
export async function resolveBaseRef(
  cwd: string,
  opts: { explicit?: string | null; startCommit?: string | null } = {},
): Promise<string> {
  if (opts.explicit) {
    const res = await git(cwd, ['rev-parse', '--verify', '--quiet', `${opts.explicit}^{commit}`]);
    if (res.ok && res.stdout.trim()) return opts.explicit;
  }

  const def = await defaultBranch(cwd);
  const branch = await currentBranch(cwd);
  if (def && branch && def !== branch) {
    const mb = await git(cwd, ['merge-base', 'HEAD', def]);
    if (mb.ok && mb.stdout.trim()) return mb.stdout.trim();
  }

  if (opts.startCommit) {
    const res = await git(cwd, ['rev-parse', '--verify', '--quiet', `${opts.startCommit}^{commit}`]);
    if (res.ok && res.stdout.trim()) return opts.startCommit;
  }

  // Empty repository: no HEAD yet, so diff against the empty tree.
  const head = await headCommit(cwd);
  if (!head) return EMPTY_TREE;
  return head;
}

/** git's canonical empty tree object, for diffing a repo with no commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function untrackedFiles(cwd: string): Promise<string[]> {
  const res = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!res.ok) return [];
  return res.stdout.split('\0').filter(Boolean);
}

/**
 * Build the review payload: committed changes since `baseRef` plus everything
 * still in the working tree, including untracked files.
 */
export async function computeDiff(
  cwd: string,
  opts: {
    baseRef?: string | null;
    startCommit?: string | null;
    maxFileBytes?: number;
    /** The previous round, for marking what has changed since. */
    previous?: ReviewRoundSnapshot | null;
    round?: number;
  } = {},
): Promise<DiffPayload> {
  const root = (await repoRoot(cwd)) ?? cwd;
  const baseRef = await resolveBaseRef(root, {
    explicit: opts.baseRef ?? null,
    startCommit: opts.startCommit ?? null,
  });
  const branch = await currentBranch(root);
  const maxBytes = opts.maxFileBytes ?? 400_000;

  const args = [
    '--no-pager',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    '-U5',
    baseRef,
    '--',
    '.',
  ];
  const res = await git(root, args, 30_000);
  const files: DiffFile[] = res.stdout ? parseUnifiedDiff(res.stdout) : [];

  // Untracked files never appear in `git diff`; synthesise an "added" entry.
  for (const rel of await untrackedFiles(root)) {
    if (files.some((f) => f.path === rel)) continue;
    const added = await diffUntracked(root, rel, maxBytes);
    if (added) files.push(added);
  }

  for (const file of files) {
    const size = file.hunks?.reduce((n, h) => n + h.lines.length, 0) ?? 0;
    if (size * 80 > maxBytes) {
      file.truncated = true;
      delete file.hunks;
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  // Mark what moved since the reviewer last looked, so round three is not a
  // cold read of the whole change.
  const previous = opts.previous ?? null;
  let changedSinceLastReview: string[] | undefined;
  if (previous) {
    changedSinceLastReview = [];
    for (const file of files) {
      const before = previous.fingerprints[file.path];
      const now = fingerprint(file);
      const changed = before !== now;
      file.changedSinceLastReview = changed;
      if (changed) changedSinceLastReview.push(file.path);
    }
  }

  return {
    baseRef,
    headRef: (await headCommit(root)) ?? 'HEAD',
    branch,
    generatedAt: Date.now(),
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    includesWorkingTree: true,
    round: opts.round ?? 1,
    ...(previous ? { previousRound: previous.round } : {}),
    ...(changedSinceLastReview ? { changedSinceLastReview } : {}),
  };
}

/** A cheap content hash of a file's diff. Two rounds that produce the same
 *  hunks for a path mean the reviewer has already seen that file's state. */
export function fingerprint(file: DiffFile): string {
  const body = (file.hunks ?? [])
    .map((h) => `${h.oldStart},${h.newStart}:${h.lines.map((l) => `${l.kind}${l.text}`).join('\n')}`)
    .join('\n@@\n');
  return createHash('sha1')
    .update(`${file.status}:${file.additions}:${file.deletions}:${body}`)
    .digest('hex')
    .slice(0, 16);
}

export function snapshotRound(diff: DiffPayload, round: number): ReviewRoundSnapshot {
  const fingerprints: Record<string, string> = {};
  for (const file of diff.files) fingerprints[file.path] = fingerprint(file);
  return { round, at: Date.now(), baseRef: diff.baseRef, headRef: diff.headRef, fingerprints };
}

async function diffUntracked(root: string, rel: string, maxBytes: number): Promise<DiffFile | null> {
  const res = await git(root, [
    '--no-pager',
    'diff',
    '--no-color',
    '--no-index',
    '--find-renames',
    '-U5',
    '/dev/null',
    rel,
  ]);
  // `--no-index` exits 1 when files differ, which is the normal case here.
  const out = res.stdout;
  if (!out) return null;
  const parsed = parseUnifiedDiff(out);
  const file = parsed[0];
  if (!file) return null;
  file.path = rel;
  file.status = 'added';
  delete file.oldPath;
  const size = file.hunks?.reduce((n, h) => n + h.lines.length, 0) ?? 0;
  if (size * 80 > maxBytes) {
    file.truncated = true;
    delete file.hunks;
  }
  return file;
}

/**
 * Content hash of every file that differs from HEAD, tracked or not.
 *
 * Attribution cannot rely on `Edit`/`Write` tool calls: plenty of sessions
 * change files through the shell — a heredoc, `sed`, a formatter — and those
 * leave no tool event to hang a file on. Comparing the working tree before and
 * after a task catches the change however it was made.
 */
export async function workingTreeFingerprints(cwd: string): Promise<Record<string, string>> {
  const status = await git(cwd, ['status', '--porcelain', '-z']);
  if (!status.ok) return {};

  const paths: string[] = [];
  // Porcelain v1 with -z: "XY <path>\0", and renames add a second \0 field.
  const entries = status.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code[0] === 'R' || code[1] === 'R') i++; // skip the rename source
  }
  if (paths.length === 0) return {};

  const hashed = await git(cwd, ['hash-object', '--', ...paths]);
  const hashes = hashed.stdout.split('\n').filter(Boolean);
  const out: Record<string, string> = {};
  paths.forEach((file, i) => {
    // A deleted file has no blob to hash; mark it so its removal still counts.
    out[file] = hashes[i] ?? 'absent';
  });
  return out;
}

/** Paths whose content differs between two fingerprint snapshots. */
export function changedBetween(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((p) => before[p] !== after[p]).sort();
}

export async function isDirty(cwd: string): Promise<boolean> {
  const res = await git(cwd, ['status', '--porcelain']);
  return res.ok && res.stdout.trim().length > 0;
}

export async function shortLog(cwd: string, baseRef: string, limit = 30): Promise<string[]> {
  const res = await git(cwd, ['--no-pager', 'log', '--oneline', `${baseRef}..HEAD`, `-${limit}`]);
  if (!res.ok) return [];
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function relativeTo(root: string, file: string): string {
  return path.relative(root, file) || file;
}
