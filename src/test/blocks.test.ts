import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BLOCK_SOURCE_KINDS, blocksText, droppedParts, joinBlocks, type Block, type ConfigRow } from '../shared/blocks.ts';
import { targetExists } from '../shared/plan.ts';
import { loadProjectConfig } from '../shared/project.ts';
import { TARGET_KINDS, type Plan } from '../shared/types.ts';
import { PROMPT_BUDGET, buildPrompt, configRows, designPrompt, planBlocks, renderPlan, type BuildPrompt } from '../daemon/render.ts';
import { briefBlocks, renderBrief } from '../daemon/brief.ts';
import { FIXTURE_BIN, bigPlan, fullProject, longPlan, plainPlan, richConfirmed, richPlan } from './prompt-fixtures.ts';

/**
 * Every word traceable (#60): each block of a prompt names where it comes
 * from — a field in the page, a setting in config, the sign-off dialog,
 * what Coplan works out, or Coplan's own instructions — and the blocks
 * joined are the prompt, byte for byte.
 */

const NOTE = 'Start with the client.';

/** Every prompt the fixtures make, by name, with the plan it was made from. */
const PROMPTS: Record<string, () => { plan: Plan; built: BuildPrompt }> = {
  'design, under the budget': () => withPlan(richPlan(), (p) => designPrompt(p, { project: fullProject(), bin: FIXTURE_BIN, note: NOTE })),
  'design, without config': () => withPlan(plainPlan(false), (p) => designPrompt(p)),
  'design, over the budget': () => withPlan(bigPlan(), (p) => designPrompt(p, { project: fullProject(true), note: NOTE })),
  'design, over the budget with the order': () => withPlan(longPlan(), (p) => designPrompt(p, { project: fullProject() })),
  'build for this session, under the budget': () => withPlan(richConfirmed(), (p) => buildPrompt(p, { target: 'session', project: fullProject(), bin: FIXTURE_BIN, note: NOTE })),
  'build for this session, settings chosen': () =>
    withPlan(richConfirmed(), (p) => buildPrompt(p, { target: 'session', project: fullProject(), settings: { review: 'subagent', parallel: 1, maxRounds: 1 } })),
  'build for this session, without config': () => withPlan(plainPlan(), (p) => buildPrompt(p, { target: 'session' })),
  'build for this session, over the budget': () => withPlan(bigPlan(), (p) => buildPrompt(p, { target: 'session', project: fullProject(true), note: NOTE })),
  'build for this session, over the budget with the order': () => withPlan(longPlan(), (p) => buildPrompt(p, { target: 'session', project: fullProject() })),
  'build for somewhere else': () => withPlan(richConfirmed(), (p) => buildPrompt(p, { target: 'elsewhere', project: fullProject(), note: NOTE })),
  'build for somewhere else, over the budget': () => withPlan(bigPlan(), (p) => buildPrompt(p, { target: 'elsewhere', project: fullProject(true) })),
};

function withPlan(plan: Plan, make: (plan: Plan) => BuildPrompt): { plan: Plan; built: BuildPrompt } {
  return { plan, built: make(plan) };
}

/** Why a block's source does not hold up, or null when it does. */
function badSource(block: Block, plan: Plan): string | null {
  const source = block.source as Block['source'] | undefined;
  if (!source || typeof source !== 'object') return 'has no source';
  if (!BLOCK_SOURCE_KINDS.includes(source.kind)) return `has a source of no known kind (${String((source as { kind?: unknown }).kind)})`;
  switch (source.kind) {
    case 'field':
      if (!TARGET_KINDS.includes(source.target.kind)) return `names a field of no known kind (${source.target.kind})`;
      return targetExists(plan, source.target) ? null : `names ${source.target.kind} "${source.target.id}", which the plan does not have`;
    case 'config':
      return source.key && Array.isArray(source.files) ? null : 'names a config setting without its key';
    case 'derived':
      return source.from.length && source.from.every(Boolean) ? null : 'says it is worked out, but not from what';
    case 'setting':
      return ['review', 'parallel', 'maxRounds'].includes(source.key) ? null : `names a build setting there is none of (${source.key})`;
    default:
      return null;
  }
}

