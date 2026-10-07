// Session, "last time", Dashboard-free Progress analytics (Phase H4,
// decision H4-1). Moved verbatim from src/App.jsx: the per-session analytics
// stored on a saved session, the "Last time" / beat-last cue, and every pure
// Progress-page builder (weekly review, insight cards, exercise trends, PR /
// best-set ranking, readiness/performance analytics) plus their formatters.
// JSX components stay in App.jsx. Fixture: scripts/verify-session-analytics.mjs.
import { computeAdherenceTrend, getSessionCoachStatus } from "./adherence.js";
import { getLocalDateKey } from "./date.js";
import {
  getMeasurementProfile,
  getSetLoadForVolume,
  isValidMeasurement,
  MEASUREMENT_UNITS,
  normalizeSetEntry,
} from "./measurement.js";
import { formatRest, formatWeight, interpretWellness } from "./progression.js";
import { getProgramDayViewModels } from "./programStorage.js";
import {
  getBestComparablePerformance,
  getComparableSessionRequirement,
  MIN_COMPARABLE_SESSIONS,
} from "./readinessPerformance.js";
import { getAverageNumericWeight, getLoggedReps, normalizeWeight } from "./sessionLog.js";
import {
  calculateAutoExerciseRpe,
  getDraftSetCount,
  getExerciseLog,
  isBlank,
  numberValue,
} from "./sessionNormalize.js";

// Window of the Progress page's "recent" counters (30 days).
export const recentWorkoutWindowDays = 30;

// ---------------------------------------------------------------------------
// Measurement in the analytics (Phase H5, decisions H5-8 / H5-10). The
// schema is Track A's src/lib/measurement.js (H5-1): getMeasurementProfile,
// normalizeSetEntry and getSetLoadForVolume. The analytics read a stored set
// with the fields the set itself persists first (resolveSetMeasurementProfile)
// and keep their own "completed" rule (isCompletedAnalyticsSet) and RPE
// parsing, so a reps / external / kg session yields the pre-H5 outputs.
// ---------------------------------------------------------------------------
export const DEFAULT_MEASUREMENT_PROFILE = Object.freeze({
  measurement: "reps",
  unit: "reps",
  perSide: false,
  loadType: "external",
  weightMode: "kg",
});

/**
 * The profile a stored set is read with: the fields the set itself persists
 * (measurement, weightMode, loadType, perSide) win over the exercise profile,
 * so a weight-mode change of the program never rewrites old history.
 */
export function resolveSetMeasurementProfile(set, exerciseProfile) {
  const base = exerciseProfile ?? DEFAULT_MEASUREMENT_PROFILE;
  const measurement = isValidMeasurement(set?.measurement) ? set.measurement : base.measurement;

  return {
    measurement,
    unit: MEASUREMENT_UNITS[measurement],
    perSide: typeof set?.perSide === "boolean" ? set.perSide : Boolean(base.perSide),
    loadType: set?.loadType ?? base.loadType,
    weightMode: set?.weightMode ?? base.weightMode,
  };
}

/**
 * readMeasuredSet(set, profile) -> { measurement, value, weight, rpe, completed, tonnage }
 * measurement.js normalizeSetEntry for the measurement and value (a set that
 * only carries reps stays a reps set, H5-1), the analytics' weight / RPE
 * parsing and completed rule, and getSetLoadForVolume's tonnage.
 */
export function readMeasuredSet(set, profile) {
  const entry = normalizeSetEntry(set, profile);
  const value = entry.value;
  const weight = normalizeWeight(set?.actualWeight ?? set?.weight ?? set?.kg);
  const rpe = parseAnalyticsRpe(set?.actualRPE ?? set?.rpe);

  return {
    measurement: entry.measurement,
    value,
    weight,
    rpe,
    completed: Boolean(set?.completed) || isCompletedAnalyticsSet(value, weight, rpe),
    tonnage: getSetLoadForVolume(set, profile).tonnage,
  };
}

// e1RM eligibility (decisions H5-8 / H5-29, answers 19.4-6): the formula
// stays weight * (1 + reps / 30); a set is an e1RM RECORD candidate only when
// it is rep-based, has a numeric external or additional load, 1-10 completed
// reps and RPE >= 6 or none. The load rule is the one of
// measurement.getSetLoadForVolume (`e1rmWeight`: external or additional load,
// never bodyweight / timed / distance); this function adds the rep and RPE
// gates. Trend values keep the pre-H5 e1RM of every weighted set; the flag
// says why a set is not a record.
export const E1RM_ELIGIBILITY = Object.freeze({ minReps: 1, maxReps: 10, minRpe: 6 });

export function getE1rmEligibility({ measurement = "reps", weight, reps, rpe, loadType = "external" } = {}) {
  if (measurement !== "reps") {
    return { eligible: false, reason: `${measurement}: e1RM only for rep-based sets` };
  }

  if (typeof weight !== "number") {
    return {
      eligible: false,
      reason: weight === "BW" ? "BW: e1RM needs a numeric load" : "No load: e1RM needs a numeric load",
    };
  }

  // H5-29: "a positive numeric load" (the rule of measurement.getSetLoadForVolume).
  if (!Number.isFinite(weight) || weight <= 0) {
    return { eligible: false, reason: `${weight} kg: e1RM needs a load above 0 kg` };
  }

  if (loadType === "bodyweight") {
    return { eligible: false, reason: "bodyweight exercise: e1RM needs an external or additional load" };
  }

  if (!Number.isFinite(reps) || reps < E1RM_ELIGIBILITY.minReps || reps > E1RM_ELIGIBILITY.maxReps) {
    return {
      eligible: false,
      reason: `${Number.isFinite(reps) ? reps : "No"} reps: e1RM only for ${E1RM_ELIGIBILITY.minReps}-${E1RM_ELIGIBILITY.maxReps} reps`,
    };
  }

  if (Number.isFinite(rpe) && rpe < E1RM_ELIGIBILITY.minRpe) {
    return {
      eligible: false,
      reason: `RPE ${rpe}: e1RM needs RPE ${E1RM_ELIGIBILITY.minRpe} or higher (or no RPE)`,
    };
  }

  return { eligible: true, reason: null };
}

// Sample the deload check needs before it says anything (decision H5-10).
// Track A's deload engine owns the rule; the weekly review only reports
// whether the sample is there. Overridable through buildWeeklyReview options.
export const DELOAD_SAMPLE_REQUIREMENT = Object.freeze({ sessions: 6, windowDays: 21 });

const NOT_COMPARABLE_MEASUREMENT = "Not comparable: measurement changed.";

/**
 * Two exercise-session entries are comparable when they were logged with the
 * same measurement and the same weight mode (decision H5-10): tonnage is
 * never compared across a per-dumbbell / kg change or a reps / time change.
 * Entries without the fields (pre-H5 shapes) are comparable, as before.
 */
export function checkTrendComparability(latest, previous) {
  if (!latest || !previous) {
    return { comparable: true, reason: null };
  }

  const latestMeasurement = latest.measurement ?? "reps";
  const previousMeasurement = previous.measurement ?? "reps";
  if (latestMeasurement !== previousMeasurement) {
    return { comparable: false, reason: NOT_COMPARABLE_MEASUREMENT, changed: "measurement" };
  }

  const latestMode = latest.weightMode ?? "kg";
  const previousMode = previous.weightMode ?? "kg";
  if (latestMode !== previousMode) {
    return { comparable: false, reason: NOT_COMPARABLE_MEASUREMENT, changed: "weightMode" };
  }

  // H5 fix round 1 (decision H5-20): per side and the load type change the
  // tonnage / e1RM meaning as much as the weight mode does, so the guard is
  // symmetric with what every set now persists.
  if (Boolean(latest.perSide) !== Boolean(previous.perSide)) {
    return { comparable: false, reason: NOT_COMPARABLE_MEASUREMENT, changed: "perSide" };
  }

  if ((latest.loadType ?? "external") !== (previous.loadType ?? "external")) {
    return { comparable: false, reason: NOT_COMPARABLE_MEASUREMENT, changed: "loadType" };
  }

  return { comparable: true, reason: null };
}

// Status label of a readiness entry, as the Readiness copy in App.jsx names
// it (readinessCopy[status].label, yellow when unknown). Only the label is
// needed here, so the UI copy object itself stays in App.jsx.
const READINESS_STATUS_LABELS = Object.freeze({
  green: "Green",
  yellow: "Yellow",
  red: "Red",
});

export function getReadinessStatusLabel(readiness) {
  return READINESS_STATUS_LABELS[readiness?.status] ?? READINESS_STATUS_LABELS.yellow;
}

// Draft-shape analytics stored on the session (`session.analytics`), the
// fallback of History / Progress when a session has no workoutSets. Decision
// H5-30: a set is counted in the exercise's measurement - the count is reps,
// seconds or meters (getDraftSetCount, so a reps value typed on a timed
// exercise stays reps) - and a bodyweight / optional-load exercise needs no
// typed load. `totalReps` sums reps only; seconds and meters get their own
// totals, present only when the day logged some, so a reps + kg session
// yields the pre-H5 object key for key.
export function getSessionAnalytics(day, draft) {
  const exerciseSummaries = day.exercises.map((exercise) => {
    const draftExercise = draft.exercises[exercise.id];
    const profile = getMeasurementProfile(exercise);
    const loadOptional = profile.loadType === "bodyweight" || profile.loadType === "optionalExternal";
    const counts = draftExercise.sets.map((set) => getDraftSetCount(set, exercise));
    const completedSets = draftExercise.sets.filter(
      (set, index) => !isBlank(counts[index].value) && (loadOptional || !isBlank(set.weight)) && !isBlank(set.rpe),
    );
    const sumCount = (field) =>
      counts
        .filter((count) => count.field === field)
        .map((count) => numberValue(count.value, NaN))
        .filter(Number.isFinite)
        .reduce((total, value) => total + value, 0);
    const reps = counts
      .filter((count) => count.field === "reps")
      .map((count) => numberValue(count.value, NaN))
      .filter(Number.isFinite);
    const totalSeconds = sumCount("seconds");
    const totalMeters = sumCount("meters");
    const weights = draftExercise.sets
      .map((set) => normalizeWeight(set.weight))
      .filter((weight) => typeof weight === "number");
    const totalReps = reps.reduce((total, rep) => total + rep, 0);
    const averageWeight = weights.length
      ? weights.reduce((total, weight) => total + weight, 0) / weights.length
      : null;

    return {
      exerciseId: exercise.id,
      totalReps,
      averageWeight,
      setCount: completedSets.length,
      exerciseRPE: calculateAutoExerciseRpe(draftExercise),
      ...(totalSeconds > 0 ? { totalSeconds } : {}),
      ...(totalMeters > 0 ? { totalMeters } : {}),
    };
  });
  const totalSeconds = exerciseSummaries.reduce((total, exercise) => total + (exercise.totalSeconds ?? 0), 0);
  const totalMeters = exerciseSummaries.reduce((total, exercise) => total + (exercise.totalMeters ?? 0), 0);

  return {
    exerciseCount: day.exercises.length,
    loggedSetCount: exerciseSummaries.reduce((total, exercise) => total + exercise.setCount, 0),
    totalReps: exerciseSummaries.reduce((total, exercise) => total + exercise.totalReps, 0),
    ...(totalSeconds > 0 ? { totalSeconds } : {}),
    ...(totalMeters > 0 ? { totalMeters } : {}),
    exerciseSummaries,
  };
}

