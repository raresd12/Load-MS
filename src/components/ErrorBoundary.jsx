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
      <div className="flex min-h-screen items-center justify-center bg-[#111111] px-4 py-10">
        <div className="w-full max-w-md rounded-[8px] border border-zinc-800 bg-zinc-900 p-5">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-300">
            Something went wrong
          </p>
          <h1 className="mt-2 text-2xl font-black text-white">The app hit an error</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-400">
            Your training data is safe - it lives in this browser&apos;s storage and is not
            affected by this crash. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="focus-ring mt-4 flex min-h-12 w-full items-center justify-center rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
          >
            Reload App
          </button>
          <details className="mt-4 rounded-[8px] border border-zinc-800 bg-[#111111] px-3 py-2">
            <summary className="cursor-pointer text-xs font-black text-zinc-400">
              Technical details
            </summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-zinc-500">
              {String(this.state.error?.stack ?? this.state.error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
