import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_OPS, PROPOSAL_EDIT_OPS, TOOLS } from '../mcp/tools.ts';
import { OP_FIELDS, PROGRESS_FIELDS, PROPOSABLE_OPS } from '../shared/plan.ts';

/**
 * The agent learns Coplan's API from three places: the tool schemas, the
 * skills, and the prose the daemon sends back (prompts, briefs, errors).
 * If they disagree, the agent's calls fail or are silently ignored. These
 * tests hold every `harness_<tool> {…}` example written anywhere to the
 * schema the tool really takes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const listDir = (rel: string, ext: string) =>
  readdirSync(path.join(ROOT, rel), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(rel, f));

/** Where call examples are written: the skills, the docs, and the
 *  daemon's and MCP server's own prose. */
const SOURCES = [
  ...listDir('skills', '.md'),
  ...listDir('commands', '.md'),
  ...listDir('docs', '.md'),
  'README.md',
  ...listDir('src/daemon', '.ts'),
  ...listDir('src/mcp', '.ts'),
  ...listDir('src/shared', '.ts'),
];

interface Example {
  where: string;
  tool: string;
  body: string;
}

/** Joins TypeScript string concatenation (`'…' +\n '…'`) so an example
 *  split across source lines reads as one. */
function unsplit(text: string): string {
  return text.replace(/(['"`])\s*\+\s*\n\s*(['"`])/g, '');
}

/** The text between a `{` at `start` and its matching `}`. */
function balanced(text: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

function examples(): Example[] {
  const out: Example[] = [];
  for (const rel of SOURCES) {
    const text = rel.endsWith('.ts') ? unsplit(read(rel)) : read(rel);
    for (const m of text.matchAll(/\bharness_([a-z_]+) \{/g)) {
      const body = balanced(text, m.index + m[0].length - 1);
      if (body === null) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ where: `${rel}:${line}`, tool: `harness_${m[1]}`, body });
    }
  }
  return out;
}

/** Splits `a, b: [x, y], c: "p, q"` at its top-level commas. */
function topLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const c of body) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** `{key: value}` fields of an example as [key, value] pairs; `...` and
 *  `…` (the writer saying "and so on") are skipped. */
function fields(body: string): [string, string][] {
  return topLevel(body)
    .filter((p) => p !== '...' && p !== '…')
    .map((p) => {
      const at = p.indexOf(':');
      return at === -1 ? [p, ''] : [p.slice(0, at).trim(), p.slice(at + 1).trim()];
    });
}

const toolOf = (name: string) => TOOLS.find((t) => t.name === name);
const propsOf = (name: string) => Object.keys((toolOf(name)?.inputSchema['properties'] ?? {}) as Record<string, unknown>);

test('every call example names a real tool with fields it takes', () => {
  const found = examples();
  assert.ok(found.length >= 10, `expected to find the call examples, found ${found.length}`);
  for (const ex of found) {
    assert.ok(toolOf(ex.tool), `${ex.where}: ${ex.tool} is not a tool`);
    for (const [key] of fields(ex.body)) {
      assert.ok(propsOf(ex.tool).includes(key), `${ex.where}: ${ex.tool} does not take "${key}" (it takes ${propsOf(ex.tool).join(', ')})`);
    }
  }
});

test('every harness_plan_edit example passes a list of ops, each with only its own fields', () => {
  const edits = examples().filter((ex) => ex.tool === 'harness_plan_edit');
  assert.ok(edits.length >= 3, 'expected harness_plan_edit examples');
  for (const ex of edits) {
    const top = fields(ex.body);
    assert.deepEqual(
      top.map(([k]) => k),
      ['ops'],
      `${ex.where}: harness_plan_edit takes {ops: [...]}, not {${ex.body}}`,
    );
    const list = top[0]![1];
    assert.ok(list.startsWith('['), `${ex.where}: ops is a list`);
    for (const item of topLevel(list.slice(1, -1))) {
      if (item === '...' || item === '…') continue;
      assert.ok(item.startsWith('{'), `${ex.where}: each op is an object, got ${item}`);
      const opFields = fields(item.slice(1, -1));
      const name = opFields.find(([k]) => k === 'op')?.[1].replace(/"/g, '');
      assert.ok(name && (AGENT_OPS as readonly string[]).includes(name), `${ex.where}: unknown op ${name}`);
      const allowed = OP_FIELDS[name as keyof typeof OP_FIELDS] as readonly string[];
      for (const [key] of opFields) {
        if (key === 'op') continue;
        assert.ok(allowed.includes(key), `${ex.where}: ${name} does not take "${key}" (it takes ${allowed.join(', ')})`);
      }
    }
  }
});

test('the harness_plan_edit schema offers exactly the fields the daemon accepts', () => {
  const tool = toolOf('harness_plan_edit')!;
  const item = (tool.inputSchema['properties'] as Record<string, { items: Record<string, unknown> }>)['ops']!.items;
  const props = item['properties'] as Record<string, { enum?: string[] }>;
  assert.deepEqual(props['op']!.enum, [...AGENT_OPS]);
  for (const op of AGENT_OPS) assert.ok(op in OP_FIELDS, `${op} is offered but the daemon has no field list for it`);
  // Progress (status, stage, checks) is reported through harness_task_update only.
  const union = new Set(
    AGENT_OPS.flatMap((op) => (OP_FIELDS[op] as readonly string[]).filter((f) => op !== 'upsert_task' || !(PROGRESS_FIELDS as readonly string[]).includes(f))),
  );
  assert.deepEqual(
    Object.keys(props)
      .filter((k) => k !== 'op')
      .sort(),
    [...union].sort(),
  );
  assert.equal(item['additionalProperties'], false);
});

test('harness_plan_propose offers the edits a proposal may carry, and the daemon takes them', () => {
  const tool = toolOf('harness_plan_propose')!;
  const item = (tool.inputSchema['properties'] as Record<string, { items: Record<string, unknown> }>)['ops']!.items;
  const props = item['properties'] as Record<string, { enum?: string[] }>;
  assert.deepEqual(props['op']!.enum, [...PROPOSAL_EDIT_OPS]);
  assert.deepEqual([...PROPOSAL_EDIT_OPS].sort(), [...PROPOSABLE_OPS].sort(), 'the tool and the daemon agree on what a proposal carries');
  assert.deepEqual(OP_FIELDS.propose, ['title', 'reason', 'ops']);
  assert.deepEqual((tool.inputSchema['required'] as string[]).sort(), ['ops', 'reason', 'title']);
});

test('the harness_plan_edit description names every op it offers', () => {
  const description = toolOf('harness_plan_edit')!.description;
  for (const op of AGENT_OPS) assert.match(description, new RegExp(`\\b${op} \\{`), `${op} is not described`);
});

/* ------------------------------------------------------------------ *
 * When to ask (#63)
 * ------------------------------------------------------------------ */

/**
 * Where the agent is told what to do: the skills, the slash commands, and
 * the prose the daemon and the MCP server send — prompts, briefs, replies,
 * refusals, tool descriptions. Code comments are not told to anyone.
 */
const TOLD = [
  ...listDir('skills', '.md'),
  ...listDir('commands', '.md'),
  ...listDir('src/daemon', '.ts'),
  ...listDir('src/mcp', '.ts'),
  ...listDir('src/shared', '.ts'),
];

/** An instruction to ask the user: "ask the user", "ask them with …",
 *  "stop and ask", "ask only …". Not "the review asks for changes", a
 *  variable called `asked` or the `"ask"` setting. */
const ASK_PHRASE = /\b(?:ask|asks|asking)\s+(?:the user|them|you|with|in chat|here|only|before|first|if|whatever|anything|what|several)\b|\b(?:and|stop and) ask\b/i;

type Why = 'the rule' | 'cannot be undone' | 'reaches outside the session' | "the user's by right, in a Managed build";

/**
 * Every place the agent is told to ask the user, and which case of the
 * rule allows it. A new one fails the test below until it is listed here
 * under a case it belongs to — or, better, the agent is told to decide
 * and carry on instead.
 */
const ALLOWED_ASKS: { file: string; text: string; why: Why }[] = [
  // The rule itself: stated once in the coplan skill, and in each prompt.
  { file: 'skills/coplan/SKILL.md', text: 'This is the one rule for asking the user anything', why: 'the rule' },
  { file: 'skills/coplan/SKILL.md', text: 'Ask only when a decision:', why: 'the rule' },
  { file: 'skills/coplan/SKILL.md', text: 'When you do ask, ask here in chat', why: 'the rule' },
  { file: 'skills/coplan/SKILL.md', text: '- Ask only as *When to ask* says', why: 'the rule' },
  { file: 'skills/coplan-build/SKILL.md', text: "Ask the user only as the `coplan` skill's *When to ask* says", why: 'the rule' },
  { file: 'skills/iric/SKILL.md', text: "Ask the user only as the `coplan` skill's *When to ask* says", why: 'the rule' },
  { file: 'src/daemon/render.ts', text: '`Ask the user, with ${agent.askWith}, only when', why: 'the rule' },
  { file: 'src/mcp/tools.ts', text: "'Tasks here are the planned tasks, shown on the boxes that link them. Ask the user, with AskUserQuestion", why: 'the rule' },
  // Cannot be undone: replacing a config the user may have written.
  { file: 'commands/coplan-init.md', text: 'and ask before replacing it', why: 'cannot be undone' },
  // Reaches outside the session: pull requests, by default (pullRequests.open "ask").
  { file: 'src/daemon/render.ts', text: "'once the user says to: ask them first'", why: 'reaches outside the session' },
  // The user's by right, in a Managed build: what its gates keep for them.
  { file: 'skills/iric/SKILL.md', text: 'does, files, checks) and ask with your question tool', why: "the user's by right, in a Managed build" },
  { file: 'src/daemon/brief.ts', text: 'show the user the change and ask them, with', why: "the user's by right, in a Managed build" },
  { file: 'src/daemon/main.ts', text: 'so dropping it is theirs to decide: ask them with', why: "the user's by right, in a Managed build" },
  { file: 'src/daemon/main.ts', text: 'and ask the user — another round, accept it as it is', why: "the user's by right, in a Managed build" },
  { file: 'src/daemon/main.ts', text: 'mark it blocked with a note saying so and ask the user;', why: "the user's by right, in a Managed build" },
  { file: 'src/daemon/main.ts', text: 'and they have not passed it: show them the change and ask with', why: "the user's by right, in a Managed build" },
  { file: 'src/daemon/main.ts', text: "This task's review is the user's: show them the change and ask with", why: "the user's by right, in a Managed build" },
];

/** Each line of a source that tells the agent to ask, with where it is. */
function asksIn(rel: string, text: string): { where: string; line: string }[] {
  const out: { where: string; line: string }[] = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (rel.endsWith('.ts') && (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))) return;
    if (ASK_PHRASE.test(line)) out.push({ where: `${rel}:${i + 1}`, line });
  });
  return out;
}

