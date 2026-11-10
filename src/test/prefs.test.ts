import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './dom-env.ts';

/**
 * The page's own preferences, read back when it loads. The store reads them
 * once, as it is imported, so they are written first.
 */

setupDom();
const FOLDS: unknown[] = [
  // A bare task id, as folds were kept before they were by session.
  't3',
  ['s0', ['t1']],
  ['s1', ['storage', 7]],
  ['s2', 'not a list'],
  ['s3', []],
  ['12345', ['t1']],
];
for (let i = 0; i < 98; i++) FOLDS.push([`old${i}`, ['t1']]);
window.localStorage.setItem('cc-harness:prefs', JSON.stringify({ collapsedTasks: FOLDS }));

const { store } = await import('../ui/store.ts');
const keys = () => [...store.getState().collapsedTasks.keys()];

test("folded tasks come back for each session, and only each session's", () => {
  const folds = store.getState().collapsedTasks;
  assert.deepEqual(folds.get('s1'), ['storage'], 'what is not a task id is dropped');
  assert.equal(folds.has('s2'), false, 'as is what is not a list');
  assert.equal(folds.has('s3'), false, 'and a session with nothing folded');
  assert.equal(folds.has('t3'), false, 'and a bare task id, which is no session');
  assert.equal(folds.size, 100, 'the 100 sessions folded in most recently');
  assert.equal(folds.has('s0'), false);
});

test('folding in a session makes it the most recent, and the oldest goes past 100', () => {
  // An id that reads as a number keeps its place in the order too.
  store.toggleTaskCollapsed('12345', 't2');
  assert.equal(keys().at(-1), '12345');
  assert.deepEqual(store.getState().collapsedTasks.get('12345'), ['t1', 't2']);
  store.toggleTaskCollapsed('new', 't2');
  assert.equal(keys().length, 100);
  assert.equal(keys()[0], 'old0', 's1, the oldest, went');
  assert.deepEqual(keys().slice(-2), ['12345', 'new']);
  const saved = JSON.parse(window.localStorage.getItem('cc-harness:prefs') ?? '{}') as { collapsedTasks?: [string, string[]][] };
  assert.deepEqual(saved.collapsedTasks?.at(-1), ['new', ['t2']], 'and that is saved');
});

test('unfolding the last task in a session forgets it', () => {
  store.toggleTaskCollapsed('new', 't2');
  assert.equal(store.getState().collapsedTasks.has('new'), false);
  store.toggleTaskCollapsed(null, 't2');
  assert.equal(keys().length, 99, 'and a view with no session folds nothing');
});
