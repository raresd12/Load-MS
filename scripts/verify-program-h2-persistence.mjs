// Phase H2 Track A: saved drafts (decision H2-3) and source weights (H2-4).
// - rpe-tracker.program-drafts.v1 holds at most 5 entries
//   { draftId, origin, sourceProgramId, updatedAt, draft }, newest first.
// - A stored draft is the whitelist-normalised draft: never a raw upload,
//   image data or the Gemini key, whatever a component attached to it.
// - sourceWeight is display-only reference text: never targetWeight, never a
//   progression value.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failOn = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failOn && this.failOn(key)) {
      throw new Error("QuotaExceededError (simulated)");
    }

    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };
console.warn = () => {};

const { STORAGE_KEYS, getTrackedStorageKeys } = await import("../src/lib/storage.js");
const {
  deleteStoredDraft,
  getProgramDays,
  getProgramDayViewModels,
  getProgramExercises,
  getProgramProgression,
  listStoredDrafts,
  loadStoredDraft,
  MAX_STORED_PROGRAM_DRAFTS,
  PROGRAM_DRAFTS_STORAGE_KEY,
  saveDraftToStorage,
  saveProgramDraft,
  seedDefaultProgramIfNeeded,
} = await import("../src/lib/programStorage.js");
const { addExercise, createBlankProgramDraft, updateExercise, updateProgramMeta, updateWarmup, validateProgramDraft } =
  await import("../src/lib/programDraft.js");

const GEMINI_KEY_STORAGE = "rpe-tracker.gemini-api-key.v1";
const GEMINI_KEY = "AIzaSy-SECRET-KEY-VALUE-0000";
const IMAGE_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
const RAW_UPLOAD = "RAW-PDF-BYTES-%PDF-1.4-SOURCE";
const forbidden = [GEMINI_KEY, IMAGE_DATA, RAW_UPLOAD, "sourceFile", "imageData", "apiKey", "geminiApiKey", "base64"];

