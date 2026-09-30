// H3 fix round 1, picked files (decision H3-12):
// - a text file is checked by content: a picture, a PDF or an office file
//   renamed to .txt / .md / .csv is refused with guidance, UTF-16 is decoded
// - photos and PDFs are encoded by the browser (FileReader.readAsDataURL)
//   when no reader is injected, and bytesToBase64 uses the engine's encoder
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  bytesToBase64,
  bytesToBase64Portable,
  readSourceFile,
  UTF16_TEXT_WARNING,
} from "../src/lib/sourceFiles.js";

const samplesDir = new URL("../fixtures/import-samples/", import.meta.url);
const readSample = (name) => new Uint8Array(readFileSync(new URL(name, samplesDir)));

/** A picked file as a browser Blob behaves: name, type, size, text(), arrayBuffer(). */
function blobLike(name, type, bytes) {
  return {
    name,
    type,
    size: bytes.length,
    text: async () => new TextDecoder("utf-8").decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function utf16(text, { bigEndian = false, bom = true } = {}) {
  const out = [];
  if (bom) out.push(...(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]));
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    out.push(...(bigEndian ? [code >> 8, code & 0xff] : [code & 0xff, code >> 8]));
  }
  return Uint8Array.from(out);
}

const textReaderOnly = (bytes) => ({ readAsText: async () => new TextDecoder("utf-8").decode(bytes) });

