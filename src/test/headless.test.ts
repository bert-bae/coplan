import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { confirmDesign, planPhase, publishPlan, publishTasks } from '../shared/plan.ts';
import { diagramMermaid, mermaidText, tasksMermaid } from '../shared/mermaid.ts';
import { headlessPage, headlessText } from '../daemon/render.ts';
import { planDocument, planOf, planPage, type WrittenPlan } from '../artifact/render.ts';
import type { Diagram, Plan, PlanInput } from '../shared/types.ts';

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

test('a plan the agent writes into the page is laid out as Coplan stores one', () => {
  const written: WrittenPlan = {
    ...INPUT,
    tasks: [
      { id: 'client', title: 'Cache client', builds: ['d1/cache'], subtasks: [{ id: 'conn', title: 'Connect', status: 'done' }, { title: 'Evict' }] },
      { id: 'wire', title: 'Wire into API', dependsOn: ['client'] },
    ],
  };
  const plan = planOf(written);
  assert.deepEqual(
    plan.tasks.map((t) => [t.id, t.parentId, t.status]),
    [['client', null, 'todo'], ['conn', 'client', 'done'], ['client.2', 'client', 'todo'], ['wire', null, 'todo']],
  );
  assert.deepEqual(plan.diagrams[0]!.nodes.find((n) => n.id === 'cache')!.taskIds, ['client'], 'builds links the task to its box once');
  assert.equal(planPhase(plan), 'planning');
  // The user's word in chat, recorded by the agent, moves it on.
  const confirmed = planOf({ ...written, design: { userSaid: 'looks right', at: '2026-11-21T10:00:00Z' } });
  assert.equal(planPhase(confirmed), 'tasking');
  assert.match(planPage(confirmed, 'Claude'), /Design confirmed in chat on 2026-11-21: “looks right”/);
  assert.equal(planPhase(planOf({ ...written, submission: { userSaid: 'build it' } })), 'building');
});

test('the page shows the overview, each diagram as a graph, and the task list, with ids to name in chat', () => {
  const html = planPage(planOf({ ...INPUT, title: 'A <b>bold</b> plan', sections: [{ title: 'Risks', body: '- **TTL** lag' }] }), 'Claude');
  assert.match(html, /<h1>A &lt;b&gt;bold&lt;\/b&gt; plan<\/h1>/, 'text is escaped');
  assert.match(html, /<li class="now">Architecture<\/li><li class="">Task list<\/li><li class="">Build<\/li>/);
  assert.match(html, /Tell Claude in chat what to change; when the design is right, tell it to confirm the design/);
  assert.match(html, /<h3>Risks<\/h3><div class="md"><ul>\s*<li><strong>TTL<\/strong> lag/);
  assert.match(html, /<pre class="mermaid">flowchart LR\n {2}n0\(&quot;API #quot;v2#quot;&lt;br\/&gt;/, 'the diagram, its fence left off');
  assert.match(html, /<code class="ref">d1\/cache<\/code>/);
  assert.match(html, /<h2>Task ideas<\/h2>/, 'coarse until the design is confirmed');
  assert.match(html, /Waits on <code class="ref">client<\/code>/);
  assert.match(html, /<h4>Build order<\/h4>/);
});

test('the PDF document has the overview and each diagram as its PNG, without the tasks', () => {
  const plan = planOf(INPUT);
  const html = planDocument(plan, new Map([[plan.diagrams[0]!.id, 'data:image/png;base64,AAA']]));
  assert.match(html, /<title>Add a cache<\/title>/);
  assert.match(html, /read-through cache/);
  assert.match(html, /<img src="data:image\/png;base64,AAA" alt="Components">/);
  assert.doesNotMatch(html, /mermaid|Wire into API<\/li>|id="tasks"/);
  assert.match(html, /API &quot;v2&quot;/);
});

test('the daemon writes its plan into the built page, where nothing in it can close the block', () => {
  const template = readFileSync(new URL('../artifact/plan.html', import.meta.url), 'utf8');
  assert.equal(template.split('<script type="application/json" id="plan">null</script>').length, 2, 'one block to fill');
  assert.doesNotMatch(template, /\/\*APP\*\//, 'the script is inlined');
  const plan = publishPlan(null, { ...INPUT, title: 'Stop </script><script>alert(1)</script>' }, 1000).plan;
  const page = headlessPage(template, plan, 'claude');
  assert.match(page, /<title>Stop &lt;\/script>&lt;script>alert\(1\)&lt;\/script><\/title>/);
  const block = page.match(/<script type="application\/json" id="plan">(.*?)<\/script>/s)![1]!;
  const data = JSON.parse(block) as Plan & { agent: string };
  assert.equal(data.title, plan.title, 'the title survives, escaped');
  assert.equal(data.agent, 'Claude');
  assert.equal(data.changes, undefined, 'the change log stays out');
  assert.equal(planOf(data), data, 'a stored plan is drawn as it is');
});
