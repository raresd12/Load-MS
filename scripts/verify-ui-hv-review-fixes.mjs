// Visual refresh, review round 1 fixes (decision HV-11). Each section pins one
// confirmed defect and carries a "before" sample that the same check must
// reject, so the check is shown to fail on the pre-fix shape.
//
//  1. Readiness tone blocks: no element opacity on text, no bg-black well;
//     every tone colour reaches 4.5:1 on its tint and on the surface-1 well;
//     the save line is good on success, bad on failure, text-2 when idle.
//  2. A neutral .pill keeps a visible edge on surface-2 (.card-inset).
//  3. No button is a solid good / warn / bad fill; the five hand-rolled
//     buttons are .btn.
//  4. The "Default" program badge is not a warn pill.
//  5. The rest timer's done-state button draws its focus ring in accent-fg.
//  6. Save Set clears the rest timer at 375 x 420 with the Reps field focused
//     (H4-10 geometry, real getActionScrollDelta).
//  7. StepperInput has no fixed-width label column on phones.
//  8. Coach warnings (sentences) are not pills.
//  9. Every flex <summary> shows a chevron (no native marker on flex).
// 10. Reduced motion also turns off the active:scale-* press scale.
// 11. .page-enter animates opacity only and does not fill forwards.
// 12. Progress and History set tabular-nums on their page root.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composite, contrastRatio, parseColor, readBlock, readRules, readThemeTokens, stripCssComments } from "./lib/contrast.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(jsx|js)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}
const sourceFiles = walk(path.join(root, "src")).map((full) => ({
  file: path.relative(root, full).split(path.sep).join("/"),
  code: readFileSync(full, "utf8"),
}));

const css = read("src/styles.css");
const { tokens } = readThemeTokens(css);
const colour = (name) => {
  const value = parseColor(tokens.get(`--color-${name}`));
  assert.ok(value, `token --color-${name} is a colour`);
  return value;
};
const rules = readRules(css);
const rulesFor = (pattern, { inReduce = false } = {}) =>
  rules.filter((rule) => pattern.test(rule.selector) && /prefers-reduced-motion/.test(rule.atRule ?? "") === inReduce);

// ---------------------------------------------------------------------------
// 1. Readiness
// ---------------------------------------------------------------------------
// Element opacity below 100 on anything but a disabled state: it dims text
// under the HV-5 floor without the text-*/NN guard of verify-ui-h4-structure
// seeing it (the red readiness labels measured 4.30 and 3.62:1).
const ELEMENT_OPACITY = /(?<![\w-])((?:[\w-]+(?:\[[^\]\s]*\])?:)*)opacity-(\d+)(?![\w-])/g;
function findElementOpacity(code) {
  const found = [];
  code.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(ELEMENT_OPACITY)) {
      const variants = match[1];
      if (Number(match[2]) < 100 && !/(^|:)(disabled|group-disabled|peer-disabled):$/.test(variants)) {
        found.push(`${index + 1}: ${match[0]}`);
      }
    }
  });
  return found;
}
assert.deepEqual(findElementOpacity('<p className="label text-current opacity-80">\n<p className="label text-current opacity-70">'), [
  "1: opacity-80",
  "2: opacity-70",
]);
assert.deepEqual(findElementOpacity('className="btn disabled:opacity-50 opacity-100 hover:opacity-100"'), []);
const opacityHits = sourceFiles.flatMap(({ file, code }) => findElementOpacity(code).map((hit) => `${file}:${hit}`));
assert.deepEqual(opacityHits, [], `element opacity dims text below the floor: ${opacityHits.join("; ")}`);

const readinessPage = read("src/pages/ReadinessPage.jsx");
assert.ok(!/bg-black\//.test(readinessPage), "the readiness wells use a token surface, not bg-black/NN (HV-1)");
assert.ok(/<div key=\{metric\.id\} className="[^"]*\bbg-surface-1\b/.test(readinessPage), "the readiness value wells are surface-1");

