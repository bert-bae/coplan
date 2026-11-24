import { execFile } from 'node:child_process';
import type { GhSnapshot } from '../shared/prEvents.ts';

/**
 * A pull request on GitHub, as one snapshot per poll — read with the user's
 * own `gh`, so Coplan needs no token of its own.
 *
 * One GraphQL query a poll (a rate-limit point, where the REST endpoints
 * would be five calls), mapped onto the REST shapes `prEvents` reads.
 * `statusCheckRollup` carries both check runs and the older commit
 * statuses, so CI reported either way is seen.
 */

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `gh` with these arguments in a folder: the real one, or a test's. */
export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>;

export const runGh: GhRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? (err as Error).message : '')) });
    });
  });

/** Where a pull request is: from its link, else the folder's own remote. */
export interface PrRef {
  host?: string;
  owner?: string;
  repo?: string;
  number: number;
}

/** A recorded pull request's address, or null when it cannot be watched
 *  here (no number, or a link that is not a GitHub pull request). */
export function prRef(pr: { url?: string; number?: number }): PrRef | null {
  if (pr.url) {
    const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pr.url);
    if (!m) return null;
    const [, host, owner, repo, num] = m as unknown as [string, string, string, string, string];
    // GitLab's merge requests are /-/merge_requests/: not matched above.
    return { ...(host !== 'github.com' ? { host } : {}), owner, repo, number: Number(num) };
  }
  return pr.number ? { number: pr.number } : null;
}

// shortcut: the newest 50 reviews, 50 threads × 20 comments and 50 comments a poll; more inside one interval are missed, page if that ever bites.
export const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number state url mergeStateStatus headRefOid author { login }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
      reviews(last: 50) { nodes { databaseId author { login } authorAssociation state body submittedAt url } }
      reviewThreads(last: 50) { nodes { comments(last: 20) { nodes { databaseId author { login } authorAssociation body path line url createdAt } } } }
      comments(last: 50) { nodes { databaseId author { login } authorAssociation body url createdAt } }
    }
  }
}`;

type Node = Record<string, unknown>;
const nodes = (v: unknown): Node[] => ((v as { nodes?: unknown } | null)?.nodes as Node[] | undefined)?.filter(Boolean) ?? [];
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const user = (v: unknown) => ({ login: str((v as Node | null)?.['login']) });
const assoc = (n: Node) => (str(n['authorAssociation']) ? { author_association: str(n['authorAssociation'])! } : {});

/** A commit status as a check run: SUCCESS/FAILURE/ERROR/PENDING/EXPECTED. */
function fromStatus(n: Node, i: number): NonNullable<GhSnapshot['checkRuns']>[number] {
  const state = String(n['state'] ?? '').toUpperCase();
  const done = state === 'SUCCESS' || state === 'FAILURE' || state === 'ERROR';
  // Statuses have no id; a negative one never meets a check run's.
  return { id: -1 - i, name: str(n['context']) ?? 'status', status: done ? 'completed' : 'in_progress', conclusion: done ? (state === 'SUCCESS' ? 'success' : 'failure') : null, ...(str(n['targetUrl']) ? { html_url: str(n['targetUrl'])! } : {}) };
}

/** The GraphQL answer as the REST shapes, and who `gh` is logged in as. */
export function snapshotFrom(data: unknown): { snapshot: GhSnapshot; viewer?: string } | null {
  const d = (data as { data?: Node } | null)?.data;
  const pr = ((d?.['repository'] as Node | null)?.['pullRequest'] ?? null) as Node | null;
  if (!pr) return null;
  const state = String(pr['state'] ?? '');
  const commit = nodes(pr['commits'])[0]?.['commit'] as Node | undefined;
  const contexts = nodes((commit?.['statusCheckRollup'] as Node | null | undefined)?.['contexts']);
  const snapshot: GhSnapshot = {
    pr: {
      number: Number(pr['number']),
      state: state === 'OPEN' ? 'open' : 'closed',
      merged: state === 'MERGED',
      ...(str(pr['url']) ? { html_url: str(pr['url'])! } : {}),
      mergeable_state: String(pr['mergeStateStatus'] ?? 'unknown').toLowerCase(),
      head: { sha: String(pr['headRefOid'] ?? '') },
      user: user(pr['author']),
    },
    checkRuns: contexts.map((n, i) =>
      n['__typename'] === 'StatusContext'
        ? fromStatus(n, i)
        : {
            id: Number(n['databaseId']),
            name: String(n['name'] ?? ''),
            status: String(n['status'] ?? '').toLowerCase(),
            conclusion: n['conclusion'] ? String(n['conclusion']).toLowerCase() : null,
            ...(str(n['detailsUrl']) ? { html_url: str(n['detailsUrl'])! } : {}),
          },
    ),
    reviews: nodes(pr['reviews']).map((n) => ({ id: Number(n['databaseId']), user: user(n['author']), ...assoc(n), state: String(n['state'] ?? ''), body: str(n['body']) ?? null, submitted_at: str(n['submittedAt']), html_url: str(n['url']) })),
    reviewComments: nodes(pr['reviewThreads']).flatMap((t) =>
      nodes(t['comments']).map((n) => ({ id: Number(n['databaseId']), user: user(n['author']), ...assoc(n), body: str(n['body']), path: str(n['path']), line: typeof n['line'] === 'number' ? n['line'] : null, html_url: str(n['url']), created_at: str(n['createdAt']) })),
    ),
    issueComments: nodes(pr['comments']).map((n) => ({ id: Number(n['databaseId']), user: user(n['author']), ...assoc(n), body: str(n['body']), html_url: str(n['url']), created_at: str(n['createdAt']) })),
  };
  const viewer = str((d?.['viewer'] as Node | null)?.['login']);
  return { snapshot, ...(viewer ? { viewer } : {}) };
}

/** One poll of a pull request. Throws with gh's own words when it fails. */
export async function fetchPr(ref: PrRef, cwd: string, gh: GhRunner = runGh): Promise<{ snapshot: GhSnapshot; viewer?: string }> {
  const args = ['api', 'graphql', ...(ref.host ? ['--hostname', ref.host] : [])];
  // Without a link, gh fills {owner} and {repo} from the folder's remote.
  args.push('-F', `owner=${ref.owner ?? '{owner}'}`, '-F', `repo=${ref.repo ?? '{repo}'}`, '-F', `number=${ref.number}`, '-f', `query=${PR_QUERY}`);
  const out = await gh(args, cwd);
  if (out.code === 127 && !out.stdout) throw new Error('gh is not installed: install the GitHub CLI and run `gh auth login` to watch pull requests.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    throw new Error(`gh api failed: ${(out.stderr || out.stdout).trim().split('\n')[0] || `exit ${out.code}`}`);
  }
  const errors = (parsed as { errors?: { message?: string }[] }).errors;
  const result = snapshotFrom(parsed);
  if (!result) throw new Error(`gh api: ${errors?.[0]?.message ?? `no pull request #${ref.number}`}`);
  return result;
}
