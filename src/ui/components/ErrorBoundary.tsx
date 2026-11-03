import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A view that throws takes only itself down.
 *
 * Without this, one bad render — a plan shape a view did not expect, a
 * library edge case on the canvas — unmounts the whole app and leaves a blank
 * page. The plan itself is safe on the daemon either way; this keeps the rest
 * of the page usable and offers a way back.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label: string; resetKey?: unknown },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[cc-harness] ${this.props.label} failed to render`, error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: unknown }): void {
    // Moving to another session or tab is a fresh start.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <p className="crash-title">The {this.props.label} could not be shown.</p>
        <p className="crash-detail">
          Your plan is saved — this is a display problem only. <code>{this.state.error.message}</code>
        </p>
        <div className="row-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