/** What breaks the rule: asks no allowed case covers, and allowed cases
 *  that no longer match exactly one line. */
function askProblems(sources: { rel: string; text: string }[], allowed: typeof ALLOWED_ASKS): string[] {
  const problems: string[] = [];
  const used = new Map<(typeof ALLOWED_ASKS)[number], number>();
  for (const { rel, text } of sources) {
    for (const ask of asksIn(rel, text)) {
      const entry = allowed.find((a) => a.file === rel && ask.line.includes(a.text));
      if (!entry) problems.push(`${ask.where} tells the agent to ask outside the allowed cases: ${ask.line.trim()}`);
      else used.set(entry, (used.get(entry) ?? 0) + 1);
    }
  }
  for (const a of allowed) {
    const n = used.get(a) ?? 0;
    if (sources.some((s) => s.rel === a.file) && n !== 1) problems.push(`${a.file}: "${a.text}" (${a.why}) matches ${n} asks, not 1`);
  }
  return problems;
}

test('the agent is told to ask the user only where the one rule allows it', () => {
  const sources = TOLD.map((rel) => ({ rel, text: read(rel) }));
  assert.deepEqual(askProblems(sources, ALLOWED_ASKS), []);
  // Counted: every allowed case is in use, and nothing else asks.
  const total = sources.reduce((n, s) => n + asksIn(s.rel, s.text).length, 0);
  assert.equal(total, ALLOWED_ASKS.length);
});

