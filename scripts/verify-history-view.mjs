// H4 fix round 3, decision H4-15: src/lib/historyView.js (moved from
// src/pages/HistoryPage.jsx). The History card summary is built from whatever
// shape a saved session has, so old sessions stay readable:
// - schema v6 sessions read workoutSets (set order by setNumber, BW sets
//   carry no volume, unlogged sets are not shown);
// - legacy keyed / array `exercises` sessions and legacy note fields are read;
// - a session with nothing in it yields an empty, renderable summary;
// - the program name falls back to the stored program (archived included);
// - the builders never mutate the session.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  buildHistoryExerciseGroups,
  buildHistorySessionSummary,
  formatHistoryDateTime,
  formatHistoryReadiness,
  formatHistoryWeight,
  getHistoryReadiness,
  getHistorySessionNotes,
  getLegacyExerciseCount,
  isHistoryLoggedSet,
  resolveHistoryProgramName,
} = await import("../src/lib/historyView.js");
const { buildProgressExerciseLookup } = await import("../src/lib/sessionAnalytics.js");
const { DEFAULT_PROGRAM_ID, getPrograms, seedDefaultProgramIfNeeded } = await import("../src/lib/programStorage.js");
const { readStorage, writeStorage, STORAGE_KEYS } = await import("../src/lib/storage.js");

function workoutSet(programExerciseId, exerciseId, setNumber, reps, weight, rpe) {
  return {
    sessionId: "s1",
    programId: "p1",
    dayId: "d1",
    programExerciseId,
    exerciseId,
    setNumber,
    actualWeight: weight,
    actualReps: reps,
    actualRPE: rpe,
    completed: reps !== null && weight !== null && rpe !== null,
  };
}

const modern = {
  id: "s1",
  schemaVersion: 6,
  date: "2026-09-20T10:00:00.000Z",
  programId: "p1",
  programName: "Custom",
  dayId: "d1",
  dayName: "Day 1",
  sessionRpe: 8,
  sessionNotes: " solid ",
  recoveryNotes: "",
  readiness: { status: "green", averageScore: 4.2 },
  exercises: {
    "pe-bench": {
      programExerciseId: "pe-bench",
      exerciseId: "lib-bench",
      notes: "elbow ok",
      sets: [
        { reps: 8, weight: 60, rpe: 8 },
        { reps: 7, weight: 60, rpe: 8.5 },
        { reps: null, weight: null, rpe: null },
      ],
    },
  },
  workoutSets: [
    workoutSet("pe-bench", "lib-bench", 2, 7, 60, 8.5),
    workoutSet("pe-bench", "lib-bench", 1, 8, 60, 8),
    workoutSet("pe-bench", "lib-bench", 3, null, null, null),
    workoutSet("pe-pull", "lib-pull", 1, 10, "BW", 7),
  ],
  analytics: { exerciseCount: 2, loggedSetCount: 3 },
};
const legacyKeyed = {
  id: "l1",
  date: "2025-01-05T10:00:00.000Z",
  dayId: "day-1",
  dayName: "Day 1",
  wellness: { sleep: 4, soreness: 4, fatigue: 4, mood: 4, stress: 4 },
  notes: "old note",
  exercises: { "bench-press": { notes: "felt heavy", sets: [{ reps: "6", weight: "80", rpe: "8" }] } },
};
const legacyArray = {
  id: "l2",
  date: "bad",
  exercises: [
    { name: "Squat", notes: "deep", sets: [{ reps: 5, weight: 100, rpe: 8 }] },
    { name: "Row", notes: "deep" },
  ],
  sessionNote: "short",
  analytics: { exerciseCount: 2, loggedSetCount: 1 },
};
const empty = { id: "e" };

const lookup = buildProgressExerciseLookup({ programs: [], activeProgram: null, activeProgramDays: [], exerciseLibrary: [] });

