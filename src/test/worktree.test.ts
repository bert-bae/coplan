import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorktreeResolver, scanTranscriptForWorktree } from '../daemon/worktree.ts';
import { workingTreeFingerprints } from '../daemon/git.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
import { ingestHook, type IngestContext } from '../daemon/hookIngest.ts';
import type { TranscriptTailer } from '../daemon/transcript.ts';

/**
 * A worktree-isolated session works in `<repo>/.claude/worktrees/<name>` but
 * every hook payload keeps naming the directory it was launched in. If the
 * harness believes that, it reviews an empty diff and ships the wrong branch.
 */

let home: string;
let repo: string;
let worktree: string;

function git(args: string[], cwd = repo): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-wt-home-'));
  repo = mkdtempSync(path.join(tmpdir(), 'cc-harness-wt-repo-'));
  process.env['CC_HARNESS_HOME'] = home;

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial']);

  // The real layout: a linked worktree nested inside the main working tree.
  worktree = path.join(repo, '.claude', 'worktrees', 'feature+ui');
  mkdirSync(path.dirname(worktree), { recursive: true });
  git(['worktree', 'add', '-q', '-b', 'feature/ui', worktree]);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function writeTranscript(file: string, entries: unknown[]): void {
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const enteredEntries = (worktreePath: string, head: string) => [
  { type: 'user', message: { content: 'hello' } },
  { type: 'relocated', relocatedCwd: worktreePath },
  {
    type: 'worktree-state',
    worktreeSession: {
      originalCwd: repo,
      preEnterOriginalCwd: repo,
      worktreePath,
      worktreeName: 'feature/ui',
      originalBranch: 'main',
      originalHeadCommit: head,
    },
  },
];

test('resolver: a relocation into a worktree is recognised', () => {
  const resolver = new WorktreeResolver();
  assert.equal(resolver.consume({ type: 'assistant' }), false);
  assert.equal(resolver.consume({ type: 'relocated', relocatedCwd: worktree }), true);
  assert.equal(resolver.current?.path, worktree);
});

test('resolver: relocating back to the original directory leaves the worktree', () => {
  const resolver = new WorktreeResolver();
  for (const entry of enteredEntries(worktree, 'abc123')) {
    resolver.consume(entry as Record<string, unknown>);
  }
  assert.equal(resolver.current?.name, 'feature/ui');
  assert.equal(resolver.current?.originalCwd, repo);

  // `relocated` alone is ambiguous — it is also how leaving is recorded.
  assert.equal(resolver.consume({ type: 'relocated', relocatedCwd: repo }), true);
  assert.equal(resolver.current, null);
});

test('resolver: a relative path is ignored rather than anchoring git somewhere arbitrary', () => {
  const resolver = new WorktreeResolver();
  assert.equal(resolver.consume({ type: 'relocated', relocatedCwd: '../elsewhere' }), false);
  assert.equal(resolver.current, null);
});

test('scan: the last relocation in a transcript wins', async () => {
  const file = path.join(home, 'scan.jsonl');
  writeTranscript(file, [
    ...enteredEntries(worktree, 'abc123'),
    { type: 'assistant', message: { content: [] } },
  ]);
  const found = await scanTranscriptForWorktree(file);
  assert.equal(found?.path, worktree);
  assert.equal(found?.originalHeadCommit, 'abc123');

  writeTranscript(file, [...enteredEntries(worktree, 'abc123'), { type: 'relocated', relocatedCwd: repo }]);
  assert.equal(await scanTranscriptForWorktree(file), null);
});

test('scan: a missing transcript resolves to no worktree rather than throwing', async () => {
  assert.equal(await scanTranscriptForWorktree(path.join(home, 'nope.jsonl')), null);
});

test('fingerprints: a nested worktree does not shift every hash onto the wrong file', async () => {
  // git reports a worktree it will not descend into as one entry with a
  // trailing slash. Feeding it to `hash-object` aborts the batch part-way, so
  // the remaining hashes used to be zipped onto the wrong paths.
  writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  writeFileSync(path.join(repo, 'z.ts'), 'export const z = 1;\n');

  const before = await workingTreeFingerprints(repo);
  assert.ok(before['a.ts'], 'the file before the worktree entry is hashed');
  assert.ok(before['z.ts'], 'the file after it is hashed too');
  assert.notEqual(before['a.ts'], before['z.ts'], 'each file gets its own hash');
  assert.ok(
    !Object.keys(before).some((p) => p.endsWith('/')),
    'no directory entry survives into the fingerprints',
  );

  writeFileSync(path.join(repo, 'z.ts'), 'export const z = 2;\n');
  const after = await workingTreeFingerprints(repo);
  assert.equal(after['a.ts'], before['a.ts'], 'the untouched file is unchanged');
  assert.notEqual(after['z.ts'], before['z.ts'], 'the edited file is seen to change');

  rmSync(path.join(repo, 'a.ts'));
  rmSync(path.join(repo, 'z.ts'));
});

test('SessionStart: a relocated session is anchored on the worktree, not its launch directory', async () => {
  const { SessionStore } = await import('../daemon/store.ts');
  const store = new SessionStore();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  const transcript = path.join(home, 'session.jsonl');
  writeTranscript(transcript, enteredEntries(worktree, head));

  const ctx: IngestContext = {
    store,
    config: DEFAULT_CONFIG,
    uiUrl: (id) => `http://127.0.0.1/s/${id}`,
    tailers: new Map<string, TranscriptTailer>(),
  };

  // What the CLI actually sends: the directory the session was launched in.
  await ingestHook(
    'SessionStart',
    { session_id: 'wt1', cwd: repo, transcript_path: transcript, start_reason: 'startup' },
    ctx,
  );

  const session = store.get('wt1')!;
  assert.equal(session.cwd, worktree, 'the session works in the worktree');
  assert.equal(session.repoRoot, worktree, 'git runs against the worktree');
  assert.equal(session.branch, 'feature/ui', 'the branch is the worktree’s, not main');
  assert.equal(session.worktree?.name, 'feature/ui');
  assert.equal(session.worktree?.mainRoot, repo, 'the owning repository is still known');
  assert.equal(session.worktree?.originalCwd, repo);
  assert.equal(session.startCommit, head, 'the diff base is the commit it forked from');

  // The MCP server still reports the launch directory, so that must resolve.
  assert.equal(store.findByCwd(repo)?.sessionId, 'wt1');
  assert.equal(store.findByCwd(worktree)?.sessionId, 'wt1');

  // What the switcher and `harness status` render: the repository it belongs
  // to, plus the worktree that tells it apart from its siblings.
  const summary = store.summaries().find((s) => s.sessionId === 'wt1')!;
  assert.equal(summary.repoName, path.basename(repo), 'named for the repo, not the worktree directory');
  assert.equal(summary.worktree, 'feature/ui');
  assert.equal(summary.branch, 'feature/ui');

  for (const tailer of ctx.tailers.values()) tailer.close();
});

test('SessionStart: compacting does not re-anchor a relocated session on its launch directory', async () => {
  const { SessionStore } = await import('../daemon/store.ts');
  const store = new SessionStore();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  const transcript = path.join(home, 'compact.jsonl');
  writeTranscript(transcript, enteredEntries(worktree, head));

  const ctx: IngestContext = {
    store,
    config: DEFAULT_CONFIG,
    uiUrl: (id) => `http://127.0.0.1/s/${id}`,
    tailers: new Map<string, TranscriptTailer>(),
  };
  const start = (reason: string) =>
    ingestHook(
      'SessionStart',
      { session_id: 'wt3', cwd: repo, transcript_path: transcript, start_reason: reason },
      ctx,
    );

  await start('startup');
  assert.equal(store.get('wt3')!.repoRoot, worktree);

  // The transcript has already been scanned, so this second SessionStart is on
  // its own — and its `cwd` is still the directory the session was launched in.
  await start('compact');
  const session = store.get('wt3')!;
  assert.equal(session.repoRoot, worktree, 'still anchored on the worktree');
  assert.equal(session.branch, 'feature/ui');
  assert.equal(session.worktree?.name, 'feature/ui');

  for (const tailer of ctx.tailers.values()) tailer.close();
});

test('SessionStart: a session with no worktree is left anchored where it started', async () => {
  const { SessionStore } = await import('../daemon/store.ts');
  const store = new SessionStore();

  const transcript = path.join(home, 'plain.jsonl');
  writeTranscript(transcript, [{ type: 'user', message: { content: 'hi' } }]);

  const ctx: IngestContext = {
    store,
    config: DEFAULT_CONFIG,
    uiUrl: (id) => `http://127.0.0.1/s/${id}`,
    tailers: new Map<string, TranscriptTailer>(),
  };

  await ingestHook(
    'SessionStart',
    { session_id: 'wt2', cwd: repo, transcript_path: transcript, start_reason: 'startup' },
    ctx,
  );

  const session = store.get('wt2')!;
  assert.equal(session.repoRoot, repo);
  assert.equal(session.branch, 'main');
  assert.equal(session.worktree, null);

  for (const tailer of ctx.tailers.values()) tailer.close();
});
