/**
 * A deliberately small markdown renderer.
 *
 * It covers what actually appears in a Claude session — fenced code, inline
 * code, headings, nested lists, task lists, tables, rules, bold/italic/strike,
 * links — plus the XML-ish blocks Claude Code injects into a transcript
 * (`<command-name>`, `<system-reminder>`, …), which would otherwise show up as
 * raw angle-bracket noise.
 *
 * Everything is escaped before it is formatted, so untrusted assistant output
 * can never inject markup.
 */

/** Escape before formatting, so assistant output can never inject markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ *
 * XML-ish transcript blocks
 * ------------------------------------------------------------------ */

/**
 * How each recognised tag renders.
 *
 * `command` tags are collected into a single chip, because Claude Code emits
 * the trio together and they describe one thing: the slash command that was
 * run. Everything else is machinery the reader mostly wants folded away, so it
 * renders as a `<details>` they can open when it matters.
 */
type XmlMode = 'command' | 'details';

interface XmlBlockSpec {
  mode: XmlMode;
  /** Summary text for `details`; the field name for `command`. */
  label: string;
}

const XML_BLOCKS: Record<string, XmlBlockSpec> = {
  'command-name': { mode: 'command', label: 'name' },
  'command-args': { mode: 'command', label: 'args' },
  'command-message': { mode: 'command', label: 'message' },
  'system-reminder': { mode: 'details', label: 'system reminder' },
  'local-command-stdout': { mode: 'details', label: 'command output' },
  'local-command-stderr': { mode: 'details', label: 'command error output' },
  'user-prompt-submit-hook': { mode: 'details', label: 'hook output' },
  'ide_selection': { mode: 'details', label: 'editor selection' },
  'ide-selection': { mode: 'details', label: 'editor selection' },
  'function_results': { mode: 'details', label: 'tool result' },
  'task-notification': { mode: 'details', label: 'task notification' },
};

interface XmlBlock {
  tag: string;
  body: string;
  /** Index of the last source line the block consumed. */
  endLine: number;
}

/**
 * Recognise a block opening on `lines[i]`.
 *
 * Only known tags match: prose and code are full of angle brackets that are
 * not markup (`a < b`, `Array<string>`), and swallowing them would lose text.
 * An unterminated block is not a block either — returning null leaves the line
 * to the normal escaping path, so nothing is ever silently dropped.
 */
function matchXmlBlock(lines: string[], i: number): XmlBlock | null {
  const open = /^\s*<([A-Za-z][\w:.-]*)\s*>(.*)$/.exec(lines[i] ?? '');
  if (!open) return null;
  const raw = open[1]!;
  const tag = raw.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(XML_BLOCKS, tag)) return null;

  const close = `</${raw}>`;
  const rest = open[2] ?? '';
  const inline = rest.indexOf(close);
  if (inline >= 0) return { tag, body: rest.slice(0, inline), endLine: i };

  const body: string[] = rest ? [rest] : [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!;
    const at = line.indexOf(close);
    if (at >= 0) {
      if (line.slice(0, at)) body.push(line.slice(0, at));
      return { tag, body: body.join('\n'), endLine: j };
    }
    body.push(line);
  }
  return null;
}

/** The `command-*` trio, rendered as one chip. */
function renderCommandGroup(fields: Map<string, string>): string {
  const name = fields.get('command-name')?.trim();
  const args = fields.get('command-args')?.trim();
  const message = fields.get('command-message')?.trim();

  const head: string[] = [];
  if (name) head.push(`<span class="md-command-name">${escapeHtml(name)}</span>`);
  if (args) head.push(`<span class="md-command-args">${escapeHtml(args)}</span>`);
  // The message repeats the command name often enough that showing both is
  // just noise; only surface it when it actually says something else.
  const extra = message && message !== name && `/${message}` !== name ? message : '';

  return (
    `<div class="md-command">` +
    (head.length ? `<div class="md-command-head">${head.join('')}</div>` : '') +
    (extra ? `<div class="md-command-message">${escapeHtml(extra)}</div>` : '') +
    `</div>`
  );
}