for (const [name, make] of Object.entries(PROMPTS)) {
  test(`contract: every block of the ${name} prompt names a source that holds up`, () => {
    const { plan, built } = make();
    assert.ok(built.blocks.length > 0);
    const ids = new Set<string>();
    for (const block of built.blocks) {
      assert.equal(typeof block.id, 'string');
      assert.ok(block.id, `a block with no id: ${JSON.stringify(block.text.slice(0, 60))}`);
      const why = badSource(block, plan);
      assert.equal(why, null, `block ${block.id} ${why}: ${JSON.stringify(block.text.slice(0, 80))}`);
      assert.ok(!ids.has(block.id), `two blocks are called ${block.id}`);
      ids.add(block.id);
    }
    // Joined, the blocks are the prompt: nothing in it comes from nowhere.
    assert.equal(blocksText(built.blocks), built.prompt);
    assert.ok(!built.blocks[0]!.inline, 'a prompt starts on a line of its own');
  });
}

/** The read-back and every task's brief: the rest of what the agent reads. */
const READS: Record<string, () => { plan: Plan; blocks: Block[]; text: string }[]> = {
  'read-back': () =>
    [richPlan(), richConfirmed(), plainPlan(false), bigPlan()].flatMap((plan) => [
      { plan, blocks: planBlocks(plan, { url: 'http://x' }), text: renderPlan(plan, { url: 'http://x' }) },
      { plan, blocks: planBlocks(plan, { changesOnly: true }), text: renderPlan(plan, { changesOnly: true }) },
    ]),
  'task brief': () =>
    [richConfirmed(), longPlan(), plainPlan()].flatMap((plan) =>
      plan.tasks.flatMap((task) =>
        [{ project: fullProject(), bin: FIXTURE_BIN }, {}].map((opts) => ({ plan, blocks: briefBlocks(plan, task, opts), text: renderBrief(plan, task, opts) })),
      ),
    ),
};

for (const [name, make] of Object.entries(READS)) {
  test(`contract: every block of every ${name} names a source that holds up, and joined they are its text`, () => {
    const cases = make();
    assert.ok(cases.length > 3);
    for (const { plan, blocks, text } of cases) {
      const ids = new Set<string>();
      for (const block of blocks) {
        const why = badSource(block, plan);
        assert.equal(why, null, `block ${block.id} ${why}: ${JSON.stringify(block.text.slice(0, 80))}`);
        assert.ok(!ids.has(block.id), `two blocks are called ${block.id}`);
        ids.add(block.id);
      }
      assert.equal(name === 'read-back' ? blocksText(blocks) : joinBlocks(blocks), text);
    }
  });
}

test('the read-back marks what only the agent needs as bookkeeping: revisions, reply hints, its proposals, the gaps, the legend', () => {
  const blocks = planBlocks(richPlan());
  const kept = new Set(blocks.filter((b) => b.bookkeeping).map((b) => b.id));
  for (const id of ['meta', 'section:risks:rev', 'diagram:d1:note', 'task:wire:rev', 'thread:c3:reply', 'proposals', 'gaps', 'legend']) assert.ok(kept.has(id), `${id} is bookkeeping`);
  // Without them, every revision and reply hint is gone from what is shown.
  const shown = joinBlocks(blocks.filter((b) => !b.bookkeeping));
  assert.doesNotMatch(shown, /\brev \d|reply with harness_plan_edit|_Statuses:/);
  assert.match(shown, /Stale reads after a write\./, 'the content stays');
});

test('a brief that cannot quote every section leaves the rest out, and says so', () => {
  const plan = longPlan();
  const blocks = briefBlocks(plan, plan.tasks.find((t) => t.id === 'docs')!, {});
  // The first section takes the room; the next is left out, and pointed to.
  assert.equal(blocks.find((b) => b.id === 'section:context')?.dropped, undefined);
  assert.equal(blocks.find((b) => b.id === 'section:risks')?.dropped, true);
  assert.match(blocks.find((b) => b.id === 'section:risks')!.text, /A cold cache after deploys\./);
  assert.ok(blocks.some((b) => b.id === 'sections:more'));
  assert.deepEqual(droppedParts(blocks), ['1 section']);
});