try {
  // ------------------------------------------------------------------
  // Schema v6 session
  // ------------------------------------------------------------------
  const modernBefore = JSON.stringify(modern);
  const summary = buildHistorySessionSummary(modern, lookup);
  assert.equal(JSON.stringify(modern), modernBefore, "the session is not mutated");
  assert.equal(summary.dayName, "Day 1");
  assert.equal(summary.dayFocus, "");
  assert.equal(summary.programName, "Custom", "the stored program name wins");
  assert.equal(summary.readinessLabel, "Green 4.2");
  assert.equal(summary.sessionRpe, 8);
  assert.equal(summary.exerciseCount, 2);
  assert.equal(summary.setCount, 3, "the unlogged third bench set is not counted");
  assert.equal(summary.totalVolume, 900, "8x60 + 7x60; the BW set adds no volume");
  assert.equal(summary.schemaLabel, "v6");
  assert.deepEqual(summary.notes, ["solid", "elbow ok"], "session and exercise notes, trimmed, blanks dropped");
  assert.equal(summary.exerciseGroups.length, 2);
  const [bench, pull] = summary.exerciseGroups;
  assert.equal(bench.programExerciseId, "pe-bench");
  assert.deepEqual(bench.sets.map((set) => set.setNumber), [1, 2], "sets are ordered by set number");
  assert.deepEqual(bench.sets.map((set) => [set.reps, set.weight, set.rpe]), [[8, 60, 8], [7, 60, 8.5]]);
  assert.equal(bench.totalVolume, 900);
  assert.equal(bench.averageRpe, 8.25);
  assert.equal(pull.programExerciseId, "pe-pull");
  assert.equal(pull.sets[0].weight, "BW");
  assert.equal(pull.totalVolume, 0);
  assert.equal(pull.averageRpe, 7);

  // The card's volume is the measurement-aware tonnage of the set record
  // (H5-10 applied to History, H5-40): a per-dumbbell set counts both
  // dumbbells, a per-side set both sides, exactly like Progress, the recap,
  // the Dashboard and the session-volume record.
  const dumbbellSession = {
    ...modern,
    id: "s-db",
    exercises: {},
    workoutSets: [
      { ...workoutSet("pe-db", "lib-db", 1, 10, 20, 8), weightMode: "per dumbbell" },
      { ...workoutSet("pe-split", "lib-split", 1, 10, 20, 8), weightMode: "per dumbbell", perSide: true },
      workoutSet("pe-bench", "lib-bench", 1, 10, 50, 8),
    ],
  };
  const dumbbellSummary = buildHistorySessionSummary(dumbbellSession, lookup);
  assert.equal(dumbbellSummary.totalVolume, 400 + 800 + 500, "20 kg per dumbbell x 10 = 400, per side as well = 800, plain 50 x 10 = 500");
  assert.deepEqual(
    dumbbellSummary.exerciseGroups.map((group) => [group.programExerciseId, group.totalVolume]).sort(),
    [["pe-bench", 500], ["pe-db", 400], ["pe-split", 800]],
  );

  // ------------------------------------------------------------------
  // Legacy shapes stay readable
  // ------------------------------------------------------------------
  const keyedBefore = JSON.stringify(legacyKeyed);
  const keyed = buildHistorySessionSummary(legacyKeyed, lookup);
  assert.equal(JSON.stringify(legacyKeyed), keyedBefore);
  assert.equal(keyed.programName, "No program saved");
  assert.equal(keyed.readinessLabel, "Green 4.0", "readiness is derived from the legacy wellness values");
  assert.equal(keyed.sessionRpe, null);
  assert.equal(keyed.exerciseCount, 1);
  assert.equal(keyed.setCount, 1);
  assert.equal(keyed.totalVolume, 480, "string values of a legacy set are read as numbers");
  assert.deepEqual(keyed.notes, ["old note", "felt heavy"]);
  assert.equal(keyed.schemaLabel, "legacy");
  assert.equal(keyed.exerciseGroups[0].programExerciseId, null);

  const array = buildHistorySessionSummary(legacyArray, lookup);
  assert.equal(array.dayName, "Workout", "no day name: generic title");
  assert.equal(array.readinessLabel, "No data");
  assert.equal(array.exerciseCount, 1, "exercises with logged sets");
  assert.equal(array.setCount, 1);
  assert.equal(array.totalVolume, 500);
  assert.equal(array.exerciseGroups[0].name, "Squat");
  assert.deepEqual(array.notes, ["short", "deep"], "duplicate notes are shown once");

  assert.deepEqual(buildHistorySessionSummary(empty, lookup), {
    dayName: "Workout",
    dayFocus: "",
    programName: "No program saved",
    readinessLabel: "No data",
    sessionRpe: null,
    exerciseCount: 0,
    setCount: 0,
    totalVolume: 0,
    exerciseGroups: [],
    notes: [],
    schemaLabel: "legacy",
  });

  // A session whose sets cannot be read falls back to its stored analytics.
  const analyticsOnly = buildHistorySessionSummary({ id: "a", analytics: { exerciseCount: 4, loggedSetCount: 11 } }, lookup);
  assert.equal(analyticsOnly.exerciseCount, 4);
  assert.equal(analyticsOnly.setCount, 11);

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  assert.equal(isHistoryLoggedSet({ completed: true, reps: null, weight: null, rpe: null }), true);
  assert.equal(isHistoryLoggedSet({ completed: false, reps: 5, weight: null, rpe: null }), true);
  assert.equal(isHistoryLoggedSet({ completed: false, reps: null, weight: "BW", rpe: null }), true);
  assert.equal(isHistoryLoggedSet({ completed: false, reps: null, weight: null, rpe: 8 }), true);
  assert.equal(isHistoryLoggedSet({ completed: false, reps: null, weight: null, rpe: null }), false);

  assert.deepEqual(getHistoryReadiness({ readiness: { status: "red" }, wellness: { sleep: 5 } }), { status: "red" }, "stored readiness first");
  assert.deepEqual(getHistoryReadiness({ readinessSnapshot: { readiness: { status: "yellow" } } }), { status: "yellow" });
  assert.equal(getHistoryReadiness({}), null);
  assert.equal(formatHistoryReadiness({ status: "red", averageScore: 2 }), "Red 2.0");
  assert.equal(formatHistoryReadiness({ status: "green" }), "Green");
  assert.equal(formatHistoryReadiness({ status: "unknown" }), "Yellow", "unknown status reads as yellow");

  assert.deepEqual(
    getHistorySessionNotes({ sessionNotes: "a", workoutNote: "b", note: " a ", recoveryNotes: "c", exercises: [{ notes: "d" }, null, { notes: "" }] }),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(getHistorySessionNotes({}), []);

  assert.equal(getLegacyExerciseCount({ analytics: { exerciseCount: 3 }, exercises: [1] }), 3);
  assert.equal(getLegacyExerciseCount({ exercises: [1, 2] }), 2);
  assert.equal(getLegacyExerciseCount({ exercises: { a: {}, b: {}, c: {} } }), 3);
  assert.equal(getLegacyExerciseCount({}), 0);

  assert.equal(formatHistoryWeight(60), "60kg");
  assert.equal(formatHistoryWeight(62.5), "62.5kg");
  assert.equal(formatHistoryWeight("BW"), "BW");
  assert.equal(formatHistoryWeight(null), "-");
  assert.equal(formatHistoryWeight(undefined), "-");

  assert.equal(formatHistoryDateTime(null), "No date");
  assert.equal(formatHistoryDateTime("bad"), "No date");
  assert.ok(formatHistoryDateTime("2026-09-20T10:00:00.000Z").includes("2026"));

  assert.deepEqual(buildHistoryExerciseGroups([]), []);
  const grouped = buildHistoryExerciseGroups([
    { exerciseName: "Curl", setNumber: 2, reps: 10, weight: 12, rpe: 8 },
    { exerciseName: "Curl", setNumber: 1, reps: 12, weight: 10, rpe: null },
  ]);
  assert.equal(grouped.length, 1, "sets without ids group by exercise name");
  assert.equal(grouped[0].key, "Curl");
  assert.deepEqual(grouped[0].sets.map((set) => set.setNumber), [1, 2]);
  assert.equal(grouped[0].totalVolume, 240);
  assert.equal(grouped[0].averageRpe, 8, "blank RPE is left out of the average");

  // ------------------------------------------------------------------
  // Program name fallback (decision new-F: archived programs keep their name)
  // ------------------------------------------------------------------
  assert.equal(resolveHistoryProgramName({}, []), null);
  assert.equal(resolveHistoryProgramName({ programId: "missing" }, []), null);
  seedDefaultProgramIfNeeded();
  const defaultProgram = getPrograms({ includeArchived: true }).find((program) => program.id === DEFAULT_PROGRAM_ID);
  const expectedName = defaultProgram.nickname || defaultProgram.name;
  assert.ok(expectedName);
  assert.equal(resolveHistoryProgramName({ programId: DEFAULT_PROGRAM_ID }, []), expectedName);
  assert.equal(resolveHistoryProgramName({}, [{ programId: DEFAULT_PROGRAM_ID }]), expectedName, "the program id of a set is used when the session has none");
  assert.equal(buildHistorySessionSummary({ id: "n", programId: DEFAULT_PROGRAM_ID }, lookup).programName, expectedName);

  const storedPrograms = readStorage(STORAGE_KEYS.programs, []);
  const archived = { ...defaultProgram, id: "archived-program", name: "Old Block", nickname: "", isArchived: true };
  assert.equal(writeStorage(STORAGE_KEYS.programs, [...storedPrograms, archived]).ok, true);
  assert.ok(!getPrograms().some((program) => program.id === "archived-program"), "archived programs are hidden from the default list");
  assert.equal(resolveHistoryProgramName({ programId: "archived-program" }, []), "Old Block", "an archived program keeps its name in history");

  // ------------------------------------------------------------------
  // The page uses the module; nothing is defined twice
  // ------------------------------------------------------------------
  const page = readFileSync(path.join(root, "src/pages/HistoryPage.jsx"), "utf8");
  assert.ok(page.includes('from "../lib/historyView.js";'), "HistoryPage imports the view model");
  assert.ok(!/^function (build|get|is|resolve|format)[A-Za-z]*\(/m.test(page), "HistoryPage defines no pure helper itself");
  const copySource = readFileSync(path.join(root, "src/components/readiness/readinessCopy.js"), "utf8");
  for (const label of ["Green", "Yellow", "Red"]) {
    assert.ok(copySource.includes(`label: "${label}"`), `the UI readiness copy still names ${label}`);
  }

  console.log("verify-history-view: ok");
} catch (error) {
  console.error("verify-history-view: FAIL");
  console.error(error);
  process.exit(1);
}
