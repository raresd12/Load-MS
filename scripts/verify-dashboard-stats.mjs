// H4 fix round 3, decision H4-15: the Dashboard numbers moved from
// src/pages/DashboardPage.jsx to src/lib/workoutRecap.js.
// - last-session metrics: completed sets and kg volume (BW sets count as a
//   set, add no volume), any saved session shape;
// - last 7 days: sessions whose date is within 7 x 24 h of `now` (inclusive),
//   sessions without a readable date are left out, average session RPE over
//   the sessions that have one, null when none has.
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
const { buildDashboardWeekStats, getDashboardSessionMetrics } = await import("../src/lib/workoutRecap.js");

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (daysAgo, extraMs = 0) => new Date(NOW - daysAgo * DAY_MS - extraMs).toISOString();

function workoutSet(programExerciseId, setNumber, reps, weight, rpe) {
  return {
    programId: "p1",
    dayId: "d1",
    programExerciseId,
    exerciseId: `lib-${programExerciseId}`,
    setNumber,
    actualWeight: weight,
    actualReps: reps,
    actualRPE: rpe,
    completed: reps !== null && weight !== null && rpe !== null,
  };
}

function session(id, date, sessionRpe, workoutSets) {
  return { id, schemaVersion: 6, date, programId: "p1", dayId: "d1", sessionRpe, exercises: {}, workoutSets };
}

const today = session("today", at(0), 8, [
  workoutSet("bench", 1, 8, 60, 8),
  workoutSet("bench", 2, 7, 60, 8.5),
  workoutSet("bench", 3, null, null, null),
  workoutSet("pull", 1, 10, "BW", 7),
]);
const threeDaysAgo = session("three", at(3), 7, [workoutSet("squat", 1, 5, 100, 8)]);
const exactlySeven = session("seven", at(7), null, [workoutSet("row", 1, 10, 50, 8)]);
const justOver = session("over", at(7, 1), 9, [workoutSet("row", 1, 10, 50, 8)]);
const undated = session("undated", "not a date", 9, [workoutSet("row", 1, 10, 50, 8)]);
const legacy = {
  id: "legacy",
  date: at(1),
  exercises: { "bench-press": { sets: [{ reps: "6", weight: "80", rpe: "8" }] } },
};

try {
  assert.deepEqual(getDashboardSessionMetrics(today), { setCount: 3, volume: 900 });
  assert.deepEqual(getDashboardSessionMetrics(legacy), { setCount: 1, volume: 480 }, "a legacy keyed session is readable");
  assert.deepEqual(getDashboardSessionMetrics({ id: "empty" }), { setCount: 0, volume: 0 });

  assert.deepEqual(buildDashboardWeekStats([], NOW), { workouts: 0, setCount: 0, volume: 0, averageRpe: null });

  const all = [today, threeDaysAgo, exactlySeven, justOver, undated, legacy];
  const before = JSON.stringify(all);
  assert.deepEqual(buildDashboardWeekStats(all, NOW), {
    workouts: 4,
    setCount: 3 + 1 + 1 + 1,
    volume: 900 + 500 + 500 + 480,
    averageRpe: 7.5,
  });
  assert.equal(JSON.stringify(all), before, "sessions are not mutated");

  assert.equal(buildDashboardWeekStats([exactlySeven], NOW).workouts, 1, "exactly 7 days old still counts");
  assert.equal(buildDashboardWeekStats([justOver], NOW).workouts, 0, "one millisecond over 7 days does not");
  assert.equal(buildDashboardWeekStats([undated], NOW).workouts, 0, "a session without a readable date is left out");
  assert.equal(buildDashboardWeekStats([exactlySeven, legacy], NOW).averageRpe, null, "no session RPE: no average");
  assert.equal(buildDashboardWeekStats([{ ...threeDaysAgo, sessionRpe: "7.5" }, today], NOW).averageRpe, 7.75, "a stored text RPE is read");

  // Two sessions of the same day on the same date are two workouts (H4-14).
  assert.deepEqual(buildDashboardWeekStats([today, { ...today, id: "again" }], NOW), {
    workouts: 2,
    setCount: 6,
    volume: 1800,
    averageRpe: 8,
  });

  // Default clock: a session saved now is inside the window.
  assert.equal(buildDashboardWeekStats([session("now", new Date().toISOString(), 8, [])]).workouts, 1);

  const page = readFileSync(path.join(root, "src/pages/DashboardPage.jsx"), "utf8");
  assert.ok(
    page.includes('import { buildDashboardWeekStats, getDashboardSessionMetrics } from "../lib/workoutRecap.js";'),
    "DashboardPage imports the builders",
  );
  assert.ok(!/^function (build|get)Dashboard/m.test(page), "DashboardPage defines no Dashboard builder itself");
  assert.ok(page.includes("buildDashboardWeekStats(sessions)"), "the page uses the real clock");

  console.log("verify-dashboard-stats: ok");
} catch (error) {
  console.error("verify-dashboard-stats: FAIL");
  console.error(error);
  process.exit(1);
}
