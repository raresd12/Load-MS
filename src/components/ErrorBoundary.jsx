import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    // Track a boolean so even falsy thrown values (throw null) show the fallback.
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("[RPE Tracker] Uncaught render error:", error, errorInfo);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
        <div className="card w-full max-w-md p-5">
          <p className="label mb-0 text-bad">
            Something went wrong
          </p>
          <h1 className="mt-2 text-[22px] font-semibold text-text-1">The app hit an error</h1>
          <p className="mt-3 text-sm leading-6 text-text-2">
            Your training data is safe - it lives in this browser&apos;s storage and is not
            affected by this crash. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn btn-primary mt-4 w-full"
          >
            Reload App
          </button>
          <details className="card-inset mt-4 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-text-2">
              Technical details
            </summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-text-2">
              {String(this.state.error?.stack ?? this.state.error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
