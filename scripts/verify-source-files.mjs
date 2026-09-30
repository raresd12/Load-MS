// H3 Track A (decisions H3-1, H3-2): picked files -> one extraction source.
// Every sample under fixtures/import-samples is classified and read end to
// end with injected readers; limits, legacy formats, the image bundle and the
// privacy rule (bytes only in files[].dataBase64) are asserted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildImageBundle,
  buildTextSource,
  bytesToBase64,
  classifySourceFile,
  classifySourceSelection,
  detectFileSignature,
  DOCX_MIME_TYPE,
  estimateInlineBytes,
  LEGACY_OFFICE_GUIDANCE,
  readSourceFile,
  SOURCE_FILE_ACCEPT,
  SOURCE_IMAGE_ACCEPT,
  SOURCE_LIMITS,
  UNSUPPORTED_SOURCE_FALLBACK,
  XLSX_MIME_TYPE,
} from "../src/lib/sourceFiles.js";
import { INJECTION_LINE } from "./build-import-samples.mjs";

const MIB = 1024 * 1024;
const samplesDir = new URL("../fixtures/import-samples/", import.meta.url);
const readSample = (name) => new Uint8Array(readFileSync(new URL(name, samplesDir)));
const readExpected = (name) => JSON.parse(readFileSync(new URL(`expected/${name}.json`, samplesDir), "utf8"));

const SAMPLES = {
  "program-sections.txt": { type: "text/plain", kind: "text" },
  "program-table.csv": { type: "text/csv", kind: "text" },
  "program.docx": { type: DOCX_MIME_TYPE, kind: "docx" },
  "program.xlsx": { type: XLSX_MIME_TYPE, kind: "xlsx" },
  "minimal.pdf": { type: "application/pdf", kind: "pdf" },
  "page-1.png": { type: "image/png", kind: "image" },
  "page-2.png": { type: "image/png", kind: "image" },
};

// A picked file as the browser gives it: name, type, size. The bytes are only
// reachable through the injected readers.
function pickedFile(name, type, bytes) {
  return { name, type, size: bytes.length, __bytes: bytes };
}

function sampleFile(name, overrides = {}) {
  const bytes = readSample(name);
  return pickedFile(overrides.name ?? name, overrides.type ?? SAMPLES[name]?.type ?? "", bytes);
}