export function getLastExerciseSession(dayId, exerciseOrId, sessions) {
  const programId = typeof exerciseOrId === "string" ? null : (exerciseOrId?.programId ?? null);

  return sessions.find(
    (session) =>
      session.dayId === dayId &&
      // Sessions of another program are never "last time" for this exercise (F1).
      (!programId || !session.programId || session.programId === programId) &&
      getExerciseLog(session, exerciseOrId),
  );
}

export function getLastExerciseLog(dayId, exerciseOrId, sessions) {
  const session = getLastExerciseSession(dayId, exerciseOrId, sessions);
  return getExerciseLog(session, exerciseOrId);
}

export function getExerciseTotalReps(session, exerciseOrId) {
  const sets = getExerciseLog(session, exerciseOrId)?.sets ?? [];
  return sets.reduce((total, set) => total + numberValue(set.reps, 0), 0);
}

// Empty set slots (weight null) never count as 0 kg here: src/lib/sessionLog.js.
export function formatLoggedWeight(session, exercise, exerciseOrId) {
  const averageWeight = getAverageLoggedWeight(session, exerciseOrId);

  if (averageWeight === null) {
    return exercise.loadType === "bodyweight" ? "BW" : "BW / untracked load";
  }

  return formatWeight(averageWeight, exercise);
}

export function getAverageLoggedWeight(session, exerciseOrId) {
  return getAverageNumericWeight(getExerciseLog(session, exerciseOrId)?.sets ?? []);
}

export function getBeatLastCue(dayId, exercise, sessions, planExercise) {
  const previousSession = getLastExerciseSession(dayId, exercise, sessions);
  const isAthletic = exercise.progressionType === "athletic";

  if (!previousSession) {
    return {
      summary: "First logged session - establish your baseline today.",
      target: isAthletic
        ? "Prioritize speed and crisp execution over more volume."
        : "Log honest reps and kg so next time has a target.",
    };
  }

  const previousSets = getExerciseLog(previousSession, exercise)?.sets ?? [];
  // Only logged sets: an untouched slot is not "0 reps at 0 kg".
  const previousReps = getLoggedReps(previousSets);
  const previousTotalReps = previousReps.reduce((total, reps) => total + reps, 0);

  if (!previousReps.length) {
    // The session exists but this exercise was skipped in it: nothing to beat.
    return {
      summary: "No logged sets for this exercise yet - establish your baseline today.",
      target: isAthletic
        ? "Prioritize speed and crisp execution over more volume."
        : "Log honest reps and kg so next time has a target.",
    };
  }
  const previousWeight = formatLoggedWeight(previousSession, exercise, exercise);
  const previousAverageWeight = getAverageLoggedWeight(previousSession, exercise);
  const plannedWeight = normalizeWeight(planExercise.recommendedWeight);
  const repsText = previousReps.join(", ");

  if (isAthletic) {
    return {
      summary: `Last time: ${previousWeight} x ${repsText} - ${previousTotalReps} total reps`,
      target: "Prioritize speed and crisp execution over more volume.",
    };
  }

  if (
    typeof plannedWeight === "number" &&
    typeof previousAverageWeight === "number" &&
    plannedWeight > previousAverageWeight
  ) {
    return {
      summary: `Last time: ${previousWeight} x ${repsText} - ${previousTotalReps} total reps`,
      target: `Today's target: try ${formatWeight(plannedWeight, exercise)} and stay within the rep range.`,
    };
  }

  return {
    summary: `Last time: ${previousWeight} x ${repsText} - ${previousTotalReps} total reps`,
    target: `Today's target: keep ${previousWeight} and beat last session's total reps.`,
  };
}

export function summarizeWeeklyReviewWindow(sessionSummaries, startMs, endMs) {
  const windowSessions = (sessionSummaries ?? []).filter((session) => {
    const time = getDateTime(session.date);
    return time && time > startMs && time <= endMs;
  });

  return {
    workouts: windowSessions.length,
    setCount: windowSessions.reduce(
      (total, session) => total + numberValue(session.completedSetCount, 0),
      0,
    ),
    totalVolume: windowSessions.reduce(
      (total, session) => total + numberValue(session.totalVolume, 0),
      0,
    ),
    averageRpe: average(
      windowSessions.map((session) => session.sessionRpe).filter(Number.isFinite),
    ),
    averageReadiness: average(
      windowSessions
        .map((session) => session.readiness?.averageScore)
        .filter(Number.isFinite),
    ),
  };
}

// Plain nouns for the weekly observation line ("Best comparable e1RM this week").
const OBSERVATION_METRIC_NOUNS = {
  e1rm: "e1RM",
  volume: "volume",
  time: "total time",
  distance: "total distance",
};

export function buildWeeklyReviewNotes(current, previous, bestSet, observations = null) {
  const notes = [];

  if (current.workouts === 0) {
    notes.push(
      "Nothing logged in the last 7 days. No guilt needed - just pick the next workout and log the first exercise. The rest tends to follow.",
    );
    if (previous.workouts > 0) {
      notes.push(
        `The week before had ${previous.workouts} ${previous.workouts === 1 ? "session" : "sessions"}, so the habit is there. Get one in early this week.`,
      );
    }
    return notes;
  }

  if (current.workouts >= 3) {
    notes.push(
      `${current.workouts} sessions banked this week. Consistency like that is what actually moves the numbers.`,
    );
  } else if (previous.workouts > current.workouts) {
    notes.push(
      `${current.workouts} ${current.workouts === 1 ? "session" : "sessions"} this week, down from ${previous.workouts}. One extra session next week puts you back on track.`,
    );
  } else {
    notes.push(
      `${current.workouts} ${current.workouts === 1 ? "session" : "sessions"} logged this week.`,
    );
  }

  if (current.totalVolume > 0 && previous.totalVolume > 0) {
    const change = current.totalVolume - previous.totalVolume;
    const threshold = Math.max(50, previous.totalVolume * 0.05);

    if (change > threshold) {
      notes.push(
        `Training volume climbed from ${formatVolume(previous.totalVolume)} to ${formatVolume(current.totalVolume)}. Nice work - just keep the jumps gradual.`,
      );
    } else if (change < -threshold) {
      notes.push(
        `Volume came down from ${formatVolume(previous.totalVolume)} to ${formatVolume(current.totalVolume)}. Fine if it was planned or recovery-driven - worth a look if it wasn't.`,
      );
    } else {
      notes.push(`Volume held steady around ${formatVolume(current.totalVolume)}.`);
    }
  }

  if (Number.isFinite(current.averageRpe) && current.averageRpe >= 8.5) {
    notes.push(
      `Average session effort ran hot at ${current.averageRpe.toFixed(1)}/10. If that continues, expect the coach to keep recommendations conservative.`,
    );
  }

  if (Number.isFinite(current.averageReadiness) && Number.isFinite(previous.averageReadiness)) {
    const readinessChange = current.averageReadiness - previous.averageReadiness;

    if (readinessChange <= -0.4) {
      notes.push(
        `Readiness slipped from ${previous.averageReadiness.toFixed(1)} to ${current.averageReadiness.toFixed(1)} out of 5. Prioritize sleep before chasing new loads.`,
      );
    } else if (readinessChange >= 0.4) {
      notes.push(
        `Readiness improved to ${current.averageReadiness.toFixed(1)}/5. Good window to push the main lifts.`,
      );
    }
  }

  if (bestSet) {
    notes.push(`Set of the week: ${bestSet.exerciseName ?? "Top set"} - ${formatSetPerformance(bestSet)}.`);
  }

  if (observations) {
    notes.push(...buildWeeklyObservationNotes(observations));
  }

  return notes;
}

/**
 * H5 weekly observations (decision H5-10), computed by buildWeeklyReview
 * when it is given the sessions: plan adherence, hold / override use, new
 * records, a readiness/performance line only with MIN_COMPARABLE_SESSIONS
 * comparable sessions, timed / distance totals and the deload sample check.
 * Every line states its sample; none states a cause.
 */
export function buildWeeklyObservationNotes(observations) {
  const notes = [];
  const { adherence, holdOverride, records, performance, measured, deloadCheck } = observations;

  if (adherence && adherence.plannedSessionCount > 0 && Number.isFinite(adherence.averageRatio)) {
    const percent = Math.round(adherence.averageRatio * 100);
    const partialCount = adherence.statusCounts.partial + adherence.statusCounts.minimal;
    notes.push(
      `Plan adherence averaged ${percent}% across ${adherence.plannedSessionCount} planned ${adherence.plannedSessionCount === 1 ? "session" : "sessions"}` +
        (partialCount > 0
          ? ` (${partialCount} ${partialCount === 1 ? "was" : "were"} partial); the coach weighs partial sessions as lighter evidence.`
          : "."),
    );
  }

  if (holdOverride && holdOverride.count > 0) {
    const parts = [];
    if (holdOverride.held > 0) {
      parts.push(`${holdOverride.held} on hold`);
    }
    if (holdOverride.overridden > 0) {
      parts.push(`${holdOverride.overridden} with a manual override`);
    }
    if (holdOverride.deload > 0) {
      parts.push(`${holdOverride.deload} on a deload`);
    }
    notes.push(
      `${holdOverride.count} ${holdOverride.count === 1 ? "session" : "sessions"} used your own settings this week: ${parts.join(", ")}. History is kept as logged.`,
    );
  }

  if (records && records.count > 0) {
    notes.push(
      `${records.count} new ${records.count === 1 ? "record" : "records"} this week${records.examples.length ? `: ${records.examples.join(", ")}` : ""}.`,
    );
  }

  if (performance) {
    if (performance.comparable && performance.metricId === "e1rm") {
      // An e1RM belongs to ONE exercise (H5-44): the sessions of a week train
      // different lifts, so the line names the lift and counts the sessions
      // that logged an e1RM without calling them comparable with each other.
      notes.push(
        `Best e1RM this week: ${performance.formattedValue}${performance.exerciseName ? ` (${performance.exerciseName})` : ""} on ${formatProgressDate(performance.date)}${performance.readinessLabel ? ` (readiness ${performance.readinessLabel})` : ""}. ${performance.rankedCount} sessions logged an e1RM; different lifts are not ranked against each other.`,
      );
    } else if (performance.comparable) {
      notes.push(
        `Best comparable ${OBSERVATION_METRIC_NOUNS[performance.metricId] ?? performance.metricLabel.toLowerCase()} this week: ${performance.formattedValue} on ${formatProgressDate(performance.date)} (${performance.rankedCount} comparable sessions${performance.readinessLabel ? `, readiness ${performance.readinessLabel}` : ""}).`,
      );
    } else if (performance.needed > 0 && performance.sessionCount > 0) {
      notes.push(
        `Not comparable yet: ${performance.needed} more ${performance.needed === 1 ? "session" : "sessions"} needed before a readiness/performance observation.`,
      );
    }
  }

  if (measured) {
    if (measured.current.totalSeconds > 0 || measured.previous.totalSeconds > 0) {
      notes.push(
        `Timed work: ${formatDuration(measured.current.totalSeconds)} this week vs ${formatDuration(measured.previous.totalSeconds)} the week before.`,
      );
    }
    if (measured.current.totalMeters > 0 || measured.previous.totalMeters > 0) {
      notes.push(
        `Distance work: ${formatMeters(measured.current.totalMeters)} this week vs ${formatMeters(measured.previous.totalMeters)} the week before.`,
      );
    }
    if (measured.current.bodyweightReps > 0 && measured.previous.bodyweightReps > 0) {
      notes.push(
        `Bodyweight reps: ${measured.current.bodyweightReps} this week vs ${measured.previous.bodyweightReps} the week before (counted apart from kg volume).`,
      );
    }
  }

  if (deloadCheck && !deloadCheck.met) {
    if (deloadCheck.checkIns) {
      const { have, required } = deloadCheck.checkIns;
      notes.push(
        `Deload check needs ${deloadCheck.required} sessions and ${required} readiness check-ins in ${deloadCheck.windowDays} days; you have ${deloadCheck.have} ${deloadCheck.have === 1 ? "session" : "sessions"} and ${have} ${have === 1 ? "check-in" : "check-ins"}.`,
      );
    } else {
      notes.push(
        `Deload check needs ${deloadCheck.required} sessions in ${deloadCheck.windowDays} days; you have ${deloadCheck.have}.`,
      );
    }
  }

  return notes;
}

