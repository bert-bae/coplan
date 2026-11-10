import { store, useStore } from '../store.ts';
import { classNames } from '../lib/format.ts';
import { copyText } from '../lib/copy.ts';

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
        <div key={toast.id} className={classNames('toast', `is-${toast.kind}`, toast.copy !== undefined && 'has-copy')}>
          <span>{toast.text}</span>
          {toast.copy !== undefined && (
            <>
              {/* Shown too, to select by hand where the clipboard is refused. */}
              <pre className="toast-copy">{toast.copy}</pre>
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  if (await copyText(toast.copy!, 'Copied.')) store.dismissToast(toast.id);
                }}
              >
                Copy text
              </button>
            </>
          )}
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
