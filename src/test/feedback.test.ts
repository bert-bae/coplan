import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeedback, renderGateResult, renderThread } from '../daemon/gates.ts';
import { stopBlock, additionalContext } from '../shared/hooks.ts';
import type { Gate, FeedbackItem, ReviewThread } from '../shared/types.ts';

const thread: ReviewThread = {
  id: 't1',
  file: 'src/app.ts',
  side: 'new',
  startLine: 12,
  endLine: 14,
  body: 'This should handle the null case.',
  excerpt: '+const value = map.get(key);\n+return value.trim();',
  createdAt: 0,
  resolved: false,
};

test('a line comment renders with its id, file, range and source', () => {
  const out = renderThread(thread);
  assert.match(out, /\[t1\]/, 'the thread id is carried so the model can reply into it');
  assert.match(out, /src\/app\.ts:12-14/);
  assert.match(out, /value\.trim\(\)/);
  assert.match(out, /handle the null case/);
});

test('single-line comments render without a range', () => {
  assert.match(renderThread({ ...thread, endLine: 12 }), /src\/app\.ts:12 /);
});

test('queued feedback reads as an instruction, not a data dump', () => {
  const items: FeedbackItem[] = [
    { id: 'f1', createdAt: 0, origin: 'diff', text: 'Two things to fix.', threads: [thread] },
  ];
  const out = renderFeedback(items);
  assert.match(out, /^\[cc-harness\]/);
  assert.match(out, /Two things to fix\./);
  assert.match(out, /src\/app\.ts:12-14/);
  assert.match(out, /Address each comment/);
  assert.match(out, /harness_reply/, 'the model is told how to answer in-thread');
});

test('no feedback renders as nothing', () => {
  assert.equal(renderFeedback([]), '');
});

test('an approved plan gate hands back the final step list', () => {
  const gate: Gate = {
    id: 'g1',
    kind: 'plan',
    stage: 'plan_review',
    prompt: 'Review the plan',
    createdAt: 0,
    status: 'resolved',
    waiting: false,
    result: {
      verdict: 'approved',
      resolvedAt: 1,
      comment: 'Looks right.',
      steps: [
        { id: 's1', title: 'Add the parser' },
        { id: 's2', title: 'Skip caching', status: 'dropped' },
        { id: 's3', title: 'Wire the route', comment: 'use the existing helper' },
      ],
    },
  };
  const out = renderGateResult(gate);
  assert.match(out, /The user approved at the plan gate/);
  assert.match(out, /DROP — Skip caching/);
  assert.match(out, /use the existing helper/);
  assert.match(out, /Approved plan \(2 steps\)/, 'dropped steps are excluded from the count');
  assert.match(out, /1\. Add the parser/);
  assert.match(out, /Proceed with the next stage/);
});

test('a rejection tells the model to stop rather than improvise', () => {
  const gate: Gate = {
    id: 'g2',
    kind: 'code_review',
    stage: 'code_review',
    prompt: 'Review the code',
    createdAt: 0,
    status: 'resolved',
    waiting: false,
    result: { verdict: 'rejected', resolvedAt: 1, comment: 'Wrong approach.' },
  };
  assert.match(renderGateResult(gate), /Stop and wait for further direction/);
});

test('stopBlock emits both known shapes of the Stop decision contract', () => {
  const out = stopBlock('do the thing');
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, 'do the thing');
  assert.equal(out.hookSpecificOutput?.decision, 'block');
  assert.equal(out.hookSpecificOutput?.reason, 'do the thing');
  assert.equal(out.hookSpecificOutput?.additionalContext, 'do the thing');
});

test('additionalContext never blocks', () => {
  const out = additionalContext('UserPromptSubmit', 'note');
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput?.additionalContext, 'note');
});
