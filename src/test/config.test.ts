import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, mergeConfig, renderTemplate } from '../shared/config.ts';

test('project overrides merge without dropping shipped providers', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    ship: {
      provider: 'bitbucket',
      providers: { gitlab: { kind: 'mcp', directive: 'use the gitlab server' } },
    },
  });
  assert.equal(merged.ship.provider, 'bitbucket');
  assert.ok(merged.ship.providers['gh'], 'built-in gh provider survives');
  assert.ok(merged.ship.providers['gitlab'], 'custom provider is added');
  assert.deepEqual(merged.ship.steps, DEFAULT_CONFIG.ship.steps);
});

test('stage overrides merge per stage', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    stages: {
      verification: { checks: ['npm test'] },
      code_review: { instructions: '.claude/review.md' },
    },
  });
  assert.deepEqual(merged.stages.verification?.checks, ['npm test']);
  assert.equal(merged.stages.code_review?.instructions, '.claude/review.md', 'other stages merge too');
});

test('scalar overrides apply', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { autoOpen: false, stopHoldSeconds: 60 });
  assert.equal(merged.autoOpen, false);
  assert.equal(merged.stopHoldSeconds, 60);
});

test('merging does not mutate the defaults', () => {
  mergeConfig(DEFAULT_CONFIG, {
    ship: { provider: 'none' },
    stages: { verification: { checks: ['x'] } },
  });
  assert.equal(DEFAULT_CONFIG.ship.provider, 'gh');
  assert.deepEqual(DEFAULT_CONFIG.stages.verification?.checks, []);
});

test('garbage input is ignored rather than throwing', () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, null), DEFAULT_CONFIG);
  assert.equal(mergeConfig(DEFAULT_CONFIG, 'nope'), DEFAULT_CONFIG);
  assert.equal(mergeConfig(DEFAULT_CONFIG, [1, 2]), DEFAULT_CONFIG);
});

test('templates substitute known keys and blank unknown ones', () => {
  assert.equal(renderTemplate('{{a}}-{{b}}-{{c}}', { a: 'x', b: 'y' }), 'x-y-');
  assert.equal(renderTemplate('no placeholders', {}), 'no placeholders');
});
