'use client';

/**
 * Generic React error boundary (rescan-4 L8 / batch 7w).
 *
 * Before this existed, a render error anywhere in a mounted tree
 * propagated to Next's root `error.tsx`, which tore the entire page
 * down. Wrapping islands like <FloatingCart>, <ChatWidget>, or the
 * cart-page body in a boundary lets the rest of the page survive a
 * single subtree crash.
 *
 * Notes:
 *  - This is a class component because React's error-catching
 *    lifecycle methods (`getDerivedStateFromError`,
 *    `componentDidCatch`) only exist on class components.
 *  - The fallback defaults to a small inline error message but can
 *    be overridden via the `fallback` prop. When `fallback` is a
 *    function, it receives the captured error + a reset callback.
 *  - We log to the browser console (visible in error tracking) but
 *    intentionally do not call into our `@/lib/logger` here — boundaries
 *    can fire during early hydration and the logger has its own
 *    transitive deps we'd rather not pull into this path.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?:
    | ReactNode
    | ((error: Error, reset: () => void) => ReactNode);
  /** Label for the error log to identify which island crashed. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const label = this.props.label ?? "ErrorBoundary";
    // eslint-disable-next-line no-console
    console.error(`[${label}] render error caught:`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const { fallback } = this.props;
    if (typeof fallback === "function") {
      return fallback(error, this.reset);
    }
    if (fallback !== undefined) {
      return fallback;
    }

    // Default inline fallback — small, non-disruptive, encourages
    // reload but keeps the rest of the page intact.
    return (
      <div
        role="alert"
        className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      >
        <p className="font-medium">Something went wrong in this section.</p>
        <p className="text-xs text-red-700/80">
          The rest of the page is still working.{" "}
          <button
            type="button"
            onClick={this.reset}
            className="underline underline-offset-2 hover:text-red-900"
          >
            Try again
          </button>
          .
        </p>
      </div>
    );
  }
}

export default ErrorBoundary;
