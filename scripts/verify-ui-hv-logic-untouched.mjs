import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Visual refresh, decision HV-8: the refresh is presentation only. Compared
// with main (git; HV_BASE_REF overrides the base for a demonstration run):
// - no file under src/lib changes, except the nine tone class literals of
//   src/lib/sessionAnalytics.js (the only Tailwind classes in src/lib);
// - the only existing fixtures that change are the four the refresh owns, and
//   two of them only in the lines it owns (verify-session-analytics.mjs: the
//   tone class assertion; verify-ui-h4-structure.mjs: the contrast floor
//   section, its helper import and the focus ring colour line);
// - src/App.jsx and every page export the same names;
// - no .jsx file loses an onClick / onChange / onSubmit handler.
// Skipped with a message only when git or the base ref is unavailable.
// Phase H6 (accounts and sync) changes src/lib on purpose: its library files
// and the two storage fixtures it extends are listed below (decision H6-42),
// and every other src/lib file is still held to HV-8.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_LIB_CHANGES = new Set(["src/lib/sessionAnalytics.js"]);
const H6_LIB_CHANGES = new Set([
  "src/lib/programStorage.js",
  "src/lib/repository.js",
  "src/lib/storage.js",
]);
const H6_NEW_LIB_FILES = new Set([
  "src/lib/accountView.js",
  "src/lib/syncApi.js",
  "src/lib/syncEngine.js",
  "src/lib/syncRecords.js",
  "src/lib/syncSeeds.js",
]);
const H6_FIXTURE_CHANGES = new Set([
  "scripts/verify-storage-h4-restore-events.mjs",
  "scripts/verify-storage-h4-secrets.mjs",
  "scripts/verify-ui-hv-logic-untouched.mjs",
  "scripts/verify-ui-hv-review-fixes.mjs",
]);
const isAllowedLibChange = ({ file, status }) =>
  (status === "M" && (ALLOWED_LIB_CHANGES.has(file) || H6_LIB_CHANGES.has(file))) ||
  ((status === "A" || status === "?") && H6_NEW_LIB_FILES.has(file));
const ALLOWED_FIXTURE_CHANGES = new Set([
  "scripts/verify-ui-h3-wiring.mjs",
  "scripts/verify-ui-h3-library-strip.mjs",
  "scripts/verify-ui-h4-structure.mjs",
  "scripts/verify-session-analytics.mjs",
]);
const TONE_LINE = /toneClass|^\s*(good|steady|caution|neutral): "/;
const CONTRAST_SECTION = /\/\/ Contrast floor[\s\S]*?(?=\/\/ Icon-only buttons)/;

const normalise = (text) => text.replace(/\r\n/g, "\n");

/** Lines of `text` that do not match `pattern`, joined (line endings normalised). */
function withoutLines(text, pattern) {
  return normalise(text)
    .split("\n")
    .filter((line) => !pattern.test(line))
    .join("\n");
}

/** Exported names of a module: declarations, `export default Name`, `export { a, b as c }`. */
function exportNames(code) {
  const names = new Set();
  for (const match of code.matchAll(/export\s+(default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1] ? `default:${match[2]}` : match[2]);
  }
  for (const match of code.matchAll(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/g)) {
    names.add(`default:${match[1]}`);
  }
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** Number of JSX onClick / onChange / onSubmit attributes. */
function handlerCount(code) {
  return (code.match(/(?<![\w$.])on(?:Click|Change|Submit)\s*=/g) ?? []).length;
}

// Self-tests.
assert.equal(isAllowedLibChange({ file: "src/lib/syncEngine.js", status: "?" }), true);
assert.equal(isAllowedLibChange({ file: "src/lib/progression.js", status: "M" }), false, "the engine stays under HV-8");
assert.equal(isAllowedLibChange({ file: "src/lib/storage.js", status: "D" }), false);
assert.deepEqual(exportNames("export default function App() {}\nexport const A = 1;\nexport { b as c, d };\nexport async function e() {}"), [
  "A",
  "c",
  "d",
  "default:App",
  "e",
]);
assert.deepEqual(exportNames("function P() {}\nexport default P;"), ["default:P"]);
assert.equal(handlerCount('<a onClick={x} onChange={y} /><form onSubmit={z}> props.onClick = 1; onClickCapture={q}'), 3);
assert.equal(withoutLines('a\n    good: "x",\n  toneClass: "y",\nb', TONE_LINE), "a\nb");

function git(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const probe = git(["--version"]);
if (probe.error || probe.status !== 0) {
  console.log("UI HV logic-untouched verification SKIPPED: git is not available.");
  process.exit(0);
}
const candidates = process.env.HV_BASE_REF ? [process.env.HV_BASE_REF] : ["main", "origin/main"];
const base = candidates.find((ref) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0);
if (!base) {
  console.log(`UI HV logic-untouched verification SKIPPED: no base ref (${candidates.join(", ")}) in this checkout.`);
  process.exit(0);
}
const show = (file) => {
  const result = git(["show", `${base}:${file}`]);
  assert.equal(result.status, 0, `git show ${base}:${file} (${result.stderr.trim()})`);
  return normalise(result.stdout);
};
const readWorking = (file) => normalise(readFileSync(path.join(root, file), "utf8"));

// ------------------------------------------------------------------
// src/lib and the existing fixtures
// ------------------------------------------------------------------
const diff = git(["diff", "--name-status", "--no-renames", base, "--", "src/lib", "scripts/verify-*.mjs"]);
assert.equal(diff.status, 0, `git diff against ${base} (${diff.stderr.trim()})`);
const changes = diff.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [status, file] = line.split("\t");
    return { status, file };
  });
