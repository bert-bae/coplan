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

/** More than any one change needs to be told apart; past it, the change is
 *  not listed (`unread: 'too-many'`) and every check applies. */
export const MAX_FILES = 5_000;
const OPTS = { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 } as const;

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd: root, ...OPTS });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Whether `ref` names a commit: true; false when git says there is none
 * (`rev-parse --verify --quiet` exits 1, silently, for a ref that is not
 * there, or a repository with no commit yet); null when git could not say
 * (it failed or timed out). A failure is never taken for "not there".
 */
async function hasCommit(root: string, ref: string): Promise<boolean | null> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, ...OPTS });
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === 1 ? false : null;
  }
}

/** `-z` output: one path per NUL, so a name with spaces or quotes is whole. */
function paths(out: string | null): string[] {
  return out ? out.split('\0').filter(Boolean) : [];
}

/**
 * One change from the lists git gave for it. A list git could not give
 * (it failed, timed out, or said more than fits) is not an empty one: the
 * change is then `unread`, and so is one too long to hold. Every check is
 * targeted to the change, so an unread one must never pass for "nothing
 * changed" — that would ask for no checks at all.
 */
function listed(lists: (string | null)[], base: string | null): ChangedFiles {
  if (lists.some((l) => l === null)) return { files: [], base, unread: 'git-failed' };
  const files = [...new Set(lists.flatMap(paths))].sort();
  return files.length > MAX_FILES ? { files: files.slice(0, MAX_FILES), base, unread: 'too-many' } : { files, base };
}

/**
 * The ref a change is measured from: the one asked for (or its
 * `origin/` twin), else where `origin/HEAD` points, else `main` or
 * `master`. `ref` is null when none is there; `failed` when git could not
 * say for one tried before it, which might have been the one.
 */
async function findBase(root: string, base?: string | null): Promise<{ ref: string | null; failed: boolean }> {
  const candidates: string[] = [];
  if (base) candidates.push(base, `origin/${base}`);
  else {
    const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim();
    if (head) candidates.push(head);
    candidates.push('main', 'master', 'origin/main', 'origin/master');
  }
  for (const ref of candidates) {
    const has = await hasCommit(root, ref);
    if (has === null) return { ref: null, failed: true };
    if (has) return { ref, failed: false };
  }
  return { ref: null, failed: false };
}

/** The ref a change is measured from (see findBase), or null when none is
 *  there or git could not say. */
export async function resolveBase(root: string, base?: string | null): Promise<string | null> {
  return (await findBase(root, base)).ref;
}

export interface ChangedFiles {
  /** Every file the change touches, from the repository root. */
  files: string[];
  /** The ref the committed part was measured from; null when none was found. */
  base: string | null;
  /** Set when `files` is not the whole change: git could not read it
   *  (`git-failed`), it is more than MAX_FILES (`too-many`), or there is no
   *  base branch to measure it from (`no-base`). Then every check applies,
   *  as for a change nobody can see. */
  unread?: 'git-failed' | 'too-many' | 'no-base';
}

/** Why a change could not be told, as a clause: "what it changed cannot be
 *  told: <this>". One wording for the done gate and `coplan check`. */
export function unreadWords(c: ChangedFiles): string {
  return c.unread === 'too-many'
    ? `it is more than ${MAX_FILES.toLocaleString('en')} files`
    : c.unread === 'no-base'
      ? 'no base branch was found to measure it from (set branches.base in .coplan/config.json)'
      : 'git could not read it (it failed or took too long)';
}

/**
 * Every file the change touches: committed since it left the base
 * (`git diff <base>...HEAD`), staged or not (`git diff HEAD`), and new
 * files git does not ignore. Null outside a git repository. With no base
 * branch to measure from, the change is `unread` ('no-base'): what is not
 * committed alone would leave out the whole build.
 */
export async function changedFiles(root: string, base?: string | null): Promise<ChangedFiles | null> {
  if ((await git(root, ['rev-parse', '--git-dir'])) === null) return null;
  const head = await hasCommit(root, 'HEAD');
  if (head === null) return { files: [], base: null, unread: 'git-failed' };
  if (!head) return unborn(root);
  const from = await findBase(root, base);
  if (from.failed) return { files: [], base: null, unread: 'git-failed' };
  if (!from.ref) return { files: [], base: null, unread: 'no-base' };
  const lists = await Promise.all([
    git(root, ['diff', '--name-only', '-z', `${from.ref}...HEAD`]),
    git(root, ['diff', '--name-only', '-z', 'HEAD']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return listed(lists, from.ref);
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
  const has = await hasCommit(root, from);
  if (has === null) return { files: [], base: since ?? null, unread: 'git-failed' };
  if (!has) return since ? null : unborn(root);
  const lists = await Promise.all([
    git(root, ['diff', '--name-only', '-z', from]),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return listed(lists, since ?? null);
}

/** A repository with no commit yet: everything in it is new — staged, or
 *  not yet added. (There is no HEAD to diff against, which is not a
 *  failure to read.) */
async function unborn(root: string): Promise<ChangedFiles> {
  return listed(await Promise.all([git(root, ['ls-files', '-z']), git(root, ['ls-files', '--others', '--exclude-standard', '-z'])]), null);
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
 *  no such branch. A branch that is there but whose diff git could not
 *  read is `unread`, not empty. */
export async function committedOn(root: string, since: string, branch: string): Promise<ChangedFiles | null> {
  const has = await hasCommit(root, branch);
  if (has === false) return null;
  if (has === null) return { files: [], base: since, unread: 'git-failed' };
  return listed([await git(root, ['diff', '--name-only', '-z', `${since}...${branch}`])], since);
}
