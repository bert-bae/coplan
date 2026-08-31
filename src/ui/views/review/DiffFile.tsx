import { memo, useMemo } from 'react';
import { store, useDrafts, useStore } from '../../store.ts';
import { CommentThread } from './CommentThread.tsx';
import { CommentComposer } from './CommentComposer.tsx';
import { classNames, splitPath } from '../../lib/format.ts';
import type { DiffFile as DiffFileModel, DiffLine, ReviewThread } from '../../../shared/types.ts';

export interface Selection {
  file: string;
  side: 'old' | 'new';
  start: number;
  end: number;
}

/**
 * One file's diff.
 *
 * Laid out as a grid rather than nested flex, which is what makes the gutters
 * stay aligned, lets a row's background span the full scroll width, and lets a
 * comment thread span every column without disturbing the code above it.
 * Lines soft-wrap by default: a change that scrolls off to the right is a
 * change the reviewer never sees.
 */
export const DiffFileView = memo(function DiffFileView({
  file,
  selection,
  onSelect,
  onCancelSelection,
  registerAnchor,
}: {
  file: DiffFileModel;
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
  onCancelSelection: () => void;
  registerAnchor: (path: string, node: HTMLElement | null) => void;
}) {
  const drafts = useDrafts();
  const sent = useStore((s) => s.session?.threads ?? EMPTY_THREADS);
  const viewed = useStore((s) => store.isViewed(file.path));
  const wrap = useStore((s) => s.diffMode === 'unified');

  const threads = useMemo(
    () => [...drafts, ...sent].filter((t) => t.file === file.path),
    [drafts, sent, file.path],
  );

  // Gutters sized to the file's largest line number: a fixed width silently
  // clips five-digit numbers in a big file.
  const digits = useMemo(() => gutterDigits(file), [file]);
  const { dir, name } = splitPath(file.path);

  return (
    <section
      className={classNames('dfile', viewed && 'is-viewed')}
      aria-label={`${file.status} ${file.path}`}
      ref={(node) => registerAnchor(file.path, node)}
      data-path={file.path}
      style={{ '--gut': `calc(${digits}ch + 16px)` } as React.CSSProperties}
    >
      <header className="dfile-head">
        <span className={classNames('file-status', `is-${file.status}`)}>{file.status[0]!.toUpperCase()}</span>
        <span className="dfile-path" title={file.path}>
          <span className="dfile-dir">{dir}</span>
          <span className="dfile-name">{name}</span>
        </span>
        {file.oldPath && file.oldPath !== file.path && (
          <span className="muted">renamed from {file.oldPath}</span>
        )}
        <span className="dfile-counts">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
        {threads.length > 0 && (
          <span className="pill is-draft">{threads.length} comment{threads.length === 1 ? '' : 's'}</span>
        )}
        <label className="dfile-viewed">
          <input
            type="checkbox"
            checked={viewed}
            aria-label={`Mark ${file.path} viewed`}
            onChange={() => store.toggleViewed(file.path)}
          />
          Viewed
        </label>
      </header>

      {file.binary ? (
        <p className="dfile-note">Binary file — content not shown. It is still part of the change.</p>
      ) : file.truncated || !file.hunks ? (
        <p className="dfile-note">
          This file is too large to render here. It is still part of the change — review it in your editor.
        </p>
      ) : viewed ? (
        <p className="dfile-note">
          Marked viewed.{' '}
          <button type="button" className="link" onClick={() => store.toggleViewed(file.path)}>
            Show the diff again
          </button>
        </p>
      ) : (
        <div className={classNames('dtable', wrap ? 'is-wrap' : 'is-nowrap')}>
          {file.hunks.map((hunk, hunkIndex) => (
            <div className="dhunk" key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
              <div className="dhunk-head">
                @@ −{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                {hunk.header && <span className="dhunk-ctx"> {hunk.header}</span>}
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <Row
                  key={`${hunkIndex}-${lineIndex}`}
                  file={file.path}
                  line={line}
                  selection={selection}
                  threads={threads}
                  onSelect={onSelect}
                  onCancelSelection={onCancelSelection}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
});

function Row({
  file,
  line,
  selection,
  threads,
  onSelect,
  onCancelSelection,
}: {
  file: string;
  line: DiffLine;
  selection: Selection | null;
  threads: ReviewThread[];
  onSelect: (sel: Selection | null) => void;
  onCancelSelection: () => void;
}) {
  // A deleted line is anchored to the old file, everything else to the new.
  const side: 'old' | 'new' = line.kind === 'del' ? 'old' : 'new';
  const lineNo = side === 'old' ? line.oldLine : line.newLine;

  const selected =
    selection !== null &&
    selection.file === file &&
    selection.side === side &&
    lineNo !== null &&
    lineNo >= selection.start &&
    lineNo <= selection.end;

  // Threads anchor at their last line, but both ends get a marker so a range
  // is visible from either direction.
  const anchored = threads.filter(
    (t) => t.side === side && lineNo !== null && (t.endLine === lineNo || t.startLine === lineNo),
  );
  const endsHere = anchored.filter((t) => t.endLine === lineNo);

  const click = (event: React.MouseEvent) => {
    if (lineNo === null) return;
    // Don't hijack a text selection the user made to copy code.
    if (window.getSelection()?.toString()) return;
    if (event.shiftKey && selection && selection.file === file && selection.side === side) {
      onSelect({
        ...selection,
        start: Math.min(selection.start, lineNo),
        end: Math.max(selection.end, lineNo),
      });
    } else {
      onSelect({ file, side, start: lineNo, end: lineNo });
    }
  };

  const isSelectionEnd = selected && selection?.end === lineNo;

  return (
    <>
      {/* The row itself is not a control.
       *
       * It used to be `role="button"` with an `aria-label`, which had two
       * costs: the label replaced the line's own text, so a screen reader
       * read "src/app.ts line 12, press Enter to comment" and never the code
       * — the diff was literally unreadable — and every line of a large diff
       * became its own tab stop. The click handler stays for the mouse, and
       * the gutter carries a real button for everyone else. */}
      <div
        className={classNames(
          'drow',
          `is-${line.kind}`,
          selected && 'is-selected',
          anchored.length > 0 && 'has-comment',
        )}
        onClick={click}
      >
        <span className="dnum" aria-hidden="true">
          {line.oldLine ?? ''}
        </span>
        <span className="dnum" aria-hidden="true">
          {line.newLine ?? ''}
        </span>
        <span className="dmark">
          <span aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
          {lineNo !== null && (
            <button
              type="button"
              className="dadd-hint"
              title="Comment on this line"
              // A removed line and an added line often carry the same number
              // on opposite sides of the diff. Naming both "line 2" leaves a
              // screen reader user with two identical buttons that do
              // different things.
              aria-label={`Comment on ${file}, ${lineWord(line.kind)} ${lineNo}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect({ file, side, start: lineNo, end: lineNo });
              }}
            >
              <span aria-hidden="true">+</span>
            </button>
          )}
        </span>
        <span className="dcode">{line.text || ' '}</span>
      </div>

      {endsHere.map((thread) => (
        <CommentThread key={thread.id} thread={thread} />
      ))}

      {isSelectionEnd && selection && (
        <CommentComposer selection={selection} onDone={onCancelSelection} />
      )}
    </>
  );
}

function lineWord(kind: DiffLine['kind']): string {
  return kind === 'del' ? 'removed line' : kind === 'add' ? 'added line' : 'line';
}

function gutterDigits(file: DiffFileModel): number {
  let max = 0;
  for (const hunk of file.hunks ?? []) {
    max = Math.max(max, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
  }
  return Math.max(2, String(max).length);
}

const EMPTY_THREADS: ReviewThread[] = [];
