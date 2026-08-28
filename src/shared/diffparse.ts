import type { DiffFile, DiffHunk, DiffLine } from './types.ts';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse `git diff` output into structured files and hunks.
 *
 * The daemon does this once so the browser never has to; the UI receives
 * hunks it can render directly, which keeps the pre-templated client small
 * and immune to diff-format edge cases.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const closeHunk = () => {
    if (current && hunk) current.hunks!.push(hunk);
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (current) files.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      closeFile();
      const paths = parseDiffGitHeader(line);
      current = {
        path: paths.newPath,
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      if (paths.oldPath !== paths.newPath) current.oldPath = paths.oldPath;
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length);
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      delete current.hunks;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) {
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      closeHunk();
      const oldStart = Number(hunkMatch[1]);
      const oldCount = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3]);
      const newCount = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      hunk = {
        header: (hunkMatch[5] ?? '').trim(),
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!hunk) continue;

    // "\ No newline at end of file" carries no line numbering.
    if (line.startsWith('\\')) continue;

    const marker = line[0];
    const text = line.slice(1);
    let entry: DiffLine | null = null;

    if (marker === '+') {
      entry = { kind: 'add', oldLine: null, newLine: newLine++, text };
      current.additions++;
    } else if (marker === '-') {
      entry = { kind: 'del', oldLine: oldLine++, newLine: null, text };
      current.deletions++;
    } else if (marker === ' ') {
      entry = { kind: 'context', oldLine: oldLine++, newLine: newLine++, text };
    }
    // Anything else — including the empty string produced by a trailing
    // newline — is not a diff line and must not advance the line counters.
    if (entry) hunk.lines.push(entry);
  }

  closeFile();
  return files;
}

function parseDiffGitHeader(line: string): { oldPath: string; newPath: string } {
  const rest = line.slice('diff --git '.length);

  // Quoted paths appear when they contain spaces or non-ASCII bytes.
  if (rest.startsWith('"')) {
    const parts = rest.match(/"((?:[^"\\]|\\.)*)"/g);
    if (parts && parts.length >= 2) {
      return {
        oldPath: stripPrefix(unquote(parts[0]!)),
        newPath: stripPrefix(unquote(parts[1]!)),
      };
    }
  }

  // Unquoted: `a/<path> b/<path>`. Paths may contain spaces, so anchor on " b/".
  const split = rest.lastIndexOf(' b/');
  if (split > 0) {
    return {
      oldPath: stripPrefix(rest.slice(0, split)),
      newPath: stripPrefix(rest.slice(split + 1)),
    };
  }
  const half = rest.split(' ');
  return { oldPath: stripPrefix(half[0] ?? ''), newPath: stripPrefix(half[1] ?? half[0] ?? '') };
}

function unquote(s: string): string {
  return s
    .slice(1, -1)
    .replace(/\\([\\"nt])/g, (_m, c: string) => ({ '\\': '\\', '"': '"', n: '\n', t: '\t' })[c] ?? c);
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Pull the exact source lines a review thread points at. */
export function excerptFor(
  file: DiffFile,
  side: 'old' | 'new',
  startLine: number,
  endLine: number,
  maxLines = 40,
): string {
  const out: string[] = [];
  for (const hunk of file.hunks ?? []) {
    for (const line of hunk.lines) {
      const n = side === 'old' ? line.oldLine : line.newLine;
      if (n === null || n < startLine || n > endLine) continue;
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      out.push(`${marker}${line.text}`);
      if (out.length >= maxLines) return `${out.join('\n')}\n… (truncated)`;
    }
  }
  return out.join('\n');
}
