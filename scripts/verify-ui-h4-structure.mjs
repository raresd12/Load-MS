import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio, parseColor, readRules, readThemeTokens } from "./lib/contrast.mjs";

// Phase H4 / UI track, decisions H4-6 (page / component layout, lazy
// boundaries, eager training path) and H4-7 (mobile conventions). Pure
// source-structure checks: App.jsx stays a shell, every page lives in its own
// file, the heavy pages load lazily, no helper that moved to src/lib is still
// defined in the UI, and localStorage is only touched by src/lib/storage.js.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const lines = (text) => text.split(/\r?\n/);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(js|jsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const app = read("src/App.jsx");
const appLines = lines(app);

// ------------------------------------------------------------------
// App.jsx is a shell: state, effects, handlers, nav, banner wiring
// ------------------------------------------------------------------
assert.ok(appLines.length < 3000, `App.jsx has ${appLines.length} lines, expected well under 3000`);
assert.ok(app.includes("export default function App()"), "App.jsx still exports App");
assert.ok(app.includes("function StorageWarningBanner("), "App.jsx keeps the storage warning banner wiring");
assert.ok(app.includes("function isValidTab("), "App.jsx keeps tab validation");

// ------------------------------------------------------------------
// Pages: one file per page; eager training path, lazy administration
// ------------------------------------------------------------------
const eagerPages = ["DashboardPage", "ReadinessPage", "WorkoutsPage", "WorkoutLogPage", "MorePage"];
const lazyPages = ["ProgramPage", "ProgressPage", "HistoryPage", "LibraryPage", "SettingsPage"];

for (const page of [...eagerPages, ...lazyPages]) {
  const file = `src/pages/${page}.jsx`;
  assert.ok(existsSync(path.join(root, file)), `${file} exists`);
  const source = read(file);
  assert.ok(
    new RegExp(`export default function ${page}\\(`).test(source),
    `${file} default-exports ${page}`,
  );
}

for (const page of eagerPages) {
  assert.ok(
    app.includes(`import ${page} from "./pages/${page}.jsx";`),
    `${page} is imported eagerly (training path renders offline instantly)`,
  );
  assert.ok(!app.includes(`import("./pages/${page}.jsx")`), `${page} is not lazy`);
}

for (const page of lazyPages) {
  assert.ok(
    app.includes(`import("./pages/${page}.jsx")`),
    `${page} is loaded through a dynamic import (React.lazy boundary)`,
  );
  assert.ok(
    !app.includes(`import ${page} from "./pages/${page}.jsx";`),
    `${page} has no static import in App.jsx (it would end up in the startup chunk)`,
  );
  assert.ok(
    new RegExp(`const ${page} = lazyPages\\.getComponent\\("`).test(app),
    `${page} is a React.lazy component of the lazy page registry (decision H4-8)`,
  );
  assert.ok(
    new RegExp(`<Suspense fallback=\\{<PageLoadingFallback />\\}>\\s*<${page}[\\s/>]`).test(app),
    `${page} renders inside a Suspense boundary with the inline fallback`,
  );
}

assert.ok(app.includes("function preloadTab("), "nav preload helper present");
assert.ok(app.includes("onMouseEnter={() => preloadTab(tab.id)}"), "lazy chunks preload on nav hover");
assert.ok(app.includes("onFocus={() => preloadTab(tab.id)}"), "lazy chunks preload on nav focus");
assert.ok(app.includes("preloadTab(activeTab);"), "the active tab's chunk is requested when the tab becomes active");

// The fallback is a small inline block in the page area, never a full-screen flash.
const fallbackStart = app.indexOf("function PageLoadingFallback()");
const fallback = app.slice(fallbackStart, app.indexOf("\n}", fallbackStart));
assert.ok(fallbackStart !== -1, "PageLoadingFallback defined");
assert.ok(!/fixed|inset-0|min-h-screen|h-screen/.test(fallback), "the Suspense fallback is not full-screen");

