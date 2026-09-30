// H3 fix round 3, decision H3-21: the `reviewedByUser: false` that an accepted
// AI technique draft sets reaches the stored draft and the Library.
// - the draft whitelist (normalizeDraftLibraryEntry) keeps the flag only when
//   it is the boolean `false`; a draft or a share file can never claim that
//   the owner reviewed an entry
// - entries without the flag do not gain one
// - the review in the Library turns it into `true`
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

const { STORAGE_KEYS } = await import("../src/lib/storage.js");
const { convertAiProgramToShare, getLibraryCatalog } = await import("../src/lib/aiProgram.js");
const { applyTechniqueDraft, TECHNIQUE_DRAFT_TAG } = await import("../src/lib/aiTechnique.js");
const { acceptTechniqueDraftIntoShare, applyTechniqueForm } = await import("../src/lib/importAssistant.js");
const { draftFromShare, normalizeDraftLibraryEntry } = await import("../src/lib/programDraft.js");
const { exportProgramShare, getExerciseById, loadStoredDraft, saveDraftToStorage, saveProgramDraft, seedDefaultProgramIfNeeded } =
  await import("../src/lib/programStorage.js");
const { isAiTechniqueDraftEntry, markLibraryTechniqueReviewed } = await import("../src/lib/libraryReview.js");

seedDefaultProgramIfNeeded();

// ---------------------------------------------------------------------------
// 1. The whitelist
// ---------------------------------------------------------------------------
const base = { id: "probe-entry", name: "Probe Entry", goalTags: ["ai-generated"] };
assert.equal(normalizeDraftLibraryEntry({ ...base, reviewedByUser: false }).reviewedByUser, false);
for (const value of [true, "false", 0, null, undefined, "", "true", 1, {}, []]) {
  assert.ok(
    !("reviewedByUser" in normalizeDraftLibraryEntry({ ...base, reviewedByUser: value })),
    `reviewedByUser: ${JSON.stringify(value)} is not kept`,
  );
}
assert.ok(!("reviewedByUser" in normalizeDraftLibraryEntry(base)), "an entry without the flag gains none");
// Nothing else passes the whitelist because of this.
assert.deepEqual(
  Object.keys(normalizeDraftLibraryEntry({ ...base, reviewedByUser: false, apiKey: "x", sourceText: "y", reviewed: false })).sort(),
  ["goalTags", "id", "name", "reviewedByUser"],
);

