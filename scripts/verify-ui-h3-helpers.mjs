// Phase H3 / UI track (decisions H3-5, H3-6): behaviour of the pure helpers
// behind the Import Assistant UI (src/lib/importAssistant.js) and the gates
// the UI relies on, run end to end against the real modules with a mocked
// fetch and an in-memory storage:
// - photo ordering, totals and pick rules; file pick rules; Extract blocker
// - extraction errors are told apart (key, quota, network, blocked,
//   unsupported, "no program") from the REAL messages of aiProgram.js
// - program file import stays JSON-only
// - technique drafts: batches of 5, approval per exercise into the draft's
//   own NEW entry only, refused drafts cannot be accepted, the notes reach the
//   Library only with the saved program and are tagged, existing Library
//   entries never change
// - source privacy: neither the stored review draft, a backup nor the saved
//   program carries the source text or file bytes
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
console.warn = () => {};

const { extractProgramDraftWithAi, mapGeminiError, setGeminiApiKey, clearGeminiApiKey } = await import(
  "../src/lib/aiProgram.js"
);
const { draftTechniqueNotesWithAi, TECHNIQUE_DRAFT_TAG, AI_GENERATED_TAG, MAX_TECHNIQUE_EXERCISES } = await import(
  "../src/lib/aiTechnique.js"
);
const {
  buildImageBundle,
  buildTextSource,
  classifySourceFile,
  LEGACY_OFFICE_GUIDANCE,
  readSourceFile,
  SOURCE_LIMITS,
} = await import("../src/lib/sourceFiles.js");
const { draftFromShare, validateProgramDraft } = await import("../src/lib/programDraft.js");
const { getExerciseLibrary, saveDraftToStorage, saveProgramDraft, seedDefaultProgramIfNeeded, exportProgramShare } =
  await import("../src/lib/programStorage.js");
const { createLocalBackup, STORAGE_KEYS } = await import("../src/lib/storage.js");
const helpers = await import("../src/lib/importAssistant.js");
const {
  acceptTechniqueDraftIntoDraft,
  acceptTechniqueDraftIntoShare,
  applyTechniqueForm,
  createExtractionTracker,
  describeNewExercises,
  classifyExtractionError,
  createTechniqueForm,
  describeSourceMeta,
  detectLibraryLanguage,
  findTextMatches,
  formatFileSize,
  getExtractBlocker,
  getProgramFileRejection,
  getTechniqueRows,
  hasTechniqueNotes,
  isAiTechniqueEntry,
  listNewExercisesOfDraft,
  listNewExercisesOfShare,
  moveListItem,
  planFilePick,
  planPhotoPick,
  PROGRAM_FILE_DOCUMENT_HINT,
  removeListItem,
  runTechniqueBatches,
  setNewLibraryEntryInDraft,
  SOURCE_PRIVACY_NOTE,
  splitIntoBatches,
  summarizePhotos,
  TECHNIQUE_DRAFT_BADGE,
} = helpers;

seedDefaultProgramIfNeeded();

const MIB = 1024 * 1024;
const sample = (name) => new URL(`../fixtures/import-samples/${name}`, import.meta.url);
const readText = (name) => readFileSync(sample(name), "utf8").replace(/\r\n?/g, "\n");
const readBytes = (name) => new Uint8Array(readFileSync(sample(name)));
const canned = (name) => JSON.parse(readText(`responses/${name}`)).response;
const fileLike = (name, type, bytes) => ({
  name,
  type,
  size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  text: async () => new TextDecoder().decode(bytes),
});
const image = (name, size) => ({ name, type: "image/png", size });

// ------------------------------------------------------------------
// Copy the UI shows
// ------------------------------------------------------------------
assert.equal(
  SOURCE_PRIVACY_NOTE,
  "Files stay in this browser tab and are sent to Google only when you press Extract. They are never saved to the app or its backups.",
);
assert.ok(/sent to Google/.test(SOURCE_PRIVACY_NOTE), '"not saved" is never told as "never sent" (13.4)');
assert.equal(TECHNIQUE_DRAFT_BADGE, "AI draft, review before relying on it");
assert.equal(formatFileSize(0), "0 B");
assert.equal(formatFileSize(1536), "2 KB");
assert.equal(formatFileSize(5 * MIB), "5.0 MB");

// ------------------------------------------------------------------
// Photo order and totals
// ------------------------------------------------------------------
{
  const pages = ["a", "b", "c"];
  assert.deepEqual(moveListItem(pages, 2, -1), ["a", "c", "b"], "Move up");
  assert.deepEqual(moveListItem(pages, 0, 1), ["b", "a", "c"], "Move down");
  assert.equal(moveListItem(pages, 0, -1), pages, "the first page cannot move up");
  assert.equal(moveListItem(pages, 2, 1), pages, "the last page cannot move down");
  assert.equal(moveListItem(pages, 5, -1), pages);
  assert.deepEqual(pages, ["a", "b", "c"], "the input list is not mutated");
  assert.deepEqual(removeListItem(pages, 1), ["a", "c"]);
  assert.equal(removeListItem(pages, 3), pages);

  const summary = summarizePhotos([image("1.png", 3 * MIB), { name: "2.png", sizeBytes: 3 * MIB }]);
  assert.equal(summary.count, 2);
  assert.equal(summary.totalBytes, 6 * MIB);
  assert.equal(summary.inlineBytes, 8 * MIB, "the request size is the base64 size");
  assert.equal(summary.remaining, SOURCE_LIMITS.MAX_IMAGES_PER_SOURCE - 2);
  assert.equal(summary.label, "2 of 6 photos, 6.0 MB (8.0 MB of 18.0 MB once encoded for the request)");
  assert.equal(summarizePhotos([]).label, "0 of 6 photos, 0 B (0 B of 18.0 MB once encoded for the request)");
}

