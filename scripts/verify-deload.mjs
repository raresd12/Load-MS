// Phase H5 Track A, decision H5-7: fatigue observation and the applied
// deload. evaluateDeloadNeed is deterministic (explicit `now`), suggests
// only with enough data, and an applied deload scales the resolved
// prescription without ever compounding into the stored progression.
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

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };
console.warn = () => {};

const { readStorage, STORAGE_KEYS } = await import("../src/lib/storage.js");
const {
  DEFAULT_PROGRAM_ID,
  duplicateProgram,
  getProgramBaseline,
  getProgramDays,
  getProgramDayViewModels,
  getProgramProgression,
  getProgramState,
  getPrograms,
  persistWorkoutSave,
  seedDefaultProgramIfNeeded,
  updateProgramStateChecked,
} = await import("../src/lib/programStorage.js");
const {
  applyDeloadToPrescription,
  applyProgramDeload,
  consumeDeloadSession,
  DELOAD_LEVELS,
  DELOAD_REQUIRED_CHECK_INS,
  DELOAD_REQUIRED_SESSIONS,
  DELOAD_WINDOW_DAYS,
  describeDeload,
  dismissDeloadSuggestion,
  endProgramDeload,
  evaluateDeloadNeed,
  getProgramDeload,
} = await import("../src/lib/deload.js");
const { resolvePrescription } = await import("../src/lib/prescription.js");
const { buildExerciseProfile, DELOAD_FACTORS, generateNextPlan, isDeloadActive } = await import("../src/lib/progression.js");

assert.deepEqual([...DELOAD_LEVELS], ["lighter_week", "deload"]);
assert.deepEqual(DELOAD_FACTORS, { lighter_week: 0.9, deload: 0.85 });
assert.equal(DELOAD_WINDOW_DAYS, 21);
assert.equal(DELOAD_REQUIRED_SESSIONS, 6);
assert.equal(DELOAD_REQUIRED_CHECK_INS, 4);
assert.equal(isDeloadActive({ level: "deload", remainingSessions: 1 }), true);
assert.equal(isDeloadActive({ level: "deload", remainingSessions: 0 }), false);
assert.equal(isDeloadActive({ level: "bogus", remainingSessions: 2 }), false);
assert.equal(isDeloadActive(null), false);
assert.equal(describeDeload({ level: "lighter_week", remainingSessions: 2 }), "Lighter week (2 sessions left)");
assert.equal(describeDeload({ level: "deload", remainingSessions: 1 }), "Deload (1 session left)");
assert.equal(describeDeload(null), "");
assert.deepEqual(consumeDeloadSession({ level: "deload", remainingSessions: 2 }), { level: "deload", remainingSessions: 1 });
assert.equal(consumeDeloadSession({ level: "deload", remainingSessions: 1 }), null);

seedDefaultProgramIfNeeded();
const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
const programId = copy.programId;
const program = getPrograms().find((entry) => entry.id === programId);
const days = getProgramDayViewModels(programId);
const day = days[0];
const main = day.exercises.find((entry) => /bench/i.test(entry.name)) ?? day.exercises[0];
const accessory = day.exercises.find((entry) => entry.id !== main.id && entry.sets > 1 && buildExerciseProfile(entry).role === "accessory");
assert.ok(main && accessory);

const NOW = "2026-09-30T18:00:00.000Z";

