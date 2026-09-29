// H4 fix round 3: every identifier a source file uses is declared or imported,
// every named import exists in the module it comes from, and no import is left
// unused. `vite build` does not check any of this (an undefined name is a
// ReferenceError at render time: moving the Save Set helpers out of
// UnifiedSetEntry.jsx without importing them back crashed the Workout Log
// while `npm test` and `npm run build` were green).
//
// Uses @babel/parser + @babel/traverse, which are installed with
// vite-plugin-pwa (workbox-build). Source check only; nothing is executed.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverseModule = require("@babel/traverse");
const traverse = traverseModule.default ?? traverseModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

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

// Names the runtime provides (browser + the few Node-safe guards the lib uses).
const KNOWN_GLOBALS = new Set([
  "window", "document", "navigator", "location", "globalThis", "console", "undefined", "NaN", "Infinity",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Date", "RegExp",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect", "Intl",
  "Error", "TypeError", "RangeError", "SyntaxError", "DOMException",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "queueMicrotask", "structuredClone", "fetch", "AbortController", "AbortSignal", "Headers", "Request", "Response",
  "URL", "URLSearchParams", "Blob", "File", "FileReader", "FormData", "TextEncoder", "TextDecoder",
  "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array", "Float32Array", "Float64Array", "ArrayBuffer", "DataView",
  "crypto", "atob", "btoa", "performance", "localStorage", "sessionStorage", "caches", "indexedDB",
  "CustomEvent", "Event", "EventTarget", "HTMLElement", "Element", "Node", "Image",
  "alert", "confirm", "prompt", "matchMedia", "getComputedStyle", "visualViewport", "history", "screen",
  "ResizeObserver", "IntersectionObserver", "MutationObserver",
  "arguments",
]);

function analyse(file) {
  const code = readFileSync(file, "utf8");
  const ast = parse(code, { sourceType: "module", plugins: ["jsx"], errorRecovery: false });
  const unresolved = new Map();
  const imports = [];
  const exportsFound = new Set();
  let exportsAll = false;
  let programScope = null;

  traverse(ast, {
    Program(programPath) {
      programScope = programPath.scope;
      for (const [name, locations] of Object.entries(programPath.scope.globals)) {
        if (!KNOWN_GLOBALS.has(name)) {
          unresolved.set(name, locations.loc?.start.line ?? 0);
        }
      }
    },
    ImportDeclaration(importPath) {
      const source = importPath.node.source.value;
      for (const specifier of importPath.node.specifiers) {
        imports.push({
          source,
          local: specifier.local.name,
          imported:
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : specifier.type === "ImportNamespaceSpecifier"
                ? "*"
                : specifier.imported.name ?? specifier.imported.value,
          line: specifier.loc.start.line,
        });
      }
    },
    ExportNamedDeclaration(exportPath) {
      const { declaration, specifiers } = exportPath.node;
      if (declaration?.id?.name) {
        exportsFound.add(declaration.id.name);
      }
      for (const declarator of declaration?.declarations ?? []) {
        if (declarator.id.type === "Identifier") {
          exportsFound.add(declarator.id.name);
        }
      }
      for (const specifier of specifiers ?? []) {
        exportsFound.add(specifier.exported.name ?? specifier.exported.value);
      }
    },
    ExportDefaultDeclaration() {
      exportsFound.add("default");
    },
    ExportAllDeclaration() {
      exportsAll = true;
    },
  });

  const unused = imports.filter((entry) => {
    const binding = programScope.getBinding(entry.local);
    return binding && !binding.referenced;
  });

  return { unresolved, imports, unused, exportsFound, exportsAll };
}

const files = walk(srcDir);
assert.ok(files.length > 40, `source files found (${files.length})`);
const analysed = new Map(files.map((file) => [file, analyse(file)]));

// The check catches what it is for.
{
  const sample = parse('import { a, b } from "./x.js"; export function f() { return a(missing); }', { sourceType: "module", plugins: ["jsx"] });
  let globals = null;
  let unusedB = null;
  traverse(sample, {
    Program(programPath) {
      globals = Object.keys(programPath.scope.globals);
      unusedB = !programPath.scope.getBinding("b").referenced;
    },
  });
  assert.deepEqual(globals, ["missing"], "an undeclared name is reported");
  assert.equal(unusedB, true, "an unused import is reported");
}

const problems = [];
let importCount = 0;

for (const [file, result] of analysed) {
  const relative = path.relative(root, file).replace(/\\/g, "/");

  for (const [name, line] of result.unresolved) {
    problems.push(`${relative}:${line} uses "${name}", which is neither declared nor imported`);
  }

  for (const entry of result.unused) {
    problems.push(`${relative}:${entry.line} imports "${entry.local}" from "${entry.source}" and never uses it`);
  }

  for (const entry of result.imports) {
    if (!entry.source.startsWith(".")) {
      continue;
    }

    importCount += 1;
    const target = path.resolve(path.dirname(file), entry.source);

    if (!/\.(js|jsx)$/.test(target)) {
      assert.ok(existsSync(target), `${relative}:${entry.line} imports ${entry.source}, which does not exist`);
      continue;
    }

    const targetResult = analysed.get(target);

    if (!targetResult) {
      problems.push(`${relative}:${entry.line} imports "${entry.source}", which does not exist`);
      continue;
    }

    if (entry.imported !== "*" && !targetResult.exportsAll && !targetResult.exportsFound.has(entry.imported)) {
      problems.push(`${relative}:${entry.line} imports "${entry.imported}" from "${entry.source}", which does not export it`);
    }
  }
}

assert.deepEqual(problems, [], `unresolved references / imports:\n${problems.join("\n")}`);

console.log(`UI H4 reference verification passed (${files.length} files, ${importCount} local imports resolved, no undeclared name, no unused import).`);
