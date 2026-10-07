// Visual refresh, review round 2 fixes (decision HV-12). Each section pins one
// confirmed defect and carries a "before" sample that the same check must
// reject, so the check is shown to fail on the pre-fix shape.
//
//  1. One chip system: no arbitrary px radius in src/, no hand-rolled 10 px
//     tag chips; tags are .pill + .pill-accent / -warn / -bad.
//  2. A .pill carries no border utility (its edge is the inset line of
//     HV-11), so the pain-flag toggle has no double edge.
//  3. No hover that repeats the base fill; the Close Details button is a .btn.
//  4. "Set N saved." ends above the fixed bars after a save (H4-10 geometry,
//     real getActionScrollDelta), with Save Set still in view.
//  5. Phone tap targets: no explicit min-height under 44 px on a .btn, a link,
//     a button or a summary; .btn-sm always carries min-h-11.
//  6. A <details> whose summary shows a chevron rotates it when open.
//  7. The best saved set has exactly one text colour (accent-soft) at every
//     width, and a screen-reader cue.
// Source check plus pure geometry; nothing is rendered.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverseModule = require("@babel/traverse");
const traverse = traverseModule.default ?? traverseModule;

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

const parseCode = (code) => parse(code, { sourceType: "module", plugins: ["jsx"], errorRecovery: false });
const tokensOf = (text) => new Set(String(text).split(/\s+/).filter(Boolean));

/** Every string piece (literals, template quasis) inside an AST node. */
function stringPieces(node, out = []) {
  if (!node || typeof node !== "object") {
    return out;
  }
  if (node.type === "StringLiteral") {
    out.push(node.value);
  } else if (node.type === "TemplateElement") {
    out.push(node.value.cooked ?? node.value.raw);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((child) => stringPieces(child, out));
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      stringPieces(value, out);
    }
  }
  return out;
}

const elementName = (opening) => (opening.name.type === "JSXIdentifier" ? opening.name.name : "");
function classNameTokens(opening) {
  const attribute = opening.attributes.find((attr) => attr.type === "JSXAttribute" && attr.name?.name === "className");
  return attribute ? tokensOf(stringPieces(attribute.value).join(" ")) : new Set();
}

/** [{ name, tokens, line }] for every JSX opening element of `code`. */
function jsxElements(code) {
  const found = [];
  traverse(parseCode(code), {
    JSXOpeningElement(nodePath) {
      found.push({ name: elementName(nodePath.node), tokens: classNameTokens(nodePath.node), line: nodePath.node.loc?.start.line ?? 0, path: nodePath });
    },
  });
  return found;
}

/** Every whole string literal / template quasi of `code` (class constants included). */
function allStrings(code) {
  const found = [];
  traverse(parseCode(code), {
    StringLiteral(nodePath) {
      found.push({ text: nodePath.node.value, line: nodePath.node.loc?.start.line ?? 0 });
    },
    TemplateElement(nodePath) {
      found.push({ text: nodePath.node.value.cooked ?? nodePath.node.value.raw, line: nodePath.node.loc?.start.line ?? 0 });
    },
  });
  return found;
}