function session(id, daysAgo, { sessionRpe = 7, dayId = day.id, painFlag = false, mainWeight = 60, mainReps = 8 } = {}) {
  const date = new Date(Date.parse(NOW) - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    id,
    schemaVersion: 6,
    programId,
    dayId,
    date,
    sessionRpe,
    readiness: { status: "green", averageScore: 4, isGood: true, isPoor: false },
    plannedExercises: {
      exercises: Object.fromEntries(
        day.exercises.map((entry) => [
          entry.id,
          { sets: entry.sets, repsMin: entry.repsMin, repsMax: entry.repsMax, repsLabel: entry.repsLabel, targetRPE: entry.targetRPE, recommendedWeight: entry.recommendedWeight, restSeconds: entry.restSeconds },
        ]),
      ),
    },
    exercises: {
      [main.id]: {
        programExerciseId: main.id,
        exerciseId: main.exerciseId,
        exerciseRPE: sessionRpe,
        painFlag,
        sets: Array.from({ length: main.sets }, () => ({ reps: mainReps, weight: mainWeight, rpe: sessionRpe })),
      },
      [accessory.id]: {
        programExerciseId: accessory.id,
        exerciseId: accessory.exerciseId,
        exerciseRPE: sessionRpe,
        sets: Array.from({ length: accessory.sets }, () => ({ reps: accessory.repsMax, weight: 20, rpe: sessionRpe })),
      },
    },
    workoutSets: [],
  };
}