// The heavy modules stay out of the startup chunk: App.jsx never imports them
// statically (ProgramPage pulls the Studio, the AI assistant and aiProgram.js).
for (const heavy of [
  "./components/ProgramStudio.jsx",
  "./components/AiProgramImportAssistant.jsx",
  "./lib/aiProgram.js",
  "./lib/programStudio.js",
  "./lib/programDraft.js",
]) {
  if (heavy === "./lib/programStudio.js") {
    // openStudioSession / updateStudioSessionDraft are App state helpers (H2-8); allowed.
    continue;
  }
  assert.ok(!app.includes(`from "${heavy}"`), `App.jsx does not import ${heavy} statically`);
}
const settings = read("src/pages/SettingsPage.jsx");
assert.ok(!settings.includes("lib/aiProgram.js"), "SettingsPage clears the Gemini key through storage.js secrets, not aiProgram.js");
assert.ok(settings.includes("clearSecret(SECRET_STORAGE_KEYS.geminiApiKey)"), "SettingsPage reset still clears the Gemini key");

// Orphans removed with the split (recorded in H4-6).
assert.ok(!app.includes("NextPlanPage"), "the unwired NextPlanPage is gone");

// ------------------------------------------------------------------
// No moved helper is defined twice
// ------------------------------------------------------------------
const uiFiles = [
  path.join(root, "src/App.jsx"),
  ...walk(path.join(root, "src/pages")),
  ...walk(path.join(root, "src/components")),
];
const uiSources = uiFiles.map((file) => ({ file: path.relative(root, file), text: readFileSync(file, "utf8") }));

const libModules = [
  "src/lib/date.js",
  "src/lib/sessionNormalize.js",
  "src/lib/sessionAnalytics.js",
  "src/lib/prescriptionView.js",
  "src/lib/workoutRecap.js",
  "src/lib/sessionEdit.js",
  // H4 fix round 3 (decisions H4-14, H4-15).
  "src/lib/historyView.js",
  "src/lib/programTargetForm.js",
  "src/lib/workoutSave.js",
];
const movedNames = new Set(["buildSaveErrorMessage", "buildStorageWarnings"]);
for (const module of libModules) {
  for (const match of read(module).matchAll(/^export (?:function|const) ([A-Za-z_$][\w$]*)/gm)) {
    movedNames.add(match[1]);
  }
}
assert.ok(movedNames.size > 100, `the lib modules export the moved helpers (${movedNames.size})`);

const definitionRe = (name) => new RegExp(`^(?:export )?(?:default )?(?:function|const|let)\\s+${name}\\b`, "m");
for (const name of movedNames) {
  for (const { file, text } of uiSources) {
    assert.ok(!definitionRe(name).test(text), `${name} moved to src/lib and is not defined again in ${file}`);
  }
}

