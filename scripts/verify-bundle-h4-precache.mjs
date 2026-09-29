import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectBundleReport, projectRoot, readPrecachedUrls, runViteBuild } from "./report-bundle.mjs";

// Phase H4 / Track B, decision H4-5: the production build is split into
// vendor-react, vendor-icons and the app chunk(s), and the service worker
// precaches every emitted JS/CSS chunk plus index.html so an installed PWA
// still launches offline (handoff 19.1 "Offline"). The build goes to a
// temporary directory outside the project so a concurrent `npm run build`
// into dist/ is never disturbed and nothing is left behind.

const outDir = mkdtempSync(path.join(tmpdir(), "load-ms-h4-precache-"));

try {
  const status = runViteBuild(outDir, ["--emptyOutDir", "--logLevel", "warn"]);
  assert.equal(status, 0, "vite build succeeds");

  const indexHtml = path.join(outDir, "index.html");
  assert.ok(existsSync(indexHtml), "index.html emitted");
  assert.ok(existsSync(path.join(outDir, "sw.js")), "service worker emitted");

  const assets = readdirSync(path.join(outDir, "assets"));
  const jsAssets = assets.filter((name) => name.endsWith(".js"));
  const cssAssets = assets.filter((name) => name.endsWith(".css"));
  assert.ok(jsAssets.length >= 3, `expected at least app + 2 vendor chunks, got ${jsAssets.join(", ")}`);
  assert.ok(cssAssets.length >= 1, "a CSS asset is emitted");

  const vendorReact = jsAssets.find((name) => name.startsWith("vendor-react-"));
  const vendorIcons = jsAssets.find((name) => name.startsWith("vendor-icons-"));
  const appChunk = jsAssets.find((name) => name.startsWith("index-"));
  assert.ok(vendorReact, "vendor-react chunk emitted");
  assert.ok(vendorIcons, "vendor-icons chunk emitted");
  assert.ok(appChunk, "app entry chunk emitted");

  // The framework lives in vendor-react only; the app chunk does not carry
  // a second copy and the icon chunk holds lucide only.
  const readAsset = (name) => readFileSync(path.join(outDir, "assets", name), "utf8");
  // React 19 tags its elements with this symbol description; the minifier
  // keeps string literals, so it identifies the framework in a chunk.
  const reactMarker = "react.transitional.element";
  const iconsMarker = "lucide";
  assert.ok(readAsset(vendorReact).includes(reactMarker), "vendor-react holds React");
  assert.ok(!readAsset(appChunk).includes(reactMarker), "the app chunk does not bundle React");
  assert.ok(!readAsset(vendorIcons).includes(reactMarker), "vendor-icons does not bundle React");
  assert.ok(readAsset(vendorIcons).includes(iconsMarker), "vendor-icons holds lucide-react");
  assert.ok(!readAsset(appChunk).includes(iconsMarker), "the app chunk does not bundle lucide-react");

  // index.html loads the vendor chunks as modulepreload so the split does not
  // add a request waterfall on cold start.
  const html = readFileSync(indexHtml, "utf8");
  assert.ok(html.includes(`assets/${appChunk}`), "index.html references the app chunk");
  assert.ok(html.includes(`assets/${vendorReact}`), "index.html preloads vendor-react");

  // Every JS / CSS asset and index.html are in the precache manifest.
  const precached = readPrecachedUrls(outDir);
  assert.ok(Array.isArray(precached) && precached.length > 0, "precache manifest parsed");
  const precachedSet = new Set(precached.map((url) => url.replace(/^\.?\//, "")));

  for (const name of [...jsAssets, ...cssAssets]) {
    assert.ok(precachedSet.has(`assets/${name}`), `${name} is precached`);
  }

  assert.ok(precachedSet.has("index.html"), "index.html is precached");
  assert.ok(precachedSet.has("manifest.webmanifest"), "web manifest is precached");

  // Report the measured sizes for the record.
  const report = collectBundleReport(outDir);
  const appRow = report.chunks.find((row) => row.file === `assets/${appChunk}`);
  const vendorReactRow = report.chunks.find((row) => row.file === `assets/${vendorReact}`);
  assert.ok(appRow && vendorReactRow);
  assert.ok(vendorReactRow.raw > 100 * 1024, "vendor-react is a real framework chunk (> 100 kB)");

  // Decision H4-11: the chunk-size warning is a working growth guard. Vite
  // counts kB as 1000 bytes. No chunk is over the limit, and the limit is at
  // most 15 % above the largest chunk, so real growth warns.
  const viteConfig = readFileSync(path.join(projectRoot, "vite.config.js"), "utf8");
  const limitMatch = viteConfig.match(/chunkSizeWarningLimit:\s*(\d+)/);
  assert.ok(limitMatch, "vite.config.js sets chunkSizeWarningLimit");
  const limitBytes = Number(limitMatch[1]) * 1000;
  const jsRows = report.chunks.filter((row) => row.file.endsWith(".js"));
  const largest = jsRows[0];
  for (const row of jsRows) {
    assert.ok(row.raw <= limitBytes, `${row.file} (${row.raw} B) is under the ${limitMatch[1]} kB warning limit`);
  }
  assert.ok(
    limitBytes <= largest.raw * 1.15,
    `chunkSizeWarningLimit ${limitMatch[1]} kB is within 15 % of the largest chunk ${largest.file} (${largest.raw} B); lower it`,
  );

  console.log(
    `Bundle H4 precache verification passed (${jsAssets.length} JS chunks, ${precached.length} precached entries, app ${(appRow.raw / 1024).toFixed(1)} kB raw / ${(appRow.gzip / 1024).toFixed(1)} kB gzip).`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