// ---------------------------------------------------------------------------
// 1. One chip system
// ---------------------------------------------------------------------------
const ARBITRARY_RADIUS = /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[\d+(?:\.\d+)?px\]/g;
function chipViolations(file, code) {
  const found = [];
  for (const match of code.matchAll(ARBITRARY_RADIUS)) {
    found.push(`${file}:${code.slice(0, match.index).split("\n").length} ${match[0]}`);
  }
  for (const { text, line } of allStrings(code)) {
    const tokens = tokensOf(text);
    // A 10 px text with its own radius or border is a hand-rolled tag chip.
    if (tokens.has("text-[10px]") && [...tokens].some((token) => /^(rounded|border)(-|$)/.test(token))) {
      found.push(`${file}:${line} hand-rolled 10px chip`);
    }
  }
  return found;
}
const chipBefore = '<span className="rounded-[4px] border border-line px-1.5 py-0.5 text-[10px] font-semibold text-text-2">Optional</span>';
assert.equal(chipViolations("before.jsx", chipBefore).length, 2, "pre-fix: the 4 px radius and the 10 px chip are both caught");
const chips = sourceFiles.flatMap(({ file, code }) => chipViolations(file, code));
assert.deepEqual(chips, [], `off-token radii or hand-rolled chips (use .pill, rounded-block / rounded-control): ${chips.join("; ")}`);
assert.ok(!/rounded-\[\d+px\]/.test(read("src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "")), "styles.css has no arbitrary px radius either");

const studio = read("src/components/ProgramStudio.jsx");
const statusTags = /const LIBRARY_STATUS_TAGS = \{([\s\S]*?)\n\};/.exec(studio)?.[1] ?? "";
assert.deepEqual(
  [...statusTags.matchAll(/className: "([^"]*)"/g)].map((match) => match[1]),
  ["pill-accent", "pill-warn", "pill-bad"],
  "the Library / New / Unmatched status tags are pill variants",
);
assert.ok(/<span className=\{`pill \$\{tag\.className\}`\}>/.test(studio), "StatusTag renders a .pill");
for (const [file, label] of [
  ["src/components/import/TechniqueDraftReview.jsx", "TechniqueDraftBadge"],
  ["src/components/workout/ExerciseInfoPanel.jsx", "AiTechniqueBadge"],
]) {
  const code = read(file);
  const body = code.slice(code.indexOf(`export function ${label}`), code.indexOf("\n}\n", code.indexOf(`export function ${label}`)));
  assert.ok(/(?<![\w-])pill pill-warn(?![\w-])/.test(body), `${file}: ${label} is a .pill-warn (the AI draft state is a warning, H3-6)`);
}

// ---------------------------------------------------------------------------
// 2. A pill has no border utility
// ---------------------------------------------------------------------------
const BORDER_UTILITY = /^(?:[\w-]+:)*border(?:-|$)/;
function borderedPills(file, code) {
  return jsxElements(code)
    .filter(({ tokens }) => tokens.has("pill") && [...tokens].some((token) => BORDER_UTILITY.test(token)))
    .map(({ line }) => `${file}:${line}`);
}
const painBefore =
  '<button className={`focus-ring pill min-h-11 border px-3 ${painFlag ? "pill-bad border-bad/40" : "border-line hover:text-text-1"}`}>x</button>';
assert.equal(borderedPills("before.jsx", painBefore).length, 1, "pre-fix: the pain-flag toggle had a border on top of the pill edge");
const bordered = sourceFiles.filter(({ file }) => file.endsWith(".jsx")).flatMap(({ file, code }) => borderedPills(file, code));
assert.deepEqual(bordered, [], `pills with a border utility (double edge with the HV-11 inset line): ${bordered.join("; ")}`);
const table = read("src/components/workout/CompletedWorkoutTable.jsx");
assert.ok(/aria-pressed=\{Boolean\(draftExercise\.painFlag\)\}\s*className=\{`focus-ring pill min-h-11 px-3 \$\{\s*draftExercise\.painFlag \? "pill-bad" : "hover:text-text-1"\s*\}`\}/.test(table), "the pain flag is .pill, .pill-bad when on");

// ---------------------------------------------------------------------------
// 3. No dead hover; Close Details is a .btn
// ---------------------------------------------------------------------------
function deadHovers(file, code) {
  const found = [];
  for (const { tokens, line } of jsxElements(code)) {
    for (const token of tokens) {
      const base = /^hover:((?:bg|text|border)-.+)$/.exec(token)?.[1];
      if (base && tokens.has(base)) {
        found.push(`${file}:${line} ${token}`);
      }
    }
  }
  return found;
}
const closeBefore =
  '<button className="focus-ring mt-2 flex min-h-11 w-full items-center justify-center rounded-block bg-accent-tint px-3 text-sm font-semibold text-accent-soft hover:bg-accent-tint">Close Details</button>';
assert.equal(deadHovers("before.jsx", closeBefore).length, 1, "pre-fix: the Close Details hover repeated its fill");
const dead = sourceFiles.filter(({ file }) => file.endsWith(".jsx")).flatMap(({ file, code }) => deadHovers(file, code));
assert.deepEqual(dead, [], `hover states that repeat the base style (no feedback): ${dead.join("; ")}`);
const infoPanel = read("src/components/workout/ExerciseInfoPanel.jsx");
const closeButton = /function ExerciseDetailsCloseButton[\s\S]*?className="([^"]*)"[\s\S]*?Close Details/.exec(infoPanel)?.[1] ?? "";
assert.ok(tokensOf(closeButton).has("btn") && tokensOf(closeButton).has("btn-secondary"), "Close Details is a .btn.btn-secondary (press scale, hover)");

// ---------------------------------------------------------------------------
// 4. "Set N saved." is visible after a save
// ---------------------------------------------------------------------------
const setEntry = read("src/components/workout/UnifiedSetEntry.jsx");
function savedLineFollowsSave(code) {
  return (
    /\{saveMessage && \(\s*<p ref=\{saveMessageRef\}/.test(code) &&
    /function saveSelectedSet\(\) \{[\s\S]*?setSaveCount\(/.test(code) &&
    /useEffect\(\(\) => \{[\s\S]*?saveMessageRef\.current[\s\S]*?saveButtonRef\.current[\s\S]*?actionBottom:\s*message\.getBoundingClientRect\(\)\.bottom[\s\S]*?\}, \[saveCount\]\);/.test(code)
  );
}
const savedBefore = `  function saveSelectedSet() {
    onSave(selectedSetIndex, toDraftSetPatch(values, profile));
    setSaveMessage(\`Set \${selectedSetIndex + 1} saved.\`);
  }
      {saveMessage && (
        <p className="set-saved mt-3 rounded-block bg-surface-2 px-3 py-2 text-sm font-medium text-accent-soft">`;
assert.equal(savedLineFollowsSave(savedBefore), false, "pre-fix: nothing brought the saved line above the bars");
assert.ok(savedLineFollowsSave(setEntry), "after a save the set entry scrolls the saved line above the fixed bars, anchored on Save Set");
assert.ok(/function scrollIntoClearBand\([\s\S]*?getActionScrollDelta\(\{/.test(setEntry), "both scrolls use the H4-10 helper");

const { getActionScrollDelta, SCROLL_CLEARANCE_GAP_PX } = await import("../src/lib/scrollClearance.js");
const spacing = (token) => {
  const step = /-(\d+(?:\.\d+)?)$/.exec(token ?? "");
  return step ? Number(step[1]) * 4 : NaN;
};
const savedClasses = tokensOf(/<p ref=\{saveMessageRef\} className="([^"]*)"/.exec(setEntry)?.[1] ?? "");
const savedGap = spacing([...savedClasses].find((token) => /^mt-/.test(token)));
const savedHeight = 2 * spacing([...savedClasses].find((token) => /^py-/.test(token))) + (savedClasses.has("text-sm") ? 20 : NaN);
assert.ok(savedGap === 12 && savedHeight === 36, `the saved line is ${savedGap}px below Save Set and ${savedHeight}px tall (measured 623-659 at 375 x 812)`);

// The reference geometry: the focus scroll (H4-10) parks Save Set's bottom 8px
// above the first fixed bar; the save then mounts the rest timer (its top at
// height - 193, the nav at height - 84; at 812: 619 and 739 as measured).
function afterSave(viewportHeight, saveHeight, { scroll }) {
  const restTop = viewportHeight - 193;
  const bars = [restTop, viewportHeight - 84];
  const saveBottom = restTop - SCROLL_CLEARANCE_GAP_PX;
  const saveTop = saveBottom - saveHeight;
  const messageBottom = saveBottom + savedGap + savedHeight;
  const delta = scroll
    ? getActionScrollDelta({ viewportTop: 0, viewportHeight, obstructionTops: bars, fieldTop: saveTop, fieldBottom: saveBottom, actionBottom: messageBottom })
    : 0;
  return { messageBottom: messageBottom - delta, saveTop: saveTop - delta, visibleBottom: restTop - SCROLL_CLEARANCE_GAP_PX };
}
const unscrolled = afterSave(812, 52, { scroll: false });
assert.ok(unscrolled.messageBottom > unscrolled.visibleBottom, `pre-fix: the saved line ends at ${unscrolled.messageBottom}, under the rest timer (${unscrolled.visibleBottom + SCROLL_CLEARANCE_GAP_PX})`);
for (const [height, saveHeight] of [[420, 44], [520, 44], [640, 52], [812, 52]]) {
  const result = afterSave(height, saveHeight, { scroll: true });
  assert.ok(result.messageBottom <= result.visibleBottom, `375 x ${height}: the saved line ends at ${result.messageBottom}, visible bottom ${result.visibleBottom}`);
  assert.ok(result.saveTop >= SCROLL_CLEARANCE_GAP_PX, `375 x ${height}: Save Set stays in view (top ${result.saveTop})`);
}

// ---------------------------------------------------------------------------
// 5. Phone tap targets
// ---------------------------------------------------------------------------
// file -> { count, reason }: explicit sub-44 px heights that never show on phones.
const SMALL_TARGET_ALLOWED = {
  "src/components/workout/StepperInput.jsx": {
    count: 2,
    reason: "the stacked +/- of the sm-and-up column (`hidden ... sm:grid`); phones use the 44 px [- value +] steppers (HV-11)",
  },
};
const minHeightPx = (tokens) => {
  const plain = [...tokens].filter((token) => /^min-h-/.test(token));
  if (!plain.length) {
    return null;
  }
  const token = plain.at(-1);
  const arbitrary = /^min-h-\[(\d+)px\]$/.exec(token);
  if (arbitrary) {
    return Number(arbitrary[1]);
  }
  const value = spacing(token);
  return Number.isFinite(value) ? value : null;
};
function smallTargets(file, code) {
  const found = [];
  for (const { name, tokens, line } of jsxElements(code)) {
    if (!["a", "button", "summary"].includes(name) && !tokens.has("btn")) {
      continue;
    }
    const height = minHeightPx(tokens);
    if (height !== null && height < 44) {
      found.push(`${file}:${line} <${name}> min-height ${height}px`);
    }
  }
  for (const { text, line } of allStrings(code)) {
    const tokens = tokensOf(text);
    if (!tokens.has("btn")) {
      continue;
    }
    const height = minHeightPx(tokens);
    if ((height !== null && height < 44) || (tokens.has("btn-sm") && (height === null || height < 44))) {
      found.push(`${file}:${line} .btn min-height ${height ?? (tokens.has("btn-sm") ? 36 : 44)}px`);
    }
  }
  return [...new Set(found)];
}
assert.ok(
  smallTargets("before.jsx", '<a className="focus-ring btn btn-ghost inline-flex min-h-9 w-fit items-center underline underline-offset-4">Check Video</a>').length > 0,
  "pre-fix: the Workouts Check Video link was 36 px",
);
const small = [];
for (const { file, code } of sourceFiles.filter(({ file }) => file.endsWith(".jsx"))) {
  const hits = smallTargets(file, code);
  const allowed = SMALL_TARGET_ALLOWED[file];
  if (allowed) {
    assert.ok(allowed.reason, `${file}: an allowance needs a reason`);
    assert.equal(hits.length, allowed.count, `${file}: ${allowed.count} allowed small targets (${allowed.reason}), found ${hits.join("; ")}`);
  } else {
    small.push(...hits);
  }
}
assert.deepEqual(small, [], `tap targets under 44 px on phones: ${small.join("; ")}`);
assert.ok(/className="hidden gap-1 sm:grid">\s*<button/.test(read("src/components/workout/StepperInput.jsx")), "the allowed small steppers sit in the sm-only column");

// ---------------------------------------------------------------------------
// 6. Disclosure chevrons rotate when open
// ---------------------------------------------------------------------------
function staticChevrons(file, code) {
  const found = [];
  traverse(parseCode(code), {
    JSXElement(nodePath) {
      if (elementName(nodePath.node.openingElement) !== "details") {
        return;
      }
      const detailsTokens = classNameTokens(nodePath.node.openingElement);
      nodePath.traverse({
        JSXElement(inner) {
          if (elementName(inner.node.openingElement) !== "summary") {
            return;
          }
          inner.traverse({
            JSXOpeningElement(icon) {
              if (!/^Chevron/.test(elementName(icon.node))) {
                return;
              }
              const tokens = classNameTokens(icon.node);
              // Three ways to turn: the .disclosure-chevron rule (bound to its
              // own details), group-open on a .group details, or a state class.
              const turns =
                tokens.has("disclosure-chevron") ||
                (detailsTokens.has("group") && tokens.has("group-open:rotate-180")) ||
                tokens.has("rotate-180");
              if (!turns) {
                found.push(`${file}:${icon.node.loc?.start.line ?? 0}`);
              }
            },
          });
        },
      });
    },
  });
  return found;
}
const settingsBefore = `<details className="card py-2">
  <summary className="flex min-h-11 items-center">
    Local data groups included in backups
    <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-text-2" />
  </summary>
</details>`;
assert.equal(staticChevrons("before.jsx", settingsBefore).length, 1, "pre-fix: the Settings chevron did not move");
const staticOnes = sourceFiles.filter(({ file }) => file.endsWith(".jsx")).flatMap(({ file, code }) => staticChevrons(file, code));
assert.deepEqual(staticOnes, [], `<details> chevrons that do not rotate when open (use .disclosure-chevron): ${staticOnes.join("; ")}`);
const stylesheet = read("src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(
  /details\[open\]\s*>\s*summary\s*>\s*\.disclosure-chevron\s*\{[^}]*(?:rotate:\s*180deg|transform:\s*rotate\(180deg\))/.test(stylesheet),
  "styles.css turns .disclosure-chevron under its own open details",
);
assert.ok(/\.disclosure-chevron\s*\{[^}]*transition:[^}]*var\(--duration-base\)/.test(stylesheet), ".disclosure-chevron turns in the base duration (HV-3; reduced motion zeroes it)");
const settingsChevron = /Local data groups included in backups\s*<ChevronDown[^>]*className="([^"]*)"/.exec(read("src/pages/SettingsPage.jsx"))?.[1] ?? "";
assert.ok(tokensOf(settingsChevron).has("disclosure-chevron"), "the Settings 'Local data groups' chevron turns when open");

// ---------------------------------------------------------------------------
// 7. Best saved set: one colour, and a non-visual cue
// ---------------------------------------------------------------------------
const COLOUR = /^text-(text-\d|accent(?:-soft|-fg)?|good|warn|bad)$/;
const summaryChunk = (code) => {
  const start = code.indexOf("function SavedSetsSummary(");
  return start === -1 ? "" : code.slice(start, code.indexOf("\nfunction ", start + 1));
};
function bestSetSingleColour(code) {
  const chunk = summaryChunk(code);
  if (!chunk || chunk.includes("text-accent-soft")) {
    return false; // the best colour must come from setRowTone only
  }
  const rowTemplates = [...chunk.matchAll(/className=\{`([^`]*)`\}/g)].map((match) => match[1]).filter((text) => text.includes("setRowTone("));
  return rowTemplates.length === 2 && rowTemplates.every((text) => ![...tokensOf(text.replace(/\$\{[\s\S]*?\}/g, " "))].some((token) => COLOUR.test(token)));
}
const bestBefore = `function SavedSetsSummary({ profile, sets }) {
  const rowClassName = (index) => \`\${index === bestIndex ? "font-semibold text-accent-soft" : ""}\`;
  return <p className={\`rounded-control bg-surface-1 \${isEmpty ? "text-text-3" : "text-text-2"} \${rowClassName(index)}\`} />;
}
function next() {}`;
assert.equal(bestSetSingleColour(bestBefore), false, "pre-fix: text-text-2 and text-accent-soft sat on one element (text-2 wins by stylesheet order)");
assert.ok(bestSetSingleColour(table), "SavedSetsSummary rows take their colour from setRowTone only");

const toneSource = /function setRowTone\([\s\S]*?\n\}/.exec(table)?.[0];
assert.ok(toneSource, "setRowTone exists");
const setRowTone = new Function(`return (${toneSource});`)();
for (const isBest of [false, true]) {
  for (const isEmpty of [false, true]) {
    for (const inherit of [false, true]) {
      const colours = [...tokensOf(setRowTone({ isBest, isEmpty, inherit }))].filter((token) => COLOUR.test(token));
      assert.ok(colours.length <= 1, `setRowTone(${JSON.stringify({ isBest, isEmpty, inherit })}) gives one colour at most: ${colours}`);
      if (isBest) {
        assert.deepEqual(colours, ["text-accent-soft"], "the best set is accent-soft");
      } else if (!inherit) {
        assert.deepEqual(colours, [isEmpty ? "text-text-3" : "text-text-2"], "other rows are text-2, empty ones text-3");
      }
    }
  }
}
assert.ok(/<span className="sr-only">[^<]*best set[^<]*<\/span>/.test(summaryChunk(table)), "the best set is announced to screen readers");
assert.equal((summaryChunk(table).match(/\{bestSetCue\(index\)\}/g) ?? []).length, 2, "both the phone line and the sm grid carry the cue");

console.log("UI HV review round 2 verification passed (one chip system, borderless pills, live hovers, saved line in view, 44 px targets, rotating chevrons, best set colour).");
