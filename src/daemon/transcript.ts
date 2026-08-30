import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { WorktreeResolver, type WorktreeRecord } from './worktree.ts';
import type { TimelineEvent, TimelineKind } from '../shared/types.ts';

/**
 * Tails a session's transcript JSONL and turns it into timeline entries.
 *
 * This is where "check on the progress of the session" comes from for free:
 * everything Claude says, thinks, and calls is already on disk, so the UI can
 * show it without spending a single token asking the model to narrate.
 */

export interface TranscriptUpdate {
  events: Omit<TimelineEvent, 'id' | 'ts'>[];
  /** Set when the CLI has assigned the conversation a title. */
  title?: string;
  /** Token usage seen in this batch, to roll up per stage. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Present only when the session entered or left a worktree in this batch;
   *  `null` means it left one. Absent means nothing about it changed. */
  worktree?: WorktreeRecord | null;
}

const MAX_TEXT = 4000;
const MAX_THINKING = 600;
const POLL_MS = 700;
/**
 * Cap on the partial trailing line held between reads. A transcript entry is
 * one JSON object per line and can legitimately be large, but an unterminated
 * line — a truncated write, a corrupted file — would otherwise accumulate for
 * as long as the tailer lives.
 */
const MAX_CARRY = 4 * 1024 * 1024;

export class TranscriptTailer {
  private offset = 0;
  private carry = '';
  private watcher: FSWatcher | null = null;
  private poller: NodeJS.Timeout | null = null;
  private reading = false;
  private pending = false;
  private closed = false;
  private worktree = new WorktreeResolver();

  constructor(
    private readonly file: string,
    private readonly onUpdate: (update: TranscriptUpdate) => void,
  ) {}

  /**
   * Start tailing. `fromStart` replays the whole file, which is what a fresh
   * daemon needs when it attaches to a session already in progress.
   *
   * The file usually does not exist yet at `SessionStart` — the CLI writes it
   * once the first message lands — so this waits for it rather than giving up.
   * Polling backs up `fs.watch` because watches are unreliable across
   * rotation, network filesystems and WSL.
   */
  start(fromStart = false): void {
    if (!fromStart && existsSync(this.file)) {
      try {
        this.offset = statSync(this.file).size;
      } catch {
        this.offset = 0;
      }
    }

    this.poller = setInterval(() => this.tick(), POLL_MS);
    this.poller.unref?.();
    this.tick();
  }

  /** One poll: attach a watcher once the file appears, then read. */
  private tick(): void {
    if (this.closed) return;
    if (!this.watcher && existsSync(this.file)) {
      try {
        this.watcher = watch(this.file, { persistent: false }, () => this.scheduleRead());
      } catch {
        /* polling alone is enough */
      }
    }
    this.scheduleRead();
  }

