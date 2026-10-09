import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { projectRoot, runViteBuild } from "./report-bundle.mjs";

// Phase H6 (decisions H6-1, H6-11, H6-24): the client bundle never carries
// the server. `src/` does not import `server/`, so no emitted chunk may hold
// node:sqlite, the API factory, the password hashing or a server path. The
// sync API address comes from .env.production through one module, so it
// appears in exactly one chunk, and the development address never ships.
// The build goes to a temporary directory, like verify-bundle-h4-precache.

const PRODUCTION_URL = readFileSync(path.join(projectRoot, ".env.production"), "utf8")
  .split(/\r?\n/)
  .find((line) => line.startsWith("VITE_SYNC_API_URL="))
  ?.slice("VITE_SYNC_API_URL=".length)
  .trim();
const DEVELOPMENT_URL = readFileSync(path.join(projectRoot, ".env.development"), "utf8")
  .split(/\r?\n/)
  .find((line) => line.startsWith("VITE_SYNC_API_URL="))
  ?.slice("VITE_SYNC_API_URL=".length)
  .trim();

assert.match(PRODUCTION_URL ?? "", /^https:\/\//, ".env.production sets an https sync API address");
assert.ok(DEVELOPMENT_URL, ".env.development sets the local sync API address");

// Phase H6 fix round 3 (decisions H6-11, H6-49): no API secret ships to the
// browser. Every env file Vite reads holds no VITE_ variable besides the sync
// address (only VITE_ variables reach the bundle), the client reads no other
// one, and no emitted file carries a server setting name or the env example's
// placeholder invite code.
const ENV_FILES = readdirSync(projectRoot).filter((name) => /^\.env(\..+)?$/.test(name));
assert.ok(ENV_FILES.includes(".env.production") && ENV_FILES.includes(".env.development"));
for (const name of ENV_FILES) {
  const lines = readFileSync(path.join(projectRoot, name), "utf8").split(/\r?\n/);
  const viteNames = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^export\s+/, "").split("=")[0].trim())
    .filter((key) => key.startsWith("VITE_"));
  for (const key of viteNames) {
    assert.equal(key, "VITE_SYNC_API_URL", `${name}: ${key} would ship to the browser; only VITE_SYNC_API_URL may`);
  }
  assert.ok(!lines.some((line) => /^\s*(export\s+)?LOADMS_/.test(line)), `${name} holds no server setting`);
}

const SOURCE_ENV_READS = [];
const walkSource = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSource(full);
    } else if (/\.(js|jsx|mjs)$/.test(entry.name)) {
      const code = readFileSync(full, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
      for (const match of code.matchAll(/import\.meta\.env\??\.([A-Z_][A-Z0-9_]*)/g)) {
        SOURCE_ENV_READS.push(`${path.relative(projectRoot, full).split(path.sep).join("/")}:${match[1]}`);
      }
    }
  }
};
walkSource(path.join(projectRoot, "src"));
assert.deepEqual(
  SOURCE_ENV_READS,
  ["src/components/account/syncController.js:VITE_SYNC_API_URL"],
  "the client reads exactly one env variable, the sync address, in one module",
);

const envExample = readFileSync(path.join(projectRoot, "deploy", "api.env.example"), "utf8");
const exampleInvite = envExample.match(/^LOADMS_SIGNUP_CODE=(.+)$/m)?.[1]?.trim();
assert.ok(exampleInvite, "the env example still names the placeholder invite code");
const SECRET_MARKERS = [
  "LOADMS_",
  "SIGNUP_CODE",
  "replace-with",
  exampleInvite,
  "/etc/loadms",
  "api.env",
];
if (existsSync(path.join(projectRoot, ".data"))) {
  SECRET_MARKERS.push("loadms-dev.db");
}

const SERVER_MARKERS = [
  "node:sqlite",
  "node:http",
  "node:crypto",
  "DatabaseSync",
  "createApi",
  "scrypt",
  "server/app",
  "server/db",
  "server/index",
  "server/",
  "CREATE TABLE",
  "password_hash",
];

const outDir = mkdtempSync(path.join(tmpdir(), "load-ms-h6-no-server-"));

try {
  const status = runViteBuild(outDir, ["--emptyOutDir", "--logLevel", "warn"]);
  assert.equal(status, 0, "vite build succeeds");

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|mjs|css|html|webmanifest|json)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(outDir);
  const chunks = files.filter((file) => /\.m?js$/.test(file) && !/[\\/](sw|workbox-[^\\/]+)\.js$/.test(file));
  assert.ok(chunks.length >= 3, `client chunks emitted: ${chunks.length}`);

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const name = path.relative(outDir, file);
    for (const marker of SERVER_MARKERS) {
      assert.ok(!text.includes(marker), `${name} must not contain the server marker "${marker}"`);
    }
    assert.ok(!text.includes(DEVELOPMENT_URL), `${name} must not contain the development sync address`);
    for (const marker of SECRET_MARKERS) {
      assert.ok(!text.includes(marker), `${name} must not contain the server secret marker "${marker}"`);
    }
  }

  const withUrl = chunks.filter((file) => readFileSync(file, "utf8").includes(PRODUCTION_URL));
  assert.equal(
    withUrl.length,
    1,
    `the production sync address appears in exactly one chunk (found in ${withUrl.map((file) => path.basename(file)).join(", ") || "none"})`,
  );
  assert.ok(!path.basename(withUrl[0]).startsWith("index-"), "the sync client is not in the entry chunk; guests never load it");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log("Bundle H6 no-server verification passed.");