/**
 * buildWeeklyReview(sessionSummaries, setRecords, now, options)
 *
 * options (all optional, H5-10):
 *   sessions            - the stored sessions; when given, the review adds the
 *                         H5 observations (adherence, hold / override, comparable
 *                         performance, measured totals, deload sample check).
 *   records             - output of computePersonalRecords (personalRecords.js);
 *                         adds the "new records this week" count.
 *   deloadRequirement   - { sessions, windowDays } (default DELOAD_SAMPLE_REQUIREMENT).
 *   minComparableSessions - default MIN_COMPARABLE_SESSIONS.
 * Without options the result is the pre-H5 review, unchanged.
 */
export function buildWeeklyReview(sessionSummaries, setRecords, now = Date.now(), options = null) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const current = summarizeWeeklyReviewWindow(sessionSummaries, now - weekMs, now);
  const previous = summarizeWeeklyReviewWindow(sessionSummaries, now - 2 * weekMs, now - weekMs);
  const weekSets = (setRecords ?? []).filter((record) => {
    if (!record.completed) {
      return false;
    }

    const time = getDateTime(record.date);
    return time && now - time <= weekMs;
  });
  const bestSet = [...weekSets].sort(compareBestSet)[0] ?? null;
  const observations = options ? buildWeeklyObservations(sessionSummaries, now, options) : null;

  return {
    current,
    previous,
    bestSet,
    notes: buildWeeklyReviewNotes(current, previous, bestSet, observations),
    ...(observations ? { observations } : {}),
  };
}

export function summarizeMeasuredWindow(sessionSummaries, startMs, endMs) {
  const windowSessions = (sessionSummaries ?? []).filter((session) => {
    const time = getDateTime(session.date);
    return time && time > startMs && time <= endMs;
  });
  const sum = (field) =>
    windowSessions.reduce((total, session) => total + numberValue(session[field], 0), 0);

  return {
    tonnage: sum("totalVolume"),
    loggedVolume: windowSessions.reduce(
      (total, session) => total + numberValue(session.loggedVolume ?? session.totalVolume, 0),
      0,
    ),
    totalSeconds: sum("totalSeconds"),
    totalMeters: sum("totalMeters"),
    bodyweightReps: sum("bodyweightReps"),
  };
}

export function buildWeeklyObservations(sessionSummaries, now, options = {}) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const sessions = Array.isArray(options.sessions) ? options.sessions : [];
  const weekSessions = sessions.filter((session) => {
    const time = getDateTime(session.date);
    return time && time > now - weekMs && time <= now;
  });
  const deloadRequirement = options.deloadRequirement ?? DELOAD_SAMPLE_REQUIREMENT;
  const minSessions = options.minComparableSessions ?? MIN_COMPARABLE_SESSIONS;
  const deloadWindowMs = deloadRequirement.windowDays * 24 * 60 * 60 * 1000;
  const deloadSessions = sessions.filter((session) => {
    const time = getDateTime(session.date);
    return time && time > now - deloadWindowMs && time <= now;
  }).length;
  const adherence = options.sessions ? computeAdherenceTrend(sessions, 7, now) : null;
  const holdOverride = options.sessions
    ? weekSessions.reduce(
        (totals, session) => {
          const status = getSessionCoachStatus(session);
          if (status.held.length) totals.held += 1;
          if (status.overridden.length) totals.overridden += 1;
          if (status.deload) totals.deload += 1;
          if (status.held.length || status.overridden.length || status.deload) totals.count += 1;
          return totals;
        },
        { count: 0, held: 0, overridden: 0, deload: 0 },
      )
    : null;
  const records = options.records ? countRecordsInWindow(options.records, now - weekMs, now) : null;
  const weekSummaries = (sessionSummaries ?? []).filter((session) => {
    const time = getDateTime(session.date);
    return time && time > now - weekMs && time <= now;
  });
  const linked = weekSummaries.filter((session) => session.readiness?.status);
  const performance = options.sessions ? buildWeeklyPerformanceObservation(linked, minSessions) : null;
  const measured = options.sessions
    ? {
        current: summarizeMeasuredWindow(sessionSummaries, now - weekMs, now),
        previous: summarizeMeasuredWindow(sessionSummaries, now - 2 * weekMs, now - weekMs),
      }
    : null;
  // H5 fix round 1 (decision H5-23): when the caller passes the deload
  // evaluation of the active program (evaluateDeloadNeed), the line states
  // the same sample the deload check uses - sessions of that program AND
  // readiness check-ins - so the weekly review never contradicts the deload
  // card. Without it the session count line stays as before.
  const evaluation = options.deloadEvaluation && typeof options.deloadEvaluation === "object" ? options.deloadEvaluation : null;
  const deloadCheck = evaluation
    ? {
        required: evaluation.requiredSampleSize?.sessions ?? deloadRequirement.sessions,
        windowDays: evaluation.windowDays ?? deloadRequirement.windowDays,
        have: evaluation.sampleSize?.sessions ?? 0,
        met: evaluation.eligible === true,
        checkIns: {
          required: evaluation.requiredSampleSize?.checkIns ?? 0,
          have: evaluation.sampleSize?.checkIns ?? 0,
        },
        fromEvaluation: true,
      }
    : options.sessions
      ? {
          required: deloadRequirement.sessions,
          windowDays: deloadRequirement.windowDays,
          have: deloadSessions,
          met: deloadSessions >= deloadRequirement.sessions,
        }
      : null;

  return { adherence, holdOverride, records, performance, measured, deloadCheck };
}

function buildWeeklyPerformanceObservation(linkedSummaries, minSessions) {
  const requirement = getComparableSessionRequirement(linkedSummaries, { minSessions });
  const best = getBestComparablePerformance(linkedSummaries, { minSessions });

  if (!best.comparable) {
    return {
      comparable: false,
      needed: requirement.needed,
      rankedCount: requirement.rankedCount,
      sessionCount: linkedSummaries.length,
    };
  }

  return {
    comparable: true,
    metricId: best.metricId,
    metricLabel: best.metricLabel,
    unit: best.unit,
    value: best.value,
    formattedValue: formatMetricValue(best.metricId, best.value),
    date: best.session.date,
    exerciseName: best.metricId === "e1rm" ? best.session.bestEstimatedStrengthExercise ?? null : null,
    rankedCount: best.rankedCount,
    readinessLabel: best.session.readiness?.status ? getReadinessStatusLabel(best.session.readiness) : null,
    needed: 0,
    sessionCount: linkedSummaries.length,
  };
}

/**
 * Records still standing that were set inside the window: the primary
 * (program + occurrence) records of a computePersonalRecords result that
 * BEAT an earlier comparable value (`previousValue`, decision H5-50). A first
 * value - the first log of an exercise, or the first reps at a new weight -
 * is a baseline, as in the recap, and is not counted.
 */
export function countRecordsInWindow(personalRecords, startMs, endMs) {
  const examples = [];
  let count = 0;

  Object.values(personalRecords?.primary ?? {}).forEach((identity) => {
    const entries = [];
    Object.entries(identity.records ?? {}).forEach(([type, record]) => {
      if (type === "best_reps_at_weight") {
        Object.values(record ?? {}).forEach((entry) => entries.push(entry));
        return;
      }
      if (record) {
        entries.push(record);
      }
    });

    entries.forEach((record) => {
      const time = getDateTime(record.date);
      const beatEarlier = record.previousValue !== null && record.previousValue !== undefined;
      if (beatEarlier && time && time > startMs && time <= endMs) {
        count += 1;
        if (examples.length < 3) {
          examples.push(`${identity.name ?? "Exercise"} ${formatRecordLabel(record)}`);
        }
      }
    });
  });

  return { count, examples };
}

export function formatRecordLabel(record) {
  switch (record?.type) {
    case "best_e1rm":
      return `e1RM ${formatKg(record.value)}`;
    case "best_weight":
      return `top weight ${formatKg(record.value)}`;
    case "best_reps_at_weight":
      return `${record.value} reps at ${typeof record.weight === "number" ? formatKg(record.weight) : "BW"}`;
    case "best_session_volume":
      return `session volume ${formatVolume(record.value)}`;
    case "best_time":
      return `time ${formatDuration(record.value)}`;
    case "best_distance":
      return `distance ${formatMeters(record.value)}`;
    default:
      return String(record?.value ?? "");
  }
}

export function formatMetricValue(metricId, value) {
  switch (metricId) {
    case "e1rm":
      return formatKg(value);
    case "volume":
      return formatVolume(value);
    case "time":
      return formatDuration(value);
    case "distance":
      return formatMeters(value);
    default:
      return formatPlainNumber(value);
  }
}

