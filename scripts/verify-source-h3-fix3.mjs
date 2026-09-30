// H3 fix round 3, text files that are not UTF-8 (decision H3-22):
// - a .txt / .md / .csv saved in an 8-bit code page (Windows-1250 /
//   ISO-8859-2, the usual ones for Romanian text) is read as Windows-1250 and
//   the source says so: never broken letters without a word about it
// - text whose letters were already lost (U+FFFD) carries a warning
// - bytes that are neither UTF-8 nor plausible 8-bit text are refused
// - UTF-8 text, with or without a byte-order mark, is as before
// - the office parser is loaded only when a DOCX / XLSX is read (H3-23)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LEGACY_ENCODING_TEXT_WARNING,
  LOST_CHARACTERS_TEXT_WARNING,
  OFFICE_READER_LOAD_ERROR,
  readSourceFile,
  UNKNOWN_ENCODING_TEXT_ERROR,
} from "../src/lib/sourceFiles.js";

function blobLike(name, type, bytes) {
  return {
    name,
    type,
    size: bytes.length,
    text: async () => new TextDecoder("utf-8").decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

// Windows-1250 / ISO-8859-2 bytes of the Romanian letters (the same in both).
const CP1250 = { ă: 0xe3, â: 0xe2, î: 0xee, ş: 0xba, ţ: 0xfe, Ă: 0xc3, Â: 0xc2, Î: 0xce, Ş: 0xaa, Ţ: 0xde };
const toCp1250 = (text) =>
  Uint8Array.from([...text].map((char) => (char.charCodeAt(0) < 0x80 ? char.charCodeAt(0) : CP1250[char])));

const program = [
  "Ziua 1 - Împins",
  "Împins la bancă 4x6 @ 80 kg, pauză 2-3 min",
  "Flotări la paralele 3x10",
  "Ridicări laterale cu gantere 3x12, fără balans",
  "Notă: încălzire 10 minute, apoi câte un set uşor",
  "Ţine spatele drept şi coboară controlat",
].join("\r\n");

// ---------------------------------------------------------------------------
// 1. A legacy code page is decoded and disclosed
// ---------------------------------------------------------------------------
{
  const bytes = toCp1250(program);
  assert.ok(!bytes.includes(undefined) && bytes.length === program.length);
  assert.ok(new TextDecoder("utf-8").decode(bytes).includes("�"), "the sample is not UTF-8");

  for (const [name, type] of [
    ["plan.txt", "text/plain"],
    ["plan.csv", "text/csv"],
    ["plan.md", "text/markdown"],
  ]) {
    const source = await readSourceFile(blobLike(name, type, bytes));
    assert.equal(source.ok, true, source.error);
    assert.equal(source.kind, "text");
    assert.equal(source.text, program.replace(/\r\n/g, "\n"), `${name}: every letter is read`);
    assert.ok(!source.text.includes("�"));
    assert.deepEqual(source.meta.warnings, [LEGACY_ENCODING_TEXT_WARNING]);
    assert.equal(source.meta.origin, "file");
  }

  assert.match(LEGACY_ENCODING_TEXT_WARNING, /not saved as UTF-8/);
  assert.match(LEGACY_ENCODING_TEXT_WARNING, /Windows-1250/);
  assert.match(LEGACY_ENCODING_TEXT_WARNING, /Check/);

  // One stray byte in an otherwise ASCII file.
  const single = await readSourceFile(blobLike("plan.txt", "text/plain", toCp1250("Day 1\nGenuflexiuni 5x5\nPauză 3 min")));
  assert.equal(single.ok, true, single.error);
  assert.equal(single.text, "Day 1\nGenuflexiuni 5x5\nPauză 3 min");
  assert.deepEqual(single.meta.warnings, [LEGACY_ENCODING_TEXT_WARNING]);
}

// ---------------------------------------------------------------------------
// 2. UTF-8 is as before
// ---------------------------------------------------------------------------
{
  const utf8Program = "Ziua 1\nÎmpins la bancă 4x6\nȘezi drept, ține pieptul sus\n日本語 🙂";
  const plain = await readSourceFile(blobLike("plan.txt", "text/plain", new TextEncoder().encode(utf8Program)));
  assert.equal(plain.ok, true, plain.error);
  assert.equal(plain.text, utf8Program);
  assert.deepEqual(plain.meta.warnings, []);

  const withBom = await readSourceFile(
    blobLike("plan.txt", "text/plain", Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(utf8Program)])),
  );
  assert.equal(withBom.text, utf8Program);
  assert.deepEqual(withBom.meta.warnings, []);

  const sample = new Uint8Array(readFileSync(new URL("../fixtures/import-samples/program-sections.txt", import.meta.url)));
  const fromSample = await readSourceFile(blobLike("program-sections.txt", "text/plain", sample));
  assert.equal(fromSample.ok, true);
  assert.deepEqual(fromSample.meta.warnings, []);
}

