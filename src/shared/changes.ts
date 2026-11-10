/**
 * What a change touched, as git says — the one thing every check is chosen
 * by (#52, and targeted checks).
 *
 * A check runs for the areas the change really touched, never for the
 * files a task only planned to touch, nor for areas no commit or edit in
 * it came near. One task's change is everything since the commit it began
 * at; the build's, everything since the base branch.
 *
 * Node only (it runs git): for `coplan check` and the daemon, never the page.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** More than any one change needs to be told apart; past it, the list is cut. */
const MAX_FILES = 5_000;

async function git(root: string, args: string[]): Promise<string | null> {
  // No folder: an empty cwd would run git wherever this process is.
  if (!root) return null;
  try {
    const { stdout } = await exec('git', args, { cwd: root, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

/** `-z` output: one path per NUL, so a name with spaces or quotes is whole. */
function paths(out: string | null): string[] {
  return out ? out.split('\0').filter(Boolean) : [];
}

/**
 * The ref a change is measured from: the one asked for (or its
 * `origin/` twin), else where `origin/HEAD` points, else `main` or
 * `master`. Null when none is there: then only uncommitted changes count.
 */
export async function resolveBase(root: string, base?: string | null): Promise<string | null> {
  const candidates: string[] = [];
  if (base) candidates.push(base, `origin/${base}`);
  else {
    const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim();
    if (head) candidates.push(head);
    candidates.push('main', 'master', 'origin/main', 'origin/master');
  }
  for (const ref of candidates) {
    if ((await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null) return ref;
  }
  return null;
}

export interface ChangedFiles {
  /** Every file the change touches, from the repository root. */
  files: string[];
  /** The ref the committed part was measured from; null when none was found. */
  base: string | null;
}

/**
 * Every file the change touches: committed since it left the base
 * (`git diff <base>...HEAD`), staged or not (`git diff HEAD`), and new
 * files git does not ignore. Null outside a git repository.
 */
export async function changedFiles(root: string, base?: string | null): Promise<ChangedFiles | null> {
  if ((await git(root, ['rev-parse', '--git-dir'])) === null) return null;
  const from = await resolveBase(root, base);
  const lists = await Promise.all([
    from ? git(root, ['diff', '--name-only', '-z', `${from}...HEAD`]) : Promise.resolve(null),
    git(root, ['diff', '--name-only', '-z', 'HEAD']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const files = [...new Set(lists.flatMap(paths))].sort().slice(0, MAX_FILES);
  return { files, base: from };
}

/**
 * Every file changed since `since` — committed after it, staged, unstaged
 * and new — or, with no `since`, since the last commit: the work not yet
 * committed. That is one task's change, measured where it is built. Null
 * outside a git repository, or when `since` is not a commit there.
 */
export async function changedSince(root: string, since?: string | null): Promise<ChangedFiles | null> {
  if ((await git(root, ['rev-parse', '--git-dir'])) === null) return null;
  const from = since ?? 'HEAD';
  if ((await git(root, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`])) === null) {
    // A repository with no commit yet: everything in it is new.
    if (since) return null;
    return { files: paths(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).sort(), base: null };
  }
  const lists = await Promise.all([
    git(root, ['diff', '--name-only', '-z', from]),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return { files: [...new Set(lists.flatMap(paths))].sort().slice(0, MAX_FILES), base: since ?? null };
}

/** The commit checked out in `root` now, or null outside git. */
export async function headCommit(root: string): Promise<string | null> {
  return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim() || null;
}

/** The working tree `branch` is checked out in — the repository's own or
 *  one of its worktrees — or null when it is not checked out anywhere. */
export async function worktreeOf(root: string, branch: string): Promise<string | null> {
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  if (!out) return null;
  let at: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && at) return at;
  }
  return null;
}

/** Files committed on `branch` since `since` (from where they diverged), for
 *  a branch no working tree has checked out any more; null when there is
 *  no such branch. */
export async function committedOn(root: string, since: string, branch: string): Promise<string[] | null> {
  const out = await git(root, ['diff', '--name-only', '-z', `${since}...${branch}`]);
  return out === null ? null : paths(out);
}
