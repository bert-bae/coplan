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
}: {
  value: string;
  onSave: (next: string) => void | Promise<unknown>;
  /** Accessible name for both the display and the input. */
  label: string;
  placeholder?: string;
  className?: string;
  as?: 'span' | 'h1' | 'h2' | 'h3';
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
}: {
  value: string;
  onSave: (next: string) => void | Promise<unknown>;
  label: string;
  placeholder?: string;
  emptyAction?: string;
  rows?: number;
  className?: string;
  startEditing?: boolean;
  onCancel?: () => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(value);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);

  const save = () => {
    setEditing(false);
    if (draft !== value) void onSave(draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(value);
    onCancel?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
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
        <div className="md-field-foot">
          <span className="muted">Markdown · ⌘/Ctrl+Enter to save · Esc to cancel</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    );
  }

  if (!value.trim()) {
    return (
      <div className={classNames('md-field is-empty', className)}>
        <button type="button" className="md-empty" onClick={() => setEditing(true)} aria-label={`${emptyAction}: ${label}`}>
          <span className="muted">{placeholder}</span> <span className="link">{emptyAction}</span>
        </button>
      </div>
    );
  }

  return (
    <div className={classNames('md-field', className)}>
      <Markdown source={value} />
      <button type="button" className="md-edit icon-btn is-tiny" title={`Edit ${label}`} aria-label={`Edit ${label}`} onClick={() => setEditing(true)}>
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
