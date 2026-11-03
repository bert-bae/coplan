import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The little git the planner needs: which repository and branch a session is
 * in, so the rail can group and label it. Nothing here writes.
 */

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function repoRoot(cwd: string): Promise<string | null> {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const name = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return name && name !== 'HEAD' ? name : null;
}
