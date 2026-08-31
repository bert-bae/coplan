import { useCallback, useEffect, useRef, useState } from 'react';
import { store, useStore, useGateOfKind, useDrafts } from '../store.ts';
import { FileTree } from './review/FileTree.tsx';
import { DiffFileView, type Selection } from './review/DiffFile.tsx';
import { PendingPanel } from './review/PendingPanel.tsx';
import { Button, EmptyState, Spinner } from '../components/primitives.tsx';
import { StageBar } from '../components/StageStatus.tsx';
import { classNames, pluralize } from '../lib/format.ts';
import type { ReviewThread } from '../../shared/types.ts';

/**
 * Code review, laid out the way a pull request is: files on the left, the
 * whole diff in one continuous scroll in the middle, and everything the user
 * has written but not sent on the right.
 *
 * The previous version rendered exactly one file at a time, which made the
 * file list a router rather than an outline — there was no way to tell whether
 * you had looked at everything.
 */
export function ReviewView() {
  const diff = useStore((s) => s.diff);
  const loading = useStore((s) => s.diffLoading);
  const selectedFile = useStore((s) => s.selectedFile);
  const diffMode = useStore((s) => s.diffMode);
  const gate = useGateOfKind('code_review');
  const drafts = useDrafts();

  const [selection, setSelection] = useState<Selection | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const anchors = useRef(new Map<string, HTMLElement>());
  const scroller = useRef<HTMLDivElement>(null);

  const registerAnchor = useCallback((path: string, node: HTMLElement | null) => {
    if (node) anchors.current.set(path, node);
    else anchors.current.delete(path);
  }, []);

  // Selecting a file scrolls to it rather than replacing the view, so the
  // reviewer keeps their place in the whole change.
  const scrollToFile = useCallback((path: string) => {
    store.selectFile(path);
    anchors.current.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const jumpToThread = useCallback((thread: ReviewThread) => {
    const node = anchors.current.get(thread.file);
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    store.selectFile(thread.file);
    window.setTimeout(() => {
      const row = node?.querySelector<HTMLElement>(`[data-line="${thread.endLine}"]`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row?.classList.add('is-flash');
      window.setTimeout(() => row?.classList.remove('is-flash'), 900);
    }, 120);
  }, []);

  const moved = diff?.changedSinceLastReview ?? null;
  const visible = onlyChanged && moved ? (diff?.files ?? []).filter((f) => f.changedSinceLastReview) : (diff?.files ?? []);

  useTrackVisibleFile(scroller, anchors);
  useReviewShortcuts({
    files: visible.map((f) => f.path),
    selected: selectedFile,
    onFile: scrollToFile,
    onTogglePanel: () => setPanelOpen((v) => !v),
    onToggleViewed: () => selectedFile && store.toggleViewed(selectedFile),
    onRefresh: () => void store.refreshDiff(true),
  });

  if (loading && !diff) {
    return (
      <div className="review-empty">
        <Spinner label="Computing the diff…" />
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="review-empty">
        <EmptyState
          title="No diff published yet"
          hint="Claude publishes one when it reaches the review stage. You can also compute the current diff now."
          action={
            <Button variant="primary" onClick={() => void store.refreshDiff(true)}>
              Compute diff now
            </Button>
          }
        />
      </div>
    );
  }

  if (diff.files.length === 0) {
    return (
      <div className="review-empty">
        <EmptyState
          title="No changes against this base"
          hint={
            <>
              Diffed against <code>{shortRef(diff.baseRef)}</code>. Either nothing has changed yet, or the base
              is wrong.
            </>
          }
          action={
            <Button onClick={() => void store.refreshDiff(true)}>Recompute</Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={classNames('review', panelOpen && 'has-panel')}>
      <StageBar tab="review" />
      <div className="review-bar">
        <div className="review-bar-info">
          <strong>{pluralize(diff.files.length, 'file')}</strong>
          <span className="add">+{diff.additions}</span>
          <span className="del">−{diff.deletions}</span>
          <span className="muted" title={`base ${diff.baseRef}`}>
            since {shortRef(diff.baseRef)}
            {diff.includesWorkingTree && ' · includes uncommitted work'}
          </span>
          {diff.round > 1 && <span className="pill is-sent">round {diff.round}</span>}
        </div>
        <div className="review-bar-actions">
          {moved && (
            // Round three should not be a cold read of the whole change.
            <div className="segmented" role="group" aria-label="Scope">
              <button
                type="button"
                className={classNames('seg', !onlyChanged && 'is-active')}
                onClick={() => setOnlyChanged(false)}
              >
                All files
              </button>
              <button
                type="button"
                className={classNames('seg', onlyChanged && 'is-active')}
                onClick={() => setOnlyChanged(true)}
                title={`${moved.length} file(s) changed since round ${diff.previousRound}`}
              >
                Changed since round {diff.previousRound} · {moved.length}
              </button>
            </div>
          )}
          <div className="segmented" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={classNames('seg', diffMode === 'unified' && 'is-active')}
              onClick={() => store.setDiffMode('unified')}
            >
              Wrap
            </button>
            <button
              type="button"
              className={classNames('seg', diffMode === 'split' && 'is-active')}
              onClick={() => store.setDiffMode('split')}
            >
              No wrap
            </button>
          </div>
          <Button variant="ghost" onClick={() => void store.refreshDiff(true)}>
            Refresh
          </Button>
          <Button variant={drafts.length ? 'primary' : 'default'} onClick={() => setPanelOpen((v) => !v)}>
            Your review{drafts.length > 0 ? ` · ${drafts.length}` : ''}
          </Button>
        </div>
      </div>

      <div className="review-body">
        <FileTree files={visible} selected={selectedFile} onSelect={scrollToFile} />

        <div className="diff-pane" ref={scroller}>
          {onlyChanged && visible.length === 0 && (
            <p className="dfile-note">Nothing changed since round {diff.previousRound}.</p>
          )}
          {visible.map((file) => (
            <DiffFileView
              key={file.path}
              file={file}
              selection={selection}
              onSelect={setSelection}
              onCancelSelection={() => setSelection(null)}
              registerAnchor={registerAnchor}
            />
          ))}
        </div>

        {panelOpen && (
          <PendingPanel gate={gate} onJump={jumpToThread} onClose={() => setPanelOpen(false)} />
        )}
      </div>
    </div>
  );
}

/**
 * Reading a forty-file diff with the mouse is slow. These are the motions a
 * developer already has in their fingers from a pager or an editor.
 */
function useReviewShortcuts(opts: {
  files: string[];
  selected: string | null;
  onFile: (path: string) => void;
  onTogglePanel: () => void;
  onToggleViewed: () => void;
  onRefresh: () => void;
}): void {
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const { files, selected, onFile } = ref.current;
      const index = selected ? files.indexOf(selected) : -1;

      switch (event.key) {
        case 'j':
        case ']': {
          event.preventDefault();
          const next = files[Math.min(files.length - 1, index + 1)];
          if (next) onFile(next);
          return;
        }
        case 'k':
        case '[': {
          event.preventDefault();
          const previous = files[Math.max(0, index - 1)];
          if (previous) onFile(previous);
          return;
        }
        case 'v':
          event.preventDefault();
          ref.current.onToggleViewed();
          return;
        case 'p':
          event.preventDefault();
          ref.current.onTogglePanel();
          return;
        case 'r':
          event.preventDefault();
          ref.current.onRefresh();
          return;
        case '/': {
          event.preventDefault();
          document.querySelector<HTMLInputElement>('.file-filter')?.focus();
          return;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

/** Keep the file rail in sync with whatever is on screen. */
function useTrackVisibleFile(
  scroller: React.RefObject<HTMLDivElement | null>,
  anchors: React.RefObject<Map<string, HTMLElement>>,
): void {
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const path = visible?.target.getAttribute('data-path');
        if (path) store.selectFile(path);
      },
      { root, rootMargin: '-8px 0px -70% 0px', threshold: 0 },
    );
    for (const node of anchors.current?.values() ?? []) observer.observe(node);
    return () => observer.disconnect();
  }, [scroller, anchors]);
}

function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
}
