// Session-plan adherence versus partial logging (Phase H5, decision H5-9).
//
// A saved session carries its own `plannedExercises` snapshot (the resolved
// prescription it was logged against, decision 19.4-2 / H4-14). Adherence is
// measured against THAT snapshot, never against the current plan or targets:
// editing a program later never changes how complete an old session was.
//
// This module only exposes the measure. How the engine weighs a "minimal"
// session is Track A's decision inside src/lib/progression.js (evidence
// weight); the recommended reading is: a `minimal` session is not a failed
// session and never a reason to reduce load on its own - it is thin evidence,
// so the engine should keep (hold) the targets it was logged against and wait
// for a fuller session before progressing or reducing. `partial` sessions are
// evidence for the exercises that were logged and nothing for the skipped
// ones. Fixture: scripts/verify-adherence.mjs.
import { numberValue } from "./sessionNormalize.js";

export const ADHERENCE_THRESHOLDS = Object.freeze({ complete: 0.9, partial: 0.5 });
export const ADHERENCE_STATUSES = Object.freeze(["complete", "partial", "minimal", "unplanned"]);

function isLoggedSet(set) {
  const value = numberValue(
    set?.actualReps ??
      set?.reps ??
      set?.actualSeconds ??
      set?.seconds ??
      set?.actualMeters ??
      set?.meters ??
      set?.actualValue ??
      set?.value,
    null,
  );

  return value !== null && value > 0;
}

/**
 * Logged (completed) set count per exercise key of a session: modern
 * `workoutSets` (keyed by programExerciseId, falling back to exerciseId) or
 * the legacy `exercises` map / array. A set counts when it has a positive
 * reps / seconds / meters value; an untouched slot or a 0-rep attempt does not.
 */