// ---------------------------------------------------------------------------
// 3. Letters that are already lost are disclosed
// ---------------------------------------------------------------------------
{
  // Valid UTF-8 that holds U+FFFD: the file was broken before it was saved.
  const broken = "Ziua 1\n�mpins la banc� 4x6";
  const fromBytes = await readSourceFile(blobLike("plan.txt", "text/plain", new TextEncoder().encode(broken)));
  assert.equal(fromBytes.ok, true, fromBytes.error);
  assert.equal(fromBytes.text, broken);
  assert.deepEqual(fromBytes.meta.warnings, [LOST_CHARACTERS_TEXT_WARNING]);

  // A text reader hands over decoded text only: what it could not decode is said.
  const fromReader = await readSourceFile(
    { name: "plan.txt", type: "text/plain", size: program.length },
    { readAsText: async () => new TextDecoder("utf-8").decode(toCp1250(program)) },
  );
  assert.equal(fromReader.ok, true, fromReader.error);
  assert.ok(fromReader.text.includes("�"));
  assert.deepEqual(fromReader.meta.warnings, [LOST_CHARACTERS_TEXT_WARNING]);
  assert.match(LOST_CHARACTERS_TEXT_WARNING, /could not be read/);

  const cleanReader = await readSourceFile(
    { name: "plan.txt", type: "text/plain", size: 20 },
    { readAsText: async () => "Day 1\nSquat 5x5" },
  );
  assert.deepEqual(cleanReader.meta.warnings, []);
}

// ---------------------------------------------------------------------------
// 4. Neither UTF-8 nor plausible 8-bit text: refused with a next step
// ---------------------------------------------------------------------------
{
  // Windows-1251 (Cyrillic): almost every letter is a high byte.
  const cyrillic = Uint8Array.from(
    [..."День 1\nЖим лёжа 4x6\nПриседания 5x5\nТяга в наклоне 3x8"].map((char) => {
      const code = char.charCodeAt(0);
      if (code < 0x80) return code;
      if (char === "ё") return 0xb8;
      return code - 0x410 + 0xc0;
    }),
  );
  const refused = await readSourceFile(blobLike("plan.txt", "text/plain", cyrillic));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, UNKNOWN_ENCODING_TEXT_ERROR);
  assert.match(refused.error, /UTF-8/);
  assert.match(refused.error, /copy\/paste/);
  assert.ok(!("text" in refused));
  assert.deepEqual(refused.files, []);

  // Binary noise is still binary.
  const noise = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7919 + 13) % 256);
  const binary = await readSourceFile(blobLike("plan.txt", "text/plain", noise));
  assert.equal(binary.ok, false);
  assert.match(binary.error, /not readable text/);
}

// ---------------------------------------------------------------------------
// 5. The office parser is not part of the module graph of a text pick
// ---------------------------------------------------------------------------
{
  // A DOCX is still read through the lazy parser.
  const docx = new Uint8Array(readFileSync(new URL("../fixtures/import-samples/program.docx", import.meta.url)));
  const expected = JSON.parse(readFileSync(new URL("../fixtures/import-samples/expected/program.docx.json", import.meta.url), "utf8"));
  const read = await readSourceFile(
    blobLike("program.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx),
  );
  assert.equal(read.ok, true, read.error);
  assert.equal(read.text, expected.text);

  const code = readFileSync(new URL("../src/lib/sourceFiles.js", import.meta.url), "utf8");
  assert.ok(!/^import\s[^;]*["']\.\/officeText\.js["']/m.test(code), "officeText.js is never a static import of sourceFiles.js");
  assert.match(code, /await import\("\.\/officeText\.js"\)/, "it is loaded when a DOCX / XLSX is read");
  assert.match(
    code,
    /try \{\s+office = await import\("\.\/officeText\.js"\);\s+\} catch \{\s+return failure\(OFFICE_READER_LOAD_ERROR\);/,
    "a parser that cannot be loaded is a stated failure",
  );
  assert.equal(
    OFFICE_READER_LOAD_ERROR,
    "The Word / Excel reader could not be loaded. Check the connection and try again, or paste the text.",
  );
  const vite = readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
  assert.match(vite, /name: "vendor-fflate"/, "the zip library has a named chunk");
}

console.log("verify-source-h3-fix3: ok");
