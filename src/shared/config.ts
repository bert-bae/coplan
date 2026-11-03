import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Harness configuration: `~/.claude/cc-harness/config.json`, overridden per
 * repo by `.claude/harness.json`. Small on purpose — the harness does one
 * thing, and most of what it does needs no knobs.
 */
export interface HarnessConfig {
  /** Open the plan in a browser the first time Claude publishes one. */
  autoOpen: boolean;
  /**
   * When the user types in chat after changing the plan in the browser, add a
   * one-line note to the prompt telling Claude to read it. Off means Claude
   * only learns of the changes when it calls `harness_plan_read` itself.
   */
  promptNotice: boolean;
  /** Exit after this long with no session activity and no browser open. 0 never. */
  idleShutdownMinutes: number;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  autoOpen: false,
  promptNotice: true,
  idleShutdownMinutes: 120,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergeConfig(base: HarnessConfig, override: unknown): HarnessConfig {
  if (!isRecord(override)) return base;
  const out: HarnessConfig = { ...base };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof HarnessConfig)[]) {
    const value = override[key];
    if (value !== undefined && typeof value === typeof DEFAULT_CONFIG[key]) {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function readJson(file: string): unknown {
  try {
    if (!existsSync(file)) return undefined;
    // Tolerate line comments so a config file can explain itself.
    const raw = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function loadConfig(opts: { configDir: string; projectDir?: string | null }): HarnessConfig {
  let cfg = DEFAULT_CONFIG;
  cfg = mergeConfig(cfg, readJson(path.join(opts.configDir, 'config.json')));
  if (opts.projectDir) cfg = mergeConfig(cfg, readJson(path.join(opts.projectDir, '.claude', 'harness.json')));
  return cfg;
}
