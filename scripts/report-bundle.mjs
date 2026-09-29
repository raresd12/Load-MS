// Builds the app (unless --no-build) and prints the size of every emitted
// asset, raw and gzip (node:zlib, level 9), plus the total and the service
// worker precache count. Usage:
//   npm run build:report            build into dist/ then report
//   node scripts/report-bundle.mjs --no-build [--dist <dir>]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Runs `vite build --outDir <outDir>`; returns the child's exit status. */
export function runViteBuild(outDir, extraArgs = []) {
  const vite = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  const build = spawnSync(process.execPath, [vite, "build", "--outDir", outDir, ...extraArgs], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  return build.status ?? 1;
}

export function collectBundleReport(dir) {
  const assetsDir = path.join(dir, "assets");
  const files = existsSync(assetsDir)
    ? readdirSync(assetsDir)
        .filter((name) => statSync(path.join(assetsDir, name)).isFile())
        .map((name) => path.join("assets", name))
    : [];
  const rootFiles = ["index.html", "sw.js", "manifest.webmanifest"].filter((name) =>
    existsSync(path.join(dir, name)),
  );
  const rows = [...files, ...rootFiles].map((relative) => {
    const buffer = readFileSync(path.join(dir, relative));

    return {
      file: relative.replace(/\\/g, "/"),
      raw: buffer.length,
      gzip: gzipSync(buffer, { level: 9 }).length,
    };
  });
  const isChunk = (row) => row.file.startsWith("assets/") && /\.(js|css)$/.test(row.file);
  const chunks = rows.filter(isChunk).sort((left, right) => right.raw - left.raw);
  const total = chunks.reduce(
    (sum, row) => ({ raw: sum.raw + row.raw, gzip: sum.gzip + row.gzip }),
    { raw: 0, gzip: 0 },
  );

  return { rows, chunks, total };
}

export function readPrecachedUrls(dir) {
  const swPath = path.join(dir, "sw.js");

  if (!existsSync(swPath)) {
    return null;
  }

  const source = readFileSync(swPath, "utf8");
  const urls = [];

  for (const match of source.matchAll(/["']?url["']?\s*:\s*"([^"]+)"/g)) {
    urls.push(match[1]);
  }

  return urls;
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1).padStart(8)} kB`;
}

function main() {
  const args = process.argv.slice(2);
  const noBuild = args.includes("--no-build");
  const distFlag = args.indexOf("--dist");
  const distDir = path.resolve(projectRoot, distFlag >= 0 ? args[distFlag + 1] : "dist");

  if (!noBuild) {
    const status = runViteBuild(distDir);

    if (status !== 0) {
      process.exit(status);
    }
  }

  const report = collectBundleReport(distDir);
  const precached = readPrecachedUrls(distDir);

  console.log(`\nBundle report for ${path.relative(projectRoot, distDir) || "."}\n`);
  console.log(`${"chunk".padEnd(44)}${"raw".padStart(12)}${"gzip".padStart(12)}`);

  for (const row of report.chunks) {
    console.log(`${row.file.padEnd(44)}${formatKb(row.raw)}${formatKb(row.gzip)}`);
  }

  console.log(
    `${"TOTAL (assets/*.js + *.css)".padEnd(44)}${formatKb(report.total.raw)}${formatKb(report.total.gzip)}`,
  );

  for (const row of report.rows.filter((candidate) => !report.chunks.includes(candidate))) {
    console.log(`${row.file.padEnd(44)}${formatKb(row.raw)}${formatKb(row.gzip)}`);
  }

  if (precached) {
    console.log(`\nService worker precache: ${precached.length} entries`);
  }
}

// Only the CLI runs the build and prints; verify-bundle-h4-precache.mjs
// imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