const { readinessStyles, readinessSaveMessageClass } = await import("../src/components/readiness/readinessCopy.js");
const { READINESS_SAVED_MESSAGE } = await import("../src/lib/readinessSave.js");
const bg = colour("bg");
const surface1 = colour("surface-1");
for (const [status, classes] of Object.entries(readinessStyles)) {
  const tone = /\btext-(good|warn|bad)\b/.exec(classes)?.[1];
  const tint = /\bbg-(good|warn|bad)-tint\b/.exec(classes)?.[1];
  assert.ok(tone && tint === tone, `${status} readiness is ${tone} text on its own tint`);
  const onTint = contrastRatio(colour(tone), composite(colour(`${tone}-tint`), bg));
  const onWell = contrastRatio(colour(tone), surface1);
  assert.ok(onTint >= 4.5, `${status} readiness text on its tint ${onTint.toFixed(2)}:1`);
  assert.ok(onWell >= 4.5, `${status} readiness label on the surface-1 well ${onWell.toFixed(2)}:1`);
}
// The pre-fix pairing fails the same check: bad at 70 % on bad-tint.
assert.ok(contrastRatio({ ...colour("bad"), a: 0.7 }, composite(colour("bad-tint"), bg)) < 4.5, "the opacity-70 red label was below 4.5:1");

assert.equal(readinessSaveMessageClass(READINESS_SAVED_MESSAGE), "text-good", "a durable save is confirmed in good (HV-1)");
assert.equal(readinessSaveMessageClass("Today's readiness could not be saved: Quota. Your check-in is still in the form."), "text-bad");
assert.equal(readinessSaveMessageClass(""), "text-text-2");
assert.equal(readinessSaveMessageClass(undefined), "text-text-2");
assert.ok(readinessPage.includes("readinessSaveMessageClass(saveMessage)"), "the Readiness save line takes its colour from the helper");

// ---------------------------------------------------------------------------
// 2. Neutral pill edge
// ---------------------------------------------------------------------------
function pillHasEdge(styles) {
  const all = readRules(styles);
  const base = all.filter((rule) => rule.selector.split(",").some((part) => part.trim() === ".pill"));
  return base.some((rule) => /box-shadow\s*:\s*inset\s+0\s+0\s+0\s+1px\s+var\(--color-line\)/.test(rule.body) || /(?<![\w-])border\s*:\s*1px\s+solid\s+var\(--color-line\)/.test(rule.body));
}
assert.equal(pillHasEdge(".pill { border-radius: 999px; background-color: var(--color-surface-2); }"), false, "the pre-fix pill had no edge");
assert.ok(pillHasEdge(css), "a neutral .pill has a 1px line edge, so it stays visible on surface-2 (.card-inset)");
for (const variant of ["accent", "good", "warn", "bad"]) {
  const reset = rules.some((rule) => rule.selector.split(",").some((part) => part.trim() === `.pill-${variant}`) && /box-shadow\s*:\s*none/.test(rule.body));
  assert.ok(reset, `.pill-${variant} keeps its tint without the neutral edge`);
}

// ---------------------------------------------------------------------------
// 3. Buttons: no solid status fill, the hand-rolled ones are .btn
// ---------------------------------------------------------------------------
const SOLID_STATUS = /(?<![\w-])bg-(good|warn|bad)(?![\w/-])/;
function buttonsWithSolidStatus(code) {
  const found = [];
  for (const match of code.matchAll(/<button\b[\s\S]*?>/g)) {
    if (SOLID_STATUS.test(match[0])) {
      found.push(match[0].replace(/\s+/g, " ").slice(0, 120));
    }
  }
  return found;
}
assert.equal(buttonsWithSolidStatus('<button type="button" className="focus-ring min-h-10 rounded-control bg-warn px-3 text-bg">').length, 1);
assert.equal(buttonsWithSolidStatus('<button className={`btn ${ok ? "bg-bad text-bg" : ""}`}>').length, 1);
assert.equal(buttonsWithSolidStatus('<button className="btn btn-danger bg-bad-tint">').length, 0);
const solidButtons = sourceFiles.flatMap(({ file, code }) => buttonsWithSolidStatus(code).map((hit) => `${file}: ${hit}`));
assert.deepEqual(solidButtons, [], `buttons with a solid good / warn / bad fill (HV-1): ${solidButtons.join("; ")}`);