// ------------------------------------------------------------------
// Picks: every refusal names its limit
// ------------------------------------------------------------------
{
  const first = planPhotoPick([], [image("p1.png", 100), image("p2.png", 100)]);
  assert.equal(first.ok, true);
  assert.deepEqual(first.files.map((file) => file.name), ["p1.png", "p2.png"], "picked order is page order");

  const added = planPhotoPick(first.files, [image("p3.png", 100)]);
  assert.deepEqual(added.files.map((file) => file.name), ["p1.png", "p2.png", "p3.png"], "a later pick is appended");
  assert.equal(planPhotoPick(first.files, []).ok, true);

  const tooMany = planPhotoPick(first.files, Array.from({ length: 5 }, (_, index) => image(`x${index}.png`, 10)));
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.error.includes("at most 6 images"), tooMany.error);
  assert.equal(tooMany.files.length, 2, "a refused pick adds nothing");

  const tooLarge = planPhotoPick([], [image("big.png", 9 * MIB)]);
  assert.equal(tooLarge.ok, false);
  assert.ok(/8 MB/.test(tooLarge.error), `the per-image limit is shown: ${tooLarge.error}`);

  const tooLargeTogether = planPhotoPick([image("a.png", 7 * MIB)], [image("b.png", 7 * MIB)]);
  assert.equal(tooLargeTogether.ok, false);
  assert.ok(/18 MB/.test(tooLargeTogether.error), `the total limit is shown: ${tooLargeTogether.error}`);

  const pdfInPhotos = planPhotoPick([], [{ name: "plan.pdf", type: "application/pdf", size: 100 }]);
  assert.equal(pdfInPhotos.ok, false);
  assert.ok(pdfInPhotos.error.includes("File tab"), pdfInPhotos.error);

  const gif = planPhotoPick([image("a.png", 10)], [{ name: "anim.gif", type: "image/gif", size: 100 }]);
  assert.equal(gif.ok, false);
  assert.ok(gif.error.startsWith("anim.gif: "), "the refused file is named");

  assert.deepEqual(planFilePick({ name: "plan.pdf", type: "application/pdf", size: 500 }), {
    ok: true,
    kind: "pdf",
    readOnPick: false,
  });
  for (const [name, kind] of [
    ["plan.docx", "docx"],
    ["plan.xlsx", "xlsx"],
    ["plan.txt", "text"],
    ["plan.md", "text"],
    ["plan.csv", "text"],
  ]) {
    assert.deepEqual(planFilePick({ name, type: "", size: 500 }), { ok: true, kind, readOnPick: true }, name);
  }

  for (const name of ["old.doc", "old.xls", "old.rtf", "old.odt", "old.ods", "old.pages", "old.numbers"]) {
    const plan = planFilePick({ name, type: "", size: 500 });
    assert.equal(plan.ok, false, name);
    assert.ok(plan.error.includes(LEGACY_OFFICE_GUIDANCE), `${name}: Track A's guidance is shown (${plan.error})`);
    assert.notEqual(
      getExtractBlocker({ mode: "file", file: { status: "error", error: plan.error } }),
      "",
      `${name}: Extract stays disabled`,
    );
  }

  const imageInFile = planFilePick(image("page.png", 100));
  assert.equal(imageInFile.ok, false);
  assert.ok(imageInFile.error.includes("Photos tab"));

  assert.ok(/5 MB/.test(planFilePick({ name: "big.docx", type: "", size: 6 * MIB }).error), "office limit shown");
  assert.ok(/10 MB/.test(planFilePick({ name: "big.pdf", type: "", size: 11 * MIB }).error), "PDF limit shown");
  assert.ok(/1 MB/.test(planFilePick({ name: "big.txt", type: "", size: 2 * MIB }).error), "text limit shown");
}

// ------------------------------------------------------------------
// When Extract is available
// ------------------------------------------------------------------
{
  assert.equal(getExtractBlocker({ mode: "text", text: "  " }), "Paste the program text first.");
  assert.equal(getExtractBlocker({ mode: "text", text: "Day 1" }), "");
  assert.ok(getExtractBlocker({ mode: "text", text: "x".repeat(80001) }).includes("80,000"));
  assert.notEqual(getExtractBlocker({ mode: "photos", photos: [] }), "");
  assert.equal(getExtractBlocker({ mode: "photos", photos: [image("a.png", 1)] }), "");
  assert.notEqual(getExtractBlocker({ mode: "file", file: null }), "");
  assert.notEqual(getExtractBlocker({ mode: "file", file: { status: "reading" } }), "");
  assert.equal(getExtractBlocker({ mode: "file", file: { status: "ready" } }), "");
  assert.notEqual(getExtractBlocker({ mode: "text", text: "Day 1", isExtracting: true }), "");
  assert.notEqual(getExtractBlocker({ mode: "other" }), "");
  // Switching mode never makes another mode's selection the source.
  assert.notEqual(getExtractBlocker({ mode: "photos", text: "Day 1", photos: [], file: { status: "ready" } }), "");
}

