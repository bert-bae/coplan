import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewReads } from '../daemon/reviewReads.ts';

test("a change to a repository's review mode is told, a first read is not (#158)", () => {
  const reads = new ReviewReads(10);
  assert.equal(reads.saw('a', 'agent'), false, 'first read');
  assert.equal(reads.saw('a', 'agent'), false, 'unchanged');
  assert.equal(reads.saw('a', 'user'), true, 'changed');
});

test('past its limit the least recently read goes first, so a repository read all along keeps its mode known (#163)', () => {
  const reads = new ReviewReads(3);
  reads.saw('a', 'user');
  reads.saw('b', 'agent');
  reads.saw('c', 'agent');
  // `a` read again (an open page's, on a settings tick), then a fourth repository: `b`, read least lately, goes.
  reads.saw('a', 'user');
  reads.saw('d', 'agent');
  assert.equal(reads.saw('a', 'none'), true, "a's change is told");
  assert.equal(reads.saw('b', 'user'), false, 'b was let go: its next read is a first read');
});