try {
  seedDefaultProgramIfNeeded();
  storage.setItem(GEMINI_KEY_STORAGE, GEMINI_KEY);
  assert.equal(PROGRAM_DRAFTS_STORAGE_KEY, "rpe-tracker.program-drafts.v1");
  assert.equal(STORAGE_KEYS.programDrafts, PROGRAM_DRAFTS_STORAGE_KEY, "the drafts key is a tracked app key");
  assert.ok(getTrackedStorageKeys().includes(PROGRAM_DRAFTS_STORAGE_KEY));
  assert.equal(MAX_STORED_PROGRAM_DRAFTS, 5);
  assert.deepEqual(listStoredDrafts(), []);
  assert.equal(loadStoredDraft("nothing"), null);
  assert.deepEqual(deleteStoredDraft("nothing"), { ok: true, removed: false });

  // ------------------------------------------------------------------
  // A draft carrying junk from a component is stored as text only
  // ------------------------------------------------------------------
  let draft = updateProgramMeta(createBlankProgramDraft(), { name: "Photo import" });
  const dayId = draft.days[0].id;
  const sectionId = draft.days[0].sections[0].id;
  draft = updateWarmup(draft, dayId, { items: [{ name: "Bike", prescription: "5 min", imageData: IMAGE_DATA }] });
  draft = addExercise(draft, dayId, sectionId, { exerciseId: "bench-press", sourceWeight: "80 kg" });
  draft = addExercise(draft, dayId, sectionId, {
    libraryStatus: "new",
    exerciseId: "draft-lib-sled",
    name: "Sled Push",
    newLibraryExercise: { id: "draft-lib-sled", name: "Sled Push", category: "athletic", sourceFile: RAW_UPLOAD },
  });
  const benchId = draft.days[0].sections[0].exercises[0].id;
  const sledId = draft.days[0].sections[0].exercises[1].id;
  draft = updateExercise(draft, dayId, sledId, { targetSets: "" });
  assert.equal(draft.days[0].sections[0].exercises[1].targetSets, null, "the user cleared the sets field");
  const polluted = {
    ...draft,
    origin: "ai-import",
    aiInstruction: "  make it 4 days  ",
    sourceFile: { name: "program.pdf", data: RAW_UPLOAD },
    imageData: IMAGE_DATA,
    apiKey: GEMINI_KEY,
    program: { ...draft.program, geminiApiKey: GEMINI_KEY },
    days: draft.days.map((day) => ({
      ...day,
      imageData: IMAGE_DATA,
      sections: day.sections.map((section) => ({
        ...section,
        base64: IMAGE_DATA,
        exercises: section.exercises.map((exercise) => ({ ...exercise, sourceFile: RAW_UPLOAD, apiKey: GEMINI_KEY })),
      })),
    })),
    libraryExercises: draft.libraryExercises.map((entry) => ({ ...entry, imageData: IMAGE_DATA })),
  };

  const saved = saveDraftToStorage(polluted);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.draftId, draft.draftId);
  assert.equal(saved.storedCount, 1);
  assert.deepEqual(saved.droppedDraftIds, []);

  const rawStored = storage.getItem(PROGRAM_DRAFTS_STORAGE_KEY);
  forbidden.forEach((marker) => {
    assert.equal(rawStored.includes(marker), false, `stored drafts never contain "${marker.slice(0, 24)}"`);
  });
  assert.equal(storage.getItem(GEMINI_KEY_STORAGE), GEMINI_KEY, "the key itself is untouched");
  const entries = JSON.parse(rawStored);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]).sort(), ["draft", "draftId", "origin", "sourceProgramId", "updatedAt"]);
  assert.equal(entries[0].origin, "ai-import");
  assert.equal(entries[0].sourceProgramId, null);
  assert.deepEqual(
    Object.keys(entries[0].draft).sort(),
    ["aiInstruction", "createdAt", "days", "draftId", "libraryExercises", "origin", "program", "reviewNotes", "schemaVersion", "source", "sourceProgramId", "updatedAt"],
  );
  assert.equal(entries[0].draft.aiInstruction, "make it 4 days");
  assert.equal(entries[0].updatedAt, entries[0].draft.updatedAt);

  const loaded = loadStoredDraft(draft.draftId);
  assert.equal(loaded.draftId, draft.draftId);
  assert.equal(loaded.program.name, "Photo import");
  assert.equal(loaded.days[0].warmup.items[0].name, "Bike");
  assert.deepEqual(Object.keys(loaded.days[0].warmup.items[0]).sort(), ["id", "name", "notes", "prescription", "videoUrl"]);
  const [loadedBench, loadedSled] = loaded.days[0].sections[0].exercises;
  assert.equal(loadedBench.id, benchId);
  assert.equal(loadedBench.sourceWeight, "80 kg");
  assert.equal(loadedBench.targetWeight, null);
  assert.equal(loadedBench.provenance.sourceWeight, "edited");
  assert.equal(loadedBench.provenance.targetReps, "default", "provenance survives the round trip");
  assert.equal(loadedSled.libraryStatus, "new");
  assert.equal(loadedSled.targetSets, null, "a cleared value stays cleared so validation can report it");
  assert.equal(loadedSled.newLibraryExercise.sourceFile, undefined);
  assert.equal(loaded.libraryExercises[0].imageData, undefined);
  assert.equal(JSON.stringify(loaded).includes("apiKey"), false);

  const listed = listStoredDrafts();
  assert.deepEqual(listed, [
    {
      draftId: draft.draftId,
      origin: "ai-import",
      sourceProgramId: null,
      updatedAt: entries[0].updatedAt,
      programName: "Photo import",
      dayCount: 1,
      exerciseCount: 2,
    },
  ]);

  // ------------------------------------------------------------------
  // Upsert by draftId, cap at MAX_STORED_PROGRAM_DRAFTS, newest first
  // ------------------------------------------------------------------
  const renamed = saveDraftToStorage(updateProgramMeta(loaded, { name: "Photo import v2" }));
  assert.equal(renamed.ok, true);
  assert.equal(renamed.storedCount, 1, "same draftId replaces the entry");
  assert.equal(listStoredDrafts()[0].programName, "Photo import v2");

  const extraIds = [];
  for (let index = 0; index < MAX_STORED_PROGRAM_DRAFTS; index += 1) {
    const extra = updateProgramMeta(createBlankProgramDraft(), { name: `Extra ${index + 1}` });
    // Deterministic ordering regardless of clock resolution.
    const result = saveDraftToStorage({ ...extra, updatedAt: `2026-09-2${index + 1}T00:00:00.000Z` });
    assert.equal(result.ok, true);
    extraIds.push(extra.draftId);
  }
  const afterCap = listStoredDrafts();
  assert.equal(afterCap.length, MAX_STORED_PROGRAM_DRAFTS);
  assert.equal(JSON.parse(storage.getItem(PROGRAM_DRAFTS_STORAGE_KEY)).length, MAX_STORED_PROGRAM_DRAFTS);
  assert.equal(afterCap[0].draftId, extraIds.at(-1), "the draft saved last is first");
  assert.ok(afterCap.some((entry) => entry.draftId === draft.draftId) === false || afterCap.length === MAX_STORED_PROGRAM_DRAFTS);
  const lastSave = saveDraftToStorage(updateProgramMeta(createBlankProgramDraft(), { name: "One more" }));
  assert.equal(lastSave.storedCount, MAX_STORED_PROGRAM_DRAFTS);
  assert.equal(lastSave.droppedDraftIds.length, 1, "the oldest entry is dropped");
  assert.equal(loadStoredDraft(lastSave.droppedDraftIds[0]), null);
  assert.deepEqual(
    lastSave.droppedDrafts,
    [{ draftId: lastSave.droppedDraftIds[0], origin: "blank", programName: `Extra ${extraIds.indexOf(lastSave.droppedDraftIds[0]) + 1}` }],
    "the evicted draft is reported with its origin and name so the UI can say so",
  );
  const ordered = listStoredDrafts().map((entry) => entry.updatedAt);
  assert.deepEqual(ordered, [...ordered].sort().reverse(), "newest first");

  const removed = deleteStoredDraft(lastSave.draftId);
  assert.deepEqual(removed, { ok: true, removed: true });
  assert.equal(listStoredDrafts().length, MAX_STORED_PROGRAM_DRAFTS - 1);

  // ------------------------------------------------------------------
  // Refusals: no draft, too large, corrupt key, failed write
  // ------------------------------------------------------------------
  assert.equal(saveDraftToStorage(null).ok, false);
  const huge = updateProgramMeta(createBlankProgramDraft(), { name: "Huge", description: "x".repeat(300 * 1024) });
  const tooLarge = saveDraftToStorage(huge);
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, "too-large");
  assert.equal(loadStoredDraft(huge.draftId), null);

  const before = storage.getItem(PROGRAM_DRAFTS_STORAGE_KEY);
  storage.failOn = (key) => key === PROGRAM_DRAFTS_STORAGE_KEY;
  const failedWrite = saveDraftToStorage(updateProgramMeta(createBlankProgramDraft(), { name: "Lost" }));
  storage.failOn = null;
  assert.equal(failedWrite.ok, false);
  assert.ok(failedWrite.error);
  assert.equal(storage.getItem(PROGRAM_DRAFTS_STORAGE_KEY), before);

  storage.setItem(PROGRAM_DRAFTS_STORAGE_KEY, "{broken");
  const corruptSave = saveDraftToStorage(updateProgramMeta(createBlankProgramDraft(), { name: "Blocked" }));
  assert.equal(corruptSave.ok, false);
  assert.equal(corruptSave.code, "corrupt");
  assert.equal(deleteStoredDraft("x").code, "corrupt");
  assert.deepEqual(listStoredDrafts(), [], "an unreadable key lists nothing instead of throwing");
  assert.equal(storage.getItem(PROGRAM_DRAFTS_STORAGE_KEY), "{broken", "never overwritten");
  storage.setItem(PROGRAM_DRAFTS_STORAGE_KEY, before);
  storage.removeItem(`${PROGRAM_DRAFTS_STORAGE_KEY}.corrupt-1`);

  // ------------------------------------------------------------------
  // H2-4: sourceWeight is reference text, never a target or a recommendation
  // ------------------------------------------------------------------
  let weighted = updateProgramMeta(createBlankProgramDraft(), { name: "Weighted" });
  const wDay = weighted.days[0].id;
  const wSection = weighted.days[0].sections[0].id;
  weighted = addExercise(weighted, wDay, wSection, { exerciseId: "bench-press", sourceWeight: "80 kg", targetWeight: 60 });
  weighted = addExercise(weighted, wDay, wSection, { exerciseId: "dips", sourceWeight: "BW +10 kg" });
  const [wBench, wDips] = weighted.days[0].sections[0].exercises;
  assert.equal(wBench.targetWeight, 60, "an explicit target stays a target");
  assert.equal(wDips.targetWeight, null, "a source weight alone never fills the target");
  const edited = updateExercise(weighted, wDay, wDips.id, { sourceWeight: "BW +12.5 kg" });
  assert.equal(edited.days[0].sections[0].exercises[1].targetWeight, null);
  assert.equal(edited.days[0].sections[0].exercises[1].sourceWeight, "BW +12.5 kg");

  const savedProgram = saveProgramDraft(edited);
  assert.equal(savedProgram.ok, true, savedProgram.error);
  const [storedBench, storedDips] = getProgramExercises(getProgramDays(savedProgram.programId)[0].id);
  assert.equal(storedBench.targetWeight, 60);
  assert.equal(storedBench.sourceWeight, "80 kg");
  assert.equal(storedDips.targetWeight, null);
  assert.equal(storedDips.sourceWeight, "BW +12.5 kg");
  assert.equal(getProgramProgression(savedProgram.programId, storedDips.id), null, "no earned recommendation from a listed weight");
  const view = getProgramDayViewModels(savedProgram.programId)[0].exercises[1];
  assert.equal(view.recommendedWeight, null);
  assert.equal(view.sourceWeight, "BW +12.5 kg");

  // ------------------------------------------------------------------
  // Fix round 1: a cleared rep range is stored as cleared (not as the 8-12
  // default marked "edited"); review notes travel with the stored draft.
  // ------------------------------------------------------------------
  let cleared = updateProgramMeta(createBlankProgramDraft(), { name: "Cleared" });
  cleared = addExercise(cleared, cleared.days[0].id, cleared.days[0].sections[0].id, { exerciseId: "bench-press" });
  cleared = updateExercise(cleared, cleared.days[0].id, cleared.days[0].sections[0].exercises[0].id, {
    targetReps: { min: null, max: null, label: null },
    targetRPE: null,
    restTime: null,
  });
  assert.equal(validateProgramDraft(cleared).valid, false);
  assert.equal(saveDraftToStorage(cleared).ok, true);
  const clearedBack = loadStoredDraft(cleared.draftId);
  const clearedBench = clearedBack.days[0].sections[0].exercises[0];
  assert.deepEqual(clearedBench.targetReps, { min: null, max: null, label: null }, "a cleared rep range is not replaced by the 8-12 default");
  assert.equal(clearedBench.provenance.targetReps, "edited");
  assert.equal(clearedBench.targetRPE, null);
  assert.equal(clearedBench.restTime, null);
  assert.ok(
    validateProgramDraft(clearedBack).errors.some((entry) => /rep range/.test(entry.message)),
    "validation still reports the cleared reps after resume",
  );
  const withNotes = { ...cleared, reviewNotes: { changes: ["Day 1: x"], removed: ["Old"], uncertainty: ["?"], extra: "dropped" } };
  assert.equal(saveDraftToStorage(withNotes).ok, true);
  assert.deepEqual(loadStoredDraft(cleared.draftId).reviewNotes, { changes: ["Day 1: x"], removed: ["Old"], uncertainty: ["?"] });
  assert.equal(loadStoredDraft(cleared.draftId).reviewNotes.extra, undefined, "only the three text lists are kept");
  assert.equal(deleteStoredDraft(cleared.draftId).ok, true);

  // ------------------------------------------------------------------
  // Fix round 2 (H2-11 completed): weight / rest text the editor could not
  // parse survives the stored-draft round trip AS TEXT, so a resumed draft
  // still fails validation and Apply cannot clear a stored target (and its
  // progression) from a typo. A real clear / "BW" / number still round-trips.
  // ------------------------------------------------------------------
  const { applyProgramDraft, DEFAULT_PROGRAM_ID, duplicateProgram, updateProgramExerciseTargetChecked } =
    await import("../src/lib/programStorage.js");
  const { draftFromProgram } = await import("../src/lib/programDraft.js");
  const typoCopy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.ok(typoCopy.ok, typoCopy.error);
  const typoDay = getProgramDays(typoCopy.programId)[0];
  const typoBench = getProgramExercises(typoDay.id).find((exercise) => exercise.exerciseId === "bench-press");
  assert.ok(typoBench, "the default program's first day has a bench press");
  assert.equal(updateProgramExerciseTargetChecked(typoCopy.programId, typoBench.id, { targetWeight: 80 }).ok, true);
  // 19.4-2 removed the progression with the target edit: put one back so the
  // fixture can show it is untouched.
  const progressionRows = JSON.parse(storage.getItem(STORAGE_KEYS.programProgressions));
  const progressionTemplate = progressionRows.find((row) => row.programId === typoCopy.programId);
  assert.ok(progressionTemplate, "the duplicate carries progression rows (19.4-1)");
  storage.setItem(
    STORAGE_KEYS.programProgressions,
    JSON.stringify([...progressionRows, { ...progressionTemplate, programExerciseId: typoBench.id, lastRecommendedWeight: 82.5 }]),
  );
  assert.ok(getProgramProgression(typoCopy.programId, typoBench.id), "the bench press has a progression row");
  const findTypo = (draft) =>
    draft.days.find((day) => day.id === typoDay.id).sections.flatMap((section) => section.exercises).find((exercise) => exercise.id === typoBench.id);
  const typoDraft0 = draftFromProgram(typoCopy.programId).draft;
  assert.equal(findTypo(typoDraft0).targetWeight, 80);
  const typoDraft = updateExercise(typoDraft0, typoDay.id, typoBench.id, { targetWeight: "82.5kgg", restTime: "150-" });
  assert.equal(findTypo(typoDraft).targetWeight, "82.5kgg", "the working draft keeps the typed text (H2-11)");
  assert.equal(validateProgramDraft(typoDraft).valid, false);
  assert.equal(saveDraftToStorage(typoDraft).ok, true);
  const typoResumed = loadStoredDraft(typoDraft.draftId);
  assert.equal(findTypo(typoResumed).targetWeight, "82.5kgg", "the stored draft keeps the unusable weight text, not null");
  assert.equal(findTypo(typoResumed).restTime, "150-", "and the unusable rest text");
  const typoValidation = validateProgramDraft(typoResumed);
  assert.equal(typoValidation.valid, false, "a resumed draft with a typo still fails validation");
  assert.ok(typoValidation.errors.some((entry) => entry.path.endsWith(".targetWeight")), "the weight is reported");
  assert.ok(typoValidation.errors.some((entry) => entry.path.endsWith(".restTime")), "the rest is reported");
  const typoApply = applyProgramDraft(typoResumed);
  assert.equal(typoApply.ok, false, "Apply is refused");
  assert.equal(typoApply.code, "invalid");
  assert.equal(getProgramExercises(typoDay.id).find((exercise) => exercise.id === typoBench.id).targetWeight, 80, "the stored target is untouched");
  assert.equal(getProgramProgression(typoCopy.programId, typoBench.id).lastRecommendedWeight, 82.5, "and so is its progression");
  assert.equal(deleteStoredDraft(typoDraft.draftId).ok, true);
  // Intentional values still round-trip as values.
  [
    [null, null],
    ["BW", "BW"],
    [82.5, 82.5],
    ["  90 ", 90],
  ].forEach(([input, expected]) => {
    const valued = updateExercise(typoDraft0, typoDay.id, typoBench.id, { targetWeight: input });
    assert.equal(saveDraftToStorage(valued).ok, true);
    assert.equal(findTypo(loadStoredDraft(valued.draftId)).targetWeight, expected, `weight ${JSON.stringify(input)} round-trips as ${JSON.stringify(expected)}`);
    assert.equal(validateProgramDraft(loadStoredDraft(valued.draftId)).valid, true);
    assert.equal(deleteStoredDraft(valued.draftId).ok, true);
  });

  console.log("verify-program-h2-persistence: ok");
} catch (error) {
  console.error("verify-program-h2-persistence: FAIL");
  console.error(error);
  process.exit(1);
}
