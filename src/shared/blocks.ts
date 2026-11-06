import type { Target } from './types.ts';

/**
 * What the agent is sent, as blocks that each say where they come from.
 *
 * A prompt is put together from many sources: the fields the user edits in
 * the page, the repository's and the user's Coplan config, what the user
 * chose in the sign-off dialog, what Coplan works out from the plan, and
 * Coplan's own fixed instructions. Rendered as blocks, every part of the
 * text can be traced to one of them — the page shows each block with its
 * source — while the text itself is the blocks joined, byte for byte what
 * the agent is sent.
 */

export type BlockSource =
  /** A field the user edits in the page: the plan's title or summary, a
   *  section, a diagram, a box, an arrow, a task — or the item a comment is
   *  on. */
  | { kind: 'field'; target: Target }
  /** A setting of the repository's `.coplan/config.json`, or of the user's
   *  own Coplan config: the files that set it (several for standing
   *  instructions, which add up), and its key. No files: no file sets it,
   *  and Coplan's default is used. */
  | { kind: 'config'; key: string; files: string[] }
  /** Worked out from the plan, naming what from. */
  | { kind: 'derived'; from: string[] }
  /** Coplan's fixed instructions. */
  | { kind: 'template' }
  /** What the user changed since the agent last read the plan. */
  | { kind: 'changes' }
  /** What the user wrote for the agent in the sign-off dialog. */
  | { kind: 'note' }
  /** How the build runs, as the user chose it in the Submit dialog. */
  | { kind: 'setting'; key: 'review' | 'parallel' | 'maxRounds' };

export type BlockSourceKind = BlockSource['kind'];

export const BLOCK_SOURCE_KINDS: readonly BlockSourceKind[] = ['field', 'config', 'derived', 'template', 'changes', 'note', 'setting'];

export interface Block {
  /** What the block is, e.g. `step-3` or `section:risks`. */
  id: string;
  source: BlockSource;
  /** Its text: whole lines, or — `inline` — the rest of the line before. */
  text: string;
  /** Continues the line of the block before it. */
  inline?: true;
  /** Left out to fit the prompt into one message: not part of the text.
   *  The agent reads it with harness_plan_read instead. */
  dropped?: true;
  /** Shortened to fit: `text` is what is sent. */
  cut?: true;
  /** The agent's bookkeeping — revisions, who edited what, how to reply,
   *  the status legend — with no counterpart in the page. */
  bookkeeping?: true;
}

/** Blocks joined as the agent reads them: whole-line blocks on lines of
 *  their own, inline ones on the line before. Dropped blocks are left out. */
export function joinBlocks(blocks: readonly Block[]): string {
  let out = '';
  let first = true;
  for (const b of blocks) {
    if (b.dropped) continue;
    out += first || b.inline ? b.text : `\n${b.text}`;
    first = false;
  }
  return out;
}

/** The text a prompt is: its blocks joined, without blank lines at either end. */
export function blocksText(blocks: readonly Block[]): string {
  return joinBlocks(blocks).trim();
}

type Flags = Pick<Block, 'dropped' | 'cut' | 'bookkeeping'>;

/**
 * Blocks in the making, written the way the renderer writes lines: `gap()`
 * where a blank line goes, `add()` for whole lines, `inline()` for the rest
 * of a line. A blank line belongs to the block after it, so a block that is
 * dropped takes its own spacing with it.
 */
export class BlockList {
  private readonly list: Block[] = [];
  private pending = 0;

  /** A blank line before the next block. */
  gap(lines = 1): this {
    this.pending += lines;
    return this;
  }

  /** Whole lines. */
  add(id: string, source: BlockSource, lines: string | readonly string[], flags: Flags = {}): this {
    const body = typeof lines === 'string' ? [lines] : [...lines];
    // A dropped block keeps the gap for the next block that is sent.
    const lead = flags.dropped ? [] : Array.from({ length: this.pending }, () => '');
    if (!flags.dropped) this.pending = 0;
    this.list.push({ id, source, text: [...lead, ...body].join('\n'), ...clean(flags) });
    return this;
  }