const untrackedLib = git(["ls-files", "--others", "--exclude-standard", "--", "src/lib"]).stdout.split(/\r?\n/).filter(Boolean);
const libViolations = [
  ...changes.filter(({ file, status }) => file.startsWith("src/lib/") && !isAllowedLibChange({ file, status })),
  ...untrackedLib.map((file) => ({ status: "?", file })).filter((change) => !isAllowedLibChange(change)),
].map(({ status, file }) => `${status} ${file}`);
assert.deepEqual(libViolations, [], `src/lib changed versus ${base} (presentation-only phase): ${libViolations.join(", ")}`);

const fixtureViolations = changes
  .filter(({ file, status }) => file.startsWith("scripts/") && status !== "A" && !ALLOWED_FIXTURE_CHANGES.has(file) && !H6_FIXTURE_CHANGES.has(file))
  .map(({ status, file }) => `${status} ${file}`);
assert.deepEqual(fixtureViolations, [], `existing fixtures changed versus ${base} outside the HV-8 list: ${fixtureViolations.join(", ")}`);

// First line where two texts differ, or null when they are equal.
function firstDifference(after, before) {
  if (after === before) {
    return null;
  }
  const a = after.split("\n");
  const b = before.split("\n");
  let index = 0;
  while (index < Math.max(a.length, b.length) && a[index] === b[index]) {
    index += 1;
  }
  return `line ${index + 1} of the compared text: now ${JSON.stringify(a[index] ?? "<end>")}, ${base} ${JSON.stringify(b[index] ?? "<end>")}`;
}
const assertSame = (after, before, message) => {
  const difference = firstDifference(after, before);
  assert.equal(difference, null, `${message} (${difference})`);
};

const changed = new Set(changes.map(({ file }) => file));
if (changed.has("src/lib/sessionAnalytics.js")) {
  assertSame(
    withoutLines(readWorking("src/lib/sessionAnalytics.js"), TONE_LINE),
    withoutLines(show("src/lib/sessionAnalytics.js"), TONE_LINE),
    "src/lib/sessionAnalytics.js changes only its tone class lines",
  );
  const toneValues = [...readWorking("src/lib/sessionAnalytics.js").matchAll(/(?:toneClass|good|steady|caution|neutral): "([^"]*)"/g)].map((match) => match[1]);
  for (const value of toneValues) {
    assert.match(value, /^tone-(?:good|steady|caution|neutral)$/, `sessionAnalytics.js tone literals are the tone-* component classes (found "${value}")`);
  }
}
if (changed.has("scripts/verify-session-analytics.mjs")) {
  assertSame(
    withoutLines(readWorking("scripts/verify-session-analytics.mjs"), /toneClass/),
    withoutLines(show("scripts/verify-session-analytics.mjs"), /toneClass/),
    "verify-session-analytics.mjs changes only its tone class assertion",
  );
}
if (changed.has("scripts/verify-ui-h4-structure.mjs")) {
  const strip = (text) => {
    assert.ok(CONTRAST_SECTION.test(text), "verify-ui-h4-structure.mjs keeps a '// Contrast floor' section before '// Icon-only buttons'");
    const rest = text.replace(CONTRAST_SECTION, "").replace(/\nimport \{[^}]*\} from "\.\/lib\/contrast\.mjs";/, "");
    return withoutLines(rest, /:focus-visible ring/);
  };
  assertSame(
    strip(readWorking("scripts/verify-ui-h4-structure.mjs")),
    strip(show("scripts/verify-ui-h4-structure.mjs")),
    "verify-ui-h4-structure.mjs changes only its contrast floor section, the contrast helper import and the focus ring colour line",
  );
}

// ------------------------------------------------------------------
// Exports of the shell and the pages; event handlers per file
// ------------------------------------------------------------------
const listed = git(["ls-tree", "-r", "--name-only", base, "--", "src"]);
assert.equal(listed.status, 0, `git ls-tree ${base} src`);
const baseFiles = listed.stdout.split(/\r?\n/).filter(Boolean);
const shellAndPages = baseFiles.filter((file) => file === "src/App.jsx" || /^src\/pages\/[^/]+\.jsx$/.test(file));
assert.ok(shellAndPages.length > 5, `${base} lists App.jsx and the pages`);
for (const file of shellAndPages) {
  assert.ok(existsSync(path.join(root, file)), `${file} still exists`);
  assert.deepEqual(exportNames(readWorking(file)), exportNames(show(file)), `${file} exports the same names as ${base}`);
}
const fewerHandlers = [];
let handlerTotal = 0;
for (const file of baseFiles.filter((name) => name.endsWith(".jsx"))) {
  const before = handlerCount(show(file));
  if (!before) {
    continue;
  }
  assert.ok(existsSync(path.join(root, file)), `${file} (with ${before} handlers on ${base}) still exists`);
  const after = handlerCount(readWorking(file));
  handlerTotal += after;
  if (after < before) {
    fewerHandlers.push(`${file}: ${before} -> ${after}`);
  }
}
assert.deepEqual(fewerHandlers, [], `onClick / onChange / onSubmit handlers lost versus ${base}: ${fewerHandlers.join("; ")}`);

console.log(
  `UI HV logic-untouched verification passed (base ${base}; ${changes.length} changed lib / fixture files checked, ${shellAndPages.length} shell and page modules, ${handlerTotal} handlers).`,
);
