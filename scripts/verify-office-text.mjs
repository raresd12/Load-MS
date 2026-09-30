// H3 Track A (decision H3-2): DOCX / XLSX -> plain text.
// Real samples (fixtures/import-samples) are parsed to the expected text byte
// for byte; malformed, encrypted, oversized and wrong-kind input never throws.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";

import { decodeXmlEntities, extractDocxText, extractXlsxText, OFFICE_TEXT_DEFAULTS } from "../src/lib/officeText.js";
import { buildImportSamples, INJECTION_LINE } from "./build-import-samples.mjs";

const samplesDir = new URL("../fixtures/import-samples/", import.meta.url);
const readSample = (name) => new Uint8Array(readFileSync(new URL(name, samplesDir)));
const readExpected = (name) => JSON.parse(readFileSync(new URL(`expected/${name}.json`, samplesDir), "utf8"));

const ZIP_TIME = new Date(2026, 0, 1);
function zip(files) {
  const entries = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(entries, { mtime: ZIP_TIME });
}

// Nothing a parser returns may carry the file itself.
function assertNoBinary(value, label, seen = new Set()) {
  if (value === null || typeof value !== "object") {
    assert.notEqual(typeof value, "function", `${label}: no function`);
    return;
  }
  assert.ok(!(value instanceof ArrayBuffer), `${label}: no ArrayBuffer`);
  assert.ok(!ArrayBuffer.isView(value), `${label}: no typed array / Buffer`);
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/base64|bytes|buffer/i.test(key), `${label}: no "${key}" field`);
    assertNoBinary(child, `${label}.${key}`, seen);
  }
}

function assertEmptyWithReason(result, kind, pattern, label) {
  assert.equal(result.text, "", `${label}: no text`);
  assert.equal(result.meta.kind, kind, `${label}: kind`);
  assert.equal(result.meta.truncated, false, `${label}: not truncated`);
  assert.equal(result.meta.warnings.length, 1, `${label}: one reason`);
  assert.match(result.meta.warnings[0], pattern, `${label}: clear reason`);
  assertNoBinary(result, label);
}

// --- 1. The committed binaries are what the generator builds ----------------
{
  const built = buildImportSamples();
  const again = buildImportSamples();

  for (const [name, bytes] of built) {
    assert.deepEqual(Buffer.from(again.get(name)), Buffer.from(bytes), `${name}: generator is deterministic`);
    assert.deepEqual(
      Buffer.from(readSample(name)),
      Buffer.from(bytes),
      `${name}: committed file differs from scripts/build-import-samples.mjs (run it, or check .gitattributes)`,
    );
  }

  assert.ok(readSample("program.docx").length < 20 * 1024, "program.docx under 20 KB");
  assert.ok(readSample("program.xlsx").length < 20 * 1024, "program.xlsx under 20 KB");
}

// --- 2. Real samples, byte for byte -----------------------------------------
const docx = await extractDocxText(readSample("program.docx"));
const xlsx = await extractXlsxText(readSample("program.xlsx"));

{
  const expected = readExpected("program.docx");
  assert.equal(docx.text, expected.text, "program.docx text");
  assert.deepEqual(docx.meta, expected.meta, "program.docx meta");
  assert.deepEqual(Object.keys(docx.meta), ["kind", "paragraphs", "rows", "truncated", "warnings"]);
  assert.equal(docx.meta.kind, "docx");
  assert.equal(docx.meta.truncated, false);

  const lines = docx.text.split("\n");
  assert.ok(lines.includes(`Coach note:\t${INJECTION_LINE}.`), "injection line is kept as data (w:tab is a tab)");
  assert.ok(lines.includes("4 days per week."), "w:br splits the paragraph into lines");
  assert.ok(lines.includes("DAY 2 - UPPER PUSH & PULL"), "&amp; is decoded");
  assert.ok(
    lines.includes("Questions: ask before week 1 < starts > — “RPE” = effort, 10 is max."),
    "&lt; &gt; and non-ASCII text survive",
  );
  assert.ok(
    lines.includes("1 | Back Squat | 5 | 5 | 75% 1RM |  | 3-4 min | 5x5 @ 75% 1RM"),
    "a table row is one line, empty cell kept as an empty column",
  );
  assert.ok(lines.includes("A1 | Bulgarian Split Squat | 3 | 10 / side |  | 8 |  | Superset with A2"));
  assert.ok(!docx.text.includes("HEADER TEXT"), "headers are ignored");
  assert.ok(!docx.text.includes("DELETED TEXT"), "tracked deletions are ignored");
  assert.ok(!docx.text.includes("TEXT INSIDE A DRAWING"), "drawings are ignored");
  assert.equal(docx.meta.warnings.length, 1);
  assert.match(docx.meta.warnings[0], /1 image or drawing object was ignored/, "drawing note");
  assert.equal(docx.meta.rows, 24, "table rows counted");
  assertNoBinary(docx, "docx result");
}

