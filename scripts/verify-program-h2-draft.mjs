// Phase H2 Track A: the ProgramDraft model (src/lib/programDraft.js).
// - createBlankProgramDraft / draftFromProgram (custom only) / draftFromShare
//   (11.4 envelope, AI share, AI edit with refId) / draftToShare round trip
// - provenance: "source" for present values, "default" for filled ones
// - validateProgramDraft errors and diffDraftAgainstProgram (review screen)
import assert from "node:assert/strict";

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

const {
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  getExerciseById,
  getProgramDays,
  getProgramExercises,
  getProgramSections,
  importProgramShare,
  PROGRAM_SHARE_TYPE,
  seedDefaultProgramIfNeeded,
  validateProgramShareStrict,
} = await import("../src/lib/programStorage.js");
const {
  addDay,
  addExercise,
  addSection,
  createBlankProgramDraft,
  diffDraftAgainstProgram,
  draftFromProgram,
  draftFromShare,
  draftToShare,
  DRAFT_EXERCISE_PROVENANCE_FIELDS,
  moveExercise,
  PROGRAM_DRAFT_SCHEMA_VERSION,
  remapExercise,
  removeDay,
  removeExercise,
  summarizeProgramDraft,
  updateDayMeta,
  updateExercise,
  updateProgramMeta,
  updateWarmup,
  validateProgramDraft,
} = await import("../src/lib/programDraft.js");

const allExercises = (draft) => draft.days.flatMap((day) => day.sections.flatMap((section) => section.exercises));
const errorPaths = (draft) => validateProgramDraft(draft).errors.map((entry) => entry.path);

