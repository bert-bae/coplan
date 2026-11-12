import { statSync } from 'node:fs';
import { inspect } from 'node:util';
import { configStamp } from '../shared/config.ts';
import { loadProjectConfig, type ProjectConfig } from '../shared/project.ts';
import type { ReviewMode } from '../shared/types.ts';
import { ReviewReads } from './reviewReads.ts';

/** What the cache reads the files with: the disk, or a test's stand-in. */
export interface ProjectFiles {
  load(root: string): ProjectConfig;
  stamp(sources: string[]): string;
  /** A file's modification time; undefined when it is gone. */
  mtime(file: string): number | undefined;
  now(): number;
}

const DISK: ProjectFiles = {
  load: loadProjectConfig,
  stamp: configStamp,
  mtime(file) {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
  },
  now: Date.now,
};

/**
 * Each repository's `.coplan/config.json` over the user's own layer. Read
 * again as soon as any file it came from changes — an edit counts at once —
 * and otherwise kept: a stat per file, not a read and a parse of every one,
 * on each call. A read that finds a repository's review mode changed tells
 * `reviewChanges`, after the read.
 */
export class ProjectConfigs {
  private readonly projects = new Map<string, { stamp: string; config: ProjectConfig }>();
  /** Each repository's review mode as last read, to tell a change (#163). */
  private readonly reviews: ReviewReads;
  /** Told of each repository whose review mode a read found changed, with
   *  the new one: an open page has it sent, the session list too. */
  readonly reviewChanges = new Set<(root: string, review: ReviewMode) => void>();
  /** Where a listener's error goes: the daemon sets its log (B83). */
  logError: (message: string) => void = () => {};

  /** `max`: configs kept. `knownReviews`: repositories whose review mode is
   *  remembered — more than one session-list pass reads (the list holds 120
   *  sessions at most: store.ts MAX_SESSIONS, twice), so a pass never pushes
   *  out the one an open page shows. */
  constructor(
    private readonly max: number,
    private readonly files: ProjectFiles = DISK,
    knownReviews = 1000,
  ) {
    this.reviews = new ReviewReads(Math.max(1, knownReviews));
  }

  at(root: string): ProjectConfig {
    const hit = this.projects.get(root);
    if (hit && hit.config.sources && this.files.stamp(hit.config.sources) === hit.stamp) {
      // A cached read keeps the repository among those known.
      this.reviews.saw(root, hit.config.settings.review);
      return hit.config;
    }
    const started = this.files.now();
    const config = this.files.load(root);
    if (this.projects.size >= this.max) this.projects.clear();
    // A file saved while it was being read may have been read half old: if
    // any changed since the load began, nothing is kept, and the next call
    // reads it again.
    const sources = config.sources ?? [];
    const settled = !sources.some((f) => (this.files.mtime(f) ?? -Infinity) >= started - 1);
    if (settled) this.projects.set(root, { stamp: this.files.stamp(sources), config });
    else this.projects.delete(root);
    const review = config.settings.review;
    if (this.reviews.saw(root, review)) {
      queueMicrotask(() => {
        // Each on its own: one that fails is logged and stops none of the others.
        for (const fn of this.reviewChanges) {
          try {
            fn(root, review);
          } catch (err) {
            this.logError(`review change listener failed: ${inspect(err)}`);
          }
        }
      });
    }
    return config;
  }
}