let readerCalls = [];
const readers = {
  readAsText: async (file) => {
    readerCalls.push("text");
    return new TextDecoder("utf-8").decode(file.__bytes);
  },
  readAsArrayBuffer: async (file) => {
    readerCalls.push("arrayBuffer");
    const bytes = file.__bytes;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
  readAsDataUrl: async (file) => {
    readerCalls.push("dataUrl");
    return `data:${file.type || "application/octet-stream"};base64,${Buffer.from(file.__bytes).toString("base64")}`;
  },
};

// Privacy: the file content may only live in files[].dataBase64 (image, PDF)
// or as the extracted text. Never raw bytes, never inside meta or text.
function assertPrivacy(source, label, base64Values = []) {
  const visit = (value, path) => {
    if (value === null || typeof value !== "object") {
      return;
    }
    assert.ok(!(value instanceof ArrayBuffer), `${label}: ${path} is not an ArrayBuffer`);
    assert.ok(!ArrayBuffer.isView(value), `${label}: ${path} is not a typed array`);
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!key.startsWith("__"), `${label}: ${path}.${key} is not the picked file`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(source, "source");

  assert.deepEqual(
    Object.keys(source.meta).filter((key) => /base64|bytes|buffer|data/i.test(key)),
    [],
    `${label}: meta has no data field`,
  );
  const metaText = JSON.stringify(source.meta);
  assert.ok(!metaText.includes("dataBase64"), `${label}: meta never carries dataBase64`);

  for (const base64 of base64Values) {
    assert.ok(base64.length > 16);
    assert.ok(!metaText.includes(base64), `${label}: meta never carries the file content`);
    assert.ok(!String(source.text ?? "").includes(base64), `${label}: text never carries the file content`);
    assert.ok(!String(source.error ?? "").includes(base64), `${label}: error never carries the file content`);
  }

  for (const [index, file] of (source.files ?? []).entries()) {
    for (const key of Object.keys(file)) {
      assert.ok(
        ["name", "mimeType", "sizeBytes", "dataBase64", "page", "pageLabel"].includes(key),
        `${label}: files[${index}].${key} is a known field`,
      );
    }
    if ("dataBase64" in file) {
      assert.equal(typeof file.dataBase64, "string", `${label}: dataBase64 is a string`);
      assert.ok(!file.dataBase64.startsWith("data:"), `${label}: dataBase64 has no data: prefix`);
    }
  }
}

// --- 1. Limits ---------------------------------------------------------------
assert.deepEqual(
  { ...SOURCE_LIMITS },
  {
    MAX_SOURCE_TEXT_CHARS: 80000,
    MAX_IMAGE_FILE_BYTES: 8 * MIB,
    MAX_PDF_FILE_BYTES: 10 * MIB,
    MAX_TEXT_FILE_BYTES: 1 * MIB,
    MAX_OFFICE_FILE_BYTES: 5 * MIB,
    MAX_IMAGES_PER_SOURCE: 6,
    MAX_TOTAL_INLINE_BYTES: 18 * MIB,
    MAX_XLSX_SHEETS: 10,
    MAX_XLSX_ROWS_PER_SHEET: 2000,
  },
  "SOURCE_LIMITS",
);
assert.ok(Object.isFrozen(SOURCE_LIMITS));
assert.equal(UNSUPPORTED_SOURCE_FALLBACK, "For now, copy/paste the content or export as PDF/text.");
assert.ok(LEGACY_OFFICE_GUIDANCE.includes("export as DOCX, XLSX, PDF or text"));
for (const extension of [".docx", ".xlsx", ".pdf", ".txt", ".md", ".csv"]) {
  assert.ok(SOURCE_FILE_ACCEPT.split(",").includes(extension), `file accept has ${extension}`);
}
assert.ok(!/\.docx?(,|$)/.test(SOURCE_IMAGE_ACCEPT) && SOURCE_IMAGE_ACCEPT.includes("image/webp"));
assert.ok(!SOURCE_FILE_ACCEPT.split(",").includes(".doc") && !SOURCE_FILE_ACCEPT.split(",").includes(".xls"));

// --- 2. Classification -------------------------------------------------------
// Same results as the H2 function for everything that was supported.
assert.deepEqual(classifySourceFile("plan.png", "image/png", 1024), { ok: true, kind: "image", mimeType: "image/png" });
assert.deepEqual(classifySourceFile("PLAN.JPG", "", 1024), { ok: true, kind: "image", mimeType: "image/jpeg" });
assert.deepEqual(classifySourceFile("plan.webp", "image/webp", 1024), { ok: true, kind: "image", mimeType: "image/webp" });
assert.deepEqual(classifySourceFile("plan.pdf", "application/pdf", 1024), { ok: true, kind: "pdf", mimeType: "application/pdf" });
assert.deepEqual(classifySourceFile("plan", "application/pdf", 1024), { ok: true, kind: "pdf", mimeType: "application/pdf" });
assert.deepEqual(classifySourceFile("plan.txt", "text/plain", 1024), { ok: true, kind: "text", mimeType: "text/plain" });
assert.equal(classifySourceFile("plan.md", "", 1024).kind, "text");
assert.equal(classifySourceFile("plan.csv", "text/csv", 1024).kind, "text");
assert.equal(classifySourceFile("plan.csv", "application/vnd.ms-excel", 1024).kind, "text", "Windows reports CSV as ms-excel");
assert.equal(classifySourceFile("notes", "text/plain; charset=utf-8", 10).kind, "text");

// New in H3: DOCX and XLSX.
assert.deepEqual(classifySourceFile("plan.docx", DOCX_MIME_TYPE, 1024), { ok: true, kind: "docx", mimeType: DOCX_MIME_TYPE });
assert.deepEqual(classifySourceFile("Plan.XLSX", "", 1024), { ok: true, kind: "xlsx", mimeType: XLSX_MIME_TYPE });
assert.equal(classifySourceFile("plan", DOCX_MIME_TYPE, 1024).kind, "docx", "MIME decides when there is no extension");
assert.equal(classifySourceFile("plan", XLSX_MIME_TYPE, 1024).kind, "xlsx");
assert.equal(classifySourceFile("plan.docx", "application/octet-stream", 1024).kind, "docx", "extension first");

for (const [name, sample] of Object.entries(SAMPLES)) {
  const size = readSample(name).length;
  const byName = classifySourceFile(name, "", size);
  const byBoth = classifySourceFile(name, sample.type, size);
  assert.equal(byName.ok, true, `${name}: accepted`);
  assert.equal(byName.kind, sample.kind, `${name}: kind`);
  assert.deepEqual(byBoth, byName, `${name}: same with the MIME type`);
  assert.equal("error" in byName, false);
}

// Size limits, to the byte.
for (const [name, type, limit, pattern] of [
  ["plan.png", "image/png", 8 * MIB, /image is too large \(max 8 MB\)/],
  ["plan.jpeg", "image/jpeg", 8 * MIB, /image is too large \(max 8 MB\)/],
  ["plan.pdf", "application/pdf", 10 * MIB, /PDF is too large \(max 10 MB\)/],
  ["plan.txt", "text/plain", 1 * MIB, /text file is too large \(max 1 MB\)/],
  ["plan.docx", DOCX_MIME_TYPE, 5 * MIB, /Word document is too large \(max 5 MB\)/],
  ["plan.xlsx", XLSX_MIME_TYPE, 5 * MIB, /Excel workbook is too large \(max 5 MB\)/],
]) {
  assert.equal(classifySourceFile(name, type, limit).ok, true, `${name}: exactly the limit is accepted`);
  const over = classifySourceFile(name, type, limit + 1);
  assert.equal(over.ok, false, `${name}: limit + 1 byte is rejected`);
  assert.equal("kind" in over, false);
  assert.match(over.error, pattern);

  for (const empty of [0, undefined, null, Number.NaN, -1]) {
    assert.deepEqual(classifySourceFile(name, type, empty), { ok: false, error: "The selected file is empty." }, `${name}: empty (${empty})`);
  }
}

// Legacy and related formats: rejected, format named, export guidance.
for (const [name, label] of [
  ["program-legacy.doc", "Legacy Word (.doc)"],
  ["plan.DOC", "Legacy Word (.doc)"],
  ["plan.xls", "Legacy Excel (.xls)"],
  ["plan.rtf", "Rich Text (.rtf)"],
  ["plan.odt", "OpenDocument Text (.odt)"],
  ["plan.ods", "OpenDocument Spreadsheet (.ods)"],
  ["plan.pages", "Apple Pages (.pages)"],
  ["plan.numbers", "Apple Numbers (.numbers)"],
  ["plan.docm", "Macro-enabled Word (.docm)"],
  ["plan.xlsm", "Macro-enabled Excel (.xlsm)"],
  ["plan.xlsb", "Excel binary (.xlsb)"],
]) {
  for (const type of ["", DOCX_MIME_TYPE, "application/msword", "text/plain"]) {
    const result = classifySourceFile(name, type, 2048);
    assert.deepEqual(
      result,
      { ok: false, error: `${label} files are not supported. Open it and export as DOCX, XLSX, PDF or text.` },
      `${name} (${type || "no type"})`,
    );
  }
}
assert.match(classifySourceFile("plan", "application/msword", 10).error, /^Legacy Word \(\.doc\) files are not supported/);
assert.match(classifySourceFile("plan", "application/vnd.ms-excel", 10).error, /^Legacy Excel \(\.xls\)/);
assert.equal(classifySourceFile("program-legacy.doc", "", readSample("program-legacy.doc").length).ok, false);
assert.deepEqual([...readSample("program-legacy.doc").subarray(0, 4)], [0xd0, 0xcf, 0x11, 0xe0], "the legacy sample has the OLE magic");

// Everything else keeps the fallback guidance.
for (const [name, type] of [
  ["plan.zip", "application/zip"],
  ["plan.pptx", ""],
  ["plan", ""],
  ["plan.exe", "application/octet-stream"],
]) {
  const result = classifySourceFile(name, type, 1024);
  assert.deepEqual(result, { ok: false, error: `This file type is not supported. ${UNSUPPORTED_SOURCE_FALLBACK}` }, name);
}
assert.deepEqual(classifySourceFile("plan.gif", "image/gif", 1024), {
  ok: false,
  error: `Only JPG, PNG and WebP images are supported. ${UNSUPPORTED_SOURCE_FALLBACK}`,
});
assert.equal(classifySourceFile("plan.heic", "image/heic", 1024).ok, false);
assert.equal(classifySourceFile(null, null, 10).ok, false);

// --- 3. Signatures and base64 --------------------------------------------------
assert.equal(detectFileSignature(readSample("page-1.png")), "png");
assert.equal(detectFileSignature(readSample("minimal.pdf")), "pdf");
assert.equal(detectFileSignature(readSample("program.docx")), "zip");
assert.equal(detectFileSignature(readSample("program.xlsx")), "zip");
assert.equal(detectFileSignature(readSample("program-legacy.doc")), "ole");
assert.equal(detectFileSignature(readSample("program-sections.txt")), "");
assert.equal(detectFileSignature(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
assert.equal(detectFileSignature(new TextEncoder().encode("RIFF\u0001\u0002\u0003\u0004WEBPVP8 ")), "webp");
assert.equal(detectFileSignature(new TextEncoder().encode("GIF89a")), "gif");
assert.equal(detectFileSignature(new TextEncoder().encode("{\\rtf1\\ansi")), "rtf");
assert.equal(detectFileSignature(new TextEncoder().encode("\n\n junk %PDF-1.7")), "pdf");
assert.equal(detectFileSignature(new Uint8Array(0)), "");
assert.equal(detectFileSignature(undefined), "");

for (const length of [0, 1, 2, 3, 4, 5, 255, 8191, 8192, 8193, 30000]) {
  const bytes = Uint8Array.from({ length }, (_, index) => (index * 131 + 7) % 256);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), `base64 of ${length} bytes`);
}
assert.equal(bytesToBase64(Uint8Array.from([1, 2, 3, 4]).buffer), "AQIDBA==", "accepts an ArrayBuffer");
assert.equal(estimateInlineBytes(0), 0);
assert.equal(estimateInlineBytes(1), 4);
assert.equal(estimateInlineBytes(3), 4);
assert.equal(estimateInlineBytes(4), 8);
assert.equal(estimateInlineBytes(8 * MIB), Buffer.alloc(8 * MIB).toString("base64").length);

// --- 4. Samples end to end -----------------------------------------------------
// Valid containers: the generated PNG and PDF are real files.
{
  const { inflateSync } = await import("node:zlib");
  for (const name of ["page-1.png", "page-2.png"]) {
    const png = Buffer.from(readSample(name));
    assert.equal(png.readUInt32BE(16), 2, `${name}: width 2`);
    assert.equal(png.readUInt32BE(20), 2, `${name}: height 2`);
    const idatAt = png.indexOf("IDAT");
    const idatLength = png.readUInt32BE(idatAt - 4);
    assert.equal(inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLength)).length, 14, `${name}: 2 scanlines of 1 + 2 x 3 bytes`);
    assert.equal(png.subarray(-8, -4).toString("latin1"), "IEND");
  }
  assert.notDeepEqual(readSample("page-1.png"), readSample("page-2.png"), "the two pages differ");

  const pdfBytes = readSample("minimal.pdf");
  const pdf = Buffer.from(pdfBytes).toString("latin1");
  assert.ok(pdfBytes.length < 2048, "minimal.pdf under 2 KB");
  assert.ok(pdf.startsWith("%PDF-1.4\n") && pdf.endsWith("%%EOF\n"));
  assert.ok(!pdf.includes("\r"), "line endings untouched (.gitattributes -text)");
  const xrefAt = Number(/startxref\n(\d+)\n/.exec(pdf)[1]);
  assert.equal(pdf.slice(xrefAt, xrefAt + 5), "xref\n", "startxref points at the xref table");
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((offset, index) => {
    assert.equal(pdf.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`, `object ${index + 1} offset`);
  });
  const stream = /stream\n([\s\S]*?)\nendstream/.exec(pdf)[1];
  assert.equal(Number(/\/Length (\d+)/.exec(pdf)[1]), stream.length, "stream length");
  assert.ok(stream.includes("(Day 1 - Back Squat 5x5 @ 75% 1RM, rest 3-4 min) Tj"), "one program line in the text stream");
}

// The hand-written text samples carry every construct the phase is about.
{
  const text = Buffer.from(readSample("program-sections.txt")).toString("utf8");
  assert.ok(!text.includes("\r"), "program-sections.txt keeps LF line endings");
  for (const [label, pattern] of [
    ["4 days", /^DAY 1 - [\s\S]*^DAY 2 - [\s\S]*^DAY 3 - [\s\S]*^DAY 4 - /m],
    ["sections", /^Main Lift$[\s\S]*^Accessories/m],
    ["superset", /^A1\. .*\nA2\. /m],
    ["percent-based", /5x5 @ 75% 1RM/],
    ["timed hold", /3 x 30 s/],
    ["per side", /3 x 10 \/ side/],
    ["RPE range", /RPE 7-8/],
    ["rest range", /rest 2-3 min/],
    ["AMRAP", /2 x AMRAP/],
    ["warm-up block", /^Warm-up$/m],
    ["recovery day", /^DAY 3 - RECOVERY$/m],
    ["block note", /Week 1-4/],
    ["kg load", /@ 80 kg/],
    ["lb load", /@ 175 lb/],
    ["instruction-like line", new RegExp(INJECTION_LINE)],
  ]) {
    assert.match(text, pattern, `program-sections.txt: ${label}`);
  }
  assert.equal(text.match(/^Warm-up$/gm).length, 1, "warm-up on one day only");

  const csv = Buffer.from(readSample("program-table.csv")).toString("utf8");
  const rows = csv.trim().split("\n");
  assert.equal(rows[0], "Day,Section,Order,Exercise,Sets,Reps,Load,RPE,Rest,Notes");
  assert.equal(rows.length, 25);
  assert.ok(rows.includes(`Program,,,Coach note,,,,,,${INJECTION_LINE}.`), "instruction-like line in the CSV");
  for (const pattern of [/75% 1RM/, /,30 s,/, /10 \/ side/, /,7-8,/, /,2-3 min,/, /AMRAP/, /Warm-up/, /Day 3 - Recovery/, /Week 1-4/, /80 kg/, /175 lb/, /A1,.*\n.*A2,/]) {
    assert.match(csv, pattern, `program-table.csv: ${pattern}`);
  }
}

{
  readerCalls = [];
  const file = sampleFile("program-sections.txt");
  const source = await readSourceFile(file, readers);
  assert.deepEqual(readerCalls, ["text"]);
  assert.deepEqual(source, {
    ok: true,
    kind: "text",
    text: Buffer.from(file.__bytes).toString("utf8"),
    files: [{ name: "program-sections.txt", mimeType: "text/plain", sizeBytes: file.size }],
    meta: { origin: "file", pages: null, sheets: null, truncated: false, warnings: [] },
  });
  assert.ok(source.text.split("\n").includes(`Coach note: ${INJECTION_LINE}.`), "instruction-like line stays data");
  assertPrivacy(source, "txt");
}

{
  const file = sampleFile("program-table.csv");
  const source = await readSourceFile(file, readers);
  assert.equal(source.ok, true);
  assert.equal(source.kind, "text");
  assert.equal(source.text, Buffer.from(file.__bytes).toString("utf8"));
  assert.equal(source.meta.origin, "file");
  assertPrivacy(source, "csv");
}

// BOM and CRLF are normalised; nothing else changes.
{
  const bytes = new TextEncoder().encode("﻿Day 1\r\nSquat 3 x 5\rPress 3 x 8\r\n");
  const source = await readSourceFile(pickedFile("windows.txt", "text/plain", bytes), readers);
  assert.equal(source.text, "Day 1\nSquat 3 x 5\nPress 3 x 8\n");
}

for (const name of ["program.docx", "program.xlsx"]) {
  readerCalls = [];
  const file = sampleFile(name);
  const expected = readExpected(name);
  const source = await readSourceFile(file, readers);
  const kind = name.endsWith(".docx") ? "docx" : "xlsx";

  assert.deepEqual(readerCalls, ["arrayBuffer"], `${name}: read once, as bytes`);
  assert.equal(source.ok, true);
  assert.equal(source.kind, "text", `${name}: office files become text`);
  assert.equal(source.text, expected.text, `${name}: the text that is sent is the extracted text`);
  assert.deepEqual(source.files, [
    { name, mimeType: kind === "docx" ? DOCX_MIME_TYPE : XLSX_MIME_TYPE, sizeBytes: file.size },
  ]);
  assert.deepEqual(source.meta, {
    origin: "office",
    pages: null,
    sheets: kind === "xlsx" ? 5 : null,
    truncated: false,
    warnings: expected.meta.warnings,
    format: kind,
    paragraphs: kind === "docx" ? expected.meta.paragraphs : null,
    rows: expected.meta.rows,
  });
  assert.ok(source.text.includes(`${INJECTION_LINE}.`), `${name}: instruction-like line stays data`);
  assert.ok(source.text.length <= SOURCE_LIMITS.MAX_SOURCE_TEXT_CHARS);
  assertPrivacy(source, name, [Buffer.from(file.__bytes).toString("base64").slice(0, 64)]);
}

for (const name of ["minimal.pdf", "page-1.png", "page-2.png"]) {
  const file = sampleFile(name);
  const base64 = Buffer.from(file.__bytes).toString("base64");
  const kind = name.endsWith(".pdf") ? "pdf" : "image";
  const expected = {
    ok: true,
    kind,
    files: [{ name, mimeType: SAMPLES[name].type, sizeBytes: file.size, dataBase64: base64 }],
    meta: { origin: "file", pages: kind === "image" ? 1 : null, sheets: null, truncated: false, warnings: [] },
  };

  readerCalls = [];
  const viaDataUrl = await readSourceFile(file, readers);
  assert.deepEqual(readerCalls, ["dataUrl"], `${name}: read once`);
  assert.deepEqual(viaDataUrl, expected, `${name}: data URL reader`);
  assert.equal("text" in viaDataUrl, false);
  assertPrivacy(viaDataUrl, name, [base64]);

  readerCalls = [];
  const viaBuffer = await readSourceFile(file, { readAsArrayBuffer: readers.readAsArrayBuffer });
  assert.deepEqual(readerCalls, ["arrayBuffer"]);
  assert.deepEqual(viaBuffer, expected, `${name}: ArrayBuffer reader gives the same source`);
  assertPrivacy(viaBuffer, name, [base64]);
}

// Without injected readers the Blob methods are used (what the browser File has).
{
  const bytes = readSample("program.docx");
  const blobLike = new File([bytes], "program.docx", { type: DOCX_MIME_TYPE });
  const source = await readSourceFile(blobLike);
  assert.equal(source.ok, true);
  assert.equal(source.text, readExpected("program.docx").text);

  const image = await readSourceFile(new File([readSample("page-2.png")], "page-2.png", { type: "image/png" }));
  assert.equal(image.files[0].dataBase64, Buffer.from(readSample("page-2.png")).toString("base64"));

  const text = await readSourceFile(new File(["Day 1\nSquat 3 x 5"], "plan.md", { type: "" }));
  assert.equal(text.text, "Day 1\nSquat 3 x 5");
}

// --- 5. Failures are results, never exceptions ----------------------------------
function assertFailure(source, pattern, label) {
  assert.equal(source.ok, false, `${label}: ok false`);
  assert.equal(source.kind, null);
  assert.deepEqual(source.files, []);
  assert.equal("text" in source, false);
  assert.match(source.error, pattern, `${label}: message`);
  assert.equal(typeof source.meta, "object");
  assert.ok(Array.isArray(source.meta.warnings));
  assertPrivacy(source, label);
}

{
  readerCalls = [];
  assertFailure(
    await readSourceFile(sampleFile("program-legacy.doc"), readers),
    /^Legacy Word \(\.doc\) files are not supported\. Open it and export as DOCX, XLSX, PDF or text\.$/,
    "legacy .doc",
  );
  assert.deepEqual(readerCalls, [], "a rejected file is never read");

  // The same bytes renamed: the content decides.
  assertFailure(
    await readSourceFile(sampleFile("program-legacy.doc", { name: "renamed.docx", type: DOCX_MIME_TYPE }), readers),
    /password-protected or saved in the legacy binary format.*export as DOCX, XLSX, PDF or text/,
    "legacy renamed to .docx",
  );
  assertFailure(
    await readSourceFile(sampleFile("program-legacy.doc", { name: "renamed.xlsx", type: XLSX_MIME_TYPE }), readers),
    /password-protected or saved in the legacy binary format/,
    "legacy renamed to .xlsx",
  );
  assertFailure(
    await readSourceFile(sampleFile("program-legacy.doc", { name: "renamed.pdf", type: "application/pdf" }), readers),
    /not a PDF: it looks like a legacy Office document.*export as DOCX, XLSX, PDF or text/,
    "legacy renamed to .pdf",
  );
  assertFailure(
    await readSourceFile(sampleFile("program-sections.txt", { name: "renamed.pdf", type: "application/pdf" }), readers),
    /not a valid PDF/,
    "text renamed to .pdf",
  );
  assertFailure(
    await readSourceFile(sampleFile("minimal.pdf", { name: "renamed.png", type: "image/png" }), readers),
    /not a valid JPG, PNG or WebP image/,
    "pdf renamed to .png",
  );
  assertFailure(
    await readSourceFile(sampleFile("program.xlsx", { name: "renamed.docx", type: DOCX_MIME_TYPE }), readers),
    /Excel workbook, not a Word document/,
    "xlsx renamed to .docx",
  );

  // A PNG saved with a .jpg name is sent with its real type.
  const mislabelled = await readSourceFile(sampleFile("page-1.png", { name: "photo.jpg", type: "image/jpeg" }), readers);
  assert.equal(mislabelled.ok, true);
  assert.equal(mislabelled.files[0].mimeType, "image/png");

  const corrupt = readSample("program.docx").slice(0, 900);
  const corruptSource = await readSourceFile(pickedFile("cut.docx", DOCX_MIME_TYPE, corrupt), readers);
  assertFailure(corruptSource, /damaged or encrypted/, "corrupt docx");
  // Fix round 2: a reason that names its own next step is not followed by a second one.
  assert.ok(!corruptSource.error.includes(UNSUPPORTED_SOURCE_FALLBACK), "one next step, not two");
  assert.match(corruptSource.error, /Save it again or export as PDF or text\.$/);
  assert.equal(corruptSource.meta.warnings.length, 1);

  assertFailure(await readSourceFile(pickedFile("empty.docx", DOCX_MIME_TYPE, new Uint8Array(0)), readers), /file is empty/, "empty docx");
  assertFailure(await readSourceFile(pickedFile("blank.txt", "text/plain", new TextEncoder().encode("  \n \n")), readers), /no readable text/, "blank text");
  assertFailure(
    await readSourceFile(pickedFile("long.txt", "text/plain", new TextEncoder().encode("a".repeat(80001))), readers),
    /too long \(over 80,000 characters\)/,
    "text over the character limit",
  );
  assert.equal(
    (await readSourceFile(pickedFile("max.txt", "text/plain", new TextEncoder().encode("a".repeat(80000))), readers)).ok,
    true,
    "exactly the character limit",
  );

  // The declared size is small but the bytes are not: the real length counts.
  const lying = { name: "lying.docx", type: DOCX_MIME_TYPE, size: 100, __bytes: new Uint8Array(5 * MIB + 1) };
  assertFailure(await readSourceFile(lying, readers), /Word document is too large \(max 5 MB\)/, "size mismatch");

  const failing = {
    readAsText: async () => {
      throw new Error("NotReadableError");
    },
    readAsArrayBuffer: async () => {
      throw new Error("NotReadableError");
    },
    readAsDataUrl: async () => {
      throw new Error("NotReadableError");
    },
  };
  for (const name of Object.keys(SAMPLES)) {
    assertFailure(await readSourceFile(sampleFile(name), failing), /could not be read\. Try selecting it again\./, `${name}: reader failure`);
  }
  assertFailure(await readSourceFile(sampleFile("page-1.png"), { readAsDataUrl: async () => "" }), /could not be read/, "empty data URL");
  assertFailure(await readSourceFile(sampleFile("program.docx"), { readAsArrayBuffer: async () => null }), /could not be read/, "no bytes");
  assertFailure(await readSourceFile({ name: "plan.png", type: "image/png", size: 10 }), /could not be read/, "no reader at all");

  for (const input of [null, undefined, "plan.txt", 7]) {
    assertFailure(await readSourceFile(input, readers), /Choose a file first/, `input ${String(input)}`);
  }
}

// Pasted text.
{
  assert.deepEqual(buildTextSource("Day 1\r\nSquat 3 x 5"), {
    ok: true,
    kind: "text",
    text: "Day 1\nSquat 3 x 5",
    files: [],
    meta: { origin: "paste", pages: null, sheets: null, truncated: false, warnings: [] },
  });
  assert.equal(buildTextSource(INJECTION_LINE).text, INJECTION_LINE);
  const empty = buildTextSource("   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "Paste the program text first.");
  assert.equal(empty.meta.origin, "paste");
  assert.equal(buildTextSource("a".repeat(80000)).ok, true);
  assert.match(buildTextSource("a".repeat(80001)).error, /over 80,000 characters/);
  assert.equal(buildTextSource(null).ok, false);
}

// --- 6. Image bundle (decision H3-1) ---------------------------------------------
const page1 = await readSourceFile(sampleFile("page-1.png"), readers);
const page2 = await readSourceFile(sampleFile("page-2.png"), readers);
const pdfSource = await readSourceFile(sampleFile("minimal.pdf"), readers);
const textSource = await readSourceFile(sampleFile("program-sections.txt"), readers);
const officeSource = await readSourceFile(sampleFile("program.docx"), readers);

{
  const bundle = buildImageBundle([page1, page2], [1, 0]);
  assert.deepEqual(bundle, {
    ok: true,
    kind: "images",
    files: [
      { ...page2.files[0], page: 1, pageLabel: "Page 1 of 2" },
      { ...page1.files[0], page: 2, pageLabel: "Page 2 of 2" },
    ],
    meta: { origin: "file", pages: 2, sheets: null, truncated: false, warnings: [] },
  });
  assert.deepEqual(bundle.files.map((file) => file.name), ["page-2.png", "page-1.png"], "the given order");
  assertPrivacy(bundle, "bundle", bundle.files.map((file) => file.dataBase64));

  const natural = buildImageBundle([page1, page2]);
  assert.deepEqual(natural.files.map((file) => [file.name, file.page]), [["page-1.png", 1], ["page-2.png", 2]], "no order = picked order");
  assert.deepEqual(buildImageBundle([page1, page2], [0, 1]), natural);

  // File entries work as well as sources, and the inputs are not modified.
  const before = JSON.stringify([page1, page2]);
  const fromEntries = buildImageBundle([page1.files[0], page2.files[0]], [1, 0]);
  assert.deepEqual(fromEntries, bundle);
  assert.equal(JSON.stringify([page1, page2]), before, "inputs untouched");
  assert.equal("page" in page1.files[0], false);

  const single = buildImageBundle([page1]);
  assert.equal(single.kind, "images");
  assert.deepEqual(single.files.map((file) => file.pageLabel), ["Page 1 of 1"]);

  // Same file twice is two pages: order is by index, not by name.
  const twice = buildImageBundle([page1, page1], [1, 0]);
  assert.equal(twice.ok, true);
  assert.equal(twice.files.length, 2);
}

function assertBundleRefused(result, pattern, label) {
  assert.equal(result.ok, false, `${label}: refused`);
  assert.equal(result.kind, null);
  assert.deepEqual(result.files, [], `${label}: no files leak into a refusal`);
  assert.match(result.error, pattern, `${label}: message`);
}

{
  const six = [page1, page2, page1, page2, page1, page2];
  assert.equal(buildImageBundle(six).ok, true, "6 images are accepted");
  assert.equal(buildImageBundle(six).meta.pages, 6);
  assertBundleRefused(buildImageBundle([...six, page1]), /at most 6 images/, "7 images");
  assertBundleRefused(buildImageBundle([]), /at least one image/, "no images");
  assertBundleRefused(buildImageBundle(null), /at least one image/, "null");

  // Mixed kinds: an image bundle never contains a PDF, text or office source.
  assertBundleRefused(buildImageBundle([page1, pdfSource]), /all of them are images.*PDF, Word, Excel or text file is always sent alone/, "image + pdf");
  assertBundleRefused(buildImageBundle([pdfSource, page1], [1, 0]), /always sent alone/, "pdf + image, reordered");
  assertBundleRefused(buildImageBundle([pdfSource, pdfSource]), /always sent alone/, "two PDFs");
  assertBundleRefused(buildImageBundle([page1, textSource]), /always sent alone/, "image + text");
  assertBundleRefused(buildImageBundle([page1, officeSource]), /always sent alone/, "image + docx");
  assertBundleRefused(buildImageBundle([page1, pdfSource.files[0]]), /always sent alone/, "image + pdf entry");
  assertBundleRefused(buildImageBundle([page1, { name: "x.gif", mimeType: "image/gif", sizeBytes: 5, dataBase64: "AAAA" }]), /always sent alone/, "unsupported image type");
  assertBundleRefused(buildImageBundle([page1, await readSourceFile(sampleFile("program-legacy.doc"), readers)]), /always sent alone/, "image + failed source");
  assertBundleRefused(buildImageBundle([page1, buildImageBundle([page1, page2])]), /always sent alone/, "a bundle inside a bundle");
  assertBundleRefused(buildImageBundle([page1, null]), /always sent alone/, "missing item");
  assertBundleRefused(buildImageBundle([page1, { name: "p.png", mimeType: "image/png", sizeBytes: 5 }]), /could not be read/, "image without data");

  // Order must name every image exactly once.
  for (const order of [[0], [0, 0], [0, 2], [0, 1, 1], [1, -1], [0, 1.5], ["0", "1"], [0, 1, 2]]) {
    assertBundleRefused(buildImageBundle([page1, page2], order), /page order is not valid/, `order ${JSON.stringify(order)}`);
  }

  // Total size: counted on the base64 form.
  const entry = (sizeBytes) => ({ name: "scan.png", mimeType: "image/png", sizeBytes, dataBase64: "AAAA" });
  const fits = Math.floor((18 * MIB) / 4) * 3; // raw bytes whose base64 is exactly 18 MiB
  assert.equal(estimateInlineBytes(fits), 18 * MIB);
  assert.equal(buildImageBundle([entry(fits / 3), entry(fits / 3), entry(fits / 3)]).ok, true, "exactly the total limit");
  assertBundleRefused(
    buildImageBundle([entry(fits / 3), entry(fits / 3), entry(fits / 3 + 1)]),
    /too large together \(max 18 MB once encoded/,
    "total over the limit",
  );
  assertBundleRefused(buildImageBundle([entry(8 * MIB), entry(8 * MIB)]), /too large together/, "two full-size images");
  assertBundleRefused(buildImageBundle([entry(8 * MIB + 1)]), /image is too large \(max 8 MB\)/, "one image over its own limit");
  const heavy = "A".repeat(18 * MIB + 4);
  assertBundleRefused(
    buildImageBundle([{ name: "lying.png", mimeType: "image/png", sizeBytes: 10, dataBase64: heavy }]),
    /too large together/,
    "the real base64 length counts, not the declared size",
  );
}

// What one pick becomes, before anything is read.
{
  const meta = (name, size = 1000) => ({ name, type: "", size });
  assert.equal(classifySourceSelection([meta("a.png")]).kind, "image");
  assert.equal(classifySourceSelection([meta("a.pdf")]).kind, "pdf");
  assert.equal(classifySourceSelection([meta("a.docx")]).kind, "docx");
  assert.equal(classifySourceSelection([meta("a.xlsx")]).kind, "xlsx");
  assert.equal(classifySourceSelection([meta("a.txt")]).kind, "text");

  const images = classifySourceSelection([meta("a.png"), meta("b.jpg"), meta("c.webp")]);
  assert.equal(images.ok, true);
  assert.equal(images.kind, "images");
  assert.deepEqual(images.items.map((item) => item.mimeType), ["image/png", "image/jpeg", "image/webp"]);

  assert.match(classifySourceSelection([meta("a.png"), meta("b.pdf")]).error, /always sent alone/);
  assert.match(classifySourceSelection([meta("a.pdf"), meta("b.pdf")]).error, /always sent alone/);
  assert.match(classifySourceSelection([meta("a.docx"), meta("b.xlsx")]).error, /always sent alone/);
  assert.match(classifySourceSelection([meta("a.txt"), meta("b.txt")]).error, /always sent alone/);
  assert.match(classifySourceSelection(Array.from({ length: 7 }, (_, index) => meta(`p${index}.png`))).error, /at most 6 images/);
  assert.equal(classifySourceSelection(Array.from({ length: 6 }, (_, index) => meta(`p${index}.png`))).ok, true);
  assert.match(classifySourceSelection([meta("a.png", 8 * MIB), meta("b.png", 8 * MIB)]).error, /too large together/);
  assert.equal(
    classifySourceSelection([meta("a.png"), meta("old.doc")]).error,
    "old.doc: Legacy Word (.doc) files are not supported. Open it and export as DOCX, XLSX, PDF or text.",
  );
  assert.equal(classifySourceSelection([meta("old.doc")]).error, "Legacy Word (.doc) files are not supported. Open it and export as DOCX, XLSX, PDF or text.");
  assert.equal(classifySourceSelection([]).ok, false);
  assert.equal(classifySourceSelection(undefined).error, "Choose a file first.");
}

// --- 7. Nothing is stored ---------------------------------------------------------
{
  const source = readFileSync(new URL("../src/lib/sourceFiles.js", import.meta.url), "utf8");
  const office = readFileSync(new URL("../src/lib/officeText.js", import.meta.url), "utf8");
  for (const [name, code] of [["sourceFiles.js", source], ["officeText.js", office]]) {
    assert.ok(!/localStorage|sessionStorage|indexedDB|writeStorage|from "\.\/storage\.js"/.test(code), `${name}: no storage access`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon/.test(code), `${name}: no network access`);
  }
}

console.log("verify-source-files: ok");