try {
  seedDefaultProgramIfNeeded();

  // ------------------------------------------------------------------
  // Blank draft
  // ------------------------------------------------------------------
  const blank = createBlankProgramDraft();
  assert.equal(blank.schemaVersion, PROGRAM_DRAFT_SCHEMA_VERSION);
  assert.equal(blank.origin, "blank");
  assert.equal(blank.sourceProgramId, null);
  assert.equal(blank.aiInstruction, null);
  assert.equal(blank.days.length, 1);
  assert.equal(blank.days[0].sections.length, 1);
  assert.deepEqual(blank.days[0].sections[0].exercises, []);
  assert.equal(blank.days[0].warmup, null);
  assert.deepEqual(blank.libraryExercises, []);
  assert.deepEqual(errorPaths(blank), ["program.name"], "a blank draft only lacks a name");
  assert.equal(validateProgramDraft(updateProgramMeta(blank, { name: "Mine" })).valid, true);

  // ------------------------------------------------------------------
  // draftFromProgram: default protected, custom keeps ids, everything "source"
  // ------------------------------------------------------------------
  const protectedResult = draftFromProgram(DEFAULT_PROGRAM_ID);
  assert.equal(protectedResult.ok, false);
  assert.match(protectedResult.error, /protected/i);
  assert.equal(draftFromProgram("missing-program").ok, false);

  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(copy.ok, true);
  const fromProgram = draftFromProgram(copy.programId);
  assert.equal(fromProgram.ok, true);
  const programDraft = fromProgram.draft;
  assert.equal(programDraft.origin, "program");
  assert.equal(programDraft.sourceProgramId, copy.programId);
  assert.equal(programDraft.program.name, copy.program.name);

  const storedDays = getProgramDays(copy.programId);
  assert.deepEqual(
    programDraft.days.map((day) => day.id),
    storedDays.map((day) => day.id),
    "draft day ids are the stored day ids",
  );
  storedDays.forEach((day, index) => {
    const draftDay = programDraft.days[index];
    const storedSections = getProgramSections(day.id);
    const storedExercises = getProgramExercises(day.id);
    assert.deepEqual(
      draftDay.sections.map((section) => section.id).slice(0, storedSections.length),
      storedSections.map((section) => section.id),
    );
    assert.deepEqual(
      draftDay.sections.flatMap((section) => section.exercises.map((exercise) => exercise.id)),
      storedExercises.map((exercise) => exercise.id),
      "draft exercise ids are the stored programExerciseIds in orderIndex order",
    );
    assert.deepEqual(draftDay.warmup, day.warmup ?? null);
    assert.ok(draftDay.sections.length >= 1, "a recovery day still has one section to add exercises to");
  });

  const bench = programDraft.days[0].sections[0].exercises[0];
  assert.equal(bench.exerciseId, "bench-press");
  assert.equal(bench.libraryStatus, "library");
  assert.equal(bench.name, getExerciseById("bench-press").name);
  assert.equal(bench.targetWeight, null);
  assert.equal(bench.sourceWeight, null);
  assert.equal(bench.loadType, "external");
  assert.equal(bench.weightMode, "kg");
  ["targetSets", "targetReps", "targetRPE", "restTime", "notes", "type", "isOptional", "exerciseId", "name"].forEach(
    (field) => assert.equal(bench.provenance[field], "source", `${field} comes from the stored record`),
  );
  assert.equal(bench.provenance.loadType, "default", "a legacy record has no persisted load type");
  assert.equal(bench.provenance.weightMode, "default");
  assert.deepEqual(Object.keys(bench.provenance).sort(), [...DRAFT_EXERCISE_PROVENANCE_FIELDS].sort());

  const pullUps = allExercises(programDraft).find((exercise) => exercise.exerciseId === "weighted-pull-ups");
  assert.equal(pullUps.loadType, "optionalExternal", "profile derived from the built-in config");
  assert.equal(pullUps.weightMode, "additional load");
  assert.equal(validateProgramDraft(programDraft).valid, true);

  // ------------------------------------------------------------------
  // draftFromShare: AI-generated share (11.4 + source, draftMeta, sourceWeight)
  // ------------------------------------------------------------------
  const aiShare = {
    app: "rpe-workout-tracker",
    type: PROGRAM_SHARE_TYPE,
    schemaVersion: 1,
    exportedAt: "2026-09-25T10:00:00.000Z",
    source: "ai-generated",
    program: { name: "AI Upper", nickname: "", description: "from a photo", goal: "" },
    days: [
      {
        id: "ai-day-1",
        programId: "ai-generated",
        name: "Push",
        focus: "Chest",
        orderIndex: 0,
        warmup: { title: "Prep", items: [{ id: "w1", name: "Band pull-aparts", prescription: "2 x 15" }] },
      },
      { id: "ai-day-2", programId: "ai-generated", name: "Rest day", focus: "", orderIndex: 1 },
    ],
    sections: [
      { id: "ai-generated:ai-day-1:section-1", programId: "ai-generated", dayId: "ai-day-1", name: "Main Work", orderIndex: 0 },
      { id: "ai-generated:ai-day-1:section-2", programId: "ai-generated", dayId: "ai-day-1", name: "Accessories", orderIndex: 1 },
    ],
    programExercises: [
      {
        id: "ai-generated:ai-day-1:1-bench-press",
        programId: "ai-generated",
        dayId: "ai-day-1",
        sectionId: "ai-generated:ai-day-1:section-1",
        exerciseId: "bench-press",
        orderIndex: 0,
        targetSets: 5,
        targetReps: { min: 5, max: 5, label: "5" },
        targetWeight: null,
        targetRPE: 8,
        restTime: 180,
        notes: "",
        type: "strength",
        isOptional: false,
        sourceWeight: "80 kg",
      },
      {
        id: "ai-generated:ai-day-1:2-ai-cable-fly",
        programId: "ai-generated",
        dayId: "ai-day-1",
        sectionId: "ai-generated:ai-day-1:section-2",
        exerciseId: "ai-cable-fly",
        orderIndex: 1,
        targetSets: 3,
        targetReps: { min: 12, max: 15, label: "12-15" },
        targetWeight: null,
        targetRPE: 8,
        restTime: [60, 90],
        notes: "slow eccentric",
        type: "hypertrophy",
        isOptional: true,
        loadType: "external",
        weightMode: "kg",
      },
    ],
    libraryExercises: [
      { id: "ai-cable-fly", name: "Cable Fly", category: "isolation", equipment: "cable", mainMuscles: ["chest"], tags: ["ai-generated"] },
      { id: "ai-unused", name: "Unused Entry", category: "isolation", equipment: "cable" },
      { id: "bench-press", name: "Bench Press (share copy)", category: "compound", equipment: "barbell" },
    ],
    draftMeta: {
      provenance: {
        "ai-generated:ai-day-1:2-ai-cable-fly": { targetRPE: "default", restTime: "default" },
      },
    },
  };

  const fromAi = draftFromShare(aiShare);
  assert.equal(fromAi.ok, true, fromAi.error);
  const aiDraft = fromAi.draft;
  assert.equal(aiDraft.origin, "ai-import");
  assert.equal(aiDraft.source, "ai-generated", "share.source is kept");
  assert.equal(aiDraft.sourceProgramId, null);
  assert.equal(aiDraft.program.name, "AI Upper");
  assert.equal(aiDraft.days.length, 2);
  assert.equal(aiDraft.days[0].id, "ai-day-1");
  assert.equal(aiDraft.days[0].warmup.items.length, 1);
  assert.equal(aiDraft.days[1].sections.length, 1, "a rest day gets an empty section");
  assert.deepEqual(
    aiDraft.days[0].sections.map((section) => [section.id, section.exercises.length]),
    [
      ["ai-generated:ai-day-1:section-1", 1],
      ["ai-generated:ai-day-1:section-2", 1],
    ],
  );

  const [aiBench] = aiDraft.days[0].sections[0].exercises;
  assert.equal(aiBench.id, "ai-generated:ai-day-1:1-bench-press");
  assert.equal(aiBench.libraryStatus, "library", "a known id resolves to the local Library, the share copy is ignored");
  assert.equal(aiBench.name, getExerciseById("bench-press").name);
  assert.equal(aiBench.sourceWeight, "80 kg", "H2-4: source weight kept as text");
  assert.equal(aiBench.targetWeight, null, "H2-4: never a target");
  assert.equal(aiBench.provenance.sourceWeight, "source");
  assert.equal(aiBench.provenance.targetSets, "source");
  assert.equal(aiBench.provenance.loadType, "default", "derived, not in the share");

  const [aiFly] = aiDraft.days[0].sections[1].exercises;
  assert.equal(aiFly.libraryStatus, "new");
  assert.equal(aiFly.exerciseId, "ai-cable-fly");
  assert.equal(aiFly.name, "Cable Fly");
  assert.equal(aiFly.newLibraryExercise.name, "Cable Fly");
  assert.equal(aiFly.isOptional, true);
  assert.deepEqual(aiFly.restTime, [60, 90]);
  assert.equal(aiFly.provenance.targetRPE, "default", "draftMeta.provenance wins over presence");
  assert.equal(aiFly.provenance.restTime, "default");
  assert.equal(aiFly.provenance.loadType, "source", "explicit enum in the share");
  assert.equal(aiFly.provenance.weightMode, "source");
  assert.deepEqual(
    aiDraft.libraryExercises.map((entry) => entry.id),
    ["ai-cable-fly"],
    "only referenced, not-yet-local entries are proposed",
  );
  assert.equal(aiDraft.libraryExercises[0].tags, undefined, "whitelist copy: unknown fields dropped");
  assert.equal(validateProgramDraft(aiDraft).valid, true);

  // Missing-value labels from the AI preview mark defaults; a share without a
  // rep value gets the default rep range labelled "default".
  const sparseShare = {
    ...aiShare,
    draftMeta: undefined,
    programExercises: [
      {
        id: "x1",
        dayId: "ai-day-1",
        sectionId: "ai-generated:ai-day-1:section-1",
        exerciseId: "bench-press",
        targetSets: 3,
        targetRPE: 8,
        restTime: 120,
        missingFields: ["sets"],
      },
    ],
  };
  const sparse = draftFromShare(sparseShare, { origin: "file-import" }).draft;
  const [sparseBench] = allExercises(sparse);
  assert.equal(sparse.origin, "file-import");
  assert.deepEqual(sparseBench.targetReps, { min: 8, max: 12, label: null });
  assert.equal(sparseBench.provenance.targetReps, "default");
  assert.equal(sparseBench.provenance.targetSets, "default", "missingFields label overrides presence");
  assert.equal(sparseBench.provenance.targetRPE, "source");
  assert.equal(sparseBench.provenance.notes, "default");

  assert.equal(draftFromShare({ type: "nope" }).ok, false);
  assert.equal(draftFromShare({ ...aiShare, days: [] }).ok, false);

  // ------------------------------------------------------------------
  // AI edit share: refId on days and exercises keeps the stored ids
  // ------------------------------------------------------------------
  const storedDay = storedDays[0];
  const storedBench = getProgramExercises(storedDay.id)[0];
  const editShare = {
    ...aiShare,
    source: "ai-edit",
    draftMeta: undefined,
    days: [{ id: "ai-day-1", name: storedDay.name, focus: "", orderIndex: 0, refId: storedDay.id }],
    sections: [aiShare.sections[0]],
    programExercises: [
      { ...aiShare.programExercises[0], refId: storedBench.id, targetSets: storedBench.targetSets + 1 },
      { ...aiShare.programExercises[1], sectionId: "ai-generated:ai-day-1:section-1" },
    ],
  };
  const edit = draftFromShare(editShare, { sourceProgramId: copy.programId, aiInstruction: "add a fly" });
  assert.equal(edit.ok, true, edit.error);
  assert.equal(edit.draft.origin, "ai-edit");
  assert.equal(edit.draft.sourceProgramId, copy.programId);
  assert.equal(edit.draft.aiInstruction, "add a fly");
  assert.equal(edit.draft.days[0].id, storedDay.id, "day refId keeps the stored day id");
  assert.deepEqual(
    allExercises(edit.draft).map((exercise) => exercise.id),
    [storedBench.id, "ai-generated:ai-day-1:2-ai-cable-fly"],
    "exercise refId keeps the stored programExerciseId",
  );
  assert.equal(allExercises(edit.draft)[0].refId, undefined, "refId does not leak into the draft exercise");
  const editDiff = diffDraftAgainstProgram(edit.draft);
  assert.equal(editDiff.ok, true);
  assert.deepEqual(editDiff.days.removed.map((day) => day.id), storedDays.slice(1).map((day) => day.id));
  assert.deepEqual(editDiff.days.added, []);
  assert.equal(editDiff.exercises.changed.length, 1);
  assert.equal(editDiff.exercises.changed[0].id, storedBench.id);
  assert.equal(editDiff.exercises.changed[0].prescriptionChanged, true);
  assert.deepEqual(editDiff.exercises.added.map((exercise) => exercise.id), ["ai-generated:ai-day-1:2-ai-cable-fly"]);

  // ------------------------------------------------------------------
  // draftToShare: deterministic ids, enums, draftMeta ignored by the importer
  // ------------------------------------------------------------------
  const share = draftToShare(aiDraft);
  assert.equal(share.type, PROGRAM_SHARE_TYPE);
  assert.equal(share.schemaVersion, 1);
  assert.equal(share.source, "ai-generated");
  assert.deepEqual(share.days.map((day) => day.id), ["draft:day-1", "draft:day-2"]);
  assert.deepEqual(
    share.sections.map((section) => [section.id, section.dayId, section.orderIndex]),
    [
      ["draft:day-1:section-1", "draft:day-1", 0],
      ["draft:day-1:section-2", "draft:day-1", 1],
      ["draft:day-2:section-1", "draft:day-2", 0],
    ],
  );
  assert.deepEqual(
    share.programExercises.map((exercise) => [exercise.id, exercise.sectionId, exercise.orderIndex]),
    [
      ["draft:exercise-1-bench-press", "draft:day-1:section-1", 0],
      ["draft:exercise-2-ai-cable-fly", "draft:day-1:section-2", 1],
    ],
  );
  assert.equal(share.programExercises[0].loadType, "external");
  assert.equal(share.programExercises[0].weightMode, "kg");
  assert.equal(share.programExercises[0].sourceWeight, "80 kg");
  assert.equal(share.programExercises[0].targetWeight, null);
  assert.equal(share.days[0].warmup.items.length, 1);
  assert.deepEqual(share.libraryExercises.map((entry) => entry.id), ["bench-press", "ai-cable-fly"]);
  assert.equal(share.draftMeta.draftId, aiDraft.draftId);
  assert.equal(share.draftMeta.provenance["draft:exercise-2-ai-cable-fly"].targetRPE, "default");
  assert.equal(share.draftMeta.exerciseIds["draft:exercise-2-ai-cable-fly"], aiFly.id);
  assert.equal(share.draftMeta.dayIds["draft:day-1"], "ai-day-1");
  assert.equal(JSON.stringify(draftToShare(aiDraft).programExercises), JSON.stringify(share.programExercises), "ids are deterministic");

  const strict = validateProgramShareStrict(share);
  assert.equal(strict.valid, true, strict.error);
  assert.equal(validateProgramShareStrict({ ...share, draftMeta: { anything: 1 } }).valid, true, "draftMeta ignored");
  assert.equal(
    validateProgramShareStrict({
      ...share,
      programExercises: [{ ...share.programExercises[0], loadType: "magic" }, share.programExercises[1]],
    }).valid,
    false,
    "unknown load type rejected",
  );

  // Round trip through the share keeps the draft ids and provenance.
  const back = draftFromShare(share, { origin: "ai-edit", sourceProgramId: copy.programId });
  assert.equal(back.ok, true, back.error);
  assert.equal(back.draft.draftId, aiDraft.draftId);
  assert.equal(back.draft.origin, "ai-edit");
  assert.deepEqual(back.draft.days.map((day) => day.id), aiDraft.days.map((day) => day.id));
  assert.deepEqual(
    allExercises(back.draft).map((exercise) => [exercise.id, exercise.libraryStatus, exercise.provenance.targetRPE]),
    allExercises(aiDraft).map((exercise) => [exercise.id, exercise.libraryStatus, exercise.provenance.targetRPE]),
  );

  const imported = importProgramShare(share);
  assert.equal(imported.ok, true, imported.error);
  const importedExercises = getProgramDays(imported.programId).flatMap((day) => getProgramExercises(day.id));
  assert.equal(importedExercises.length, 2);
  assert.equal(importedExercises[0].loadType, "external");
  assert.equal(importedExercises[0].weightMode, "kg");
  assert.equal(importedExercises[0].sourceWeight, "80 kg");
  assert.equal(importedExercises[0].targetWeight, null);
  assert.equal(importedExercises[0].draftMeta, undefined);
  assert.ok(getExerciseById("ai-cable-fly"), "proposed entry imported add-only");
  assert.equal(getExerciseById("bench-press").name, getExerciseById("bench-press").name);

  // ------------------------------------------------------------------
  // validateProgramDraft
  // ------------------------------------------------------------------
  const dayId = programDraft.days[0].id;
  const sectionId = programDraft.days[0].sections[0].id;
  assert.deepEqual(errorPaths(updateProgramMeta(programDraft, { name: "  " })), ["program.name"]);
  assert.ok(errorPaths(programDraft.days.reduce((draft, day) => removeDay(draft, day.id), programDraft)).includes("days"));

  const unmatched = addExercise(programDraft, dayId, sectionId, { name: "Mystery Machine" });
  const unmatchedErrors = validateProgramDraft(unmatched).errors;
  assert.equal(unmatchedErrors.length, 1);
  assert.match(unmatchedErrors[0].path, /exercises\[9\]\.exerciseId$/);
  assert.match(unmatchedErrors[0].message, /Mystery Machine/);

  const badTargets = updateExercise(programDraft, dayId, bench.id, {
    targetSets: 0,
    targetRPE: 11,
    targetReps: { min: 9, max: 3 },
    restTime: "soon",
    targetWeight: -1,
  });
  const badPaths = errorPaths(badTargets);
  ["targetSets", "targetRPE", "targetReps", "restTime", "targetWeight"].forEach((field) =>
    assert.ok(badPaths.some((path) => path.endsWith(`exercises[0].${field}`)), `${field} error reported`),
  );

  const dupId = {
    ...programDraft,
    days: programDraft.days.map((day, index) =>
      index === 1 ? { ...day, sections: [{ ...day.sections[0], exercises: [bench, ...day.sections[0].exercises] }] } : day,
    ),
  };
  assert.ok(errorPaths(dupId).some((path) => path === "days[1].sections[0].exercises[0].id"), "duplicate exercise ids");
  const dupDay = { ...programDraft, days: [...programDraft.days, programDraft.days[0]] };
  assert.ok(errorPaths(dupDay).some((path) => path.startsWith("days[5]")), "duplicate day ids");

  const badWarmup = { ...programDraft, days: programDraft.days.map((day, index) => (index === 0 ? { ...day, warmup: { items: [{ name: "" }] } } : day)) };
  assert.ok(errorPaths(badWarmup).includes("days[0].warmup.items[0]"));
  const badEnum = { ...programDraft, days: programDraft.days.map((day, index) => (index === 0 ? { ...day, sections: [{ ...day.sections[0], exercises: [{ ...bench, loadType: "lbs", weightMode: "stones" }, ...day.sections[0].exercises.slice(1)] }] } : day)) };
  const enumPaths = errorPaths(badEnum);
  assert.ok(enumPaths.includes("days[0].sections[0].exercises[0].loadType"));
  assert.ok(enumPaths.includes("days[0].sections[0].exercises[0].weightMode"));
  const newWithoutEntry = { ...programDraft, days: programDraft.days.map((day, index) => (index === 0 ? { ...day, sections: [{ ...day.sections[0], exercises: [{ ...bench, exerciseId: "brand-new", libraryStatus: "new", newLibraryExercise: null }, ...day.sections[0].exercises.slice(1)] }] } : day)) };
  assert.ok(errorPaths(newWithoutEntry).includes("days[0].sections[0].exercises[0].newLibraryExercise"));
  assert.equal(validateProgramDraft(null).valid, false);

  // ------------------------------------------------------------------
  // diffDraftAgainstProgram
  // ------------------------------------------------------------------
  const noChange = diffDraftAgainstProgram(programDraft);
  assert.equal(noChange.ok, true);
  assert.deepEqual(noChange.program, []);
  assert.deepEqual(noChange.days, { added: [], removed: [], renamed: [], changed: [] });
  assert.deepEqual(noChange.exercises, { added: [], removed: [], moved: [], changed: [] }, "an untouched legacy program shows no changes");
  assert.equal(diffDraftAgainstProgram(blank).ok, false);

  const secondExercise = programDraft.days[0].sections[0].exercises[1];
  let edited = updateProgramMeta(programDraft, { name: "Renamed" });
  edited = updateDayMeta(edited, dayId, { name: "Push A" });
  edited = addDay(edited, { name: "Extra" });
  edited = removeDay(edited, programDraft.days[4].id);
  edited = updateExercise(edited, dayId, bench.id, { targetSets: 5, notes: "pause" });
  edited = removeExercise(edited, dayId, secondExercise.id);
  edited = addExercise(edited, dayId, sectionId, { exerciseId: "bench-press", index: 0 });
  const lastId = programDraft.days[0].sections[0].exercises.at(-1).id;
  edited = moveExercise(edited, dayId, lastId, { index: 1 });
  const diff = diffDraftAgainstProgram(edited);
  assert.deepEqual(diff.program, [{ field: "name", from: programDraft.program.name, to: "Renamed" }]);
  assert.deepEqual(diff.days.renamed, [{ id: dayId, from: storedDays[0].name, to: "Push A" }]);
  assert.equal(diff.days.added.length, 1);
  assert.equal(diff.days.added[0].name, "Extra");
  assert.deepEqual(diff.days.removed.map((day) => day.id), [programDraft.days[4].id]);
  assert.equal(diff.exercises.added.length, 1);
  assert.equal(diff.exercises.added[0].name, "Bench Press");
  assert.deepEqual(diff.exercises.removed.map((exercise) => exercise.id).sort(), [
    ...getProgramExercises(programDraft.days[4].id).map((exercise) => exercise.id),
    secondExercise.id,
  ].sort());
  const benchChange = diff.exercises.changed.find((entry) => entry.id === bench.id);
  assert.deepEqual(
    benchChange.fields.map((entry) => [entry.field, entry.from, entry.to]),
    [
      ["targetSets", 4, 5],
      ["notes", "", "pause"],
    ],
  );
  assert.equal(benchChange.prescriptionChanged, true);
  const notesOnly = diffDraftAgainstProgram(updateExercise(programDraft, dayId, bench.id, { notes: "tempo" }));
  assert.equal(notesOnly.exercises.changed[0].prescriptionChanged, false, "notes are not a prescription");
  assert.ok(diff.exercises.moved.some((entry) => entry.id === lastId && entry.to.index === 1));

  // ------------------------------------------------------------------
  // Fix round 1: multi-section round trip, day-level diff, remap diff,
  // review notes on the draft
  // ------------------------------------------------------------------
  let multi = updateProgramMeta(createBlankProgramDraft(), { name: "Multi" });
  const multiDay = multi.days[0].id;
  multi = addExercise(multi, multiDay, multi.days[0].sections[0].id, { exerciseId: "bench-press" });
  multi = addSection(multi, multiDay, { name: "Finisher" });
  multi = addExercise(multi, multiDay, multi.days[0].sections[1].id, { exerciseId: "dips" });
  const multiBack = draftFromShare(draftToShare(multi));
  assert.equal(multiBack.ok, true, multiBack.error);
  assert.deepEqual(
    multiBack.draft.days[0].sections.map((section) => [section.name, section.exercises.map((exercise) => exercise.exerciseId)]),
    [
      ["Main Work", ["bench-press"]],
      ["Finisher", ["dips"]],
    ],
    "a draftToShare round trip keeps every section's exercises",
  );
  assert.deepEqual(
    multiBack.draft.days[0].sections.map((section) => section.id),
    multi.days[0].sections.map((section) => section.id),
    "section ids survive the round trip",
  );

  const dayEdited = updateWarmup(
    updateDayMeta(programDraft, dayId, { focus: "Changed focus", notes: "Injected note", isOptional: true }),
    dayId,
    { title: "Warm-up", items: [{ id: "w-x", name: "Invented jumping jacks", prescription: "5 min" }] },
  );
  const dayDiff = diffDraftAgainstProgram(dayEdited);
  assert.deepEqual(
    dayDiff.days.changed.map((day) => [day.id, day.fields.map((entry) => entry.field)]),
    [[dayId, ["focus", "notes", "isOptional", "warmup"]]],
    "warm-up, notes, focus and the optional flag of a day are part of the review diff",
  );
  const warmupField = dayDiff.days.changed[0].fields.find((entry) => entry.field === "warmup");
  assert.equal(warmupField.to.items[0].name, "Invented jumping jacks");
  assert.deepEqual(dayDiff.days.renamed, []);
  assert.deepEqual(diffDraftAgainstProgram(updateWarmup(programDraft, dayId, programDraft.days[0].warmup)).days.changed, [], "an unchanged warm-up is not a change");

  const remapped = remapExercise(programDraft, dayId, bench.id, "dips");
  const remapDiff = diffDraftAgainstProgram(remapped);
  assert.deepEqual(remapDiff.exercises.removed.map((exercise) => exercise.id), [bench.id], "a Library remap leaves the stored occurrence behind");
  assert.deepEqual(remapDiff.exercises.changed, []);
  assert.equal(remapDiff.exercises.added.length, 1);
  assert.deepEqual(remapDiff.exercises.added[0].replaces, { id: bench.id, name: "Bench Press" });

  const notedShare = {
    ...share,
    draftMeta: {
      ...share.draftMeta,
      changes: ["Day 1: added a fly.", "  ", "Day 1: added a fly."],
      removed: [{ refId: "x", name: "Old Row" }],
      uncertainty: ["Day 1: reps unclear."],
    },
  };
  const noted = draftFromShare(notedShare, { origin: "ai-import" }).draft;
  assert.deepEqual(
    noted.reviewNotes,
    { changes: ["Day 1: added a fly."], removed: ["Old Row"], uncertainty: ["Day 1: reps unclear."] },
    "the AI's review notes travel with the draft",
  );
  assert.equal(createBlankProgramDraft().reviewNotes, null);
  assert.equal(draftFromProgram(copy.programId).draft.reviewNotes, null);

  const summary = summarizeProgramDraft(unmatched);
  assert.equal(summary.dayCount, 5);
  assert.equal(summary.exerciseCount, 41);
  assert.equal(summary.unresolvedCount, 1);
  assert.equal(summarizeProgramDraft(aiDraft).newCount, 1);

  // ------------------------------------------------------------------
  // Fix round 2: validation refuses a "library" exercise whose id exists
  // only as a proposal of the draft (the writers add proposals for "new"
  // exercises only, so it would be saved with a dangling Library id).
  // ------------------------------------------------------------------
  const { getPrograms: listPrograms, saveProgramDraft: writeDraft } = await import("../src/lib/programStorage.js");
  const { addExercise: addDraftExercise, createBlankProgramDraft: blankDraft, updateProgramMeta: renameDraft, validateProgramDraft: validateDraft } =
    await import("../src/lib/programDraft.js");
  let mismatch = renameDraft(blankDraft(), { name: "Mismatch" });
  mismatch = addDraftExercise(mismatch, mismatch.days[0].id, mismatch.days[0].sections[0].id, { exerciseId: "bench-press" });
  const mismatchExercise = mismatch.days[0].sections[0].exercises[0];
  mismatch = {
    ...mismatch,
    libraryExercises: [{ id: "x-prop", name: "Prop", category: "compound", equipment: "machine", mainMuscles: ["chest"] }],
    days: [
      {
        ...mismatch.days[0],
        sections: [{ ...mismatch.days[0].sections[0], exercises: [{ ...mismatchExercise, exerciseId: "x-prop", name: "Prop", libraryStatus: "library" }] }],
      },
    ],
  };
  const mismatchValidation = validateDraft(mismatch);
  assert.equal(mismatchValidation.valid, false, "a Library exercise pointing at a proposal-only id is invalid");
  assert.ok(
    mismatchValidation.errors.some((entry) => entry.path.endsWith(".libraryStatus") && /not in the Library yet/.test(entry.message)),
    mismatchValidation.errors.map((entry) => entry.message).join(" | "),
  );
  const programCountBefore = listPrograms().length;
  const mismatchSave = writeDraft(mismatch);
  assert.equal(mismatchSave.ok, false, "the writer refuses it");
  assert.equal(mismatchSave.code, "invalid");
  assert.equal(listPrograms().length, programCountBefore, "no program was written");
  assert.equal(getExerciseById("x-prop"), null, "no dangling Library id reached storage");

  // ------------------------------------------------------------------
  // H2 gate (fix round 3): "Nothing becomes a saved program / Library entry
  // before approval". Every program key is snapshotted byte for byte; the
  // draft-only operations (blank draft, draftFromShare with a "new"
  // proposal, addExercise / proposeNewLibraryExercise / remapExercise) and
  // the optional saveDraftToStorage change nothing but the drafts key and
  // no proposal resolves in the Library; only saveProgramDraft (the
  // explicit Save) changes the program keys.
  // ------------------------------------------------------------------
  const { getTrackedStorageKeys, STORAGE_KEYS: KEYS } = await import("../src/lib/storage.js");
  const { deleteStoredDraft: dropStoredDraft, getExerciseLibrary: listLibrary, saveDraftToStorage: storeDraft } =
    await import("../src/lib/programStorage.js");
  const { proposeNewLibraryExercise: proposeEntry } = await import("../src/lib/programDraft.js");
  const memory = globalThis.window.localStorage.store;
  const programKeys = getTrackedStorageKeys().filter((key) => key !== KEYS.programDrafts);
  assert.ok(
    [KEYS.programs, KEYS.exerciseLibrary, KEYS.programExercises, KEYS.baselines, KEYS.programProgressions, KEYS.programDays, KEYS.programSections, KEYS.programStates].every(
      (key) => programKeys.includes(key),
    ),
    "the snapshot covers programs, Library, program exercises, baselines and progressions",
  );
  const snapshotProgramKeys = () => Object.fromEntries(programKeys.map((key) => [key, memory.get(key) ?? null]));
  const gateBefore = snapshotProgramKeys();
  const gateProgramCount = listPrograms().length;
  const gateLibraryCount = listLibrary().length;
  const draftsBefore = memory.get(KEYS.programDrafts) ?? null;

  // Manual Studio path: blank draft, Library pick, unknown movement proposed
  // as a new entry, a "new" init, and a remap to another Library entry.
  let gate = renameDraft(blankDraft(), { name: "Gate Program" });
  const gateDay = gate.days[0].id;
  const gateSection = gate.days[0].sections[0].id;
  gate = addDraftExercise(gate, gateDay, gateSection, { exerciseId: "bench-press" });
  gate = addDraftExercise(gate, gateDay, gateSection, { name: "Gate Sled Push" });
  const gateSledId = gate.days[0].sections[0].exercises[1].id;
  gate = proposeEntry(gate, gateDay, gateSledId, { category: "athletic", equipment: "sled" });
  gate = addDraftExercise(gate, gateDay, gateSection, {
    libraryStatus: "new",
    exerciseId: "draft-lib-gate-rope",
    name: "Gate Rope Slam",
    newLibraryExercise: { id: "draft-lib-gate-rope", name: "Gate Rope Slam", category: "athletic", equipment: "rope" },
  });
  const gateBenchId = gate.days[0].sections[0].exercises[0].id;
  gate = remapExercise(gate, gateDay, gateBenchId, "dips");
  const gateProposalIds = gate.libraryExercises.map((entry) => entry.id);
  assert.equal(gateProposalIds.length, 2, "two proposals registered on the draft");
  assert.ok(gateProposalIds.includes("draft-lib-gate-rope"));
  assert.deepEqual(
    gate.days[0].sections[0].exercises.map((exercise) => [exercise.libraryStatus, exercise.exerciseId]),
    [
      ["library", "dips"],
      ["new", gateProposalIds.find((id) => id !== "draft-lib-gate-rope")],
      ["new", "draft-lib-gate-rope"],
    ],
  );
  assert.equal(validateDraft(gate).valid, true, validateDraft(gate).errors.map((entry) => entry.message).join(" | "));

  // AI import path: a share whose exercise proposes a "new" Library entry
  // (a fresh id: "ai-cable-fly" was approved by an earlier block).
  const gateAiShare = {
    ...aiShare,
    program: { ...aiShare.program, name: "AI Gate Upper" },
    programExercises: aiShare.programExercises.map((exercise) =>
      exercise.exerciseId === "ai-cable-fly" ? { ...exercise, id: "ai-generated:ai-day-1:2-ai-gate-landmine", exerciseId: "ai-gate-landmine" } : exercise,
    ),
    libraryExercises: [{ id: "ai-gate-landmine", name: "Gate Landmine Press", category: "compound", equipment: "barbell" }],
    draftMeta: { provenance: {} },
  };
  assert.equal(getExerciseById("ai-gate-landmine"), null);
  const gateShare = draftFromShare(gateAiShare, { origin: "ai-import" });
  assert.equal(gateShare.ok, true, gateShare.error);
  assert.equal(gateShare.draft.days[0].sections[1].exercises[0].libraryStatus, "new");
  assert.deepEqual(gateShare.draft.libraryExercises.map((entry) => entry.id), ["ai-gate-landmine"]);

  // Optional saved drafts (H2-3): the drafts key only.
  assert.equal(storeDraft(gate).ok, true);
  assert.equal(storeDraft(gateShare.draft).ok, true);

  const allProposalIds = [...gateProposalIds, "ai-gate-landmine"];
  allProposalIds.forEach((id) => {
    assert.equal(getExerciseById(id), null, `proposal ${id} is not in the Library before approval`);
  });
  ["Gate Sled Push", "Gate Rope Slam", "Gate Landmine Press"].forEach((name) => {
    assert.equal(listLibrary().some((entry) => entry.name === name), false, `no Library entry "${name}" before approval`);
  });
  assert.equal(listPrograms().length, gateProgramCount, "no program before approval");
  assert.equal(listPrograms().some((program) => ["Gate Program", "AI Gate Upper"].includes(program.name)), false);
  assert.equal(listLibrary().length, gateLibraryCount);
  assert.deepEqual(snapshotProgramKeys(), gateBefore, "every program key is byte-identical after the draft-only operations");
  const draftsAfter = memory.get(KEYS.programDrafts);
  assert.notEqual(draftsAfter, draftsBefore, "only the drafts key changed");
  assert.ok(draftsAfter.includes(gate.draftId) && draftsAfter.includes(gateShare.draft.draftId));

  // Approval: saveProgramDraft is what changes the program keys.
  const gateSaved = writeDraft(gate);
  assert.equal(gateSaved.ok, true, gateSaved.error);
  const gateAfter = snapshotProgramKeys();
  const changedKeys = programKeys.filter((key) => gateAfter[key] !== gateBefore[key]).sort();
  assert.deepEqual(
    changedKeys,
    [KEYS.exerciseLibrary, KEYS.programDays, KEYS.programExercises, KEYS.programSections, KEYS.programStates, KEYS.programs].sort(),
    "Save writes the program, its days / sections / exercises, the approved Library entries and the program state",
  );
  assert.equal(gateAfter[KEYS.baselines], gateBefore[KEYS.baselines], "no baseline rows from a draft save");
  assert.equal(gateAfter[KEYS.programProgressions], gateBefore[KEYS.programProgressions], "no progression rows from a draft save");
  assert.equal(gateAfter[KEYS.activeProgramId], gateBefore[KEYS.activeProgramId], "saving never activates");
  assert.equal(listPrograms().length, gateProgramCount + 1);
  gateProposalIds.forEach((id) => {
    assert.ok(getExerciseById(id), `approved proposal ${id} is in the Library after Save`);
  });
  assert.equal(getExerciseById("ai-gate-landmine"), null, "the other draft's proposal is still not in the Library");
  assert.equal(listLibrary().length, gateLibraryCount + 2);
  assert.equal(dropStoredDraft(gate.draftId).ok, true);
  assert.equal(dropStoredDraft(gateShare.draft.draftId).ok, true);

  console.log("verify-program-h2-draft: ok");
} catch (error) {
  console.error("verify-program-h2-draft: FAIL");
  console.error(error);
  process.exit(1);
}