{
  const expected = readExpected("program.xlsx");
  assert.equal(xlsx.text, expected.text, "program.xlsx text");
  assert.deepEqual(xlsx.meta, expected.meta, "program.xlsx meta");
  assert.deepEqual(Object.keys(xlsx.meta), ["kind", "sheets", "rows", "truncated", "warnings"]);
  assert.equal(xlsx.meta.kind, "xlsx");
  assert.equal(xlsx.meta.sheets, 5);

  const lines = xlsx.text.split("\n");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("## Sheet: ")),
    ["## Sheet: Overview", "## Sheet: Day 1", "## Sheet: Day 2", "## Sheet: Day 3", "## Sheet: Day 4"],
    "workbook sheet order, hidden sheet skipped",
  );
  assert.ok(lines.includes(`Coach note | ${INJECTION_LINE}.`), "injection line is kept as data (inline string)");
  assert.equal(lines[1], "Sample Strength Block", "rich text runs are joined; the merged cell keeps its top-left value");
  assert.ok(lines.includes("Start date | 46027"), "date stays the raw serial");
  assert.ok(lines.includes("Training days | 3"), "formula gives the cached value");
  assert.ok(lines.includes("Day 3 | Recovery | FALSE") && lines.includes("Day 1 | Lower Strength | TRUE"), "booleans");
  assert.ok(lines.includes("1 | Back Squat | 5 | 5 | 75% |  | 3-4 min | 5x5 @ 75% 1RM"), "percent cell, empty column kept");
  assert.ok(lines.includes(" | Bike, easy pace |  | 5 min"), "leading and inner empty cells kept");
  assert.ok(lines.includes(" | Total sets | 8"));
  assert.ok(!xlsx.text.includes("HIDDEN SHEET TEXT"), "hidden sheet is not sent");
  assert.ok(xlsx.meta.warnings.some((warning) => /1 hidden sheet was skipped/.test(warning)));
  assert.ok(xlsx.meta.warnings.some((warning) => /raw Excel serial number \(for example 46027\)/.test(warning)));
  assertNoBinary(xlsx, "xlsx result");
}

// ArrayBuffer input (what FileReader gives) is the same as a Uint8Array.
{
  const bytes = readSample("program.docx");
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert.ok(buffer instanceof ArrayBuffer);
  assert.equal((await extractDocxText(buffer)).text, docx.text);
  const sheetBytes = readSample("program.xlsx");
  const sheetBuffer = sheetBytes.buffer.slice(sheetBytes.byteOffset, sheetBytes.byteOffset + sheetBytes.byteLength);
  assert.equal((await extractXlsxText(sheetBuffer)).text, xlsx.text);
}

