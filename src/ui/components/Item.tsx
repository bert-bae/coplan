import { useEffect, useRef, useState, type ReactNode } from 'react';
import { store, useStore } from '../store.ts';
import { scrollBehavior } from '../lib/motion.ts';
import { classNames } from '../lib/format.ts';

/**
 * A plan item that can be jumped to from elsewhere — the activity log, a
 * question's linked task. When it is the focus target it scrolls into view
 * and flashes once, so the reader's eye lands on it.
 */
export function Focusable({
  kind,
  id,
  className,
  children,
  as: Tag = 'section',
}: {
  kind: string;
  id: string;
  className?: string;
  children: ReactNode;
  as?: 'section' | 'article' | 'div';
}) {
  const focusTarget = useStore((s) => s.focusTarget);
  const ref = useRef<HTMLElement>(null);
  const [flash, setFlash] = useState(false);
  const mine = focusTarget === `${kind}:${id}`;

  useEffect(() => {
    if (!mine) return;
    ref.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'center' });
    setFlash(true);
    const timer = window.setTimeout(() => {
      setFlash(false);
      store.set({ focusTarget: null });
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [mine]);

  return (
    <Tag ref={ref as never} id={`${kind}-${id}`} className={classNames(className, flash && 'is-flash')}>
      {children}
    </Tag>
  );
}

/** Up / down / remove, for anything that lives in an ordered list. Remove
 *  asks once, inline, rather than with a dialog. */
export function ItemActions({
  label,
  index,
  count,
  onMove,
  onRemove,
}: {
  label: string;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="item-confirm">
        Remove?
        <button type="button" className="link is-danger" onClick={onRemove}>
          Remove
        </button>
        <button type="button" className="link" onClick={() => setConfirming(false)}>
          Keep
        </button>
      </span>
    );
  }
  return (
    <span className="item-actions">
      <button
        type="button"
        className="icon-btn is-tiny"
        disabled={index === 0}
        title="Move up"
        aria-label={`Move ${label} up`}
        onClick={() => onMove(index - 1)}
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        className="icon-btn is-tiny"
        disabled={index >= count - 1}
        title="Move down"
        aria-label={`Move ${label} down`}
        onClick={() => onMove(index + 1)}
      >
        <span aria-hidden="true">↓</span>
      </button>
      <button type="button" className="icon-btn is-tiny is-danger" title="Remove" aria-label={`Remove ${label}`} onClick={() => setConfirming(true)}>
        <span aria-hidden="true">×</span>
      </button>
    </span>
  );
}