function checkIns(statuses) {
  return Object.fromEntries(
    statuses.map((status, index) => {
      const date = new Date(Date.parse(NOW) - index * 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return [date, { readiness: { status } }];
    }),
  );
}

// --- not enough data ------------------------------------------------------------
const few = evaluateDeloadNeed({ program, days, sessions: [session("a", 1, { sessionRpe: 9.5 }), session("b", 3, { sessionRpe: 9.5 }), session("c", 5, { sessionRpe: 9.5 })], readinessByDate: checkIns(["red", "red", "red"]), now: NOW });
assert.equal(few.eligible, false);
assert.equal(few.suggest, false);
assert.deepEqual(few.sampleSize, { sessions: 3, checkIns: 3 });
assert.deepEqual(few.requiredSampleSize, { sessions: 6, checkIns: 4 });
assert.match(few.reasons[0], /Not enough data yet: 3 of 6 sessions and 3 of 4 readiness check-ins/);

// Sessions outside the 21-day window and of other programs do not count.
const stale = [1, 3, 5, 25, 27, 29].map((daysAgo, index) => session(`s${index}`, daysAgo, { sessionRpe: 9 }));
const foreign = { ...session("x", 2, { sessionRpe: 9 }), programId: DEFAULT_PROGRAM_ID };
assert.equal(evaluateDeloadNeed({ program, days, sessions: [...stale, foreign], readinessByDate: checkIns(["red", "red", "red", "red"]), now: NOW }).sampleSize.sessions, 3);

// --- eligible, no signal ----------------------------------------------------------
const calm = [1, 4, 7, 10, 13, 16].map((daysAgo, index) => session(`c${index}`, daysAgo, { sessionRpe: 7 }));
const noSignal = evaluateDeloadNeed({ program, days, sessions: calm, readinessByDate: checkIns(["green", "green", "yellow", "green"]), now: NOW });
assert.equal(noSignal.eligible, true);
assert.equal(noSignal.suggest, false);
assert.equal(noSignal.level, null);
assert.deepEqual(noSignal.signals.map((signal) => signal.met), [false, false, false, false]);
assert.match(noSignal.reasons.at(-1), /0 of 4 fatigue observations/);

// --- two signals: lighter week ----------------------------------------------------
const hard = [1, 4, 7, 10, 13, 16].map((daysAgo, index) => session(`h${index}`, daysAgo, { sessionRpe: index < 3 ? 9 : 7 }));
const redWeek = checkIns(["red", "red", "green", "red", "green"]);
const lighter = evaluateDeloadNeed({ program, days, sessions: hard, readinessByDate: redWeek, now: NOW });
assert.equal(lighter.eligible, true);
assert.equal(lighter.suggest, true);
assert.equal(lighter.level, "lighter_week");
assert.deepEqual(lighter.signals.filter((signal) => signal.met).map((signal) => signal.key), ["high_session_rpe", "red_readiness"]);
assert.equal(lighter.reasons.length, 2);
assert.match(lighter.reasons[0], /Session RPE was 9 or higher in 3 of the last 4 sessions/);
assert.match(lighter.reasons[1], /Readiness was red in 3 of the last 5 check-ins/);
assert.equal(lighter.signals.find((signal) => signal.key === "regressing_main_lifts").met, false);

// One signal only is not a suggestion.
assert.equal(evaluateDeloadNeed({ program, days, sessions: hard, readinessByDate: checkIns(["green", "green", "green", "green"]), now: NOW }).suggest, false);

// --- three signals: deload ------------------------------------------------------------
const painful = hard.map((entry, index) => (index < 2 ? { ...entry, exercises: { ...entry.exercises, [main.id]: { ...entry.exercises[main.id], painFlag: true } } } : entry));
const full = evaluateDeloadNeed({ program, days, sessions: painful, readinessByDate: redWeek, now: NOW });
assert.equal(full.suggest, true);
assert.equal(full.level, "deload");
assert.equal(full.signals.find((signal) => signal.key === "pain_flags").met, true);

// The regression signal: two main lifts trending down over 3 comparable sessions.
const second = day.exercises.find((entry) => entry.id !== main.id && entry.id !== accessory.id && /row|press|squat|deadlift|pull/i.test(entry.name));
if (second) {
  const regressing = [1, 4, 7, 10, 13, 16].map((daysAgo, index) => {
    const entry = session(`r${index}`, daysAgo, { sessionRpe: 8.5, mainReps: 8 - Math.min(index, 3) });
    entry.exercises[second.id] = {
      programExerciseId: second.id,
      exerciseId: second.exerciseId,
      exerciseRPE: 8.5,
      sets: Array.from({ length: second.sets }, () => ({ reps: second.repsMax - Math.min(index, 3), weight: 40, rpe: 8.5 })),
    };
    return entry;
  });
  // The most recent session has the fewest reps at the same load.
  regressing.forEach((entry, index) => {
    entry.exercises[main.id].sets = entry.exercises[main.id].sets.map(() => ({ reps: 4 + index, weight: 60, rpe: 8.5 }));
    entry.exercises[second.id].sets = entry.exercises[second.id].sets.map(() => ({ reps: 4 + index, weight: 40, rpe: 8.5 }));
  });
  const regressionResult = evaluateDeloadNeed({ program, days, sessions: regressing, readinessByDate: checkIns(["green", "green", "green", "green"]), now: NOW });
  const regressionSignal = regressionResult.signals.find((signal) => signal.key === "regressing_main_lifts");
  assert.equal(regressionSignal.met, true, regressionSignal.detail);
  assert.match(regressionSignal.detail, /2 main exercises are trending down/);
}

// --- dismissal: suppressed for 7 days unless a new signal appears -------------------
assert.equal(applyProgramDeload({ programId, level: "sideways" }).ok, false);
assert.equal(applyProgramDeload({ programId, level: "deload", sessions: 5 }).ok, false);
assert.equal(applyProgramDeload({ level: "deload" }).ok, false);
const dismissed = dismissDeloadSuggestion(programId, { signals: lighter.signals.filter((signal) => signal.met), now: NOW });
assert.equal(dismissed.ok, true);
assert.deepEqual(dismissed.state.deloadSuggestion, { dismissedAt: NOW, signals: ["high_session_rpe", "red_readiness"] });
const suppressed = evaluateDeloadNeed({ program, days, sessions: hard, readinessByDate: redWeek, now: "2026-10-03T18:00:00.000Z", state: getProgramState(programId) });
assert.equal(suppressed.suggest, false);
assert.equal(suppressed.suppressed, true);
assert.equal(suppressed.level, "lighter_week", "the level is still reported");
assert.match(suppressed.reasons.at(-1), /dismissed less than 7 days ago/);
const later = evaluateDeloadNeed({ program, days, sessions: hard.map((entry) => ({ ...entry, date: new Date(Date.parse(entry.date) + 8 * 24 * 60 * 60 * 1000).toISOString() })), readinessByDate: checkIns(["red", "red", "green", "red", "green"]), now: "2026-10-08T18:00:00.000Z", state: getProgramState(programId) });
assert.equal(later.suppressed, false, "after 7 days the suggestion is back");
const newSignal = evaluateDeloadNeed({ program, days, sessions: painful, readinessByDate: redWeek, now: "2026-10-03T18:00:00.000Z", state: getProgramState(programId) });
assert.equal(newSignal.suppressed, false, "a signal that was not met at dismissal re-suggests");
assert.equal(newSignal.suggest, true);
assert.equal(newSignal.level, "deload");

// --- applied deload ---------------------------------------------------------------------
assert.equal(getProgramDeload(programId), null);
const applied = applyProgramDeload({ programId, level: "lighter_week", sessions: 2, now: NOW });
assert.equal(applied.ok, true);
assert.deepEqual(applied.state.deload, { level: "lighter_week", remainingSessions: 2, totalSessions: 2, startedAt: NOW });
assert.deepEqual(getProgramDeload(programId), applied.state.deload);
assert.equal(applied.state.deloadSuggestion.dismissedAt, NOW, "the rest of the state is kept");
const whileActive = evaluateDeloadNeed({ program, days, sessions: hard, readinessByDate: redWeek, now: "2026-10-08T18:00:00.000Z", state: getProgramState(programId) });
assert.equal(whileActive.active, true);
assert.equal(whileActive.suggest, false, "no suggestion while one is running");

// The view models carry it; the resolver scales the resolved values.
const deloadDays = getProgramDayViewModels(programId);
assert.deepEqual(deloadDays[0].deload, applied.state.deload);
const mainVm = deloadDays[0].exercises.find((entry) => entry.id === main.id);
const accessoryVm = deloadDays[0].exercises.find((entry) => entry.id === accessory.id);
assert.deepEqual(mainVm.deload, applied.state.deload);
const scaledMain = resolvePrescription({ programExercise: mainVm, progression: { programId, programExerciseId: main.id, sourceSessionId: "earned", lastRecommendedWeight: 100, lastRecommendedSets: 4, updatedAt: NOW }, baseline: getProgramBaseline(programId, main.id) });
assert.equal(scaledMain.weight, 90, "100 kg x 0.9");
assert.equal(scaledMain.sets, 4, "a main lift keeps its sets");
assert.equal(scaledMain.deload.baseWeight, 100);
assert.equal(scaledMain.deload.factor, 0.9);
assert.equal(scaledMain.deload.setsReduced, false);
assert.equal(scaledMain.deload.remainingSessions, 2);
assert.match(scaledMain.sourceDetail, /Lighter week \(2 sessions left\): load 10% lighter\.$/);
const scaledAccessory = resolvePrescription({ programExercise: accessoryVm, progression: { programId, programExerciseId: accessory.id, sourceSessionId: "earned", lastRecommendedWeight: 20, lastRecommendedSets: accessory.sets, updatedAt: NOW }, baseline: getProgramBaseline(programId, accessory.id) });
assert.equal(scaledAccessory.sets, accessory.sets - 1, "one set off an accessory");
assert.equal(scaledAccessory.deload.setsReduced, true);
assert.match(scaledAccessory.sourceDetail, /one accessory set off/);
assert.equal(resolvePrescription({ programExercise: mainVm, deload: null }).deload, null, "an explicit null deload argument wins");
const scaledStrict = applyDeloadToPrescription({ weight: 100, sets: 3, exercise: { ...mainVm, roundToKg: 2.5 }, deload: { level: "deload", remainingSessions: 3 } });
assert.equal(scaledStrict.weight, 85, "100 x 0.85 = 85");
assert.equal(applyDeloadToPrescription({ weight: 22, sets: 3, exercise: { equipment: "dumbbell", weightMode: "per dumbbell", category: "compound" }, deload: { level: "lighter_week", remainingSessions: 1 } }).weight, 20, "22 x 0.9 = 19.8 -> 20 on the dumbbell band");
assert.equal(applyDeloadToPrescription({ weight: "BW", sets: 3, exercise: mainVm, deload: applied.state.deload }).weight, "BW", "bodyweight stays");
assert.equal(applyDeloadToPrescription({ weight: 100, sets: 3, exercise: mainVm, deload: null }).weight, 100);
// A small load still gets lighter (H5-36): nearest-step rounding alone left
// 10 kg on a cable or 25 kg on a stack untouched while the detail said "load
// 10% lighter". The load goes at least one equipment step down; a load that
// is already one step says so and never claims a reduction.
{
  const lighter = { level: "lighter_week", remainingSessions: 2 };
  const scale = (weight, equipment, deload = lighter) => applyDeloadToPrescription({ weight, sets: 3, exercise: { equipment }, deload });
  [
    [10, "Cable machine", 7.5],
    [7.5, "Barbell", 5],
    [25, "Selectorized machine", 20],
    [3, "Dumbbell", 2],
    [100, "Barbell", 90],
  ].forEach(([weight, equipment, expected]) => {
    const scaled = scale(weight, equipment);
    assert.equal(scaled.weight, expected, `${equipment} ${weight} kg -> ${expected} kg`);
    assert.equal(scaled.weightUnchanged, false);
    assert.equal(scaled.baseWeight, weight);
  });
  const floorLoad = scale(2.5, "Barbell", { level: "deload", remainingSessions: 2 });
  assert.equal(floorLoad.weight, 2.5, "one step is the floor: the load is never scaled to 0");
  assert.equal(floorLoad.weightUnchanged, true);
  const smallVm = { id: "small", programId: "p-small", name: "Cable Curl", equipment: "Cable machine", sets: 3, repsMin: 10, repsMax: 12, repsLabel: "10-12", recommendedWeight: 10, role: "main", deload: lighter };
  const small = resolvePrescription({ programExercise: smallVm });
  assert.equal(small.weight, 7.5);
  assert.match(small.sourceDetail, /load 10% lighter/);
  const atFloor = resolvePrescription({ programExercise: { ...smallVm, equipment: "Barbell", recommendedWeight: 2.5 } });
  assert.equal(atFloor.weight, 2.5);
  assert.match(atFloor.sourceDetail, /load unchanged \(already at the smallest step\)/);
  assert.doesNotMatch(atFloor.sourceDetail, /% lighter/);
}

// The engine: plan status "deload", every exercise a frozen hold, no evidence.
const d1 = session("d1", 0, { sessionRpe: 6, mainWeight: 90 });
const deloadPlan = generateNextPlan(deloadDays[0], d1, hard);
assert.equal(deloadPlan.status, "deload");
assert.deepEqual(deloadPlan.deload, { level: "lighter_week", factor: 0.9, remainingSessions: 2 });
assert.ok(deloadPlan.exercises.every((entry) => entry.deloadSession === true && entry.decision === "hold"));
assert.equal(deloadPlan.exercises.find((entry) => entry.exerciseId === main.id).recommendedWeight, main.recommendedWeight, "the planned base value is repeated, not compounded");
assert.ok(deloadPlan.readinessNotes.some((note) => /logged under a lighter week/.test(note)));
assert.equal(generateNextPlan(deloadDays[0], d1, hard, { deload: null }).status, "generated", "an explicit null deload option wins");

// Saving under the deload: 2 -> 1, nothing progressed; then 1 -> cleared.
const progressionBefore = JSON.stringify(readStorage(STORAGE_KEYS.programProgressions, null));
const save1 = persistWorkoutSave({ sessions: [d1, ...hard], nextPlans: { [day.id]: deloadPlan }, workoutDrafts: {}, programId, plan: deloadPlan, programStatePatch: { lastCompletedDayId: day.id, nextRecommendedDayId: getProgramDays(programId)[1].id, lastWorkoutDate: d1.date } });
assert.equal(save1.ok, true);
assert.equal(save1.programState.deload.remainingSessions, 1);
assert.equal(getProgramDeload(programId).remainingSessions, 1);
assert.equal(JSON.stringify(readStorage(STORAGE_KEYS.programProgressions, null)), progressionBefore, "no progression written from a deload session");
assert.equal(getProgramProgression(programId, main.id)?.sourceSessionId ?? null, null, "only the duplicated base row exists");
assert.equal(JSON.stringify(readStorage(STORAGE_KEYS.sessions, null)), JSON.stringify([d1, ...hard]), "sessions stored as given");
const editSave = persistWorkoutSave({ sessions: [{ ...d1, sessionRpe: 5 }, ...hard], programId, plan: deloadPlan, programStatePatch: { lastCompletedDayId: day.id } });
assert.equal(editSave.ok, true);
assert.equal(getProgramDeload(programId).remainingSessions, 1, "an edit of the same session consumes nothing");
const d2 = session("d2", -2, { sessionRpe: 6, mainWeight: 90 });
const deloadPlan2 = generateNextPlan(getProgramDayViewModels(programId)[0], d2, [d1, ...hard]);
assert.equal(deloadPlan2.deload.remainingSessions, 1);
const save2 = persistWorkoutSave({ sessions: [d2, d1, ...hard], programId, plan: deloadPlan2, programStatePatch: { lastCompletedDayId: day.id } });
assert.equal(save2.ok, true);
assert.equal(save2.programState.deload, null, "cleared at 0");
assert.equal(getProgramDeload(programId), null);
assert.equal(getProgramDayViewModels(programId)[0].deload, null);
const afterPlan = generateNextPlan(getProgramDayViewModels(programId)[0], d2, [d1, ...hard]);
assert.equal(afterPlan.status, "generated", "the engine is back to normal after the deload");
assert.equal(resolvePrescription({ programExercise: getProgramDayViewModels(programId)[0].exercises.find((entry) => entry.id === main.id), progression: { programId, programExerciseId: main.id, sourceSessionId: "earned", lastRecommendedWeight: 100, updatedAt: NOW } }).weight, 100, "the base load never changed");

// A finished deload is remembered (H5-16): the observations it answered are
// not counted again, so the same pre-deload sessions and check-ins do not
// suggest a second deload the day after the first.
{
  const finished = getProgramState(programId);
  assert.deepEqual(finished.lastDeload, { level: "lighter_week", startedAt: NOW, endedAt: d2.date, totalSessions: 2, completedSessions: 2 });
  const dayAfter = new Date(Date.parse(d2.date) + 24 * 60 * 60 * 1000).toISOString();
  const history = [d2, d1, ...painful];
  const withoutMemory = evaluateDeloadNeed({ program, days, sessions: history, readinessByDate: redWeek, now: dayAfter, state: { ...finished, lastDeload: null, deloadSuggestion: null } });
  assert.equal(withoutMemory.suggest, true, "control: the pre-deload observations alone would suggest again");
  const afterDeload = evaluateDeloadNeed({ program, days, sessions: history, readinessByDate: redWeek, now: dayAfter, state: { ...finished, deloadSuggestion: null } });
  assert.equal(afterDeload.suggest, false, "the observations a deload answered are not suggested again");
  assert.equal(afterDeload.sinceLastDeload, true);
  assert.equal(afterDeload.sampleSize.sessions, 0, "only sessions after the deload count");
  assert.equal(afterDeload.signals.some((signal) => signal.met), false);
}

// A session logged under a deload stays "no evidence" when it is regenerated
// after the deload ended (H5-15; new-E: an edit, or the delete of a later
// session). The saved snapshot carries `deloadSession`; the current state no
// longer names a deload. Without the snapshot the 90 kg deload load would be
// written as the earned progression.
{
  const flagged = (entry) => ({
    ...entry,
    plannedExercises: {
      exercises: Object.fromEntries(Object.entries(entry.plannedExercises.exercises).map(([id, planned]) => [id, { ...planned, deloadSession: true, deloadLevel: "lighter_week" }])),
    },
  });
  const storedD1 = flagged(d1);
  const storedD2 = { ...flagged(d2), sessionNotes: "edited after the deload ended" };
  assert.equal(getProgramDayViewModels(programId)[0].deload, null, "the deload is over");
  const regenerated = generateNextPlan(getProgramDayViewModels(programId)[0], storedD2, [storedD1, ...hard]);
  assert.equal(regenerated.status, "deload", "the snapshot, not the current state, says how the session was logged");
  assert.ok(regenerated.exercises.every((entry) => entry.deloadSession === true && entry.decision === "hold"));
  assert.equal(generateNextPlan(getProgramDayViewModels(programId)[0], storedD2, [storedD1, ...hard], { deload: null }).status, "deload", "an explicit option cannot turn a deload session into evidence");
  const progressionBeforeEdit = JSON.stringify(readStorage(STORAGE_KEYS.programProgressions, null));
  const editAfter = persistWorkoutSave({ sessions: [storedD2, storedD1, ...hard], programId, plan: regenerated, programStatePatch: { lastCompletedDayId: day.id } });
  assert.equal(editAfter.ok, true);
  assert.equal(JSON.stringify(readStorage(STORAGE_KEYS.programProgressions, null)), progressionBeforeEdit, "the edit of a deload session writes no progression");
  assert.notEqual(getProgramProgression(programId, main.id)?.sourceSessionId ?? null, "d2");
  assert.equal(getProgramDeload(programId), null, "and it starts no deload");
}

// Under a deload a manual override is used as typed (H5-18): only the
// fields the coach resolved are scaled.
{
  const deload = { level: "deload", remainingSessions: 2 };
  const manual = { programId, programExerciseId: main.id, mode: "manual", remainingSessions: 2, prescription: { targetWeight: 50 } };
  const typed = resolvePrescription({ programExercise: { ...mainVm, override: manual, deload }, progression: { programId, programExerciseId: main.id, sourceSessionId: "earned", lastRecommendedWeight: 100, lastRecommendedSets: 4, updatedAt: NOW } });
  assert.equal(typed.weight, 50, "50 kg typed stays 50 kg, not 42.5");
  assert.equal(typed.source, "override");
  assert.equal(typed.deload.weightKept, true);
  assert.equal(typed.deload.baseWeight, 50);
  assert.match(typed.sourceDetail, /Deload \(2 sessions left\): your manual weight kept as typed/);
}

// Ending early and the checked state writer.
assert.equal(applyProgramDeload({ programId, level: "deload", sessions: 3, now: NOW }).ok, true);
assert.equal(getProgramDeload(programId).level, "deload");
const endedEarly = endProgramDeload(programId, { now: "2026-10-05T09:00:00.000Z" });
assert.equal(endedEarly.ok, true);
assert.equal(getProgramDeload(programId), null);
assert.deepEqual(
  { level: endedEarly.state.lastDeload.level, endedAt: endedEarly.state.lastDeload.endedAt, totalSessions: endedEarly.state.lastDeload.totalSessions },
  { level: "deload", endedAt: "2026-10-05T09:00:00.000Z", totalSessions: 3 },
  "an early end is remembered too (H5-16)",
);
assert.equal(
  evaluateDeloadNeed({ program, days, sessions: painful, readinessByDate: redWeek, now: "2026-10-05T10:00:00.000Z", state: { ...endedEarly.state, deloadSuggestion: null } }).suggest,
  false,
  "End early is not followed at once by the same suggestion",
);
assert.equal(updateProgramStateChecked(null, {}).ok, false);
storage.setItem(STORAGE_KEYS.programStates, "{not json");
const corrupt = applyProgramDeload({ programId, level: "deload", sessions: 2, now: NOW });
assert.equal(corrupt.ok, false);
assert.equal(corrupt.code, "corrupt");
assert.equal(storage.getItem(STORAGE_KEYS.programStates), "{not json", "a corrupt states key is never overwritten");

console.log("Deload (H5-7) verification passed.");
