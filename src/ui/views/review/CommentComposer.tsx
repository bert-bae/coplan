import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../../store.ts';
import { Button } from '../../components/primitives.tsx';
import { lineRef } from '../../lib/format.ts';
import { excerptFor } from '../../../shared/diffparse.ts';
import type { Selection } from './DiffFile.tsx';

/**
 * Writing a line comment.
 *
 * It says explicitly that adding a comment does not send it — the previous
 * "Add comment" button read like a send, and the actual send lived in a
 * different part of the page.
 */
export function CommentComposer({ selection, onDone }: { selection: Selection; onDone: () => void }) {
  const [body, setBody] = useState('');
  const diff = useStore((s) => s.diff);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const text = body.trim();
    if (!text) return;
    const file = diff?.files.find((f) => f.path === selection.file);
    store.addDraft({
      id: newId(),
      file: selection.file,
      side: selection.side,
      startLine: selection.start,
      endLine: selection.end,
      body: text,
      excerpt: file ? excerptFor(file, selection.side, selection.start, selection.end) : undefined,
      createdAt: Date.now(),
      resolved: false,
    });
    setBody('');
    onDone();
  };

  return (
    <div className="dcomposer">
      <div className="dcomposer-card">
        <header className="dcomposer-head">
          <strong>{lineRef(selection.file, selection.start, selection.end)}</strong>
          <span className="muted">shift-click another line to extend the range</span>
        </header>
        <textarea
          ref={ref}
          className="input"
          rows={3}
          value={body}
          placeholder="What should change here?"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
            if (e.key === 'Escape') onDone();
          }}
        />
        <div className="dcomposer-foot">
          <span className="explain">Saved to your review — Claude sees it when you submit.</span>
          <div className="row-actions">
            <Button size="sm" variant="primary" onClick={submit} disabled={!body.trim()}>
              Add to review
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function newId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