  /** The rest of the line before; nothing when `text` is empty. */
  inline(id: string, source: BlockSource, text: string, flags: Flags = {}): this {
    if (text) this.list.push({ id, source, text, inline: true, ...clean(flags) });
    return this;
  }

  /** Blocks made elsewhere, in order. A gap waiting here goes before the
   *  first of them that is sent. */
  push(...blocks: readonly Block[]): this {
    for (const b of blocks) {
      if (this.pending && !b.inline && !b.dropped) {
        this.list.push({ ...b, text: `${'\n'.repeat(this.pending)}${b.text}` });
        this.pending = 0;
      } else this.list.push(b);
    }
    return this;
  }

  get blocks(): Block[] {
    return this.list;
  }

  get length(): number {
    return this.list.length;
  }
}

function clean(flags: Flags): Flags {
  const out: Flags = {};
  if (flags.dropped) out.dropped = true;
  if (flags.cut) out.cut = true;
  if (flags.bookkeeping) out.bookkeeping = true;
  return out;
}

/**
 * A config setting a prompt is made with, as the sign-off dialogs list it:
 * read-only, with where it is set, so the user can follow it to the file.
 */
export interface ConfigRow {
  /** Its key in `.coplan/config.json`, e.g. `hooks.review`, `pullRequests`. */
  key: string;
  label: string;
  /** What it is set to, in words. */
  value: string;
  /** The files that set it; empty when none does and Coplan's default holds. */
  files: string[];
}

/** The same blocks, every one marked dropped. */
export function dropAll(blocks: readonly Block[]): Block[] {
  return blocks.map((b) => ({ ...b, dropped: true }));
}

/** Blocks as a list of lines, for text that is put together as lines. */
export function blockLines(blocks: readonly Block[]): string[] {
  return blocks.length ? joinBlocks(blocks).split('\n') : [];
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

export const TEMPLATE: BlockSource = { kind: 'template' };
export const CHANGES: BlockSource = { kind: 'changes' };
export const NOTE: BlockSource = { kind: 'note' };

export const field = (kind: Target['kind'], id = ''): BlockSource => ({ kind: 'field', target: { kind, id } });
export const derived = (...from: string[]): BlockSource => ({ kind: 'derived', from });
export const setting = (key: 'review' | 'parallel' | 'maxRounds'): BlockSource => ({ kind: 'setting', key });

/* ------------------------------------------------------------------ *
 * What was left out
 * ------------------------------------------------------------------ */

/**
 * What a prompt cut to fit leaves out, in words: "3 sections", "the
 * architecture (2 diagrams)". Empty when nothing was.
 */
export function droppedParts(blocks: readonly Block[]): string[] {
  const dropped = blocks.filter((b) => b.dropped);
  if (!dropped.length) return [];
  // An item's own block is named after it: `section:risks`, `task:t3`.
  const items = (kind: Target['kind']) =>
    dropped.filter((b) => b.source.kind === 'field' && b.source.target.kind === kind && b.id === `${kind}:${b.source.target.id}`).length;
  const has = (id: string) => dropped.some((b) => b.id === id);
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const out: string[] = [];
  if (has('summary')) out.push('the summary');
  if (has('changes')) out.push('what the user changed');
  const sections = items('section');
  if (sections) out.push(n(sections, 'section'));
  const diagrams = items('diagram');
  if (diagrams) out.push(`the architecture (${n(diagrams, 'diagram')})`);
  const details = dropped.filter((b) => b.source.kind === 'field' && b.source.target.kind === 'task' && b.id === `task:${b.source.target.id}:detail`).length;
  if (details) out.push(`the detail of ${n(details, 'task')}`);
  const tasks = items('task');
  if (tasks) out.push(`${n(tasks, 'task')} past the cut`);
  if (has('build-order') || has('branches')) out.push('the build order');
  if (has('report')) out.push('the build report');
  const comments = dropped.filter((b) => b.id.startsWith('thread:') && !b.bookkeeping).length;
  if (comments) out.push(n(comments, 'open comment'));
  return out;
}
