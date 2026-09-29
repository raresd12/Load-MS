// Lazy page registry (Phase H4, decisions H4-6 and H4-8). No React import: the
// `lazy` factory is injected so the retry behaviour has a Node fixture
// (scripts/verify-lazy-pages.mjs).
//
// React.lazy keeps a rejected load for the lifetime of the lazy component: it
// rethrows the stored error on every later render and never calls the loader
// again. A page whose chunk failed once (offline before the chunk was cached,
// a stale hash after another client updated the service worker) can therefore
// only recover with a NEW lazy component. The registry hands out one lazy
// component per page and replaces it after a failed load.
//
// The browser has the same memory: a module URL whose import failed stays
// failed in the module map of the document (measured in Chromium, also after
// the network came back), so importing the same URL again can never work. The
// failed URL is read from the error message the browser produced and the
// retry imports it with a `lazy-retry` query, which is a new module-map entry
// for the same file. Where the message carries no URL the loader is simply
// called again; "Reload App" is the recovery that always works.

const LAZY_PAGE_LOAD_ERROR = "LazyPageLoadError";

export function createLazyPageLoadError(pageId, cause) {
  const detail = String(cause?.message ?? cause ?? "").trim();
  const error = new Error(
    detail ? `Could not load the ${pageId} page. ${detail}` : `Could not load the ${pageId} page.`,
  );

  error.name = LAZY_PAGE_LOAD_ERROR;
  error.pageId = pageId;
  error.cause = cause;
  error.isLazyPageLoadError = true;

  return error;
}

export const LAZY_RETRY_PARAM = "lazy-retry";

/**
 * The module URL named by a failed dynamic import ("Failed to fetch
 * dynamically imported module: <url>", "error loading dynamically imported
 * module: <url>"), without an earlier retry marker. null when the message has
 * no URL, the URL is not http(s), or it is not on `origin` (when given).
 */
export function getFailedModuleUrl(error, origin) {
  const message = String(error?.message ?? error ?? "");
  const match = message.match(/dynamically imported module:?\s+(\S+)/i);

  if (!match) {
    return null;
  }

  let url;

  try {
    url = new URL(match[1]);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (origin && url.origin !== origin) {
    return null;
  }

  url.searchParams.delete(LAZY_RETRY_PARAM);
  url.hash = "";

  return url.href;
}

export function getRetryModuleUrl(moduleUrl, attempt) {
  const url = new URL(moduleUrl);
  url.searchParams.set(LAZY_RETRY_PARAM, String(attempt));

  return url.href;
}

/** True only for a failed chunk load, never for an error thrown by a page while it renders. */
export function isLazyPageLoadError(error) {
  return Boolean(error) && typeof error === "object" && error.isLazyPageLoadError === true;
}

/**
 * `loaders`: { pageId: () => import("./pages/X.jsx") }. `lazy`: React.lazy.
 * `importModule` (optional): (url) => import(url), used for the retry of a
 * URL the browser remembers as failed. `origin` (optional): only module URLs
 * of this origin are retried.
 *
 * - has(pageId): whether the page is a lazy page.
 * - load(pageId): the shared load promise (one fetch for a preload and the
 *   render); rejects with a LazyPageLoadError. A rejected promise is dropped,
 *   so the next load fetches again. null for an unknown page.
 * - prefetch(pageId): fire-and-forget load for hover / focus / touch / tab
 *   activation; never rejects and returns nothing.
 * - getComponent(pageId): the page's lazy component; a NEW one after a failed
 *   load, the same one otherwise (so a loaded page never remounts).
 * - retry(pageId): forget a failed load so the next getComponent / load starts
 *   over; returns true when something was reset.
 */
export function createLazyPages({ loaders, lazy, importModule, origin }) {
  if (typeof lazy !== "function") {
    throw new TypeError("createLazyPages needs React.lazy.");
  }

  const entries = new Map();
  const pageLoaders = { ...loaders };

  function has(pageId) {
    return typeof pageLoaders[pageId] === "function";
  }

  function getEntry(pageId) {
    let entry = entries.get(pageId);

    if (!entry) {
      entry = { promise: null, component: null, failed: false, failures: 0, failedUrl: null };
      entries.set(pageId, entry);
    }

    return entry;
  }

  function load(pageId) {
    if (!has(pageId)) {
      return null;
    }

    const entry = getEntry(pageId);

    if (!entry.promise) {
      let request;

      try {
        request = Promise.resolve(
          entry.failedUrl && typeof importModule === "function"
            ? importModule(getRetryModuleUrl(entry.failedUrl, entry.failures))
            : pageLoaders[pageId](),
        );
      } catch (error) {
        request = Promise.reject(error);
      }

      const promise = request.then(
        (module) => module,
        (error) => {
          if (entry.promise === promise) {
            entry.promise = null;
          }

          entry.failures += 1;
          entry.failedUrl = getFailedModuleUrl(error, origin) ?? entry.failedUrl;

          throw createLazyPageLoadError(pageId, error);
        },
      );

      entry.promise = promise;
    }

    return entry.promise;
  }

  function prefetch(pageId) {
    const promise = load(pageId);

    if (promise) {
      promise.catch(() => {});
    }
  }

  function getComponent(pageId) {
    if (!has(pageId)) {
      return null;
    }

    const entry = getEntry(pageId);

    if (!entry.component || entry.failed) {
      entry.failed = false;
      const component = lazy(() =>
        load(pageId).catch((error) => {
          if (entry.component === component) {
            entry.failed = true;
          }

          throw error;
        }),
      );
      entry.component = component;
    }

    return entry.component;
  }

  function retry(pageId) {
    const entry = entries.get(pageId);

    if (!entry || !entry.failed) {
      return false;
    }

    entry.component = null;
    entry.failed = false;

    return true;
  }

  return { has, load, prefetch, getComponent, retry };
}
