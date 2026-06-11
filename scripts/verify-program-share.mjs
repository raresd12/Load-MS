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

const {
  DEFAULT_PROGRAM_ID,
  exportProgramShare,
  getProgramDays,
  getPrograms,
  importProgramShare,
  seedDefaultProgramIfNeeded,
  validateProgramShare,
} = await import("../src/lib/programStorage.js");
const { readStorage, STORAGE_KEYS } = await import("../src/lib/storage.js");

seedDefaultProgramIfNeeded();

const programsBefore = getPrograms();
assert.ok(programsBefore.length >= 1, "default program should be seeded");

const share = exportProgramShare(DEFAULT_PROGRAM_ID);
assert.ok(share, "export should produce a share object");
assert.equal(share.type, "rpe-tracker-program-share");
assert.ok(share.days.length > 0, "share should contain days");
assert.ok(share.programExercises.length > 0, "share should contain exercises");
assert.ok(share.libraryExercises.length > 0, "share should contain library entries");
assert.equal(validateProgramShare(share).valid, true);

// Round-trip through JSON like a real file.
const parsedShare = JSON.parse(JSON.stringify(share));
const libraryCountBefore = readStorage(STORAGE_KEYS.exerciseLibrary, []).length;
const sourceDayCount = getProgramDays(DEFAULT_PROGRAM_ID).length;

const result = importProgramShare(parsedShare);
assert.equal(result.valid, true);
assert.ok(result.program.id !== DEFAULT_PROGRAM_ID, "import must create a new program id");
assert.equal(result.program.isDefault, false);
assert.equal(result.importedDayCount, sourceDayCount);
assert.equal(result.importedExerciseCount, share.programExercises.length);

const programsAfter = getPrograms();
assert.equal(programsAfter.length, programsBefore.length + 1, "exactly one program added");

const importedDays = getProgramDays(result.program.id);
assert.equal(importedDays.length, sourceDayCount, "imported program keeps all days");
assert.ok(
  importedDays.every((day) => day.programId === result.program.id),
  "imported days are bound to the new program",
);

// Library exercises already present locally must not be duplicated.
const libraryCountAfter = readStorage(STORAGE_KEYS.exerciseLibrary, []).length;
assert.equal(libraryCountAfter, libraryCountBefore, "no duplicate library entries");

// The original program is untouched.
const originalDays = getProgramDays(DEFAULT_PROGRAM_ID);
assert.equal(originalDays.length, sourceDayCount);

// Invalid inputs are rejected without writes.
assert.equal(importProgramShare(null).valid, false);
assert.equal(importProgramShare({ type: "wrong" }).valid, false);
assert.equal(
  importProgramShare({ type: "rpe-tracker-program-share", program: { name: "X" }, days: [] }).valid,
  false,
);
assert.equal(getPrograms().length, programsAfter.length, "failed imports add nothing");

console.log("Program share verification passed.");