function buttonClassBefore(code, text) {
  const index = code.search(new RegExp(`>\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<`));
  assert.ok(index !== -1, `button "${text}" found`);
  const open = code.lastIndexOf("<button", index);
  return code.slice(open, index + 1);
}
const programPage = read("src/pages/ProgramPage.jsx");
const programCard = read("src/components/program/ProgramCard.jsx");
const settingsPage = read("src/pages/SettingsPage.jsx");
for (const [code, text] of [
  [programPage, "Resume"],
  [programCard, "Duplicate to Edit"],
  [settingsPage, "Import Backup"],
  [settingsPage, "Confirm Reset"],
]) {
  assert.ok(/(?<![\w-])btn(?![\w-])/.test(buttonClassBefore(code, text)), `"${text}" is a .btn (press scale, disabled style, hover rule)`);
}
assert.ok(/(?<![\w-])btn-danger(?![\w-])/.test(buttonClassBefore(settingsPage, "Confirm Reset")), "Confirm Reset is .btn-danger (HV-2)");
const setActive = programCard.slice(programCard.lastIndexOf("<button", programCard.indexOf('"Set Active"')), programCard.indexOf('"Set Active"'));
assert.ok(/(?<![\w-])btn(?![\w-])/.test(setActive) && setActive.includes("btn-primary"), "Set Active is .btn.btn-primary");

// ---------------------------------------------------------------------------
// 4. Default badge
// ---------------------------------------------------------------------------
const programFields = read("src/components/program/ProgramFields.jsx");
const badge = programFields.slice(programFields.indexOf("export function ProgramBadge"), programFields.indexOf("export function ProgramTextField"));
assert.ok(badge.length > 0 && !/pill-(warn|bad|good)/.test(badge), "ProgramBadge uses no status pill: Default is a neutral pill, Active the accent pill");
assert.ok(badge.includes("pill pill-accent"), "the Active badge stays pill-accent");

// ---------------------------------------------------------------------------
// 5. Focus ring on the accent fill
// ---------------------------------------------------------------------------
const accent = colour("accent");
assert.ok(contrastRatio(colour("accent-soft"), accent) < 3, "the default ring (accent-soft) is below 3:1 on accent, so it needs the override");
assert.ok(contrastRatio(colour("accent-fg"), accent) >= 3, "accent-fg reaches the 3:1 a focus indicator needs on accent");
const onAccent = rules.filter((rule) => /\.focus-on-accent:focus-visible/.test(rule.selector) && !rule.atRule);
assert.ok(onAccent.some((rule) => /outline-color\s*:\s*var\(--color-accent-fg\)/.test(rule.body)), ".focus-on-accent:focus-visible draws the ring in accent-fg (unlayered, so it beats the global ring)");
const restTimer = read("src/components/workout/RestTimerBar.jsx");
assert.ok(/isDone \? "focus-on-accent [^"]*"/.test(restTimer), "the done-state OK button carries .focus-on-accent");

// ---------------------------------------------------------------------------
// 6. Save Set clears the rest timer at 375 x 420 (H4-10)
// ---------------------------------------------------------------------------
const { getActionScrollDelta, SCROLL_CLEARANCE_GAP_PX } = await import("../src/lib/scrollClearance.js");
const setEntry = read("src/components/workout/UnifiedSetEntry.jsx");
const stepper = read("src/components/workout/StepperInput.jsx");
const fieldLgMin = Number(/\.field-lg\s*\{[^}]*min-height:\s*(\d+)px/.exec(css)?.[1]);
assert.equal(fieldLgMin, 56, ".field-lg is 56 px (HV-2)");
const shortQuery = /@custom-variant\s+short\s+\(@media\s*\(max-height:\s*(\d+)px\)\);/.exec(css);
assert.ok(shortQuery, "styles.css defines the short: variant (max-height media query)");
const shortMax = Number(shortQuery[1]);