test('contract: a block with no source fails the check', () => {
  const plan = richPlan();
  assert.match(badSource({ id: 'x', text: 'x' } as unknown as Block, plan) ?? '', /no source/);
  assert.match(badSource({ id: 'x', text: 'x', source: { kind: 'field', target: { kind: 'task', id: 'nope' } } }, plan) ?? '', /does not have/);
  assert.match(badSource({ id: 'x', text: 'x', source: { kind: 'derived', from: [] } }, plan) ?? '', /not from what/);
});

test('the fields a prompt quotes are tagged with the item they come from', () => {
  const { built } = PROMPTS['build for this session, under the budget']!();
  const at = (id: string) => built.blocks.find((b) => b.id === id);
  assert.deepEqual(at('section:risks')?.source, { kind: 'field', target: { kind: 'section', id: 'risks' } });
  assert.deepEqual(at('node:d1/cache')?.source, { kind: 'field', target: { kind: 'node', id: 'd1/cache' } });
  assert.match(at('node:d1/cache')!.text, /Read-through, 10m TTL\./);
  assert.deepEqual(at('edge:d1/api->cache')?.source, { kind: 'field', target: { kind: 'edge', id: 'd1/api->cache' } });
  assert.deepEqual(at('task:wire')?.source, { kind: 'field', target: { kind: 'task', id: 'wire' } });
  assert.deepEqual(at('title')?.source, { kind: 'field', target: { kind: 'plan', id: '' } });
  assert.equal(at('title')?.text, 'Add a read-through cache');
  // A comment comes from the item it is on, where the page shows it.
  assert.deepEqual(at('thread:c3')?.source, { kind: 'field', target: { kind: 'task', id: 'wire' } });
  assert.equal(at('note')?.source.kind, 'note');
  assert.equal(at('changes')?.source.kind, 'changes');
  assert.deepEqual(at('branches')?.source, { kind: 'derived', from: ["each task's branch", 'the base branch (branches.base)'] });
});

test('settings in a prompt name where they are set: config, or the Submit dialog', () => {
  const project = fullProject();
  const build = buildPrompt(richConfirmed(), { target: 'session', project, settings: { review: 'subagent', parallel: 3, maxRounds: 2 } });
  const at = (id: string) => build.blocks.find((b) => b.id === id);
  assert.deepEqual(at('step-3:review')?.source, { kind: 'setting', key: 'review' });
  assert.deepEqual(at('step-1:parallel')?.source, { kind: 'setting', key: 'parallel' });
  assert.equal(at('step-3:model')?.source.kind, 'config');
  assert.equal(at('step-3:model')?.text, ' Run the reviewer on the `opus` model.');
  assert.deepEqual(at('step-7:pull-requests')?.source, { kind: 'config', key: 'pullRequests', files: ['.coplan/config.json'] });
  assert.deepEqual(at('checks:review')?.source, { kind: 'config', key: 'hooks.review', files: ['.coplan/config.json'] });
  assert.deepEqual(at('instructions:build')?.source, { kind: 'config', key: 'instructions.build', files: ['.coplan/config.json'] });

  // The design prompt's review mode is the config's default: no dialog sets it.
  const design = designPrompt(richPlan(), { project });
  assert.deepEqual(design.blocks.find((b) => b.id === 'step-5:review')?.source, { kind: 'config', key: 'iric.review', files: ['.coplan/config.json'] });
  // Without config, the default is Coplan's: no file sets it.
  const bare = designPrompt(richPlan());
  assert.deepEqual(bare.blocks.find((b) => b.id === 'step-5:review')?.source, { kind: 'config', key: 'iric.review', files: [] });
});