// --- 3. Malformed input never throws ----------------------------------------
{
  const good = readSample("program.docx");
  const goodSheet = readSample("program.xlsx");

  for (const [label, input] of [
    ["null", null],
    ["undefined", undefined],
    ["string", "not bytes"],
    ["number", 42],
    ["object", {}],
  ]) {
    assertEmptyWithReason(await extractDocxText(input), "docx", /could not be read/, `docx ${label}`);
    assertEmptyWithReason(await extractXlsxText(input), "xlsx", /could not be read/, `xlsx ${label}`);
  }

  assertEmptyWithReason(await extractDocxText(new ArrayBuffer(0)), "docx", /is empty/, "docx empty");
  assertEmptyWithReason(await extractXlsxText(new Uint8Array(0)), "xlsx", /is empty/, "xlsx empty");

  const garbage = Uint8Array.from({ length: 300 }, (_, index) => (index * 37 + 11) % 256);
  assertEmptyWithReason(await extractDocxText(garbage), "docx", /not a valid Word document/, "docx garbage");
  assertEmptyWithReason(await extractXlsxText(garbage), "xlsx", /not a valid Excel document/, "xlsx garbage");

  // A zip cut in half: the central directory is gone.
  assertEmptyWithReason(
    await extractDocxText(good.slice(0, Math.floor(good.length / 2))),
    "docx",
    /damaged or encrypted/,
    "docx truncated zip",
  );
  assertEmptyWithReason(
    await extractXlsxText(goodSheet.slice(0, Math.floor(goodSheet.length / 2))),
    "xlsx",
    /damaged or encrypted/,
    "xlsx truncated zip",
  );

  // Compressed data overwritten: directory intact, content broken.
  {
    const broken = good.slice();
    const text = Buffer.from(broken).toString("latin1");
    const start = text.indexOf("word/document.xml") + "word/document.xml".length;
    for (let index = start; index < start + 400; index += 1) broken[index] = 0xff;
    const result = await extractDocxText(broken);
    assert.equal(result.text, "", "broken deflate stream: no text");
    assert.equal(result.meta.warnings.length, 1);
    assertNoBinary(result, "docx broken stream");
  }

  // Password-protected OOXML and legacy binary files are OLE containers.
  assertEmptyWithReason(
    await extractDocxText(readSample("program-legacy.doc")),
    "docx",
    /password-protected or saved in the legacy binary format.*export as DOCX, XLSX, PDF or text/,
    "docx OLE",
  );
  assertEmptyWithReason(
    await extractXlsxText(readSample("program-legacy.doc")),
    "xlsx",
    /password-protected or saved in the legacy binary format/,
    "xlsx OLE",
  );
  assertEmptyWithReason(
    await extractDocxText(zip({ EncryptionInfo: "x", EncryptedPackage: "y" })),
    "docx",
    /password-protected/,
    "docx encrypted package",
  );

  assertEmptyWithReason(
    await extractDocxText(zip({ "word/styles.xml": "<w:styles/>", "readme.txt": "hello" })),
    "docx",
    /word\/document\.xml is missing/,
    "docx missing document.xml",
  );
  assertEmptyWithReason(
    await extractXlsxText(zip({ "xl/styles.xml": "<styleSheet/>" })),
    "xlsx",
    /xl\/workbook\.xml is missing/,
    "xlsx missing workbook.xml",
  );
  assertEmptyWithReason(await extractDocxText(goodSheet), "docx", /Excel workbook, not a Word document/, "xlsx as docx");
  assertEmptyWithReason(await extractXlsxText(good), "xlsx", /Word document, not an Excel workbook/, "docx as xlsx");
  assertEmptyWithReason(
    await extractXlsxText(zip({ "xl/workbook.bin": "x" })),
    "xlsx",
    /\.xlsb.*not supported/,
    "xlsb content",
  );
  assertEmptyWithReason(
    await extractDocxText(zip({ "word/document.xml": "\u0001\u0002 not xml at all" })),
    "docx",
    /damaged or encrypted/,
    "docx part is not xml",
  );
  assertEmptyWithReason(
    await extractDocxText(zip({ "word/document.xml": "<w:document><w:body><w:p/></w:body></w:document>" })),
    "docx",
    /No text was found/,
    "docx without text",
  );
  assertEmptyWithReason(
    await extractDocxText(
      zip({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:drawing><a:t>x</a:t></w:drawing></w:r></w:p></w:body></w:document>" }),
    ),
    "docx",
    /only contains images or drawings/,
    "docx with images only",
  );
}

// --- 4. DOCX walker ----------------------------------------------------------
function docxOf(body) {
  return zip({
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
  });
}

{
  const result = await extractDocxText(
    docxOf(
      [
        "<!-- a comment with <w:t>COMMENT</w:t> -->",
        '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>',
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Squat &amp; press </w:t></w:r>',
        "<w:r><w:t>&lt;3 x 5&gt; &quot;heavy&quot; &apos;ok&apos; &#8211; &#x2014; &#233;</w:t></w:r>",
        "<w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t><w:cr/><w:t>three</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>non</w:t><w:noBreakHyphen/><w:t>stop</w:t></w:r></w:p>",
        "<w:p><w:r><w:t><![CDATA[raw <b> & text]]></w:t></w:r></w:p>",
        '<w:p><w:r><w:t>unknown &nbsp; &bogus; &#xFFFFFFFF; &#0; stay</w:t></w:r></w:p>',
        '<w:p><w:r><w:instrText>HYPERLINK "http://example.invalid"</w:instrText></w:r><w:r><w:t>link text</w:t></w:r></w:p>',
        '<w:p><w:ins w:id="2"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="3"><w:r><w:delText>gone</w:delText><w:t>gone too</w:t></w:r></w:del></w:p>',
        "<mc:AlternateContent><mc:Choice><w:p><w:r><w:drawing><w:t>IN DRAWING</w:t><w:drawing><w:t>NESTED</w:t></w:drawing><w:t>STILL IN</w:t></w:drawing></w:r></w:p></mc:Choice>",
        "<mc:Fallback><w:p><w:r><w:pict><w:t>IN PICT</w:t></w:pict><w:t>FALLBACK TEXT</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>",
        "<w:tbl>",
        "<w:tr><w:tc><w:p><w:r><w:t>Exercise</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sets</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>",
        "<w:tr><w:tc><w:p><w:r><w:t>Row</w:t></w:r></w:p><w:p><w:r><w:t>two lines</w:t><w:br/><w:t>three</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>8</w:t></w:r></w:p></w:tc></w:tr>",
        "<w:tr><w:tc><w:p><w:r><w:t>Outer</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>in1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>in2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc><w:tc><w:p><w:r><w:t>after</w:t></w:r></w:p></w:tc></w:tr>",
        "<w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr>",
        "</w:tbl>",
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Day 2</w:t></w:r></w:p>',
        "<w:p/><w:p/><w:p/>",
        "<w:p><w:r><w:t>last   </w:t></w:r></w:p>",
      ].join(""),
    ),
  );

  assert.equal(
    result.text,
    [
      "Squat & press <3 x 5> \"heavy\" 'ok' – — é\ttabbed",
      "one",
      "two",
      "three",
      "non-stop",
      "raw <b> & text",
      "unknown &nbsp; &bogus; &#xFFFFFFFF; &#0; stay",
      "link text",
      "inserted",
      "", // the paragraph that only held the drawing
      "Exercise | Sets",
      "Row two lines three |  | 8",
      "Outer in1 | in2 | after",
      "",
      "Day 2",
      "",
      "last",
    ].join("\n"),
    "docx walker output",
  );
  assert.equal(result.meta.paragraphs, 9, "non-empty paragraphs outside tables");
  assert.equal(result.meta.rows, 3, "the empty row is dropped");
  assert.equal(result.meta.truncated, false);
  assert.deepEqual(result.meta.warnings, [
    "1 image or drawing object was ignored; text inside images is not read from Word files.",
  ]);
}

// Cut in the middle of a tag, a cell or an attribute: what was read is kept.
{
  const cut = await extractDocxText(
    zip({
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>kept</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>open cell</w:t><w:t attr="never closed',
    }),
  );
  assert.equal(cut.text, "kept\ncell | open cell");
  assert.equal(cut.meta.rows, 1);

  const dangling = await extractDocxText(docxOf("<w:p><w:r><w:t>text</w:t></w:r><w:r><w:t>no end"));
  assert.equal(dangling.text, "textno end");
}

// Main part named by the package relationships, not word/document.xml.
{
  const result = await extractDocxText(
    zip({
      "_rels/.rels":
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document2.xml"/></Relationships>',
      "word/document2.xml": "<w:document><w:body><w:p><w:r><w:t>moved part</w:t></w:r></w:p></w:body></w:document>",
    }),
  );
  assert.equal(result.text, "moved part");
}

// UTF-16 part with a byte order mark.
{
  const xml = "<w:document><w:body><w:p><w:r><w:t>Genuflexiuni și împins</w:t></w:r></w:p></w:body></w:document>";
  const bytes = new Uint8Array(2 + xml.length * 2);
  bytes.set([0xff, 0xfe]);
  for (let index = 0; index < xml.length; index += 1) {
    bytes[2 + index * 2] = xml.charCodeAt(index) & 0xff;
    bytes[3 + index * 2] = xml.charCodeAt(index) >> 8;
  }
  assert.equal((await extractDocxText(zip({ "word/document.xml": bytes }))).text, "Genuflexiuni și împins");
}

// maxChars: cut at a line end, flagged.
{
  const body = Array.from({ length: 200 }, (_, index) => `<w:p><w:r><w:t>Line ${index + 1} of the program</w:t></w:r></w:p>`).join("");
  const limited = await extractDocxText(docxOf(body), { maxChars: 500 });
  assert.equal(limited.meta.truncated, true);
  assert.ok(limited.text.length <= 500, "never longer than maxChars");
  assert.ok(limited.text.startsWith("Line 1 of the program\nLine 2 of the program"));
  assert.match(limited.text.split("\n").at(-1), /^Line \d+ of the program$/, "cut at a line end");
  assert.ok(limited.meta.warnings.some((warning) => /longer than 500 characters/.test(warning)));

  const full = await extractDocxText(docxOf(body));
  assert.equal(full.meta.truncated, false);
  assert.equal(full.text.split("\n").length, 200);
  assert.equal(OFFICE_TEXT_DEFAULTS.maxChars, 80000);

  const invalidOption = await extractDocxText(docxOf(body), { maxChars: -5 });
  assert.equal(invalidOption.text, full.text, "an invalid limit falls back to the default");
}

// --- 5. XLSX walker ----------------------------------------------------------
const WORKBOOK_RELS_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";

function xlsxOf(sheets, extra = {}) {
  const files = {
    "xl/workbook.xml":
      '<workbook xmlns:r="r"><sheets>' +
      sheets
        .map(
          (sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${index + 1}"/>`,
        )
        .join("") +
      "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels":
      "<Relationships>" +
      sheets
        .map(
          (sheet, index) =>
            `<Relationship Id="rId${index + 1}" Type="${sheet.type ?? WORKBOOK_RELS_TYPE}" Target="${sheet.target ?? `worksheets/sheet${index + 1}.xml`}"/>`,
        )
        .join("") +
      "</Relationships>",
    ...extra,
  };

  sheets.forEach((sheet, index) => {
    if (sheet.xml !== undefined) {
      files[sheet.part ?? `xl/worksheets/sheet${index + 1}.xml`] = sheet.xml;
    }
  });

  return zip(files);
}

{
  const sharedStrings =
    "<sst>" +
    "<si><t>Exercise</t></si>" +
    '<si><r><rPr><b/></rPr><t xml:space="preserve">Back </t></r><r><t>Squat</t></r><rPh><t>PHONETIC</t></rPh></si>' +
    "<si><t>R&amp;D &lt;tempo&gt; &#8211; 3&#x2D;1&#x2d;1</t></si>" +
    "<si><t>two_x000D__x000A_lines</t></si>" +
    "<si><t/></si>" +
    "</sst>";
  const styles =
    '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd\\-mmm\\-yy"/><numFmt numFmtId="165" formatCode="0.0%"/>' +
    '<numFmt numFmtId="166" formatCode="0.00 &quot;kg&quot;"/><numFmt numFmtId="167" formatCode="[Red]General"/></numFmts>' +
    '<cellStyleXfs><xf numFmtId="14"/></cellStyleXfs>' +
    '<cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="22"/><xf numFmtId="167"/><xf numFmtId="10"/></cellXfs></styleSheet>';
  const sheet =
    "<worksheet><sheetData>" +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Inline &amp; text</t></is></c><c r="D1" t="inlineStr"><is><r><t>rich </t></r><r><t>inline</t></r></is></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>5</v></c><c r="C2"><v>0.30000000000000004</v></c><c r="D2"><v>-12.50</v></c><c r="E2"><v>1.5E3</v></c></row>' +
    '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="b"><v>0</v></c><c r="C3" t="e"><v>#DIV/0!</v></c><c r="D3" t="d"><v>2026-01-05</v></c></row>' +
    '<row r="4"><c r="A4"><f>SUM(B2:B2)*2</f><v>10</v></c><c r="B4" t="str"><f>A1&amp;"!"</f><v>Exercise!</v></c><c r="C4"><f>NOW()</f></c><c r="D4" t="str"><f>""</f><v></v></c></row>' +
    '<row r="5"><c r="A5" s="1"><v>46027</v></c><c r="B5" s="4"><v>46027.5</v></c><c r="C5" s="2"><v>0.825</v></c><c r="D5" s="6"><v>0.7</v></c><c r="E5" s="3"><v>82.5</v></c><c r="F5" s="5"><v>7</v></c></row>' +
    '<row r="6"><c r="C6" t="s"><v>2</v></c><c r="F6" t="s"><v>3</v></c><c r="G6" t="s"><v>4</v></c><c r="H6" t="s"><v>99</v></c></row>' +
    '<row r="7"><c r="A7"/><c r="B7"><v></v></c></row>' +
    '<row r="9"><c><v>1</v></c><c><v>2</v></c><c r="E9"><v>5</v></c><c><v>6</v></c></row>' +
    '</sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>';

  const result = await extractXlsxText(
    xlsxOf([{ name: "Plan &amp; notes", xml: sheet }], {
      "xl/sharedStrings.xml": sharedStrings,
      "xl/styles.xml": styles,
    }),
  );

  assert.equal(
    result.text,
    [
      "## Sheet: Plan & notes",
      "Exercise | Inline & text |  | rich inline",
      "Back Squat | 5 | 0.3 | -12.5 | 1500",
      "TRUE | FALSE | #DIV/0! | 2026-01-05",
      "10 | Exercise!",
      "46027 | 46027.5 | 82.5% | 70% | 82.5 | 7",
      " |  | R&D <tempo> – 3-1-1 |  |  | two lines",
      "",
      "1 | 2 |  |  | 5 | 6",
    ].join("\n"),
    "xlsx walker output",
  );
  assert.equal(result.meta.sheets, 1);
  assert.equal(result.meta.rows, 7, "the row without values is not counted");
  assert.equal(result.meta.truncated, false);
  assert.deepEqual(result.meta.warnings, [
    "2 date cells are shown as the raw Excel serial number (for example 46027), not as a calendar date.",
    "1 formula cell has no saved result and is empty. Open and save the workbook in Excel to store the values.",
  ]);
  assertNoBinary(result, "xlsx walker result");
}

// Prefixed elements, absolute targets, missing rels, chart sheets.
{
  const prefixed = await extractXlsxText(
    xlsxOf([
      {
        name: "Prefixed",
        target: "/xl/worksheets/custom.xml",
        part: "xl/worksheets/custom.xml",
        xml: '<x:worksheet><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>ok</x:t></x:is></x:c><x:c r="B1"><x:v>3</x:v></x:c></x:row></x:sheetData></x:worksheet>',
      },
      { name: "Chart", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet", target: "chartsheets/sheet1.xml" },
      { name: "Gone", target: "worksheets/missing.xml" },
      { name: "Empty", xml: "<worksheet><sheetData/></worksheet>" },
    ]),
  );
  assert.equal(prefixed.text, "## Sheet: Prefixed\nok | 3");
  assert.equal(prefixed.meta.sheets, 1);
  assert.deepEqual(prefixed.meta.warnings, [
    "1 chart sheet was skipped.",
    'Sheet "Gone" could not be found in the file and was skipped.',
  ]);

  const noRels = await extractXlsxText(
    zip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="Only" sheetId="7" r:id="rId9"/></sheets></workbook>',
      "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c><v>1</v></c></row><row><c><v>2</v></c></row></sheetData></worksheet>',
    }),
  );
  assert.equal(noRels.text, "## Sheet: Only\n1\n2", "falls back to sheet<N>.xml; rows and cells without references");

  const onlyHidden = await extractXlsxText(
    xlsxOf([{ name: "Secret", state: "veryHidden", xml: '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' }]),
  );
  assert.equal(onlyHidden.text, "");
  assert.deepEqual(onlyHidden.meta.warnings, [
    "1 hidden sheet was skipped.",
    "No visible worksheet was found in the Excel workbook.",
  ]);

  const noValues = await extractXlsxText(xlsxOf([{ name: "Blank", xml: "<worksheet><sheetData/></worksheet>" }]));
  assert.equal(noValues.text, "");
  assert.deepEqual(noValues.meta.warnings, ["No cell values were found in the Excel workbook."]);
}

// --- 6. Limits ---------------------------------------------------------------
function rowsXml(count, cellsPerRow = 2) {
  const rows = [];
  for (let row = 1; row <= count; row += 1) {
    let cells = "";
    for (let column = 0; column < cellsPerRow; column += 1) {
      cells += `<c r="${String.fromCharCode(65 + column)}${row}"><v>${row * 10 + column}</v></c>`;
    }
    rows.push(`<row r="${row}">${cells}</row>`);
  }
  return `<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

{
  assert.equal(OFFICE_TEXT_DEFAULTS.maxRows, 2000);
  assert.equal(OFFICE_TEXT_DEFAULTS.maxSheets, 10);

  // A sheet over maxRows: truncated, flagged, never more than the limit.
  const big = await extractXlsxText(xlsxOf([{ name: "Big", xml: rowsXml(2500) }, { name: "Small", xml: rowsXml(3) }]));
  assert.equal(big.meta.truncated, true);
  assert.equal(big.meta.rows, 2003);
  assert.equal(big.meta.sheets, 2);
  const bigLines = big.text.split("\n");
  assert.equal(bigLines[2000], "20000 | 20001", "row 2000 is the last row of the first sheet");
  assert.equal(bigLines[2001], "");
  assert.equal(bigLines[2002], "## Sheet: Small");
  assert.deepEqual(big.meta.warnings, ['Sheet "Big" has more than 2,000 rows; only the first 2,000 were read.']);

  const exact = await extractXlsxText(xlsxOf([{ name: "Exact", xml: rowsXml(2000) }]));
  assert.equal(exact.meta.truncated, false, "exactly maxRows is not truncated");
  assert.equal(exact.meta.rows, 2000);

  const custom = await extractXlsxText(xlsxOf([{ name: "Big", xml: rowsXml(50) }]), { maxRows: 5 });
  assert.equal(custom.text, "## Sheet: Big\n10 | 11\n20 | 21\n30 | 31\n40 | 41\n50 | 51");
  assert.equal(custom.meta.truncated, true);

  // More sheets than maxSheets.
  const many = await extractXlsxText(
    xlsxOf(Array.from({ length: 12 }, (_, index) => ({ name: `S${index + 1}`, xml: rowsXml(1) }))),
  );
  assert.equal(many.meta.sheets, 10);
  assert.equal(many.meta.truncated, true);
  assert.ok(many.text.includes("## Sheet: S10") && !many.text.includes("## Sheet: S11"));
  assert.deepEqual(many.meta.warnings, ["The workbook has 12 sheets; only the first 10 were read."]);

  // A cell far to the right does not create thousands of columns.
  const wide = await extractXlsxText(
    xlsxOf([{ name: "Wide", xml: '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row></sheetData></worksheet>' }]),
  );
  assert.equal(wide.text, "## Sheet: Wide\n1");
  assert.equal(wide.meta.truncated, true);
  assert.ok(wide.meta.warnings.some((warning) => /more than 50 columns/.test(warning)));

  // maxChars over the whole workbook.
  const limited = await extractXlsxText(xlsxOf([{ name: "Big", xml: rowsXml(500) }]), { maxChars: 300 });
  assert.equal(limited.meta.truncated, true);
  assert.ok(limited.text.length <= 300);
  assert.ok(limited.text.startsWith("## Sheet: Big\n10 | 11\n"));

  // Zip bomb: a part that inflates past the per-part limit is never inflated.
  const bombSize = OFFICE_TEXT_DEFAULTS.maxPartBytes + 1;
  const bomb = new Uint8Array(bombSize).fill(0x20);
  bomb.set(strToU8("<worksheet><sheetData>"));
  const bombZip = xlsxOf([
    { name: "Bomb", xml: bomb },
    { name: "Fine", xml: rowsXml(2) },
  ]);
  assert.ok(bombZip.length < 200 * 1024, `the bomb is small on disk (${bombZip.length} B)`);
  const defused = await extractXlsxText(bombZip);
  assert.equal(defused.text, "## Sheet: Fine\n10 | 11\n20 | 21");
  assert.equal(defused.meta.truncated, true);
  assert.deepEqual(defused.meta.warnings, ['Sheet "Bomb" is too large to read and was skipped.']);

  const docBomb = await extractDocxText(zip({ "word/document.xml": bomb }));
  assertEmptyWithReason(docBomb, "docx", /too large to read/, "docx bomb");
}

// --- 7. Entities helper and lazy loading -------------------------------------
assert.equal(decodeXmlEntities("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos; &#65;&#x42;&#x1F600;"), "a & b < c > d \"e\" 'f' AB\u{1F600}");
assert.equal(decodeXmlEntities("&amp;amp; &unknown; &#xD800; & alone"), "&amp; &unknown; &#xD800; & alone", "decoded once, invalid left alone");
assert.equal(decodeXmlEntities(null), "");

for (const file of ["officeText.js", "sourceFiles.js"]) {
  const source = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
  assert.ok(!/from\s+["']fflate["']/.test(source), `${file}: fflate is never a static import`);
  assert.ok(!/require\(\s*["']fflate["']\s*\)/.test(source), `${file}: no require("fflate")`);
}
assert.match(
  readFileSync(new URL("../src/lib/officeText.js", import.meta.url), "utf8"),
  /await import\("fflate"\)/,
  "officeText.js loads fflate with a dynamic import()",
);

console.log("verify-office-text: ok");
