// H3 fix round 2, office files (decision H3-14): a small forged DOCX / XLSX
// can neither fill the memory of the tab nor keep it busy.
// - only the part that is read is inflated (DOCX: the package relationships,
//   then ONE main part), and one file never inflates more than maxTotalBytes
// - a directory whose entries share local data is refused
// - a sheet is walked with a bounded amount of work: empty rows and cells
//   past the column limit count, and a part is walked once
//
// The proofs are deterministic where they can be: a part that must not be
// inflated is forged so that inflating it would refuse the whole file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync, strToU8, zipSync } from "fflate";

import { extractDocxText, extractXlsxText, OFFICE_TEXT_DEFAULTS } from "../src/lib/officeText.js";
import { readSourceFile, DOCX_MIME_TYPE, XLSX_MIME_TYPE } from "../src/lib/sourceFiles.js";

const samplesDir = new URL("../fixtures/import-samples/", import.meta.url);
const readSample = (name) => new Uint8Array(readFileSync(new URL(name, samplesDir)));
const readExpected = (name) => JSON.parse(readFileSync(new URL(`expected/${name}.json`, samplesDir), "utf8"));

const MIB = 1024 * 1024;
const ZIP_TIME = new Date(2026, 0, 1);
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const documentXml = (body) => `<?xml version="1.0"?><w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;
const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

function zip(files) {
  const entries = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(entries, { mtime: ZIP_TIME });
}

const u16 = (value) => [value & 255, (value >> 8) & 255];
const u32 = (value) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255];

/**
 * A zip written by hand: `entries` are deflated parts, `aliases` are further
 * central-directory entries that point at the local header of entry `of`.
 */
function buildZip(entries, aliases = []) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const packed = deflateSync(raw, { level: 9 });
    const header = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0),
      ...u32(0), ...u32(packed.length), ...u32(raw.length), ...u16(name.length), ...u16(0),
    ]);
    central.push({ name: entry.name, packed: packed.length, size: raw.length, offset });
    chunks.push(header, name, packed);
    offset += header.length + name.length + packed.length;
  }

  aliases.forEach((alias) => central.push({ ...central[alias.of], name: alias.name }));

  const directoryStart = offset;

  for (const entry of central) {
    const name = encoder.encode(entry.name);
    const header = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0),
      ...u32(0), ...u32(entry.packed), ...u32(entry.size), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(entry.offset),
    ]);
    chunks.push(header, name);
    offset += header.length + name.length;
  }

  chunks.push(
    new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
      ...u32(offset - directoryStart), ...u32(directoryStart), ...u16(0),
    ]),
  );

  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let position = 0;

  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }

  return out;
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeU32(bytes, offset, value) {
  bytes.set(u32(value), offset);
}

/**
 * The file with a wrong declared size for one part (directory and local
 * header): inflating that part refuses the whole file (H3-11), so a file that
 * is still read proves the part was never inflated.
 */
function withPoisonedPart(bytes, partName) {
  const copy = bytes.slice();
  let end = copy.length - 22;

  while (end >= 0 && readU32(copy, end) !== 0x06054b50) {
    end -= 1;
  }

  assert.ok(end >= 0, "end record");
  let cursor = readU32(copy, end + 16);
  let done = false;

  for (let index = 0; index < readU16(copy, end + 10); index += 1) {
    const nameLength = readU16(copy, cursor + 28);
    const name = new TextDecoder().decode(copy.subarray(cursor + 46, cursor + 46 + nameLength));

    if (name === partName) {
      const size = readU32(copy, cursor + 24) + 1;
      writeU32(copy, cursor + 24, size);
      writeU32(copy, readU32(copy, cursor + 42) + 22, size);
      done = true;
    }

    cursor += 46 + nameLength + readU16(copy, cursor + 30) + readU16(copy, cursor + 32);
  }

  assert.ok(done, `${partName} is in the zip`);
  return copy;
}

async function timed(run) {
  const started = performance.now();
  const result = await run();
  return { result, ms: performance.now() - started };
}

const DAMAGED = /damaged or encrypted and could not be opened/;

assert.equal(OFFICE_TEXT_DEFAULTS.maxPartBytes, 24 * MIB);
assert.equal(OFFICE_TEXT_DEFAULTS.maxTotalBytes, 48 * MIB);
assert.equal(OFFICE_TEXT_DEFAULTS.maxXmlTokens, 1000000);

// ---------------------------------------------------------------------------
// 1. DOCX: the overlapping-entry bomb is refused before anything is inflated
// ---------------------------------------------------------------------------
{
  const bomb = new Uint8Array(24 * MIB - 10);
  const entries = [
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: documentXml(paragraph("Squat 5x5")) },
    { name: "word/xdocument.xml", data: bomb },
  ];
  const aliases = Array.from({ length: 40 }, (_, index) => ({ name: `word/document${index}.xml`, of: 2 }));
  const file = buildZip(entries, aliases);
  assert.ok(file.length < 64 * 1024, "the file is a few kilobytes");

  const { result, ms } = await timed(() => extractDocxText(file));
  assert.equal(result.text, "");
  assert.match(result.meta.warnings[0], DAMAGED);
  assert.ok(ms < 2000, `refused at once (${Math.round(ms)} ms)`);

  // One alias is enough, and the XLSX reader refuses the same way.
  assert.match((await extractDocxText(buildZip(entries, [{ name: "word/other.xml", of: 1 }]))).meta.warnings[0], DAMAGED);
  const sheetEntries = [
    { name: "xl/workbook.xml", data: `<workbook xmlns="${S_NS}" xmlns:r="${R_NS}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<Relationships xmlns="${P_NS}"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet xmlns="${S_NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>` },
  ];
  assert.equal((await extractXlsxText(buildZip(sheetEntries))).text, "## Sheet: A\n1", "the hand-written zip itself is readable");
  assert.match(
    (await extractXlsxText(buildZip(sheetEntries, [{ name: "xl/worksheets/sheet2.xml", of: 2 }]))).meta.warnings[0],
    DAMAGED,
  );

  // Through the picker: a message, never an exception.
  const picked = await readSourceFile(
    { name: "bomb.docx", type: DOCX_MIME_TYPE, size: file.length },
    { readAsArrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.length) },
  );
  assert.equal(picked.ok, false);
  assert.match(picked.error, DAMAGED);
}

// ---------------------------------------------------------------------------
// 2. DOCX: only the main part is inflated
// ---------------------------------------------------------------------------
{
  const extras = ["word/document2.xml", "word/xdocument.xml", "word/mydocument-old.xml", "word/styles.xml", "word/header1.xml"];
  let file = zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": documentXml(paragraph("Squat 5x5")),
    ...Object.fromEntries(extras.map((name) => [name, documentXml(paragraph(`not read ${name}`))])),
  });
  extras.forEach((name) => {
    file = withPoisonedPart(file, name);
  });

  const result = await extractDocxText(file);
  assert.equal(result.text, "Squat 5x5", "parts that are not read are not inflated");
  assert.deepEqual(result.meta.warnings, []);

  // The check of the proof: the same forgery on the part that IS read refuses the file.
  assert.match((await extractDocxText(withPoisonedPart(file, "word/document.xml"))).meta.warnings[0], DAMAGED);

  // A main part named by the package relationships: that one, and only that one.
  let renamed = zip({
    "_rels/.rels": `<Relationships xmlns="${P_NS}"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document2.xml"/></Relationships>`,
    "word/document2.xml": documentXml(paragraph("Bench 3x8")),
    "word/document3.xml": documentXml(paragraph("not read")),
  });
  renamed = withPoisonedPart(renamed, "word/document3.xml");
  assert.equal((await extractDocxText(renamed)).text, "Bench 3x8");

  // Large parts next to the document cost nothing.
  const big = zip({
    "word/document.xml": documentXml(paragraph("Row 3x10")),
    "word/document-a.xml": new Uint8Array(20 * MIB),
    "word/document-b.xml": new Uint8Array(20 * MIB),
    "word/document-c.xml": new Uint8Array(20 * MIB),
  });
  assert.ok(big.length < MIB);
  const { result: bigResult, ms } = await timed(() => extractDocxText(big));
  assert.equal(bigResult.text, "Row 3x10");
  assert.ok(ms < 2000, `60 MiB of other parts are not touched (${Math.round(ms)} ms)`);
}

