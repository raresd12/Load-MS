import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Visual refresh, decision HV-6: colour comes only from the HV-5 tokens. No
// Tailwind palette utility of any family (the old lime / zinc / amber / red /
// sky / cyan and every other one), no arbitrary colour class, no gradient
// utility, none of the three hard-coded legacy colours, no font-black and no
// wide-tracked eyebrow style anywhere in src/. Allowed exceptions: none.
// HV close: raw black / white utilities (bg-black/95, text-white) and the
// Tailwind drop-shadow utilities are also out; overlays use bg-bg/NN and
// popovers use surface-3 with a line border instead of a shadow.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(js|jsx|css)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FAMILIES = [
  "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky",
  "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];
const SHADES = "50|100|200|300|400|500|600|700|800|900|950";

// Any utility (bg-, text-, border-l-, ring-offset-, from-, shadow-, fill-,
// placeholder:, divide- ...) or CSS variable (--color-zinc-900) naming a
// palette shade, with or without an opacity modifier.
const PALETTE = new RegExp(`(?<![\\w])[\\w:\\[\\]-]*-(?:${FAMILIES.join("|")})-(?:${SHADES})(?:\\/(?:\\d+|\\[[^\\]\\s]*\\]))?(?![\\w-])`, "g");
// Arbitrary colour values: bg-[#111111], text-[rgb(...)], shadow-[0_0_20px_rgba(...)].
const ARBITRARY_COLOR = /(?<![\w-])[\w:-]*-\[[^\]\s]*(?:#[0-9a-f]{3,8}(?![0-9a-z])|rgba?\(|hsla?\(|oklch\(|color-mix\()[^\]\s]*\]/gi;
const GRADIENT_UTILITY = /(?<![\w-])[\w:-]*bg-(?:gradient|linear|radial|conic)-[\w[\]/.-]+/g;
const LEGACY_HEX = /#(?:111111|bef264|f8f8f8)(?![0-9a-f])/gi;
// Raw black / white colour utilities, with or without an opacity modifier.
const RAW_BLACK_WHITE = /(?<![\w-])(?:[\w-]+:)*(?:bg|text|border(?:-[xytrbls])?|ring(?:-offset)?|outline|divide|fill|stroke|shadow|from|via|to|decoration|caret|accent)-(?:black|white)(?:\/(?:\d+|\[[^\]\s]*\]))?(?![\w-])/g;
// Tailwind box-shadow utilities (shadow, shadow-sm ... shadow-2xl, shadow-inner)
// and shadow colours; the refresh has no drop shadows or glows.
const SHADOW_UTILITY = /(?<![\w-])[\w:-]*shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner|none|[\w-]+\/\d+))?(?![\w-])/g;
const FONT_BLACK = /(?<![\w-])[\w:-]*font-black(?![\w-])/g;
// Eyebrow letter-spacing: tracking-wide / wider / widest and any arbitrary
// tracking of 0.08em or more (the old uppercase eyebrows used 0.08-0.18em).
const TRACKING = /(?<![\w-])[\w:-]*tracking-(?:wide|wider|widest|\[(\d*\.?\d+)em\])(?![\w-])/g;

function findLegacyStyles(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const at = (kind, value) => found.push(`${index + 1}: ${kind} ${value}`);
    for (const match of line.matchAll(PALETTE)) at("palette", match[0]);
    for (const match of line.matchAll(ARBITRARY_COLOR)) at("arbitrary-colour", match[0]);
    for (const match of line.matchAll(GRADIENT_UTILITY)) at("gradient", match[0]);
    for (const match of line.matchAll(LEGACY_HEX)) at("legacy-hex", match[0]);
    for (const match of line.matchAll(RAW_BLACK_WHITE)) at("raw-black-white", match[0]);
    // box-shadow in CSS is a property, not a utility; only class-like tokens count.
    if (!/^\s*(?:box-shadow|--[\w-]+)\s*:/.test(line)) {
      for (const match of line.matchAll(SHADOW_UTILITY)) at("shadow", match[0]);
    }
    for (const match of line.matchAll(FONT_BLACK)) at("font-black", match[0]);
    for (const match of line.matchAll(TRACKING)) {
      if (match[1] === undefined || Number.parseFloat(match[1]) >= 0.08) at("eyebrow-tracking", match[0]);
    }
  });
  return found;
}

