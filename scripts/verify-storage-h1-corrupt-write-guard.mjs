// Fixer round 2 (decision new-U): a writer never replaces a value it could not
// read with a value computed from the fallback.
// - writeStorage / writeStorageBatch refuse a key whose stored text is not
//   valid JSON (code "corrupt"), record nothing new, and leave the raw text.
// - The programStorage writers that merge onto readStorage() fallbacks
//   (duplicate, import, save, target edit, state, active id, metadata) all
//   return a failure instead of a near-empty array written over the user's data.
// - An explicit overwrite clears the read-corrupt issue (the banner stops
//   claiming the original is still there); discardCorruptStorageValue is the
//   user-facing way out and keeps the `.corrupt-<n>` copy.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.writes = [];
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.writes.push(key);
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };

const originalWarn = console.warn;
console.warn = () => {};

const {
  ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID,
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  exportProgramShare,
  getProgramDays,
  getProgramExercises,
  importProgramShare,
  persistWorkoutSave,
  seedDefaultProgramIfNeeded,
  setActiveProgram,
  setActiveProgramChecked,
  updateProgramExerciseTargetChecked,
  updateProgramMetadata,
  updateProgramState,
} = await import("../src/lib/programStorage.js");
const {
  clearStorageIssue,
  discardCorruptStorageValue,
  getStorageIssues,
  isStorageKeyCorrupt,
  readStorage,
  STORAGE_KEYS,
  writeStorage,
  writeStorageBatch,
} = await import("../src/lib/storage.js");

function trackedWrites() {
  return storage.writes.filter((key) => !key.includes(".corrupt-"));
}

function corruptIssue(key) {
  return getStorageIssues().find((issue) => issue.key === key && issue.kind === "read-corrupt");
}

function withCorruptKey(key, raw, run) {
  const healthy = storage.getItem(key);
  storage.setItem(key, raw);
  storage.writes = [];

  try {
    run();
    assert.equal(storage.getItem(key), raw, `${key}: corrupt text untouched`);
    assert.ok(!trackedWrites().includes(key), `${key}: never written`);
    assert.ok(corruptIssue(key), `${key}: read-corrupt issue still live (banner stays truthful)`);
  } finally {
    storage.setItem(key, healthy);
    clearStorageIssue(key);
    storage.writes = [];
  }
}

