import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewReads } from '../daemon/reviewReads.ts';

test("a change to a repository's review mode is told, a first read is not (#158)", () => {
  const reads = new ReviewReads(10);
  assert.equal(reads.saw('a', 'self'), false, 'first read');
  assert.equal(reads.saw('a', 'self'), false, 'unchanged');
  assert.equal(reads.saw('a', 'user'), true, 'changed');
});

test('past its limit the least recently read goes first, so a repository read all along keeps its mode known (#163)', () => {
  const reads = new ReviewReads(3);
  reads.saw('a', 'user');
  reads.saw('b', 'self');
  reads.saw('c', 'self');
  // `a` read again (an open page's, on a settings tick), then a fourth repository: `b`, read least lately, goes.
  reads.saw('a', 'user');
  reads.saw('d', 'self');
  assert.equal(reads.saw('a', 'subagent'), true, "a's change is told");
  assert.equal(reads.saw('b', 'user'), false, 'b was let go: its next read is a first read');
});
