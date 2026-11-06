import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseJsonc } from './jsonc.ts';

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
  /**
   * When Claude asks the user something, open that session in the Claude
   * desktop app straight away instead of waiting for a click in the harness.
   * Only possible for a local session with Remote Control on: nothing else
   * has a documented link to open.
   */
  openClaudeOnQuestion: boolean;
  /** Exit after this long with no session activity and no browser open. 0 never. */
  idleShutdownMinutes: number;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  autoOpen: false,
  promptNotice: true,
  openClaudeOnQuestion: false,
  idleShutdownMinutes: 120,
};

/** Settings about this machine's daemon, which serves every repository at
 *  once: a repository cannot set them. */
export const GLOBAL_ONLY: readonly (keyof HarnessConfig)[] = ['idleShutdownMinutes'];

/** Keys older versions read; an old file still holding them is not wrong. */
const RETIRED = ['gateHoldSeconds', 'stages', 'ship'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Why a value cannot be used, or null when it can. */
function invalid(key: keyof HarnessConfig, value: unknown): string | null {
  const want = typeof DEFAULT_CONFIG[key];
  if (typeof value !== want) return `must be ${want === 'boolean' ? 'true or false' : `a ${want}`}`;
  if (key === 'idleShutdownMinutes' && (!Number.isInteger(value) || (value as number) < 0)) return 'must be a whole number of minutes, 0 or more';
  return null;
}

/** Layer `override` on `base`, key by key. What cannot be used is left out
 *  and, given `errors`, said there, prefixed with `where`. */
export function mergeConfig(
  base: HarnessConfig,
  override: unknown,
  opts: { errors?: string[]; where?: string; globalOnly?: boolean } = {},
): HarnessConfig {
  const { errors, where = '', globalOnly = true } = opts;
  if (override === undefined) return base;
  if (!isRecord(override)) {
    errors?.push(`${where}must hold an object.`);
    return base;
  }
  const out: HarnessConfig = { ...base };
  const known = Object.keys(DEFAULT_CONFIG) as (keyof HarnessConfig)[];
  for (const key of Object.keys(override)) {
    if (RETIRED.includes(key)) continue;
    if (!(known as string[]).includes(key)) {
      errors?.push(`${where}"${key}" is not a setting Coplan reads: use ${known.join(', ')}.`);
      continue;
    }
    const k = key as keyof HarnessConfig;
    if (!globalOnly && GLOBAL_ONLY.includes(k)) {
      errors?.push(`${where}"${key}" can only be set in the global config: one daemon serves every repository.`);
      continue;
    }
    const why = invalid(k, override[key]);
    if (why) {
      errors?.push(`${where}"${key}" ${why}; ${JSON.stringify(override[key])} is not, so ${JSON.stringify(base[k])} is used.`);
      continue;
    }
    (out as unknown as Record<string, unknown>)[key] = override[key];
  }
  return out;
}

export interface ConfigReport {
  config: HarnessConfig;
  /** What could not be read or used, each naming its file. */
  errors: string[];
  /** The files looked at; the config is current while none of them changes. */
  files: string[];
}

function readLayer(file: string, errors: string[]): unknown {
  let text: string;
  try {
    if (!existsSync(file)) return undefined;
    text = readFileSync(file, 'utf8');
  } catch (err) {
    errors.push(`${file} could not be read: ${(err as Error).message}`);
    return undefined;
  }
  try {
    return parseJsonc(text);
  } catch (err) {
    errors.push(`${file} is not valid JSON, so none of it is used: ${(err as Error).message}`);
    return undefined;
  }
}

export function globalConfigFile(configDir: string): string {
  return path.join(configDir, 'config.json');
}

export function projectHarnessFile(projectDir: string): string {
  return path.join(projectDir, '.claude', 'harness.json');
}

/** The config, with everything wrong with it said rather than skipped. */
export function loadConfigReport(opts: { configDir: string; projectDir?: string | null }): ConfigReport {
  const errors: string[] = [];
  const global = globalConfigFile(opts.configDir);
  const files = [global];
  let cfg = mergeConfig(DEFAULT_CONFIG, readLayer(global, errors), { errors, where: `${global}: ` });
  if (opts.projectDir) {
    const project = projectHarnessFile(opts.projectDir);
    files.push(project);
    cfg = mergeConfig(cfg, readLayer(project, errors), { errors, where: `${project}: `, globalOnly: false });
  }
  return { config: cfg, errors, files };
}

/**
 * The daemon's view of the config: read once per repository, and again as
 * soon as either file changes — an edit counts without a restart. What is
 * wrong with a file is handed to `onError` once, not on every read. Whoever
 * subscribes hears when what is wrong with a repository's files (or the
 * global one) changes — so a page can show it, and stop once it is fixed.
 */
export class ConfigCache {
  private entries = new Map<string, { stamp: string; config: HarnessConfig; errors: string[] }>();
  private said = new Set<string>();
  /** Watchers, by the folder they watch ('' for the global file alone). */
  private watchers = new Map<string, Set<() => void>>();
  /** What each folder's files were last found to hold wrong, kept apart
   *  from the cache: a cache cleared at its limit is not news, and does
   *  not lose what another folder's page shows. */
  private known = new Map<string, string[]>();
  private pending = new Set<string>();

  constructor(
    private readonly configDir: string,
    private readonly onError: (message: string) => void = () => {},
    private readonly max = 64,
  ) {}

  /** What is wrong with the files one repository reads — the global file
   *  and its own `.claude/harness.json` — read again if either changed. A
   *  page is shown its own repository's errors, not every repository's. */
  errors(projectDir?: string | null): string[] {
    this.get(projectDir);
    return this.held(projectDir);
  }

  /** The same, as last read, without looking at the files again: for a
   *  watcher told of a change, which a read just found. */
  held(projectDir?: string | null): string[] {
    return [...(this.known.get(projectDir ?? '') ?? this.entries.get(projectDir ?? '')?.errors ?? [])];
  }

  /** `fn` is called — once, after the read that found it, never inside it
   *  — whenever what is wrong with `projectDir`'s files changes. */
  subscribe(projectDir: string | null, fn: () => void): () => void {
    const key = projectDir ?? '';
    let set = this.watchers.get(key);
    if (!set) this.watchers.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.watchers.delete(key);
    };
  }

  get(projectDir?: string | null): HarnessConfig {
    const key = projectDir ?? '';
    const files = projectDir ? [globalConfigFile(this.configDir), projectHarnessFile(projectDir)] : [globalConfigFile(this.configDir)];
    const stamp = configStamp(files);
    const hit = this.entries.get(key);
    if (hit?.stamp === stamp) return hit.config;
    const report = loadConfigReport({ configDir: this.configDir, projectDir });
    for (const e of report.errors) {
      if (this.said.has(e)) continue;
      if (this.said.size > 256) this.said.clear();
      this.said.add(e);
      this.onError(e);
    }
    if (this.entries.size >= this.max) this.entries.clear();
    this.entries.set(key, { stamp, config: report.config, errors: report.errors });
    if ((this.known.get(key) ?? []).join('\n') !== report.errors.join('\n')) {
      if (this.known.size > 1000) this.known.clear();
      this.known.set(key, report.errors);
      this.notify(key);
    }
    return report.config;
  }

  /** A folder's watchers hear of its change once the read is done, and once
   *  however many reads changed it: one watcher reading again does not set
   *  off the next. */
  private notify(key: string): void {
    const first = this.pending.size === 0;
    this.pending.add(key);
    if (!first) return;
    queueMicrotask(() => {
      const keys = [...this.pending];
      this.pending.clear();
      for (const k of keys) for (const fn of this.watchers.get(k) ?? []) fn();
    });
  }
}

/** A stamp of the files a config was read from: when it changes, read again. */
export function configStamp(files: readonly string[]): string {
  return files
    .map((f) => {
      try {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}