// ---------------------------------------------------------------------------
// 1. Text files are checked by content
// ---------------------------------------------------------------------------
{
  const refused = [
    ["page-1.png", "plan.txt", "text/plain", /not text: it is a PNG image\. Pick it as a photo instead\./],
    ["program.docx", "plan.csv", "text/csv", /not text: it looks like a Word or Excel document\. Rename it to \.docx or \.xlsx/],
    ["program.xlsx", "plan.md", "text/markdown", /not text: it looks like a Word or Excel document/],
    ["minimal.pdf", "plan.txt", "text/plain", /not text: it is a PDF\. Rename it to \.pdf/],
    ["program-legacy.doc", "plan.txt", "text/plain", /not text: it looks like a legacy Office document\. Open it and export as DOCX, XLSX, PDF or text\./],
  ];

  for (const [sample, name, type, pattern] of refused) {
    const bytes = readSample(sample);

    // As the app reads it (no injected reader): by its bytes.
    const direct = await readSourceFile(blobLike(name, type, bytes));
    assert.equal(direct.ok, false, `${sample} as ${name}: refused`);
    assert.match(direct.error, pattern, `${sample} as ${name}: guidance`);
    assert.equal(direct.kind, null);
    assert.deepEqual(direct.files, []);
    assert.ok(!("text" in direct), "no garbage text is returned");

    // With only a text reader (decoded text is all there is): still refused.
    const decoded = await readSourceFile({ name, type, size: bytes.length }, textReaderOnly(bytes));
    assert.equal(decoded.ok, false, `${sample} as ${name}, text reader: refused`);
    assert.match(decoded.error, /not text|not readable text/, `${sample} as ${name}, text reader: reason`);
  }

  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  assert.match((await readSourceFile(blobLike("plan.txt", "text/plain", jpeg))).error, /it is a JPG image/);
  const rtf = new TextEncoder().encode("{\\rtf1\\ansi Day 1 Squat 5x5}");
  assert.match((await readSourceFile(blobLike("plan.txt", "text/plain", rtf))).error, /Rich Text \(\.rtf\) document/);
  assert.match((await readSourceFile({ name: "plan.txt", size: rtf.length }, textReaderOnly(rtf))).error, /Rich Text/);

  // Unknown binary data.
  const noise = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7919 + 13) % 256);
  const binary = await readSourceFile(blobLike("plan.txt", "text/plain", noise));
  assert.equal(binary.ok, false);
  assert.match(binary.error, /not readable text \(it holds binary data\)/);

  // UTF-16 "Unicode Text" exports are text.
  const table = "Day 1\tSquat\t5x5\t80 kg\r\nZiua 2\tÎmpins\t3x8\t60 kg";
  const expectedText = "Day 1\tSquat\t5x5\t80 kg\nZiua 2\tÎmpins\t3x8\t60 kg";

  for (const [label, bytes] of [
    ["UTF-16LE with BOM", utf16(table)],
    ["UTF-16BE with BOM", utf16(table, { bigEndian: true })],
    ["UTF-16LE without BOM", utf16(table, { bom: false })],
    ["UTF-16BE without BOM", utf16(table, { bigEndian: true, bom: false })],
  ]) {
    const source = await readSourceFile(blobLike("plan.txt", "text/plain", bytes));
    assert.equal(source.ok, true, `${label}: accepted (${source.error})`);
    assert.equal(source.kind, "text");
    assert.equal(source.text, expectedText, `${label}: decoded`);
    assert.deepEqual(source.meta.warnings, [UTF16_TEXT_WARNING], `${label}: said`);
    assert.ok(!source.text.includes("\u0000") && !source.text.includes("�"));
  }

  // The same export decoded as UTF-8 by a text reader is refused, never sent as NUL-filled text.
  const mangled = await readSourceFile({ name: "plan.txt", size: 10 }, textReaderOnly(utf16(table)));
  assert.equal(mangled.ok, false);
  assert.match(mangled.error, /not readable text/);

  // Ordinary text is untouched: UTF-8 with and without BOM, CRLF, diacritics,
  // tabs, a form feed, and text that only talks about a PDF.
  const plain = "Ziua 1 - Împins\r\nSquat\t5x5 @ 80 kg\r\n\fGenuflexiuni: 3 × 10 — odihnă 90 s\r\nExport as %PDF- or PK if needed";
  const plainExpected = plain.replace(/\r\n/g, "\n");

  for (const [label, bytes] of [
    ["UTF-8", new TextEncoder().encode(plain)],
    ["UTF-8 with BOM", Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(plain)])],
  ]) {
    const source = await readSourceFile(blobLike("plan.md", "text/markdown", bytes));
    assert.equal(source.ok, true, label);
    assert.equal(source.text, plainExpected, label);
    assert.deepEqual(source.meta.warnings, [], label);
    const viaReader = await readSourceFile({ name: "plan.md", size: bytes.length }, textReaderOnly(bytes));
    assert.equal(viaReader.ok, true, label);
    assert.equal(viaReader.text, plainExpected, label);
  }

  for (const sample of ["program-sections.txt", "program-table.csv"]) {
    const bytes = readSample(sample);
    const source = await readSourceFile(blobLike(sample, "", bytes));
    assert.equal(source.ok, true, sample);
    assert.equal(source.text, new TextDecoder().decode(bytes).replace(/\r\n?/g, "\n"), sample);
  }

  // The real size counts, not the declared one.
  const big = await readSourceFile({ ...blobLike("plan.txt", "text/plain", new Uint8Array(1024 * 1024 + 1).fill(0x61)), size: 10 });
  assert.equal(big.ok, false);
  assert.match(big.error, /text file is too large \(max 1 MB\)/);
}

