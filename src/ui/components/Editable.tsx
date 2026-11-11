import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Markdown } from './Markdown.tsx';
import { useKeptDraft } from '../lib/drafts.ts';
import { useSessionId } from '../store.ts';
import { classNames } from '../lib/format.ts';
import { isComposing } from '../lib/keys.ts';

/**
 * Edit-in-place. Everything in the plan is editable where it is shown,
 * because the point of the page is that the reader reshapes it — a separate
 * edit screen would make every small correction a context switch.
 *
 * Both fields share one contract: Enter (or ⌘/Ctrl+Enter for prose) saves,
 * Escape abandons, and losing focus saves — the same as renaming a file.
 * Refused because the text changed underneath, it stays open showing what
 * is there now, and only Enter saves over it.
 */

export function InlineText({
  value,
  onSave,
  label,
  placeholder = 'Untitled',
  className,
  as: Tag = 'span',
  readOnly = false,
  version,
}: {
  value: string;
  /** Resolves false when the save was refused; the field then reopens with
   *  the text intact, so nothing typed is lost. */
  onSave: (next: string, version: number | undefined, was: string) => void | Promise<unknown>;
  /** Accessible name for both the display and the input. */
  label: string;
  placeholder?: string;
  className?: string;
  as?: 'span' | 'h1' | 'h2' | 'h3';
  /** Shown, not editable: the plan is locked. */
  readOnly?: boolean;
  /** The item's revision, captured when editing starts and handed back on
   *  save, so a save over someone else's newer change is refused. The text
   *  editing started from is handed back too (`was`). */
  version?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Refused as changed underneath: saved over that only by Enter, never by
  // leaving the field (a click anywhere would undo what the refusal was about).
  const [refused, setRefused] = useState(false);
  const done = useRef(false);
  const startedAt = useRef<number | undefined>(version);
  const latest = useRef<number | undefined>(version);
  latest.current = version;
  const startedFrom = useRef(value);
  const shown = useRef(value);
  shown.current = value;
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** Finished from the keyboard: the keyboard stays on the text. */
  const refocus = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) input.current?.select();
    else if (refocus.current) {
      refocus.current = false;
      trigger.current?.focus();
    }
  }, [editing]);

  const start = () => {
    done.current = false;
    startedAt.current = version;
    startedFrom.current = value;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setRefused(false);
    setEditing(false);
    const next = draft.trim();
    if (!next || next === value) return;
    void Promise.resolve(onSave(next, startedAt.current, startedFrom.current)).then((result) => {
      if (result !== false) return;
      // Refused (most likely changed underneath): reopen with the text, on
      // the revision now on screen, so a deliberate second save goes in.
      done.current = false;
      startedAt.current = latest.current;
      // Changed underneath (not a failure of some other kind): what is there
      // now is shown, and only Enter saves over it.
      setRefused(shown.current !== startedFrom.current);
      startedFrom.current = shown.current;
      setDraft(next);
      setEditing(true);
    });
  };
  const abandon = () => {
    done.current = true;
    setRefused(false);
    setEditing(false);
    setDraft(value);
  };

  if (readOnly) return <Tag className={classNames('inline-text', 'is-readonly', !value && 'is-empty', className)}>{value || placeholder}</Tag>;

  if (editing) {
    const field = (
      <input
        ref={input}
        className={classNames('inline-input', className)}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={refused ? undefined : commit}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            refocus.current = true;
            commit();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            refocus.current = true;
            abandon();
          }
        }}
      />
    );
    if (!refused) return field;
    return (
      <>
        {field}
        <span className="inline-now muted" role="status">
          Now: {value || '(empty)'}. Enter saves yours over it; Escape keeps it.
        </span>
      </>
    );
  }

  return (
    <Tag className={classNames('inline-text', !value && 'is-empty', className)}>
      <button ref={trigger} type="button" className="inline-trigger" onClick={start} title="Click to edit" aria-label={`${label}: ${value || placeholder}. Edit`}>
        {value || placeholder}
      </button>
    </Tag>
  );
}