const spacing = (token) => {
  const arbitrary = /\[(\d+)px\]$/.exec(token);
  if (arbitrary) {
    return Number(arbitrary[1]);
  }
  const step = /-(\d+(?:\.\d+)?)$/.exec(token);
  return step ? Number(step[1]) * 4 : NaN;
};
/** The px value of `utility` (min-h / gap / mt) on a class string, the short: one when `short`. */
function classPx(classes, utility, short) {
  const list = classes.split(/\s+/);
  const plain = list.filter((token) => token.startsWith(`${utility}-`));
  const tight = list.filter((token) => token.startsWith(`short:${utility}-`)).map((token) => token.slice("short:".length));
  const chosen = short && tight.length ? tight.at(-1) : plain.at(-1);
  return chosen ? spacing(chosen) : NaN;
}
const inputClasses = /className="(field field-lg[^"]*)"/.exec(stepper)?.[1];
assert.ok(inputClasses, "StepperInput's value input is .field.field-lg");
const gridClasses = /<div className="(grid gap-[^"]*)">\s*<StepperInput/.exec(setEntry)?.[1];
assert.ok(gridClasses, "UnifiedSetEntry lays its values out in one grid");
const saveClasses = /ref=\{saveButtonRef\}[\s\S]*?className="([^"]*)"/.exec(setEntry)?.[1];
assert.ok(saveClasses, "Save Set found");

// Order: the focused value field and Save Set are separated by the values only.
const gridAt = setEntry.indexOf(gridClasses);
const saveAt = setEntry.indexOf("ref={saveButtonRef}");
const notesAt = setEntry.indexOf("{labels.notes.length > 0 && (");
const savedLineAt = setEntry.indexOf("{saveMessage && (");
assert.ok(notesAt !== -1 && notesAt < gridAt, "the per-side / per-dumbbell notes sit above the values");
assert.ok(savedLineAt > saveAt, 'the "Set N saved." line sits below Save Set, so it does not push Save Set down');

function setEntrySpan({ input, grid, save, short }) {
  const field = short && /(?:^|\s)short:min-h-/.test(input) ? classPx(input, "min-h", true) : fieldLgMin;
  return 3 * field + 2 * classPx(grid, "gap", short) + classPx(save, "mt", short) + (classPx(save, "min-h", short) || 44);
}
// The reference measurement (375 x 420, rest timer running): rest bar top at
// viewport height - 193, bottom nav top at height - 84; the Reps field starts
// below the fold. Save Set must end inside the visible band.
function saveSetBottomAfterFocus(viewportHeight, span) {
  const fieldTop = viewportHeight - 120;
  const delta = getActionScrollDelta({
    viewportTop: 0,
    viewportHeight,
    obstructionTops: [viewportHeight - 193, viewportHeight - 84],
    fieldTop,
    fieldBottom: fieldTop + 56,
    actionBottom: fieldTop + span,
  });
  return { bottom: fieldTop + span - delta, visibleBottom: viewportHeight - 193 - SCROLL_CLEARANCE_GAP_PX };
}
// Before the fix: 56 px fields, gap-3, mt-3 and the 52 px button everywhere.
const before = saveSetBottomAfterFocus(420, setEntrySpan({ input: "field field-lg", grid: "grid gap-3", save: "mt-3 min-h-[52px]", short: true }));
assert.ok(before.bottom > before.visibleBottom, `pre-fix: Save Set ends at ${before.bottom}, under the rest timer (${before.visibleBottom})`);
const shortSpan = setEntrySpan({ input: inputClasses, grid: gridClasses, save: saveClasses, short: true });
const fullSpan = setEntrySpan({ input: inputClasses, grid: gridClasses, save: saveClasses, short: false });
for (const height of [420, shortMax]) {
  const result = saveSetBottomAfterFocus(height, shortSpan);
  assert.ok(result.bottom <= result.visibleBottom, `at 375 x ${height} (short layout, span ${shortSpan}px) Save Set ends at ${result.bottom}, visible bottom ${result.visibleBottom}`);
}
const tall = saveSetBottomAfterFocus(shortMax + 1, fullSpan);
assert.ok(tall.bottom <= tall.visibleBottom, `just above the short query (${shortMax + 1}px) the full layout (span ${fullSpan}px) clears too: ${tall.bottom} <= ${tall.visibleBottom}`);

