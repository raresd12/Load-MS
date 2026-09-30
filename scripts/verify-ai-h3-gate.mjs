// H3 gate follow-ups (decision H3-27): the end-to-end cases the completeness
// gate found missing. Every case reads a picked file through readSourceFile and
// runs the result through extractProgramDraftWithAi with a mocked fetch that
// answers with a canned response from fixtures/import-samples/responses/.
//   1. one photo (source kind "image"), PNG / JPEG / WebP content
//   2. a .md file
//   3. the Word / Excel reader cannot be loaded: a stated failure, no request,
//      and the same file is read once the reader loads again
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

globalThis.window = { localStorage: new MemoryLocalStorage() };

// The reader chunk fails to load while this flag is on, like a lazy chunk that
// cannot be fetched. Registered before any module asks for officeText.js.
let officeReaderFails = true;
let officeReaderRequests = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/(^|\/)officeText\.js$/.test(specifier)) {
      officeReaderRequests += 1;

      if (officeReaderFails) {
        throw new Error("Failed to fetch dynamically imported module");
      }
    }

    return nextResolve(specifier, context);
  },
});

const { extractProgramDraftWithAi, setGeminiApiKey } = await import("../src/lib/aiProgram.js");
const { seedDefaultProgramIfNeeded, validateProgramShareStrict } = await import("../src/lib/programStorage.js");
const { draftFromShare, normalizeProgramDraft } = await import("../src/lib/programDraft.js");
const { createLocalBackup } = await import("../src/lib/storage.js");
const { DOCX_MIME_TYPE, OFFICE_READER_LOAD_ERROR, readSourceFile, XLSX_MIME_TYPE } = await import(
  "../src/lib/sourceFiles.js"
);

seedDefaultProgramIfNeeded();

const samplesDir = new URL("../fixtures/import-samples/", import.meta.url);
const readSample = (name) => readFileSync(new URL(name, samplesDir));
const readResponse = (name) => JSON.parse(readFileSync(new URL(`responses/${name}`, samplesDir), "utf8"));
const pickedFile = (bytes, name, type) => new File([bytes], name, { type });

const API_KEY = "h3-gate-key-7272";
assert.equal(setGeminiApiKey(API_KEY).ok, true);

const fetchCalls = [];
let responses = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
  const next = responses.shift();
  if (!next) throw new Error("unexpected fetch");
  return next;
};
const geminiOk = (document) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(document) }] } }] }),
});

async function extract(source, response) {
  const before = new Map(window.localStorage.store);
  fetchCalls.length = 0;
  responses = [geminiOk(response)];
  const result = await extractProgramDraftWithAi(source);
  const after = window.localStorage.store;
  assert.equal(after.size, before.size, "extraction adds or removes no storage key");

  for (const [key, value] of before) {
    assert.equal(after.get(key), value, `storage key ${key} unchanged by extraction`);
  }

  assert.equal(fetchCalls.length, 1, "one request per extraction");
  return { result, parts: fetchCalls[0].body.contents[0].parts, call: fetchCalls[0] };
}

function assertNoSource(result, payload, label) {
  assert.ok(payload.length >= 40, `${label}: the payload is long enough to be meaningful`);

  const drafted = draftFromShare(result.share, { origin: "ai-import" });
  const holders = {
    result: JSON.stringify(result),
    "stored draft": JSON.stringify(normalizeProgramDraft(drafted.draft)),
    backup: JSON.stringify(createLocalBackup()),
  };

  for (const [name, json] of Object.entries(holders)) {
    assert.ok(!json.includes(payload), `${label}: the ${name} does not carry the source`);
    assert.ok(!json.includes(API_KEY), `${label}: the ${name} does not carry the key`);
  }

  assert.ok(!holders.result.includes("dataBase64"), `${label}: no dataBase64 field in the result`);
}

