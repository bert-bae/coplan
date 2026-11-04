import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Markdown } from './Markdown.tsx';
import { classNames } from '../lib/format.ts';

/**
 * Edit-in-place. Everything in the plan is editable where it is shown,
 * because the point of the page is that the reader reshapes it — a separate
 * edit screen would make every small correction a context switch.
 *
 * Both fields share one contract: Enter (or ⌘/Ctrl+Enter for prose) saves,
 * Escape abandons, and losing focus saves — the same as renaming a file.
 */

export function InlineText({
  value,
  onSave,
  label,
  placeholder = 'Untitled',
  className,
  as: Tag = 'span',
  readOnly = false,
}: {
  value: string;
  onSave: (next: string) => void | Promise<unknown>;
  /** Accessible name for both the display and the input. */
  label: string;
  placeholder?: string;
  className?: string;
  as?: 'span' | 'h1' | 'h2' | 'h3';
  /** Shown, not editable: the plan is locked. */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const start = () => {
    done.current = false;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) void onSave(next);
  };
  const abandon = () => {
    done.current = true;
    setEditing(false);
    setDraft(value);
  };

  if (readOnly) return <Tag className={classNames('inline-text', 'is-readonly', !value && 'is-empty', className)}>{value || placeholder}</Tag>;

  if (editing) {
    return (
      <input
        ref={input}
        className={classNames('inline-input', className)}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            abandon();
          }
        }}
      />
    );
  }

  return (
    <Tag className={classNames('inline-text', !value && 'is-empty', className)}>
      <button type="button" className="inline-trigger" onClick={start} title="Click to edit" aria-label={`${label}: ${value || placeholder}. Edit`}>
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
}: {
  value: string;
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
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const startedAt = useRef<number | undefined>(version);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);

  const begin = () => {
    startedAt.current = version;
    setEditing(true);
  };
  const changedUnderneath = editing && version !== undefined && startedAt.current !== undefined && version !== startedAt.current;

  const save = async () => {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    // With the "changed while you were editing" warning on screen, saving is
    // a deliberate choice to replace the newer version, so it is made
    // against that version. Otherwise it is made against the one edited.
    const base = changedUnderneath ? version : startedAt.current;
    const result = await onSave(draft, base);
    setSaving(false);
    if (result === false) {
      // Refused — most likely changed underneath. Keep the text, and start
      // from the revision now on screen so a deliberate second save goes in.
      startedAt.current = version;
      return;
    }
    setEditing(false);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(value);
    onCancel?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