// The check itself: what it must catch and what it must let through.
assert.deepEqual(findLegacyStyles('className="bg-zinc-900 text-lime-300"'), ["1: palette bg-zinc-900", "1: palette text-lime-300"]);
assert.deepEqual(findLegacyStyles('className="hover:border-l-sky-300/40 ring-offset-zinc-950 focus:ring-cyan-200/[0.5]"'), [
  "1: palette hover:border-l-sky-300/40",
  "1: palette ring-offset-zinc-950",
  "1: palette focus:ring-cyan-200/[0.5]",
]);
assert.deepEqual(findLegacyStyles("`${tone} shadow-rose-500/20 placeholder:text-zinc-600 from-teal-400 via-indigo-500 to-violet-600`"), [
  "1: palette shadow-rose-500/20",
  "1: palette placeholder:text-zinc-600",
  "1: palette from-teal-400",
  "1: palette via-indigo-500",
  "1: palette to-violet-600",
  "1: shadow shadow-rose-500/20",
]);
assert.deepEqual(findLegacyStyles("  color: var(--color-zinc-400);"), ["1: palette --color-zinc-400"]);
assert.deepEqual(findLegacyStyles('className="bg-[#111111] text-[#fff] shadow-[0_0_24px_rgba(190,242,100,0.3)]"'), [
  "1: arbitrary-colour bg-[#111111]",
  "1: arbitrary-colour text-[#fff]",
  "1: arbitrary-colour shadow-[0_0_24px_rgba(190,242,100,0.3)]",
  "1: legacy-hex #111111",
]);
assert.deepEqual(findLegacyStyles('className="bg-gradient-to-b bg-linear-to-r font-black tracking-[0.14em] tracking-widest"'), [
  "1: gradient bg-gradient-to-b",
  "1: gradient bg-linear-to-r",
  "1: font-black font-black",
  "1: eyebrow-tracking tracking-[0.14em]",
  "1: eyebrow-tracking tracking-widest",
]);
assert.deepEqual(findLegacyStyles("  outline-color: #BEF264;"), ["1: legacy-hex #BEF264"]);
// The pre-fix popover and full-screen viewer classes are caught.
assert.deepEqual(findLegacyStyles('className="fixed inset-0 bg-black/95 text-white hover:bg-white/10"'), [
  "1: raw-black-white bg-black/95",
  "1: raw-black-white text-white",
  "1: raw-black-white hover:bg-white/10",
]);
assert.deepEqual(findLegacyStyles('className="card-inset absolute shadow-xl shadow-black/40"'), [
  "1: raw-black-white shadow-black/40",
  "1: shadow shadow-xl",
  "1: shadow shadow-black/40",
]);
assert.deepEqual(findLegacyStyles('className="shadow focus:shadow-lg"'), ["1: shadow shadow", "1: shadow focus:shadow-lg"]);
assert.deepEqual(findLegacyStyles("    box-shadow: inset 0 0 0 1px var(--color-line);"), [], "a CSS box-shadow declaration is not a utility");
assert.deepEqual(findLegacyStyles('className="bg-bg/95 bg-surface-3 border-line" // shadowed variable, blackboard'), [], "token overlays and words pass");
assert.deepEqual(
  findLegacyStyles(
    'className="bg-surface-1 text-text-2 border-line bg-accent-tint text-accent-soft max-h-[calc(100vh-7rem)] max-[359px]:gap-1 tracking-tight tracking-[0.04em] font-bold text-red text-[11px] grid-cols-[1fr_auto] tone-good"',
  ),
  [],
  "token utilities, layout arbitrary values and small tracking pass",
);
assert.deepEqual(findLegacyStyles('const label = "Red 500 m"; // zinc-900 in prose'), [], "words without a utility prefix pass");

const files = walk(path.join(root, "src"));
const offences = [];
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  for (const hit of findLegacyStyles(readFileSync(file, "utf8"))) {
    offences.push(`${relative}:${hit}`);
  }
}
if (offences.length) {
  const byKind = {};
  for (const offence of offences) {
    const kind = offence.split(": ")[1].split(" ")[0];
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  console.error(`Legacy colour / typography styles in src (${offences.length}; ${JSON.stringify(byKind)}):`);
  for (const offence of offences) {
    console.error(`  ${offence}`);
  }
}
assert.equal(offences.length, 0, `${offences.length} legacy colour / typography styles remain in src (listed above)`);

console.log(`UI HV no-legacy-colours verification passed (${files.length} files under src).`);