// ---------------------------------------------------------------------------
// 3. XLSX: one file never inflates more than maxTotalBytes
// ---------------------------------------------------------------------------
const workbook = (names, target = (index) => `worksheets/sheet${index + 1}.xml`) => ({
  "xl/workbook.xml": `<workbook xmlns="${S_NS}" xmlns:r="${R_NS}"><sheets>${names
    .map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("")}</sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${P_NS}">${names
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="${R_NS}/worksheet" Target="${target(index)}"/>`)
    .join("")}</Relationships>`,
});
const sheetXml = (sheetData, padding = "") => `<worksheet xmlns="${S_NS}"><sheetData>${sheetData}</sheetData>${padding}</worksheet>`;
const textRow = (row, text) => `<row r="${row}"><c r="A${row}" t="inlineStr"><is><t>${text}</t></is></c></row>`;

{
  const padding = `<!--${" ".repeat(20 * MIB)}-->`;
  const file = zip({
    ...workbook(["One", "Two", "Three"]),
    "xl/worksheets/sheet1.xml": sheetXml(textRow(1, "Squat"), padding),
    "xl/worksheets/sheet2.xml": sheetXml(textRow(1, "Bench"), padding),
    "xl/worksheets/sheet3.xml": sheetXml(textRow(1, "Row"), padding),
  });
  assert.ok(file.length < MIB);
  const result = await extractXlsxText(file);
  assert.equal(result.text, "## Sheet: One\nSquat\n\n## Sheet: Two\nBench", "two parts of 20 MiB fit, the third does not");
  assert.equal(result.meta.truncated, true);
  assert.ok(result.meta.warnings.includes('Sheet "Three" is too large to read and was skipped.'), result.meta.warnings.join(" | "));
}

// ---------------------------------------------------------------------------
// 4. XLSX: a sheet is walked with a bounded amount of work, and once
// ---------------------------------------------------------------------------
{
  const names = Array.from({ length: 10 }, (_, index) => `S${index + 1}`);
  const same = () => "worksheets/sheet1.xml";

  // One real row, then 1.5 million empty rows (more tokens than one file may cost).
  const emptyRows = zip({
    ...workbook(names, same),
    "xl/worksheets/sheet1.xml": sheetXml(textRow(1, "Squat 5x5") + "<row/>".repeat(1500000)),
  });
  assert.ok(emptyRows.length < 64 * 1024);
  const empty = await timed(() => extractXlsxText(emptyRows));
  assert.equal(empty.result.text, "## Sheet: S1\nSquat 5x5");
  assert.equal(empty.result.meta.sheets, 1);
  assert.equal(empty.result.meta.rows, 1);
  assert.equal(empty.result.meta.truncated, true, "the walk stopped, and says so");
  assert.ok(empty.result.meta.warnings.includes('Sheet "S1" is too large to read in full; only its first rows were read.'));
  assert.equal(
    empty.result.meta.warnings.filter((line) => /points at the same data as sheet "S1" and was skipped\.$/.test(line)).length,
    9,
    "the nine other sheets point at the same part: it is walked once",
  );
  assert.ok(empty.ms < 8000, `bounded work (${Math.round(empty.ms)} ms)`);

  // One row of 400,000 cells: the cells past the column limit are counted, not read.
  const wideRow = zip({
    ...workbook(names, same),
    "xl/worksheets/sheet1.xml": sheetXml(`<row r="1">${"<c><v>1</v></c>".repeat(400000)}</row>`),
  });
  const wide = await timed(() => extractXlsxText(wideRow));
  assert.equal(wide.result.text, `## Sheet: S1\n${Array.from({ length: 50 }, () => "1").join(" | ")}`);
  assert.equal(wide.result.meta.truncated, true);
  assert.ok(wide.result.meta.warnings.includes('Sheet "S1" has more than 50 columns; the extra columns were skipped.'));
  assert.ok(wide.result.meta.warnings.includes('Sheet "S1" is too large to read in full; only its first rows were read.'));
  assert.ok(wide.ms < 8000, `bounded work (${Math.round(wide.ms)} ms)`);

  // The allowance is one per file: sheets after an exhausted one are named as not read.
  const twoSheets = await extractXlsxText(
    zip({
      ...workbook(["Big", "After", "Last"]),
      "xl/worksheets/sheet1.xml": sheetXml(textRow(1, "Squat") + "<row/>".repeat(1200000)),
      "xl/worksheets/sheet2.xml": sheetXml(textRow(1, "Bench")),
      "xl/worksheets/sheet3.xml": sheetXml(textRow(1, "Row")),
    }),
  );
  assert.equal(twoSheets.text, "## Sheet: Big\nSquat");
  assert.equal(twoSheets.meta.truncated, true);
  assert.ok(
    twoSheets.meta.warnings.includes("2 more sheets were not read: the workbook is too large to read in full."),
    twoSheets.meta.warnings.join(" | "),
  );

  // Two sheets that share a part in an ordinary workbook: read once, said once.
  const shared = await extractXlsxText(
    zip({
      ...workbook(["Plan", "Copy"], same),
      "xl/worksheets/sheet1.xml": sheetXml(textRow(1, "Squat") + textRow(2, "Bench")),
    }),
  );
  assert.equal(shared.text, "## Sheet: Plan\nSquat\nBench");
  assert.deepEqual(shared.meta.warnings, ['Sheet "Copy" points at the same data as sheet "Plan" and was skipped.']);
  assert.equal(shared.meta.truncated, false);
}

