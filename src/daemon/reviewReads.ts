import type { ReviewMode } from '../shared/types.ts';

/**
 * Each repository's review mode as last read, to tell when a read finds it
 * changed (F80). Bounded, least recently read first out: every read — a
 * cached one too — keeps a repository in, so one an open page shows (read on
 * each settings tick) is never taken for new and its change lost (#163).
 */
export class ReviewReads {
  private readonly read = new Map<string, ReviewMode>();

  constructor(private readonly max: number) {}

  /** A read of `root` found `review`: whether that is a change from the
   *  last one known (a first read is not). A cached read is a read too. */
  saw(root: string, review: ReviewMode): boolean {
    const was = this.read.get(root);
    this.read.delete(root);
    this.read.set(root, review);
    if (this.read.size > this.max) this.read.delete(this.read.keys().next().value!);
    return was !== undefined && was !== review;
  }
}
