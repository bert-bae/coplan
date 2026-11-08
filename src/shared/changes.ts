/**
 * The files a change touches, as git sees them (#52).
 *
 * A hook limited to some files (`paths`) runs for a task that touches them.
 * Before there is a diff — the implement stage — that can only be the files
 * the task planned to touch. At review and at the end there is a diff, and
 * a task that edited a file outside its plan must not skip the check for
 * it: so those stages match the files the change really touched as well.
 *
 * Node only (it runs git): for `coplan check` and the daemon, never the page.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** More than any one change needs to be told apart; past it, the list is cut. */
const MAX_FILES = 5_000;

async function git(root: string, args: string[]): Promise<string | null> {
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
 * The files a stage's hooks are matched against: the files the task
 * planned to touch, and — at review and at the end, once there is a diff —
 * the files the change touched. A task that names no files gets every hook
 * whatever it changed, as before: the diff only ever adds checks.
 */
export function filesForStage(stage: 'implement' | 'review' | 'final', planned: readonly string[] | undefined, changed: readonly string[] | undefined): string[] {
  const own = [...(planned ?? [])];
  if (stage === 'implement' || !own.length || !changed?.length) return own;
  return [...new Set([...own, ...changed])];
}