// ---------------------------------------------------------------------------
// 5. What worked keeps working
// ---------------------------------------------------------------------------
{
  // 50,000 real rows: still cut at the row limit with the row warning.
  const rows = Array.from({ length: 50000 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index + 1}</v></c></row>`).join("");
  const many = await extractXlsxText(zip({ ...workbook(["Rows"]), "xl/worksheets/sheet1.xml": sheetXml(rows) }));
  assert.equal(many.meta.rows, 2000);
  assert.equal(many.meta.truncated, true);
  assert.deepEqual(many.meta.warnings, ['Sheet "Rows" has more than 2,000 rows; only the first 2,000 were read.']);

  // A full sheet of the documented limits (2,000 rows x 50 columns of text) is inside the allowance.
  const fullRow = (row) =>
    `<row r="${row}">${Array.from({ length: 50 }, () => `<c t="inlineStr"><is><t>x</t></is></c>`).join("")}</row>`;
  const full = await extractXlsxText(
    zip({ ...workbook(["Full"]), "xl/worksheets/sheet1.xml": sheetXml(Array.from({ length: 2000 }, (_, index) => fullRow(index + 1)).join("")) }),
    { maxChars: 1000000 },
  );
  assert.equal(full.meta.rows, 2000);
  assert.equal(full.meta.truncated, false, full.meta.warnings.join(" | "));
  assert.deepEqual(full.meta.warnings, []);

  // The committed samples read exactly as frozen.
  for (const [name, extract, type] of [
    ["program.docx", extractDocxText, DOCX_MIME_TYPE],
    ["program.xlsx", extractXlsxText, XLSX_MIME_TYPE],
  ]) {
    const expected = readExpected(name);
    const bytes = readSample(name);
    const result = await extract(bytes);
    assert.equal(result.text, expected.text, name);
    const picked = await readSourceFile(
      { name, type, size: bytes.length },
      { readAsArrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) },
    );
    assert.equal(picked.ok, true, picked.error);
    assert.equal(picked.text, expected.text);
  }
}

console.log("Office H3 fix round 2 verification passed.");
