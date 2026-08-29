// src/test/markdown.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/ui/lib/markdown.ts
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var XML_BLOCKS = {
  "command-name": { mode: "command", label: "name" },
  "command-args": { mode: "command", label: "args" },
  "command-message": { mode: "command", label: "message" },
  "system-reminder": { mode: "details", label: "system reminder" },
  "local-command-stdout": { mode: "details", label: "command output" },
  "local-command-stderr": { mode: "details", label: "command error output" },
  "user-prompt-submit-hook": { mode: "details", label: "hook output" },
  "ide_selection": { mode: "details", label: "editor selection" },
  "ide-selection": { mode: "details", label: "editor selection" },
  "function_results": { mode: "details", label: "tool result" },
  "task-notification": { mode: "details", label: "task notification" }
};
function matchXmlBlock(lines, i) {
  const open = /^\s*<([A-Za-z][\w:.-]*)\s*>(.*)$/.exec(lines[i] ?? "");
  if (!open) return null;
  const raw = open[1];
  const tag = raw.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(XML_BLOCKS, tag)) return null;
  const close = `</${raw}>`;
  const rest = open[2] ?? "";
  const inline2 = rest.indexOf(close);
  if (inline2 >= 0) return { tag, body: rest.slice(0, inline2), endLine: i };
  const body = rest ? [rest] : [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    const at = line.indexOf(close);
    if (at >= 0) {
      if (line.slice(0, at)) body.push(line.slice(0, at));
      return { tag, body: body.join("\n"), endLine: j };
    }
    body.push(line);
  }
  return null;
}
function renderCommandGroup(fields) {
  const name = fields.get("command-name")?.trim();
  const args = fields.get("command-args")?.trim();
  const message = fields.get("command-message")?.trim();
  const head = [];
  if (name) head.push(`<span class="md-command-name">${escapeHtml(name)}</span>`);
  if (args) head.push(`<span class="md-command-args">${escapeHtml(args)}</span>`);
  const extra = message && message !== name && `/${message}` !== name ? message : "";
  return `<div class="md-command">` + (head.length ? `<div class="md-command-head">${head.join("")}</div>` : "") + (extra ? `<div class="md-command-message">${escapeHtml(extra)}</div>` : "") + `</div>`;
}
function renderDetailsBlock(spec, tag, body) {
  const text = body.replace(/^\n+|\n+$/g, "");
  return `<details class="md-xml is-${escapeHtml(tag)}"><summary>${escapeHtml(spec.label)}</summary><pre class="md-xml-body">${escapeHtml(text)}</pre></details>`;
}
function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuffer = [];
  let paragraph = [];
  const lists = [];
  let command = null;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeDeepestList = () => {
    const list = lists.pop();
    if (!list) return;
    out.push("</li>");
    out.push(`</${list.type}>`);
  };
  const closeLists = () => {
    while (lists.length) closeDeepestList();
  };
  const flushCommand = () => {
    if (!command) return;
    out.push(renderCommandGroup(command));
    command = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    closeLists();
    flushCommand();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        out.push(
          `<pre class="md-code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ""}><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`
        );
        codeBuffer = [];
        inCode = false;
        codeLang = "";
      } else {
        flushBlocks();
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    const xml = matchXmlBlock(lines, i);
    if (xml) {
      const spec = XML_BLOCKS[xml.tag];
      if (spec.mode === "command") {
        flushParagraph();
        closeLists();
        command ??= /* @__PURE__ */ new Map();
        command.set(xml.tag, xml.body);
      } else {
        flushBlocks();
        out.push(renderDetailsBlock(spec, xml.tag, xml.body));
      }
      i = xml.endLine;
      continue;
    }
    if (!line.trim()) {
      flushBlocks();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushBlocks();
      const level = heading[1].length + 1;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const table = matchTable(lines, i);
    if (table) {
      flushBlocks();
      out.push(table.html);
      i = table.endLine;
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushBlocks();
      out.push("<hr />");
      continue;
    }
    const item = matchListItem(line);
    if (item) {
      flushParagraph();
      flushCommand();
      pushListItem(out, lists, item);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushBlocks();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode && codeBuffer.length) {
    out.push(`<pre class="md-code"><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  }
  flushBlocks();
  return out.join("\n");
}
function matchListItem(line) {
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  const ordered = bullet ? null : /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
  const match = bullet ?? ordered;
  if (!match) return null;
  const indent = (match[1] ?? "").replace(/\t/g, "  ").length;
  let content = match[2] ?? "";
  const item = { type: bullet ? "ul" : "ol", indent, content };
  const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
  if (task && bullet) {
    item.task = true;
    item.checked = task[1] !== " ";
    content = task[2] ?? "";
    item.content = content;
  }
  return item;
}
function pushListItem(out, lists, item) {
  const closeDeepest = () => {
    const list = lists.pop();
    if (!list) return;
    out.push("</li>");
    out.push(`</${list.type}>`);
  };
  while (lists.length > 1 && item.indent < lists[lists.length - 1].indent) closeDeepest();
  const top = lists[lists.length - 1];
  if (!top || item.indent > top.indent) {
    out.push(`<${item.type}>`);
    lists.push({ type: item.type, indent: item.indent });
  } else if (top.type !== item.type) {
    closeDeepest();
    out.push(`<${item.type}>`);
    lists.push({ type: item.type, indent: item.indent });
  } else {
    out.push("</li>");
  }
  const box = item.task ? `<input type="checkbox" disabled${item.checked ? " checked" : ""} /> ` : "";
  const cls = item.task ? ` class="md-task${item.checked ? " is-done" : ""}"` : "";
  out.push(`<li${cls}>${box}${inline(item.content)}`);
}
function matchTable(lines, i) {
  const header = lines[i] ?? "";
  const divider = lines[i + 1] ?? "";
  if (!/\|/.test(header)) return null;
  if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(divider)) return null;
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const heads = cells(header);
  const aligns = cells(divider).map(
    (c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""
  );
  const align = (n) => aligns[n] ? ` style="text-align:${aligns[n]}"` : "";
  const body = [];
  let end = i + 1;
  for (let j = i + 2; j < lines.length; j++) {
    const row = lines[j] ?? "";
    if (!row.trim() || !row.includes("|")) break;
    const tds = cells(row).map((c, n) => `<td${align(n)}>${inline(c)}</td>`).join("");
    body.push(`<tr>${tds}</tr>`);
    end = j;
  }
  const ths = heads.map((c, n) => `<th${align(n)}>${inline(c)}</th>`).join("");
  const html = `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead>` + (body.length ? `<tbody>${body.join("")}</tbody>` : "") + `</table></div>`;
  return { html, endLine: end };
}
var CODE_MARK = "\0";
function inline(text) {
  let html = escapeHtml(text);
  const spans = [];
  html = html.replace(/`([^`]+)`/g, (_all, body) => {
    spans.push(`<code>${body}</code>`);
    return `${CODE_MARK}${spans.length - 1}${CODE_MARK}`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  return html.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g"), (_all, n) => spans[Number(n)] ?? "");
}

// src/test/markdown.test.ts
test("markup in the source is escaped, never emitted", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> and <b>bold</b>');
  assert.ok(!html.includes("<img"), "no raw tag survives");
  assert.ok(!html.includes("<b>"), "no raw tag survives");
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("onerror=&quot;alert(1)&quot;"));
});
test("an unrecognised XML tag is escaped rather than swallowed", () => {
  const html = renderMarkdown("<made-up>payload</made-up>");
  assert.ok(html.includes("&lt;made-up&gt;payload&lt;/made-up&gt;"));
});
test("markup inside a code fence stays literal", () => {
  const html = renderMarkdown("```\n<system-reminder>hi</system-reminder>\n```");
  assert.ok(html.includes('<pre class="md-code">'));
  assert.ok(html.includes("&lt;system-reminder&gt;"));
  assert.ok(!html.includes("<details"), "a quoted tag is code, not a block");
});
test("a slash command renders as one chip instead of three raw tags", () => {
  const html = renderMarkdown(
    "<command-message>cc-harness:harness</command-message>\n<command-name>/cc-harness:harness</command-name>\n<command-args>security audit for packages - reusable pattern</command-args>"
  );
  assert.ok(!html.includes("&lt;command-name&gt;"), "the tags themselves are gone");
  assert.equal((html.match(/md-command"/g) ?? []).length, 1, "the trio is one chip, not three");
  assert.ok(html.includes('<span class="md-command-name">/cc-harness:harness</span>'));
  assert.ok(html.includes("security audit for packages - reusable pattern"));
});
test("a command message that only repeats the name is not shown twice", () => {
  const html = renderMarkdown(
    "<command-message>cc-harness:harness</command-message>\n<command-name>/cc-harness:harness</command-name>"
  );
  assert.ok(!html.includes("md-command-message"));
});
test("a command message that says something else is kept", () => {
  const html = renderMarkdown(
    "<command-message>running the audit</command-message>\n<command-name>/audit</command-name>"
  );
  assert.ok(html.includes('<div class="md-command-message">running the audit</div>'));
});
test("machinery blocks fold away but keep their content", () => {
  const html = renderMarkdown("<system-reminder>\nbudget is low\n</system-reminder>");
  assert.ok(html.includes('<details class="md-xml is-system-reminder">'));
  assert.ok(html.includes("<summary>system reminder</summary>"));
  assert.ok(html.includes("budget is low"));
});
test("a multi-line block is captured whole", () => {
  const html = renderMarkdown("<local-command-stdout>\nline one\nline two\n</local-command-stdout>");
  assert.ok(html.includes("line one\nline two"));
});
test("an unterminated block is left as plain text", () => {
  const html = renderMarkdown("<system-reminder>oops\n\nreal content here");
  assert.ok(html.includes("&lt;system-reminder&gt;oops"));
  assert.ok(html.includes("real content here"));
});
test("prose around a block is still rendered as markdown", () => {
  const html = renderMarkdown("Before\n\n<command-name>/go</command-name>\n\n**After**");
  assert.ok(html.includes("<p>Before</p>"));
  assert.ok(html.includes("md-command-name"));
  assert.ok(html.includes("<strong>After</strong>"));
});
test("emphasis, strike and inline code render", () => {
  const html = renderMarkdown("**bold** and *italic* and ~~gone~~ and `code`");
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>italic</em>"));
  assert.ok(html.includes("<del>gone</del>"));
  assert.ok(html.includes("<code>code</code>"));
});
test("emphasis markers inside a code span stay literal", () => {
  const html = renderMarkdown("use `a **b** c` here");
  assert.ok(html.includes("<code>a **b** c</code>"));
  assert.ok(!html.includes("<strong>"));
});
test("lists nest by indentation", () => {
  const html = renderMarkdown("- one\n  - nested\n- two");
  assert.equal((html.match(/<ul>/g) ?? []).length, 2, "the indented item opens a child list");
  assert.equal((html.match(/<\/ul>/g) ?? []).length, 2, "and it is closed again");
  assert.ok(html.includes("nested"));
});
test("an ordered list is not folded into a bulleted one", () => {
  const html = renderMarkdown("- bullet\n\n1. first\n2. second");
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<ol>"));
});
test("task list items render as checkboxes", () => {
  const html = renderMarkdown("- [x] done\n- [ ] todo");
  assert.ok(html.includes('<input type="checkbox" disabled checked />'));
  assert.ok(html.includes('<input type="checkbox" disabled />'));
  assert.ok(html.includes('class="md-task is-done"'));
});
test("a table renders with its header and alignment", () => {
  const html = renderMarkdown("| a | b |\n| --- | ---: |\n| 1 | 2 |");
  assert.ok(html.includes('<table class="md-table">'));
  assert.ok(html.includes("<th>a</th>"));
  assert.ok(html.includes('<th style="text-align:right">b</th>'));
  assert.ok(html.includes("<td>1</td>"));
  assert.ok(html.includes("md-table-wrap"), "a wide table scrolls in its own box");
});
test("a rule is a rule, and a table divider is not", () => {
  assert.ok(renderMarkdown("above\n\n---\n\nbelow").includes("<hr />"));
  assert.ok(!renderMarkdown("| a |\n| --- |\n| 1 |").includes("<hr />"));
});
test("a fenced block keeps its language and its contents verbatim", () => {
  const html = renderMarkdown("```ts\nconst a = 1;\n```");
  assert.ok(html.includes('data-lang="ts"'));
  assert.ok(html.includes("const a = 1;"));
});
test("links open in a new tab, and bare urls are linked", () => {
  const md = renderMarkdown("[docs](https://example.com/a) and https://example.com/b");
  assert.ok(md.includes('<a href="https://example.com/a" target="_blank" rel="noreferrer">docs</a>'));
  assert.ok(md.includes('<a href="https://example.com/b"'));
});
test("a javascript: url is not turned into a link", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!html.includes("<a "), "only http(s) targets are linkified");
});
test("empty input produces empty output", () => {
  assert.equal(renderMarkdown(""), "");
});
//# sourceMappingURL=markdown.test.js.map
