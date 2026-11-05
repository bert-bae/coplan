import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_OPS, TOOLS } from '../mcp/tools.ts';
import { OP_FIELDS, PROGRESS_FIELDS } from '../shared/plan.ts';

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
  const union = new Set(AGENT_OPS.flatMap((op) => (OP_FIELDS[op] as readonly string[]).filter((f) => !(PROGRESS_FIELDS as readonly string[]).includes(f))));
  assert.deepEqual(
    Object.keys(props)
      .filter((k) => k !== 'op')
      .sort(),
    [...union].sort(),
  );
  assert.equal(item['additionalProperties'], false);
});

test('the harness_plan_edit description names every op it offers', () => {
  const description = toolOf('harness_plan_edit')!.description;
  for (const op of AGENT_OPS) assert.match(description, new RegExp(`\\b${op} \\{`), `${op} is not described`);
});
