import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { projectRoot, readPrecachedUrls, runViteBuild } from "./report-bundle.mjs";

// Phase H4 / UI track, decision H4-6: with the React.lazy boundaries the build
// emits one chunk per administration page. The service worker must precache
// EVERY dist/assets file and index.html so an installed PWA launches offline
// and can open the Program / Progress / History / Library / Settings tabs
// without a network (handoff 19.1 "Offline"), and the startup HTML must not
// preload the lazy chunks (they would be back in the startup transfer).
//
// H4 fix round 1: always builds the CURRENT source into a temporary directory
// outside the project (never reads dist/, which is gitignored, not rebuilt by
// `npm test` and can be stale) and removes it afterwards.

const tempDir = mkdtempSync(path.join(tmpdir(), "load-ms-h4-ui-pwa-"));
const outDir = tempDir;
{
  const status = runViteBuild(outDir, ["--emptyOutDir", "--logLevel", "warn"]);
  assert.equal(status, 0, "vite build succeeds");
}

try {
  const assets = readdirSync(path.join(outDir, "assets"));
  const precached = readPrecachedUrls(outDir);
  assert.ok(Array.isArray(precached) && precached.length > 0, "precache manifest parsed from sw.js");
  const precachedSet = new Set(precached.map((url) => url.replace(/^\.?\//, "")));

  // Every emitted asset (JS, CSS, and anything else under assets/) is precached.
  for (const name of assets) {
    assert.ok(precachedSet.has(`assets/${name}`), `assets/${name} is precached`);
  }
  assert.ok(precachedSet.has("index.html"), "index.html is precached");
  assert.ok(precachedSet.has("manifest.webmanifest"), "manifest.webmanifest is precached");

  // Nothing in the precache list points at a file that does not exist.
  for (const url of precachedSet) {
    assert.ok(existsSync(path.join(outDir, url)), `precached ${url} exists in the build`);
  }

  // One chunk per lazy page, all precached, none preloaded by index.html.
  const html = readFileSync(path.join(outDir, "index.html"), "utf8");
  const jsAssets = assets.filter((name) => name.endsWith(".js"));
  for (const page of ["ProgramPage", "ProgressPage", "HistoryPage", "LibraryPage", "SettingsPage"]) {
    const chunk = jsAssets.find((name) => name.startsWith(`${page}-`));
    assert.ok(chunk, `${page} has its own chunk (${jsAssets.join(", ")})`);
    assert.ok(precachedSet.has(`assets/${chunk}`), `${chunk} is precached for offline use`);
    assert.ok(!html.includes(`assets/${chunk}`), `${chunk} is not part of the startup HTML`);
  }

  // The training path stays in the entry chunk (no chunk named after it).
  for (const page of ["DashboardPage", "ReadinessPage", "WorkoutsPage", "WorkoutLogPage"]) {
    assert.ok(!jsAssets.some((name) => name.startsWith(`${page}-`)), `${page} is not split out of the startup chunk`);
  }

  // The build under test is the fresh temporary one, never the project's dist/.
  assert.ok(!outDir.startsWith(path.join(projectRoot, "dist")), "the checked build is not dist/");

  // Decision H4-8: a lazy chunk retried with ?lazy-retry=<n> is answered by
  // the precache like the plain URL (offline retry after the precache filled).
  const sw = readFileSync(path.join(outDir, "sw.js"), "utf8");
  assert.ok(/ignoreURLParametersMatching:\s*\[[^\]]*\/\^lazy-retry\$\//.test(sw), "sw.js ignores the lazy-retry parameter when matching the precache");

  // Offline launch (handoff 19.1 "Offline", H4 fix round 3): the precache only
  // answers requests for the files themselves. A navigation to the app URL
  // ("./", "/?source=pwa", a start_url the OS launches) is answered offline
  // only because the worker registers a NavigationRoute bound to the
  // precached index.html (workbox `navigateFallback`). Without it npm test
  // stayed green while an installed PWA opened to the browser's offline page.
  const navigationRoutes = sw.match(/registerRoute\(\s*new\s+[\w$.]*NavigationRoute\(/g) ?? [];
  assert.equal(navigationRoutes.length, 1, "sw.js registers exactly one NavigationRoute");
  assert.ok(
    /registerRoute\(\s*new\s+[\w$.]*NavigationRoute\(\s*[\w$.]*createHandlerBoundToURL\(\s*["']index\.html["']\s*\)\s*\)\s*\)/.test(sw),
    "the NavigationRoute serves the precached index.html for every navigation (no allowlist / denylist)",
  );
  const indexEntry = sw.match(/\{url:"index\.html",revision:("[0-9a-f]+"|null)\}/);
  assert.ok(indexEntry, "index.html is a precache entry of sw.js");
  assert.notEqual(indexEntry[1], "null", "index.html is precached with a content revision, so a release replaces it");
  assert.ok(
    sw.indexOf("precacheAndRoute(") !== -1 && sw.indexOf("precacheAndRoute(") < sw.indexOf("NavigationRoute("),
    "the precache is set up before the navigation route that reads from it",
  );
  // The worker's own runtime is a separate file next to sw.js; it must be in the build.
  const runtime = sw.match(/["']\.\/(workbox-[0-9a-f]+)(?:\.js)?["']/);
  assert.ok(runtime, "sw.js names its workbox runtime");
  assert.ok(existsSync(path.join(outDir, `${runtime[1]}.js`)), `${runtime[1]}.js is emitted next to sw.js`);
  // The prompt flow (H2-16) is kept: the worker never activates by itself.
  assert.ok(!/\.skipWaiting\(\)\s*,\s*[\w$.]*clientsClaim\(\)/.test(sw.replace(/addEventListener\("message"[\s\S]*?\}\)\)/, "")), "no unconditional skipWaiting + clientsClaim");
  assert.ok(/addEventListener\("message"[\s\S]{0,120}SKIP_WAITING/.test(sw), "skipWaiting only answers the banner's SKIP_WAITING message");
  const viteConfig = readFileSync(path.join(projectRoot, "vite.config.js"), "utf8");
  assert.ok(/navigateFallback:\s*"index\.html"/.test(viteConfig), "vite.config.js keeps workbox navigateFallback index.html");
  assert.ok(!/navigateFallbackDenylist|navigateFallbackAllowlist/.test(viteConfig), "no navigation is excluded from the offline fallback");
  const manifest = JSON.parse(readFileSync(path.join(outDir, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.start_url, "./", "the installed app launches the scope root (a navigation the route answers)");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");

  const entry = jsAssets.find((name) => name.startsWith("index-"));
  assert.ok(entry && html.includes(`assets/${entry}`), "index.html loads the entry chunk");

  console.log(
    `UI H4 PWA verification passed (${assets.length} assets, ${precachedSet.size} precached entries, navigation fallback index.html, fresh temporary build).`,
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
