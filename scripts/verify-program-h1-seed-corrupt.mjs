// Fixer round 1 (decision new-G, handoff 11.1): seeding never treats a corrupt
// program storage key as an empty one. With unreadable JSON under programs.v1
// (or any key the seed merges into) seedDefaultProgramIfNeeded writes nothing,
// the corrupt key keeps its raw value, custom programs are not replaced by the
// defaults and active-program-id / program-storage-meta are not rewritten.
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
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  getActiveProgramId,
  getProgramDays,
  getPrograms,
  seedDefaultProgramIfNeeded,
} = await import("../src/lib/programStorage.js");
const { clearStorageIssue, getStorageIssues, STORAGE_KEYS } = await import(
  "../src/lib/storage.js"
);

function snapshotKeys() {
  return Object.fromEntries([...storage.store.entries()]);
}

function trackedWrites() {
  return storage.writes.filter((key) => !key.includes(".corrupt-"));
}

try {
  // Healthy first run seeds both defaults.
  const first = seedDefaultProgramIfNeeded();
  assert.equal(first.seeded, true);
  assert.equal(first.activeProgramId, DEFAULT_PROGRAM_ID);

  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.equal(copy.ok, true);
  assert.ok(getPrograms().some((program) => program.id === copy.programId));
  assert.equal(getProgramDays(copy.programId).length, 5);

  // ------------------------------------------------------------------
  // programs.v1 corrupt: nothing is seeded or rewritten.
  // ------------------------------------------------------------------
  const healthyPrograms = storage.getItem(STORAGE_KEYS.programs);
  const healthyActive = storage.getItem(STORAGE_KEYS.activeProgramId);
  const healthyMeta = storage.getItem(STORAGE_KEYS.programStorageMeta);
  storage.setItem(STORAGE_KEYS.programs, '{"broken": ');
  storage.setItem(STORAGE_KEYS.activeProgramId, "{bad");
  const before = snapshotKeys();
  storage.writes = [];

  const blocked = seedDefaultProgramIfNeeded();
  assert.equal(blocked.seeded, false);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(
    [...blocked.corruptKeys].sort(),
    [STORAGE_KEYS.activeProgramId, STORAGE_KEYS.programs].sort(),
    "the corrupt keys are reported",
  );
  assert.deepEqual(trackedWrites(), [], "no tracked key was written");
  assert.equal(storage.getItem(STORAGE_KEYS.programs), '{"broken": ', "corrupt programs kept");
  assert.equal(storage.getItem(STORAGE_KEYS.activeProgramId), "{bad", "corrupt active id kept");
  assert.equal(storage.getItem(STORAGE_KEYS.programStorageMeta), healthyMeta, "meta not rewritten");
  assert.equal(storage.getItem(`${STORAGE_KEYS.programs}.corrupt-1`), '{"broken": ', "copy kept");
  assert.deepEqual(
    Object.fromEntries(Object.entries(snapshotKeys()).filter(([key]) => !key.includes(".corrupt-"))),
    before,
    "every tracked key byte-identical",
  );
  assert.equal(getPrograms().length, 0, "fallback is used in memory only");
  assert.equal(getProgramDays(copy.programId).length, 5, "the copy's days are still there");
  assert.ok(
    getStorageIssues().some(
      (issue) => issue.key === STORAGE_KEYS.programs && issue.kind === "read-corrupt",
    ),
    "the corrupt key is reported for the banner",
  );

  // Running it again (every mount) still writes nothing.
  seedDefaultProgramIfNeeded();
  assert.deepEqual(trackedWrites(), []);

  // ------------------------------------------------------------------
  // Only active-program-id corrupt: the fallback id is used but not written.
  // ------------------------------------------------------------------
  storage.setItem(STORAGE_KEYS.programs, healthyPrograms);
  storage.writes = [];
  assert.equal(getActiveProgramId(), DEFAULT_PROGRAM_ID, "fallback resolved in memory");
  assert.equal(storage.getItem(STORAGE_KEYS.activeProgramId), "{bad", "corrupt id not overwritten");
  const activeOnly = seedDefaultProgramIfNeeded();
  assert.equal(activeOnly.blocked, true);
  assert.deepEqual(activeOnly.corruptKeys, [STORAGE_KEYS.activeProgramId]);
  assert.equal(activeOnly.activeProgramId, DEFAULT_PROGRAM_ID);
  assert.deepEqual(trackedWrites(), []);

  // Healthy again: the normal path resumes and nothing custom was lost.
  storage.setItem(STORAGE_KEYS.activeProgramId, healthyActive);
  clearStorageIssue(STORAGE_KEYS.programs);
  clearStorageIssue(STORAGE_KEYS.activeProgramId);
  const resumed = seedDefaultProgramIfNeeded();
  assert.equal(resumed.seeded, false);
  assert.equal(resumed.blocked, undefined);
  assert.ok(getPrograms().some((program) => program.id === copy.programId), "custom program intact");

  // ------------------------------------------------------------------
  // Fresh install but program-days corrupt: still no seed (the seed would
  // merge into the corrupt key).
  // ------------------------------------------------------------------
  const fresh = new MemoryLocalStorage();
  globalThis.window = { localStorage: fresh };
  fresh.setItem(STORAGE_KEYS.programDays, "[not json");
  fresh.writes = [];
  const freshBlocked = seedDefaultProgramIfNeeded();
  assert.equal(freshBlocked.blocked, true);
  assert.deepEqual(freshBlocked.corruptKeys, [STORAGE_KEYS.programDays]);
  assert.equal(fresh.getItem(STORAGE_KEYS.programs), null, "no programs seeded over a corrupt store");
  assert.equal(fresh.getItem(STORAGE_KEYS.programDays), "[not json");
  assert.deepEqual(
    fresh.writes.filter((key) => !key.includes(".corrupt-")),
    [],
  );

  console.warn = originalWarn;
  console.log("Program H1 corrupt-seed verification passed.");
} catch (error) {
  console.warn = originalWarn;
  throw error;
}
