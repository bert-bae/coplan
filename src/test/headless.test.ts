import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmDesign, publishPlan, publishTasks } from '../shared/plan.ts';
import { diagramMermaid, mermaidText, tasksMermaid } from '../shared/mermaid.ts';
import { headlessText } from '../daemon/render.ts';
import type { Diagram, PlanInput } from '../shared/types.ts';

/**
 * A headless plan (`/coplan --headless`): the plan as Markdown, its diagrams
 * and task list drawn as Mermaid graphs, for an agent the browser cannot
 * reach.
 */

const INPUT: PlanInput = {
  title: 'Add a cache',
  mode: 'architect',
  summary: 'Reads are slow; a read-through cache in front of Postgres fixes it without touching writers.',
  diagrams: [
    {
      title: 'Components',
      nodes: [
        { id: 'end', label: 'API "v2"', kind: 'service', detail: 'Node <20>', taskIds: ['wire'] },
        { id: 'cache', label: 'Cache', kind: 'datastore', taskIds: ['client'] },
        { id: 'user', label: 'User', kind: 'actor' },
      ],
      edges: [
        { source: 'user', target: 'end', label: 'GET | HEAD' },
        { source: 'end', target: 'cache', dashed: true, arrows: 'both' },
      ],
    },
  ],
  tasks: [
    { id: 'client', title: 'Cache client' },
    { id: 'wire', title: 'Wire into API', dependsOn: ['client'] },
  ],
};

test('a diagram is drawn as Mermaid: a shape per kind, its arrows, and the tasks on each box', () => {
  const d = publishPlan(null, INPUT, 1000).plan.diagrams[0]!;
  const lines = diagramMermaid(d);
  assert.equal(lines[0], '```mermaid');
  assert.equal(lines.at(-1), '```');
  // Ids are the graph's own: `end` is a word Mermaid reserves.
  assert.ok(lines.includes('  n0("API #quot;v2#quot;<br/>Node #lt;20#gt;<br/>tasks: wire")'), lines.join('\n'));
  assert.ok(lines.includes('  n1[("Cache<br/>tasks: client")]'));
  assert.ok(lines.includes('  n2(["User"])'));
  assert.ok(lines.includes('  n2 -->|"GET #124; HEAD"| n0'));
  assert.ok(lines.includes('  n0 <-.-> n1'));
  const none: Pick<Diagram, 'nodes' | 'edges' | 'direction'> = { nodes: d.nodes, edges: [{ id: 'x', source: 'n9', target: 'end' }], direction: 'TB' };
  assert.equal(diagramMermaid(none)[1], 'flowchart TB');
  assert.equal(diagramMermaid(none).filter((l) => l.includes('-->')).length, 0, 'an arrow to no box is left out');
});

test('the task list is drawn as what waits on what, nested, coloured by status', () => {
  const plan = publishPlan(
    null,
    {
      title: 'P',
      mode: 'tasklist',
      tasks: [
        { id: 'store', title: 'Storage', subtasks: [{ id: 'a', title: 'A', status: 'done' }, { id: 'b', title: 'B' }] },
        { id: 'api', title: 'API', dependsOn: ['store'], status: 'in_progress' },
      ],
    },
    1000,
  ).plan;
  const lines = tasksMermaid(plan);
  assert.deepEqual(lines.slice(0, 7), ['```mermaid', 'flowchart LR', '  subgraph t0["store · Storage"]', '    t1["✓ a · A"]:::done', '    t2["b · B"]', '  end', '  t3["▶ api · API"]:::in_progress']);
  assert.ok(lines.includes('  t0 --> t3'), 'from what it waits on to the task');
  assert.equal(tasksMermaid({ tasks: [] }).length, 0);
});

test('label text cannot break out of its quotes', () => {
  assert.equal(mermaidText('a "b" <c>\n# `d` | e'), 'a #quot;b#quot; #lt;c#gt; #35; #96;d#96; #124; e');
});

test('the headless file leads with where the plan is and what to say in chat, then draws it', () => {
  const plan = publishPlan(null, INPUT, Date.UTC(2026, 10, 18, 9, 30)).plan;
  const text = headlessText(plan, { agent: 'claude' });
  const [title, , lead, , next] = text.split('\n');
  assert.equal(title, '# Add a cache');
  assert.equal(lead, '> **Coplan plan** · **Architecture** → Task list → Build · updated 2026-11-18 09:30 UTC');
  assert.match(next!, /Tell Claude in chat what to change; when the design is right, tell it to confirm the design/);
  assert.match(text, /## Summary\nReads are slow/);
  assert.equal(text.match(/```mermaid/g)?.length, 2, 'the diagram and the task list');
  assert.ok(text.indexOf('```mermaid\nflowchart LR\n  n0') < text.indexOf('**Parts**'), 'the graph before the parts in words');
  assert.doesNotMatch(text, /harness_/, 'no tool names: it is for the user');
  // Once the design is confirmed and the task list made, it says so.
  const listed = publishTasks(confirmDesign(plan, { prompt: 'p' }), { tasks: [{ id: 'client', title: 'Cache client', detail: 'd' }] }).plan;
  assert.match(headlessText(listed, { agent: 'codex' }), /Architecture → \*\*Task list\*\* → Build[^\n]*\n>\n> The design is confirmed\. Review the task list made from it below; tell Codex/);
});