test("a config source names each file that set it: the user's own, then the repository's", () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coplan-origins-'));
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(home, 'instructions'), { recursive: true });
  mkdirSync(path.join(repo, '.coplan'), { recursive: true });
  writeFileSync(path.join(home, 'coplan.json'), JSON.stringify({ pullRequests: { tool: 'graphite', open: 'auto' }, review: { model: 'opus' } }));
  writeFileSync(path.join(home, 'instructions', 'build.md'), 'Mine first.');
  writeFileSync(path.join(repo, '.coplan', 'config.json'), JSON.stringify({ pullRequests: { open: 'ask' }, instructions: { build: 'Then the repository.' }, hooks: { review: ['npm test'] } }));
  const project = loadProjectConfig(repo, { globalDir: home });
  assert.deepEqual(project.origins?.['pullRequests.tool'], [path.join(home, 'coplan.json')]);
  assert.deepEqual(project.origins?.['pullRequests.open'], ['.coplan/config.json'], 'the repository overrides it');
  assert.deepEqual(project.origins?.['review.model'], [path.join(home, 'coplan.json')]);
  assert.deepEqual(project.origins?.['instructions.build'], [path.join(home, 'instructions', 'build.md'), '.coplan/config.json']);
  assert.deepEqual(project.origins?.['hooks.review'], ['.coplan/config.json']);
  assert.equal(project.origins?.['hooks.final'], undefined, 'not set anywhere: Coplan has no default checks');

  const built = buildPrompt(richConfirmed(), { target: 'session', project });
  const at = (id: string) => built.blocks.find((b) => b.id === id);
  assert.deepEqual(at('step-7:pull-requests')?.source, { kind: 'config', key: 'pullRequests', files: [path.join(home, 'coplan.json'), '.coplan/config.json'] });
  assert.deepEqual(at('instructions:build')?.source, { kind: 'config', key: 'instructions.build', files: [path.join(home, 'instructions', 'build.md'), '.coplan/config.json'] });
});

test('a prompt over the budget reports which blocks were left out to fit, and none of them is in its text', () => {
  const { built } = PROMPTS['build for this session, over the budget']!();
  assert.equal(built.trimmed, true);
  assert.ok(built.prompt.length <= PROMPT_BUDGET);
  const dropped = built.blocks.filter((b) => b.dropped);
  const ids = new Set(dropped.map((b) => b.id));
  for (const id of ['sections', 'section:context', 'section:risks:body', 'architecture', 'diagram:d1', 'node:d1/cache', 'edge:d1/api->cache', 'task:client:detail', 'build-order']) {
    assert.ok(ids.has(id), `${id} is left out, and says so`);
  }
  // Each one is out of the text: its words are not in the prompt.
  for (const id of ['section:context:body', 'node:d1/cache', 'task:storage:detail']) {
    const block = dropped.find((b) => b.id === id)!;
    assert.ok(!built.prompt.includes(block.text.trim()), `${id} is not in the prompt`);
  }
  // The task list is cut: the tasks past the cut are left out too, after the line that says so.
  const more = built.blocks.findIndex((b) => b.id === 'tasks:more');
  assert.ok(more > 0);
  assert.ok(built.blocks.slice(more + 1).some((b) => b.dropped && /^task:bulk\d+$/.test(b.id)));
  assert.ok(built.blocks.some((b) => b.dropped && b.id === 'task:bulk59'), 'the last task is among them');
  assert.equal(joinBlocks(built.blocks.filter((b) => b.dropped)), '', 'joined, dropped blocks say nothing');

  const past = built.blocks.filter((b) => b.dropped && /^task:[^:]+$/.test(b.id)).length;
  assert.ok(past > 10);
  // Every task with a detail: three of the plan's, and the sixty bulk ones.
  assert.deepEqual(droppedParts(built.blocks), ['3 sections', 'the architecture (3 diagrams)', 'the detail of 63 tasks', `${past} tasks past the cut`, 'the build order']);
  // Cut, not dropped: kept in part, and marked.
  assert.equal(built.blocks.find((b) => b.id === 'changes')?.cut, true);
  assert.equal(built.blocks.find((b) => b.id === 'instructions:build')?.cut, true);
});

test('a prompt that fits leaves nothing out', () => {
  const { built } = PROMPTS['build for this session, under the budget']!();
  assert.equal(built.trimmed, false);
  assert.deepEqual(droppedParts(built.blocks), []);
  assert.ok(!built.blocks.some((b) => b.dropped || b.cut));
});

