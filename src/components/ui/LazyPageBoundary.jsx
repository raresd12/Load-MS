import { Component } from "react";
import { isLazyPageLoadError } from "../../lib/lazyPages.js";

/**
 * Decision H4-8: a lazy page whose chunk could not be loaded shows this inline
 * block in the page area; the navigation and the training path stay usable.
 * Only a failed chunk load is handled here. An error a page throws while it
 * renders is passed on to the app-level ErrorBoundary, as before.
 */
export default class LazyPageBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error) {
    if (isLazyPageLoadError(error)) {
      console.warn("[RPE Tracker] Page chunk failed to load:", error);
    }
  }

  handleRetry() {
    this.props.onRetry?.();
    this.setState({ hasError: false, error: null });
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (!isLazyPageLoadError(this.state.error)) {
      throw this.state.error;
    }

    const pageLabel = this.props.pageLabel ?? "This";

    return (
      <div role="alert" className="rounded-[8px] border border-amber-300/50 bg-amber-300/10 p-4">
        <p className="text-sm font-black text-amber-100">
          Could not load the {pageLabel} page
        </p>
        <p className="mt-1 text-xs font-semibold leading-5 text-amber-100/90">
          The app may be offline or a newer version was installed. Your training data is safe
          and the rest of the app keeps working. Try again, or reload the app if it keeps
          failing.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={this.handleRetry}
            className="focus-ring min-h-11 rounded-[8px] bg-amber-300 px-4 text-xs font-black text-zinc-950 hover:bg-amber-200"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="focus-ring min-h-11 rounded-[8px] border border-amber-300/50 px-4 text-xs font-black text-amber-100 hover:bg-amber-300/10"
          >
            Reload App
          </button>
        </div>
      </div>
    );
  }
}