// ------------------------------------------------------------------
// Office files: the text that will be sent, and what was left out
// ------------------------------------------------------------------
const docxBytes = readBytes("program.docx");
const xlsxBytes = readBytes("program.xlsx");
const docxSource = await readSourceFile(fileLike("program.docx", "", docxBytes));
const xlsxSource = await readSourceFile(fileLike("program.xlsx", "", xlsxBytes));
{
  assert.equal(docxSource.ok, true);
  assert.equal(docxSource.kind, "text");
  assert.equal(docxSource.files[0].dataBase64, undefined, "the document itself is not part of the source");
  const docxMeta = describeSourceMeta(docxSource);
  assert.ok(/paragraphs? and \d+ table rows? read on this device\./.test(docxMeta.lines[0]), docxMeta.lines[0]);
  assert.ok(docxMeta.warnings.length >= 1, "ignored images / drawings are told");
  assert.ok(docxMeta.warnings.some((line) => /image|drawing/i.test(line)), docxMeta.warnings.join(" | "));

  assert.equal(xlsxSource.ok, true);
  const xlsxMeta = describeSourceMeta(xlsxSource);
  assert.ok(new RegExp(`^${xlsxSource.meta.sheets} sheets, `).test(xlsxMeta.lines[0]), xlsxMeta.lines[0]);
  assert.ok(xlsxMeta.warnings.some((line) => /hidden/i.test(line)), "the skipped hidden sheet is told");

  const truncated = describeSourceMeta({ text: "abc", meta: { origin: "office", format: "docx", truncated: true, warnings: [] } });
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.lines.some((line) => line.startsWith("Truncated: only the first 80,000 characters")));

  const legacy = await readSourceFile(fileLike("program-legacy.doc", "application/msword", readBytes("program-legacy.doc")));
  assert.equal(legacy.ok, false);
  assert.ok(legacy.error.includes(LEGACY_OFFICE_GUIDANCE));
}

// ------------------------------------------------------------------
// Source review: text search
// ------------------------------------------------------------------
{
  const found = findTextMatches("Bench Press 5x5\nbench row\nSquat", "bench");
  assert.equal(found.count, 2);
  assert.deepEqual(found.segments, [
    { text: "Bench", match: true },
    { text: " Press 5x5\n", match: false },
    { text: "bench", match: true },
    { text: " row\nSquat", match: false },
  ]);
  assert.equal(found.segments.map((segment) => segment.text).join(""), "Bench Press 5x5\nbench row\nSquat");
  assert.deepEqual(findTextMatches("abc", ""), { count: 0, segments: [{ text: "abc", match: false }] });
  assert.deepEqual(findTextMatches("", "a"), { count: 0, segments: [] });
  assert.equal(findTextMatches("a.c abc", ".").count, 1, "the query is literal, not a pattern");
  assert.equal(findTextMatches("5x5 (75%)", "(75%)").count, 1);
}

// ------------------------------------------------------------------
// Program file import stays JSON-only
// ------------------------------------------------------------------
{
  assert.equal(PROGRAM_FILE_DOCUMENT_HINT, "Use the AI Import Assistant for documents");
  assert.equal(getProgramFileRejection("program.json", "application/json"), "");
  assert.equal(getProgramFileRejection("My Program.JSON", ""), "");
  assert.equal(getProgramFileRejection("share.txt", "text/plain"), "", "a share saved as .txt is still parsed");
  assert.equal(getProgramFileRejection("share", ""), "");

  for (const name of ["plan.docx", "plan.xlsx", "plan.pdf", "plan.doc", "plan.xls", "plan.odt", "photo.png", "photo.jpg"]) {
    const message = getProgramFileRejection(name, "");
    assert.ok(message.includes(PROGRAM_FILE_DOCUMENT_HINT), `${name}: ${message}`);
    assert.ok(message.includes(name));
  }
}

// ------------------------------------------------------------------
// Extraction: mocked Gemini
// ------------------------------------------------------------------
const API_KEY = "ui-h3-key-4242-secret";
const fetchCalls = [];
let responses = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
  const next = responses.shift();
  if (!next) throw new Error("unexpected fetch");
  if (next instanceof Error) throw next;
  return next;
};
const geminiOk = (document, finishReason = "STOP") => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(document) }] } }] }),
});
const geminiFail = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });

const sourceText = readText("program-sections.txt");
const textSource = buildTextSource(sourceText);
assert.equal(textSource.ok, true);

// No key: nothing is sent.
{
  clearGeminiApiKey();
  const result = await extractProgramDraftWithAi(textSource);
  assert.equal(result.valid, false);
  const missing = classifyExtractionError(result.error);
  assert.equal(missing.kind, "key");
  assert.equal(missing.title, "API key needed");
  assert.ok(!missing.guidance.includes("remove the saved key"), "a missing key is not told as a rejected key");
  assert.equal(fetchCalls.length, 0);
  assert.equal(setGeminiApiKey(API_KEY).ok, true);
}

