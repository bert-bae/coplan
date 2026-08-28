import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SessionStore } from './store.ts';
import type { HarnessConfig } from '../shared/config.ts';
import { renderTemplate } from '../shared/config.ts';
import { git, currentBranch, defaultBranch, shortLog } from './git.ts';
import { checksSummary } from './checks.ts';
import type { SessionState, ShipState, ShipStep } from '../shared/types.ts';

/**
 * Compose the ship payload from everything the session already knows: the
 * approved plan, the review threads, the checks, and the commit log.
 *
 * The model never writes this text, which is the point — by the time the ship
 * stage is reached, all the material already exists in the harness.
 */
export async function composeShip(
  session: SessionState,
  config: HarnessConfig,
): Promise<ShipState> {
  const cwd = session.repoRoot ?? session.cwd;
  const branch = session.branch ?? (await currentBranch(cwd));
  const base = await defaultBranch(cwd);
  const title = shipTitle(session);
  const body = await shipBody(session, cwd);

  const commitTemplate = config.ship.commitTemplate ?? '{{title}}\n\n{{body}}';
  const commitMessage = renderTemplate(commitTemplate, { title, body }).trim();

  return {
    title,
    body,
    commitMessage,
    branch,
    baseBranch: base,
    steps: config.ship.steps,
    provider: config.ship.provider,
  };
}

function shipTitle(session: SessionState): string {
  const plan = session.plan;
  if (plan?.title) return plan.title;
  const firstStep = plan?.steps[0]?.title;
  if (firstStep) return firstStep;
  return session.title;
}