function renderDetailsBlock(spec: XmlBlockSpec, tag: string, body: string): string {
  const text = body.replace(/^\n+|\n+$/g, '');
  return (
    `<details class="md-xml is-${escapeHtml(tag)}">` +
    `<summary>${escapeHtml(spec.label)}</summary>` +
    `<pre class="md-xml-body">${escapeHtml(text)}</pre>` +
    `</details>`
  );
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';
  /** How far an open fence was indented: its lines lose that much. */
  let codeIndent = 0;
  let codeBuffer: string[] = [];
  let paragraph: string[] = [];
  // Where the next line that is not blank is, from each line: one pass, so
  // a long run of blank lines is not scanned again for each of them.
  const nextFilled: number[] = new Array(lines.length + 1).fill(lines.length);
  for (let k = lines.length - 1; k >= 0; k--) nextFilled[k] = lines[k]!.trim() ? k : nextFilled[k + 1]!;

  /** Open lists, outermost first. A `<li>` is always open at the deepest.
   *  `col` is where an item's text starts: what continues it is indented
   *  at least that far. */
  const lists: { type: 'ul' | 'ol'; indent: number; col: number }[] = [];
  /** Buffered `command-*` fields awaiting a flush. */
  let command: Map<string, string> | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeDeepestList = () => {
    const list = lists.pop();
    if (!list) return;
    out.push('</li>');
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
  /** Anything that is not a list item ends the list, and so on. */
  const flushBlocks = () => {
    flushParagraph();
    closeLists();
    flushCommand();
  };
  /** Something indented `indent` far, under an open list: it belongs to the
   *  deepest item whose text it reaches. Whether it is in the list at all. */
  const settleInList = (indent: number): boolean => {
    if (!lists.length || indent < lists[0]!.col) return false;
    while (lists.length > 1 && indent < lists[lists.length - 1]!.col) closeDeepestList();
    return true;
  };
  const closeCode = () => {
    out.push(
      `<pre class="md-code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ''}>` +
        `<code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`,
    );
    codeBuffer = [];
    inCode = false;
    codeLang = '';
    codeIndent = 0;
  };
  const indentOf = (text: string) => (/^\s*/.exec(text)![0] ?? '').replace(/\t/g, '  ').length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^(\s*)```(\w*)\s*$/.exec(line);
    if (inCode) {
      // Closed by a bare fence no deeper than the one that opened it: one
      // indented further, or one naming a language, is part of the code
      // (a block quoting a list step that holds its own fence, say).
      if (fence && !fence[2] && indentOf(line) <= codeIndent) closeCode();
      else codeBuffer.push(line.replace(/^\t+/, (tabs) => '  '.repeat(tabs.length)).replace(new RegExp(`^ {0,${codeIndent}}`), ''));
      continue;
    }
    if (fence) {
      const indent = indentOf(line);
      // Indented under a list item, as far as its text, the code is part of
      // that item: the list stays open around it, so the steps after it
      // count on. Elsewhere a fence is indented at most three spaces.
      if (settleInList(indent)) {
        flushParagraph();
        flushCommand();
      } else if (indent <= 3) {
        flushBlocks();
      }
      if (lists.length || indent <= 3) {
        inCode = true;
        codeLang = fence[2] ?? '';
        codeIndent = indent;
        continue;
      }
    }

    // Transcript machinery. Checked inside the loop rather than as a pre-pass
    // so a fenced code block that quotes one of these tags stays code.
    const xml = matchXmlBlock(lines, i);
    if (xml) {
      const spec = XML_BLOCKS[xml.tag]!;
      if (spec.mode === 'command') {
        flushParagraph();
        closeLists();
        command ??= new Map();
        command.set(xml.tag, xml.body);
      } else {
        flushBlocks();
        out.push(renderDetailsBlock(spec, xml.tag, xml.body));
      }
      i = xml.endLine;
      continue;
    }

    if (!line.trim()) {
      // A blank line between list items, or before something indented under
      // one, does not end the list: numbered steps spaced apart count on.
      const next = lines[nextFilled[i]!];
      if (lists.length && next !== undefined && (matchListItem(next) !== null || indentOf(next) >= lists[0]!.col)) {
        flushParagraph();
        flushCommand();
        continue;
      }
      flushBlocks();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushBlocks();
      const level = heading[1]!.length + 1;
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    // Tables before rules: a delimiter row is made of the same characters as
    // a horizontal rule.
    const table = matchTable(lines, i);
    if (table) {
      flushBlocks();
      out.push(table.html);
      i = table.endLine;
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushBlocks();
      out.push('<hr />');
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
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }

    // A new paragraph indented under an item belongs to the item its
    // indent reaches, not necessarily the deepest one open.
    if (!paragraph.length && lists.length && !settleInList(indentOf(line)) && i > 0 && !lines[i - 1]!.trim()) closeLists();
    paragraph.push(line.trim());
  }

  if (inCode && codeBuffer.length) closeCode();
  flushBlocks();
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Lists
 * ------------------------------------------------------------------ */

interface ListItem {
  type: 'ul' | 'ol';
  indent: number;
  content: string;
  /** The number an ordered list starts at, as written. */
  start?: number;
  /** Where its text starts, past the marker and its space. */
  col: number;
  /** `- [ ]` / `- [x]`, rendered as a disabled checkbox. */
  task?: boolean;
  checked?: boolean;
}

function matchListItem(line: string): ListItem | null {
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  const ordered = bullet ? null : /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
  const match = bullet ?? ordered;
  if (!match) return null;

  const indent = (match[1] ?? '').replace(/\t/g, '  ').length;
  let content = (bullet ? bullet[2] : ordered![3]) ?? '';
  const col = indent + (line.trimStart().length - content.length);
  const item: ListItem = { type: bullet ? 'ul' : 'ol', indent, content, col, ...(ordered ? { start: Number(ordered[2]) } : {}) };

  const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
  if (task && bullet) {
    item.task = true;
    item.checked = task[1] !== ' ';
    content = task[2] ?? '';
    item.content = content;
  }
  return item;
}

/**
 * Place one item, opening and closing lists so nesting follows indentation.
 *
 * The deepest `<li>` is always left open, which is what lets a nested list be
 * emitted inside its parent item rather than as a sibling of it.
 */
function pushListItem(out: string[], lists: { type: 'ul' | 'ol'; indent: number; col: number }[], item: ListItem): void {
  const closeDeepest = () => {
    const list = lists.pop();
    if (!list) return;
    out.push('</li>');
    out.push(`</${list.type}>`);
  };

  while (lists.length > 1 && item.indent < lists[lists.length - 1]!.indent) closeDeepest();

  // An ordered list starts where its first item says: `3.` is 3.
  const open = item.type === 'ol' && item.start !== undefined && item.start !== 1 ? `<ol start="${item.start}">` : `<${item.type}>`;
  const top = lists[lists.length - 1];
  if (!top || item.indent > top.indent) {
    out.push(open);
    lists.push({ type: item.type, indent: item.indent, col: item.col });
  } else if (top.type !== item.type) {
    closeDeepest();
    out.push(open);
    lists.push({ type: item.type, indent: item.indent, col: item.col });
  } else {
    out.push('</li>');
    top.col = item.col;
  }

  const box = item.task
    ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''} /> `
    : '';
  const cls = item.task ? ` class="md-task${item.checked ? ' is-done' : ''}"` : '';
  out.push(`<li${cls}>${box}${inline(item.content)}`);
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

/** `| a | b |` over `| --- | :-: |`, then rows until the block ends. */
function matchTable(lines: string[], i: number): { html: string; endLine: number } | null {
  const header = lines[i] ?? '';
  const divider = lines[i + 1] ?? '';
  if (!/\|/.test(header)) return null;
  if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(divider)) return null;

  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const heads = cells(header);
  const aligns = cells(divider).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '',
  );
  const align = (n: number) => (aligns[n] ? ` style="text-align:${aligns[n]}"` : '');

  const body: string[] = [];
  let end = i + 1;
  for (let j = i + 2; j < lines.length; j++) {
    const row = lines[j] ?? '';
    if (!row.trim() || !row.includes('|')) break;
    const tds = cells(row)
      .map((c, n) => `<td${align(n)}>${inline(c)}</td>`)
      .join('');
    body.push(`<tr>${tds}</tr>`);
    end = j;
  }

  const ths = heads.map((c, n) => `<th${align(n)}>${inline(c)}</th>`).join('');
  const html =
    `<div class="md-table-wrap"><table class="md-table">` +
    `<thead><tr>${ths}</tr></thead>` +
    (body.length ? `<tbody>${body.join('')}</tbody>` : '') +
    `</table></div>`;
  return { html, endLine: end };
}