// The error box tells the failures apart, from the real messages.
{
  const kinds = [];
  const run = async (queue) => {
    responses = queue;
    const result = await extractProgramDraftWithAi(textSource);
    assert.equal(result.valid, false);
    const info = classifyExtractionError(result.error);
    assert.equal(info.message, result.error, "the original message is kept");
    kinds.push(info.kind);
    return info;
  };

  const key = await run([geminiFail(400, "API key not valid. Please pass a valid API key.")]);
  assert.equal(key.kind, "key");
  assert.ok(key.guidance.includes("paste a new one"));
  assert.equal((await run([geminiFail(403, "forbidden")])).kind, "key");

  const quota = await run([geminiFail(429, "quota"), geminiFail(429, "quota")]);
  assert.equal(quota.kind, "quota");
  assert.ok(quota.guidance.includes("press Extract again"));

  assert.equal((await run([geminiFail(503, "overloaded"), geminiFail(503, "overloaded")])).kind, "network");
  assert.equal((await run([geminiFail(404, "model"), geminiFail(404, "model")])).kind, "network");
  const network = await run([new TypeError("Failed to fetch")]);
  assert.equal(network.kind, "network");
  assert.ok(network.guidance.includes("nothing was saved"));

  const blocked = await run([{ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: "SAFETY" } }) }]);
  assert.equal(blocked.kind, "blocked");
  assert.equal((await run([geminiOk({}, "PROHIBITED_CONTENT")])).kind, "blocked");

  const empty = await run([geminiOk({ name: "Not a program", days: [] })]);
  assert.equal(empty.kind, "empty");
  assert.equal(empty.title, "The model returned no program");
  assert.ok(empty.guidance.includes("paste the text"));

  assert.equal((await run([geminiOk({ name: "x", days: [] }, "MAX_TOKENS")])).kind, "response");
  assert.equal(
    (await run([{ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] }) }])).kind,
    "response",
  );
  assert.equal(new Set(kinds).size, 6, `six kinds are told apart: ${[...new Set(kinds)].join(", ")}`);

  // Source problems (nothing is sent).
  for (const message of [
    classifySourceFile("plan.doc", "", 100).error,
    classifySourceFile("plan.zip", "", 100).error,
    classifySourceFile("big.pdf", "", 11 * MIB).error,
    planPhotoPick([], Array.from({ length: 7 }, (_, index) => image(`${index}.png`, 1))).error,
    buildImageBundle([]).error,
    buildTextSource("").error,
  ]) {
    assert.equal(classifyExtractionError(message).kind, "unsupported", message);
  }

  for (const status of [400, 401, 403, 404, 429, 500]) {
    assert.notEqual(classifyExtractionError(mapGeminiError(status, "")).kind, "other", `HTTP ${status} has guidance`);
  }

  assert.deepEqual(classifyExtractionError(""), { kind: "none", title: "", guidance: "", message: "" });
  assert.equal(classifyExtractionError("The draft needs a review before it can be saved: Day 1 has no name.").kind, "other");
}

// A real end-to-end extraction of the text sample.
responses = [geminiOk(canned("program-sections.txt.json"))];
fetchCalls.length = 0;
const extraction = await extractProgramDraftWithAi(textSource);
assert.equal(extraction.valid, true, extraction.error);
assert.equal(fetchCalls.length, 1);
assert.ok(extraction.preview.uncertainty.length > 0, "the sample has disclosures, so the top block shows");

// ------------------------------------------------------------------
// Technique drafts: who can get one
// ------------------------------------------------------------------
const newExercises = listNewExercisesOfShare(extraction.share, extraction.preview);
{
  assert.equal(newExercises.length, extraction.summary.newExerciseCount, "every new entry is listed once");
  assert.ok(newExercises.length >= 2, `the sample proposes new exercises (${newExercises.length})`);
  const libraryIds = new Set(getExerciseLibrary().map((entry) => String(entry.id)));
  newExercises.forEach((exercise) => {
    assert.ok(!libraryIds.has(exercise.id), `${exercise.name} is not a Library exercise`);
    assert.equal(exercise.hasNotes, false, "an extracted new entry has no technique content (13.7)");
  });
  const matchedIds = extraction.preview.days
    .flatMap((day) => day.exercises)
    .filter((exercise) => exercise.matchedLibrary)
    .map((exercise) => String(exercise.exerciseId));
  assert.ok(matchedIds.length > 0, "the sample also has Library matches");
  matchedIds.forEach((id) => assert.ok(!newExercises.some((exercise) => exercise.id === id), "matched exercises get no technique action"));
  assert.deepEqual(listNewExercisesOfShare(null, null), []);
}

