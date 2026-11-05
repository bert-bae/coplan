/**
 * JSON with comments, for the config files people write by hand: `//` to
 * the end of a line and `/* … *\/` anywhere outside a string, and a comma
 * after the last item. Inside a string nothing is touched, so a command like
 * `"curl http://x"` keeps its `//`.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      // Kept as whitespace so a line number in a parse error still points
      // at the right line.
      const comment = end < 0 ? text.slice(i) : text.slice(i, end + 2);
      out += comment.replace(/[^\n]/g, ' ');
      i += comment.length;
    } else {
      out += c;
      i++;
    }
  }
  return dropTrailingCommas(out);
}

/** A comma before `}` or `]` — the edit people make most — outside strings. */
function dropTrailingCommas(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, i + 1);
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}
