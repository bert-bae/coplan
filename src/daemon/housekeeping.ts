/**
 * Storage housekeeping.
 *
 * The harness writes in one place, `~/.claude/cc-harness`, and it accumulates.
 * A session directory outlives the session by design — the daemon evicts it
 * from memory long before it removes it from disk, so a `--resume` can still
 * find its plan — and a daemon killed mid-save leaves a half-written file.
 *
 * None of that is a leak the daemon can fix on its own without deciding, on
 * the user's behalf, that a piece of their history is worthless. So this
 * module only ever reports what *could* go, and removes exactly what it is
 * asked to; the decision stays with the person who owns the files.
 */
import { readdirSync, statSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessHome, paths, readLock, isPidAlive, sanitizeId } from '../shared/paths.ts';
import type { CleanupGroupId, CleanupOutcome, StorageGroup, StorageReport } from '../shared/types.ts';

/**
 * A session directory the daemon no longer lists has to have been untouched
 * for at least this long before it is offered up.
 *
 * Eviction from memory happens an hour after a session ends, but the CLI can
 * still resume that session and the harness will rehydrate it off disk. A day
 * is long enough that anything still on this list is genuinely finished with.
 */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/** A `.state.*.tmp` older than this was abandoned: the rename is atomic. */
const PARTIAL_WRITE_MS = 5 * 60 * 1000;

/** Above this, the daemon log is trimmed rather than left to grow. */
const LOG_LIMIT_BYTES = 1024 * 1024;
/** How much of the tail a trim keeps. */
const LOG_KEEP_BYTES = 256 * 1024;

export interface ScanOptions {
  /** Session ids the daemon is holding. These are never offered up. */
  liveSessionIds?: Iterable<string>;
  now?: number;
}

interface Candidate {
  path: string;
  bytes: number;
  /** Set on the log, which is trimmed in place rather than removed. */
  trimTo?: number;
}

interface GroupPlan extends Omit<StorageGroup, 'count' | 'bytes'> {
  candidates: Candidate[];
}

/**
 * What could be reclaimed, grouped by what losing it would cost.
 *
 * Every group is described in terms of the consequence, not the mechanism:
 * the question a user is answering is "can I afford to lose this", and no
 * amount of detail about `.state.<pid>.tmp` files helps them answer it.
 */
export function scanStorage(opts: ScanOptions = {}): StorageReport {
  const now = opts.now ?? Date.now();
  const live = new Set<string>();
  for (const id of opts.liveSessionIds ?? []) live.add(sanitizeId(id));

  const plans = buildPlans(live, now);
  const groups: StorageGroup[] = plans.map((plan) => ({
    id: plan.id,
    label: plan.label,
    detail: plan.detail,
    count: plan.candidates.length,
    bytes: plan.candidates.reduce((sum, c) => sum + reclaimable(c), 0),
  }));

  return {
    home: harnessHome(),
    scannedAt: now,
    groups,
    totalBytes: groups.reduce((sum, g) => sum + g.bytes, 0),
  };
}

export interface CleanOptions extends ScanOptions {
  /** Which groups to act on. Omitted means every group in the report. */
  groups?: CleanupGroupId[];
  /** Report what would go without touching anything. */
  dryRun?: boolean;
}

/**
 * Remove what the caller asked for, and report what actually went.
 *
 * The scan is redone here rather than trusting a report the caller is holding:
 * a report is a snapshot, and between rendering it and clicking the button a
 * session can have come back to life. Re-deriving the candidate list under the
 * *current* set of live sessions is what makes the button safe to press.
 */
export function cleanStorage(opts: CleanOptions = {}): CleanupOutcome {
  const now = opts.now ?? Date.now();
  const live = new Set<string>();
  for (const id of opts.liveSessionIds ?? []) live.add(sanitizeId(id));

  const wanted = opts.groups && opts.groups.length ? new Set(opts.groups) : null;
  const plans = buildPlans(live, now).filter((p) => !wanted || wanted.has(p.id));

  const groups: CleanupOutcome['groups'] = [];
  const failed: string[] = [];
  let freedBytes = 0;
  let removed = 0;

  for (const plan of plans) {
    let groupBytes = 0;
    let groupCount = 0;
    for (const candidate of plan.candidates) {
      const gain = reclaimable(candidate);
      if (opts.dryRun) {
        groupBytes += gain;
        groupCount++;
        continue;
      }
      if (!discard(candidate)) {
        failed.push(candidate.path);
        continue;
      }
      groupBytes += gain;
      groupCount++;
    }
    groups.push({ id: plan.id, label: plan.label, count: groupCount, bytes: groupBytes });
    freedBytes += groupBytes;
    removed += groupCount;
  }

  return { dryRun: Boolean(opts.dryRun), groups, removed, freedBytes, failed };
}

/* ------------------------------------------------------------------ *
 * Candidates
 * ------------------------------------------------------------------ */

