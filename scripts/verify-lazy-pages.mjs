// H4 fix round 1, decision H4-8: a lazy page whose chunk failed to load can be
// loaded again in the same session. Runs the real React.lazy of the project
// (React keeps a rejection on the lazy component forever, so the registry has
// to hand out a new component) against src/lib/lazyPages.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lazy } from "react";

import {
  LAZY_RETRY_PARAM,
  createLazyPageLoadError,
  createLazyPages,
  getFailedModuleUrl,
  getRetryModuleUrl,
  isLazyPageLoadError,
} from "../src/lib/lazyPages.js";

// What React does when it renders a lazy component: call the initializer; it
// throws the pending thenable (suspend), throws the stored error (rejected) or
// returns the default export of the module (resolved).
async function renderLazy(component) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return { status: "rendered", value: component._init(component._payload) };
    } catch (thrown) {
      if (thrown && typeof thrown.then === "function") {
        await thrown.then(
          () => {},
          () => {},
        );
        continue;
      }

      return { status: "threw", error: thrown };
    }
  }

  throw new Error("lazy component did not settle");
}

function createLoaders(plan) {
  const calls = {};
  const loaders = {};

  for (const [pageId, outcomes] of Object.entries(plan)) {
    calls[pageId] = 0;
    loaders[pageId] = () => {
      const outcome = outcomes[Math.min(calls[pageId], outcomes.length - 1)];
      calls[pageId] += 1;

      return outcome === "fail"
        ? Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
        : Promise.resolve({ default: function Page() {}, pageId, outcome });
    };
  }

  return { calls, loaders };
}

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// The defect, pinned on React itself: a rejected lazy component never recovers
// ---------------------------------------------------------------------------
{
  let calls = 0;
  const Broken = lazy(() => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("chunk fetch failed"))
      : Promise.resolve({ default: () => null });
  });
  assert.equal((await renderLazy(Broken)).status, "threw");
  assert.equal((await renderLazy(Broken)).status, "threw", "React.lazy rethrows the stored rejection");
  assert.equal(calls, 1, "React.lazy never calls the loader again");
}

// ---------------------------------------------------------------------------
// Failed load -> inline error -> retry renders the page
// ---------------------------------------------------------------------------
{
  const { calls, loaders } = createLoaders({ history: ["fail", "ok"], program: ["ok"] });
  const pages = createLazyPages({ lazy, loaders });

  assert.equal(pages.has("history"), true);
  assert.equal(pages.has("dashboard"), false, "eager pages are not in the registry");
  assert.equal(pages.getComponent("dashboard"), null);
  assert.equal(pages.load("dashboard"), null);
  assert.equal(pages.prefetch("dashboard"), undefined);
  assert.equal(pages.prefetch("more"), undefined);

  const First = pages.getComponent("history");
  assert.equal(pages.getComponent("history"), First, "the same component while nothing failed");
  assert.equal(calls.history, 0, "nothing is fetched before a render or a preload");

  const failed = await renderLazy(First);
  assert.equal(failed.status, "threw");
  assert.equal(isLazyPageLoadError(failed.error), true, "the boundary can tell a chunk failure apart");
  assert.equal(failed.error.pageId, "history");
  assert.match(failed.error.message, /Could not load the history page\. Failed to fetch/);
  assert.equal(failed.error.cause instanceof TypeError, true);
  assert.equal(calls.history, 1);
  assert.equal((await renderLazy(First)).status, "threw", "the failed component stays failed (React)");
  assert.equal(calls.history, 1);

  // "Try again": the registry forgets the failure, the shell renders again.
  assert.equal(pages.retry("history"), true);
  assert.equal(pages.retry("history"), false, "nothing left to reset");
  const Second = pages.getComponent("history");
  assert.notEqual(Second, First, "a failed page gets a new lazy component");
  const rendered = await renderLazy(Second);
  assert.equal(rendered.status, "rendered");
  assert.equal(typeof rendered.value, "function");
  assert.equal(calls.history, 2, "the chunk was requested again");
  assert.equal(pages.getComponent("history"), Second, "a loaded page keeps its component (no remount)");
  assert.equal((await renderLazy(Second)).status, "rendered");
  assert.equal(calls.history, 2);
  assert.equal(pages.retry("history"), false, "a loaded page is never reset");
  assert.equal(pages.getComponent("history"), Second);

  // Another page is unaffected.
  assert.equal((await renderLazy(pages.getComponent("program"))).status, "rendered");
  assert.equal(calls.program, 1);
}

// ---------------------------------------------------------------------------
// Without an explicit retry: leaving the tab and opening it again recovers
// ---------------------------------------------------------------------------
{
  const { calls, loaders } = createLoaders({ settings: ["fail", "fail", "ok"] });
  const pages = createLazyPages({ lazy, loaders });

  const first = pages.getComponent("settings");
  assert.equal((await renderLazy(first)).status, "threw");
  const second = pages.getComponent("settings");
  assert.notEqual(second, first);
  assert.equal((await renderLazy(second)).status, "threw", "still offline");
  const third = pages.getComponent("settings");
  assert.notEqual(third, second);
  assert.equal((await renderLazy(third)).status, "rendered");
  assert.equal(calls.settings, 3);
}

