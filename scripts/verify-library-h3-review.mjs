// H3 fix round 1, AI technique notes in the Library (decision H3-9):
// - accepted notes are stored as "- bullet" text and SHOWN as the same bullet
//   list as a seeded entry (getTechniqueBullets is what the Library detail
//   and the workout info panel render)
// - the entry carries the AI badge in the Library until the owner marks it as
//   reviewed; the review is one checked write that changes nothing else
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failWrites = false;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failWrites) {
      const error = new Error("The quota has been exceeded.");
      error.name = "QuotaExceededError";
      throw error;
    }

    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

globalThis.window = { localStorage: new MemoryLocalStorage() };
const savedWarn = console.warn;
console.warn = () => {};

const { STORAGE_KEYS, createLocalBackup } = await import("../src/lib/storage.js");
const { convertAiProgramToShare, getLibraryCatalog } = await import("../src/lib/aiProgram.js");
const { AI_GENERATED_TAG, applyTechniqueDraft, TECHNIQUE_DRAFT_TAG: TAG_FROM_TECHNIQUE, validateTechniqueDraft } = await import(
  "../src/lib/aiTechnique.js"
);
const { acceptTechniqueDraftIntoShare, isAiTechniqueEntry, TECHNIQUE_DRAFT_BADGE: BADGE_FROM_ASSISTANT } = await import(
  "../src/lib/importAssistant.js"
);
const { draftFromShare } = await import("../src/lib/programDraft.js");
const { exportProgramShare, getExerciseById, getExerciseLibrary, getProgramDayViewModels, saveProgramDraft, seedDefaultProgramIfNeeded } =
  await import("../src/lib/programStorage.js");
const {
  getTechniqueBullets,
  getVisibleGoalTags,
  isAiTechniqueDraftEntry,
  markLibraryTechniqueReviewed,
  TECHNIQUE_DRAFT_BADGE,
  TECHNIQUE_DRAFT_TAG,
} = await import("../src/lib/libraryReview.js");

seedDefaultProgramIfNeeded();

assert.equal(TAG_FROM_TECHNIQUE, TECHNIQUE_DRAFT_TAG, "one tag");
assert.equal(TECHNIQUE_DRAFT_TAG, "technique-ai-draft");
assert.equal(BADGE_FROM_ASSISTANT, TECHNIQUE_DRAFT_BADGE, "one badge text");
assert.equal(TECHNIQUE_DRAFT_BADGE, "AI draft, review before relying on it");

// ---------------------------------------------------------------------------
// 1. getTechniqueBullets: a list and "- bullet" text are the same list
// ---------------------------------------------------------------------------
assert.deepEqual(getTechniqueBullets(["a", " b ", "", null, "c"]), ["a", "b", "c"]);
assert.deepEqual(getTechniqueBullets("- a\n- b\n- c"), ["a", "b", "c"]);
assert.deepEqual(getTechniqueBullets("- a\r\n-  b  \r\n\r\n- c\n"), ["a", "b", "c"]);
assert.deepEqual(getTechniqueBullets("• a\n* b\n– c"), ["a", "b", "c"]);
assert.deepEqual(getTechniqueBullets("- only one"), ["only one"]);
assert.deepEqual(getTechniqueBullets("- hip-hinge, not a squat\n- semi-stiff"), ["hip-hinge, not a squat", "semi-stiff"]);
// Plain text stays a paragraph.
assert.equal(getTechniqueBullets("Keep ribs down and brace before each rep."), null);
assert.equal(getTechniqueBullets("Chest, Triceps"), null);
assert.equal(getTechniqueBullets("-5 degrees of incline"), null, "a minus sign is not a bullet");
assert.equal(getTechniqueBullets("- a\nand a sentence"), null, "mixed text is not rewritten");
assert.equal(getTechniqueBullets(""), null);
assert.equal(getTechniqueBullets("   "), null);
assert.equal(getTechniqueBullets("-"), null);
assert.equal(getTechniqueBullets([]), null);
assert.equal(getTechniqueBullets(null), null);
assert.equal(getTechniqueBullets(undefined), null);
assert.equal(getTechniqueBullets(7), null);

assert.deepEqual(getVisibleGoalTags(["strength", TECHNIQUE_DRAFT_TAG, AI_GENERATED_TAG]), ["strength", AI_GENERATED_TAG]);
assert.deepEqual(getVisibleGoalTags(null), []);