test('a new "ask the user" anywhere the agent reads fails the check', () => {
  const skill = read('skills/coplan-build/SKILL.md');
  const added = `${skill}\n- **A test is flaky** — mark the task blocked and ask the user what to do.\n`;
  const problems = askProblems([{ rel: 'skills/coplan-build/SKILL.md', text: added }], ALLOWED_ASKS);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /tells the agent to ask outside the allowed cases: - \*\*A test is flaky\*\*/);
  // In the daemon's prose too, but not in a comment.
  const reply = "out.push('Tell them it is ready, and ask anything you need decided.');\n// the agent may ask the user here";
  assert.equal(askProblems([{ rel: 'src/daemon/main.ts', text: reply }], []).length, 1);
});

test('the rule for asking is stated once in the coplan skill, and once in every prompt', async () => {
  const skill = read('skills/coplan/SKILL.md');
  assert.equal(skill.match(/^## When to ask$/gm)?.length, 1);
  for (const point of ['cannot be undone', 'reaches outside this session', "is the user's by right"]) assert.ok(skill.includes(point), `the skill names "${point}"`);
  const { buildPrompt, designPrompt } = await import('../daemon/render.ts');
  const { publishPlan, confirmDesign } = await import('../shared/plan.ts');
  const plan = confirmDesign(publishPlan(null, { title: 'P', tasks: [{ title: 'T' }] }).plan, { prompt: 'p' });
  const prompts = {
    design: designPrompt(plan),
    managed: buildPrompt(plan, { target: 'session', mode: 'managed' }),
    tracked: buildPrompt(plan, { target: 'session', mode: 'tracked' }),
  };
  for (const [name, built] of Object.entries(prompts)) {
    assert.equal(built.blocks.filter((b) => b.id === 'ask-rule').length, 1, `${name}: one rule`);
    assert.equal(built.prompt.match(/\*\*When to ask\.\*\*/g)?.length, 1, `${name}: stated once`);
  }
  assert.match(prompts.managed.prompt, /theirs by right — in this Managed build/);
  assert.doesNotMatch(prompts.tracked.prompt, /by right/, 'a Tracked build keeps nothing back for the user');
  const exported = buildPrompt(plan, { target: 'elsewhere' }).prompt;
  assert.doesNotMatch(exported, /When to ask|\bask\b/i, 'an export tells no one anything');
});