// ---------------------------------------------------------------------------
// Prefetch: shared with the render, never an unhandled rejection
// ---------------------------------------------------------------------------
{
  const { calls, loaders } = createLoaders({ library: ["fail", "ok"], progress: ["ok"] });
  const pages = createLazyPages({ lazy, loaders });

  assert.equal(pages.prefetch("library"), undefined, "prefetch returns nothing to catch");
  pages.prefetch("library");
  assert.equal(calls.library, 1, "two prefetches share one request");
  await tick();
  await tick();
  assert.deepEqual(unhandled, [], "a failed prefetch is not an unhandled rejection");

  // The failed prefetch is forgotten: opening the page fetches again and works.
  const Library = pages.getComponent("library");
  assert.equal((await renderLazy(Library)).status, "rendered");
  assert.equal(calls.library, 2);

  // A successful prefetch and the render share one request.
  pages.prefetch("progress");
  assert.equal((await renderLazy(pages.getComponent("progress"))).status, "rendered");
  pages.prefetch("progress");
  assert.equal(calls.progress, 1);

  // load() is the rejecting variant for callers that want the outcome.
  const failing = createLazyPages({
    lazy,
    loaders: { history: () => Promise.reject(new Error("offline")) },
  });
  await assert.rejects(
    failing.load("history"),
    (error) => isLazyPageLoadError(error) && error.pageId === "history",
  );
  const throwing = createLazyPages({
    lazy,
    loaders: {
      history: () => {
        throw new Error("sync failure");
      },
    },
  });
  await assert.rejects(throwing.load("history"), /Could not load the history page\. sync failure/);
  throwing.prefetch("history");
}