// Every top-level UI declaration exists exactly once across App.jsx, pages and components.
const seen = new Map();
for (const { file, text } of uiSources) {
  for (const match of text.matchAll(/^(?:export )?(?:default )?(?:function|const|let)\s+([A-Za-z_$][\w$]*)(.*)$/gm)) {
    const name = match[1];
    if (/=\s*lazy\(/.test(match[2])) {
      // App.jsx's React.lazy wrappers name the page they load; not a second definition.
      continue;
    }
    const previous = seen.get(name);
    assert.ok(!previous, `${name} is defined in both ${previous} and ${file}`);
    seen.set(name, file);
  }
}

// ------------------------------------------------------------------
// Storage boundary: only src/lib/storage.js talks to localStorage
// ------------------------------------------------------------------
for (const file of walk(path.join(root, "src"))) {
  const relative = path.relative(root, file).replace(/\\/g, "/");
  if (relative === "src/lib/storage.js") {
    continue;
  }
  const code = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  assert.ok(!/\blocalStorage\b/.test(code), `${relative} does not touch localStorage directly`);
}

// ------------------------------------------------------------------
// Midnight (decision H4-2) wired through the date helpers
// ------------------------------------------------------------------
assert.ok(app.includes("getDateRolloverAction(previousDateKeyRef.current, todayDateKey)"), "the rollover effect asks the helper");
assert.ok(app.includes("window.setInterval(syncTodayDateKey, DATE_KEY_RESYNC_INTERVAL_MS)"), "resync cadence comes from date.js");
assert.ok(!/setInterval\([^)]*60000/.test(app), "no hard-coded 60 s interval left in App.jsx");
assert.ok(app.includes('window.addEventListener("focus", syncTodayDateKey)'), "focus resync kept");
assert.ok(app.includes('document.addEventListener("visibilitychange", syncTodayDateKey)'), "visibilitychange resync kept");

// ------------------------------------------------------------------
// Mobile conventions (decision H4-7)
// ------------------------------------------------------------------
const html = read("index.html");
const css = read("src/styles.css");
assert.ok(/viewport-fit=cover/.test(html), "index.html viewport uses viewport-fit=cover");
assert.ok(/\.safe-bottom\s*\{[^}]*env\(safe-area-inset-bottom,\s*0px\)/.test(css), "safe-bottom pads by env(safe-area-inset-bottom) with a 0 fallback");
assert.ok(/\.safe-top\s*\{[^}]*env\(safe-area-inset-top,\s*0px\)/.test(css), "safe-top pads by env(safe-area-inset-top) with a 0 fallback");
assert.ok(/\.rest-timer-safe\s*\{[^}]*env\(safe-area-inset-bottom,\s*0px\)/.test(css), "the rest timer bar offsets by the bottom inset");
assert.ok(/button:focus-visible,[\s\S]*outline: 2px solid var\(--color-accent(?:-soft)?\)/.test(css), "every interactive element gets the violet :focus-visible ring (HV-5 token)");

const navStart = app.indexOf('aria-label="Main navigation"');
const nav = app.slice(navStart, app.indexOf("</nav>", navStart));
assert.ok(/className="safe-bottom /.test(nav), "the bottom nav pads for the home indicator");
assert.ok(nav.includes("min-h-14"), "mobile nav buttons keep a >= 44 px target");

const restTimer = read("src/components/workout/RestTimerBar.jsx");
assert.ok(restTimer.includes("rest-timer-safe"), "RestTimerBar uses the safe-area offset");

const stepper = read("src/components/workout/StepperInput.jsx");
assert.ok(stepper.includes("aria-label={`Increase ${label}`}") && stepper.includes("aria-label={`Decrease ${label}`}"), "stepper +/- buttons are labelled");
assert.ok(stepper.includes("enterKeyHint={enterKeyHint}"), "stepper passes enterKeyHint to the input");
assert.ok(stepper.includes("min-h-11 min-w-11"), "mobile stepper buttons are >= 44 px squares");

const setEntry = read("src/components/workout/UnifiedSetEntry.jsx");
assert.ok(setEntry.includes('inputMode="numeric"') && setEntry.includes('inputMode="decimal"'), "set entry uses numeric keyboards");
assert.ok((setEntry.match(/enterKeyHint="done"/g) ?? []).length === 3, "reps / kg / RPE carry enterKeyHint=done");
// Decision H4-10: the focus scroll keeps Save Set above the fixed bottom bars
// (geometry in src/lib/scrollClearance.js, fixture verify-scroll-clearance.mjs).
assert.ok(!setEntry.includes("scrollIntoView("), "no edge-aligned scrollIntoView (it parks Save Set under the bottom nav)");
assert.ok(setEntry.includes("getActionScrollDelta({"), "the set entry asks the clearance helper on focus");
assert.ok(setEntry.includes('document.querySelectorAll("[data-fixed-bottom-bar]")'), "the fixed bottom bars are measured");
assert.ok(/<button\s+ref=\{saveButtonRef\}/.test(setEntry), "Save Set is the measured action");
assert.ok((setEntry.match(/onFocus=\{handleInputFocus\}/g) ?? []).length === 3, "reps / kg / RPE trigger the focus scroll");
assert.ok(/data-fixed-bottom-bar="nav"/.test(nav), "the bottom nav is marked as a fixed bottom bar");
assert.ok(restTimer.includes('data-fixed-bottom-bar="rest-timer"'), "the rest timer bar is marked as a fixed bottom bar");

// H4 fix round 1: at the 320 px minimum width the five labels still fit
// (no side padding, tight tracking and a smaller gap below 360 px).
assert.ok(/max-\[359px\]:px-0/.test(nav) && /max-\[359px\]:tracking-tight/.test(nav), "mobile nav labels get the full button width below 360 px");
assert.ok(/grid-cols-5 gap-1\.5 max-\[359px\]:gap-1 /.test(nav), "mobile nav gap tightens below 360 px");

const workoutLog = read("src/pages/WorkoutLogPage.jsx");
assert.ok(/inputMode="decimal"\s+enterKeyHint="done"\s+min="1"\s+max="10"/.test(workoutLog), "session RPE uses the decimal keyboard");

// Contrast floor (decision HV-5, replaces the zinc floor of H4-7 / H4 fix
// round 3): colour comes from the @theme tokens of styles.css and text-3
// (>= 4.5:1 on bg, surface-1 and surface-2, proven with its table in
// verify-ui-hv-tokens.mjs) is the dimmest text. A text colour utility with an
// opacity modifier (text-text-3/50, hover:text-accent/40 ...) must still reach
// 4.5:1 on surface-2, the lightest surface text sits on, whatever the variant
// (hover:, sm:, disabled:, placeholder: ...). text-sm/6 is a size with a line
// height, not a colour. Placeholders use text-3 itself (no dimmer exception
// any more). Checked over App.jsx, src/pages and src/components, and over
// styles.css for a literal colour below the floor.
const TEXT_WITH_OPACITY = /(?<![\w-])((?:[\w-]+(?:\[[^\]\s]*\])?:)*)text-([a-z0-9-]+)\/(\d+|\[[^\]\s]+\])(?![\w-])/g;
const opacityOf = (modifier) => {
  const inner = modifier.replace(/^\[|\]$/g, "");
  return /%$/.test(inner) || /^\d+$/.test(modifier) ? Number.parseFloat(inner) / 100 : Number.parseFloat(inner);
};
function colourTokensOf(tokens) {
  const colours = new Map();
  for (const [name, value] of tokens) {
    const colour = name.startsWith("--color-") ? parseColor(value) : null;
    if (colour) {
      colours.set(name.slice("--color-".length), colour);
    }
  }
  return colours;
}
function findBelowFloorText(text, colours, surface) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(TEXT_WITH_OPACITY)) {
      const base = colours.get(match[2]);
      if (!base) {
        continue;
      }
      const ratio = contrastRatio({ ...base, a: base.a * opacityOf(match[3]) }, surface);
      if (!(ratio >= 4.5)) {
        found.push(`${index + 1}: ${match[0]} (${ratio.toFixed(2)}:1)`);
      }
    }
  });
  return found;
}
const PLACEHOLDER_TEXT = /(?<![\w-])(?:[\w-]+(?:\[[^\]\s]*\])?:)*placeholder:text-[^\s"'`}]+/g;
const findPlaceholderColours = (text) => (text.match(PLACEHOLDER_TEXT) ?? []).filter((match) => !/placeholder:text-text-3$/.test(match));
// The checks themselves, on a fixed token set: what they must catch and what
// they must let through.
{
  const colours = colourTokensOf(
    new Map([
      ["--color-text-1", "rgba(255,255,255,0.92)"],
      ["--color-text-3", "rgba(255,255,255,0.52)"],
      ["--color-accent", "#a78bfa"],
      ["--font-sans", "Inter"],
    ]),
  );
  const surface = parseColor("#1a1a20");
  assert.deepEqual(findBelowFloorText('<p className="text-xs text-text-3/50">', colours, surface), ["1: text-text-3/50 (2.35:1)"]);
  assert.deepEqual(findBelowFloorText('className="hover:text-accent/40 sm:placeholder:text-text-1/[0.3]"', colours, surface), [
    "1: hover:text-accent/40 (2.09:1)",
    "1: sm:placeholder:text-text-1/[0.3] (2.49:1)",
  ]);
  assert.deepEqual(findBelowFloorText('className="text-text-1/90 text-sm/6 text-text-3 text-accent text-[11px]/4"', colours, surface), []);
  assert.deepEqual(findPlaceholderColours('className="placeholder:text-text-3 focus:placeholder:text-text-2 placeholder:text-zinc-600"'), [
    "focus:placeholder:text-text-2",
    "placeholder:text-zinc-600",
  ]);
}
const theme = readThemeTokens(css);
assert.ok(theme.found, "styles.css declares the HV-5 colour tokens in @theme");
const themeColours = colourTokensOf(theme.tokens);
const floorSurface = themeColours.get("surface-2");
assert.ok(floorSurface && themeColours.get("text-3"), "the surface-2 and text-3 tokens are colours");
assert.ok(contrastRatio(themeColours.get("text-3"), floorSurface) >= 4.5, "text-3 itself meets 4.5:1 on surface-2");
for (const { file, text } of uiSources) {
  const found = findBelowFloorText(text, themeColours, floorSurface);
  assert.deepEqual(found, [], `${file}: text below the text-3 contrast floor (${found.join("; ")})`);
  const placeholders = findPlaceholderColours(text);
  assert.deepEqual(placeholders, [], `${file}: placeholders use text-3 (${placeholders.join("; ")})`);
}
assert.deepEqual(findBelowFloorText(css, themeColours, floorSurface), [], "styles.css applies no text colour below the floor");
for (const rule of readRules(css)) {
  if (/(?<![\w-])background(?:-color)?\s*:/.test(rule.body)) {
    continue;
  }
  for (const match of rule.body.matchAll(/(?<![\w-])color\s*:\s*([^;]+);/g)) {
    const literal = parseColor(match[1].replace(/!important/, "").trim());
    if (literal) {
      assert.ok(contrastRatio(literal, floorSurface) >= 4.5, `styles.css ${rule.selector}: color ${match[1].trim()} is below 4.5:1 on surface-2`);
    }
  }
  if (/::placeholder/.test(rule.selector)) {
    for (const match of rule.body.matchAll(/(?<![\w-])color\s*:\s*([^;]+);/g)) {
      assert.match(match[1].trim(), /^var\(--color-text-3\)$/, `styles.css ${rule.selector}: placeholders use text-3`);
    }
  }
}
assert.ok(
  uiSources.some(({ text }) => /placeholder:text-text-3(?![\w/-])/.test(text)) ||
    readRules(css).some((rule) => /::placeholder/.test(rule.selector) && /(?<![\w-])color\s*:\s*var\(--color-text-3\)/.test(rule.body)),
  "placeholders are styled with text-3 (a placeholder:text-text-3 utility or a ::placeholder rule)",
);

// Icon-only buttons carry an aria-label: every <button ...> whose only child is
// an icon element must have aria-label.
for (const { file, text } of uiSources) {
  for (const match of text.matchAll(/<button\b([^>]*)>\s*<([A-Z][A-Za-z0-9]*)\b[^>]*aria-hidden="true"[^>]*\/>\s*<\/button>/g)) {
    assert.ok(/aria-label=/.test(match[1]), `${file}: icon-only <${match[2]}> button has an aria-label`);
  }
}

console.log(`UI H4 structure verification passed (App.jsx ${appLines.length} lines, ${uiSources.length} UI files, ${movedNames.size} moved helpers).`);
