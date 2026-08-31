import { store, useStore } from '../store.ts';
import { classNames } from '../lib/format.ts';

/** Confirmation that an action landed. The old UI gave none, so submitting a
 *  review looked identical to losing it. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);

  // Mounted even when empty. A live region that appears at the same instant
  // as its first message is routinely missed: assistive tech announces
  // changes to regions it was already watching.
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={classNames('toast', `is-${toast.kind}`)}>
          <span>{toast.text}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => store.dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
