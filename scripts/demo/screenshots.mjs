#!/usr/bin/env node
// Regenerates the README's screenshots (docs/images/*.png).
//
//   pnpm build
//   node scripts/demo/screenshots.mjs [--out docs/images] [--repos <dir>] [--only board,report]
//
// It starts a daemon of its own from dist/, in a fresh CC_HARNESS_HOME so
// your real sessions are untouched, makes four throwaway git repositories,
// seeds them with the demo plans (scripts/demo/seed.mjs), captures each view
// in Chromium at 1600×1000, twice the pixels, and stops the daemon.
//
// Needs Playwright with Chromium, which is not a dependency of this
// repository: install it wherever you like (`npm i -g playwright` and
// `npx playwright install chromium`). The page header shows each repository's
// path, so for tidy screenshots pass a short `--repos` directory.
//
// If Python with Pillow is on the PATH, each image is reduced to 256 colours,
// which keeps it a third of the size and looks the same; otherwise the full
// PNG is kept.
import { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { seed } from './seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = path.resolve(flag('out') ?? path.join(ROOT, 'docs', 'images'));
const ONLY = flag('only')?.split(',');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'coplan-demo-'));
const REPOS = path.resolve(flag('repos') ?? path.join(scratch, 'code'));
const HOME = path.join(scratch, 'home');

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is not installed. See the top of this file.');
  process.exit(2);
}
if (!existsSync(path.join(ROOT, 'dist', 'daemon', 'main.js'))) {
  console.error('dist/ is missing: run `pnpm build` first.');
  process.exit(2);
}

/* ------------------------------ Repositories ----------------------------- */

const CHECKS = `{
  "hooks": {
    "implement": ["pnpm typecheck", "pnpm lint"],
    "review": [{ "name": "tests", "run": "pnpm test", "timeout": 900 }],
    "final": ["pnpm check"]
  },
  "iric": { "review": "subagent", "parallel": 2, "maxRounds": 3 },
  "branches": { "base": "main", "prefix": "coplan/" }
}
`;
const BRANCH = { 'orders-service': 'coplan/orders-cache', 'billing-api': 'coplan/webhook-retries', 'public-api': 'coplan/rate-limit-plans' };
for (const name of ['orders-service', 'web-dashboard', 'billing-api', 'public-api']) {
  const dir = path.join(REPOS, name);
  if (existsSync(path.join(dir, '.git'))) continue;
  mkdirSync(path.join(dir, '.coplan'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  writeFileSync(path.join(dir, '.coplan', 'config.json'), CHECKS);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'init');
  if (BRANCH[name]) git('checkout', '-q', '-b', BRANCH[name]);
}

/* -------------------------------- Daemon -------------------------------- */

mkdirSync(HOME, { recursive: true });
const env = { ...process.env, CC_HARNESS_HOME: HOME };
const daemon = spawn(process.execPath, [path.join(ROOT, 'dist', 'daemon', 'main.js')], { env, stdio: 'ignore' });
let lock = null;
for (let i = 0; i < 100 && !lock; i++) {
  await sleep(100);
  try {
    lock = JSON.parse(readFileSync(path.join(HOME, 'daemon.json'), 'utf8'));
  } catch {
    /* not up yet */
  }
}
if (!lock) {
  daemon.kill();
  console.error(`The daemon did not start; see ${path.join(HOME, 'daemon.log')}.`);
  process.exit(1);
}

/* -------------------------------- Capture ------------------------------- */

const browser = await chromium.launch();
try {
  const ids = await seed(lock, REPOS);
  mkdirSync(OUT, { recursive: true });

  const open = async (session, { dark = false, height = 1000 } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1600, height }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${lock.port}/?token=${lock.token}#/session/${ids[session]}`);
    await page.waitForSelector('[role=tablist]', { timeout: 15_000 });
    await page.waitForTimeout(700);
    return page;
  };
  const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
  const box = (page, label) => page.locator('.react-flow__node', { hasText: label }).first();
  // Long enough for a card's arrival and a box's highlight to finish.
  const settle = (page, ms = 1200) => page.waitForTimeout(ms);

  const shots = {
    // Shaping the design, with a box selected, while Codex waits on a question.
    async architecture(page = open('S2')) {
      page = await page;
      await tab(page, 'Architecture');
      await settle(page, 600);
      await box(page, 'Share links').click();
      await page.mouse.move(1150, 960);
      await settle(page);
      return page;
    },
    // The task list for a confirmed design: dependencies, branches, build order.
    async tasks(page = open('S3')) {
      page = await page;
      await tab(page, 'Tasks');
      await settle(page);
      return page;
    },
    // The exact build prompt and the build settings, before submitting.
    async submit(page = open('S3', { height: 1100 })) {
      page = await page;
      await tab(page, 'Tasks');
      await settle(page, 500);
      await page.getByRole('button', { name: /Review & submit/ }).first().click();
      await settle(page, 1500);
      return page;
    },
    // What the agent reads: one task's brief, each part with its source.
    async viewer(page = open('S3', { height: 1100 })) {
      page = await page;
      await tab(page, 'Tasks');
      await settle(page, 500);
      await page.locator('.task-line').nth(1).hover();
      await page.getByRole('button', { name: /^Brief for / }).nth(1).click();
      await settle(page, 1200);
      return page;
    },
    // The board during a build.
    async board(page = open('S1')) {
      page = await page;
      await tab(page, 'Tasks');
      await settle(page, 1800);
      return page;
    },
    // The diagram as a progress map, one box selected.
    async progress(page = open('S1')) {
      page = await page;
      await tab(page, 'Architecture');
      await settle(page, 600);
      await box(page, 'Redis cache').click();
      await page.mouse.move(1150, 960);
      await settle(page);
      return page;
    },
    // The build report on the Overview.
    async report(page = open('S4')) {
      page = await page;
      await tab(page, 'Overview');
      await settle(page);
      return page;
    },
    'board-dark': async () => shots.board(open('S1', { dark: true })),
  };

  for (const [name, take] of Object.entries(shots)) {
    if (ONLY && !ONLY.includes(name)) continue;
    const page = await take();
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    await page.context().close();
    const reduced = spawnSync(
      'python3',
      ['-I', '-c', 'import sys; from PIL import Image; p = sys.argv[1]; Image.open(p).convert("RGB").quantize(256, Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(p, optimize=True)', file],
      { stdio: 'ignore' },
    );
    console.log(`${path.relative(ROOT, file)}${reduced.status === 0 ? ' (256 colours)' : ''}`);
  }
} finally {
  await browser.close();
  daemon.kill('SIGTERM');
}