function buildPlans(live: Set<string>, now: number): GroupPlan[] {
  return [
    {
      id: 'sessions',
      label: 'Finished sessions',
      detail: 'Saved plans for sessions Coplan no longer lists, untouched for over a day.',
      candidates: staleSessionDirs(live, now),
    },
    {
      id: 'partial-writes',
      label: 'Interrupted writes',
      detail: 'Half-written state files left behind when a daemon was killed mid-save.',
      candidates: partialWrites(now),
    },
    {
      id: 'log',
      label: 'Daemon log',
      detail: 'The older part of the log. The most recent entries are kept.',
      candidates: oversizedLog(),
    },
    {
      id: 'lock',
      label: 'Stale lock file',
      detail: 'A daemon address left behind by a process that is no longer running.',
      candidates: staleLock(),
    },
  ];
}

/**
 * Session directories the daemon has no session for.
 *
 * Anything resident is excluded by id, and anything touched recently is
 * excluded by age — including a session evicted an hour ago that the user is
 * about to resume.
 */
function staleSessionDirs(live: Set<string>, now: number): Candidate[] {
  const root = paths.sessionsDir();
  if (!existsSync(root)) return [];
  const out: Candidate[] = [];

  for (const entry of safeReaddir(root)) {
    if (!entry.isDirectory()) continue;
    if (live.has(sanitizeId(entry.name))) continue;
    const dir = path.join(root, entry.name);
    if (now - touchedAt(dir) < STALE_SESSION_MS) continue;
    out.push({ path: dir, bytes: sizeOf(dir) });
  }
  return out;
}

/**
 * The most recent moment anything in a session directory changed.
 *
 * The directory's own mtime only moves when an entry is added or removed, so a
 * long-running session that keeps rewriting `state.json` in place would look
 * years old by that measure alone.
 */
function touchedAt(dir: string): number {
  let latest = mtimeOf(dir);
  for (const entry of safeReaddir(dir)) {
    if (!entry.isFile()) continue;
    latest = Math.max(latest, mtimeOf(path.join(dir, entry.name)));
  }
  return latest;
}

/** `.state.<pid>.tmp` files that never got renamed. */
function partialWrites(now: number): Candidate[] {
  const root = paths.sessionsDir();
  if (!existsSync(root)) return [];
  const out: Candidate[] = [];

  for (const entry of safeReaddir(root)) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    for (const file of safeReaddir(dir)) {
      if (!file.isFile()) continue;
      if (!/^\.state\..*\.tmp$/.test(file.name)) continue;
      const full = path.join(dir, file.name);
      if (now - mtimeOf(full) < PARTIAL_WRITE_MS) continue;
      out.push({ path: full, bytes: sizeOf(full) });
    }
  }
  return out;
}

/** Trim the log if it is past its limit; the bytes given back, or 0. Only
 *  the log is looked at: cheap enough for the daemon to call every few
 *  minutes, unlike a whole `cleanStorage` scan. */
export function trimLog(): number {
  const [log] = oversizedLog();
  if (!log || !discard(log)) return 0;
  return reclaimable(log);
}

/** The log is appended to for the daemon's whole life and never rotated. */
function oversizedLog(): Candidate[] {
  const file = paths.logFile();
  const bytes = sizeOf(file);
  if (bytes <= LOG_LIMIT_BYTES) return [];
  return [{ path: file, bytes, trimTo: LOG_KEEP_BYTES }];
}

function staleLock(): Candidate[] {
  const lock = readLock();
  if (!lock || isPidAlive(lock.pid)) return [];
  const file = paths.lockFile();
  return [{ path: file, bytes: sizeOf(file) }];
}

/* ------------------------------------------------------------------ *
 * Removal
 * ------------------------------------------------------------------ */

/** What a candidate gives back: all of it, or the part of the log that goes. */
function reclaimable(candidate: Candidate): number {
  return candidate.trimTo === undefined ? candidate.bytes : Math.max(0, candidate.bytes - candidate.trimTo);
}

/**
 * Remove one candidate, refusing anything outside the directory the harness
 * writes to.
 *
 * Session ids are already sanitised on the way into a path, so this is a
 * second lock on a door that is bolted — which is the appropriate amount of
 * care for code whose failure mode is `rm -rf` on the wrong directory.
 */
function discard(candidate: Candidate): boolean {
  const target = path.resolve(candidate.path);
  const home = path.resolve(harnessHome());
  if (!target.startsWith(home + path.sep)) return false;

  try {
    if (candidate.trimTo !== undefined) {
      trimFile(target, candidate.trimTo);
      return true;
    }
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the last `keepBytes` of a file, starting at a line boundary.
 *
 * Rewritten in place rather than replaced: the daemon holds no descriptor on
 * the log — every entry is an `appendFileSync` — but a rename would still
 * leave anything that did hold one writing to an unlinked inode.
 */
function trimFile(file: string, keepBytes: number): void {
  const content = readFileSync(file, 'utf8');
  const tail = content.slice(Math.max(0, content.length - keepBytes));
  const from = tail.indexOf('\n');
  writeFileSync(file, from === -1 ? tail : tail.slice(from + 1));
}

/* ------------------------------------------------------------------ *
 * Filesystem helpers — none of these may throw, since a scan runs against
 * a directory other processes are writing to.
 * ------------------------------------------------------------------ */

function safeReaddir(dir: string): { name: string; isFile(): boolean; isDirectory(): boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function mtimeOf(target: string): number {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/** Bytes on disk, recursing into directories. */
function sizeOf(target: string): number {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of safeReaddir(target)) total += sizeOf(path.join(target, entry.name));
  return total;
}
