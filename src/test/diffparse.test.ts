import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, excerptFor } from '../shared/diffparse.ts';

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
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

test('parses multiple files with correct line numbering', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 2);

  const app = files[0]!;
  assert.equal(app.path, 'src/app.ts');
  assert.equal(app.status, 'modified');
  assert.equal(app.additions, 2);
  assert.equal(app.deletions, 1);

  const lines = app.hunks![0]!.lines;
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ],
  );
  assert.equal(app.hunks![0]!.header, 'function main()');
});

test('detects added files', () => {
  const readme = parseUnifiedDiff(SAMPLE)[1]!;
  assert.equal(readme.path, 'README.md');
  assert.equal(readme.status, 'added');
  assert.equal(readme.additions, 2);
});

test('handles renames', () => {
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
  assert.equal(files[0]!.status, 'renamed');
  assert.equal(files[0]!.oldPath, 'old.ts');
  assert.equal(files[0]!.path, 'new.ts');
});

test('handles paths containing spaces', () => {
  const files = parseUnifiedDiff(`diff --git a/my dir/file name.ts b/my dir/file name.ts
index 111..222 100644
--- a/my dir/file name.ts
+++ b/my dir/file name.ts
@@ -1 +1 @@
-a
+b
`);
  assert.equal(files[0]!.path, 'my dir/file name.ts');
});

test('marks binary files and drops hunks', () => {
  const files = parseUnifiedDiff(`diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`);
  assert.equal(files[0]!.binary, true);
  assert.equal(files[0]!.hunks, undefined);
});

test('ignores the no-newline marker without shifting line numbers', () => {
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
  const lines = files[0]!.hunks![0]!.lines;
  assert.deepEqual(lines.map((l) => l.kind), ['context', 'del', 'add']);
  assert.equal(lines[1]!.oldLine, 2);
  assert.equal(lines[2]!.newLine, 2);
});

test('excerptFor returns the selected source with markers', () => {
  const app = parseUnifiedDiff(SAMPLE)[0]!;
  assert.equal(excerptFor(app, 'new', 2, 3), '+const b = 3;\n+const c = 4;');
  assert.equal(excerptFor(app, 'old', 2, 2), '-const b = 2;');
});

test('empty input yields no files', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
});