// ---------------------------------------------------------------------------
// 2. An accepted draft, saved with its program, as the Library shows it
// ---------------------------------------------------------------------------
const extraction = convertAiProgramToShare(
  {
    name: "Imported plan",
    days: [
      {
        name: "Day 1",
        exercises: [
          { exerciseId: "", name: "Snatch-Grip Romanian Deadlift", isNew: true, category: "compound", equipment: "barbell", mainMuscles: ["Hamstrings", "Glutes"], sets: 3, repsMin: 8, repsMax: 10, targetRPE: 8, restSeconds: 120, progressionType: "hypertrophy" },
          { exerciseId: "", name: "Cable Face Pull Variation", isNew: true, category: "isolation", equipment: "cable", mainMuscles: ["Rear delts"], sets: 3, repsMin: 12, repsMax: 15, targetRPE: 8, restSeconds: 60, progressionType: "pump" },
        ],
      },
    ],
  },
  getLibraryCatalog(),
  "2026-09-29T00:00:00.000Z",
);
assert.equal(extraction.valid, true, extraction.error);
const [noted, plain] = extraction.share.libraryExercises;
const techniqueDraft = {
  id: noted.id,
  name: noted.name,
  mainCue: "Hips back, chest long, bar close.",
  setup: "- picioarele la lățimea șoldurilor, sub bară\n- prinde bara lat\n- abdomenul încordat",
  howToDoIt: [
    "împinge șoldurile înapoi cu genunchii ușor flexați",
    "coboară bara aproape de picioare, cu spatele neutru",
    "oprește când simți întinderea în hamstrings",
    "revino împingând șoldurile în față",
  ],
  executionTips: ["ține bara lipită de coapse", "gâtul neutru"],
  commonMistakes: ["spate rotunjit", "bară departe de corp"],
  whatYouShouldFeel: "- hamstrings și fesieri întinși\n- lower back stabil",
  whyItsThere: "- construiește lanțul posterior",
  progressionRegression: "- mai ușor: dumbbell romanian deadlift",
  safetyNotes: "- oprește dacă simți durere ascuțită în spate",
  aiGenerated: true,
};
assert.deepEqual(validateTechniqueDraft(techniqueDraft), { valid: true, errors: [] });

const accepted = acceptTechniqueDraftIntoShare(extraction.share, techniqueDraft);
assert.equal(accepted.ok, true, accepted.error);
const programDraft = draftFromShare(accepted.share, { origin: "ai-import" });
assert.equal(programDraft.ok, true, programDraft.error);
const saved = saveProgramDraft(programDraft.draft);
assert.equal(saved.ok, true, saved.error);

const stored = getExerciseById(noted.id);
assert.ok(stored, "the new entry is in the Library");
assert.equal(typeof stored.howToDoIt, "string", "technique text is stored as '- bullet' lines (H3-4)");
assert.equal(isAiTechniqueDraftEntry(stored), true, "the Library entry carries the AI marker");
assert.equal(isAiTechniqueEntry(stored), true);

// What the Library detail and the workout info panel render: bullet lists,
// the same items a seeded entry with array fields would give.
const expectedBullets = {
  setup: ["picioarele la lățimea șoldurilor, sub bară", "prinde bara lat", "abdomenul încordat"],
  howToDoIt: techniqueDraft.howToDoIt,
  executionTips: techniqueDraft.executionTips,
  commonMistakes: techniqueDraft.commonMistakes,
  whatYouShouldFeel: ["hamstrings și fesieri întinși", "lower back stabil"],
  whyItsThere: ["construiește lanțul posterior"],
  progressionRegression: ["mai ușor: dumbbell romanian deadlift"],
  safetyNotes: ["oprește dacă simți durere ascuțită în spate"],
};

for (const [field, bullets] of Object.entries(expectedBullets)) {
  assert.deepEqual(getTechniqueBullets(stored[field]), bullets, `${field} is shown as ${bullets.length} bullets`);
  assert.ok(getTechniqueBullets(stored[field]).every((item) => !item.startsWith("-") && !item.includes("\n")), `${field}: no inline hyphens, no run-on line`);
}
assert.equal(getTechniqueBullets(stored.mainCue), null, "the main cue stays one sentence");
assert.equal(stored.mainCue, techniqueDraft.mainCue);

// A seeded entry (array fields) is rendered by the same function.
const seeded = getExerciseLibrary().find((entry) => Array.isArray(entry.howToDoIt) && entry.howToDoIt.length > 1);
assert.ok(seeded, "a seeded entry with list fields exists");
assert.deepEqual(getTechniqueBullets(seeded.howToDoIt), seeded.howToDoIt.map((item) => String(item).trim()));
assert.equal(isAiTechniqueDraftEntry(seeded), false);

// The entry without notes has no marker and nothing to show.
const storedPlain = getExerciseById(plain.id);
assert.equal(isAiTechniqueDraftEntry(storedPlain), false);
assert.equal(getTechniqueBullets(storedPlain.howToDoIt), null);
assert.equal(getTechniqueBullets(storedPlain.whatYouShouldFeel), null, "the muscle list placeholder is plain text");