// Batches of 5, one request each, in order; a failed batch stops the run.
{
  assert.equal(MAX_TECHNIQUE_EXERCISES, 5);
  assert.deepEqual(splitIntoBatches([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map((batch) => batch.length), [5, 5, 2]);
  assert.deepEqual(splitIntoBatches([1, 2, 3, 4, 5]).map((batch) => batch.length), [5]);
  assert.deepEqual(splitIntoBatches([]), []);
  assert.deepEqual(splitIntoBatches([1, 2, 3], 2), [[1, 2], [3]]);

  const twelve = Array.from({ length: 12 }, (_, index) => ({ id: `n${index + 1}`, name: `Exercise ${index + 1}`, hasNotes: false }));
  const seen = [];
  const progress = [];
  const all = await runTechniqueBatches({
    exercises: twelve,
    language: "ro",
    request: async ({ exercises, language }) => {
      seen.push({ ids: exercises.map((exercise) => exercise.id), language, keys: Object.keys(exercises[0]).sort() });
      return {
        ok: true,
        drafts: exercises.slice(1).map((exercise) => ({ id: exercise.id, name: exercise.name })),
        rejected: [{ id: exercises[0].id, name: exercises[0].name, errors: ["Setup is empty."] }],
        uncertainty: ["shared line"],
        model: "gemini-test",
      };
    },
    onProgress: (step) => progress.push(step),
  });
  assert.deepEqual(seen.map((call) => call.ids.length), [5, 5, 2]);
  assert.deepEqual(seen[0].ids, ["n1", "n2", "n3", "n4", "n5"]);
  assert.deepEqual(seen[0].keys, ["category", "equipment", "id", "mainMuscles", "name"], "only the request fields are sent");
  assert.ok(seen.every((call) => call.language === "ro"));
  assert.equal(all.drafts.length, 9);
  assert.equal(all.rejected.length, 3);
  assert.deepEqual(all.uncertainty, ["shared line"]);
  assert.equal(all.error, "");
  assert.deepEqual(progress.at(-1), { completedBatches: 3, totalBatches: 3 });

  let calls = 0;
  const partial = await runTechniqueBatches({
    exercises: twelve,
    request: async ({ exercises }) => {
      calls += 1;
      return calls === 2
        ? { ok: false, error: "The free Gemini quota is used up for now." }
        : { ok: true, drafts: exercises.map((exercise) => ({ id: exercise.id, name: exercise.name })), rejected: [], uncertainty: [] };
    },
  });
  assert.equal(calls, 2, "no request after a failed batch");
  assert.equal(partial.drafts.length, 5, "what came back before the failure is kept");
  assert.ok(partial.error.startsWith("The free Gemini quota is used up for now."));
  assert.ok(partial.error.includes('"Exercise 6"') && partial.error.includes("the exercises after them"));

  const thrown = await runTechniqueBatches({ exercises: twelve.slice(0, 1), request: async () => { throw new Error("boom"); } });
  assert.ok(thrown.error.startsWith("The technique request failed."), "never throws");
  assert.equal((await runTechniqueBatches({ exercises: [], request: async () => ({ ok: true }) })).error, "There is no new exercise to describe.");
}

// ------------------------------------------------------------------
// Technique drafts: request, approval per exercise, save
// ------------------------------------------------------------------
const libraryBefore = JSON.stringify(getExerciseLibrary());
assert.equal(detectLibraryLanguage(getExerciseLibrary()), "ro", "the seeded Library is Romanian");
assert.equal(detectLibraryLanguage([]), "ro");
assert.equal(
  detectLibraryLanguage([{ setup: "- keep the bar over your feet\n- brace with your core", howToDoIt: "- pull the bar from the floor" }]),
  "en",
);

responses = [geminiOk(canned("technique-drafts.json"))];
fetchCalls.length = 0;
const drafted = await runTechniqueBatches({
  exercises: newExercises.slice(0, 2),
  language: detectLibraryLanguage(getExerciseLibrary()),
  request: draftTechniqueNotesWithAi,
});
assert.equal(drafted.error, "");
assert.equal(drafted.drafts.length, 2);
assert.equal(fetchCalls.length, 1, "two exercises are one request");
{
  const sent = JSON.stringify(fetchCalls[0].body);
  assert.ok(!sent.includes(sourceText.slice(0, 200)), "a technique request never carries the program source");
  assert.ok(!sent.includes(API_KEY), "the key travels as a header only");
  assert.ok(sent.includes(newExercises[0].name));
}

const [firstDraft, secondDraft] = drafted.drafts;
{
  const rows = getTechniqueRows(firstDraft);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Main Cue", "Setup", "How To Do It", "What You Should Feel", "Execution Tips", "Common Mistakes", "Why It's There", "Progression / Regression", "Safety Notes"],
    "every field is shown, in the Library display order",
  );
  rows.forEach((row) => row.bullets.forEach((bullet) => assert.ok(!/^[-•]/.test(bullet), "bullets are shown without the hyphen")));
}

// Accept applies to that exercise's own new entry and to nothing else.
const accepted = acceptTechniqueDraftIntoShare(extraction.share, firstDraft);
assert.equal(accepted.ok, true, accepted.error);
{
  assert.notEqual(accepted.share, extraction.share);
  assert.equal(
    hasTechniqueNotes(extraction.share.libraryExercises.find((entry) => entry.id === firstDraft.id)),
    false,
    "the input share is not mutated",
  );
  accepted.share.libraryExercises.forEach((entry) => {
    const original = extraction.share.libraryExercises.find((item) => item.id === entry.id);
    if (entry.id === firstDraft.id) {
      assert.equal(hasTechniqueNotes(entry), true);
      assert.ok(entry.goalTags.includes(AI_GENERATED_TAG) && entry.goalTags.includes(TECHNIQUE_DRAFT_TAG));
      assert.equal(isAiTechniqueEntry(entry), true);
      assert.equal(entry.name, original.name);
    } else {
      assert.deepEqual(entry, original, "the other entries are untouched");
    }
  });
  assert.deepEqual(accepted.share.programExercises, extraction.share.programExercises, "no prescription changes");
  assert.deepEqual(accepted.share.days, extraction.share.days);
  assert.equal(listNewExercisesOfShare(accepted.share, extraction.preview).find((item) => item.id === firstDraft.id).hasNotes, true);
  assert.equal(JSON.stringify(getExerciseLibrary()), libraryBefore, "accepting writes nothing to the Library");
}

// A draft with kg / sets text cannot be accepted.
{
  const withLoad = { ...secondDraft, setup: `${secondDraft.setup}\n- start with 20 kg on the bar` };
  const refusedLoad = acceptTechniqueDraftIntoShare(accepted.share, withLoad);
  assert.equal(refusedLoad.ok, false);
  assert.equal(refusedLoad.code, "invalid");
  assert.ok(/contains a load/.test(refusedLoad.error), refusedLoad.error);
  assert.equal(refusedLoad.share, accepted.share, "nothing is applied");

  const withSets = { ...secondDraft, howToDoIt: [...secondDraft.howToDoIt, "do 3 sets of 10"] };
  const refusedSets = acceptTechniqueDraftIntoShare(accepted.share, withSets);
  assert.equal(refusedSets.ok, false);
  assert.ok(/set or rep count/.test(refusedSets.error), refusedSets.error);

  // A draft written for a Library exercise, or for an exercise of another draft.
  const libraryEntry = getExerciseLibrary()[0];
  const forLibrary = acceptTechniqueDraftIntoShare(
    { ...accepted.share, libraryExercises: [...accepted.share.libraryExercises, libraryEntry], programExercises: [...accepted.share.programExercises, { exerciseId: libraryEntry.id }] },
    { ...firstDraft, id: libraryEntry.id, name: libraryEntry.name },
  );
  assert.equal(forLibrary.ok, false);
  assert.equal(forLibrary.code, "not-new", "an existing Library entry is never filled by AI");
  assert.equal(acceptTechniqueDraftIntoShare(accepted.share, { ...firstDraft, id: "unknown-id" }).code, "mismatch");
  assert.equal(JSON.stringify(getExerciseLibrary()), libraryBefore);
}

// Second approval is independent of the first; an accepted entry is only
// replaced when asked.
const acceptedBoth = acceptTechniqueDraftIntoShare(accepted.share, secondDraft);
assert.equal(acceptedBoth.ok, true, acceptedBoth.error);
{
  const changedCue = { ...firstDraft, mainCue: "Push the hips back first." };
  const kept = acceptTechniqueDraftIntoShare(acceptedBoth.share, changedCue);
  assert.equal(kept.ok, true);
  assert.equal(kept.entry.mainCue, firstDraft.mainCue, "without replace, filled fields are kept");
  const replaced = acceptTechniqueDraftIntoShare(acceptedBoth.share, changedCue, { replace: true });
  assert.equal(replaced.entry.mainCue, "Push the hips back first.");
  assert.equal(replaced.entry.goalTags.filter((tag) => tag === TECHNIQUE_DRAFT_TAG).length, 1);
}

// The Studio path: the same approval on a program draft.
const converted = draftFromShare(extraction.share, { origin: "ai-import" });
assert.equal(converted.ok, true, converted.error);
{
  const programDraft = converted.draft;
  const listed = listNewExercisesOfDraft(programDraft);
  assert.deepEqual(listed.map((item) => item.id).sort(), newExercises.map((item) => item.id).sort());

  const allExercises = programDraft.days.flatMap((day) => day.sections.flatMap((section) => section.exercises));
  const newExercise = allExercises.find((exercise) => exercise.libraryStatus === "new" && exercise.exerciseId === firstDraft.id);
  const libraryExercise = allExercises.find((exercise) => exercise.libraryStatus === "library");
  assert.ok(newExercise && libraryExercise);

  const onLibrary = acceptTechniqueDraftIntoDraft(programDraft, libraryExercise.id, { ...firstDraft, id: libraryExercise.exerciseId });
  assert.equal(onLibrary.ok, false);
  assert.equal(onLibrary.code, "not-new");
  assert.equal(onLibrary.draft, programDraft);
  assert.equal(acceptTechniqueDraftIntoDraft(programDraft, newExercise.id, secondDraft).code, "mismatch");
  assert.equal(acceptTechniqueDraftIntoDraft(programDraft, "missing", firstDraft).ok, false);

  const inStudio = acceptTechniqueDraftIntoDraft(programDraft, newExercise.id, firstDraft);
  assert.equal(inStudio.ok, true, inStudio.error);
  const after = inStudio.draft.days.flatMap((day) => day.sections.flatMap((section) => section.exercises));
  after.forEach((exercise, index) => {
    if (exercise.libraryStatus === "new" && exercise.exerciseId === firstDraft.id) {
      assert.equal(hasTechniqueNotes(exercise.newLibraryExercise), true);
      const { newLibraryExercise: _entry, ...rest } = exercise;
      const { newLibraryExercise: _before, ...restBefore } = allExercises[index];
      assert.deepEqual(rest, restBefore, "the prescription of the exercise is untouched");
    } else {
      assert.equal(exercise, allExercises[index], "other exercises keep their object");
    }
  });
  assert.equal(hasTechniqueNotes(inStudio.draft.libraryExercises.find((entry) => entry.id === firstDraft.id)), true);
  assert.equal(hasTechniqueNotes(programDraft.libraryExercises.find((entry) => entry.id === firstDraft.id)), false, "input draft not mutated");
  assert.equal(validateProgramDraft(inStudio.draft).valid, true);

  // "Edit notes": manual correction keeps the entry's shape and its tags.
  const entry = after.find((exercise) => exercise.exerciseId === firstDraft.id).newLibraryExercise;
  const form = createTechniqueForm(entry);
  assert.ok(!form.setup.includes("- "), "the form shows one bullet per line without hyphens");
  const edited = applyTechniqueForm(entry, { ...form, mainCue: "  Hips back,   bar close. ", setup: "stand tall\n\n- grip the bar\n", executionTips: "keep the bar close\n* look ahead" });
  assert.equal(edited.mainCue, "Hips back, bar close.");
  assert.equal(edited.setup, "- stand tall\n- grip the bar");
  assert.deepEqual(edited.executionTips, ["keep the bar close", "look ahead"]);
  assert.deepEqual(edited.goalTags, entry.goalTags, "a corrected AI draft is still tagged as one");
  assert.equal(edited.id, entry.id);
  const manual = setNewLibraryEntryInDraft(inStudio.draft, edited);
  assert.equal(manual.libraryExercises.find((item) => item.id === entry.id).setup, "- stand tall\n- grip the bar");
  assert.equal(setNewLibraryEntryInDraft(inStudio.draft, { ...edited, id: libraryExercise.exerciseId }), inStudio.draft, "a Library id changes nothing");
  assert.equal(validateProgramDraft(manual).valid, true);

  // Fix round 2: the review summary of the Studio follows the accepted notes.
  const newInDraft = listNewExercisesOfDraft(programDraft).length;
  assert.ok(newInDraft >= 2, "the sample draft has several new exercises");
  assert.equal(describeNewExercises(programDraft), `${newInDraft} new (no technique content yet)`);
  assert.equal(
    describeNewExercises(inStudio.draft),
    `${newInDraft} new (1 with technique notes, ${newInDraft - 1} without technique content yet)`,
  );
  let allNoted = programDraft;
  listNewExercisesOfDraft(programDraft).forEach((exercise) => {
    allNoted = setNewLibraryEntryInDraft(allNoted, { ...entry, id: exercise.id, name: exercise.name });
  });
  assert.equal(describeNewExercises(allNoted), `${newInDraft} new (technique notes added)`);
  assert.equal(describeNewExercises({ days: [{ sections: [{ exercises: [{ libraryStatus: "library" }] }] }] }), "");
  assert.equal(describeNewExercises(null), "");

  // Fix round 2: every field emptied = no AI notes left, so no review marker.
  const emptyForm = Object.fromEntries(Object.keys(form).map((field) => [field, ""]));
  const emptied = applyTechniqueForm(entry, emptyForm);
  assert.equal(hasTechniqueNotes(emptied), false);
  assert.equal(isAiTechniqueEntry(emptied), false, "an entry without notes is not badged as an AI draft");
  assert.equal(emptied.goalTags.includes(TECHNIQUE_DRAFT_TAG), false);
  assert.equal(emptied.goalTags.includes(AI_GENERATED_TAG), true, "the entry itself still comes from an import");
  assert.equal("reviewedByUser" in emptied, false);
  assert.equal(emptied.id, entry.id);
  assert.equal(emptied.name, entry.name);
  assert.ok(entry.goalTags.includes(TECHNIQUE_DRAFT_TAG), "the input entry is not mutated");
  // Spaces and bare bullet markers are not notes either.
  assert.equal(isAiTechniqueEntry(applyTechniqueForm(entry, { ...emptyForm, setup: "  \n - \n", mainCue: "   " })), false);
  // One field left: still the AI draft.
  assert.equal(isAiTechniqueEntry(applyTechniqueForm(entry, { ...emptyForm, mainCue: "Hips back" })), true);
  assert.equal(isAiTechniqueEntry(applyTechniqueForm(entry, { ...emptyForm, commonMistakes: "rounding the back" })), true);
  // Notes typed again after everything was cleared are the user's own.
  const retyped = applyTechniqueForm(emptied, { ...emptyForm, setup: "stand tall" });
  assert.equal(hasTechniqueNotes(retyped), true);
  assert.equal(isAiTechniqueEntry(retyped), false);
  assert.equal(validateProgramDraft(setNewLibraryEntryInDraft(inStudio.draft, emptied)).valid, true);

  // An empty new entry: What You Should Feel's muscle placeholder is not notes.
  assert.equal(hasTechniqueNotes({ id: "x", name: "X", mainMuscles: ["Lats", "Biceps"], whatYouShouldFeel: "Lats, Biceps" }), false);
  assert.equal(createTechniqueForm({ mainMuscles: ["Lats"], whatYouShouldFeel: "Lats" }).whatYouShouldFeel, "");
}

// ------------------------------------------------------------------
// Fix round 2: one extraction run at a time, ended when the draft is handed on
// ------------------------------------------------------------------
{
  const tracker = createExtractionTracker();
  assert.equal(tracker.isRunning(), false);
  assert.equal(tracker.cancel(), false, "nothing to cancel");

  const first = tracker.start();
  assert.equal(tracker.isCurrent(first.id), true);
  assert.equal(tracker.isRunning(), true);
  assert.ok(first.signal instanceof AbortSignal);
  assert.equal(first.signal.aborted, false);

  // "Edit draft in Studio" / "Add to my programs" / "Discard draft" while the request runs.
  assert.equal(tracker.cancel(), true);
  assert.equal(first.signal.aborted, true, "the request is aborted");
  assert.equal(tracker.isCurrent(first.id), false, "its answer is not kept");
  assert.equal(tracker.isRunning(), false);

  // The aborted signal really ends an extraction request without a draft.
  const { extractProgramDraftWithAi, getGeminiApiKey, setGeminiApiKey } = await import("../src/lib/aiProgram.js");
  const keyBefore = getGeminiApiKey();
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("no request is expected");
  };
  assert.equal(setGeminiApiKey("h3-fix2-tracker-key").ok, true);
  const aborted = await extractProgramDraftWithAi({ kind: "text", text: "Day 1\nSquat 3x5\nBench 3x8" }, { signal: first.signal });
  assert.equal(aborted.valid, false);
  assert.equal(fetchCount, 0);
  assert.equal(setGeminiApiKey(keyBefore ?? "").ok, true);
  globalThis.fetch = previousFetch;

  // A run that returned is closed by finish; a later run is a new one.
  const second = tracker.start();
  assert.notEqual(second.id, first.id);
  tracker.finish(first.id);
  assert.equal(tracker.isCurrent(second.id), true, "finishing an old run does not close the open one");
  tracker.finish(second.id);
  assert.equal(tracker.isRunning(), false);
  assert.equal(second.signal.aborted, false, "a finished run is not aborted");

  // Starting again while a run is open ends the open one.
  const third = tracker.start();
  const fourth = tracker.start();
  assert.equal(third.signal.aborted, true);
  assert.equal(tracker.isCurrent(third.id), false);
  assert.equal(tracker.isCurrent(fourth.id), true);

  // Leaving the page is not a cancel: two assistants do not share a tracker.
  assert.equal(createExtractionTracker().isCurrent(fourth.id), false);
}