// ---------------------------------------------------------------------------
// 2. Accepted draft -> stored draft -> Library -> review
// ---------------------------------------------------------------------------
const extraction = convertAiProgramToShare(
  {
    name: "Flag plan",
    days: [
      {
        name: "Day 1",
        exercises: [
          { exerciseId: "", name: "Flag Probe Deadlift", isNew: true, category: "compound", equipment: "barbell", mainMuscles: ["Hamstrings"], sets: 3, repsMin: 8, repsMax: 10, targetRPE: 8, restSeconds: 120, progressionType: "hypertrophy" },
          { exerciseId: "", name: "Flag Probe Face Pull", isNew: true, category: "isolation", equipment: "cable", mainMuscles: ["Rear delts"], sets: 3, repsMin: 12, repsMax: 15, targetRPE: 8, restSeconds: 60, progressionType: "pump" },
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
  setup: ["picioarele la lățimea șoldurilor", "prinde bara lat"],
  howToDoIt: ["împinge șoldurile înapoi", "revino împingând șoldurile în față"],
  executionTips: ["ține bara lipită de coapse"],
  commonMistakes: ["spate rotunjit"],
  whatYouShouldFeel: ["hamstrings și fesieri întinși"],
  whyItsThere: ["construiește lanțul posterior"],
  progressionRegression: ["mai ușor: dumbbell romanian deadlift"],
  safetyNotes: ["oprește dacă simți durere ascuțită în spate"],
  aiGenerated: true,
};
assert.equal(applyTechniqueDraft(noted, techniqueDraft).reviewedByUser, false);

const accepted = acceptTechniqueDraftIntoShare(extraction.share, techniqueDraft);
assert.equal(accepted.ok, true, accepted.error);
const programDraft = draftFromShare(accepted.share, { origin: "ai-import" });
assert.equal(programDraft.ok, true, programDraft.error);

/** Every Library entry object anywhere inside a draft. */
function draftEntries(node, found = []) {
  if (Array.isArray(node)) {
    node.forEach((entry) => draftEntries(entry, found));
  } else if (node && typeof node === "object") {
    if (typeof node.id === "string" && Array.isArray(node.goalTags)) {
      found.push(node);
    }

    Object.values(node).forEach((entry) => draftEntries(entry, found));
  }

  return found;
}
const entriesOf = (draft, id) => draftEntries(draft).filter((entry) => entry.id === id);

assert.ok(entriesOf(programDraft.draft, noted.id).length > 0, "the draft holds the new entry");
entriesOf(programDraft.draft, noted.id).forEach((entry) => {
  assert.equal(entry.reviewedByUser, false, "the draft entry keeps reviewedByUser: false");
  assert.ok(entry.goalTags.includes(TECHNIQUE_DRAFT_TAG));
});
assert.ok(entriesOf(programDraft.draft, plain.id).length > 0);
entriesOf(programDraft.draft, plain.id).forEach((entry) => assert.ok(!("reviewedByUser" in entry)));

// A stored draft (unfinished Studio work) keeps it too.
assert.equal(saveDraftToStorage(programDraft.draft).ok, true);
const reloaded = loadStoredDraft(programDraft.draft.draftId);
assert.ok(reloaded, "the draft is stored");
const reloadedEntries = entriesOf(reloaded, noted.id);
assert.ok(reloadedEntries.length > 0);
reloadedEntries.forEach((entry) => assert.equal(entry.reviewedByUser, false));

const saved = saveProgramDraft(programDraft.draft);
assert.equal(saved.ok, true, saved.error);
const stored = getExerciseById(noted.id);
assert.equal(stored.reviewedByUser, false, "the Library entry says it was not reviewed");
assert.equal(isAiTechniqueDraftEntry(stored), true);
assert.ok(!("reviewedByUser" in getExerciseById(plain.id)), "an entry without AI notes has no flag");
const rawLibrary = JSON.parse(window.localStorage.getItem(STORAGE_KEYS.exerciseLibrary));
assert.deepEqual(
  rawLibrary.filter((entry) => "reviewedByUser" in entry).map((entry) => [entry.id, entry.reviewedByUser]),
  [[noted.id, false]],
  "only the entry with AI notes carries the flag; no seeded entry gained one",
);

const reviewed = markLibraryTechniqueReviewed(noted.id);
assert.equal(reviewed.ok, true, reviewed.error);
assert.equal(getExerciseById(noted.id).reviewedByUser, true);
assert.equal(isAiTechniqueDraftEntry(getExerciseById(noted.id)), false);

// A share file of the reviewed entry, opened as a draft: "reviewed" is a
// statement about the owner of THIS Library and does not travel.
const share = exportProgramShare(saved.program.id);
assert.equal(share.libraryExercises.find((entry) => entry.id === noted.id).reviewedByUser, true);
const imported = draftFromShare(share, { origin: "file" });
assert.equal(imported.ok, true, imported.error);
draftEntries(imported.draft).forEach((entry) => assert.ok(!("reviewedByUser" in entry), "a draft never claims a review"));

// ---------------------------------------------------------------------------
// 3. Emptied notes (H3-18): the flag goes with the tag
// ---------------------------------------------------------------------------
{
  const withNotes = applyTechniqueDraft(plain, { ...techniqueDraft, id: plain.id, name: plain.name }, { libraryIds: [] });
  assert.equal(withNotes.reviewedByUser, false);
  const emptied = applyTechniqueForm(withNotes, {});
  assert.ok(!("reviewedByUser" in emptied));
  assert.ok(!("reviewedByUser" in normalizeDraftLibraryEntry(emptied)));
}

console.log("verify-library-h3-fix3: ok");