export function MarkdownField({
  value,
  onSave,
  label,
  placeholder = 'Nothing written yet.',
  emptyAction = 'Add detail',
  rows = 6,
  className,
  startEditing = false,
  onCancel,
  version,
  draftKey,
}: {
  value: string;
  /** Names the field (`summary`, `task:t3:detail`): an editor left open
   *  keeps its text, in this session, when it unmounts, and reopens with it. */
  draftKey?: string;
  /** Resolves false when the save was refused; the editor then stays open
   *  with the text intact, so nothing typed is lost. */
  onSave: (next: string, version: number | undefined) => void | Promise<unknown>;
  label: string;
  placeholder?: string;
  emptyAction?: string;
  rows?: number;
  className?: string;
  startEditing?: boolean;
  onCancel?: () => void;
  /** The item's revision. Captured when editing starts and handed back on
   *  save, so a save over someone else's newer change is refused. */
  version?: number;
}) {
  // A draft left open here (a tab or session switch unmounted it) reopens.
  const { editing, draft, setDraft, started, saving, begin, close, save: keep } = useKeptDraft(useSessionId(), draftKey ?? null, value, version, startEditing);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);

  // What editing started from: a field with a revision is watched by it; one
  // with none (the summary, a box's notes, a caption) by its text, and its
  // save is not refused (there is nothing to check it against): the warning
  // below is all it gets. Showing the user's own text already (their save,
  // landing) is nothing to lose, whatever moved.
  const changedUnderneath =
    editing && value !== draft && (started.version !== undefined ? version !== started.version : value !== started.value);

  // With the "changed while you were editing" warning on screen, saving is
  // a deliberate choice to replace the newer version, so it is made against
  // that version. Otherwise it is made against the one edited.
  const save = () => keep(() => onSave(draft, changedUnderneath ? version : started.version));
  const cancel = () => {
    close();
    onCancel?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
    }
  };
  if (editing) {
    return (
      <div className={classNames('md-field is-editing', className)}>
        <textarea
          ref={area}
          className="input md-input"
          value={draft}
          rows={Math.max(rows, Math.min(24, draft.split('\n').length + 1))}
          aria-label={label}
          placeholder="Markdown: **bold**, `code`, - lists, ## headings"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {changedUnderneath && (
          <p className="md-conflict" role="alert">
            This changed while you were editing. Saving now replaces the newer version with your text — copy anything
            you want to keep from it first.
          </p>
        )}
        <div className="md-field-foot">
          <span className="muted">Markdown · ⌘/Ctrl+Enter to save · Esc to cancel</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  if (!value.trim()) {
    return (
      <div className={classNames('md-field is-empty', className)}>
        <button type="button" className="md-empty" onClick={begin} aria-label={`${emptyAction}: ${label}`}>
          <span className="muted">{placeholder}</span> <span className="link">{emptyAction}</span>
        </button>
      </div>
    );
  }

  return (
    <div className={classNames('md-field', className)}>
      <Markdown source={value} />
      <button type="button" className="md-edit icon-btn is-tiny" title={`Edit ${label}`} aria-label={`Edit ${label}`} onClick={begin}>
        <span aria-hidden="true">✎</span>
      </button>
    </div>
  );
}

/** A one-shot input that adds something and clears itself. */
export function AddField({
  placeholder,
  label,
  onAdd,
  autoFocus,
  onCancel,
  children,
}: {
  placeholder: string;
  label: string;
  onAdd: (value: string) => Promise<boolean> | boolean | void;
  autoFocus?: boolean;
  onCancel?: () => void;
  children?: ReactNode;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      className="add-field"
      onSubmit={async (e) => {
        e.preventDefault();
        const next = value.trim();
        if (!next) return;
        const ok = await onAdd(next);
        if (ok !== false) setValue('');
      }}
    >
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opened on request
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Escape that drops an input method's choice is its own (lib/keys.ts).
          if (isComposing(e)) return;
          if (e.key === 'Escape' && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!value.trim()) onCancel?.();
        }}
      />
      {children}
      <button type="submit" className="btn btn-sm" disabled={!value.trim()}>
        Add
      </button>
    </form>
  );
}
