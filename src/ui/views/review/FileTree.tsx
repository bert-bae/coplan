import { useMemo, useState } from 'react';
import { store, useStore, useDrafts } from '../../store.ts';
import { classNames, splitPath } from '../../lib/format.ts';
import type { DiffFile, ReviewThread } from '../../../shared/types.ts';

/**
 * The file rail, in the shape a PR review needs: grouped by directory,
 * filterable, with per-file comment counts and a viewed checkbox so a
 * forty-file diff can be worked through without losing your place.
 */
export function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: DiffFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const drafts = useDrafts();
  const threads = useStore((s) => s.session?.threads ?? EMPTY);
  const viewed = useStore((s) => (s.sessionId ? (s.viewedFiles[s.sessionId] ?? EMPTY_STR) : EMPTY_STR));

  const groups = useMemo(() => groupByDirectory(files, filter), [files, filter]);
  const viewedCount = files.filter((f) => viewed.includes(f.path)).length;

  return (
    <nav className="file-rail" aria-label="Changed files">
      <div className="file-rail-head">
        <input
          className="file-filter"
          type="search"
          aria-label="Filter changed files"
          value={filter}
          placeholder={`Filter ${files.length} files…`}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="file-rail-progress">
          {viewedCount}/{files.length} viewed
        </span>
      </div>

      <div className="file-rail-body">
        {groups.length === 0 && <p className="sidebar-empty">No files match.</p>}
        {groups.map((group) => (
          <div className="file-group" key={group.dir}>
            {group.dir && <div className="file-group-head">{group.dir}</div>}
            {group.files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                active={file.path === selected}
                viewed={viewed.includes(file.path)}
                comments={countFor(file.path, drafts, threads)}
                onSelect={() => onSelect(file.path)}
              />
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

function FileRow({
  file,
  active,
  viewed,
  comments,
  onSelect,
}: {
  file: DiffFile;
  active: boolean;
  viewed: boolean;
  comments: { draft: number; sent: number };
  onSelect: () => void;
}) {
  const { name } = splitPath(file.path);

  return (
    <div
      className={classNames(
        'file-row',
        active && 'is-active',
        viewed && 'is-viewed',
        file.changedSinceLastReview === false && 'is-unchanged',
      )}
    >
      <label className="file-viewed" title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}>
        <input
          type="checkbox"
          checked={viewed}
          onChange={() => store.toggleViewed(file.path)}
          aria-label={`Mark ${file.path} viewed`}
        />
      </label>
      <button
        type="button"
        className="file-open"
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        title={file.path}
      >
        <span className={classNames('file-status', `is-${file.status}`)} aria-hidden="true">
          {file.status[0]!.toUpperCase()}
        </span>
        <span className="file-name">{name}</span>
        {file.changedSinceLastReview && (
          <span className="pill is-moved" title="Changed since your last review">
            new
          </span>
        )}
        {comments.draft > 0 && (
          <span className="pill is-draft" title={`${comments.draft} unsent comment(s)`}>
            {comments.draft}
          </span>
        )}
        {comments.sent > 0 && (
          <span className="pill is-sent" title={`${comments.sent} comment(s) already sent`}>
            {comments.sent}
          </span>
        )}
        <span className="file-counts">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
      </button>
    </div>
  );
}

function countFor(
  path: string,
  drafts: ReviewThread[],
  threads: ReviewThread[],
): { draft: number; sent: number } {
  return {
    draft: drafts.filter((t) => t.file === path).length,
    sent: threads.filter((t) => t.file === path && t.deliveredAt).length,
  };
}

function groupByDirectory(files: DiffFile[], filter: string): { dir: string; files: DiffFile[] }[] {
  const needle = filter.trim().toLowerCase();
  const matched = needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files;

  const map = new Map<string, DiffFile[]>();
  for (const file of matched) {
    const { dir } = splitPath(file.path);
    const key = dir.replace(/\/$/, '');
    const bucket = map.get(key);
    if (bucket) bucket.push(file);
    else map.set(key, [file]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, group]) => ({ dir, files: group }));
}

const EMPTY: ReviewThread[] = [];
const EMPTY_STR: string[] = [];
