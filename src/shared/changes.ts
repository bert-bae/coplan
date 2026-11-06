import type { Plan, Task } from './types.ts';
import { currentBranch, git, remoteDefaultBranch } from './git.ts';
import { SESSION_BRANCH, branchPlan, effectiveBranch, leafTasks, leavesUnder } from './build.ts';
import type { HookStage } from './project.ts';

/**
 * The files a task actually changed, from git, so the checks that gate it
 * follow the change and not only the plan. A task lists the files it
 * expects to touch; a hook limited by `paths` to a file the task touched
 * anyway must still run at review — or a check is skipped and nobody sees.
 *
 * The diff only ever adds checks: it is read alongside the files the task
 * expected, never instead of them, and where it cannot be read — or cannot
 * be told apart from other tasks' work — the expected files decide alone,
 * as they did before there was a diff.
 *
 * Every git call is asynchronous: the daemon serving the page, the hooks
 * and every session's tools must not stall on a slow repository.
 */

/** More than this many files changed and they are not matched one by one:
 *  every hook applies, which is the safe side of a list too long to read. */
const MAX_CHANGED = 20_000;

/** What changed: the files, `'all'` when too many to list, null when git
 *  cannot say. */
export type Changed = string[] | 'all' | null;

const split = (out: string, sep: string): string[] => out.split(sep).filter((f) => f.trim());

/** Whether `ref` names a commit here. A ref that reads like a flag is not one. */
export async function hasRef(cwd: string, ref: string): Promise<boolean> {
  if (!ref || ref.startsWith('-')) return false;
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null;
}

/** The base found for a folder, for a little while: it is asked for on
 *  every brief and every done, and it does not move between them. */
const bases = new Map<string, { at: number; base: string | null }>();
const BASE_TTL_MS = 30_000;

/** Forget every base found: for a test that moves branches under it. */
export function forgetBases(): void {
  bases.clear();
}

/**
 * The branch to diff against when nothing more specific is known: the one
 * the repository names (`branches.base`), else the remote's default branch,
 * else `main` or `master` — each as whichever of the local branch and
 * `origin`'s is further on. A local `main` weeks behind would count every
 * commit since as the task's work; an `origin/main` behind unpushed local
 * commits, theirs. Null when none is there. Names are tried in turn, and
 * the first found is kept.
 */
export async function defaultBase(cwd: string, configured?: string): Promise<string | null> {
  const key = `${cwd}\0${configured ?? ''}`;
  const hit = bases.get(key);
  if (hit && Date.now() - hit.at < BASE_TTL_MS) return hit.base;
  // The configured name first; git is asked for the remote's default only
  // when that is not there.
  let base = configured ? await furthest(cwd, configured) : null;
  if (!base) {
    const names = [...new Set([await remoteDefaultBranch(cwd), 'main', 'master'].filter((n): n is string => Boolean(n) && n !== configured))];
    for (const name of names) {
      base = await furthest(cwd, name);
      if (base) break;
    }
  }
  if (bases.size > 200) bases.clear();
  bases.set(key, { at: Date.now(), base });
  return base;
}

/** Of `name` and `origin/name`, the one further on: the other's descendant,
 *  or `origin`'s when they have gone separate ways. Null when neither is. */
async function furthest(cwd: string, name: string): Promise<string | null> {
  const remote = `origin/${name}`;
  const [local, upstream] = await Promise.all([hasRef(cwd, name), hasRef(cwd, remote)]);
  if (!local || !upstream) return local ? name : upstream ? remote : null;
  // Local is ahead (or level) only when origin's is its ancestor.
  return (await git(cwd, ['merge-base', '--is-ancestor', remote, name], 1024)) !== null ? name : remote;
}

export interface DiffRange {
  /** What the work is compared with. */
  base: string;
  /** The branch the work is on; `HEAD` for the checkout at `root`. */
  head: string;
}

/**
 * The files changed on `head` since it left `base` (`git diff base...head`),
 * in the repository whose root is `root` (callers know it already), by path
 * from that root — and what is not committed yet where `head` is checked
 * out: here, or in a worktree of its own. A rename counts as both of its
 * paths, and a deleted file counts: removing code is a change its tests
 * must see.
 *
 * Null when git cannot say: not a repository, or a ref that is not there.
 */
