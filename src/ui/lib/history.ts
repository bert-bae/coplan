/**
 * Undo and redo for the canvas, as a pair of stacks of whole graphs.
 *
 * The canvas already saves the whole graph on every change, so a step back
 * is the graph before it, saved again. Nothing here knows what a graph is;
 * the canvas decides when a step is recorded and when history no longer
 * applies (someone else changed the diagram).
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private readonly limit = 100) {}

  /** `before` is the state just replaced by a new edit. */
  record(before: T): void {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** The state to go back to, given the one on screen; null if none. */
  undo(current: T): T | null {
    const before = this.past.pop();
    if (before === undefined) return null;
    this.future.push(current);
    return before;
  }

  redo(current: T): T | null {
    const after = this.future.pop();
    if (after === undefined) return null;
    this.past.push(current);
    return after;
  }

  /** Forget the last edit recorded: it was refused, so the state before it
   *  is the state now, and undoing to it would do nothing. */
  discardLast(): void {
    this.past.pop();
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