// ---------------------------------------------------------------------------
// 1. One photo
// ---------------------------------------------------------------------------
{
  const canned = readResponse("image-bundle.json");
  // Signature bytes are enough for JPEG / WebP: the reader checks the content
  // signature, it does not decode the picture.
  const padding = Array.from({ length: 48 }, (_, index) => (index * 7 + 3) % 256);
  const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...padding]);
  const webpBytes = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x34, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, ...padding,
  ]);
  const photos = [
    { label: "PNG photo", file: pickedFile(readSample("page-1.png"), "page-1.png", "image/png"), mimeType: "image/png" },
    { label: "JPEG photo", file: pickedFile(jpegBytes, "IMG_0001.jpg", "image/jpeg"), mimeType: "image/jpeg" },
    { label: "WebP photo", file: pickedFile(webpBytes, "scan.webp", "image/webp"), mimeType: "image/webp" },
    // The label of the file says PNG, the content is JPEG: the content wins.
    { label: "mislabelled photo", file: pickedFile(jpegBytes, "photo.png", "image/png"), mimeType: "image/jpeg" },
  ];

  for (const { label, file, mimeType } of photos) {
    const source = await readSourceFile(file);
    assert.equal(source.ok, true, `${label}: ${source.error}`);
    assert.equal(source.kind, "image", `${label}: one photo is a source of kind image`);
    assert.equal(source.files.length, 1);
    assert.equal(source.files[0].mimeType, mimeType, `${label}: MIME type from the content`);
    assert.equal(source.meta.pages, 1);

    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    assert.equal(source.files[0].dataBase64, base64, `${label}: the bytes are read unchanged`);

    const { result, parts, call } = await extract(source, canned.response);
    assert.equal(parts.length, 2, `${label}: rules and one picture`);
    assert.equal(typeof parts[0].text, "string");
    assert.deepEqual(parts[1], { inline_data: { mime_type: mimeType, data: base64 } }, `${label}: the picture as sent`);
    assert.ok(!parts.some((part) => /^Page \d+ of \d+$/.test(part.text ?? "")), `${label}: no page label for one photo`);
    assert.equal(call.init.headers["x-goog-api-key"], API_KEY);
    assert.ok(!String(call.init.body).includes(API_KEY), `${label}: the key is not in the request body`);
    assert.ok(!String(call.init.body).includes(file.name), `${label}: the file name is not sent`);

    assert.equal(result.valid, true, `${label}: ${result.error}`);
    assert.equal(validateProgramShareStrict(result.share).valid, true);
    assert.equal(result.share.days.length, 4);
    assert.ok(
      result.share.programExercises.every((exercise) => exercise.targetWeight === null),
      `${label}: a source load is never a target`,
    );
    assert.ok(result.share.draftMeta.uncertainty.length > 0, `${label}: what could not be read is listed`);
    assertNoSource(result, base64, label);
  }

  // A picture that is not one of the three formats is refused before any request.
  fetchCalls.length = 0;
  const gif = await readSourceFile(
    pickedFile(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...padding]), "photo.png", "image/png"),
  );
  assert.equal(gif.ok, false, "a GIF named .png is refused");
  assert.match(gif.error, /not a valid JPG, PNG or WebP image/);
  const refused = await extractProgramDraftWithAi(gif);
  assert.equal(refused.valid, false, "a failed read cannot be extracted");
  assert.equal(fetchCalls.length, 0, "and no request is made");
}