/* ------------------------------------------------------------------ *
 * Inline
 * ------------------------------------------------------------------ */

/** Placeholder for a code span, so emphasis never fires inside one. */
const CODE_MARK = '\u0000';

function inline(text: string): string {
  let html = escapeHtml(text);

  // Lift code spans out first. `**` inside backticks is literal, and running
  // the emphasis passes over them would mangle real code.
  const spans: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_all, body: string) => {
    spans.push(`<code>${body}</code>`);
    return `${CODE_MARK}${spans.length - 1}${CODE_MARK}`;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // A bare url ends before the punctuation that ends its sentence, or the
  // parenthesis around it (one of its own, balanced, it keeps).
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_m, before: string, found: string) => {
    const [url, after] = trimUrl(found);
    return `${before}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>${after}`;
  });

  return html.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'), (_all, n: string) => spans[Number(n)] ?? '');
}

/** A bare url, from the punctuation after it. The text is escaped already:
 *  `&quot;` and `&gt;` after a url are not part of it, `&amp;` may be. */
function trimUrl(found: string): [string, string] {
  let url = found;
  let after = '';
  for (;;) {
    const entity = /&(?:quot|gt|#39);$/.exec(url);
    if (entity) {
      after = entity[0] + after;
      url = url.slice(0, -entity[0].length);
      continue;
    }
    const last = url.at(-1) ?? '';
    const unbalanced = last === ')' && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length;
    if (/[.,:!?]/.test(last) || (last === ';' && !/&(?:amp|lt);$/.test(url)) || unbalanced) {
      after = last + after;
      url = url.slice(0, -1);
      continue;
    }
    return [url, after];
  }
}
