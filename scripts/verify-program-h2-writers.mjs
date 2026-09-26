// Phase H2 Track A: draft operations (src/lib/programDraft.js) return a NEW
// draft and never mutate the input; unknown targets return the same object.
// Covers days, sections, exercises (within / across sections), warm-up,
// updateExercise provenance, remapExercise and proposeNewLibraryExercise.
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

const { getExerciseById, seedDefaultProgramIfNeeded } = await import("../src/lib/programStorage.js");
const {
  addDay,
  addExercise,
  addSection,
  createBlankProgramDraft,
  createDraftLibraryExercise,
  moveDay,
  moveExercise,
  moveSection,
  proposeNewLibraryExercise,
  remapExercise,
  removeDay,
  removeExercise,
  removeSection,
  updateDayMeta,
  updateExercise,
  updateProgramMeta,
  updateSectionMeta,
  updateWarmup,
  validateProgramDraft,
} = await import("../src/lib/programDraft.js");

const frozen = (draft) => JSON.stringify(draft);
const exerciseIds = (section) => section.exercises.map((exercise) => exercise.id);

try {
  seedDefaultProgramIfNeeded();

  let draft = updateProgramMeta(createBlankProgramDraft(), { name: "Studio", goal: "strength" });
  const original = draft;
  const snapshot = frozen(draft);
  assert.equal(draft.program.goal, "strength");
  assert.equal(updateProgramMeta(draft, { name: "Studio" }), draft, "no-op returns the same draft");

  // ------------------------------------------------------------------
  // Days
  // ------------------------------------------------------------------
  const dayOne = draft.days[0];
  draft = addDay(draft, { name: "Pull", focus: "Back", isOptional: true });
  assert.equal(draft.days.length, 2);
  assert.equal(draft.days[1].name, "Pull");
  assert.equal(draft.days[1].isOptional, true);
  assert.ok(draft.days[1].id.startsWith("draft-day-"));
  assert.equal(draft.days[1].sections.length, 1, "a new day has one section");
  draft = addDay(draft, { index: 0 });
  assert.equal(draft.days[0].name, "Day 3", "default name from the day count, inserted at index 0");
  const inserted = draft.days[0];
  draft = moveDay(draft, inserted.id, 2);
  assert.deepEqual(draft.days.map((day) => day.id), [dayOne.id, draft.days[1].id, inserted.id]);
  assert.equal(moveDay(draft, "nope", 0), draft);
  draft = updateDayMeta(draft, inserted.id, { name: "Legs", notes: "  heavy  ", isOptional: true });
  assert.equal(draft.days[2].name, "Legs");
  assert.equal(draft.days[2].notes, "heavy");
  assert.equal(draft.days[2].isOptional, true);
  assert.equal(updateDayMeta(draft, inserted.id, { name: "Legs" }), draft);
  draft = removeDay(draft, inserted.id);
  assert.equal(draft.days.length, 2);
  assert.equal(removeDay(draft, inserted.id), draft);

  // ------------------------------------------------------------------
  // Warm-up stays informational
  // ------------------------------------------------------------------
  draft = updateWarmup(draft, dayOne.id, {
    title: "",
    items: [
      { id: "", name: "Bike", prescription: "5 min", notes: "", videoUrl: "" },
      { name: "", prescription: "" },
      { name: "Band pull-aparts", prescription: "2 x 15", video_url: "https://v" },
    ],
  });
  assert.equal(draft.days[0].warmup.title, "Warm-up & Activation");
  assert.deepEqual(
    draft.days[0].warmup.items.map((item) => [item.id, item.name, item.videoUrl]),
    [
      ["warmup-1", "Bike", ""],
      ["warmup-3", "Band pull-aparts", "https://v"],
    ],
  );
  assert.deepEqual(exerciseIds(draft.days[0].sections[0]), [], "warm-up items never become exercises");
  assert.equal(updateWarmup(draft, dayOne.id, draft.days[0].warmup), draft);
  assert.equal(updateWarmup(draft, dayOne.id, { items: [] }).days[0].warmup, null, "empty warm-up clears it");
  assert.equal(updateWarmup(draft, dayOne.id, null).days[0].warmup, null);

  // ------------------------------------------------------------------
  // Sections
  // ------------------------------------------------------------------
  const mainSection = draft.days[0].sections[0];
  draft = addSection(draft, dayOne.id, { name: "Accessories" });
  draft = addSection(draft, dayOne.id, { index: 0 });
  assert.deepEqual(
    draft.days[0].sections.map((section) => section.name),
    ["Section 3", "Main Work", "Accessories"],
  );
  const firstSection = draft.days[0].sections[0];
  draft = moveSection(draft, dayOne.id, firstSection.id, 5);
  assert.equal(draft.days[0].sections.at(-1).id, firstSection.id, "index is clamped");
  draft = updateSectionMeta(draft, dayOne.id, firstSection.id, { name: "Finisher" });
  assert.equal(draft.days[0].sections.at(-1).name, "Finisher");
  assert.equal(updateSectionMeta(draft, dayOne.id, firstSection.id, { name: "" }), draft, "empty name keeps the old one");
  const accessories = draft.days[0].sections[1];

  // ------------------------------------------------------------------
  // Exercises
  // ------------------------------------------------------------------
  draft = addExercise(draft, dayOne.id, mainSection.id, { exerciseId: "bench-press", targetSets: 5 });
  draft = addExercise(draft, dayOne.id, mainSection.id, { exerciseId: "weighted-pull-ups" });
  draft = addExercise(draft, dayOne.id, mainSection.id, { name: "Sled Push", targetReps: { label: "20 m" } });
  const [benchEx, pullEx, sledEx] = draft.days[0].sections[0].exercises;
  assert.equal(benchEx.libraryStatus, "library");
  assert.equal(benchEx.name, getExerciseById("bench-press").name);
  assert.equal(benchEx.targetSets, 5);
  assert.equal(benchEx.provenance.targetSets, "edited");
  assert.equal(benchEx.provenance.targetReps, "default");
  assert.deepEqual(benchEx.targetReps, { min: 8, max: 12, label: null });
  assert.equal(benchEx.targetRPE, 8);
  assert.equal(benchEx.restTime, 120);
  assert.equal(pullEx.loadType, "optionalExternal", "profile from the built-in config");
  assert.equal(pullEx.weightMode, "additional load");
  assert.equal(sledEx.libraryStatus, "unmatched");
  assert.equal(sledEx.exerciseId, null);
  assert.equal(sledEx.name, "Sled Push");
  assert.deepEqual(sledEx.targetReps, { min: null, max: null, label: "20 m" });
  assert.ok(sledEx.id.startsWith("draft-exercise-"));
  assert.equal(addExercise(draft, dayOne.id, "missing-section", { exerciseId: "bench-press" }), draft);
  assert.equal(addExercise(draft, "missing-day", mainSection.id, { exerciseId: "bench-press" }), draft);

  draft = addExercise(draft, dayOne.id, mainSection.id, { exerciseId: "bench-press", index: 0 });
  assert.equal(draft.days[0].sections[0].exercises[0].exerciseId, "bench-press");
  assert.notEqual(draft.days[0].sections[0].exercises[0].id, benchEx.id, "second occurrence has its own id");
  const secondBench = draft.days[0].sections[0].exercises[0];
  draft = removeExercise(draft, dayOne.id, secondBench.id);
  assert.deepEqual(exerciseIds(draft.days[0].sections[0]), [benchEx.id, pullEx.id, sledEx.id]);
  assert.equal(removeExercise(draft, dayOne.id, secondBench.id), draft);

  // move within the section
  draft = moveExercise(draft, dayOne.id, sledEx.id, 0);
  assert.deepEqual(exerciseIds(draft.days[0].sections[0]), [sledEx.id, benchEx.id, pullEx.id]);
  draft = moveExercise(draft, dayOne.id, sledEx.id, { index: 99 });
  assert.deepEqual(exerciseIds(draft.days[0].sections[0]), [benchEx.id, pullEx.id, sledEx.id]);
  // move across sections of the same day
  draft = moveExercise(draft, dayOne.id, pullEx.id, { sectionId: accessories.id, index: 0 });
  assert.deepEqual(exerciseIds(draft.days[0].sections[0]), [benchEx.id, sledEx.id]);
  assert.deepEqual(exerciseIds(draft.days[0].sections[1]), [pullEx.id]);
  assert.equal(draft.days[0].sections[1].exercises[0], pullEx, "the moved exercise keeps its identity");
  draft = moveExercise(draft, dayOne.id, sledEx.id, { sectionId: accessories.id });
  assert.deepEqual(exerciseIds(draft.days[0].sections[1]), [pullEx.id, sledEx.id]);
  assert.equal(moveExercise(draft, dayOne.id, sledEx.id, { sectionId: "nope" }), draft);
  assert.equal(moveExercise(draft, draft.days[1].id, sledEx.id, 0), draft, "exercises do not move across days");

  // ------------------------------------------------------------------
  // updateExercise: provenance "edited" only for changed fields
  // ------------------------------------------------------------------
  const before = draft.days[0].sections[0].exercises[0];
  draft = updateExercise(draft, dayOne.id, benchEx.id, {
    targetReps: { min: 3, max: 5 },
    targetWeight: "BW",
    restTime: [120, 180],
    targetRPE: "8.5",
    notes: "paused",
    isOptional: true,
    weightMode: "per dumbbell",
    sourceWeight: "100 kg",
    targetSets: 5,
    name: "Renamed Bench",
  });
  const after = draft.days[0].sections[0].exercises[0];
  assert.deepEqual(after.targetReps, { min: 3, max: 5, label: null });
  assert.equal(after.targetWeight, "BW");
  assert.deepEqual(after.restTime, [120, 180]);
  assert.equal(after.targetRPE, 8.5);
  assert.equal(after.notes, "paused");
  assert.equal(after.isOptional, true);
  assert.equal(after.weightMode, "per dumbbell");
  assert.equal(after.sourceWeight, "100 kg");
  assert.equal(after.targetWeight, "BW", "H2-4: source weight never overwrites the target");
  assert.equal(after.name, before.name, "a Library exercise keeps the Library name");
  assert.equal(after.exerciseId, before.exerciseId, "exerciseId is not patched here");
  ["targetReps", "targetWeight", "restTime", "targetRPE", "notes", "isOptional", "weightMode", "sourceWeight"].forEach(
    (field) => assert.equal(after.provenance[field], "edited", `${field} edited`),
  );
  assert.equal(after.provenance.targetSets, "edited", "same value as before (5) stays edited from addExercise");
  assert.equal(after.provenance.loadType, "default", "untouched field keeps its label");
  assert.equal(after.provenance.type, "default");
  assert.equal(updateExercise(draft, dayOne.id, benchEx.id, { targetSets: 5 }), draft, "unchanged value is a no-op");
  assert.equal(updateExercise(draft, dayOne.id, "nope", { targetSets: 1 }), draft);
  const cleared = updateExercise(draft, dayOne.id, benchEx.id, { targetSets: "many", loadType: "lbs" });
  assert.equal(cleared.days[0].sections[0].exercises[0].targetSets, null, "unusable number becomes null");
  assert.equal(cleared.days[0].sections[0].exercises[0].loadType, "external", "invalid enum keeps the current value");
  assert.equal(validateProgramDraft(cleared).valid, false);
  const unmatchedRename = updateExercise(draft, dayOne.id, sledEx.id, { name: "Prowler Push" });
  assert.equal(unmatchedRename.days[0].sections[1].exercises[1].name, "Prowler Push", "unmatched names are editable");

  // ------------------------------------------------------------------
  // remapExercise / proposeNewLibraryExercise
  // ------------------------------------------------------------------
  assert.equal(validateProgramDraft(draft).valid, false, "the unmatched sled push blocks saving");
  draft = remapExercise(draft, dayOne.id, sledEx.id, "hanging-leg-raise");
  let sled = draft.days[0].sections[1].exercises[1];
  assert.equal(sled.libraryStatus, "library");
  assert.equal(sled.exerciseId, "hanging-leg-raise");
  assert.equal(sled.name, getExerciseById("hanging-leg-raise").name);
  assert.equal(sled.loadType, "bodyweight", "profile re-derived from the new entry");
  assert.equal(sled.provenance.exerciseId, "edited");
  assert.equal(sled.provenance.name, "source");
  assert.equal(validateProgramDraft(draft).valid, true);
  assert.equal(remapExercise(draft, dayOne.id, sledEx.id, "no-such-library-id"), draft, "unknown ids are refused");

  draft = remapExercise(draft, dayOne.id, sledEx.id, null);
  sled = draft.days[0].sections[1].exercises[1];
  assert.equal(sled.libraryStatus, "unmatched");
  assert.equal(sled.exerciseId, null);
  assert.equal(sled.name, getExerciseById("hanging-leg-raise").name, "the name stays for the user to re-map");

  draft = proposeNewLibraryExercise(draft, dayOne.id, sledEx.id, {
    name: "Sled Push",
    category: "athletic",
    equipment: "sled",
    mainMuscles: ["quads", "glutes"],
    rawUpload: "not-a-library-field",
  });
  sled = draft.days[0].sections[1].exercises[1];
  assert.equal(sled.libraryStatus, "new");
  assert.equal(sled.name, "Sled Push");
  assert.ok(sled.exerciseId.startsWith("draft-lib-sled-push-"));
  assert.equal(sled.newLibraryExercise.id, sled.exerciseId);
  assert.equal(sled.newLibraryExercise.rawUpload, undefined, "whitelist copy");
  assert.deepEqual(draft.libraryExercises.map((entry) => entry.id), [sled.exerciseId]);
  assert.deepEqual(draft.libraryExercises[0].mainMuscles, ["quads", "glutes"]);
  assert.equal(draft.libraryExercises[0].whatYouShouldFeel, "quads, glutes");
  assert.equal(validateProgramDraft(draft).valid, true);

  const renamedNew = updateExercise(draft, dayOne.id, sledEx.id, { name: "Prowler" });
  assert.equal(renamedNew.libraryExercises[0].name, "Prowler", "renaming a new exercise renames its proposal");
  assert.equal(renamedNew.days[0].sections[1].exercises[1].newLibraryExercise.name, "Prowler");

  const remappedAway = remapExercise(draft, dayOne.id, sledEx.id, "bench-press");
  assert.deepEqual(remappedAway.libraryExercises, [], "an unreferenced proposal is pruned");
  assert.equal(remappedAway.days[0].sections[1].exercises[1].newLibraryExercise, null);

  // A "new" exercise added with its own proposal keeps draft.libraryExercises in step.
  const proposal = createDraftLibraryExercise({ name: "Nordic Curl", category: "isolation", equipment: "bodyweight" });
  const withProposal = addExercise(draft, dayOne.id, mainSection.id, {
    libraryStatus: "new",
    exerciseId: proposal.id,
    newLibraryExercise: proposal,
  });
  assert.equal(withProposal.days[0].sections[0].exercises.at(-1).libraryStatus, "new");
  assert.deepEqual(withProposal.libraryExercises.map((entry) => entry.id), [sled.exerciseId, proposal.id]);
  assert.equal(validateProgramDraft(withProposal).valid, true);

  // ------------------------------------------------------------------
  // removeSection drops its exercises; the original draft never changed
  // ------------------------------------------------------------------
  const withoutAccessories = removeSection(draft, dayOne.id, accessories.id);
  assert.equal(withoutAccessories.days[0].sections.length, 2);
  assert.equal(
    withoutAccessories.days[0].sections.some((section) => section.id === accessories.id),
    false,
  );
  assert.equal(removeSection(draft, dayOne.id, "nope"), draft);
  assert.ok(draft.updatedAt >= draft.createdAt);
  assert.equal(frozen(original), snapshot, "the very first draft object was never mutated by the operations above");

  console.log("verify-program-h2-writers: ok");
} catch (error) {
  console.error("verify-program-h2-writers: FAIL");
  console.error(error);
  process.exit(1);
}
