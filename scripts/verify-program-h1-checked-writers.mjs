// Fixer round 2: setActiveProgram and updateProgramMetadata no longer report
// success when their write failed. The checked variants return
// { ok:false, error, code }; the legacy wrappers return null.
import assert from "node:assert/strict";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failKey = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failKey === key) {
      throw new DOMException(`Simulated write failure for ${key}`, "QuotaExceededError");
    }

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
  getActiveProgramId,
  getPrograms,
  seedDefaultProgramIfNeeded,
  setActiveProgram,
  setActiveProgramChecked,
  setProgramArchived,
  updateProgramMetadata,
  updateProgramMetadataChecked,
} = await import("../src/lib/programStorage.js");
const { getStorageIssues, STORAGE_KEYS } = await import("../src/lib/storage.js");

try {
  seedDefaultProgramIfNeeded();
  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(copy.ok, true);

  // ------------------------------------------------------------------
  // setActiveProgram
  // ------------------------------------------------------------------
  storage.failKey = STORAGE_KEYS.activeProgramId;
  const failedSwitch = setActiveProgramChecked(ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID);
  assert.equal(failedSwitch.ok, false);
  assert.equal(failedSwitch.code, "quota");
  assert.equal(failedSwitch.programId, null);
  assert.match(failedSwitch.error, /storage is full/);
  assert.equal(setActiveProgram(ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID), null, "legacy wrapper: null on failure");
  assert.equal(
    storage.getItem(STORAGE_KEYS.activeProgramId),
    JSON.stringify(DEFAULT_PROGRAM_ID),
    "stored active id unchanged",
  );
  assert.equal(getActiveProgramId(), DEFAULT_PROGRAM_ID);
  assert.ok(
    getStorageIssues().some((issue) => issue.key === STORAGE_KEYS.activeProgramId && issue.kind === "quota"),
    "failure surfaced for the banner",
  );

  storage.failKey = null;
  const switched = setActiveProgramChecked(ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID);
  assert.deepEqual(switched, { ok: true, programId: ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID });
  assert.equal(getActiveProgramId(), ATHLETIC_AESTHETIC_BASKETBALL_PROGRAM_ID);
  assert.equal(setActiveProgram(DEFAULT_PROGRAM_ID), DEFAULT_PROGRAM_ID, "legacy wrapper still returns the id");

  // Missing / archived programs are rejected without a write.
  assert.equal(setActiveProgramChecked("nope").ok, false);
  assert.equal(setActiveProgram("nope"), null);
  assert.equal(setProgramArchived(copy.programId, true).ok, true);
  const archivedSwitch = setActiveProgramChecked(copy.programId);
  assert.equal(archivedSwitch.ok, false);
  assert.match(archivedSwitch.error, /not found or archived/);
  assert.equal(getActiveProgramId(), DEFAULT_PROGRAM_ID);
  assert.equal(setProgramArchived(copy.programId, false).ok, true);

  // ------------------------------------------------------------------
  // updateProgramMetadata
  // ------------------------------------------------------------------
  const programsBefore = storage.getItem(STORAGE_KEYS.programs);
  storage.failKey = STORAGE_KEYS.programs;
  const failedMetadata = updateProgramMetadataChecked(copy.programId, { nickname: "zz" });
  assert.equal(failedMetadata.ok, false);
  assert.equal(failedMetadata.code, "quota");
  assert.equal(failedMetadata.program, null);
  assert.equal(updateProgramMetadata(copy.programId, { nickname: "zz" }), null, "legacy wrapper: null on failure");
  assert.equal(storage.getItem(STORAGE_KEYS.programs), programsBefore, "programs byte-identical");
  assert.notEqual(getPrograms().find((program) => program.id === copy.programId).nickname, "zz");

  storage.failKey = null;
  const saved = updateProgramMetadataChecked(copy.programId, { nickname: "zz", name: "Renamed" });
  assert.equal(saved.ok, true);
  assert.equal(saved.program.nickname, "zz");
  assert.equal(saved.program.name, "Renamed");
  assert.equal(getPrograms().find((program) => program.id === copy.programId).nickname, "zz");
  assert.equal(updateProgramMetadata(copy.programId, { goal: "g" }).goal, "g", "legacy wrapper returns the program");
  assert.equal(updateProgramMetadataChecked("nope", { nickname: "x" }).ok, false);
  assert.equal(updateProgramMetadata("nope", { nickname: "x" }), null);

  // Default program: the name stays protected, the nickname is editable.
  const defaultEdit = updateProgramMetadataChecked(DEFAULT_PROGRAM_ID, { name: "Hack", nickname: "Mine" });
  assert.equal(defaultEdit.ok, true);
  assert.notEqual(defaultEdit.program.name, "Hack");
  assert.equal(defaultEdit.program.nickname, "Mine");

  console.warn = originalWarn;
  console.log("Program H1 checked-writers verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
