import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Visual refresh, decision HV-7: labels are sentence case. The old uppercase
// wide-tracked eyebrows became the `.label` component class; `uppercase` is
// left only where a file is listed in UPPERCASE_ALLOWED (genuine acronyms or
// unit chips, at most 6 in all), the stylesheet transforms nothing to
// uppercase, and no JSX text is written in capitals except real acronyms.
// Source check only (@babel/parser + @babel/traverse, as in
// verify-ui-h4-references.mjs); nothing is executed.

const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverseModule = require("@babel/traverse");
const traverse = traverseModule.default ?? traverseModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, pattern, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, pattern, out);
    } else if (pattern.test(name)) {
      out.push(full);
    }
  }
  return out;
}
const rel = (file) => path.relative(root, file).split(path.sep).join("/");

// file -> { count, reason }. Empty: every eyebrow in the tree was a styled
// word, and acronyms (RPE, BW, AMRAP, e1RM) are already written in capitals,
// so none needs `uppercase`. An entry needs a reason; the total stays <= 6.
const UPPERCASE_ALLOWED = {};
const UPPERCASE_MAX_TOTAL = 6;
const LABEL_MIN_USES = 40;
// Words of five or more capitals allowed in JSX text: acronyms and the typed
// confirmation keyword of Settings > Reset (the user must type it exactly).
const ALL_CAPS_ALLOWED = new Set(["AMRAP", "EMOM", "RESET", "DOCX", "XLSX"]);

const UPPERCASE = /(?<![\w-])(?:[\w-]+(?:\[[^\]\s]*\])?:)*uppercase(?![\w-])/g;
const countUppercase = (text) => (text.match(UPPERCASE) ?? []).length;