// ---------------------------------------------------------------------------
// The browser remembers a failed module URL: the retry imports the same file
// under a new module-map entry (measured in Chromium: import(url) keeps
// failing after the file is back, import(url + "?lazy-retry=1") loads it)
// ---------------------------------------------------------------------------
{
  const origin = "http://127.0.0.1:4187";
  const chunkUrl = `${origin}/assets/HistoryPage-D-0oqvYH.js`;
  const remembered = new Set();
  let online = false;
  const imported = [];
  // A module map like the browser's: a URL that failed once fails forever.
  const browserImport = (url) => {
    imported.push(url);
    if (remembered.has(url) || !online) {
      remembered.add(url);
      return Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${url}`));
    }
    return Promise.resolve({ default: function HistoryPage() {}, url });
  };
  const pages = createLazyPages({
    lazy,
    origin,
    importModule: browserImport,
    loaders: { history: () => browserImport(chunkUrl) },
  });

  assert.equal((await renderLazy(pages.getComponent("history"))).status, "threw", "offline: the chunk fails");
  assert.equal((await renderLazy(pages.getComponent("history"))).status, "threw", "still offline: the retry fails too");
  assert.deepEqual(imported, [chunkUrl, `${chunkUrl}?lazy-retry=1`]);

  online = true;
  await assert.rejects(browserImport(chunkUrl), /Failed to fetch/, "the plain URL stays failed in the module map");
  await assert.rejects(browserImport(`${chunkUrl}?lazy-retry=1`), /Failed to fetch/);
  imported.length = 0;
  const rendered = await renderLazy(pages.getComponent("history"));
  assert.equal(rendered.status, "rendered", "Try again loads the page once the network is back");
  assert.deepEqual(imported, [`${chunkUrl}?lazy-retry=2`], "a new retry marker per attempt, never stacked");

  // URL parsing: browser wordings, earlier markers removed, foreign origins refused.
  assert.equal(getFailedModuleUrl(new TypeError(`Failed to fetch dynamically imported module: ${chunkUrl}`), origin), chunkUrl);
  assert.equal(getFailedModuleUrl(new TypeError(`error loading dynamically imported module: ${chunkUrl}`), origin), chunkUrl);
  assert.equal(
    getFailedModuleUrl(new TypeError(`Failed to fetch dynamically imported module: ${chunkUrl}?lazy-retry=3`), origin),
    chunkUrl,
  );
  assert.equal(
    getFailedModuleUrl(new TypeError(`Failed to fetch dynamically imported module: ${origin}/src/pages/HistoryPage.jsx?t=17`), origin),
    `${origin}/src/pages/HistoryPage.jsx?t=17`,
    "other query parameters (dev server) are kept",
  );
  assert.equal(getFailedModuleUrl(new TypeError("Importing a module script failed."), origin), null, "no URL in the message");
  assert.equal(getFailedModuleUrl(new TypeError("Failed to fetch dynamically imported module: https://evil.example/x.js"), origin), null);
  assert.equal(getFailedModuleUrl(new TypeError("Failed to fetch dynamically imported module: javascript:alert(1)")), null);
  assert.equal(getFailedModuleUrl(new TypeError("Failed to fetch dynamically imported module: not a url"), origin), null);
  assert.equal(getFailedModuleUrl(null, origin), null);
  assert.equal(getRetryModuleUrl(chunkUrl, 2), `${chunkUrl}?lazy-retry=2`);
  assert.equal(getRetryModuleUrl(`${chunkUrl}?t=1&lazy-retry=1`, 2), `${chunkUrl}?t=1&lazy-retry=2`);
  assert.equal(LAZY_RETRY_PARAM, "lazy-retry");

  // A foreign URL in the message is never imported: the loader is used again.
  const foreignCalls = [];
  let loaderCalls = 0;
  const guarded = createLazyPages({
    lazy,
    origin,
    importModule: (url) => {
      foreignCalls.push(url);
      return Promise.resolve({ default: () => null });
    },
    loaders: {
      history: () => {
        loaderCalls += 1;
        return loaderCalls === 1
          ? Promise.reject(new TypeError("Failed to fetch dynamically imported module: https://evil.example/x.js"))
          : Promise.resolve({ default: () => null });
      },
    },
  });
  assert.equal((await renderLazy(guarded.getComponent("history"))).status, "threw");
  assert.equal((await renderLazy(guarded.getComponent("history"))).status, "rendered");
  assert.deepEqual(foreignCalls, []);
  assert.equal(loaderCalls, 2);
}

// ---------------------------------------------------------------------------
// Only chunk failures are handled inline
// ---------------------------------------------------------------------------
{
  assert.equal(isLazyPageLoadError(createLazyPageLoadError("program", new Error("x"))), true);
  assert.equal(createLazyPageLoadError("program").message, "Could not load the program page.");
  assert.equal(isLazyPageLoadError(new Error("render crash")), false);
  assert.equal(isLazyPageLoadError(new TypeError("x is not a function")), false);
  assert.equal(isLazyPageLoadError(null), false);
  assert.equal(isLazyPageLoadError(undefined), false);
  assert.equal(isLazyPageLoadError("text"), false);
  assert.throws(() => createLazyPages({ loaders: {} }), /React\.lazy/);
}

// ---------------------------------------------------------------------------
// Wiring: every lazy page sits in its own boundary, prefetch is fire-and-forget
// ---------------------------------------------------------------------------
{
  const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
  const app = read("src/App.jsx");
  const boundary = read("src/components/ui/LazyPageBoundary.jsx");

  for (const [page, pageId] of [
    ["Program", "program"],
    ["Progress", "progress"],
    ["History", "history"],
    ["Library", "library"],
    ["Settings", "settings"],
  ]) {
    assert.ok(
      new RegExp(
        `<LazyPageBoundary pageLabel="${page}" onRetry=\\{\\(\\) => retryLazyPage\\("${pageId}"\\)\\}>\\s*` +
          `<Suspense fallback=\\{<PageLoadingFallback />\\}>\\s*<${page}Page[\\s/>]`,
      ).test(app),
      `${page} renders inside its own LazyPageBoundary + Suspense`,
    );
    assert.ok(
      app.includes(`const ${page}Page = lazyPages.getComponent("${pageId}");`),
      `${page}Page is read from the registry on every render`,
    );
  }

  assert.ok(!/=\s*lazy\(/.test(app), "no module-level React.lazy component (it could never recover)");
  assert.ok(/function preloadTab\(tabId\) \{\s*lazyPages\.prefetch\(tabId\);\s*\}/.test(app), "preloadTab is the fire-and-forget prefetch");
  assert.ok(app.includes("importModule: (url) => import(/* @vite-ignore */ url),"), "the shell provides the retry import");
  assert.ok(app.includes("origin: typeof window !== \"undefined\" ? window.location.origin : undefined,"), "retries are limited to the app origin");
  assert.ok(!/lazyPages\.load\(/.test(app), "the shell never holds a promise that can reject");
  assert.ok(/function retryLazyPage\(pageId\) \{\s*lazyPages\.retry\(pageId\);\s*setLazyPageRetryCount\(/.test(app), "Try again resets the page and re-renders the shell");

  assert.ok(boundary.includes("isLazyPageLoadError(this.state.error)"), "the boundary checks the error kind");
  assert.ok(/if \(!isLazyPageLoadError\(this\.state\.error\)\) \{\s*throw this\.state\.error;/.test(boundary), "a render error of a page still reaches the app-level ErrorBoundary");
  assert.ok(boundary.includes("this.props.onRetry?.()"), "Try again calls the shell");
  assert.ok(boundary.includes("window.location.reload()"), "Reload App stays available for a stale build");
  assert.ok(!/fixed|inset-0|min-h-screen|h-screen/.test(boundary), "the error block is inline, never full-screen");
}

await tick();
await tick();
assert.deepEqual(unhandled, [], "no unhandled rejection anywhere in the registry");

console.log("Lazy pages verification passed.");
