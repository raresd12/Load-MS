// H3 fix round 1, office files (decision H3-11): a small forged DOCX / XLSX
// can neither hang the tab nor lose text silently.
// - the entry count of the zip is checked against the file and capped
// - a part is inflated as a stream that stops at its declared size
// - attributes are read in one pass (no quadratic pattern), long runs of
//   spaces cost nothing
// - WordprocessingML is read whatever prefix its namespace has
//
// Time limits here are 50 to 1000 times above what the fixed code needs and
// far below what the defects took, so a loaded machine does not fail them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";

import { extractDocxText, extractXlsxText, MAX_ZIP_ENTRIES, OFFICE_TEXT_DEFAULTS } from "../src/lib/officeText.js";
import { readSourceFile } from "../src/lib/sourceFiles.js";

const samplesDir = new URL("../fixtures/import-samples/", import.meta.url);
const readSample = (name) => new Uint8Array(readFileSync(new URL(name, samplesDir)));
const readExpected = (name) => JSON.parse(readFileSync(new URL(`expected/${name}.json`, samplesDir), "utf8"));

const ZIP_TIME = new Date(2026, 0, 1);
function zip(files, options = {}) {
  const entries = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(entries, { mtime: ZIP_TIME, ...options });
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const docx = (body, options) =>
  zip({ "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>` }, options);
const xlsx = (sheetData) =>
  zip({
    "xl/workbook.xml": `<workbook xmlns="${S_NS}" xmlns:r="${R_NS}"><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${S_NS}"><sheetData>${sheetData}</sheetData></worksheet>`,
  });

async function timed(run) {
  const started = performance.now();
  const result = await run();
  return { result, ms: performance.now() - started };
}

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64(bytes, offset, value) {
  writeU32(bytes, offset, value % 0x100000000);
  writeU32(bytes, offset + 4, Math.floor(value / 0x100000000));
}

function findEnd(bytes) {
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (u32(bytes, index) === 0x06054b50) return index;
  }
  return assert.fail("no end record");
}

/** Central directory entry offsets by part name. */
function centralEntries(bytes) {
  const end = findEnd(bytes);
  const entries = new Map();
  let cursor = u32(bytes, end + 16);

  for (let index = 0; index < u16(bytes, end + 10); index += 1) {
    assert.equal(u32(bytes, cursor), 0x02014b50);
    const nameLength = u16(bytes, cursor + 28);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.set(name, cursor);
    cursor += 46 + nameLength + u16(bytes, cursor + 30) + u16(bytes, cursor + 32);
  }

  return entries;
}

/** The file with the declared uncompressed size of one part changed (central directory and local header). */
function withDeclaredSize(bytes, partName, size) {
  const copy = bytes.slice();
  const central = centralEntries(copy).get(partName);
  assert.ok(central !== undefined, `${partName} is in the zip`);
  writeU32(copy, central + 24, size);
  writeU32(copy, u32(copy, central + 42) + 22, size);
  return copy;
}

/** The file with a zip64 end record and locator in front of its end record, claiming `count` entries. */
function withZip64Count(bytes, count) {
  const end = findEnd(bytes);
  const directoryOffset = u32(bytes, end + 16);
  const directorySize = u32(bytes, end + 12);
  const record = new Uint8Array(56);
  writeU32(record, 0, 0x06064b50);
  writeU64(record, 4, 44);
  record[12] = 45;
  record[14] = 45;
  writeU64(record, 24, count);
  writeU64(record, 32, count);
  writeU64(record, 40, directorySize);
  writeU64(record, 48, directoryOffset);
  const locator = new Uint8Array(20);
  writeU32(locator, 0, 0x07064b50);
  writeU64(locator, 8, end);
  writeU32(locator, 16, 1);

  const out = new Uint8Array(bytes.length + record.length + locator.length);
  out.set(bytes.subarray(0, end), 0);
  out.set(record, end);
  out.set(locator, end + record.length);
  out.set(bytes.subarray(end), end + record.length + locator.length);
  // The classic record says "see zip64".
  const newEnd = end + record.length + locator.length;
  out[newEnd + 8] = 0xff;
  out[newEnd + 9] = 0xff;
  out[newEnd + 10] = 0xff;
  out[newEnd + 11] = 0xff;
  return out;
}

const DAMAGED = /damaged or encrypted and could not be opened/;

// ---------------------------------------------------------------------------
// 0. The real samples still read byte for byte through the new zip reader
// ---------------------------------------------------------------------------
{
  const word = await extractDocxText(readSample("program.docx"));
  assert.equal(word.text, readExpected("program.docx").text);
  const excel = await extractXlsxText(readSample("program.xlsx"));
  assert.equal(excel.text, readExpected("program.xlsx").text);

  // Stored (uncompressed) parts and every compression level.
  for (const level of [0, 1, 6, 9]) {
    const result = await extractDocxText(docx("<w:p><w:r><w:t>Squat 5x5</w:t></w:r></w:p>", { level }));
    assert.equal(result.text, "Squat 5x5", `level ${level}`);
    assert.deepEqual(result.meta.warnings, []);
  }

  // An empty part is a part.
  const empty = await extractDocxText(zip({ "word/document.xml": "" }));
  assert.equal(empty.text, "");
  assert.equal(empty.meta.warnings.length, 1);
}

// ---------------------------------------------------------------------------
// 1. Forged zip64 entry count
// ---------------------------------------------------------------------------
{
  const sample = readSample("program.docx");

  for (const count of [1e6, 2e8, 2 ** 32, 2 ** 40]) {
    const forged = withZip64Count(sample, count);
    assert.ok(forged.length < 3400, "the forged file is about 3 KB");
    const { result, ms } = await timed(() => extractDocxText(forged));
    assert.equal(result.text, "", `${count} entries: nothing is returned as if it were fine`);
    assert.equal(result.meta.warnings.length, 1);
    assert.match(result.meta.warnings[0], DAMAGED, `${count} entries: a clear reason`);
    assert.ok(ms < 500, `${count} entries: refused at once (${Math.round(ms)} ms)`);

    const viaSource = await readSourceFile({ name: "plan.docx", size: forged.length, arrayBuffer: async () => forged.buffer });
    assert.equal(viaSource.ok, false);
    assert.match(viaSource.error, DAMAGED);
  }

  // The same file with an honest zip64 record reads normally.
  const honest = withZip64Count(sample, centralEntries(sample).size);
  assert.equal((await extractDocxText(honest)).text, readExpected("program.docx").text, "zip64 itself is read");

  // A count the central directory has no room for.
  const classic = sample.slice();
  const end = findEnd(classic);
  classic[end + 10] = 0x88;
  classic[end + 11] = 0x13; // 5000 entries in a 3 KB file
  assert.match((await extractDocxText(classic)).meta.warnings[0], DAMAGED);

  // More entries than any document has: refused, even though the zip is real.
  const parts = { "word/document.xml": `<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>` };
  for (let index = 0; index < MAX_ZIP_ENTRIES; index += 1) parts[`word/media/f${index}.bin`] = new Uint8Array(0);
  assert.match((await extractDocxText(zip(parts, { level: 0 }))).meta.warnings[0], DAMAGED, `${MAX_ZIP_ENTRIES + 1} entries`);
  delete parts["word/media/f0.bin"];
  assert.equal((await extractDocxText(zip(parts, { level: 0 }))).text, "x", `${MAX_ZIP_ENTRIES} entries are read`);
}

// ---------------------------------------------------------------------------
// 2. The declared size of a part is not trusted
// ---------------------------------------------------------------------------
{
  const MIB = 1024 * 1024;
  const bomb = docx(`<w:p><w:r><w:t>hi</w:t></w:r></w:p>${" ".repeat(64 * MIB)}`);
  assert.ok(bomb.length < 100 * 1024, "64 MiB of spaces are a small zip");

  // Declared honestly: over the part limit, never inflated.
  const honest = await timed(() => extractDocxText(bomb));
  assert.equal(honest.result.text, "");
  assert.match(honest.result.meta.warnings[0], /too large to read here/);
  assert.ok(honest.ms < 500, `an oversized part is not inflated (${Math.round(honest.ms)} ms)`);

  // Declared as 100 bytes, as 1 MiB and as exactly the part limit: the
  // stream stops where the declared size ends and the file is refused; the
  // text is never cut without a word.
  for (const declared of [100, MIB, OFFICE_TEXT_DEFAULTS.maxPartBytes]) {
    const lying = withDeclaredSize(bomb, "word/document.xml", declared);
    const { result, ms } = await timed(() => extractDocxText(lying));
    assert.equal(result.text, "", `declared ${declared}: no partly read text`);
    assert.equal(result.meta.truncated, false);
    assert.match(result.meta.warnings[0], DAMAGED, `declared ${declared}: refused with a reason`);
    assert.ok(ms < 3000, `declared ${declared}: the rest of the stream is not inflated (${Math.round(ms)} ms)`);
  }

  // A part that is smaller than it declares is refused as well.
  const small = docx("<w:p><w:r><w:t>hi</w:t></w:r></w:p>");
  const declaredSize = u32(small, centralEntries(small).get("word/document.xml") + 24);
  assert.match((await extractDocxText(withDeclaredSize(small, "word/document.xml", declaredSize + 1))).meta.warnings[0], DAMAGED);
  assert.match((await extractDocxText(withDeclaredSize(small, "word/document.xml", declaredSize - 1))).meta.warnings[0], DAMAGED);
  assert.equal((await extractDocxText(withDeclaredSize(small, "word/document.xml", declaredSize))).text, "hi");

  // XLSX: a lying sheet is refused, not read in part.
  const sheet = xlsx(`<row r="1"><c r="A1" t="inlineStr"><is><t>Squat</t></is></c></row>${" ".repeat(8 * MIB)}`);
  const lyingSheet = await extractXlsxText(withDeclaredSize(sheet, "xl/worksheets/sheet1.xml", 120));
  assert.equal(lyingSheet.text, "");
  assert.match(lyingSheet.meta.warnings[0], DAMAGED);
}

// ---------------------------------------------------------------------------
// 3. Attributes and long runs cost linear time
// ---------------------------------------------------------------------------
{
  const run = "A".repeat(400000);

  const word = docx(`<w:p><w:pPr><w:pStyle ${run}/></w:pPr><w:r><w:t>Squat 5x5</w:t></w:r></w:p>`);
  assert.ok(word.length < 2000, "the file is tiny");
  const wordRead = await timed(() => extractDocxText(word));
  assert.equal(wordRead.result.text, "Squat 5x5");
  assert.ok(wordRead.ms < 2000, `DOCX attribute run of 400,000 characters: ${Math.round(wordRead.ms)} ms`);

  for (const attrs of [run, `${run}=`, `r="A1" ${run}`, `${"a ".repeat(200000)}`, `${"= ".repeat(200000)}`, `x="${run}`, `${"a='' ".repeat(80000)}`]) {
    const sheet = xlsx(`<row r="1" ${attrs}><c ${attrs}><v>5</v></c><c r="B1" t="inlineStr" ${attrs.includes('"') ? "" : attrs}><is><t>Squat</t></is></c></row>`);
    const { result, ms } = await timed(() => extractXlsxText(sheet));
    assert.ok(ms < 2000, `XLSX attributes "${attrs.slice(0, 12)}...": ${Math.round(ms)} ms`);
    assert.equal(result.meta.kind, "xlsx");
  }

  const viaSource = await timed(() => readSourceFile({ name: "plan.docx", size: word.length, arrayBuffer: async () => word.buffer }));
  assert.equal(viaSource.result.ok, true);
  assert.equal(viaSource.result.text, "Squat 5x5");
  assert.ok(viaSource.ms < 2000);

  // Attributes are still read exactly as before.
  const attributes = await extractXlsxText(
    xlsx(
      `<row r = "2"><c r='B2' t = "inlineStr"><is><t>Bench &amp; Row</t></is></c><c t="inlineStr" r="D2" s="0"><is><t>x</t></is></c></row>`,
    ),
  );
  assert.equal(attributes.text, "## Sheet: Plan\n | Bench & Row |  | x");

  // Long runs of spaces and tabs in text.
  const spaces = " ".repeat(2000000);
  const spaced = await timed(() =>
    extractDocxText(
      docx(
        `<w:p><w:r><w:t xml:space="preserve">Squat${spaces}5x5${spaces}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">${spaces}Bench${spaces}3x8</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
      ),
      { maxChars: 5000000 },
    ),
  );
  assert.ok(spaced.ms < 3000, `runs of 2,000,000 spaces: ${Math.round(spaced.ms)} ms`);
  assert.ok(spaced.result.text.startsWith("Squat ") && spaced.result.text.includes("5x5\nBench"));
  assert.ok(spaced.result.text.endsWith("3x8"));

  const spacedSheet = await timed(() =>
    extractXlsxText(xlsx(`<row r="1"><c r="A1" t="inlineStr"><is><t>${spaces}Squat${spaces}x</t></is></c></row>`), { maxChars: 5000000 }),
  );
  assert.ok(spacedSheet.ms < 3000, `a cell with 4,000,000 spaces: ${Math.round(spacedSheet.ms)} ms`);
  assert.ok(spacedSheet.result.text.startsWith("## Sheet: Plan\nSquat "));
}

// ---------------------------------------------------------------------------
// 4. WordprocessingML under any prefix
// ---------------------------------------------------------------------------
{
  const body = (p) => {
    const tag = (name) => (p ? `${p}:${name}` : name);
    const attr = (name) => (p ? `${p}:${name}` : name);
    return [
      `<${tag("p")}><${tag("pPr")}><${tag("pStyle")} ${attr("val")}="Heading1"/></${tag("pPr")}><${tag("r")}><${tag("t")}>Day 1</${tag("t")}></${tag("r")}></${tag("p")}>`,
      `<${tag("p")}><${tag("pPr")}><${tag("tabs")}><${tag("tab")} ${attr("val")}="left" ${attr("pos")}="720"/></${tag("tabs")}></${tag("pPr")}><${tag("r")}><${tag("t")}>Squat</${tag("t")}><${tag("tab")}/><${tag("t")}>5x5 @ 80 kg</${tag("t")}><${tag("br")}/><${tag("t")}>rest 3 min</${tag("t")}></${tag("r")}></${tag("p")}>`,
      `<${tag("p")}><${tag("r")}><${tag("t")}>kept</${tag("t")}></${tag("r")}><${tag("del")}><${tag("r")}><${tag("delText")}>removed</${tag("delText")}><${tag("t")}>removed too</${tag("t")}></${tag("r")}></${tag("del")}></${tag("p")}>`,
      `<${tag("p")}><${tag("r")}><${tag("drawing")}><${tag("p")}><${tag("r")}><${tag("t")}>inside a drawing</${tag("t")}></${tag("r")}></${tag("p")}></${tag("drawing")}></${tag("r")}></${tag("p")}>`,
      `<${tag("tbl")}><${tag("tr")}><${tag("tc")}><${tag("p")}><${tag("r")}><${tag("t")}>Bench</${tag("t")}></${tag("r")}></${tag("p")}></${tag("tc")}><${tag("tc")}><${tag("p")}><${tag("r")}><${tag("t")}>3x8</${tag("t")}></${tag("r")}></${tag("p")}></${tag("tc")}></${tag("tr")}></${tag("tbl")}>`,
    ].join("");
  };
  const expected = "Day 1\nSquat\t5x5 @ 80 kg\nrest 3 min\nkept\n\nBench | 3x8";
  const documents = {
    "w: prefix": `<w:document xmlns:w="${W_NS}"><w:body>${body("w")}</w:body></w:document>`,
    "default namespace": `<document xmlns="${W_NS}"><body>${body("")}</body></document>`,
    "ns0: prefix": `<ns0:document xmlns:ns0="${W_NS}"><ns0:body>${body("ns0")}</ns0:body></ns0:document>`,
  };
  const results = {};

  for (const [label, xml] of Object.entries(documents)) {
    const result = await extractDocxText(zip({ "word/document.xml": `<?xml version="1.0"?>${xml}` }));
    results[label] = result;
    assert.equal(result.text, expected, label);
    assert.equal(result.meta.paragraphs, 3, label);
    assert.equal(result.meta.rows, 1, label);
    assert.equal(result.meta.warnings.length, 1, `${label}: the drawing is counted`);
    assert.match(result.meta.warnings[0], /^1 image or drawing object was ignored/);
  }

  assert.deepEqual(results["default namespace"], results["w: prefix"]);
  assert.deepEqual(results["ns0: prefix"], results["w: prefix"]);

  // The probe of the finding.
  const probe = await extractDocxText(
    zip({ "word/document.xml": `<document xmlns="${W_NS}"><body><p><r><t>Squat 5x5 @ 80 kg</t></r></p></body></document>` }),
  );
  assert.equal(probe.text, "Squat 5x5 @ 80 kg");
  assert.deepEqual(probe.meta.warnings, []);

  // mc:AlternateContent: the fallback copy is skipped under any prefix.
  const alternate = await extractDocxText(
    zip({
      "word/document.xml": `<x:document xmlns:x="${W_NS}" xmlns:alt="http://schemas.openxmlformats.org/markup-compatibility/2006"><x:body><x:p><alt:AlternateContent><alt:Choice><x:r><x:t>once</x:t></x:r></alt:Choice><alt:Fallback><x:r><x:t>twice</x:t></x:r></alt:Fallback></alt:AlternateContent></x:p></x:body></x:document>`,
    }),
  );
  assert.equal(alternate.text, "once");
}

console.log("verify-office-h3-fix1: ok");
