import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedChecks, runAllChecks, cancelSessionRun } from '../daemon/checks.ts';
import type { SessionStore } from '../daemon/store.ts';

/**
 * Wait until a command has actually been spawned.
 *
 * A fixed sleep would be a race: on a loaded machine the spawn can take
 * longer, and the test would then be cancelling a run that had not started —
 * asserting nothing while appearing to pass.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function running(id: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (store.get(id)?.checks.some((c) => c.status === 'running')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no check ever started running');
}

/**
 * Bounding a check run.
 *
 * The MCP call that starts a run waits for it before it answers and opens the
 * verification gate, so the run has to finish inside a budget the transport
 * also honours. Unbounded, five slow commands at fifteen minutes each outlast
 * any budget worth naming — the call aborts, Claude is told the harness never
 * answered, and the gate the user is looking at is not the one it thinks.
 */

let home: string;
let cwd: string;
let store: SessionStore;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'cc-harness-checks-home-'));
  cwd = mkdtempSync(path.join(tmpdir(), 'cc-harness-checks-cwd-'));
  process.env['CC_HARNESS_HOME'] = home;
  const { SessionStore: Store } = await import('../daemon/store.ts');
  store = new Store();
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test('a run finishes inside its budget rather than outlasting every timeout above it', async () => {
  const id = 'checks-budget';
  store.ensure(id, cwd);
  seedChecks(store, id, ['sleep 30', 'echo never-reached']);

  const started = Date.now();
  const results = await runAllChecks(store, id, { budgetMs: 400 });
  const took = Date.now() - started;

  assert.ok(took < 10_000, `the run gave up at its deadline rather than running on (${took}ms)`);
  // The command that was still going is reported; the one after it is not
  // silently marked as anything it did not do.
  const state = store.get(id)!;
  assert.equal(state.checks[1]?.status, 'pending', 'a command never reached stays honestly unrun');
  assert.ok(results.length <= 1);
});

test('a run that finishes early is not held to its budget', async () => {
  const id = 'checks-fast';
  store.ensure(id, cwd);
  seedChecks(store, id, ['exit 0', 'exit 3']);

  const results = await runAllChecks(store, id, { budgetMs: 30_000 });

  assert.equal(results.length, 2);
  assert.equal(results[0]?.status, 'passed');
  assert.equal(results[1]?.status, 'failed');
  assert.equal(results[1]?.exitCode, 3);
});

test('starting a run stops the one it replaces instead of racing it', async () => {
  // The UI's "run checks" button and an in-flight `harness_publish_checks`
  // hit the same session with the same commands and no re-seed in between.
  // Cancelling the command that happens to be in flight is not enough: the
  // abandoned loop then walks on to its NEXT command and spawns it for real,
  // racing the run that replaced it over the very ports and locks this is
  // supposed to protect — and it is untracked, so nothing can stop it.
  //
  // Two commands, and no re-seed: with one command, or with the array
  // replaced underneath it, the abandoned loop has nothing left to run into
  // and the bug cannot show itself.
  const id = 'checks-replace';
  store.ensure(id, cwd);
  seedChecks(store, id, ['sleep 30', 'sleep 30']);

  const first = runAllChecks(store, id);
  await running(id);

  // Supersede it. This cancels the command in flight; the question is what
  // the loop behind that command does next.
  const second = runAllChecks(store, id);
  await running(id);

  const abandoned = await withTimeout(first, 5_000);
  assert.ok(
    abandoned,
    'the superseded run walked on to its next command instead of stopping — it is now racing its replacement, untracked',
  );
  assert.ok(abandoned.length <= 1, `it should have stopped after its cancelled command (ran ${abandoned.length})`);

  cancelSessionRun(id);
  await second;
});

test('cancelling a session run reports how much it stopped', async () => {
  const id = 'checks-cancel';
  store.ensure(id, cwd);
  seedChecks(store, id, ['sleep 30']);

  const inFlight = runAllChecks(store, id);
  await running(id);

  assert.equal(cancelSessionRun(id), 1, 'the in-flight command is the one that was stopped');
  await inFlight;
  assert.equal(cancelSessionRun(id), 0, 'and a session with nothing in flight stops nothing');
});