// ---------------------------------------------------------------------------
// 2. A .md file
// ---------------------------------------------------------------------------
{
  const canned = readResponse("program-sections.txt.json");
  const bytes = readSample("program-sections.txt");
  const text = bytes.toString("utf8").replace(/\r\n?/g, "\n");

  // Browsers often give .md files an empty type: the extension decides.
  for (const type of ["text/markdown", ""]) {
    const label = `program.md (type "${type}")`;
    const source = await readSourceFile(pickedFile(bytes, "program.md", type));
    assert.equal(source.ok, true, `${label}: ${source.error}`);
    assert.equal(source.kind, "text");
    assert.equal(source.meta.origin, "file");
    assert.equal(source.text.trim(), text.trim(), `${label}: the text is read unchanged`);
    assert.deepEqual(source.meta.warnings, [], `${label}: UTF-8 needs no warning`);

    const { result, parts, call } = await extract(source, canned.response);
    assert.equal(parts.length, 2, `${label}: rules and source are separate parts`);
    assert.ok(parts[1].text.startsWith("SOURCE TEXT START\n") && parts[1].text.endsWith("\nSOURCE TEXT END"));
    assert.ok(parts[1].text.includes(text.trim()), `${label}: the whole source is sent`);
    assert.ok(!parts.some((part) => part.inline_data), `${label}: a text file is sent as text`);
    assert.ok(!String(call.init.body).includes("program.md"), `${label}: the file name is not sent`);

    const injection = /^.*ignore previous instructions.*$/im.exec(text);
    assert.ok(injection, "the sample holds an injection line");
    assert.ok(parts[1].text.includes(injection[0]), `${label}: the injection line travels as source data`);
    assert.ok(!parts[0].text.includes(injection[0]), `${label}: and is not in the rules text`);

    assert.equal(result.valid, true, `${label}: ${result.error}`);
    assert.equal(validateProgramShareStrict(result.share).valid, true);
    assert.equal(result.share.days.length, 4);
    assert.ok(
      result.share.programExercises.every((exercise) => exercise.targetWeight === null),
      `${label}: a source load is never a target`,
    );
    assertNoSource(result, text.trim(), label);
  }
}

// ---------------------------------------------------------------------------
// 3. The Word / Excel reader cannot be loaded
// ---------------------------------------------------------------------------
{
  const office = [
    { name: "program.docx", type: DOCX_MIME_TYPE },
    { name: "program.xlsx", type: XLSX_MIME_TYPE },
  ];

  assert.equal(officeReaderRequests, 0, "the reader is not loaded before a Word / Excel file is picked");
  fetchCalls.length = 0;

  for (const { name, type } of office) {
    const requestsBefore = officeReaderRequests;
    const failed = await readSourceFile(pickedFile(readSample(name), name, type));
    assert.equal(officeReaderRequests, requestsBefore + 1, `${name}: the reader was asked for`);
    assert.equal(failed.ok, false, `${name}: a reader that cannot be loaded is a failure, not a throw`);
    assert.equal(failed.error, OFFICE_READER_LOAD_ERROR);
    assert.equal(failed.kind, null);
    assert.deepEqual(failed.files, [], `${name}: no part of the file is kept`);
    assert.ok(!JSON.stringify(failed).includes("dataBase64"));

    const refused = await extractProgramDraftWithAi(failed);
    assert.equal(refused.valid, false, `${name}: nothing to extract`);
  }

  assert.equal(fetchCalls.length, 0, "no request is made for a file that was not read");

  // Text, photo and PDF sources do not need the reader.
  const requestsBefore = officeReaderRequests;
  assert.equal((await readSourceFile(pickedFile(readSample("program-table.csv"), "program-table.csv", "text/csv"))).ok, true);
  assert.equal((await readSourceFile(pickedFile(readSample("page-2.png"), "page-2.png", "image/png"))).ok, true);
  assert.equal((await readSourceFile(pickedFile(readSample("minimal.pdf"), "minimal.pdf", "application/pdf"))).ok, true);
  assert.equal(officeReaderRequests, requestsBefore, "other formats never ask for the Word / Excel reader");

  // "Try again" works: the failure is not remembered.
  officeReaderFails = false;

  for (const { name, type } of office) {
    const expected = JSON.parse(readFileSync(new URL(`expected/${name}.json`, samplesDir), "utf8"));
    const source = await readSourceFile(pickedFile(readSample(name), name, type));
    assert.equal(source.ok, true, `${name} after the reader loads: ${source.error}`);
    assert.equal(source.kind, "text");
    assert.equal(source.meta.origin, "office");
    assert.equal(source.text, expected.text, `${name}: the same text as the pinned sample`);
  }
}

console.log("verify-ai-h3-gate: ok");