// ------------------------------------------------------------------
// Save: the notes persist with the new entry, through the add-only writer
// ------------------------------------------------------------------
const finalDraft = draftFromShare(acceptedBoth.share, { origin: "ai-import" });
assert.equal(finalDraft.ok, true, finalDraft.error);
assert.equal(validateProgramDraft(finalDraft.draft).valid, true);

// The stored review draft (what "Edit draft in Studio" keeps) has no source.
{
  const stored = saveDraftToStorage(finalDraft.draft);
  assert.equal(stored.ok, true, stored.error);
  const raw = window.localStorage.getItem(STORAGE_KEYS.programDrafts);
  assert.ok(raw && raw.includes(finalDraft.draft.program.name));
  assert.ok(!raw.includes("dataBase64"), "no file bytes field in the stored draft");
  assert.ok(!raw.includes(sourceText.trim()), "the pasted source is not in the stored draft");
  assert.ok(!raw.includes(JSON.stringify(sourceText.trim()).slice(1, -1)), "nor in its JSON-escaped form");
  assert.ok(!raw.includes(API_KEY));
  assert.ok(raw.includes(firstDraft.mainCue), "accepted technique notes travel with the stored draft");
  assert.ok(raw.includes(finalDraft.draft.reviewNotes.uncertainty[0].slice(0, 40)), "the review notes travel with it (H2-8)");
}

