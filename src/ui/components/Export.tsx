import { useEffect, useRef, useState } from 'react';
import { store, usePlan, useStore } from '../store.ts';
import { api } from '../lib/api.ts';
import { classNames } from '../lib/format.ts';
import { isComposing } from '../lib/keys.ts';
import { PromptView } from './PromptView.tsx';
import type { Block } from '../../shared/blocks.ts';
import type { Target } from '../../shared/types.ts';

/**
 * Export plan: the whole plan as Markdown — the summary, the sections, the
 * diagrams, the tasks with their briefs — with no build instructions, for
 * the user to take into whatever builds it. Open from every view and in
 * every phase: it signs nothing off and changes nothing, and the agent's
 * read position stays where it was.
 *
 * Shown as blocks with their sources, like everything the agent reads, so
 * each part of the export traces to the field it comes from.
 */
export function ExportHost() {
  const open = useStore((s) => s.exportOpen);
  const sessionId = useStore((s) => s.sessionId);
  if (!open || !sessionId) return null;
  return <ExportDialog key={sessionId} sessionId={sessionId} />;
}

interface Shown {
  version: number;
  text: string;
  blocks: Block[];
}

function showField(target: Target): void {
  store.closeExport();
  store.focusField(target);
}

function ExportDialog({ sessionId }: { sessionId: string }) {
  const plan = usePlan();
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const version = plan?.version ?? 0;

  useEffect(() => {
    body.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isComposing(e)) {
        e.stopPropagation();
        store.closeExport();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Rebuilt as the plan moves: what is copied is the plan as it is now.
  useEffect(() => {
    let live = true;
    api
      .exportPlan(sessionId)
      .then((res) => {
        if (!live) return;
        setShown(res);
        setError(null);
      })
      .catch((err: unknown) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [sessionId, version]);

  if (!plan) return null;
  const current = Boolean(shown && shown.version >= version);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Export the plan">
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={() => store.closeExport()} />
      <div className="lightbox-body is-text pv-viewer" ref={body} tabIndex={-1}>
        <header className="item-head">
          <h2 className="section-title">Export the plan</h2>
          <span className="muted">{plan.title}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={!shown} onClick={() => shown && void copy(shown.text)}>
            Copy
          </button>
          <button type="button" className="btn btn-sm" disabled={!shown} onClick={() => shown && download(plan.title, shown.text)}>
            Download .md
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => store.closeExport()}>
            ×
          </button>
        </header>
        <p className="muted pv-about">
          The whole plan as Markdown — summary, sections, diagrams, and the tasks with their briefs — with no build instructions,
          review modes or Coplan tools in it, to take into whatever builds it. Exporting signs nothing off and changes nothing
          here.
        </p>
        {error ? (
          <p className="error-text" role="alert">
            Could not export it: {error}
          </p>
        ) : (
          <div className={classNames(!current && 'is-stale')}>
            <PromptView blocks={shown?.blocks} text={shown?.text ?? 'Exporting…'} onField={showField} testId="export-text" />
          </div>
        )}
      </div>
    </div>
  );
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    store.toast('success', 'Copied the plan as Markdown.');
  } catch {
    store.toast('error', 'The browser would not let the page use the clipboard. Select the text and copy it instead, or download it.');
  }
}

/** The plan as a `.md` file, named after it. */
function download(title: string, text: string): void {
  try {
    const name = `${title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'plan'}.md`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch {
    store.toast('error', 'The browser would not save the file. Copy the text instead.');
  }
}
