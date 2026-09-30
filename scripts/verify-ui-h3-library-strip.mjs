// Library filter strip (decision H3-28): the horizontally scrolling filter row
// holds `sr-only` labels, which are absolutely positioned. A scroll container
// that is not positioned is not their containing block, so their boxes escaped
// the strip and widened the whole document (scrollWidth 1170 at 375 px, 1194
// at 1024 px): the page could pan sideways. `relative` on the strip keeps them
// inside it. This fixture pins the class and the shape of the strip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/pages/LibraryPage.jsx", import.meta.url), "utf8");

const strips = [...source.matchAll(/className="([^"]*\boverflow-x-auto\b[^"]*)"/g)].map((match) => match[1]);
assert.equal(strips.length, 1, "LibraryPage has exactly one horizontally scrolling strip");

const [strip] = strips;
const classes = strip.split(/\s+/);
assert.ok(classes.includes("relative"), "the strip is positioned, so sr-only labels inside it are clipped by it");
assert.ok(classes.includes("overflow-x-auto"), "the strip scrolls sideways on its own");
assert.ok(
  !classes.some((name) => /^(?:absolute|fixed|sticky|static)$/.test(name)),
  "no other position class competes with relative",
);

// The labels the strip clips: one visually hidden label per filter select.
assert.match(source, /<span className="sr-only">\{label\}<\/span>/, "filter selects keep their sr-only labels");

// The shell itself does not scroll sideways (H3-24): the fix is on the strip,
// not on a parent with overflow hidden, which would defeat sticky positioning.
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.ok(!/overflow-x-hidden/.test(app), "App.jsx does not use overflow-x-hidden on the shell");

console.log("verify-ui-h3-library-strip: ok");