export async function changedFiles(root: string, range: DiffRange): Promise<Changed> {
  const [committed, tree] = await Promise.all([
    // A big repository's diff may take a while: more than a lookup's time.
    git(root, ['diff', '--name-only', '--no-renames', '-z', `${range.base}...${range.head}`, '--'], undefined, 30_000),
    // `HEAD`: the checkout this runs in — `coplan check`'s own.
    range.head === 'HEAD' ? Promise.resolve(root) : worktreeOf(root, range.head),
  ]);
  // Git failed with both ends there (a timeout, a huge repository): the
  // change is not known, so every hook applies — not none of the extras.
  // An end that is not there (a branch not made yet) is nothing to read.
  if (committed === null) return (await hasRef(root, range.base)) && (await hasRef(root, range.head)) ? 'all' : null;
  const files = new Set(split(committed, '\0'));
  if (tree) {
    const [unstaged, untracked] = await Promise.all([
      git(tree, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']),
      git(tree, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    for (const f of [...split(unstaged ?? '', '\0'), ...split(untracked ?? '', '\0')]) files.add(f);
  }
  return files.size > MAX_CHANGED ? 'all' : [...files];
}

/** The folder `branch` is checked out in — the repository's own, or a
 *  worktree of it — or null when it is checked out nowhere. */
async function worktreeOf(root: string, branch: string): Promise<string | null> {
  // Line by line (`-z` needs git 2.36): a path with a newline in it is the
  // one this cannot read.
  const out = await git(root, ['worktree', 'list', '--porcelain']);
  if (!out) return (await currentBranch(root)) === branch ? root : null;
  let path: string | null = null;
  for (const field of out.split('\n')) {
    if (field.startsWith('worktree ')) path = field.slice(9);
    else if (field === `branch refs/heads/${branch}` && path) return path;
  }
  return null;
}

/** Whether the branch a task lands on holds other tasks' work too: the
 *  unbranched tasks' shared branch, or a named one another task names. A
 *  parent's own subtasks are its work, not another task's. */
export function sharesBranch(plan: Pick<Plan, 'tasks'>, task: Task): boolean {
  const branch = effectiveBranch(plan, task);
  if (!branch) return true;
  const mine = new Set(leavesUnder(plan, task.id).map((t) => t.id));
  return leafTasks(plan).some((t) => t.id !== task.id && !mine.has(t.id) && t.status !== 'dropped' && effectiveBranch(plan, t) === branch);
}

/** The files a task expects to touch: its own, or for a parent, its
 *  subtasks'. What its checks are matched against, before the diff. */
export function taskFiles(plan: Pick<Plan, 'tasks'>, task: Task): string[] {
  return task.files?.length ? [...task.files] : leavesUnder(plan, task.id).flatMap((t) => t.files ?? []);
}

/**
 * Where a task's work is, as git sees it — only for a task on a branch of
 * its own: that branch, against the one it was cut from (a stacked branch's
 * lower one, the session's branch for one stacked on the unbranched tasks,
 * otherwise the base). On a branch other tasks share, their work and this
 * one's cannot be told apart, so nothing is read: the expected files decide,
 * and the brief lists what else may apply. Null then, or when there is no
 * base to compare with.
 */
export async function taskDiffRange(
  plan: Pick<Plan, 'tasks' | 'submission' | 'branches'>,
  task: Task,
  where: { cwd: string; sessionBranch?: string | null; configuredBase?: string },
): Promise<DiffRange | null> {
  const branch = effectiveBranch(plan, task);
  if (!branch || sharesBranch(plan, task)) return null;
  // What the branch was cut from: where its pull request points now, as the
  // build last said (a restack after a lower one merged moves it), else the
  // branch it stacks on — the session's, for one on the unbranched tasks'
  // work. Never the branch itself: a session that resumed on it would diff
  // it against itself, and see nothing.
  const stacked = branchPlan(plan).branches.find((b) => b.branch === branch)?.base;
  const lower = plan.branches?.[branch]?.base ?? (stacked === SESSION_BRANCH ? where.sessionBranch : stacked);
  const below = lower && lower !== branch && lower !== SESSION_BRANCH ? await furthest(where.cwd, lower) : null;
  const base = below ?? (await defaultBase(where.cwd, plan.submission?.base ?? where.configuredBase));
  return base && base !== branch ? { base, head: branch } : null;
}

/**
 * The files a stage's hooks are matched against. The implement stage runs
 * before there is a diff: the files the task expects to touch. Review and
 * final add the files it did change. A task that lists no files is matched
 * against nothing — every hook applies — and the diff does not narrow that;
 * nor does a change too large to list, which applies every hook too.
 */
export function filesForStage(stage: HookStage, expected: readonly string[], changed: Changed | undefined): string[] {
  if (stage === 'implement' || !expected.length || !changed) return [...expected];
  if (changed === 'all') return [];
  return [...new Set([...expected, ...changed])];
}
