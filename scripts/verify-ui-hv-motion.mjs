import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBlock, readRules, readThemeTokens, stripCssComments } from "./lib/contrast.mjs";

// Visual refresh, decision HV-3 (guarded here, HV-8 row in docs/decisions.md):
// motion is short and calm. The three motion classes (.page-enter,
// .set-saved, .bar-fill) run between 100 and 700 ms, a
// prefers-reduced-motion block switches animation, transition and smooth
// scrolling off, and the only Tailwind animation left in src is the spinner.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssRaw = readFileSync(path.join(root, "src/styles.css"), "utf8");
const css = stripCssComments(cssRaw);

// Custom properties declared anywhere (@theme, :root ...), to resolve var().
const variables = new Map(readThemeTokens(cssRaw).tokens);
for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
  if (!variables.has(match[1])) {
    variables.set(match[1], match[2].trim());
  }
}

function resolveVars(value, depth = 0) {
  if (depth > 5) {
    return value;
  }
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fallback) => {
    const resolved = variables.get(name) ?? fallback;
    return resolved === undefined ? whole : resolveVars(resolved, depth + 1);
  });
}

function toMs(text) {
  const match = /^(-?\d*\.?\d+)(ms|s)$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  return Number.parseFloat(match[1]) * (match[2].toLowerCase() === "s" ? 1000 : 1);
}

// Splits on a separator outside parentheses (cubic-bezier(0, 0, 0.2, 1)).
function splitTop(value, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && (separator === " " ? /\s/.test(char) : char === separator)) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

// Durations of a declaration block: the first time of each comma-separated
// `animation` / `transition` shorthand (the second is the delay) and every
// value of `animation-duration` / `transition-duration`.
function durationsOf(body) {
  const durations = [];
  for (const match of body.matchAll(/(?<![\w-])(animation|transition)(-duration)?\s*:\s*([^;]+);/g)) {
    const value = resolveVars(match[3]);
    for (const part of splitTop(value, ",")) {
      const times = splitTop(part, " ").map(toMs).filter((time) => time !== null);
      if (match[2]) {
        durations.push(...times);
      } else if (times.length) {
        durations.push(times[0]);
      }
    }
  }
  return durations;
}

function animationNames(body) {
  const names = [];
  for (const match of body.matchAll(/(?<![\w-])animation(-name)?\s*:\s*([^;]+);/g)) {
    for (const part of splitTop(resolveVars(match[2]), ",")) {
      const words = splitTop(part, " ").filter((word) => !toMs(word) && !/^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|infinite|both|forwards|backwards|none|normal|reverse|alternate|alternate-reverse|running|paused|\d+(?:\.\d+)?|cubic-bezier\(.*\)|steps\(.*\))$/.test(word));
      names.push(...words);
    }
  }
  return names;
}

// Self-tests.
assert.deepEqual(durationsOf("animation: page-enter 220ms ease-out both;"), [220]);
assert.deepEqual(durationsOf("transition: width 0.4s ease 50ms, opacity 150ms;"), [400, 150]);
assert.deepEqual(durationsOf("transition-duration: 120ms, 0.3s;"), [120, 300]);
assert.deepEqual(animationNames("animation: set-saved 600ms ease-out 1;"), ["set-saved"]);
assert.deepEqual(animationNames("animation: page-enter 220ms cubic-bezier(0.2, 0, 0, 1) both;"), ["page-enter"]);
assert.deepEqual(durationsOf("transition: width 400ms cubic-bezier(0.2, 0, 0, 1), opacity 150ms;"), [400, 150]);

// ------------------------------------------------------------------
// prefers-reduced-motion
// ------------------------------------------------------------------
const reduceMatch = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/.exec(css);
assert.ok(reduceMatch, "styles.css has a @media (prefers-reduced-motion: reduce) block");
const reduce = readBlock(css, reduceMatch.index + reduceMatch[0].length - 1).body;
const reduceDeclaration = (property) => new RegExp(`(?<![\\w-])${property}\\s*:\\s*([^;]+);`).exec(reduce)?.[1].replace(/!important/, "").trim();
for (const property of ["animation-duration", "transition-duration"]) {
  const value = reduceDeclaration(property);
  assert.ok(value !== undefined, `the reduced-motion block sets ${property}`);
  const ms = toMs(value);
  assert.ok(ms !== null && ms <= 1, `the reduced-motion block makes ${property} near zero (found "${value}")`);
}
assert.equal(reduceDeclaration("animation-iteration-count"), "1", "the reduced-motion block stops looping animations (animation-iteration-count: 1)");
assert.equal(reduceDeclaration("scroll-behavior"), "auto", "the reduced-motion block turns smooth scrolling off (scroll-behavior: auto)");
assert.ok(/(?:^|[\s,{])\*(?:\s*,|\s*\{|::)/.test(reduce), "the reduced-motion block applies to every element (*)");

// ------------------------------------------------------------------
// The three motion classes
// ------------------------------------------------------------------
const baseRules = readRules(css).filter((rule) => !/prefers-reduced-motion/.test(rule.atRule ?? ""));
const keyframes = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]));
for (const className of ["page-enter", "set-saved", "bar-fill"]) {
  const selector = new RegExp(`\\.${className}(?![\\w-])`);
  const rules = baseRules.filter((rule) => selector.test(rule.selector));
  assert.ok(rules.length > 0, `styles.css defines .${className}`);
  const durations = rules.flatMap((rule) => durationsOf(rule.body));
  assert.ok(durations.length > 0, `.${className} declares an animation or transition duration`);
  for (const duration of durations) {
    assert.ok(duration >= 100 && duration <= 700, `.${className} runs ${duration} ms, expected 100-700 ms`);
  }
  for (const name of rules.flatMap((rule) => animationNames(rule.body))) {
    assert.ok(keyframes.has(name), `.${className} animates @keyframes ${name}, which styles.css defines`);
  }
}

// ------------------------------------------------------------------
// Tailwind animation utilities: only animate-spin
// ------------------------------------------------------------------
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
const ANIMATE = /(?<![\w-])(?:[\w-]+(?:\[[^\]\s]*\])?:)*animate-(?!spin(?![\w-]))[\w[\]-]+/g;
assert.deepEqual("animate-spin motion-safe:animate-pulse animate-bounce hover:animate-[wiggle_1s]".match(ANIMATE), [
  "motion-safe:animate-pulse",
  "animate-bounce",
  "hover:animate-[wiggle_1s]",
]);
const animated = [];
for (const file of walk(path.join(root, "src"))) {
  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(ANIMATE)) {
      animated.push(`${path.relative(root, file).split(path.sep).join("/")}:${index + 1}: ${match[0]}`);
    }
  });
}
assert.deepEqual(animated, [], `Tailwind animations other than animate-spin: ${animated.join("; ")}`);

console.log("UI HV motion verification passed (reduced-motion block, .page-enter / .set-saved / .bar-fill within 100-700 ms).");
