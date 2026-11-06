import { useEffect, useRef } from 'react';

/** ⌘ on a Mac, Ctrl everywhere else — said the way the keyboard says it. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';
export const ALT = MOD === '⌘' ? '⌥' : 'Alt+';

/** Every shortcut on the canvas, in one place: the overlay lists these, and
 *  menus quote them. */
export const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  {
    group: 'Add',
    keys: [
      ['Double-click or right-click empty canvas', 'a box there'],
      ['Tab', 'a box after the selected one, connected'],
      ['⇧Tab', 'a box before it, connected'],
      ['Enter', 'a box beside it, from the same boxes'],
      ['Drag from a box’s edge into space', 'a connected box there'],
    ],
  },
  {
    group: 'Connect',
    keys: [
      ['Drag from a box’s edge onto a box', 'connect them'],
      ['Drag an arrow’s end grip', 'move that end to another box'],
      ['Drop an unconnected box on an arrow', 'put it into the arrow'],
    ],
  },
  {
    group: 'Edit',
    keys: [
      ['Type on a selected box', 'rename it'],
      ['F2 or double-click', 'rename a box or an arrow'],
      [`${MOD}C  ${MOD}X  ${MOD}V`, 'copy, cut, paste'],
      [`${MOD}D`, 'duplicate'],
      ['⌫', 'delete'],
      [`${ALT}⌫`, 'delete, keeping the flow through it'],
      [`${MOD}Z  ⇧${MOD}Z`, 'undo, redo'],
      ['Right-click, or ⇧F10', 'everything you can do to it'],
    ],
  },
  {
    group: 'Tasks',
    keys: [
      ['Click a box’s ☐ chip, or Tab to it', 'the tasks that build it: add, rename, unlink, brief'],
      [`${ALT}Enter`, 'the selected box’s tasks'],
      ['Esc', 'close them, back on the chip'],
    ],
  },
  {
    group: 'Select and move',
    keys: [
      ['Click / ⇧-drag', 'select one / select an area'],
      [`${MOD}A`, 'select everything'],
      ['Arrow keys', 'nudge the selection'],
      ['Hover or select a box', 'see what it connects to'],
      [ALT === '⌥' ? 'Hold ⌥' : 'Hold Alt', 'see two steps out'],
      ['Esc', 'clear the selection'],
    ],
  },
  {
    group: 'View',
    keys: [
      ['⇧1', 'fit the whole diagram'],
      ['⇧2', 'zoom to the selection'],
      ['Space-drag', 'pan'],
      ['F6', 'move between the canvas and its details'],
      ['?', 'these shortcuts'],
    ],
  },
];

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus?.();
  }, []);
  return (
    <div
      className="flow-shortcuts-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="flow-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <header className="flow-shortcuts-head">
          <h2>Shortcuts</h2>
          <button type="button" className="icon-btn is-tiny" aria-label="Close shortcuts" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="flow-shortcuts-groups">
          {SHORTCUTS.map((g) => (
            <section key={g.group}>
              <h3>{g.group}</h3>
              <dl>
                {g.keys.map(([keys, what]) => (
                  <div key={keys} className="flow-shortcut">
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