test('the design prompt over the budget keeps the build order when it fits, and says what it left out', () => {
  const { built } = PROMPTS['design, over the budget with the order']!();
  assert.equal(built.trimmed, true);
  assert.ok(!built.blocks.find((b) => b.id === 'build-order')?.dropped);
  assert.deepEqual(droppedParts(built.blocks), ['3 sections', 'the architecture (2 diagrams)', 'the detail of 3 tasks', '4 open comments']);
  for (const id of ['thread:c1', 'thread:c3:reply', 'comments']) assert.equal(built.blocks.find((b) => b.id === id)?.dropped, true, `${id} is left out`);
});

test("the agent's bookkeeping is marked: revisions, who edited what, how to reply, the legend", () => {
  const { built } = PROMPTS['build for this session, under the budget']!();
  const kept = built.blocks.filter((b) => b.bookkeeping).map((b) => b.id);
  assert.ok(kept.includes('section:risks:by'));
  assert.ok(kept.includes('thread:c3:reply'));
  assert.ok(kept.includes('legend'));
  for (const b of built.blocks.filter((x) => x.bookkeeping)) assert.match(b.text, /edited by the user|added by the user|reply with harness_plan_edit|Statuses:|rev /);
});

test('the Confirm dialog shows every config setting the design prompt depends on, and the Submit dialog every one the build prompt does', () => {
  const covers = (rows: ConfigRow[], key: string) => rows.some((r) => r.key === key || key.startsWith(`${r.key}.`) || r.key.startsWith(`${key}.`));
  for (const project of [fullProject(), fullProject(true), loadProjectConfig(null, { globalDir: null })]) {
    const design = designPrompt(richPlan(), { project, note: NOTE });
    const rows = configRows(project, 'design');
    for (const b of design.blocks) {
      if (b.source.kind === 'config') assert.ok(covers(rows, b.source.key), `the design prompt's ${b.id} depends on ${b.source.key}, which the Confirm dialog does not show`);
      // The Confirm dialog has no settings of its own: nothing in the prompt can come from one.
      assert.notEqual(b.source.kind, 'setting', `${b.id} depends on a build setting the Confirm dialog does not have`);
    }
    for (const settings of [undefined, { review: 'subagent' as const, parallel: 2, maxRounds: 3 }]) {
      const build = buildPrompt(richConfirmed(), { target: 'session', project, ...(settings ? { settings } : {}) });
      const there = buildPrompt(richConfirmed(), { target: 'elsewhere', project, ...(settings ? { settings } : {}) });
      const rows = configRows(project, 'build');
      for (const b of [...build.blocks, ...there.blocks]) {
        if (b.source.kind === 'config' && !b.source.key.startsWith('iric.')) assert.ok(covers(rows, b.source.key), `the build prompt's ${b.id} depends on ${b.source.key}, which the Submit dialog does not show`);
      }
    }
  }
});

test('each config row says what it is set to and where: the file, or none for a default', () => {
  const rows = configRows(fullProject(), 'build');
  const at = (key: string) => rows.find((r) => r.key === key);
  assert.deepEqual(at('hooks.review'), { key: 'hooks.review', label: 'Review checks', value: 'tests', files: ['.coplan/config.json'] });
  assert.deepEqual(at('pullRequests'), { key: 'pullRequests', label: 'Pull requests', value: 'Graphite, as each branch is done · template .github/pull_request_template.md', files: ['.coplan/config.json'] });
  assert.deepEqual(at('review.model'), { key: 'review.model', label: 'Reviewer model', value: 'opus', files: ['.coplan/config.json'] });
  assert.equal(at('instructions.build')?.value, 'Small commits, each with a message that says why.');
  const bare = configRows(loadProjectConfig(null, { globalDir: null }), 'design');
  assert.deepEqual(
    bare.map((r) => [r.key, r.value, r.files.length]),
    [
      ['hooks.implement', 'none', 0],
      ['hooks.review', 'none', 0],
      ['hooks.final', 'none', 0],
      ['iric.review', 'an independent reviewer (a fresh subagent)', 0],
      ['branches', 'cut from the base branch', 0],
      ['instructions.design', 'none', 0],
    ],
  );
});