function parseJsx(code, file) {
  try {
    return parse(code, { sourceType: "module", plugins: ["jsx"] });
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

function stringsIn(node, out = []) {
  if (!node || typeof node !== "object") {
    return out;
  }
  if (node.type === "StringLiteral") {
    out.push(node.value);
  } else if (node.type === "TemplateElement") {
    out.push(node.value.cooked ?? node.value.raw);
  }
  for (const key of Object.keys(node)) {
    if (["loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "extra"].includes(key)) {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((child) => stringsIn(child, out));
    } else if (value && typeof value.type === "string") {
      stringsIn(value, out);
    }
  }
  return out;
}

const hasLabelClass = (strings) => strings.some((value) => value.split(/\s+/).some((token) => token === "label" || token === "label-accent"));

// Counts className attributes (and *className / *Class / *Classes constants)
// that apply .label or .label-accent; returns ALL CAPS words in JSX text.
function inspect(code, file) {
  const ast = parseJsx(code, file);
  let labelUses = 0;
  const allCaps = [];
  const visitText = (value, line) => {
    for (const match of value.matchAll(/(?<![A-Za-z0-9])[A-Z]{5,}(?![A-Za-z0-9])/g)) {
      if (!ALL_CAPS_ALLOWED.has(match[0])) {
        allCaps.push(`${file}:${line}: "${match[0]}"`);
      }
    }
  };
  traverse(ast, {
    JSXAttribute(nodePath) {
      if (nodePath.node.name.name === "className" && hasLabelClass(stringsIn(nodePath.node.value))) {
        labelUses += 1;
      }
    },
    VariableDeclarator(nodePath) {
      const name = nodePath.node.id?.name ?? "";
      if (/class(?:Name|es)?$/i.test(name) && hasLabelClass(stringsIn(nodePath.node.init))) {
        labelUses += 1;
      }
    },
    JSXText(nodePath) {
      visitText(nodePath.node.value, nodePath.node.loc.start.line);
    },
    JSXExpressionContainer(nodePath) {
      const expression = nodePath.node.expression;
      if (nodePath.parent.type !== "JSXAttribute" && expression.type === "StringLiteral") {
        visitText(expression.value, expression.loc.start.line);
      }
    },
  });
  return { labelUses, allCaps };
}

// The checks themselves.
assert.equal(countUppercase('className="text-xs font-bold uppercase tracking-[0.12em]" sm:uppercase'), 2);
assert.equal(countUppercase('className="normal-case" // uppercaseLetters'), 0);
{
  const sample = inspect(
    [
      'const headerClassName = "label text-sm";',
      "export function A({ on }) {",
      '  return <div className="card"><p className="label">Sets</p><p className={`label-accent ${on ? "x" : ""}`}>Next</p>',
      '  <p className={cx("label", on)}>WARNING here</p><span>RPE AMRAP</span>{"SAVED"}<b title="ALLCAPS">e1RM</b></div>;',
      "}",
    ].join("\n"),
    "sample.jsx",
  );
  assert.equal(sample.labelUses, 4, "className attributes and a class constant using .label / .label-accent");
  assert.deepEqual(sample.allCaps, ['sample.jsx:4: "WARNING"', 'sample.jsx:4: "SAVED"'], "capitals in text, not acronyms or attributes");
}

// ------------------------------------------------------------------
// The tree
// ------------------------------------------------------------------
const allowedTotal = Object.values(UPPERCASE_ALLOWED).reduce((sum, entry) => sum + entry.count, 0);
assert.ok(allowedTotal <= UPPERCASE_MAX_TOTAL, `the uppercase whitelist allows ${allowedTotal}, at most ${UPPERCASE_MAX_TOTAL}`);
for (const [file, entry] of Object.entries(UPPERCASE_ALLOWED)) {
  assert.ok(entry.reason && entry.count > 0, `${file}: a whitelist entry needs a count and a reason`);
}

const sourceFiles = walk(path.join(root, "src"), /\.(js|jsx)$/);
const uppercaseByFile = {};
for (const file of sourceFiles) {
  const count = countUppercase(readFileSync(file, "utf8"));
  if (count) {
    uppercaseByFile[rel(file)] = count;
  }
}
const uppercaseTotal = Object.values(uppercaseByFile).reduce((sum, count) => sum + count, 0);
const overAllowance = Object.entries(uppercaseByFile)
  .filter(([file, count]) => count > (UPPERCASE_ALLOWED[file]?.count ?? 0))
  .map(([file, count]) => `${file} (${count}, allowed ${UPPERCASE_ALLOWED[file]?.count ?? 0})`);
assert.deepEqual(
  overAllowance,
  [],
  `\`uppercase\` remains outside the HV-7 whitelist (${uppercaseTotal} in src): ${overAllowance.join(", ")}`,
);
assert.ok(uppercaseTotal <= UPPERCASE_MAX_TOTAL, `${uppercaseTotal} uppercase classes, at most ${UPPERCASE_MAX_TOTAL}`);

const css = readFileSync(path.join(root, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(!/text-transform\s*:\s*uppercase/i.test(css), "styles.css transforms no text to uppercase (.label is sentence case)");
assert.ok(/(?:^|[},\s])\.label(?![\w-])[^{]*\{/.test(css), "styles.css defines the .label component class");

const uiFiles = [...walk(path.join(root, "src/pages"), /\.jsx?$/), ...walk(path.join(root, "src/components"), /\.jsx?$/)];
let labelUses = 0;
const allCaps = [];
for (const file of [path.join(root, "src/App.jsx"), ...uiFiles]) {
  const result = inspect(readFileSync(file, "utf8"), rel(file));
  if (file !== path.join(root, "src/App.jsx")) {
    labelUses += result.labelUses;
  }
  allCaps.push(...result.allCaps);
}
assert.ok(labelUses >= LABEL_MIN_USES, `.label is applied ${labelUses} times across src/pages and src/components, expected at least ${LABEL_MIN_USES}`);
assert.deepEqual(allCaps, [], `JSX text written in capitals (sentence case, HV-7): ${allCaps.join("; ")}`);

console.log(`UI HV labels verification passed (${uppercaseTotal} uppercase, ${labelUses} .label uses, ${uiFiles.length + 1} UI files).`);
