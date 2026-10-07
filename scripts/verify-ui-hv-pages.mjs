import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Visual refresh, decisions HV-9 and HV-10: every page is restyled with the
// Track A component classes, and the copy stays exactly as it was.
// - every src/pages/*.jsx uses `card` and `label` (or `label-accent`);
// - no raw palette colour utility or arbitrary colour value in the shell, the
//   pages or the workout components (the full sweep is
//   verify-ui-hv-no-legacy-colors.mjs; this keeps the page track honest even
//   if that list changes);
// - the gym-first set entry (HV-9): UnifiedSetEntry flashes `set-saved` and
//   renders its values through StepperInput, whose value field is
//   `field field-lg`; the session RPE field of the Workout Log is `field-lg`;
// - App.jsx keys a `page-enter` wrapper on the active tab and the nav items
//   use `nav-item`;
// - the visible copy of every page on main (JSX text plus copy attributes)
//   is still there, word for word (at least 30 strings are compared).
// Source check only (@babel/parser + @babel/traverse); nothing is executed.
// HV_PAGES_TARGET_REF=<ref> reads the checked files from that git ref instead
// of the working tree, so `HV_PAGES_TARGET_REF=main` shows the check failing
// before the refresh.

const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverseModule = require("@babel/traverse");
const traverse = traverseModule.default ?? traverseModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalise = (text) => text.replace(/\r\n/g, "\n");
const collapse = (text) => text.replace(/\s+/g, " ").trim();