async function shipBody(session: SessionState, cwd: string): Promise<string> {
  const parts: string[] = [];

  if (session.plan?.summary) parts.push(session.plan.summary, '');

  const steps = (session.plan?.steps ?? []).filter((s) => s.status !== 'dropped');
  if (steps.length) {
    parts.push('## What changed', '');
    for (const step of steps) {
      parts.push(`- ${step.title}${step.detail ? ` — ${step.detail}` : ''}`);
    }
    parts.push('');
  }

  const resolvedThreads = session.threads.filter((t) => t.resolved);
  if (resolvedThreads.length) {
    parts.push('## Review feedback addressed', '');
    for (const thread of resolvedThreads) {
      parts.push(`- \`${thread.file}:${thread.startLine}\` — ${thread.body}`);
    }
    parts.push('');
  }

  if (session.checks.length) {
    parts.push('## Verification', '');
    for (const check of session.checks) {
      const mark = check.status === 'passed' ? '✅' : check.status === 'failed' ? '❌' : '⏳';
      parts.push(`- ${mark} \`${check.command}\``);
    }
    parts.push('');
  }

  if (session.baseRef) {
    const log = await shortLog(cwd, session.baseRef, 20);
    if (log.length) {
      parts.push('## Commits', '');
      for (const line of log) parts.push(`- ${line}`);
      parts.push('');
    }
  }

  return parts.join('\n').trim();
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export interface ShipOutcome {
  ok: boolean;
  output: string;
  url?: string;
  summaryPath?: string;
  /** Set when the chosen provider is an MCP server, which only the session
   *  can call — the model performs this step, not the daemon. */
  directive?: string;
}

export async function executeShip(
  store: SessionStore,
  sessionId: string,
  config: HarnessConfig,
  ship: ShipState,
): Promise<ShipOutcome> {
  const session = store.get(sessionId);
  if (!session) return { ok: false, output: 'unknown session' };
  const cwd = session.repoRoot ?? session.cwd;
  const log: string[] = [];
  const steps = new Set<ShipStep>(ship.steps);

  const record = (line: string) => {
    log.push(line);
    store.addTimeline(sessionId, 'ship', line, { label: 'ship' });
  };

  if (steps.has('checks')) {
    const summary = checksSummary(session.checks);
    record(`checks: ${summary.text}`);
    if (!summary.ok) {
      return { ok: false, output: log.join('\n') };
    }
  }

  if ((steps.has('commit') || steps.has('push')) && ship.branch && ship.branch === ship.baseBranch) {
    // Committing the session's work straight onto the branch a PR would
    // target is almost never what the user meant, and it is not undoable
    // once pushed. Make them create a branch first.
    return fail(
      record,
      log,
      `refusing to commit to "${ship.branch}": it is this repository's default branch. ` +
        `Create a feature branch first, or uncheck the commit and push steps.`,
    );
  }

  if (steps.has('commit')) {
    const status = await git(cwd, ['status', '--porcelain']);
    if (status.stdout.trim()) {
      // Stage exactly the paths the user reviewed. `git add -A` would sweep
      // in anything that landed since — a stray .env, an unrelated edit.
      const reviewed = reviewedPaths(store, sessionId);
      const add = reviewed.length
        ? await git(cwd, ['add', '--', ...reviewed])
        : await git(cwd, ['add', '-A']);
      if (!add.ok) return fail(record, log, `git add failed: ${add.stderr}`);
      if (reviewed.length) record(`staged ${reviewed.length} reviewed path(s)`);
      const messageFile = path.join(tmpdir(), `cc-harness-commit-${Date.now()}.txt`);
      writeFileSync(messageFile, `${ship.commitMessage}\n`);
      const commit = await git(cwd, ['commit', '-F', messageFile]);
      if (!commit.ok) return fail(record, log, `git commit failed: ${commit.stderr || commit.stdout}`);
      record(`committed: ${ship.commitMessage.split('\n')[0]}`);
    } else {
      record('commit: working tree already clean');
    }
  }

  if (steps.has('push')) {
    const branch = ship.branch ?? (await currentBranch(cwd));
    if (!branch) return fail(record, log, 'push: detached HEAD, refusing to guess a branch');
    const push = await git(cwd, ['push', '-u', 'origin', branch], 120_000);
    if (!push.ok) return fail(record, log, `git push failed: ${push.stderr || push.stdout}`);
    record(`pushed ${branch} to origin`);
  }

  let url: string | undefined;
  let directive: string | undefined;

  if (steps.has('pr')) {
    const provider = config.ship.providers[ship.provider];
    if (!provider) {
      return fail(record, log, `unknown ship provider "${ship.provider}"`);
    }
    const vars = {
      title: ship.title,
      body: ship.body,
      branch: ship.branch ?? '',
      base: ship.baseBranch ?? '',
    };

    if (provider.kind === 'command') {
      const bodyFile = path.join(tmpdir(), `cc-harness-pr-${Date.now()}.md`);
      writeFileSync(bodyFile, ship.body);
      // Everything interpolated into a `shell: true` command is quoted. Git
      // ref names legally contain `;`, `$`, backticks and parentheses, so an
      // unquoted branch name is an execution vector.
      const command = renderTemplate(provider.command, {
        title: shellQuote(ship.title),
        body: shellQuote(ship.body),
        bodyFile: shellQuote(bodyFile),
        branch: shellQuote(vars.branch),
        base: shellQuote(vars.base),
      });
      const result = await runShell(command, cwd);
      log.push(result.output.trim());
      if (!result.ok) return fail(record, log, `PR command failed (exit ${result.code})`);
      url = extractUrl(result.output);
      record(url ? `opened PR: ${url}` : 'PR command finished');
    } else if (provider.kind === 'mcp') {
      // The daemon has no access to the session's MCP servers, so the model
      // performs this step. It receives the directive plus the composed text.
      directive = renderTemplate(provider.directive, vars);
      record(`PR delegated to the session (provider: ${ship.provider})`);
    } else {
      record('PR skipped (provider: none)');
    }
  }

  let summaryPath: string | undefined;
  if (steps.has('summary') && config.ship.summaryPath) {
    summaryPath = writeSummary(cwd, config, ship, session);
    if (summaryPath) record(`summary written to ${path.relative(cwd, summaryPath)}`);
  }

  const outcome: ShipOutcome = { ok: true, output: log.join('\n') };
  if (url) outcome.url = url;
  if (summaryPath) outcome.summaryPath = summaryPath;
  if (directive) outcome.directive = directive;

  store.mutate(sessionId, (s) => {
    s.ship = {
      ...ship,
      result: { ok: true, output: outcome.output, ...(url ? { url } : {}), ...(summaryPath ? { summaryPath } : {}) },
    };
    s.stage = 'done';
  });

  return outcome;
}

/** Paths from the diff the user reviewed, including the pre-rename name. */
function reviewedPaths(store: SessionStore, sessionId: string): string[] {
  const diff = store.getDiff(sessionId);
  if (!diff) return [];
  const paths = new Set<string>();
  for (const file of diff.files) {
    paths.add(file.path);
    if (file.oldPath) paths.add(file.oldPath);
  }
  return [...paths];
}

function fail(record: (line: string) => void, log: string[], message: string): ShipOutcome {
  record(message);
  return { ok: false, output: log.join('\n') };
}

function writeSummary(
  cwd: string,
  config: HarnessConfig,
  ship: ShipState,
  session: SessionState,
): string | undefined {
  try {
    const rel = renderTemplate(config.ship.summaryPath ?? '', {
      branch: (ship.branch ?? 'session').replace(/[/\\]/g, '-'),
      date: new Date().toISOString().slice(0, 10),
    });
    if (!rel) return undefined;
    const file = path.resolve(cwd, rel);
    mkdirSync(path.dirname(file), { recursive: true });

    const lines = [`# ${ship.title}`, '', ship.body, ''];
    if (session.threads.length) {
      lines.push('## Review threads', '');
      for (const t of session.threads) {
        lines.push(`- \`${t.file}:${t.startLine}-${t.endLine}\` — ${t.body}${t.resolved ? ' _(resolved)_' : ''}`);
      }
      lines.push('');
    }
    writeFileSync(file, lines.join('\n'));
    return file;
  } catch {
    return undefined;
  }
}

function runShell(command: string, cwd: string): Promise<{ ok: boolean; code: number; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, NO_COLOR: '1' } });
    child.stdout?.on('data', (b: Buffer) => (output += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => (output += b.toString('utf8')));
    child.on('error', (err) => resolve({ ok: false, code: -1, output: output + err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? -1, output }));
  });
}

function extractUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0].replace(/[.,)]+$/, '') : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
