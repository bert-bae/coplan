import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../ui/lib/markdown.ts';

/**
 * The markdown renderer.
 *
 * Its output is handed to `dangerouslySetInnerHTML`, so the escaping tests
 * here are load-bearing: assistant and tool output is untrusted text, and any
 * path that reaches the DOM unescaped is an injection.
 */

/* ----------------------------------------------------------- safety */

test('markup in the source is escaped, never emitted', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> and <b>bold</b>');
  assert.ok(!html.includes('<img'), 'no raw tag survives');
  assert.ok(!html.includes('<b>'), 'no raw tag survives');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('onerror=&quot;alert(1)&quot;'));
});

test('an unrecognised XML tag is escaped rather than swallowed', () => {
  // Only known transcript tags are lifted out; everything else is text, and
  // losing it would silently drop content the reader needs.
  const html = renderMarkdown('<made-up>payload</made-up>');
  assert.ok(html.includes('&lt;made-up&gt;payload&lt;/made-up&gt;'));
});

test('markup inside a code fence stays literal', () => {
  const html = renderMarkdown('```\n<system-reminder>hi</system-reminder>\n```');
  assert.ok(html.includes('<pre class="md-code">'));
  assert.ok(html.includes('&lt;system-reminder&gt;'));
  assert.ok(!html.includes('<details'), 'a quoted tag is code, not a block');
});

/* ------------------------------------------------- transcript blocks */

test('a slash command renders as one chip instead of three raw tags', () => {
  const html = renderMarkdown(
    '<command-message>cc-harness:harness</command-message>\n' +
      '<command-name>/cc-harness:harness</command-name>\n' +
      '<command-args>security audit for packages - reusable pattern</command-args>',
  );

  assert.ok(!html.includes('&lt;command-name&gt;'), 'the tags themselves are gone');
  assert.equal((html.match(/md-command"/g) ?? []).length, 1, 'the trio is one chip, not three');
  assert.ok(html.includes('<span class="md-command-name">/cc-harness:harness</span>'));
  assert.ok(html.includes('security audit for packages - reusable pattern'));
});

test('a command message that only repeats the name is not shown twice', () => {
  const html = renderMarkdown(
    '<command-message>cc-harness:harness</command-message>\n<command-name>/cc-harness:harness</command-name>',
  );
  assert.ok(!html.includes('md-command-message'));
});

test('a command message that says something else is kept', () => {
  const html = renderMarkdown(
    '<command-message>running the audit</command-message>\n<command-name>/audit</command-name>',
  );
  assert.ok(html.includes('<div class="md-command-message">running the audit</div>'));
});

test('machinery blocks fold away but keep their content', () => {
  const html = renderMarkdown('<system-reminder>\nbudget is low\n</system-reminder>');
  assert.ok(html.includes('<details class="md-xml is-system-reminder">'));
  assert.ok(html.includes('<summary>system reminder</summary>'));
  assert.ok(html.includes('budget is low'));
});

test('a multi-line block is captured whole', () => {
  const html = renderMarkdown('<local-command-stdout>\nline one\nline two\n</local-command-stdout>');
  assert.ok(html.includes('line one\nline two'));
});

test('an unterminated block is left as plain text', () => {
  // Consuming to end-of-input would hide everything after a stray open tag.
  const html = renderMarkdown('<system-reminder>oops\n\nreal content here');
  assert.ok(html.includes('&lt;system-reminder&gt;oops'));
  assert.ok(html.includes('real content here'));
});

test('prose around a block is still rendered as markdown', () => {
  const html = renderMarkdown('Before\n\n<command-name>/go</command-name>\n\n**After**');
  assert.ok(html.includes('<p>Before</p>'));
  assert.ok(html.includes('md-command-name'));
  assert.ok(html.includes('<strong>After</strong>'));
});

/* ---------------------------------------------------------- markdown */

test('emphasis, strike and inline code render', () => {
  const html = renderMarkdown('**bold** and *italic* and ~~gone~~ and `code`');
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<del>gone</del>'));
  assert.ok(html.includes('<code>code</code>'));
});

test('emphasis markers inside a code span stay literal', () => {
  // The code span is lifted out before the emphasis passes run; without that,
  // real code gets silently rewritten.
  const html = renderMarkdown('use `a **b** c` here');
  assert.ok(html.includes('<code>a **b** c</code>'));
  assert.ok(!html.includes('<strong>'));
});

test('lists nest by indentation', () => {
  const html = renderMarkdown('- one\n  - nested\n- two');
  assert.equal((html.match(/<ul>/g) ?? []).length, 2, 'the indented item opens a child list');
  assert.equal((html.match(/<\/ul>/g) ?? []).length, 2, 'and it is closed again');
  assert.ok(html.includes('nested'));
});

test('an ordered list is not folded into a bulleted one', () => {
  const html = renderMarkdown('- bullet\n\n1. first\n2. second');
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<ol>'));
});

test('task list items render as checkboxes', () => {
  const html = renderMarkdown('- [x] done\n- [ ] todo');
  assert.ok(html.includes('<input type="checkbox" disabled checked />'));
  assert.ok(html.includes('<input type="checkbox" disabled />'));
  assert.ok(html.includes('class="md-task is-done"'));
});

test('a table renders with its header and alignment', () => {
  const html = renderMarkdown('| a | b |\n| --- | ---: |\n| 1 | 2 |');
  assert.ok(html.includes('<table class="md-table">'));
  assert.ok(html.includes('<th>a</th>'));
  assert.ok(html.includes('<th style="text-align:right">b</th>'));
  assert.ok(html.includes('<td>1</td>'));
  assert.ok(html.includes('md-table-wrap'), 'a wide table scrolls in its own box');
});

test('a rule is a rule, and a table divider is not', () => {
  assert.ok(renderMarkdown('above\n\n---\n\nbelow').includes('<hr />'));
  assert.ok(!renderMarkdown('| a |\n| --- |\n| 1 |').includes('<hr />'));
});

test('a fenced block keeps its language and its contents verbatim', () => {
  const html = renderMarkdown('```ts\nconst a = 1;\n```');
  assert.ok(html.includes('data-lang="ts"'));
  assert.ok(html.includes('const a = 1;'));
});

test('links open in a new tab, and bare urls are linked', () => {
  const md = renderMarkdown('[docs](https://example.com/a) and https://example.com/b');
  assert.ok(md.includes('<a href="https://example.com/a" target="_blank" rel="noreferrer">docs</a>'));
  assert.ok(md.includes('<a href="https://example.com/b"'));
});

test('a javascript: url is not turned into a link', () => {
  const html = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!html.includes('<a '), 'only http(s) targets are linkified');
});

test('empty input produces empty output', () => {
  assert.equal(renderMarkdown(''), '');
});
