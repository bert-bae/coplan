import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The little git Coplan needs, read-only and asynchronous: which repository
 * and branch a folder is in, the remote's default branch, and the raw output
 * of a command for whoever reads more (the files a task changed). One place,
 * so the daemon, the CLI and `coplan init` agree on what they find.
 */

const exec = promisify(execFile);

/** stdout of a git command, as it came — null when it failed. Paths come
 *  unquoted (`core.quotePath=false`), so a file named in UTF-8 reads as itself. */
export async function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024, timeout = 5_000): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', timeout, maxBuffer });
    return stdout;
  } catch {
    return null;
  }
}

const line = async (cwd: string, args: string[]): Promise<string | null> => (await git(cwd, args, 1024 * 1024))?.trim() || null;

export async function repoRoot(cwd: string): Promise<string | null> {
  return line(cwd, ['rev-parse', '--show-toplevel']);
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const name = await line(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return name && name !== 'HEAD' ? name : null;
}

/** The branch `origin` says is its default, by name ("main"); null when
 *  there is no `origin`, or it does not say. */
export async function remoteDefaultBranch(cwd: string): Promise<string | null> {
  const ref = await line(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  return ref?.replace(/^refs\/remotes\/origin\//, '') || null;
}
