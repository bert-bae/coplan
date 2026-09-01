import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ShipProvider, ShipStep, Stage } from './types.ts';

export interface StageConfig {
  /** Path to a markdown file (relative to the config dir) whose contents are
   *  returned to the model when this stage is entered. */
  instructions?: string;
  /** Verification only: commands to run. */
  checks?: string[];
}

export interface ShipConfig {
  steps: ShipStep[];
  provider: string;
  providers: Record<string, ShipProvider>;
  /** Supports {{branch}} and {{date}}. */
  summaryPath?: string;
  commitTemplate?: string;
}

export interface HarnessConfig {
  /** Open a browser window the first time a session engages the harness.
   *  Off by default — the URL is printed instead, and `harness open` is the
   *  explicit way to get a window. */
  autoOpen: boolean;
  /** Timeline ring-buffer size. */
  maxTimelineEvents: number;
  /**
   * How long the opt-in `holdIdleSessions` wait holds a finished turn open,
   * in seconds. It does not apply to gates: an open gate ends the turn.
   */
  stopHoldSeconds: number;
  /** How long a single `harness_await` MCP call parks, in seconds. */
  awaitSeconds: number;
  /**
   * Hold a finished turn open even with no gate, so a message typed in the
   * browser can reach a session that would otherwise have gone idle.
   *
   * Off by default, and deliberately so: it keeps the terminal occupied and
   * consumes the CLI's consecutive-Stop-block allowance. Turn it on for a
   * session you intend to drive entirely from the browser.
   */
  holdIdleSessions: boolean;
  /** Skip files larger than this many bytes in the diff view. */
  maxDiffFileBytes: number;
  /** Exit after this many minutes with no live session and no browser
   *  attached. 0 disables it. Keeps daemons from accumulating. */
  idleShutdownMinutes: number;
  stages: Partial<Record<Stage, StageConfig>>;
  ship: ShipConfig;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  autoOpen: false,
  maxTimelineEvents: 500,
  stopHoldSeconds: 540,
  awaitSeconds: 120,
  holdIdleSessions: false,
  maxDiffFileBytes: 400_000,
  idleShutdownMinutes: 120,
  stages: {
    verification: { checks: [] },
  },
  ship: {
    steps: ['checks', 'commit', 'push', 'pr', 'summary'],
    provider: 'gh',
    providers: {
      gh: {
        kind: 'command',
        label: 'GitHub (gh CLI)',
        command: 'gh pr create --base {{base}} --head {{branch}} --title {{title}} --body-file {{bodyFile}}',
      },
      bitbucket: {
        kind: 'mcp',
        label: 'Bitbucket (MCP)',
        directive:
          'Open a pull request using the connected Bitbucket MCP server. Use the title and body below verbatim, ' +
          'source branch {{branch}}, destination branch {{base}}. Report the resulting PR URL back with harness_note.',
      },
      none: { kind: 'none', label: 'No PR — commit and push only' },
    },
    summaryPath: 'docs/reviews/{{branch}}.md',
    commitTemplate: '{{title}}\n\n{{body}}',
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shallow-merge with one level of nesting for `stages` and `ship`. */
export function mergeConfig(base: HarnessConfig, override: unknown): HarnessConfig {
  if (!isRecord(override)) return base;
  const out: HarnessConfig = { ...base, stages: { ...base.stages }, ship: { ...base.ship } };

  for (const [key, value] of Object.entries(override)) {
    if (key === 'stages' && isRecord(value)) {
      for (const [stage, cfg] of Object.entries(value)) {
        if (!isRecord(cfg)) continue;
        const s = stage as Stage;
        out.stages[s] = { ...out.stages[s], ...(cfg as StageConfig) };
      }
    } else if (key === 'ship' && isRecord(value)) {
      out.ship = {
        ...out.ship,
        ...(value as unknown as Partial<ShipConfig>),
        providers: { ...out.ship.providers, ...((value as unknown as Partial<ShipConfig>).providers ?? {}) },
      };
    } else if (value !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function readJson(file: string): unknown {
  try {
    if (!existsSync(file)) return undefined;
    // Tolerate comments so the shipped defaults file can explain itself.
    const raw = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Config resolution: shipped defaults → user global → project-local.
 * The project file lets a repo pin its own checks and ship provider.
 */
export function loadConfig(opts: { configDir: string; projectDir?: string | null }): HarnessConfig {
  let cfg = DEFAULT_CONFIG;
  cfg = mergeConfig(cfg, readJson(path.join(opts.configDir, 'config.json')));
  if (opts.projectDir) {
    cfg = mergeConfig(cfg, readJson(path.join(opts.projectDir, '.claude', 'harness.json')));
  }
  return cfg;
}

/** Read a stage's custom instructions, if the user configured any. */
export function stageInstructions(
  cfg: HarnessConfig,
  stage: Stage,
  opts: { configDir: string; projectDir?: string | null },
): string | undefined {
  const rel = cfg.stages[stage]?.instructions;
  if (!rel) return undefined;
  const candidates = [
    path.resolve(opts.configDir, rel),
    ...(opts.projectDir ? [path.resolve(opts.projectDir, rel)] : []),
  ];
  for (const file of candidates) {
    try {
      if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
}
