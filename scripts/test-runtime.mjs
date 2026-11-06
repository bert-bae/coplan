// The tests that need no browser: everything but the .tsx ones, which run in
// jsdom. CI runs these on the oldest Node the plugin supports (package.json
// `engines`), where the plugin itself must work; jsdom, a test-only
// dependency, needs a newer one. Every other job runs the whole suite.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(path.join(root, 'src', 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join('dist', 'test', f.replace(/\.ts$/, '.js')));

const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(run.status ?? 1);