function ast(code, file) {
  try {
    return parse(code, { sourceType: "module", plugins: ["jsx"] });
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

/** Every whitespace-separated token of every string literal and template chunk. */
function classTokens(code, file = "<inline>") {
  const tokens = new Set();
  const add = (text) => {
    for (const token of text.split(/\s+/)) {
      if (token) {
        tokens.add(token);
      }
    }
  };
  traverse(ast(code, file), {
    StringLiteral(nodePath) {
      add(nodePath.node.value);
    },
    TemplateElement(nodePath) {
      add(nodePath.node.value.raw);
    },
    JSXAttribute(nodePath) {
      const value = nodePath.node.value;
      if (value?.type === "StringLiteral") {
        add(value.value);
      }
    },
  });
  return tokens;
}

const COPY_ATTRIBUTES = new Set(["label", "title", "body", "placeholder", "aria-label", "emptyLabel", "detail"]);

/** Visible copy: JSX text and the string values of copy attributes, whitespace collapsed. */
function copyStrings(code, file = "<inline>") {
  const strings = new Set();
  const keep = (text) => {
    const value = collapse(text);
    if (value.length >= 8 && /[A-Za-z]{3}/.test(value)) {
      strings.add(value);
    }
  };
  traverse(ast(code, file), {
    JSXText(nodePath) {
      keep(nodePath.node.value);
    },
    JSXAttribute(nodePath) {
      const name = nodePath.node.name?.name;
      const value = nodePath.node.value;
      if (COPY_ATTRIBUTES.has(name) && value?.type === "StringLiteral") {
        keep(value.value);
      }
    },
  });
  return strings;
}

// Palette shades and arbitrary colour values (same families as the legacy sweep).
const FAMILIES = [
  "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky",
  "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];
const PALETTE = new RegExp(`(?<![\\w])[\\w:\\[\\]-]*-(?:${FAMILIES.join("|")})-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\\/\\d+)?(?![\\w-])`, "g");
const ARBITRARY_COLOR = /(?<![\w-])[\w:-]*-\[[^\]\s]*(?:#[0-9a-f]{3,8}(?![0-9a-z])|rgba?\(|hsla?\()[^\]\s]*\]/gi;
const rawColours = (code) => [...(code.match(PALETTE) ?? []), ...(code.match(ARBITRARY_COLOR) ?? [])];

// ------------------------------------------------------------------
// Self-tests
// ------------------------------------------------------------------
{
  const tokens = classTokens('const a = "card p-3"; <p className={`label ${x ? "pill-good" : ""}`}>Hi</p>');
  assert.ok(tokens.has("card") && tokens.has("label") && tokens.has("pill-good"));
  assert.ok(!tokens.has("card-inset"));
  const copy = copyStrings('<div title="Open Settings now"><p>\n  Saved workouts will\n  appear here.\n</p><b>{x}</b><i>ok</i></div>');
  assert.deepEqual([...copy].sort(), ["Open Settings now", "Saved workouts will appear here."]);
  assert.deepEqual(rawColours('className="bg-zinc-900 text-lime-300/80 bg-[#111111] text-text-1 bg-surface-1"'), [
    "bg-zinc-900",
    "text-lime-300/80",
    "bg-[#111111]",
  ]);
}

// ------------------------------------------------------------------
// Sources (working tree, or HV_PAGES_TARGET_REF)
// ------------------------------------------------------------------
function git(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const targetRef = process.env.HV_PAGES_TARGET_REF;
const read = (file) => {
  if (targetRef) {
    const result = git(["show", `${targetRef}:${file}`]);
    assert.equal(result.status, 0, `git show ${targetRef}:${file} (${result.stderr.trim()})`);
    return normalise(result.stdout);
  }
  return normalise(readFileSync(path.join(root, file), "utf8"));
};

const pages = readdirSync(path.join(root, "src/pages"))
  .filter((name) => name.endsWith(".jsx"))
  .sort()
  .map((name) => `src/pages/${name}`);
assert.ok(pages.length >= 10, `expected the ten pages, found ${pages.length}`);

// 1. Every page uses .card and .label (or .label-accent).
for (const page of pages) {
  const tokens = classTokens(read(page), page);
  assert.ok(tokens.has("card"), `${page} uses .card at least once`);
  assert.ok(tokens.has("label") || tokens.has("label-accent"), `${page} uses .label or .label-accent at least once`);
}

// 2. No raw colour utilities in the shell, the pages and the workout components.
const workoutComponents = readdirSync(path.join(root, "src/components/workout"))
  .filter((name) => name.endsWith(".jsx"))
  .map((name) => `src/components/workout/${name}`);
for (const file of ["src/App.jsx", ...pages, ...workoutComponents]) {
  assert.deepEqual(rawColours(read(file)), [], `${file} has no raw palette or arbitrary colour utility`);
}

// 3. Gym-first set entry (HV-9).
{
  const setEntry = read("src/components/workout/UnifiedSetEntry.jsx");
  const setEntryTokens = classTokens(setEntry, "UnifiedSetEntry.jsx");
  assert.ok(setEntryTokens.has("set-saved"), "UnifiedSetEntry flashes .set-saved on the saved set");
  assert.ok(setEntryTokens.has("btn-primary"), "Save Set is a .btn-primary");
  assert.ok(/import StepperInput from "\.\/StepperInput\.jsx";/.test(setEntry), "UnifiedSetEntry renders its values through StepperInput");
  const stepperTokens = classTokens(read("src/components/workout/StepperInput.jsx"), "StepperInput.jsx");
  assert.ok(stepperTokens.has("field") && stepperTokens.has("field-lg"), "StepperInput's value field is .field.field-lg");
  const logTokens = classTokens(read("src/pages/WorkoutLogPage.jsx"), "WorkoutLogPage.jsx");
  assert.ok(logTokens.has("field-lg"), "the session RPE field of the Workout Log is .field-lg");
  const tableTokens = classTokens(read("src/components/workout/CompletedWorkoutTable.jsx"), "CompletedWorkoutTable.jsx");
  for (const token of ["card-active", "set-saved", "pill-bad"]) {
    assert.ok(tableTokens.has(token), `CompletedWorkoutTable uses .${token} (current exercise, saved row, pain flag)`);
  }
}

// 4. Shell: page-enter wrapper keyed on the active tab, nav items.
{
  const app = read("src/App.jsx");
  assert.ok(/<div key=\{activeTab\} className="page-enter[ "]/.test(app), "App.jsx keys a .page-enter wrapper on activeTab");
  assert.ok(classTokens(app, "App.jsx").has("nav-item"), "App.jsx nav buttons use .nav-item");
}

// 5. Copy is unchanged: every visible string of every page on main is still there.
let compared = 0;
const probe = git(["--version"]);
const base = probe.status === 0 ? ["main", "origin/main"].find((ref) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0) : null;
if (!base) {
  console.log("UI HV pages: copy comparison SKIPPED (git or main unavailable).");
} else {
  const missing = [];
  for (const page of pages) {
    const before = git(["show", `${base}:${page}`]);
    if (before.status !== 0) {
      continue;
    }
    const now = copyStrings(read(page), page);
    for (const text of copyStrings(normalise(before.stdout), `${base}:${page}`)) {
      compared += 1;
      if (!now.has(text)) {
        missing.push(`${page}: ${JSON.stringify(text)}`);
      }
    }
  }
  assert.ok(compared >= 30, `at least 30 copy strings sampled from ${base} (got ${compared})`);
  assert.deepEqual(missing, [], `copy strings from ${base} missing now:\n${missing.join("\n")}`);
}

console.log(
  `UI HV pages verification passed (${pages.length} pages use .card and .label, ${workoutComponents.length + pages.length + 1} files free of raw colours, ${compared} copy strings unchanged${targetRef ? `, target ${targetRef}` : ""}).`,
);
