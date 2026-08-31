import type { ReactNode } from 'react';
import { classNames } from '../lib/format.ts';

/** Small shared building blocks. Kept in one file so the visual vocabulary
 *  of the app is legible in a single screen of code. */

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  title,
  type = 'button',
  label,
  expanded,
  pressed,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'subtle';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  /** Overrides the accessible name when the visible text is not the whole
   *  story — a count appended to a label, say. */
  label?: string;
  /** Set on a button that shows and hides something; omitted otherwise, since
   *  `aria-expanded="false"` on a plain button is a lie. */
  expanded?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type={type}
      className={classNames('btn', `btn-${variant}`, size === 'sm' && 'btn-sm')}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-expanded={expanded}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}) {
  return <span className={classNames('badge', `badge-${tone}`)}>{children}</span>;
}

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={classNames('panel', className)}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h3 className="panel-title">{title}</h3>}
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {action}
    </div>
  );
}

/** An explanatory line that says what an action will actually do. Used
 *  wherever two similar-looking controls have very different consequences. */
export function Explain({ children }: { children: ReactNode }) {
  return <p className="explain">{children}</p>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="muted">{label}</span>}
    </span>
  );
}

export function StatChip({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <span className={classNames('stat-chip', tone && `tone-${tone}`)}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </span>
  );
}