  /** Idempotent: releases the watch descriptor and the poll interval. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = false;
    this.carry = '';
    try {
      this.watcher?.close();
    } catch {
      /* already gone */
    }
    this.watcher = null;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private scheduleRead(): void {
    if (this.closed) return;
    if (this.reading) {
      this.pending = true;
      return;
    }
    void this.read();
  }

  private async read(): Promise<void> {
    if (this.closed) return;
    this.reading = true;
    try {
      let size = 0;
      try {
        size = statSync(this.file).size;
      } catch {
        return;
      }
      // A shrinking file means it was rotated or rewritten; start over.
      if (size < this.offset) {
        this.offset = 0;
        this.carry = '';
      }
      if (size === this.offset) return;

      const chunk = await readRange(this.file, this.offset, size - 1);
      this.offset = size;
      const text = this.carry + chunk;
      const lines = text.split('\n');
      this.carry = lines.pop() ?? '';
      if (this.carry.length > MAX_CARRY) {
        // Nothing parseable is coming; drop it rather than grow forever.
        this.carry = '';
      }

      const update: TranscriptUpdate = { events: [] };
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.consume(JSON.parse(line) as Record<string, unknown>, update);
        } catch {
          /* a partially-written line; the carry handles the common case */
        }
      }
      // A close that landed mid-read must not push state into a session the
      // daemon has already finished with.
      if (this.closed) return;
      if (update.events.length > 0 || update.title || update.usage || 'worktree' in update) {
        this.onUpdate(update);
      }
    } finally {
      this.reading = false;
      if (this.pending && !this.closed) {
        this.pending = false;
        this.scheduleRead();
      }
    }
  }

  private consume(entry: Record<string, unknown>, update: TranscriptUpdate): void {
    const type = entry['type'];

    // Relocation into (or out of) a worktree moves the ground every git
    // operation for this session stands on, so it is watched continuously
    // rather than only read once when the session registers.
    if (type === 'worktree-state' || type === 'relocated') {
      if (this.worktree.consume(entry)) update.worktree = this.worktree.current;
      return;
    }

    if (type === 'ai-title') {
      const title = firstString(entry['title'], entry['text'], entry['value']);
      if (title) update.title = title;
      return;
    }

    if (type === 'assistant') {
      const message = entry['message'] as { content?: unknown; usage?: unknown } | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage) {
        const input =
          num(usage['input_tokens']) +
          num(usage['cache_read_input_tokens']) +
          num(usage['cache_creation_input_tokens']);
        const output = num(usage['output_tokens']);
        if (input || output) {
          update.usage ??= { inputTokens: 0, outputTokens: 0 };
          update.usage.inputTokens += input;
          update.usage.outputTokens += output;
        }
      }
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const raw of content) {
        const block = raw as Record<string, unknown>;
        switch (block['blockType'] ?? block['type']) {
          case 'text': {
            const text = String(block['text'] ?? '').trim();
            if (text) update.events.push({ kind: 'assistant', text: truncate(text, MAX_TEXT) });
            break;
          }
          case 'thinking': {
            const text = String(block['thinking'] ?? block['text'] ?? '').trim();
            if (text) update.events.push({ kind: 'thinking', text: truncate(text, MAX_THINKING) });
            break;
          }
          case 'tool_use': {
            const name = String(block['name'] ?? 'tool');
            const input = (block['input'] ?? {}) as Record<string, unknown>;
            update.events.push({
              kind: 'tool',
              label: name,
              text: describeToolInput(name, input),
              meta: { tool: name },
            });
            break;
          }
        }
      }
      return;
    }

    if (type === 'user' && entry['isSidechain'] !== true) {
      const origin = entry['origin'] as { kind?: string } | undefined;
      // Tool results also arrive as `user` entries; only surface real prompts.
      if (origin?.kind !== 'human') return;
      const message = entry['message'] as { content?: unknown } | undefined;
      const text = extractUserText(message?.content);
      if (text) update.events.push({ kind: 'user', text: truncate(text, MAX_TEXT) });
      return;
    }

    if (type === 'system') {
      const text = firstString(entry['content'], entry['text']);
      if (text) update.events.push({ kind: 'note', text: truncate(text, 500) });
    }
  }
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (block['type'] !== 'text') continue;
    const text = String(block['text'] ?? '');
    // The IDE injects context blocks that aren't things the user typed.
    if (/^<(ide_|system-reminder|local-command)/.test(text.trim())) continue;
    parts.push(text);
  }
  return parts.join('\n').trim();
}

/** A one-line summary of a tool call, good enough for a progress feed. */
function describeToolInput(name: string, input: Record<string, unknown>): string {
  const str = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === 'string' ? v : undefined;
  };
  switch (name) {
    case 'Bash':
      return truncate(str('command') ?? '', 240);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str('file_path') ?? str('notebook_path') ?? '';
    case 'Grep':
      return `${str('pattern') ?? ''}${str('path') ? ` in ${str('path')}` : ''}`;
    case 'Glob':
      return str('pattern') ?? '';
    case 'Task':
    case 'Agent':
      return str('description') ?? str('prompt')?.slice(0, 120) ?? '';
    case 'Skill':
      return str('skill') ?? '';
    case 'WebFetch':
      return str('url') ?? '';
    case 'TodoWrite':
      return 'updated the task list';
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return truncate(first ?? '', 160);
    }
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function readRange(file: string, start: number, end: number): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const stream = createReadStream(file, { start, end, encoding: 'utf8' });
    // Resolve once and always destroy: an error mid-stream would otherwise
    // leave the descriptor open until GC got around to it.
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(out);
    };
    stream.on('data', (c) => {
      out += c;
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

export const _internals = { describeToolInput, extractUserText, truncate };
export type { WorktreeRecord };
export type { TimelineKind };
