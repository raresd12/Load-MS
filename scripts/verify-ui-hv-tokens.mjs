import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  colorsEqual,
  composite,
  contrastRatio,
  parseColor,
  readRules,
  readThemeTokens,
  stripCssComments,
} from "./lib/contrast.mjs";

// Visual refresh, decision HV-5: the palette is a fixed set of Tailwind 4
// @theme tokens in src/styles.css (black #0a0a0f, violet #a78bfa, dark only)
// and every text / surface pairing the UI uses meets WCAG AA. Values are
// compared as colours (whitespace, case and "0.10" vs "0.1" do not matter).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(root, "src/styles.css"), "utf8");

const EXPECTED_TOKENS = {
  "--color-bg": "#0a0a0f",
  "--color-bg-bar": "#0d0d13",
  "--color-surface-1": "#131318",
  "--color-surface-2": "#1a1a20",
  "--color-surface-3": "#212128",
  "--color-line": "rgba(255,255,255,0.10)",
  "--color-line-accent": "rgba(167,139,250,0.35)",
  "--color-text-1": "rgba(255,255,255,0.92)",
  "--color-text-2": "rgba(255,255,255,0.70)",
  "--color-text-3": "rgba(255,255,255,0.52)",
  "--color-accent": "#a78bfa",
  "--color-accent-fg": "#2e1065",
  "--color-accent-soft": "#c4b5fd",
  "--color-accent-tint": "rgba(124,58,237,0.18)",
  "--color-accent-tint-strong": "rgba(124,58,237,0.30)",
  "--color-good": "#4ade80",
  "--color-good-tint": "rgba(74,222,128,0.15)",
  "--color-warn": "#fbbf24",
  "--color-warn-tint": "rgba(251,191,36,0.15)",
  "--color-bad": "#f87171",
  "--color-bad-tint": "rgba(248,113,113,0.15)",
};

// Self-tests of the helper against known WCAG values.
assert.equal(Math.round(contrastRatio("#ffffff", "#000000") * 100) / 100, 21);
assert.equal(contrastRatio("#777777", "#777777"), 1);
assert.equal(Math.round(contrastRatio("#767676", "#ffffff") * 100) / 100, 4.54);
assert.ok(colorsEqual("rgba(255, 255, 255, 0.1)", "rgba(255,255,255,0.10)"));
assert.ok(colorsEqual("#A78BFA", "rgb(167 139 250)"));
assert.ok(!colorsEqual("#a78bfa", "#a78bfb"));
assert.deepEqual(composite(parseColor("rgba(255,255,255,0.5)"), parseColor("#000000")), { r: 127.5, g: 127.5, b: 127.5, a: 1 });

// ------------------------------------------------------------------
// Contrast (WCAG 2.x) of the contract values, printed first so the table
// shows even while the stylesheet lags: text >= 4.5:1, the accent as a
// non-text mark >= 3:1. The token check below ties them to styles.css.
// ------------------------------------------------------------------
const color = (name) => parseColor(EXPECTED_TOKENS[`--color-${name}`]);
const over = (name, base) => composite(color(name), color(base));
const checks = [];
for (const text of ["text-1", "text-2", "text-3"]) {
  for (const surface of ["bg", "surface-1", "surface-2"]) {
    checks.push({ fg: text, on: surface, ratio: contrastRatio(color(text), color(surface)), floor: 4.5 });
  }
}
checks.push({ fg: "accent-fg", on: "accent", ratio: contrastRatio(color("accent-fg"), color("accent")), floor: 4.5 });
for (const surface of ["bg", "surface-1"]) {
  checks.push({ fg: "accent-soft", on: surface, ratio: contrastRatio(color("accent-soft"), color(surface)), floor: 4.5 });
}
// Informational blocks (warm-up, deload suggestion, the steady insight) are
// accent-soft on accent-tint laid over a card.
checks.push({
  fg: "accent-soft",
  on: "accent-tint over surface-1",
  ratio: contrastRatio(color("accent-soft"), over("accent-tint", "surface-1")),
  floor: 4.5,
});
checks.push({ fg: "accent", on: "bg", ratio: contrastRatio(color("accent"), color("bg")), floor: 3, nonText: true });
for (const status of ["good", "warn", "bad"]) {
  checks.push({
    fg: status,
    on: `${status}-tint over surface-1`,
    ratio: contrastRatio(color(status), over(`${status}-tint`, "surface-1")),
    floor: 4.5,
  });
}
console.log("HV-5 contrast table (WCAG 2.x):");
for (const check of checks) {
  console.log(
    `  ${check.fg.padEnd(11)} on ${check.on.padEnd(27)} ${check.ratio.toFixed(2).padStart(5)}:1  (floor ${check.floor}:1${check.nonText ? ", non-text" : ""})`,
  );
}
for (const check of checks) {
  assert.ok(check.ratio >= check.floor, `${check.fg} on ${check.on} is ${check.ratio.toFixed(2)}:1, below ${check.floor}:1`);
}

// ------------------------------------------------------------------
// Tokens: every one declared in @theme with exactly its value
// ------------------------------------------------------------------
const theme = readThemeTokens(css);
assert.ok(theme.found, "src/styles.css declares the palette in a Tailwind @theme block (none found)");
const missing = [];
const wrong = [];
for (const [name, expected] of Object.entries(EXPECTED_TOKENS)) {
  const actual = theme.tokens.get(name);
  if (actual === undefined) {
    missing.push(name);
  } else if (!colorsEqual(actual, expected)) {
    wrong.push(`${name}: ${actual} (expected ${expected})`);
  }
}
assert.deepEqual(missing, [], `@theme is missing tokens: ${missing.join(", ")}`);
assert.deepEqual(wrong, [], `@theme tokens with another value: ${wrong.join("; ")}`);

// ------------------------------------------------------------------
// Page background: the token, no gradient, dark only
// ------------------------------------------------------------------
const clean = stripCssComments(css);
assert.ok(!/(?:linear|radial|conic)-gradient\s*\(/i.test(clean), "styles.css has no gradient (the body gradient is gone)");
const rules = readRules(css);
const isTarget = (selector, target) => selector.split(",").some((part) => part.trim() === target);
const backgroundOf = (body) => [...body.matchAll(/(?<![\w-])background(?:-color)?\s*:\s*([^;]+);/g)].map((match) => match[1].trim());
const bodyBackgrounds = rules.filter((rule) => !rule.atRule && isTarget(rule.selector, "body")).flatMap((rule) => backgroundOf(rule.body));
assert.ok(bodyBackgrounds.length > 0, "body sets its background");
for (const value of bodyBackgrounds) {
  assert.match(value, /^var\(--color-bg\)$/, `body background uses the bg token (found "${value}")`);
}
const rootBackgrounds = rules.filter((rule) => !rule.atRule && isTarget(rule.selector, ":root")).flatMap((rule) => backgroundOf(rule.body));
for (const value of rootBackgrounds) {
  assert.match(value, /^var\(--color-bg\)$/, `:root background uses the bg token (found "${value}")`);
}
assert.ok(/(?<![\w-])color-scheme\s*:\s*dark\s*;/.test(clean), "the app stays dark only (color-scheme: dark)");
assert.ok(!/prefers-color-scheme\s*:\s*light/.test(clean), "no light theme block");

console.log(`UI HV tokens verification passed (${Object.keys(EXPECTED_TOKENS).length} tokens, ${checks.length} contrast pairs).`);