// ---------------------------------------------------------------------------
// 7. Stepper label
// ---------------------------------------------------------------------------
const stepperGrid = /<label className="(grid [^"]*)"/.exec(stepper)?.[1] ?? "";
const phoneColumns = /(?:^|\s)grid-cols-\[([^\]]+)\]/.exec(stepperGrid)?.[1];
assert.equal(phoneColumns, "44px_minmax(0,1fr)_44px", "phones: [- value +], no fixed 44 px label column");
assert.ok(!/grid-cols-\[44px_44px_/.test(stepper), "the pre-fix label column is gone");
const middleAt320 = 214 - 2 * 44 - 2 * 6;
assert.ok(middleAt320 >= 110, `the value column is ${middleAt320}px at 320 px (54 px before)`);
assert.ok(/<span className="relative block min-w-0">\s*<span\s+aria-hidden="true"\s+className="pointer-events-none absolute[^"]*sm:hidden"\s*>\s*\{label\}/.test(stepper), "phones: the label is a caption inside the value box");
assert.ok(/<span className="label mb-0 hidden[^"]*sm:block">/.test(stepper), "sm and up: the label sits above the value");

// ---------------------------------------------------------------------------
// 8. Coach warnings are not pills
// ---------------------------------------------------------------------------
function warningPills(code) {
  const found = [];
  for (const match of code.matchAll(/\{warning\}/g)) {
    const open = code.lastIndexOf("<", match.index);
    const tag = code.slice(open, match.index);
    if (/(?<![\w-])pill(?![\w-])/.test(tag)) {
      found.push(tag.replace(/\s+/g, " ").slice(0, 80));
    }
  }
  return found;
}
assert.equal(warningPills('<span\n  key={warning}\n  className="pill pill-warn"\n>\n  {warning}\n</span>').length, 1);
const workoutsPage = read("src/pages/WorkoutsPage.jsx");
assert.ok((workoutsPage.match(/\{warning\}/g) ?? []).length >= 2, "both warning lists are still rendered");
assert.deepEqual(warningPills(workoutsPage), [], "sentence-length coach warnings are blocks or list items, not 999 px pills");

// ---------------------------------------------------------------------------
// 9. Flex summaries show a chevron
// ---------------------------------------------------------------------------
function markerlessSummaries(code) {
  const found = [];
  for (const match of code.matchAll(/<summary\b([\s\S]*?)>([\s\S]*?)<\/summary>/g)) {
    const classes = /className="([^"]*)"/.exec(match[1])?.[1] ?? "";
    const isFlex = /(?<![\w:-])(flex|grid|inline-flex)(?![\w-])/.test(classes);
    const isButton = /(?<![\w-])btn(?![\w-])/.test(classes);
    // The affordance is a chevron icon, or a visible chip / button such as
    // the "Edit" pill of a prescription row.
    const hasCue = /<Chevron\w*/.test(match[2]) || /className="[^"]*(?<![\w-])(pill|btn)(?![\w-])/.test(match[2]);
    if (isFlex && !isButton && !hasCue) {
      found.push(match[2].replace(/\s+/g, " ").trim().slice(0, 60));
    }
  }
  return found;
}
assert.deepEqual(markerlessSummaries('<summary className="label-accent mb-0 flex min-h-11 cursor-pointer items-center">\n  RPE guide\n</summary>'), ["RPE guide"]);
assert.deepEqual(markerlessSummaries('<summary className="cursor-pointer">Technical details</summary>'), []);
const noMarker = sourceFiles.flatMap(({ file, code }) => markerlessSummaries(code).map((hit) => `${file}: ${hit}`));
assert.deepEqual(noMarker, [], `flex <summary> elements with no chevron (display:flex drops the native marker): ${noMarker.join("; ")}`);

