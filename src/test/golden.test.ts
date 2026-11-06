import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plan } from '../shared/types.ts';
import type { BriefOptions } from '../daemon/brief.ts';
import { FIXTURE_BIN, FIXTURE_HOME, FIXTURE_URL, bigPlan, fullProject, longPlan, plainPlan, richConfirmed, richPlan } from './prompt-fixtures.ts';

// The instructions pointer names the user's own config by where Coplan's
// home is: fixed, so the bytes are the same on every machine.
process.env['CC_HARNESS_HOME'] = FIXTURE_HOME;
const { PROMPT_BUDGET, buildPrompt, designPrompt, promptHash, renderPlan } = await import('../daemon/render.ts');
const { renderBrief } = await import('../daemon/brief.ts');

/**
 * What the agent is sent, byte for byte.
 *
 * Every prompt the page shows before a sign-off is the prompt that is sent,
 * and the sign-off is refused if its hash moved since the preview (#23). So
 * the prompts and the read-back are held here exactly as they render today:
 * a change to how they are put together must not change a byte of them, and
 * a change to what they say shows up here as a diff to review.
 *
 * To record a deliberate change: `COPLAN_UPDATE_GOLDEN=1 pnpm test`, then
 * read the diff of src/test/golden/.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'src', 'test', 'golden');
const UPDATE = process.env['COPLAN_UPDATE_GOLDEN'] === '1';

const NOTE = 'Start with the client.\nLeave billing alone.';

interface Case {
  /** The prompt or read-back. */
  text: string;
  /** Whether it was cut to fit: undefined for the read-back. */
  trimmed?: boolean;
}

/** A prompt as the cases compare it. */
const asCase = ({ prompt, trimmed }: { prompt: string; trimmed: boolean }): Case => ({ text: prompt, trimmed });

const CASES: Record<string, () => Case> = {
  // The ask for a task list, once the design is confirmed.
  'design-under': () => asCase(designPrompt(richPlan(), { agent: 'claude', project: fullProject(), bin: FIXTURE_BIN, note: NOTE })),
  'design-under-no-config': () => asCase(designPrompt(plainPlan(false), {})),
  'design-under-codex': () => asCase(designPrompt(richPlan(), { agent: 'codex', project: fullProject() })),
  'design-over-with-order': () => asCase(designPrompt(longPlan(), { agent: 'claude', project: fullProject() })),
  'design-over': () => asCase(designPrompt(bigPlan(), { agent: 'claude', project: fullProject(true), bin: FIXTURE_BIN, note: NOTE })),

  // The build prompt, for this session (cut to fit) and somewhere else (never cut).
  'build-session-under': () => asCase(buildPrompt(richConfirmed(), { target: 'session', agent: 'claude', project: fullProject(), bin: FIXTURE_BIN, note: NOTE })),
  'build-session-under-no-config': () => asCase(buildPrompt(plainPlan(), { target: 'session' })),
  'build-session-under-settings': () =>
    asCase(buildPrompt(richConfirmed(), { target: 'session', agent: 'cursor', project: fullProject(), settings: { review: 'self', parallel: 1, maxRounds: 1 } })),
  'build-session-over': () => asCase(buildPrompt(bigPlan(), { target: 'session', agent: 'claude', project: fullProject(true), bin: FIXTURE_BIN, note: NOTE })),
  'build-session-over-with-order': () => asCase(buildPrompt(longPlan(), { target: 'session', agent: 'claude', project: fullProject(), bin: FIXTURE_BIN })),
  'build-elsewhere-under': () => asCase(buildPrompt(richConfirmed(), { target: 'elsewhere', project: fullProject(), bin: FIXTURE_BIN, note: NOTE })),
  'build-elsewhere-under-no-config': () => asCase(buildPrompt(plainPlan(), { target: 'elsewhere' })),
  'build-elsewhere-over': () => asCase(buildPrompt(bigPlan(), { target: 'elsewhere', project: fullProject(true), note: NOTE })),

  // What harness_plan_read returns.
  'readback': () => ({ text: renderPlan(richPlan(), { url: FIXTURE_URL, planCheck: { 'box-undescribed': 'error' } }) }),
  'readback-changes-only': () => ({ text: renderPlan(richPlan(), { url: FIXTURE_URL, changesOnly: true }) }),
  'readback-confirmed': () => ({ text: renderPlan(richConfirmed()) }),
  'readback-first': () => ({ text: renderPlan(plainPlan(false)) }),

  // What harness_task_brief returns: what each implementer subagent is given.
  'brief-subtask': () => ({ text: brief(richConfirmed(), 'inval', { agent: 'claude', project: fullProject(), bin: FIXTURE_BIN }) }),
  'brief-parent': () => ({ text: brief(richConfirmed(), 'storage', { agent: 'claude', project: fullProject(), bin: FIXTURE_BIN }) }),
  'brief-in-progress': () => ({ text: brief(richConfirmed(), 'wire', { agent: 'codex', project: fullProject() }) }),
  'brief-no-config': () => ({ text: brief(plainPlan(), 'client', {}) }),
  'brief-long-sections': () => ({ text: brief(longPlan(), 'docs', { project: fullProject(), settings: { review: 'self', parallel: 1, maxRounds: 1 } }) }),
};

function brief(plan: Plan, id: string, opts: BriefOptions): string {
  return renderBrief(plan, plan.tasks.find((t) => t.id === id)!, opts);
}

/** Which cases are meant to be over the budget, and so cut. */
const OVER = new Set(['design-over', 'design-over-with-order', 'build-session-over', 'build-session-over-with-order']);

const hashesFile = path.join(DIR, 'hashes.json');

if (UPDATE) {
  mkdirSync(DIR, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const [name, make] of Object.entries(CASES)) {
    const { text } = make();
    writeFileSync(path.join(DIR, `${name}.txt`), text);
    hashes[name] = promptHash(text);
  }
  writeFileSync(hashesFile, `${JSON.stringify(hashes, null, 2)}\n`);
}

const recorded: Record<string, string> = existsSync(hashesFile) ? (JSON.parse(readFileSync(hashesFile, 'utf8')) as Record<string, string>) : {};

for (const [name, make] of Object.entries(CASES)) {
  test(`golden: ${name} renders byte for byte as recorded`, () => {
    const file = path.join(DIR, `${name}.txt`);
    assert.ok(existsSync(file), `no golden file for ${name}: record it with COPLAN_UPDATE_GOLDEN=1`);
    const { text, trimmed } = make();
    assert.equal(text, readFileSync(file, 'utf8'));
    // The hash the page previews and the sign-off checks (#23).
    assert.equal(promptHash(text), recorded[name], `the prompt hash of ${name} moved`);
    if (trimmed !== undefined) {
      assert.equal(trimmed, OVER.has(name), `${name} is ${OVER.has(name) ? '' : 'not '}meant to be cut to fit`);
      if (name.includes('session') || name.startsWith('design')) {
        assert.equal(text.length <= PROMPT_BUDGET, true, `${name} is ${text.length} characters, over the budget`);
      }
    }
  });
}

test('golden: every case has a file, and every file a case', () => {
  assert.deepEqual(Object.keys(recorded).sort(), Object.keys(CASES).sort());
});
