import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchPr, prRef, runGh, snapshotFrom } from '../daemon/github.ts';
import { prEvents } from '../shared/prEvents.ts';

/** A pull request read with the user's own `gh`: one GraphQL query, mapped onto what prEvents reads. */

const answer = (over: Record<string, unknown> = {}) => ({
  data: {
    viewer: { login: 'coplan-bot' },
    repository: {
      pullRequest: {
        number: 7,
        state: 'OPEN',
        url: 'https://github.com/o/r/pull/7',
        mergeStateStatus: 'BEHIND',
        headRefOid: 'aaa',
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      { __typename: 'CheckRun', databaseId: 11, name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/11' },
                      { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE', targetUrl: 'https://legacy/1' },
                    ],
                  },
                },
              },
            },
          ],
        },
        reviews: { nodes: [{ databaseId: 5, author: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'Split it.', submittedAt: '2026-11-20T00:00:00Z', url: 'https://x/r5' }] },
        reviewThreads: { nodes: [{ comments: { nodes: [{ databaseId: 8, author: { login: 'bob' }, body: 'Use a map.', path: 'src/a.ts', line: 3, url: 'https://x/c8', createdAt: '2026-11-20T00:00:00Z' }] } }] },
        comments: { nodes: [{ databaseId: 9, author: { login: 'coplan-bot' }, body: 'Fixed.', url: 'https://x/i9', createdAt: '2026-11-20T00:00:00Z' }] },
        ...over,
      },
    },
  },
});

test('prRef: from the link (GitHub or Enterprise), else the number; not a GitLab merge request', () => {
  assert.deepEqual(prRef({ url: 'https://github.com/o/r/pull/7' }), { owner: 'o', repo: 'r', number: 7 });
  assert.deepEqual(prRef({ url: 'https://ghe.corp/o/r/pull/12/files' }), { host: 'ghe.corp', owner: 'o', repo: 'r', number: 12 });
  assert.deepEqual(prRef({ number: 3 }), { number: 3 });
  assert.equal(prRef({ url: 'https://gitlab.com/o/r/-/merge_requests/4', number: 4 }), null);
  assert.equal(prRef({}), null);
});

test('the answer, mapped: legacy commit statuses count as CI, and the viewer is who Coplan is', () => {
  const read = snapshotFrom(answer())!;
  assert.equal(read.viewer, 'coplan-bot');
  assert.equal(read.snapshot.pr.mergeable_state, 'behind');
  const { events } = prEvents(read.snapshot, { state: 'open' }, { self: read.viewer });
  assert.deepEqual(
    events.map((e) => e.id),
    ['review:5', 'rc:8', 'ci:aaa:failed', 'mergeable:aaa:behind'],
    "the legacy status fails CI; Coplan's own comment is not an event",
  );
  assert.deepEqual(events.find((e) => e.kind === 'ci_failed')!.checks, [{ name: 'ci/legacy', conclusion: 'failure', url: 'https://legacy/1' }]);
  assert.equal(snapshotFrom(answer({ state: 'MERGED' }))!.snapshot.pr.merged, true);
  assert.equal(snapshotFrom({ data: { repository: { pullRequest: null } } }), null);
});

test('fetchPr runs the real gh: its answer, its failure in its own words, or how to install it', { skip: process.platform === 'win32' }, async () => {
  const bin = mkdtempSync(path.join(tmpdir(), 'coplan-gh-'));
  const oldPath = process.env['PATH'];
  try {
    const fixture = path.join(bin, 'answer.json');
    writeFileSync(fixture, JSON.stringify(answer()));
    // The fake gh records its arguments, so the query's address is checked too.
    writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\ncat "${fixture}"\n`);
    chmodSync(path.join(bin, 'gh'), 0o755);
    process.env['PATH'] = `${bin}:${oldPath}`;
    const read = await fetchPr({ host: 'ghe.corp', owner: 'o', repo: 'r', number: 7 }, bin);
    assert.equal(read.snapshot.pr.number, 7);
    const args = readFileSync(path.join(bin, 'args'), 'utf8').split('\n');
    assert.deepEqual(args.slice(0, 10), ['api', 'graphql', '--hostname', 'ghe.corp', '-F', 'owner=o', '-F', 'repo=r', '-F', 'number=7']);
    await fetchPr({ number: 7 }, bin);
    assert.ok(readFileSync(path.join(bin, 'args'), 'utf8').includes('owner={owner}'), 'no link: gh fills the owner from the remote');

    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "gh: To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4\n');
    await assert.rejects(fetchPr({ number: 7 }, bin), /gh api failed: gh: To get started with GitHub CLI/);

    process.env['PATH'] = path.join(bin, 'nowhere');
    await assert.rejects(fetchPr({ number: 7 }, bin), /gh is not installed/);
    assert.equal((await runGh(['--version'], bin)).code, 127);
  } finally {
    process.env['PATH'] = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