// ---------------------------------------------------------------------------
// 2. Base64: the engine encodes
// ---------------------------------------------------------------------------
{
  for (const length of [0, 1, 2, 3, 4, 5, 8191, 8192, 8193, 24575, 24576, 24577, 100003]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 256);
    const expected = Buffer.from(bytes).toString("base64");
    assert.equal(bytesToBase64(bytes), expected, `${length} bytes`);
    assert.equal(bytesToBase64Portable(bytes), expected, `${length} bytes, portable`);
  }

  // Without Uint8Array.prototype.toBase64 (older browsers) the btoa path gives the same.
  const native = Uint8Array.prototype.toBase64;
  const bytes = Uint8Array.from({ length: 70001 }, (_, index) => (index * 17 + 3) % 256);
  try {
    delete Uint8Array.prototype.toBase64;
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), "btoa path");
    const savedBtoa = globalThis.btoa;
    try {
      globalThis.btoa = undefined;
      assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), "portable path");
    } finally {
      globalThis.btoa = savedBtoa;
    }

    // 8 MiB used to take seconds in a script loop.
    const large = new Uint8Array(8 * 1024 * 1024).fill(0x5a);
    const started = performance.now();
    const encoded = bytesToBase64(large);
    const ms = performance.now() - started;
    assert.equal(encoded.length, Math.ceil(large.length / 3) * 4);
    assert.ok(ms < 5000, `8 MiB are encoded by btoa in ${Math.round(ms)} ms`);
  } finally {
    if (native) {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(Uint8Array.prototype, "toBase64", { value: native, configurable: true, writable: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Photos and PDFs: FileReader.readAsDataURL when nothing is injected
// ---------------------------------------------------------------------------
{
  const calls = [];
  const savedFileReader = globalThis.FileReader;

  class StubFileReader {
    readAsDataURL(blob) {
      calls.push("readAsDataURL");
      blob
        .arrayBuffer()
        .then((buffer) => {
          if (blob.failRead) throw new Error("NotReadableError");
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
          this.onload?.();
        })
        .catch((error) => {
          this.error = error;
          this.onerror?.();
        });
    }
  }

  function pickedBlob(name, type, bytes) {
    const blob = new Blob([bytes], { type });
    const arrayBuffer = blob.arrayBuffer.bind(blob);
    blob.name = name;
    blob.arrayBuffer = async () => {
      calls.push("arrayBuffer");
      return arrayBuffer();
    };
    return blob;
  }

  try {
    globalThis.FileReader = StubFileReader;

    for (const [sample, type, kind] of [
      ["page-1.png", "image/png", "image"],
      ["minimal.pdf", "application/pdf", "pdf"],
    ]) {
      const bytes = readSample(sample);
      calls.length = 0;
      const source = await readSourceFile(pickedBlob(sample, type, bytes));
      assert.equal(source.ok, true, `${sample}: ${source.error}`);
      assert.equal(source.kind, kind);
      assert.equal(source.files[0].dataBase64, Buffer.from(bytes).toString("base64"), `${sample}: same bytes`);
      // The stub reads the blob itself; the module asked FileReader, once.
      assert.deepEqual(calls, ["readAsDataURL", "arrayBuffer"], `${sample}: read through FileReader`);
    }

    // A mislabelled file is still found out from the data URL.
    const wrong = await readSourceFile(pickedBlob("scan.pdf", "application/pdf", readSample("page-1.png")));
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /not a valid PDF/);

    // A failing read is a returned error.
    const failing = pickedBlob("page-1.png", "image/png", readSample("page-1.png"));
    failing.failRead = true;
    const failed = await readSourceFile(failing);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /could not be read\. Try selecting it again\./);

    // An injected binary reader wins (fixtures, other callers).
    calls.length = 0;
    const injected = await readSourceFile(pickedBlob("page-1.png", "image/png", readSample("page-1.png")), {
      readAsArrayBuffer: async (file) => file.arrayBuffer(),
    });
    assert.equal(injected.ok, true);
    assert.deepEqual(calls, ["arrayBuffer"], "no FileReader when a reader is injected");

    // Office and text files never go through the data URL reader.
    calls.length = 0;
    const word = await readSourceFile(pickedBlob("program.docx", "", readSample("program.docx")));
    assert.equal(word.ok, true);
    const text = await readSourceFile(pickedBlob("program-sections.txt", "text/plain", readSample("program-sections.txt")));
    assert.equal(text.ok, true);
    assert.ok(!calls.includes("readAsDataURL"));
  } finally {
    if (savedFileReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = savedFileReader;
  }

  // Without FileReader (Node) the Blob's own bytes are used.
  assert.equal(typeof globalThis.FileReader, "undefined");
  const bytes = readSample("page-2.png");
  const source = await readSourceFile(new Blob([bytes], { type: "image/png" }) && Object.assign(new Blob([bytes], { type: "image/png" }), { name: "page-2.png" }));
  assert.equal(source.ok, true);
  assert.equal(source.files[0].dataBase64, Buffer.from(bytes).toString("base64"));
}

console.log("verify-source-h3-fix1: ok");