export function buildProgressAnalytics({
  sessions,
  readinessByDate,
  programs,
  activeProgram,
  activeProgramDays,
  exerciseLibrary,
  // Epoch ms of "now" for the recent-window counters; injectable for fixtures.
  now = Date.now(),
}) {
  const sortedSessions = [...(sessions ?? [])].sort(
    (left, right) => getDateTime(right.date) - getDateTime(left.date),
  );
  const exerciseLookup = buildProgressExerciseLookup({
    programs,
    activeProgram,
    activeProgramDays,
    exerciseLibrary,
  });
  const setRecords = sortedSessions.flatMap((session) =>
    getSessionSetRecords(session, exerciseLookup),
  );
  const completedSets = setRecords.filter((set) => set.completed);
  const weightedSets = completedSets.filter(
    (set) => typeof set.weight === "number" && Number.isFinite(set.reps),
  );
  const sessionRpes = sortedSessions
    .map((session) => numberValue(session.sessionRpe, NaN))
    .filter(Number.isFinite);
  const readinessEntries = buildReadinessEntries(readinessByDate, sortedSessions);
  const readinessScores = readinessEntries
    .map((entry) => entry.readiness.averageScore)
    .filter(Number.isFinite);
  const recentWindowMs = recentWorkoutWindowDays * 24 * 60 * 60 * 1000;
  const recentWorkoutCount = sortedSessions.filter((session) => {
    const dateTime = getDateTime(session.date);
    return dateTime && now - dateTime <= recentWindowMs;
  }).length;
  const recentSevenDayWorkoutCount = sortedSessions.filter((session) => {
    const dateTime = getDateTime(session.date);
    return dateTime && now - dateTime <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const exerciseOptions = buildProgressExerciseOptions({
    activeProgram,
    activeProgramDays,
    exerciseLookup,
    setRecords,
  });
  const sessionSummaries = buildProgressSessionSummaries(sortedSessions, setRecords, readinessByDate);
  const bestRecentSet = getBestRecentSet(completedSets, now, recentWorkoutWindowDays);
  const insights = buildTrainingInsightCards({
    totalWorkouts: sortedSessions.length,
    recentWorkoutCount,
    recentSevenDayWorkoutCount,
    sessionSummaries,
    sessionRpes,
    readinessEntries,
    bestRecentSet,
  });
  const readinessPerformance = buildReadinessPerformanceAnalytics(sessionSummaries);

  return {
    sortedSessions,
    sessionSummaries,
    setRecords,
    totalWorkouts: sortedSessions.length,
    recentWorkoutCount,
    recentSevenDayWorkoutCount,
    lastWorkoutDate: sortedSessions[0]?.date ?? null,
    lastWorkoutName: sortedSessions[0]?.dayName ?? sortedSessions[0]?.dayFocus ?? null,
    totalCompletedSets: completedSets.length,
    weightedSetCount: weightedSets.length,
    // Measurement-aware tonnage (H5-10): per-dumbbell x2 and per-side x2 as
    // getSetLoadForVolume says; identical to the as-logged sum for kg sets.
    totalVolume: sumTonnage(completedSets),
    loggedVolume: weightedSets.reduce((total, set) => total + set.weight * set.reps, 0),
    totalSeconds: sumField(completedSets, "seconds"),
    totalMeters: sumField(completedSets, "meters"),
    bodyweightReps: sumBodyweightReps(completedSets),
    averageSessionRpe: average(sessionRpes),
    sessionRpeSampleSize: sessionRpes.length,
    averageReadiness: average(readinessScores),
    readinessEntries,
    bestRecentSet,
    insights,
    readinessPerformance,
    exerciseOptions,
    loggedExerciseCount: exerciseOptions.filter((option) => option.loggedSetCount > 0).length,
  };
}

export function buildProgressSessionSummaries(sessions, setRecords, readinessByDate = {}) {
  const recordsBySession = new Map();

  setRecords.forEach((record) => {
    const key = record.sessionId;
    if (!key) {
      return;
    }

    const currentRecords = recordsBySession.get(key) ?? [];
    currentRecords.push(record);
    recordsBySession.set(key, currentRecords);
  });

  return sessions.map((session) => {
    const sessionKey = getProgressSessionKey(session);
    const records = recordsBySession.get(sessionKey) ?? [];
    const completedRecords = records.filter((record) => record.completed);
    const weightedRecords = completedRecords.filter(
      (record) => typeof record.weight === "number" && Number.isFinite(record.reps),
    );
    const estimatedRecords = weightedRecords.filter((record) => record.estimatedOneRepMax !== null);
    const readiness = getSessionReadinessForProgress(session, readinessByDate);
    const fallbackLoggedSets = numberValue(session.analytics?.loggedSetCount, 0);
    const fallbackExerciseCount =
      numberValue(session.analytics?.exerciseCount, null) ??
      (Array.isArray(session.exercises)
        ? session.exercises.length
        : Object.keys(session.exercises ?? {}).length);

    return {
      sessionKey,
      date: session.date,
      dayName: session.dayName ?? session.dayFocus ?? "Workout",
      sessionRpe: numberValue(session.sessionRpe, null),
      readiness,
      completedSetCount: completedRecords.length || fallbackLoggedSets,
      exerciseCount: completedRecords.length
        ? new Set(completedRecords.map((record) => record.exerciseKey)).size
        : fallbackExerciseCount,
      totalReps: completedRecords.reduce(
        (total, record) => total + (Number.isFinite(record.reps) ? record.reps : 0),
        0,
      ),
      // Measurement-aware tonnage (H5-10); `loggedVolume` keeps the as-logged sum.
      totalVolume: sumTonnage(completedRecords),
      loggedVolume: weightedRecords.reduce((total, record) => total + record.weight * record.reps, 0),
      bestEstimatedStrength: estimatedRecords.length
        ? Math.max(...estimatedRecords.map((record) => record.estimatedOneRepMax))
        : null,
      // The exercise that best e1RM belongs to (H5-44): a session's best e1RM
      // is one lift's number, so the weekly line names it.
      bestEstimatedStrengthExercise: estimatedRecords.length
        ? estimatedRecords.reduce((best, record) => (record.estimatedOneRepMax > best.estimatedOneRepMax ? record : best)).exerciseName ?? null
        : null,
      weightedSetCount: weightedRecords.length,
      totalSeconds: sumField(completedRecords, "seconds"),
      bestSeconds: maxField(completedRecords, "seconds"),
      totalMeters: sumField(completedRecords, "meters"),
      bestMeters: maxField(completedRecords, "meters"),
      bodyweightReps: sumBodyweightReps(completedRecords),
      measurements: distinctValues(completedRecords, "measurement"),
      weightModes: distinctValues(completedRecords, "weightMode"),
    };
  });
}

function sumTonnage(records) {
  return records.reduce(
    (total, record) => total + (Number.isFinite(record.tonnage) ? record.tonnage : 0),
    0,
  );
}

function sumField(records, field) {
  return records.reduce(
    (total, record) => total + (Number.isFinite(record[field]) ? record[field] : 0),
    0,
  );
}

function maxField(records, field) {
  const values = records.map((record) => record[field]).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function sumBodyweightReps(records) {
  return records.reduce(
    (total, record) =>
      total +
      ((record.measurement ?? "reps") === "reps" && record.weight === "BW" && Number.isFinite(record.reps)
        ? record.reps
        : 0),
    0,
  );
}

function distinctValues(records, field) {
  return [...new Set(records.map((record) => record[field]).filter(Boolean))];
}

export function getSessionReadinessForProgress(session, readinessByDate = {}) {
  if (session?.readiness?.status) {
    return session.readiness;
  }

  if (session?.readinessSnapshot?.readiness?.status) {
    return session.readinessSnapshot.readiness;
  }

  if (session?.wellness) {
    return interpretWellness(session.wellness);
  }

  const readinessDate = session?.readinessDate;
  const dateKey = session?.date ? getLocalDateKey(new Date(session.date)) : null;
  const linkedEntry = readinessByDate?.[readinessDate] ?? readinessByDate?.[dateKey];

  if (linkedEntry?.readiness?.status) {
    return linkedEntry.readiness;
  }

  if (linkedEntry?.wellness) {
    return interpretWellness(linkedEntry.wellness);
  }

  return null;
}

export function buildReadinessPerformanceAnalytics(sessionSummaries) {
  const statusCounts = { green: 0, yellow: 0, red: 0, missing: 0 };
  const linkedSessions = [];

  (sessionSummaries ?? []).forEach((session) => {
    const status = session.readiness?.status;

    if (status === "green" || status === "yellow" || status === "red") {
      statusCounts[status] += 1;
      linkedSessions.push(session);
      return;
    }

    statusCounts.missing += 1;
  });

  const readinessScores = linkedSessions
    .map((session) => session.readiness?.averageScore)
    .filter(Number.isFinite);
  const averageReadiness = average(readinessScores);
  const rpeByStatus = buildReadinessRpeGroups(linkedSessions);
  const highFatigueSessions = linkedSessions.filter(
    (session) =>
      (session.readiness?.status === "red" || session.readiness?.status === "yellow") &&
      Number.isFinite(session.sessionRpe) &&
      session.sessionRpe >= 9,
  );
  const bestPerformance = getBestReadinessPerformanceDay(linkedSessions);
  const linkedSessionCount = linkedSessions.length;
  const lowReadinessRpe = average(
    linkedSessions
      .filter((session) => session.readiness?.status === "red" || session.readiness?.status === "yellow")
      .map((session) => session.sessionRpe)
      .filter(Number.isFinite),
  );
  const greenReadinessRpe = rpeByStatus.green.averageRpe;

  return {
    linkedSessionCount,
    statusCounts,
    averageReadiness,
    averageReadinessDetail: linkedSessionCount
      ? `${linkedSessionCount} sessions have readiness linked`
      : "No readiness-linked workouts yet.",
    rpeByStatus,
    highFatigueCount: highFatigueSessions.length,
    highFatigueDetail: highFatigueSessions.length
      ? "Red/yellow readiness with session RPE 9+."
      : linkedSessionCount
        ? "No low-readiness + RPE 9+ sessions found."
        : "Needs readiness plus session RPE.",
    bestPerformance,
    performanceNote: buildReadinessPerformanceNote({
      linkedSessionCount,
      lowReadinessRpe,
      greenReadinessRpe,
      highFatigueCount: highFatigueSessions.length,
      bestPerformance,
    }),
    ...buildReadinessCoachNote({
      linkedSessionCount,
      lowReadinessRpe,
      greenReadinessRpe,
      highFatigueCount: highFatigueSessions.length,
    }),
  };
}

export function buildReadinessRpeGroups(linkedSessions) {
  return ["green", "yellow", "red"].reduce((groups, status) => {
    const sessions = linkedSessions.filter((session) => session.readiness?.status === status);
    const rpes = sessions.map((session) => session.sessionRpe).filter(Number.isFinite);

    groups[status] = {
      count: sessions.length,
      rpeCount: rpes.length,
      averageRpe: average(rpes),
    };

    return groups;
  }, {});
}

/**
 * Review finding F7: the "best performance day" is ranked within ONE metric
 * type only (e1RM across the sessions that have it, otherwise volume) via
 * src/lib/readinessPerformance.js. Total reps / set counts are never ranked
 * against kg values. Fewer than two comparable sessions yields a
 * "Not enough comparable data" entry instead of a winner.
 */
export function getBestReadinessPerformanceDay(linkedSessions) {
  if (!linkedSessions?.length) {
    return null;
  }

  const best = getBestComparablePerformance(linkedSessions);

  if (!best.comparable) {
    return {
      comparable: false,
      metricId: null,
      label: "Not enough comparable data",
      detail: "Needs at least 2 readiness-linked sessions with the same metric (e1RM or volume).",
    };
  }

  const statusLabel = getReadinessStatusLabel(best.session.readiness);
  const readinessAverage = Number.isFinite(best.session.readiness?.averageScore)
    ? ` ${best.session.readiness.averageScore.toFixed(1)}/5`
    : "";
  const formattedValue = best.metricId === "e1rm" ? formatKg(best.value) : formatVolume(best.value);

  return {
    comparable: true,
    metricId: best.metricId,
    label: formatProgressDate(best.session.date),
    detail: `${best.metricLabel}: ${formattedValue} | ${statusLabel}${readinessAverage} | ranked across ${best.rankedCount} sessions with ${best.metricLabel.toLowerCase()}`,
  };
}

export function buildReadinessPerformanceNote({
  linkedSessionCount,
  lowReadinessRpe,
  greenReadinessRpe,
  highFatigueCount,
  bestPerformance,
}) {
  if (linkedSessionCount < 2) {
    return "Not enough readiness-linked sessions yet. Log readiness before training and session RPE after training.";
  }

  if (
    Number.isFinite(lowReadinessRpe) &&
    Number.isFinite(greenReadinessRpe) &&
    lowReadinessRpe >= greenReadinessRpe + 0.5
  ) {
    return "Low readiness days tended to have higher RPE. Useful signal, not proof of causation.";
  }

  if (highFatigueCount > 0) {
    return "Some lower-readiness days also hit very high session RPE. Watch fatigue before forcing progression.";
  }

  if (bestPerformance?.comparable) {
    return "Best performance day is shown with its readiness context. Keep collecting data before reading patterns too hard.";
  }

  return "Readiness-linked sessions exist, but no strong pattern is clear yet.";
}

export function buildReadinessCoachNote({
  linkedSessionCount,
  lowReadinessRpe,
  greenReadinessRpe,
  highFatigueCount,
}) {
  if (linkedSessionCount < 2) {
    return {
      coachNoteTitle: "Not enough data",
      coachNote: "Add readiness to more workouts before judging recovery patterns.",
    };
  }

  if (highFatigueCount > 0) {
    return {
      coachNoteTitle: "Watch fatigue",
      coachNote: "Low readiness plus RPE 9+ showed up. Keep hard days earned, not forced.",
    };
  }

  if (
    Number.isFinite(lowReadinessRpe) &&
    Number.isFinite(greenReadinessRpe) &&
    lowReadinessRpe >= greenReadinessRpe + 0.5
  ) {
    return {
      coachNoteTitle: "Readiness matters",
      coachNote: "Lower readiness is lining up with harder sessions. Use conservative jumps on those days.",
    };
  }

  return {
    coachNoteTitle: "Pattern stable",
    coachNote: "Readiness and fatigue look manageable with the data available.",
  };
}

export function getBestRecentSet(completedSets, now, windowDays) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const recentSets = completedSets.filter((set) => {
    const dateTime = getDateTime(set.date);
    return dateTime && now - dateTime <= windowMs;
  });

  return [...recentSets].sort(compareBestSet)[0] ?? null;
}

export function buildTrainingInsightCards({
  totalWorkouts,
  recentWorkoutCount,
  recentSevenDayWorkoutCount,
  sessionSummaries,
  sessionRpes,
  readinessEntries,
  bestRecentSet,
}) {
  const recentSessionRpes = sessionRpes.slice(0, 5);
  const recentRpeAverage = average(recentSessionRpes);
  const readinessTrend = compareRecentReadiness(readinessEntries);
  const volumeTrend = compareRecentSessionValues(
    sessionSummaries.filter((summary) => summary.totalVolume > 0),
    "totalVolume",
  );

  return [
    buildConsistencyInsight(totalWorkouts, recentWorkoutCount, recentSevenDayWorkoutCount),
    buildFatigueInsight(recentRpeAverage, recentSessionRpes.length),
    buildReadinessInsight(readinessTrend),
    buildVolumeInsight(volumeTrend),
    buildBestRecentSetInsight(bestRecentSet),
  ];
}

export function buildConsistencyInsight(totalWorkouts, recentWorkoutCount, recentSevenDayWorkoutCount) {
  if (!totalWorkouts) {
    return createProgressInsight({
      title: "Training consistency",
      status: "No data",
      value: "No workouts",
      body: "Save your first workout to start tracking consistency.",
      tone: "neutral",
    });
  }

  if (recentSevenDayWorkoutCount >= 3) {
    return createProgressInsight({
      title: "Training consistency",
      status: "Strong",
      value: `${recentSevenDayWorkoutCount} this week`,
      body: "Training has been consistent this week.",
      tone: "good",
    });
  }

  if (recentSevenDayWorkoutCount >= 1) {
    return createProgressInsight({
      title: "Training consistency",
      status: "Building",
      value: `${recentSevenDayWorkoutCount} this week`,
      body: "Some work is logged. Keep the rhythm simple and repeatable.",
      tone: "steady",
    });
  }

  return createProgressInsight({
    title: "Training consistency",
    status: "Watch",
    value: `${recentWorkoutCount} in 30d`,
    body: "No workout logged this week yet.",
    tone: "caution",
  });
}

export function buildFatigueInsight(recentRpeAverage, sampleSize) {
  if (!sampleSize || !Number.isFinite(recentRpeAverage)) {
    return createProgressInsight({
      title: "Recent fatigue",
      status: "No data",
      value: "No RPE",
      body: "Add session RPE to see fatigue patterns.",
      tone: "neutral",
    });
  }

  if (recentRpeAverage >= 8.5) {
    return createProgressInsight({
      title: "Recent fatigue",
      status: "High",
      value: `RPE ${recentRpeAverage.toFixed(1)}`,
      body: "Session RPE is trending high. Watch fatigue.",
      tone: "caution",
    });
  }

  if (recentRpeAverage >= 7) {
    return createProgressInsight({
      title: "Recent fatigue",
      status: "Productive",
      value: `RPE ${recentRpeAverage.toFixed(1)}`,
      body: "Sessions look hard enough without obvious red flags.",
      tone: "steady",
    });
  }

  return createProgressInsight({
    title: "Recent fatigue",
    status: "Low",
    value: `RPE ${recentRpeAverage.toFixed(1)}`,
    body: "Fatigue looks manageable. Push when performance supports it.",
    tone: "good",
  });
}

export function buildReadinessInsight(trend) {
  if (!trend.sampleSize) {
    return createProgressInsight({
      title: "Readiness trend",
      status: "No data",
      value: "No check-ins",
      body: "Save readiness to compare recovery with performance.",
      tone: "neutral",
    });
  }

  if (trend.currentAverage >= 4) {
    return createProgressInsight({
      title: "Readiness trend",
      status: "Strong",
      value: `${trend.currentAverage.toFixed(1)} / 5`,
      body: "Readiness looks strong lately.",
      tone: "good",
    });
  }

  if (trend.currentAverage < 3) {
    return createProgressInsight({
      title: "Readiness trend",
      status: "Low",
      value: `${trend.currentAverage.toFixed(1)} / 5`,
      body: "Readiness is low. Keep progression conservative.",
      tone: "caution",
    });
  }

  return createProgressInsight({
    title: "Readiness trend",
    status: trend.direction,
    value: `${trend.currentAverage.toFixed(1)} / 5`,
    body:
      trend.direction === "Up"
        ? "Readiness is moving up."
        : trend.direction === "Down"
          ? "Readiness dipped recently. Watch recovery."
          : "Readiness looks stable.",
    tone: trend.direction === "Up" ? "good" : trend.direction === "Down" ? "caution" : "steady",
  });
}

export function buildVolumeInsight(trend) {
  if (!trend.sampleSize) {
    return createProgressInsight({
      title: "Volume trend",
      status: "No data",
      value: "No kg volume",
      body: "Weighted sets unlock volume trend.",
      tone: "neutral",
    });
  }

  if (trend.direction === "Up") {
    return createProgressInsight({
      title: "Volume trend",
      status: "Up",
      value: formatVolume(trend.currentAverage),
      body: "Volume is moving up recently.",
      tone: "good",
    });
  }

  if (trend.direction === "Down") {
    return createProgressInsight({
      title: "Volume trend",
      status: "Down",
      value: formatVolume(trend.currentAverage),
      body: "Volume dipped recently. Check recovery and exercise selection.",
      tone: "caution",
    });
  }

  return createProgressInsight({
    title: "Volume trend",
    status: "Stable",
    value: formatVolume(trend.currentAverage),
    body: "Volume looks stable.",
    tone: "steady",
  });
}

export function buildBestRecentSetInsight(bestRecentSet) {
  if (!bestRecentSet) {
    return createProgressInsight({
      title: "Best recent set",
      status: "No data",
      value: "No set yet",
      body: "Log weighted sets to surface standout performances.",
      tone: "neutral",
    });
  }

  return createProgressInsight({
    title: "Best recent set",
    status: "Best",
    value: formatSetPerformance(bestRecentSet),
    body: bestRecentSet.exerciseName ?? "Best recent weighted performance.",
    tone: "good",
  });
}

export function createProgressInsight({ title, status, value, body, tone }) {
  const toneClasses = {
    good: "tone-good",
    steady: "tone-steady",
    caution: "tone-caution",
    neutral: "tone-neutral",
  };

  return {
    title,
    status,
    value,
    body,
    toneClass: toneClasses[tone] ?? toneClasses.neutral,
  };
}

export function compareRecentReadiness(entries) {
  const scores = (entries ?? [])
    .map((entry) => entry.readiness?.averageScore)
    .filter(Number.isFinite);
  const currentScores = scores.slice(0, 3);
  const previousScores = scores.slice(3, 6);
  const currentAverage = average(currentScores);
  const previousAverage = average(previousScores);

  return {
    sampleSize: currentScores.length,
    currentAverage,
    previousAverage,
    direction: getTrendDirection(currentAverage, previousAverage, 0.2),
  };
}

export function compareRecentSessionValues(entries, field) {
  const values = (entries ?? [])
    .map((entry) => entry[field])
    .filter((value) => Number.isFinite(value) && value > 0);
  const currentValues = values.slice(0, 3);
  const previousValues = values.slice(3, 6);
  const currentAverage = average(currentValues);
  const previousAverage = average(previousValues);

  return {
    sampleSize: currentValues.length,
    currentAverage,
    previousAverage,
    direction: getTrendDirection(currentAverage, previousAverage, 0.05, true),
  };
}

export function getTrendDirection(currentAverage, previousAverage, threshold, useRelativeThreshold = false) {
  if (!Number.isFinite(currentAverage) || !Number.isFinite(previousAverage)) {
    return "Stable";
  }

  const difference = currentAverage - previousAverage;
  const minimumChange = useRelativeThreshold
    ? Math.max(1, Math.abs(previousAverage) * threshold)
    : threshold;

  if (difference > minimumChange) {
    return "Up";
  }

  if (difference < -minimumChange) {
    return "Down";
  }

  return "Stable";
}

export function buildProgressExerciseLookup({
  programs,
  activeProgram,
  activeProgramDays,
  exerciseLibrary,
}) {
  const entries = [];

  (programs ?? []).forEach((program) => {
    getProgramDayViewModels(program.id).forEach((day) => {
      day.exercises.forEach((exercise) => entries.push({ program, day, exercise }));
    });
  });

  if (activeProgram && !entries.length) {
    activeProgramDays.forEach((day) => {
      day.exercises.forEach((exercise) => entries.push({ program: activeProgram, day, exercise }));
    });
  }

  return buildExerciseLookupFromEntries({ entries, activeProgram, exerciseLibrary });
}

/**
 * The pure part of buildProgressExerciseLookup (H5-8): builds the lookup from
 * an explicit list of { program, day, exercise } day-view-model entries, so a
 * module without storage access (personalRecords.js) can reuse the same
 * identity resolution. Every entry carries its measurement profile.
 */
export function buildExerciseLookupFromEntries({ entries, activeProgram = null, exerciseLibrary = [] }) {
  const byProgramExercise = new Map();
  const byLooseProgramExercise = new Map();
  const byExerciseId = new Map();
  const byExerciseName = new Map();
  const libraryById = new Map((exerciseLibrary ?? []).map((exercise) => [exercise.id, exercise]));
  const programEntries = new Map();
  const exerciseIdCounts = new Map();
  const exerciseNameCounts = new Map();
  const programExerciseIdCounts = new Map();

  function addProgramExercise(program, day, exercise) {
    const entry = {
      key: getProgressExerciseKey({
        programId: program?.id,
        programExerciseId: exercise.programExerciseId ?? exercise.id,
        exerciseId: exercise.libraryExerciseId ?? exercise.legacyExerciseId,
        exerciseName: exercise.name,
      }),
      programId: program?.id ?? null,
      programName: program?.nickname || program?.name || null,
      dayId: day?.id ?? null,
      dayName: day?.name ?? null,
      dayFocus: day?.focus ?? null,
      programExerciseId: exercise.programExerciseId ?? exercise.id,
      exerciseId: exercise.libraryExerciseId ?? exercise.legacyExerciseId ?? exercise.id,
      name: exercise.name,
      category: exercise.category,
      prescription: `${exercise.sets}x ${exercise.repsLabel} | ${formatWeight(exercise.recommendedWeight, exercise)} | RPE ${exercise.targetRPE} | ${formatRest(exercise.restSeconds)}`,
      activeProgram: activeProgram?.id === program?.id,
      loggedSetCount: 0,
      loadType: exercise.loadType ?? DEFAULT_MEASUREMENT_PROFILE.loadType,
      weightMode: exercise.weightMode ?? DEFAULT_MEASUREMENT_PROFILE.weightMode,
      repsLabel: exercise.repsLabel ?? null,
      profile: getMeasurementProfile(exercise),
    };

    if (entry.programId && entry.programExerciseId) {
      byProgramExercise.set(`${entry.programId}::${entry.programExerciseId}`, entry);
    }

    if (entry.programExerciseId) {
      byLooseProgramExercise.set(entry.programExerciseId, entry);
      programExerciseIdCounts.set(
        entry.programExerciseId,
        (programExerciseIdCounts.get(entry.programExerciseId) ?? 0) + 1,
      );
    }

    if (entry.exerciseId) {
      const current = byExerciseId.get(entry.exerciseId);
      if (!current || entry.activeProgram) {
        byExerciseId.set(entry.exerciseId, entry);
      }
      exerciseIdCounts.set(entry.exerciseId, (exerciseIdCounts.get(entry.exerciseId) ?? 0) + 1);
    }

    if (entry.name) {
      const name = normalizeProgressName(entry.name);
      byExerciseName.set(name, entry);
      exerciseNameCounts.set(name, (exerciseNameCounts.get(name) ?? 0) + 1);
    }

    programEntries.set(entry.key, entry);
  }

  (entries ?? []).forEach(({ program, day, exercise }) => addProgramExercise(program, day, exercise));

  return {
    byProgramExercise,
    byLooseProgramExercise,
    byExerciseId,
    byExerciseName,
    libraryById,
    programEntries,
    // How many program exercises share a Library id / name / occurrence id:
    // a legacy set without ids is attributed to a program occurrence only when
    // the count is 1 (personalRecords.js, "match only unambiguously").
    exerciseIdCounts,
    exerciseNameCounts,
    programExerciseIdCounts,
  };
}

export function getSessionSetRecords(session, exerciseLookup) {
  if (Array.isArray(session?.workoutSets) && session.workoutSets.length) {
    return session.workoutSets.map((set) => normalizeWorkoutSetRecord(session, set, exerciseLookup));
  }

  const legacyExercises = Array.isArray(session?.exercises)
    ? session.exercises.map((exerciseLog, index) => [
        exerciseLog?.programExerciseId ??
          exerciseLog?.exerciseId ??
          exerciseLog?.id ??
          exerciseLog?.name ??
          `exercise-${index + 1}`,
        exerciseLog,
      ])
    : Object.entries(session?.exercises ?? {});

  return legacyExercises.flatMap(([exerciseKey, exerciseLog]) => {
    const sets = Array.isArray(exerciseLog?.sets) ? exerciseLog.sets : [];

    return sets.map((set, index) =>
      normalizeLegacySetRecord(session, exerciseKey, exerciseLog, set, index, exerciseLookup),
    );
  });
}

/**
 * Measurement fields of a set record (H5-10, additive): `measurement`,
 * `value` (reps | seconds | meters), `seconds`, `meters`, `weightMode`,
 * `loadType`, `perSide`, `tonnage` (getSetLoadForVolume), `e1rmEligibility`
 * and `identitySource` (how the set was matched to a program occurrence:
 * "exact" | "loose" | "library" | "name" | "none"). `reps` carries the count
 * for rep-based sets only; a timed / distance set has `reps: null`.
 */
function buildMeasuredSetFields(entry, profile, identitySource) {
  // The measurement is the set's own (H5-1): a reps-only set of a timed
  // exercise stays a reps set.
  const measurement = entry.measurement;
  const reps = measurement === "reps" ? entry.value : null;
  const seconds = measurement === "time" ? entry.value : null;
  const meters = measurement === "distance" ? entry.value : null;

  return {
    measurement,
    value: entry.value,
    reps,
    seconds,
    meters,
    weightMode: profile.weightMode,
    loadType: profile.loadType,
    perSide: profile.perSide,
    tonnage: entry.tonnage,
    e1rmEligibility: getE1rmEligibility({
      measurement,
      weight: entry.weight,
      reps,
      rpe: entry.rpe,
      loadType: profile.loadType,
    }),
    identitySource,
  };
}

export function normalizeWorkoutSetRecord(session, set, exerciseLookup) {
  const match = resolveProgressExerciseMatch(
    {
      programId: set.programId ?? session.programId,
      programExerciseId: set.programExerciseId,
      exerciseId: set.exerciseId,
      exerciseName: set.exerciseName,
    },
    exerciseLookup,
  );
  const lookupEntry = match.entry;
  const profile = resolveSetMeasurementProfile(set, lookupEntry?.profile);
  const entry = readMeasuredSet(set, profile);
  const measured = buildMeasuredSetFields(entry, profile, match.via);
  const { reps } = measured;
  const weight = entry.weight;
  const rpe = entry.rpe;

  return {
    sessionId: set.sessionId ?? session.id ?? getProgressSessionKey(session),
    date: session.date,
    programId: set.programId ?? session.programId ?? lookupEntry?.programId ?? null,
    dayId: set.dayId ?? session.dayId ?? lookupEntry?.dayId ?? null,
    dayName: session.dayName ?? lookupEntry?.dayName ?? null,
    dayFocus: session.dayFocus ?? session.focus ?? lookupEntry?.dayFocus ?? null,
    programExerciseId: set.programExerciseId ?? lookupEntry?.programExerciseId ?? null,
    exerciseId: set.exerciseId ?? lookupEntry?.exerciseId ?? null,
    exerciseName: lookupEntry?.name ?? getLibraryExerciseName(set.exerciseId, exerciseLookup) ?? "Exercise",
    exerciseKey: getProgressExerciseKey({
      programId: set.programId ?? session.programId ?? lookupEntry?.programId,
      programExerciseId: set.programExerciseId ?? lookupEntry?.programExerciseId,
      exerciseId: set.exerciseId ?? lookupEntry?.exerciseId,
      exerciseName: lookupEntry?.name,
    }),
    setNumber: set.setNumber,
    reps,
    weight,
    rpe,
    completed: Boolean(set.completed) || isCompletedAnalyticsSet(entry.value, weight, rpe),
    estimatedOneRepMax: calculateEstimatedOneRepMax(weight, reps),
    ...measured,
  };
}

export function normalizeLegacySetRecord(session, exerciseKey, exerciseLog, set, index, exerciseLookup) {
  const match = resolveProgressExerciseMatch(
    {
      programId: session.programId,
      programExerciseId: exerciseLog?.programExerciseId ?? exerciseKey,
      // H5 fix round 1 (decision H5-22): the oldest sessions key the map by
      // the exercise id of the day ("bench-press") and carry no ids in the
      // log, so the key is also the Library / legacy id candidate.
      exerciseId: exerciseLog?.exerciseId ?? exerciseKey,
      exerciseName: exerciseLog?.name ?? exerciseLog?.exerciseName,
    },
    exerciseLookup,
  );
  const lookupEntry = match.entry;
  const profile = resolveSetMeasurementProfile(set, lookupEntry?.profile);
  const exerciseRpe = parseAnalyticsRpe(exerciseLog?.exerciseRPE);
  // Legacy precedence: reps / weight / rpe before the actual* aliases, and
  // the exercise RPE fills in a set RPE that is missing or blank (as before
  // H5: the set value is parsed first, then the exercise RPE).
  const legacySet = {
    reps: set?.reps ?? set?.actualReps ?? null,
    weight: set?.weight ?? set?.kg ?? set?.actualWeight ?? null,
    rpe: parseAnalyticsRpe(set?.rpe ?? set?.actualRPE) ?? exerciseRpe ?? null,
    seconds: set?.seconds ?? set?.actualSeconds ?? null,
    meters: set?.meters ?? set?.actualMeters ?? null,
    measurement: set?.measurement,
    weightMode: set?.weightMode,
    loadType: set?.loadType,
    perSide: set?.perSide,
  };
  const entry = readMeasuredSet(legacySet, profile);
  const rpe = entry.rpe;
  const measured = buildMeasuredSetFields(entry, profile, match.via);
  const { reps } = measured;
  const weight = entry.weight;

  return {
    sessionId: session.id ?? getProgressSessionKey(session),
    date: session.date,
    programId: session.programId ?? lookupEntry?.programId ?? null,
    dayId: session.dayId ?? lookupEntry?.dayId ?? null,
    dayName: session.dayName ?? lookupEntry?.dayName ?? null,
    dayFocus: session.dayFocus ?? session.focus ?? lookupEntry?.dayFocus ?? null,
    programExerciseId: exerciseLog?.programExerciseId ?? lookupEntry?.programExerciseId ?? null,
    exerciseId: exerciseLog?.exerciseId ?? lookupEntry?.exerciseId ?? null,
    exerciseName:
      lookupEntry?.name ??
      getLibraryExerciseName(exerciseLog?.exerciseId, exerciseLookup) ??
      exerciseLog?.name ??
      exerciseLog?.exerciseName ??
      exerciseKey,
    exerciseKey: getProgressExerciseKey({
      programId: session.programId ?? lookupEntry?.programId,
      programExerciseId: exerciseLog?.programExerciseId ?? lookupEntry?.programExerciseId,
      exerciseId: exerciseLog?.exerciseId ?? lookupEntry?.exerciseId,
      exerciseName: lookupEntry?.name ?? exerciseLog?.name ?? exerciseKey,
    }),
    setNumber: index + 1,
    reps,
    weight,
    rpe,
    completed: isCompletedAnalyticsSet(entry.value, weight, rpe),
    estimatedOneRepMax: calculateEstimatedOneRepMax(weight, reps),
    ...measured,
  };
}

/**
 * resolveProgressExerciseMatch(identity, lookup) -> { entry, via } where
 * via is "exact" (programId + programExerciseId), "loose" (occurrence id
 * only), "library" (Library id), "name" or "none". Same order as before H5.
 */
export function resolveProgressExerciseMatch(identity, exerciseLookup) {
  if (identity.programId && identity.programExerciseId) {
    const strictMatch = exerciseLookup.byProgramExercise.get(
      `${identity.programId}::${identity.programExerciseId}`,
    );

    if (strictMatch) {
      return { entry: strictMatch, via: "exact" };
    }
  }

  if (identity.programExerciseId) {
    const looseMatch = exerciseLookup.byLooseProgramExercise.get(identity.programExerciseId);

    if (looseMatch) {
      return { entry: looseMatch, via: "loose" };
    }
  }

  if (identity.exerciseId) {
    const exerciseMatch = exerciseLookup.byExerciseId.get(identity.exerciseId);

    if (exerciseMatch) {
      return { entry: exerciseMatch, via: "library" };
    }
  }

  if (identity.exerciseName) {
    const nameMatch = exerciseLookup.byExerciseName.get(normalizeProgressName(identity.exerciseName));
    return nameMatch ? { entry: nameMatch, via: "name" } : { entry: null, via: "none" };
  }

  return { entry: null, via: "none" };
}

export function resolveProgressExerciseEntry(identity, exerciseLookup) {
  return resolveProgressExerciseMatch(identity, exerciseLookup).entry;
}

export function buildProgressExerciseOptions({ activeProgram, activeProgramDays, exerciseLookup, setRecords }) {
  const options = new Map();

  activeProgramDays.forEach((day) => {
    day.exercises.forEach((exercise) => {
      const key = getProgressExerciseKey({
        programId: activeProgram?.id,
        programExerciseId: exercise.programExerciseId ?? exercise.id,
        exerciseId: exercise.libraryExerciseId ?? exercise.legacyExerciseId,
        exerciseName: exercise.name,
      });

      options.set(key, {
        key,
        programId: activeProgram?.id ?? null,
        programExerciseId: exercise.programExerciseId ?? exercise.id,
        exerciseId: exercise.libraryExerciseId ?? exercise.legacyExerciseId ?? exercise.id,
        name: exercise.name,
        programName: activeProgram?.nickname || activeProgram?.name || null,
        dayName: day.name,
        prescription: `${exercise.sets}x ${exercise.repsLabel} | ${formatWeight(exercise.recommendedWeight, exercise)} | RPE ${exercise.targetRPE} | ${formatRest(exercise.restSeconds)}`,
        loggedSetCount: 0,
        activeProgram: true,
      });
    });
  });

  setRecords.forEach((record) => {
    const existing = options.get(record.exerciseKey);

    if (existing) {
      existing.loggedSetCount += record.completed ? 1 : 0;
      return;
    }

    const lookupEntry = resolveProgressExerciseEntry(record, exerciseLookup);

    options.set(record.exerciseKey, {
      key: record.exerciseKey,
      programId: record.programId,
      programExerciseId: record.programExerciseId,
      exerciseId: record.exerciseId,
      name: lookupEntry?.name ?? record.exerciseName ?? "Exercise",
      programName: lookupEntry?.programName ?? null,
      dayName: record.dayName ?? lookupEntry?.dayName ?? null,
      prescription: lookupEntry?.prescription ?? "",
      loggedSetCount: record.completed ? 1 : 0,
      activeProgram: false,
    });
  });

  return [...options.values()].sort((left, right) => {
    if (left.loggedSetCount !== right.loggedSetCount) {
      return right.loggedSetCount - left.loggedSetCount;
    }

    if (left.activeProgram !== right.activeProgram) {
      return left.activeProgram ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export function buildSelectedExerciseAnalytics(exercise, setRecords) {
  const completedSets = setRecords
    .filter((set) => set.exerciseKey === exercise.key && set.completed)
    .sort((left, right) => getDateTime(right.date) - getDateTime(left.date));
  const weightedSets = completedSets.filter(
    (set) => typeof set.weight === "number" && Number.isFinite(set.reps),
  );
  const estimatedSets = weightedSets.filter((set) => set.estimatedOneRepMax !== null);
  const recentSessions = buildExerciseSessionSummaries(completedSets);
  // The best set is read in the exercise's current measurement (the latest
  // session's); an older reps log of a now-timed exercise does not outrank
  // the timed sets. All-reps history: unchanged.
  const currentMeasurement = recentSessions[0]?.measurement ?? "reps";
  const currentSets = completedSets.filter((set) => (set.measurement ?? "reps") === currentMeasurement);
  const bestSet = [...(currentSets.length ? currentSets : completedSets)].sort(compareBestSet)[0] ?? null;
  const trendValues = recentSessions.map((entry) => getExerciseTrendMetric(entry).value);
  const repsTrend = buildExerciseMetricTrend(recentSessions, "totalReps", formatPlainNumber, "reps");
  const volumeTrend = buildExerciseMetricTrend(recentSessions, "totalVolume", formatVolume);
  const strengthTrend = buildExerciseMetricTrend(recentSessions, "bestEstimatedStrength", formatKg);
  const timeTrend = buildExerciseMetricTrend(recentSessions, "bestSeconds", formatDuration);
  const totalTimeTrend = buildExerciseMetricTrend(recentSessions, "totalSeconds", formatDuration);
  const distanceTrend = buildExerciseMetricTrend(recentSessions, "bestMeters", formatMeters);
  const totalDistanceTrend = buildExerciseMetricTrend(recentSessions, "totalMeters", formatMeters);
  const trendInfo = buildExerciseProgressTrend(recentSessions);
  const measurement = recentSessions[0]?.measurement ?? "reps";

  return {
    completedSets,
    weightedSets,
    latestSession: recentSessions[0] ?? null,
    bestSet,
    bestEstimatedStrength: estimatedSets.length
      ? Math.max(...estimatedSets.map((set) => set.estimatedOneRepMax))
      : null,
    // Measurement-aware tonnage (H5-10); `loggedVolume` keeps the as-logged sum.
    totalVolume: sumTonnage(completedSets),
    loggedVolume: weightedSets.reduce((total, set) => total + set.weight * set.reps, 0),
    averageSetRpe: average(completedSets.map((set) => set.rpe).filter(Number.isFinite)),
    recentSessions,
    repsTrend,
    volumeTrend,
    strengthTrend,
    timeTrend,
    totalTimeTrend,
    distanceTrend,
    totalDistanceTrend,
    trendInfo,
    trendMaxValue: Math.max(0, ...trendValues.filter(Number.isFinite)),
    measurement,
    measurementUnit: MEASUREMENT_UNITS[measurement] ?? "reps",
    weightMode: recentSessions[0]?.weightMode ?? "kg",
    comparability: checkTrendComparability(recentSessions[0], recentSessions[1]),
    bestSeconds: maxField(completedSets, "seconds"),
    totalSeconds: sumField(completedSets, "seconds"),
    bestMeters: maxField(completedSets, "meters"),
    totalMeters: sumField(completedSets, "meters"),
  };
}

export function buildExerciseProgressTrend(recentSessions) {
  const usefulSessions = recentSessions.filter((entry) => {
    const metric = getExerciseTrendMetric(entry);
    return Number.isFinite(metric.value) && metric.value > 0;
  });

  if (usefulSessions.length < 2) {
    return {
      label: "Not enough data",
      body: "Log at least two useful sessions before reading the trend.",
      status: "not_enough_data",
      toneClass: "tone-neutral",
    };
  }

  const latest = usefulSessions[0];
  const previous = usefulSessions[1];
  const comparability = checkTrendComparability(latest, previous);

  if (!comparability.comparable) {
    return {
      label: "Not comparable",
      body: `${comparability.reason} The trend restarts from this session.`,
      status: "not_comparable",
      toneClass: "tone-neutral",
    };
  }

  const latestMetric = getExerciseTrendMetric(latest);
  const previousMetric = getExerciseTrendMetric(previous);
  const change = latestMetric.value - previousMetric.value;
  const threshold = Math.max(1, Math.abs(previousMetric.value) * 0.03);
  const rpeIsHigh = Number.isFinite(latest.averageRpe) && latest.averageRpe >= 8.5;

  if (change > threshold) {
    return {
      label: "Improving",
      body: `${latestMetric.label} improved versus last time. Keep building without forcing jumps.`,
      status: "improving",
      toneClass: "tone-good",
    };
  }

  if (change < -threshold && rpeIsHigh) {
    return {
      label: "Regressing",
      body: "Performance dipped while RPE was high. Treat this as a fatigue warning, not a panic signal.",
      status: "regressing",
      toneClass: "tone-caution",
    };
  }

  return {
    label: "Stable",
    body:
      change < -threshold
        ? "Performance dipped, but RPE was not clearly high. Watch the next session before reacting."
        : "Recent sessions look similar. Keep chasing clean reps or better control.",
    status: "stable",
    toneClass: "tone-steady",
  };
}

// Trend metric per measurement (H5-10): reps -> e1RM, then tonnage, then
// total reps (unchanged); time -> best seconds; distance -> best meters.
export function getExerciseTrendMetric(entry) {
  if (entry.measurement === "time") {
    return { label: "Best time", value: entry.bestSeconds ?? entry.totalSeconds ?? 0 };
  }

  if (entry.measurement === "distance") {
    return { label: "Best distance", value: entry.bestMeters ?? entry.totalMeters ?? 0 };
  }

  if (Number.isFinite(entry.bestEstimatedStrength) && entry.bestEstimatedStrength > 0) {
    return { label: "Estimated strength", value: entry.bestEstimatedStrength };
  }

  if (Number.isFinite(entry.totalVolume) && entry.totalVolume > 0) {
    return { label: "Volume", value: entry.totalVolume };
  }

  return { label: "Total reps", value: entry.totalReps };
}

export function buildExerciseMetricTrend(recentSessions, field, formatter, suffix = "") {
  const validEntries = recentSessions.filter(
    (entry) => Number.isFinite(entry[field]) && entry[field] > 0,
  );

  if (!validEntries.length) {
    return {
      value: "No data",
      detail: "Log this exercise to build a trend.",
    };
  }

  const latest = validEntries[0][field];

  if (validEntries.length < 2) {
    return {
      value: suffix ? `${formatter(latest)} ${suffix}` : formatter(latest),
      detail: "One logged session so far.",
    };
  }

  const comparability = checkTrendComparability(validEntries[0], validEntries[1]);
  const previous = validEntries[1][field];
  const difference = latest - previous;
  const formattedLatest = suffix ? `${formatter(latest)} ${suffix}` : formatter(latest);

  if (!comparability.comparable) {
    return {
      value: formattedLatest,
      detail: comparability.reason,
      comparable: false,
    };
  }

  if (Math.abs(difference) < 0.01) {
    return {
      value: formattedLatest,
      detail: "Stable versus last time.",
    };
  }

  const formattedDifference = suffix
    ? `${formatter(Math.abs(difference))} ${suffix}`
    : formatter(Math.abs(difference));

  return {
    value: formattedLatest,
    detail: `${difference > 0 ? "Up" : "Down"} ${formattedDifference} versus last time.`,
  };
}

export function buildExerciseSessionSummaries(records) {
  const sessionsById = new Map();

  records.forEach((record) => {
    const key = record.sessionId ?? `${record.date}-${record.exerciseKey}`;
    const entry = sessionsById.get(key) ?? {
      sessionId: key,
      date: record.date,
      sets: [],
    };

    entry.sets.push(record);
    sessionsById.set(key, entry);
  });

  return [...sessionsById.values()]
    .map((entry) => {
      const sets = entry.sets.sort((left, right) => left.setNumber - right.setNumber);
      const weightedSets = sets.filter(
        (set) => typeof set.weight === "number" && Number.isFinite(set.reps),
      );
      const rpes = sets.map((set) => set.rpe).filter(Number.isFinite);
      const totalReps = sets.reduce((total, set) => total + (Number.isFinite(set.reps) ? set.reps : 0), 0);
      const loggedVolume = weightedSets.reduce((total, set) => total + set.weight * set.reps, 0);
      const totalVolume = sets.some((set) => Number.isFinite(set.tonnage))
        ? sumTonnage(sets)
        : loggedVolume;
      const bestEstimatedStrength = weightedSets.length
        ? Math.max(...weightedSets.map((set) => set.estimatedOneRepMax ?? 0))
        : null;
      const bestSet = [...sets].sort(compareBestSet)[0] ?? null;
      const measurements = distinctValues(sets, "measurement");
      const weightModes = distinctValues(sets, "weightMode");
      // H5-20: per side and the load type are comparability guards too, so
      // the session entry carries them for checkTrendComparability.
      const loadTypes = distinctValues(sets, "loadType");
      const perSideCount = sets.filter((set) => set.perSide === true).length;

      return {
        ...entry,
        sets,
        bestSet,
        totalReps,
        totalVolume,
        loggedVolume,
        bestEstimatedStrength,
        averageRpe: average(rpes),
        setSummary: sets.map(formatSetPerformance).join(" | "),
        // Measurement of the session's sets (H5-10): the sets of one
        // occurrence share a profile; a mixed session reports the first.
        measurement: measurements[0] ?? "reps",
        weightMode: weightModes[0] ?? "kg",
        loadType: loadTypes[0] ?? "external",
        perSide: sets.length ? sets[0].perSide === true : false,
        mixedMeasurement:
          measurements.length > 1 ||
          weightModes.length > 1 ||
          loadTypes.length > 1 ||
          (perSideCount > 0 && perSideCount < sets.length),
        bestSeconds: maxField(sets, "seconds"),
        totalSeconds: sumField(sets, "seconds"),
        bestMeters: maxField(sets, "meters"),
        totalMeters: sumField(sets, "meters"),
      };
    })
    .sort((left, right) => getDateTime(right.date) - getDateTime(left.date));
}

export function buildReadinessEntries(readinessByDate, sessions) {
  const entries = Object.entries(readinessByDate ?? {})
    .map(([date, entry]) => {
      const readiness = entry?.readiness ?? (entry?.wellness ? interpretWellness(entry.wellness) : null);

      if (!readiness) {
        return null;
      }

      return { date: entry.date ?? date, readiness };
    })
    .filter(Boolean);

  if (!entries.length) {
    sessions.forEach((session) => {
      const readiness = session.readiness ?? (session.wellness ? interpretWellness(session.wellness) : null);

      if (readiness && session.date) {
        entries.push({
          date: getLocalDateKey(new Date(session.date)),
          // H1 follow-up: a training and a recovery session can share a date,
          // so the list key carries the session id (see ReadinessTrend).
          sessionId: session.id ?? null,
          readiness,
        });
      }
    });
  }

  return entries.sort((left, right) => getDateTime(`${right.date}T00:00:00`) - getDateTime(`${left.date}T00:00:00`));
}

// Best set per measurement (H5-10): rep-based sets rank by e1RM, weight,
// reps as before; timed sets by weight then seconds; distance sets by weight
// then meters. Across measurements reps rank above time above distance, so a
// mixed list never ranks 45 seconds against 45 reps.
const MEASUREMENT_RANK = Object.freeze({ reps: 0, time: 1, distance: 2 });

export function compareBestSet(left, right) {
  const leftMeasurement = left.measurement ?? "reps";
  const rightMeasurement = right.measurement ?? "reps";

  if (leftMeasurement !== rightMeasurement) {
    return (MEASUREMENT_RANK[leftMeasurement] ?? 0) - (MEASUREMENT_RANK[rightMeasurement] ?? 0);
  }

  const leftStrength = left.estimatedOneRepMax ?? -1;
  const rightStrength = right.estimatedOneRepMax ?? -1;

  if (leftStrength !== rightStrength) {
    return rightStrength - leftStrength;
  }

  const leftWeight = typeof left.weight === "number" ? left.weight : -1;
  const rightWeight = typeof right.weight === "number" ? right.weight : -1;

  if (leftWeight !== rightWeight) {
    return rightWeight - leftWeight;
  }

  if (leftMeasurement === "time") {
    return (right.seconds ?? -1) - (left.seconds ?? -1);
  }

  if (leftMeasurement === "distance") {
    return (right.meters ?? -1) - (left.meters ?? -1);
  }

  return (right.reps ?? -1) - (left.reps ?? -1);
}

export function getProgressExerciseKey({ programId, programExerciseId, exerciseId, exerciseName }) {
  if (programId && programExerciseId) {
    return `program-exercise:${programId}:${programExerciseId}`;
  }

  if (programExerciseId) {
    return `program-exercise:${programExerciseId}`;
  }

  if (exerciseId) {
    return `exercise:${exerciseId}`;
  }

  return `name:${normalizeProgressName(exerciseName ?? "exercise")}`;
}

export function getProgressSessionKey(session) {
  return session?.id ?? `${session?.date ?? "session"}-${session?.dayId ?? session?.dayName ?? "workout"}`;
}

export function getLibraryExerciseName(exerciseId, exerciseLookup) {
  return exerciseLookup.libraryById.get(exerciseId)?.name ?? null;
}

export function normalizeProgressName(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function parseAnalyticsNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseAnalyticsRpe(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 10 ? parsed : null;
}

export function isCompletedAnalyticsSet(reps, weight, rpe) {
  return Number.isFinite(reps) && (weight !== null || rpe !== null);
}

export function calculateEstimatedOneRepMax(weight, reps) {
  if (typeof weight !== "number" || !Number.isFinite(reps) || reps <= 0) {
    return null;
  }

  return weight * (1 + reps / 30);
}

export function average(values) {
  const validValues = values.filter(Number.isFinite);

  if (!validValues.length) {
    return null;
  }

  return validValues.reduce((total, value) => total + value, 0) / validValues.length;
}

export function getDateTime(value) {
  if (!value) {
    return 0;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function formatProgressDate(value) {
  if (!value) {
    return "No data";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "No data";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

export function formatAverage(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "No data";
}

export function formatPlainNumber(value) {
  if (!Number.isFinite(value)) {
    return "No data";
  }

  return value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
}

export function formatReadinessAverage(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} / 5` : "No data";
}

export function formatKg(value) {
  if (!Number.isFinite(value)) {
    return "No kg data";
  }

  return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} kg`;
}

export function formatVolume(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "No kg data";
  }

  return `${Math.round(value).toLocaleString()} kg`;
}

export function formatSetPerformance(set) {
  const weightText =
    typeof set.weight === "number"
      ? formatKg(set.weight)
      : set.weight === "BW"
        ? "BW"
        : "No kg";
  const valueText =
    set.measurement === "time"
      ? Number.isFinite(set.seconds)
        ? formatDuration(set.seconds)
        : "No time"
      : set.measurement === "distance"
        ? Number.isFinite(set.meters)
          ? formatMeters(set.meters)
          : "No distance"
        : Number.isFinite(set.reps)
          ? `${set.reps} reps`
          : "No reps";
  const rpeText = Number.isFinite(set.rpe) ? ` @ RPE ${set.rpe}` : "";

  return `${weightText} x ${valueText}${rpeText}`;
}

// Timed work: "45 sec", "2 min 30 sec" (same wording as the rest timer).
export function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "No time";
  }

  return formatRest(Math.round(value));
}

// Distance: "400 m", "1,200 m".
export function formatMeters(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "No distance";
  }

  return `${Math.round(value).toLocaleString()} m`;
}

export function formatBestWeightReps(set) {
  if (!set) {
    return "No set";
  }

  const repsText = Number.isFinite(set.reps) ? `${set.reps} reps` : "No reps";

  if (typeof set.weight === "number") {
    return `${formatKg(set.weight)} x ${repsText}`;
  }

  if (set.weight === "BW") {
    return `BW x ${repsText}`;
  }

  return repsText;
}