// ---------------------------------------------------------------------------
// 10. Reduced motion and the active:scale utilities
// ---------------------------------------------------------------------------
const reduceMatch = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/.exec(stripCssComments(css));
const reduce = readBlock(stripCssComments(css), reduceMatch.index + reduceMatch[0].length - 1).body;
const scaleOff = (block) => readRules(block).some((rule) => /(^|[\s,])\*?:active\b/.test(rule.selector) && !/\.btn/.test(rule.selector) && /(?<![\w-])scale\s*:\s*none\s*!important/.test(rule.body));
assert.equal(scaleOff("* { animation-duration: 0.01ms !important; } .btn:active:not(:disabled) { transform: none; }"), false, "the pre-fix block left active:scale-* on");
const usesActiveScale = sourceFiles.some(({ code }) => /(?<![\w-])active:scale-/.test(code));
assert.ok(!usesActiveScale || scaleOff(reduce), "reduced motion turns off the Tailwind press scale (scale: none on :active) as HV-3 says");

// ---------------------------------------------------------------------------
// 11. .page-enter
// ---------------------------------------------------------------------------
function keyframesBody(styles, name) {
  const clean = stripCssComments(styles);
  const match = new RegExp(`@keyframes\\s+${name}\\s*\\{`).exec(clean);
  return match ? readBlock(clean, match.index + match[0].length - 1).body : null;
}
const CONTAINING_BLOCK = /(?<![\w-])(transform|translate|scale|rotate|filter|perspective|backdrop-filter)\s*:/;
assert.ok(CONTAINING_BLOCK.test("from { opacity: 0; transform: translateY(4px); }"), "the pre-fix keyframes moved the wrapper");
const pageKeyframes = keyframesBody(css, "hv-page-enter");
assert.ok(pageKeyframes, "@keyframes hv-page-enter exists");
assert.ok(!CONTAINING_BLOCK.test(pageKeyframes), "hv-page-enter animates opacity only: a transform makes the wrapper the containing block of the fixed rest timer");
const pageEnter = rulesFor(/^\.page-enter$/);
assert.ok(pageEnter.length > 0, ".page-enter defined");
for (const rule of pageEnter) {
  assert.ok(!/(?<![\w-])(both|forwards)(?![\w-])/.test(rule.body), ".page-enter does not fill forwards: nothing stays on the wrapper after the fade");
}

// ---------------------------------------------------------------------------
// 12. Tabular numbers on Progress and History
// ---------------------------------------------------------------------------
for (const file of ["src/pages/ProgressPage.jsx", "src/pages/HistoryPage.jsx"]) {
  const code = read(file);
  const body = code.slice(code.indexOf("export default function"));
  // The first `return (<div ...` of the default export is the page root
  // (an empty state returns a <section> before it).
  const pageRoot = /\n {2}return \(\n {4}<div className="([^"]*)"/.exec(body)?.[1];
  assert.ok(pageRoot !== undefined, `${file} has a page root`);
  assert.ok(/(?<![\w-])tabular-nums(?![\w-])/.test(pageRoot), `${file}: the page root sets tabular-nums (HV-1 / HV-10)`);
}

console.log("UI HV review fixes verification passed (readiness contrast, pills, buttons, focus on accent, Save Set clearance, stepper label, warnings, summaries, reduced motion, page-enter, tabular numbers).");