export function countLoggedSetsByExercise(session) {
  const counts = new Map();
  const add = (key) => {
    if (key === null || key === undefined || key === "") {
      return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  if (Array.isArray(session?.workoutSets) && session.workoutSets.length) {
    session.workoutSets.forEach((set) => {
      if (isLoggedSet(set)) {
        add(set.programExerciseId ?? set.exerciseId ?? null);
      }
    });
    return counts;
  }

  const legacyEntries = Array.isArray(session?.exercises)
    ? session.exercises.map((log, index) => [
        log?.programExerciseId ?? log?.exerciseId ?? log?.id ?? log?.name ?? `exercise-${index + 1}`,
        log,
      ])
    : Object.entries(session?.exercises ?? {});

  legacyEntries.forEach(([key, log]) => {
    const sets = Array.isArray(log?.sets) ? log.sets : [];
    sets.forEach((set) => {
      if (isLoggedSet(set)) {
        add(log?.programExerciseId ?? key);
      }
    });
  });

  return counts;
}

function resolveExerciseName(id, planned, exercises, session) {
  const fromPlan = planned?.name;
  if (fromPlan) {
    return String(fromPlan);
  }

  const match = (exercises ?? []).find(
    (exercise) => (exercise?.programExerciseId ?? exercise?.id) === id,
  );
  if (match?.name) {
    return match.name;
  }

  const log = Array.isArray(session?.exercises)
    ? session.exercises.find((entry) => (entry?.programExerciseId ?? entry?.id) === id)
    : session?.exercises?.[id];

  return log?.name ?? log?.exerciseName ?? String(id);
}

/**
 * computeSessionAdherence({ session, plannedExercises, exercises }) ->
 *   { plannedSets, completedSets, countedSets, plannedExercises, loggedExercises,
 *     skippedExercises: [{ programExerciseId, name }],
 *     partialExercises: [{ programExerciseId, name, plannedSets, completedSets }],
 *     unplannedExercises, ratio (0-1 | null), status }
 *
 * plannedExercises: the session's own snapshot (default `session.plannedExercises`),
 *   keyed by programExerciseId -> { sets, ... }.
 * exercises: optional day view models, only used to name skipped exercises.
 *
 * ratio = sum over planned exercises of min(logged, planned) / planned sets:
 * extra sets on one exercise never cover a skipped one. `completedSets` is the
 * raw logged count of the planned exercises. status: complete (>= 0.9),
 * partial (0.5-0.9), minimal (< 0.5), unplanned (no snapshot or no planned sets).
 */
export function computeSessionAdherence({ session, plannedExercises, exercises = [] } = {}) {
  const snapshot =
    plannedExercises && typeof plannedExercises === "object"
      ? plannedExercises
      : session?.plannedExercises && typeof session.plannedExercises === "object"
        ? session.plannedExercises
        : null;
  const logged = countLoggedSetsByExercise(session);
  const entries = Object.entries(snapshot ?? {}).filter(([, planned]) => planned && typeof planned === "object");
  const totalLogged = [...logged.values()].reduce((total, count) => total + count, 0);

  let plannedSets = 0;
  let completedSets = 0;
  let countedSets = 0;
  let loggedExercises = 0;
  const skippedExercises = [];
  const partialExercises = [];

  entries.forEach(([id, planned]) => {
    const plannedCount = Math.max(0, numberValue(planned.sets, 0));
    const loggedCount = logged.get(id) ?? 0;
    const name = resolveExerciseName(id, planned, exercises, session);

    plannedSets += plannedCount;
    completedSets += loggedCount;
    countedSets += Math.min(loggedCount, plannedCount);

    if (loggedCount > 0) {
      loggedExercises += 1;
    }

    if (plannedCount > 0 && loggedCount === 0) {
      skippedExercises.push({ programExerciseId: id, name });
    } else if (plannedCount > 0 && loggedCount < plannedCount) {
      partialExercises.push({
        programExerciseId: id,
        name,
        plannedSets: plannedCount,
        completedSets: loggedCount,
      });
    }
  });

  const plannedIds = new Set(entries.map(([id]) => id));
  const unplannedExercises = [...logged.keys()].filter((key) => !plannedIds.has(key)).length;

  if (!snapshot || plannedSets === 0) {
    return {
      plannedSets,
      completedSets: snapshot ? completedSets : totalLogged,
      countedSets: 0,
      plannedExercises: entries.length,
      loggedExercises: snapshot ? loggedExercises : logged.size,
      skippedExercises,
      partialExercises,
      unplannedExercises,
      ratio: null,
      status: "unplanned",
    };
  }

  const ratio = Math.min(1, countedSets / plannedSets);
  const status =
    ratio >= ADHERENCE_THRESHOLDS.complete
      ? "complete"
      : ratio >= ADHERENCE_THRESHOLDS.partial
        ? "partial"
        : "minimal";

  return {
    plannedSets,
    completedSets,
    countedSets,
    plannedExercises: entries.length,
    loggedExercises,
    skippedExercises,
    partialExercises,
    unplannedExercises,
    ratio,
    status,
  };
}

export function isPartialSession(adherence) {
  return adherence?.status === "partial" || adherence?.status === "minimal";
}

/**
 * The recap line (H5-9). `keptTargets` says whether the generated next plan
 * kept the prescription the session was logged against (the recap decides
 * it by comparing the plan with the snapshot).
 */
export function describeSessionAdherence(adherence, { keptTargets = true } = {}) {
  if (!adherence || adherence.status === "unplanned") {
    return "Unplanned session: no plan snapshot to compare against.";
  }

  if (adherence.status === "complete") {
    return `Full session: ${adherence.countedSets} of ${adherence.plannedSets} planned sets.`;
  }

  const skipped = adherence.skippedExercises.map((exercise) => exercise.name).filter(Boolean);
  const base = `Partial session (${adherence.countedSets} of ${adherence.plannedSets} planned sets): ${keptTargets ? "coach kept targets" : "coach adjusted the logged exercises only"}`;

  return skipped.length ? `${base}. Skipped: ${skipped.join(", ")}.` : `${base}.`;
}

/**
 * computeAdherenceTrend(sessions, days = 28, now = Date.now()) ->
 *   { days, sessionCount, plannedSessionCount, averageRatio,
 *     statusCounts: { complete, partial, minimal, unplanned },
 *     mostSkipped: [{ programExerciseId, name, count }] }
 *
 * Rolling window (now - days, now]; the average is over planned sessions only.
 */
export function computeAdherenceTrend(sessions, days = 28, now = Date.now()) {
  const windowMs = days * 24 * 60 * 60 * 1000;
  const statusCounts = { complete: 0, partial: 0, minimal: 0, unplanned: 0 };
  const skippedCounts = new Map();
  const ratios = [];
  let sessionCount = 0;

  (sessions ?? []).forEach((session) => {
    const time = new Date(session?.date ?? "").getTime();
    if (!Number.isFinite(time) || time <= now - windowMs || time > now) {
      return;
    }

    sessionCount += 1;
    const adherence = computeSessionAdherence({ session });
    statusCounts[adherence.status] += 1;

    if (adherence.ratio !== null) {
      ratios.push(adherence.ratio);
    }

    adherence.skippedExercises.forEach((exercise) => {
      const current = skippedCounts.get(exercise.programExerciseId) ?? {
        programExerciseId: exercise.programExerciseId,
        name: exercise.name,
        count: 0,
      };
      current.count += 1;
      skippedCounts.set(exercise.programExerciseId, current);
    });
  });

  return {
    days,
    sessionCount,
    plannedSessionCount: ratios.length,
    averageRatio: ratios.length
      ? ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length
      : null,
    statusCounts,
    mostSkipped: [...skippedCounts.values()].sort((left, right) => right.count - left.count).slice(0, 3),
  };
}

// Hold / override / deload wording hooks (H5-10). Track A's prescription
// resolver labels a resolved value with strings such as "Held by you",
// "Manual override" and "deload"; the snapshot and the plan carry them on
// their source fields. This reader matches those labels only, never the
// engine's own `decision: "hold"` and never its reason prose (H5 fix round
// 1: "Control held all the way ..." is a load increase, not a user hold).
// The resolver's bare source value "override" names a hold AND a manual
// record (H5-6), so it is not a manual-override marker by itself: a manual
// override is `overrideMode: "manual"`, the label "Manual override" or a
// bare "manual" source value.
const HELD_PATTERN = /held by you|on hold|user hold|^hold$/i;
const OVERRIDE_PATTERN = /manual override|^manual$/i;
const DELOAD_PATTERN = /deload/i;
const SOURCE_FIELDS = [
  "prescriptionSource",
  "source",
  "sourceLabel",
  "sourceDetail",
  "status",
  "holdReason",
  "coachStatus",
  "overrideReason",
  "overrideMode",
  "deloadLevel",
  "planStatus",
];

function collectSourceStrings(entry) {
  if (!entry || typeof entry !== "object") {
    return [];
  }

  const strings = SOURCE_FIELDS.map((field) => entry[field])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  // The engine's frozen plan entries (H5-6 / H5-7) carry the reason text
  // ("Held by you", "Logged during a deload ...") as their first reason.
  const firstReason = Array.isArray(entry.reasons) ? entry.reasons[0] : null;
  if (typeof firstReason === "string" && firstReason.trim()) {
    strings.push(firstReason.trim());
  }

  return strings;
}

/**
 * getSessionCoachStatus(session, plan = null) ->
 *   { held: [programExerciseId], overridden: [programExerciseId], deload: boolean, sources: [string] }
 *
 * Reads the session's plannedExercises snapshot (what it was logged against)
 * and, when given, the plan generated from it: the engine's `held` /
 * `overrideMode` / `deloadSession` flags and the strings "Held by you",
 * "Manual override" / "On hold" and "deload".
 */
export function getSessionCoachStatus(session, plan = null) {
  const held = new Set();
  const overridden = new Set();
  const sources = new Set();
  let deload = false;

  const inspect = (id, entry) => {
    const isHeld = Boolean(entry && typeof entry === "object" && (entry.held === true || entry.overrideMode === "hold"));
    collectSourceStrings(entry).forEach((text) => {
      sources.add(text);
      if (HELD_PATTERN.test(text)) held.add(id);
      // A held exercise is never also "overridden": the hold IS its override.
      if (!isHeld && OVERRIDE_PATTERN.test(text)) overridden.add(id);
      if (DELOAD_PATTERN.test(text)) deload = true;
    });
    if (entry && typeof entry === "object") {
      if (isHeld) held.add(id);
      if (entry.overrideMode === "manual") overridden.add(id);
      if (entry.deloadSession === true || entry.deload === true) deload = true;
    }
  };

  Object.entries(session?.plannedExercises ?? {}).forEach(([id, planned]) => {
    inspect(id, planned);
  });
  inspect("session", session);

  if (plan) {
    inspect("plan", plan);
    (plan.exercises ?? []).forEach((exercise) => {
      inspect(exercise?.exerciseId ?? exercise?.programExerciseId ?? "plan", exercise);
    });
  }

  held.delete("session");
  held.delete("plan");
  overridden.delete("session");
  overridden.delete("plan");

  return { held: [...held], overridden: [...overridden], deload, sources: [...sources] };
}
