// Measures what Coplan puts into an agent's context: the skills and commands,
// the MCP tool definitions, and every hook and tool reply of the demo sessions
// (scripts/demo/seed.mjs), replayed against a daemon of its own from dist/.
//
//   pnpm build && node scripts/measure-tokens.mjs [--json out.json]
//
// Tokens are estimated as characters / 4; compare runs, not absolute numbers.
// Used for docs/TOKENS.md; not part of the plugin.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { seed } from './demo/seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(ROOT, 'dist', 'daemon', 'main.js'))) {
  console.error('dist/ is missing: run `pnpm build` first.');
  process.exit(2);
}
const tok = (s) => Math.round((s?.length ?? 0) / 4);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'coplan-tokens-'));
const HOME = path.join(scratch, 'home');
const REPOS = path.join(scratch, 'code');

/* ----------------------------- Static context ---------------------------- */

const files = (dir, name) =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).map((e) =>
    e.isDirectory() ? path.join(dir, e.name, name) : path.join(dir, e.name),
  );
const frontmatter = (text) => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
const staticRows = [...files('skills', 'SKILL.md'), ...files('commands')].map((f) => {
  const text = readFileSync(path.join(ROOT, f), 'utf8');
  return { file: f, always: tok(frontmatter(text)), onUse: tok(text) };
});

/** The tool list exactly as an agent gets it over MCP. */
async function toolList() {
  const mcp = spawn(process.execPath, [path.join(ROOT, 'dist', 'mcp', 'main.js')], {
    env: { ...process.env, CC_HARNESS_HOME: HOME },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const send = (m) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  let buf = '';
  const reply = new Promise((resolve) =>
    mcp.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) resolve(m.result.tools);
        } catch {
          /* partial line */
        }
      }
    }),
  );
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'measure', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  const tools = await Promise.race([reply, sleep(10_000).then(() => [])]);
  mcp.kill();
  return tools.map((t) => ({ name: t.name, tokens: tok(JSON.stringify(t)) }));
}

/* --------------------------------- Daemon -------------------------------- */

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
for (const name of ['orders-service', 'web-dashboard', 'billing-api', 'public-api']) {
  const dir = path.join(REPOS, name);
  mkdirSync(path.join(dir, '.coplan'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  writeFileSync(path.join(dir, '.coplan', 'config.json'), CHECKS);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'init');
}
mkdirSync(HOME, { recursive: true });
const daemon = spawn(process.execPath, [path.join(ROOT, 'dist', 'daemon', 'main.js')], {
  env: { ...process.env, CC_HARNESS_HOME: HOME },
  stdio: 'ignore',
});
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

/* ------------------------- Replies, as the agent sees them ------------------------- */

// Every /mcp and /hook reply, reduced to the text that reaches the model:
// a tool's `text`, a hook's additionalContext.
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  const route = new URL(url).pathname;
  const m = /^\/(mcp|hook)\/(\w+)/.exec(route);
  if (m) {
    const body = await res.clone().json().catch(() => ({}));
    const text = m[1] === 'mcp' ? (body.text ?? JSON.stringify(body)) : (body.hookSpecificOutput?.additionalContext ?? '');
    const input = JSON.parse(init.body);
    calls.push({ kind: m[1], name: m[2], input, tokens: tok(text), text });
  }
  return res;
};

let tools = [];
try {
  await seed(lock, REPOS);
  // The build's own reads, on the mid-build plan (orders-service).
  const S1 = 'b1c7e0a2-4d1f-4b8e-9a51-3f2d6c0e9a11';
  const C1 = path.join(REPOS, 'orders-service');
  const mcp = (tool, body) =>
    fetch(`http://127.0.0.1:${lock.port}/mcp/${tool}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lock.token}`, 'content-type': 'application/json', 'x-harness-session': S1, 'x-harness-agent': 'claude' },
      body: JSON.stringify({ cwd: C1, ...body }),
    });
  await mcp('next', {});
  for (const id of ['t1c', 't2a', 't4']) await mcp('brief', { task_id: id });
  await mcp('read', { peek: true });
  await mcp('read', { peek: true, changes_only: true });
  tools = await toolList();
} finally {
  globalThis.fetch = realFetch;
  daemon.kill('SIGTERM');
}

/* --------------------------------- Report -------------------------------- */

const label = (c) => {
  if (c.kind === 'hook') return `hook ${c.name}${c.input.prompt ? ` "${c.input.prompt.slice(0, 24)}"` : ''}`;
  const extra = c.input.task_id ? ` ${c.input.task_id}` : c.input.changes_only ? ' changes_only' : '';
  return `mcp ${c.name}${extra}`;
};
const groups = new Map();
for (const c of calls) {
  if (!c.tokens) continue;
  const key = c.kind === 'mcp' && c.name === 'task' ? 'mcp task (update)' : label(c);
  const g = groups.get(key) ?? { n: 0, total: 0, max: 0 };
  g.n++;
  g.total += c.tokens;
  g.max = Math.max(g.max, c.tokens);
  groups.set(key, g);
}

const out = [];
out.push('## Skills and commands (description always loaded; body on use)\n');
out.push('| File | Always | On use |', '| --- | ---: | ---: |');
for (const r of staticRows) out.push(`| ${r.file} | ${r.always} | ${r.onUse} |`);
out.push('\n## MCP tool definitions\n');
out.push('| Tool | Tokens |', '| --- | ---: |');
for (const t of tools) out.push(`| ${t.name} | ${t.tokens} |`);
out.push(`| **total** | **${tools.reduce((a, t) => a + t.tokens, 0)}** |`);
out.push('\n## Replies the agent reads (demo sessions)\n');
out.push('| Reply | Calls | Avg | Max |', '| --- | ---: | ---: | ---: |');
for (const [k, g] of [...groups].sort((a, b) => b[1].max - a[1].max)) out.push(`| ${k} | ${g.n} | ${Math.round(g.total / g.n)} | ${g.max} |`);
console.log(out.join('\n'));

const i = process.argv.indexOf('--json');
if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify({ staticRows, tools, calls }, null, 2));
rmSync(scratch, { recursive: true, force: true });