const saved = saveProgramDraft(finalDraft.draft);
assert.equal(saved.ok, true, saved.error);
{
  const library = getExerciseLibrary();
  const before = JSON.parse(libraryBefore);
  before.forEach((entry) => {
    assert.deepEqual(library.find((item) => item.id === entry.id), entry, `${entry.name}: an existing Library entry is never changed`);
  });
  assert.equal(library.length, before.length + newExercises.length, "add-only");

  for (const techniqueDraft of [firstDraft, secondDraft]) {
    const entry = library.find((item) => item.name === techniqueDraft.name);
    assert.ok(entry, `${techniqueDraft.name} was added with the program`);
    assert.equal(entry.mainCue, techniqueDraft.mainCue);
    assert.equal(entry.setup, techniqueDraft.setup);
    assert.deepEqual(entry.executionTips, techniqueDraft.executionTips);
    assert.deepEqual(entry.commonMistakes, techniqueDraft.commonMistakes);
    assert.ok(entry.goalTags.includes(AI_GENERATED_TAG), "tagged ai-generated");
    assert.ok(entry.goalTags.includes(TECHNIQUE_DRAFT_TAG), "tagged technique-ai-draft");
    assert.equal(getTechniqueRows(entry).length, 9);
  }

  const withoutNotes = newExercises.slice(2);
  withoutNotes.forEach((exercise) => {
    const entry = library.find((item) => item.name === exercise.name);
    assert.ok(entry);
    assert.equal(hasTechniqueNotes(entry), false, `${exercise.name}: no draft accepted, no notes`);
    assert.ok(!entry.goalTags.includes(TECHNIQUE_DRAFT_TAG));
  });
}