try {
  // ------------------------------------------------------------------
  // Primitives.
  // ------------------------------------------------------------------
  storage.setItem(STORAGE_KEYS.appUiState, "{broken");
  storage.writes = [];
  assert.deepEqual(readStorage(STORAGE_KEYS.appUiState, {}), {});
  const refused = writeStorage(STORAGE_KEYS.appUiState, { activeTab: "dashboard" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "corrupt");
  assert.match(refused.error, /could not be read, so it was not overwritten/);
  assert.equal(storage.getItem(STORAGE_KEYS.appUiState), "{broken", "raw text kept");
  assert.deepEqual(trackedWrites(), [], "nothing written");
  assert.ok(corruptIssue(STORAGE_KEYS.appUiState), "issue still describes the key");
  assert.ok(
    !getStorageIssues().some(
      (issue) => issue.key === STORAGE_KEYS.appUiState && issue.kind !== "read-corrupt",
    ),
    "no second (write) issue for the same key",
  );
  assert.equal(isStorageKeyCorrupt(STORAGE_KEYS.appUiState), true);

  // Dismissing the banner (clearStorageIssue) does not unlock the overwrite:
  // the guard reads the stored text, not the in-memory issue list.
  clearStorageIssue(STORAGE_KEYS.appUiState);
  const refusedAgain = writeStorage(STORAGE_KEYS.appUiState, { activeTab: "dashboard" });
  assert.equal(refusedAgain.code, "corrupt");
  assert.ok(corruptIssue(STORAGE_KEYS.appUiState), "the issue is raised again by the attempt");

  // A key that was never read is guarded the same way (and gets its copy).
  storage.setItem(STORAGE_KEYS.setupCues, "[oops");
  assert.equal(writeStorage(STORAGE_KEYS.setupCues, {}).code, "corrupt");
  assert.equal(storage.getItem(`${STORAGE_KEYS.setupCues}.corrupt-1`), "[oops", "copy kept");

  // Batch: refused before the first write, even when the corrupt key is last.
  storage.writes = [];
  const batch = writeStorageBatch([
    { key: STORAGE_KEYS.sessions, value: [{ id: "s1" }] },
    { key: STORAGE_KEYS.appUiState, value: {} },
  ]);
  assert.equal(batch.ok, false);
  assert.equal(batch.code, "corrupt");
  assert.equal(batch.failedKey, STORAGE_KEYS.appUiState);
  assert.equal(batch.rolledBack, true);
  assert.equal(storage.getItem(STORAGE_KEYS.sessions), null, "healthy key of the batch not written");
  assert.deepEqual(trackedWrites(), []);

  // Explicit overwrite: allowed, and the read-corrupt issue is replaced.
  const overwritten = writeStorage(STORAGE_KEYS.appUiState, { activeTab: "dashboard" }, { overwriteCorrupt: true });
  assert.equal(overwritten.ok, true);
  assert.deepEqual(readStorage(STORAGE_KEYS.appUiState, {}), { activeTab: "dashboard" });
  assert.equal(corruptIssue(STORAGE_KEYS.appUiState), undefined, "issue cleared after a knowing overwrite");
  assert.equal(storage.getItem(`${STORAGE_KEYS.appUiState}.corrupt-1`), "{broken", "copy survives");

  const batchOverwrite = writeStorageBatch(
    [
      { key: STORAGE_KEYS.sessions, value: [{ id: "s1" }] },
      { key: STORAGE_KEYS.setupCues, value: {} },
    ],
    { overwriteCorrupt: [STORAGE_KEYS.setupCues] },
  );
  assert.equal(batchOverwrite.ok, true);
  assert.equal(corruptIssue(STORAGE_KEYS.setupCues), undefined);

  // Discard: copy must exist, key removed, issue cleared, later writes go through.
  storage.setItem(STORAGE_KEYS.readinessByDate, "{bad");
  assert.equal(writeStorage(STORAGE_KEYS.readinessByDate, {}).code, "corrupt");
  const discard = discardCorruptStorageValue(STORAGE_KEYS.readinessByDate);
  assert.equal(discard.ok, true);
  assert.equal(discard.discarded, true);
  assert.equal(discard.corruptCopyKey, `${STORAGE_KEYS.readinessByDate}.corrupt-1`);
  assert.equal(storage.getItem(STORAGE_KEYS.readinessByDate), null);
  assert.equal(storage.getItem(`${STORAGE_KEYS.readinessByDate}.corrupt-1`), "{bad");
  assert.equal(corruptIssue(STORAGE_KEYS.readinessByDate), undefined);
  assert.equal(writeStorage(STORAGE_KEYS.readinessByDate, { d: 1 }).ok, true);
  assert.deepEqual(discardCorruptStorageValue(STORAGE_KEYS.readinessByDate), {
    ok: true,
    discarded: false,
    corruptCopyKey: null,
  });

  // Healthy keys are unaffected.
  assert.equal(writeStorage(STORAGE_KEYS.nextPlans, { a: 1 }).ok, true);
  assert.equal(writeStorage(STORAGE_KEYS.nextPlans, { a: 2 }).ok, true);
  assert.deepEqual(readStorage(STORAGE_KEYS.nextPlans, {}), { a: 2 });
  getStorageIssues().forEach((issue) => clearStorageIssue(issue.key));

  // ------------------------------------------------------------------
  // Program storage writers merge onto fallbacks: every one must refuse.
  // ------------------------------------------------------------------
  const seeded = seedDefaultProgramIfNeeded();
  assert.equal(seeded.seeded, true);
  const dayCount = getProgramDays(DEFAULT_PROGRAM_ID).length;
  const firstDay = getProgramDays(DEFAULT_PROGRAM_ID)[0];
  const firstExercise = getProgramExercises(firstDay.id)[0];
  const progressionCount = readStorage(STORAGE_KEYS.programProgressions, []).length;
  assert.ok(dayCount > 0 && progressionCount > 0);

  withCorruptKey(STORAGE_KEYS.programDays, "[broken", () => {
    const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
    assert.equal(copy.ok, false, "duplicate refused");
    assert.equal(copy.code, "corrupt");
    assert.equal(copy.programId, null);
    assert.equal(
      readStorage(STORAGE_KEYS.programs, []).length,
      2,
      "no half-made copy in programs.v1",
    );
  });
  assert.equal(getProgramDays(DEFAULT_PROGRAM_ID).length, dayCount, "days intact afterwards");

  const share = exportProgramShare(DEFAULT_PROGRAM_ID);
  withCorruptKey(STORAGE_KEYS.programs, "{broken", () => {
    const imported = importProgramShare(JSON.parse(JSON.stringify(share)));
    assert.equal(imported.ok, false, "import refused");
    assert.equal(imported.code, "corrupt");
    assert.equal(imported.failedKey, STORAGE_KEYS.programs);
  });
  assert.equal(readStorage(STORAGE_KEYS.programs, []).length, 2, "both defaults still there");

  withCorruptKey(STORAGE_KEYS.programProgressions, "[broken", () => {
    const saved = persistWorkoutSave({
      sessions: [],
      programId: DEFAULT_PROGRAM_ID,
      progressionUpdates: [{ programExerciseId: firstExercise.id, patch: { lastRecommendedWeight: 1 } }],
    });
    assert.equal(saved.ok, false, "save refused");
    assert.equal(saved.code, "corrupt");
    assert.equal(storage.getItem(STORAGE_KEYS.sessions), JSON.stringify([{ id: "s1" }]), "sessions untouched");
  });
  assert.equal(readStorage(STORAGE_KEYS.programProgressions, []).length, progressionCount);

  // The app path of the finding: sessions.v1 unreadable, the hook fallback []
  // would become a one-session history with a success recap.
  withCorruptKey(STORAGE_KEYS.sessions, '[{"id":1}', () => {
    const saved = persistWorkoutSave({
      sessions: [{ id: "new" }],
      nextPlans: {},
      workoutDrafts: {},
      programId: DEFAULT_PROGRAM_ID,
      programStatePatch: { lastCompletedDayId: firstDay.id },
    });
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "corrupt");
    assert.equal(saved.failedKey, STORAGE_KEYS.sessions);
  });

  withCorruptKey(STORAGE_KEYS.programStates, "[broken", () => {
    assert.equal(updateProgramState(DEFAULT_PROGRAM_ID, { currentWeek: 2 }), null, "state update refused");
  });

  withCorruptKey(STORAGE_KEYS.activeProgramId, "{bad", () => {
    const switched = setActiveProgramChecked(ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID);
    assert.equal(switched.ok, false);
    assert.equal(switched.code, "corrupt");
    assert.equal(setActiveProgram(ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID), null);
  });

  withCorruptKey(STORAGE_KEYS.programs, "{broken", () => {
    assert.equal(updateProgramMetadata(DEFAULT_PROGRAM_ID, { nickname: "x" }), null);
  });

  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(copy.ok, true);
  const copyExercise = getProgramExercises(getProgramDays(copy.programId)[0].id)[0];
  withCorruptKey(STORAGE_KEYS.programExercises, "[broken", () => {
    const edited = updateProgramExerciseTargetChecked(copy.programId, copyExercise.id, { targetSets: 3 });
    assert.equal(edited.ok, false);
    assert.match(edited.error, /not found|could not be read/);
  });

  console.warn = originalWarn;
  console.log("Storage H1 corrupt-write-guard verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
