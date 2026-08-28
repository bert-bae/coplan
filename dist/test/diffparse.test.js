// src/test/diffparse.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/shared/diffparse.ts
var HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
function parseUnifiedDiff(raw) {
  const files = [];
  const lines = raw.split("\n");
  let current = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const closeHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (current) files.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      closeFile();
      const paths = parseDiffGitHeader(line);
      current = {
        path: paths.newPath,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: []
      };
      if (paths.oldPath !== paths.newPath) current.oldPath = paths.oldPath;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      delete current.hunks;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ")) {
      continue;
    }
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      closeHunk();
      const oldStart = Number(hunkMatch[1]);
      const oldCount = hunkMatch[2] === void 0 ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3]);
      const newCount = hunkMatch[4] === void 0 ? 1 : Number(hunkMatch[4]);
      hunk = {
        header: (hunkMatch[5] ?? "").trim(),
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: []
      };
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue;
    const marker = line[0];
    const text = line.slice(1);
    let entry = null;
    if (marker === "+") {
      entry = { kind: "add", oldLine: null, newLine: newLine++, text };
      current.additions++;
    } else if (marker === "-") {
      entry = { kind: "del", oldLine: oldLine++, newLine: null, text };
      current.deletions++;
    } else if (marker === " ") {
      entry = { kind: "context", oldLine: oldLine++, newLine: newLine++, text };
    }
    if (entry) hunk.lines.push(entry);
  }
  closeFile();
  return files;
}
function parseDiffGitHeader(line) {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const parts = rest.match(/"((?:[^"\\]|\\.)*)"/g);
    if (parts && parts.length >= 2) {
      return {
        oldPath: stripPrefix(unquote(parts[0])),
        newPath: stripPrefix(unquote(parts[1]))
      };
    }
  }
  const split = rest.lastIndexOf(" b/");
  if (split > 0) {
    return {
      oldPath: stripPrefix(rest.slice(0, split)),
      newPath: stripPrefix(rest.slice(split + 1))
    };
  }
  const half = rest.split(" ");
  return { oldPath: stripPrefix(half[0] ?? ""), newPath: stripPrefix(half[1] ?? half[0] ?? "") };
}
function unquote(s) {
  return s.slice(1, -1).replace(/\\([\\"nt])/g, (_m, c) => ({ "\\": "\\", '"': '"', n: "\n", t: "	" })[c] ?? c);
}
function stripPrefix(p) {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}
function excerptFor(file, side, startLine, endLine, maxLines = 40) {
  const out = [];
  for (const hunk of file.hunks ?? []) {
    for (const line of hunk.lines) {
      const n = side === "old" ? line.oldLine : line.newLine;
      if (n === null || n < startLine || n > endLine) continue;
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      out.push(`${marker}${line.text}`);
      if (out.length >= maxLines) return `${out.join("\n")}
\u2026 (truncated)`;
    }
  }
  return out.join("\n");
}

// src/test/diffparse.test.ts
var SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ function main()
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..aaaaaaa
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Title
+body
`;
test("parses multiple files with correct line numbering", () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 2);
  const app = files[0];
  assert.equal(app.path, "src/app.ts");
  assert.equal(app.status, "modified");
  assert.equal(app.additions, 2);
  assert.equal(app.deletions, 1);
  const lines = app.hunks[0].lines;
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4]
    ]
  );
  assert.equal(app.hunks[0].header, "function main()");
});
test("detects added files", () => {
  const readme = parseUnifiedDiff(SAMPLE)[1];
  assert.equal(readme.path, "README.md");
  assert.equal(readme.status, "added");
  assert.equal(readme.additions, 2);
});
test("handles renames", () => {
  const files = parseUnifiedDiff(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
index 111..222 100644
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`);
  assert.equal(files[0].status, "renamed");
  assert.equal(files[0].oldPath, "old.ts");
  assert.equal(files[0].path, "new.ts");
});
test("handles paths containing spaces", () => {
  const files = parseUnifiedDiff(`diff --git a/my dir/file name.ts b/my dir/file name.ts
index 111..222 100644
--- a/my dir/file name.ts
+++ b/my dir/file name.ts
@@ -1 +1 @@
-a
+b
`);
  assert.equal(files[0].path, "my dir/file name.ts");
});
test("marks binary files and drops hunks", () => {
  const files = parseUnifiedDiff(`diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`);
  assert.equal(files[0].binary, true);
  assert.equal(files[0].hunks, void 0);
});
test("ignores the no-newline marker without shifting line numbers", () => {
  const files = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`);
  const lines = files[0].hunks[0].lines;
  assert.deepEqual(lines.map((l) => l.kind), ["context", "del", "add"]);
  assert.equal(lines[1].oldLine, 2);
  assert.equal(lines[2].newLine, 2);
});
test("excerptFor returns the selected source with markers", () => {
  const app = parseUnifiedDiff(SAMPLE)[0];
  assert.equal(excerptFor(app, "new", 2, 3), "+const b = 3;\n+const c = 4;");
  assert.equal(excerptFor(app, "old", 2, 2), "-const b = 2;");
});
test("empty input yields no files", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
});
//# sourceMappingURL=diffparse.test.js.map
