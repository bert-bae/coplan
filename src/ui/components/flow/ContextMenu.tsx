import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { classNames } from '../../lib/format.ts';

/**
 * The right-click menu on the canvas.
 *
 * One component for every menu — empty canvas, a box, an arrow, a selection
 * — fed a list of entries by the editor. It opens at the pointer (or at the
 * selected box, from the keyboard), stays inside the canvas, and is a real
 * menu to the keyboard: arrows move, Enter chooses, Escape closes or steps
 * back out of a sub-list.
 */

export type MenuEntry =
  | { kind: 'item'; label: string; hint?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: 'check'; label: string; checked: boolean; onSelect: () => void }
  | { kind: 'heading'; label: string }
  | { kind: 'separator' }
  /** A row of small choices — box kinds, arrowheads — chosen in one click. */
  | { kind: 'choices'; label: string; options: MenuChoice[]; onSelect: (value: string) => void }
  /** A longer list shown in place of the menu, with a way back. */
  | { kind: 'submenu'; label: string; hint?: string; entries: MenuEntry[] };

export interface MenuChoice {
  value: string;
  label: string;
  content: ReactNode;
  className?: string;
  active?: boolean;
}

export function ContextMenu({
  at,
  title,
  entries,
  onClose,
}: {
  /** Where it opens, relative to the canvas's top-left corner. */
  at: { x: number; y: number };
  title: string;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [stack, setStack] = useState<{ title: string; entries: MenuEntry[] }[]>([]);
  const [place, setPlace] = useState(at);
  const view = stack.at(-1) ?? { title, entries };

  // Keep the whole menu on the canvas: open up or left when there is no room.
  useLayoutEffect(() => {
    const el = menu.current;
    const frame = el?.parentElement?.getBoundingClientRect();
    if (!el || !frame) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPlace({
      x: Math.max(4, at.x + w > frame.width - 4 ? at.x - w : at.x),
      y: Math.max(4, at.y + h > frame.height - 4 ? Math.max(4, frame.height - h - 4) : at.y),
    });
  }, [at.x, at.y, stack.length]);

  // Focus the first choice when the menu, or a sub-list, opens.
  useEffect(() => {
    items(menu.current)[0]?.focus();
  }, [stack.length]);

  // A press anywhere else closes it.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const list = items(menu.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(list.length - 1);
    } else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && stack.length)) {
      e.preventDefault();
      if (stack.length) setStack((s) => s.slice(0, -1));
      else onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      go(at + (e.shiftKey ? -1 : 1));
    }
  };

  const choose = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <div
      ref={menu}
      className="flow-menu nodrag nopan nowheel"
      role="menu"
      aria-label={view.title}
      style={{ left: place.x, top: place.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flow-menu-title">
        {stack.length > 0 && (
          <button type="button" role="menuitem" className="flow-menu-back" aria-label="Back" onClick={() => setStack((s) => s.slice(0, -1))}>
            ‹
          </button>
        )}
        <span>{view.title}</span>
      </div>
      {view.entries.map((entry, i) => {
        switch (entry.kind) {
          case 'separator':
            return <div key={i} className="flow-menu-sep" role="separator" />;
          case 'heading':
            return (
              <div key={i} className="flow-menu-heading" role="presentation">
                {entry.label}
              </div>
            );
          case 'item':
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={classNames('flow-menu-item', entry.danger && 'is-danger')}
                disabled={entry.disabled}
                onClick={() => choose(entry.onSelect)}
              >
                <span className="flow-menu-label">{entry.label}</span>
                {entry.hint && <kbd className="flow-menu-hint">{entry.hint}</kbd>}
              </button>
            );
          case 'check':
            return (
              <button key={i} type="button" role="menuitemcheckbox" aria-checked={entry.checked} className="flow-menu-item" onClick={() => choose(entry.onSelect)}>
                <span className="flow-menu-check" aria-hidden="true">
                  {entry.checked ? '✓' : ''}
                </span>
                <span className="flow-menu-label">{entry.label}</span>
              </button>
            );
          case 'choices':
            return (
              <div key={i} className="flow-menu-choices" role="group" aria-label={entry.label}>
                <span className="flow-menu-heading">{entry.label}</span>
                <div className="flow-menu-choice-row">
                  {entry.options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={Boolean(o.active)}
                      aria-label={o.label}
                      title={o.label}
                      className={classNames('flow-menu-choice', o.className, o.active && 'is-active')}
                      onClick={() => choose(() => entry.onSelect(o.value))}
                    >
                      {o.content}
                    </button>
                  ))}
                </div>
              </div>
            );
          case 'submenu':
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                className="flow-menu-item"
                onClick={() => setStack((s) => [...s, { title: entry.label, entries: entry.entries }])}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    setStack((s) => [...s, { title: entry.label, entries: entry.entries }]);
                  }
                }}
              >
                <span className="flow-menu-label">{entry.label}</span>
                {entry.hint && <kbd className="flow-menu-hint">{entry.hint}</kbd>}
                <span className="flow-menu-more" aria-hidden="true">
                  ›
                </span>
              </button>
            );
        }
      })}
    </div>
  );
}

/** The menu's choices, top to bottom. Sorted explicitly: not every selector
 *  engine returns a selector list's matches in document order. */
function items(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"], [role="menuitemcheckbox"]')].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}