// The workout info panel gets the marker with the exercise.
const viewModels = getProgramDayViewModels(saved.program.id);
const workoutExercise = viewModels
  .flatMap((day) => day.exercises)
  .find((exercise) => exercise.libraryExerciseId === noted.id);
assert.ok(workoutExercise, "the exercise is in the workout view model");
assert.equal(isAiTechniqueDraftEntry(workoutExercise), true, "the workout info panel can show the badge");

// ---------------------------------------------------------------------------
// 3. The review
// ---------------------------------------------------------------------------
const snapshot = () => new Map(window.localStorage.store);
const libraryOf = (store) => JSON.parse(store.get(STORAGE_KEYS.exerciseLibrary));

// A failed write: nothing changes and the result says so.
{
  const before = snapshot();
  window.localStorage.failWrites = true;
  const failed = markLibraryTechniqueReviewed(noted.id);
  window.localStorage.failWrites = false;
  assert.equal(failed.ok, false);
  assert.ok(typeof failed.error === "string" && failed.error.length > 0);
  assert.ok(!("entry" in failed));
  assert.equal(window.localStorage.store.get(STORAGE_KEYS.exerciseLibrary), before.get(STORAGE_KEYS.exerciseLibrary));
  assert.equal(isAiTechniqueDraftEntry(getExerciseById(noted.id)), true, "the badge stays");
}

// Unknown ids, entries without the marker.
assert.deepEqual(markLibraryTechniqueReviewed("no-such-id"), { ok: false, error: "This exercise is not in the Library." });
assert.equal(markLibraryTechniqueReviewed("").ok, false);
assert.equal(markLibraryTechniqueReviewed(null).ok, false);
{
  const before = snapshot();
  const untouched = markLibraryTechniqueReviewed(seeded.id);
  assert.equal(untouched.ok, true);
  assert.equal(untouched.changed, false);
  const plainResult = markLibraryTechniqueReviewed(plain.id);
  assert.equal(plainResult.changed, false);
  assert.deepEqual([...snapshot()], [...before], "nothing is written for an entry without the marker");
}

// The review itself.
{
  const before = snapshot();
  const reviewed = markLibraryTechniqueReviewed(noted.id);
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.equal(reviewed.changed, true);
  const after = snapshot();

  for (const [key, value] of before) {
    if (key !== STORAGE_KEYS.exerciseLibrary) {
      assert.equal(after.get(key), value, `${key} is unchanged`);
    }
  }
  assert.equal(after.size, before.size);

  const libraryBefore = libraryOf(before);
  const libraryAfter = libraryOf(after);
  assert.equal(libraryAfter.length, libraryBefore.length);
  libraryAfter.forEach((entry, index) => {
    if (entry.id !== noted.id) {
      assert.deepEqual(entry, libraryBefore[index], `entry ${entry.id} is untouched`);
      return;
    }

    const { goalTags, reviewedByUser, ...rest } = entry;
    const { goalTags: tagsBefore, reviewedByUser: reviewedBefore, ...restBefore } = libraryBefore[index];
    assert.deepEqual(rest, restBefore, "the notes and every other field are as they were");
    assert.deepEqual(goalTags, tagsBefore.filter((tag) => tag !== TECHNIQUE_DRAFT_TAG));
    assert.ok(goalTags.includes(AI_GENERATED_TAG), "the entry is still known to come from an import");
    assert.equal(reviewedByUser, true);
    assert.notEqual(reviewedBefore, true);
  });

  const now = getExerciseById(noted.id);
  assert.equal(isAiTechniqueDraftEntry(now), false, "the badge is gone");
  assert.deepEqual(getTechniqueBullets(now.howToDoIt), techniqueDraft.howToDoIt);
  assert.deepEqual(markLibraryTechniqueReviewed(noted.id).changed, false, "a second review writes nothing");
  assert.deepEqual([...snapshot()], [...after]);

  // Backups and share files carry the reviewed entry like any other.
  const backup = JSON.stringify(createLocalBackup());
  assert.ok(!backup.includes(TECHNIQUE_DRAFT_TAG));
  const share = exportProgramShare(saved.program.id);
  assert.ok(share.libraryExercises.some((entry) => entry.id === noted.id));
  assert.ok(!JSON.stringify(share).includes(TECHNIQUE_DRAFT_TAG));
}

// applyTechniqueDraft never writes the Library and never touches a stored entry.
assert.throws(() => applyTechniqueDraft(getExerciseById(noted.id), techniqueDraft, { libraryIds: [noted.id] }), /./);

console.warn = savedWarn;
console.log("verify-library-h3-review: ok");
