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
      <div role="alert" className="card border border-warn/30">
        <p className="text-[15px] font-semibold text-warn">
          Could not load the {pageLabel} page
        </p>
        <p className="mt-1 text-sm leading-6 text-text-2">
          The app may be offline or a newer version was installed. Your training data is safe
          and the rest of the app keeps working. Try again, or reload the app if it keeps
          failing.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={this.handleRetry}
            className="btn btn-primary"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn btn-secondary"
          >
            Reload App
          </button>
        </div>
      </div>
    );
  }
}