// Nothing of the source or the key in backups and share files.
{
  const backup = JSON.stringify(createLocalBackup());
  const share = JSON.stringify(exportProgramShare(saved.program.id));
  for (const [label, text] of [["backup", backup], ["share", share]]) {
    assert.ok(!text.includes(API_KEY), `${label}: no API key`);
    assert.ok(!text.includes("dataBase64"), `${label}: no file bytes`);
    assert.ok(!text.includes(sourceText.trim()), `${label}: no source text`);
    assert.ok(!text.includes(JSON.stringify(sourceText.trim()).slice(1, -1)), `${label}: no escaped source text`);
  }
}

// An image bundle: the bytes are in the request and nowhere in the result.
{
  const pageSources = [
    await readSourceFile(fileLike("page-1.png", "image/png", readBytes("page-1.png"))),
    await readSourceFile(fileLike("page-2.png", "image/png", readBytes("page-2.png"))),
  ];
  const order = moveListItem([0, 1], 1, -1);
  const bundle = buildImageBundle(pageSources, order);
  assert.equal(bundle.ok, true, bundle.error);
  assert.deepEqual(bundle.files.map((file) => file.name), ["page-2.png", "page-1.png"], "the user's order is the page order");
  responses = [geminiOk(canned("image-bundle.json"))];
  fetchCalls.length = 0;
  const result = await extractProgramDraftWithAi(bundle);
  assert.equal(result.valid, true, result.error);
  const parts = fetchCalls[0].body.contents[0].parts;
  assert.deepEqual(
    parts.filter((part) => part.inline_data).map((part) => part.inline_data.data),
    bundle.files.map((file) => file.dataBase64),
  );
  const text = JSON.stringify(result);
  bundle.files.forEach((file) => assert.ok(!text.includes(file.dataBase64), "no image bytes in the result"));
  assert.ok(!text.includes("dataBase64"));
}

// Office text goes out as text, the document never does.
{
  responses = [geminiOk(canned("program.docx-text.json"))];
  fetchCalls.length = 0;
  const result = await extractProgramDraftWithAi(docxSource);
  assert.equal(result.valid, true, result.error);
  const parts = fetchCalls[0].body.contents[0].parts;
  assert.ok(parts.every((part) => !part.inline_data), "a DOCX is sent as text parts only");
  assert.ok(!JSON.stringify(result).includes(docxSource.text.trim()), "the sent text is not in the result");
}

console.log("verify-ui-h3-helpers: ok");
