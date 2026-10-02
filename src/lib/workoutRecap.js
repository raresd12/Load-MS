// Post-workout coach recap (Phase H4, decision H4-1): the in-memory recap
// App.jsx shows after Save Workout. Moved verbatim from src/App.jsx.
// Fixture: scripts/verify-workout-recap.mjs.
import {
  computeSessionAdherence,
  describeSessionAdherence,
  getSessionCoachStatus,
} from "./adherence.js";
import { computePersonalRecords, detectNewRecords, listIneligibleSets } from "./personalRecords.js";
import {
  getBestComparablePerformance,
  getComparableSessionRequirement,
  MIN_COMPARABLE_SESSIONS,
} from "./readinessPerformance.js";
import { getMeasurementProfile, getSetLoadForVolume, normalizeSetEntry } from "./measurement.js";
import {
  calculateEstimatedOneRepMax,
  checkTrendComparability,
  formatMetricValue,
  formatProgressDate,
  formatRecordLabel,
  formatSetPerformance,
  formatVolume,
  resolveSetMeasurementProfile,
} from "./sessionAnalytics.js";
import { normalizeWeight } from "./sessionLog.js";
import { getExerciseLog, numberValue } from "./sessionNormalize.js";

/**
 * buildPostWorkoutCoachRecap(session, previousSessions, day, generatedPlan, options)
 *
 * options (H5-10, all optional): { programs, programExercises (raw records or
 * day view models; default day.exercises), exerciseLibrary, previousRecords
 * (computePersonalRecords over the sessions before this one; computed from
 * `previousSessions` when omitted), minComparableSessions }.
 *
 * Returns the pre-H5 fields (id, savedAt, programName, dayName, exerciseCount,
 * setCount, totalVolume, bestSetText, improvedText, watchText, nextText) plus:
 *   adherence, adherenceText   - computeSessionAdherence / describeSessionAdherence
 *   records, recordsText       - detectNewRecords (primary identity, "first" excluded from the text)
 *   ineligibleSets             - listIneligibleSets (why a set is not a record)
 *   coachStatus, coachStatusText - "Held by you" / "Manual override" / "deload" hooks
 *   comparison, comparisonText - getBestComparablePerformance over this program+day
 */
export function buildPostWorkoutCoachRecap(session, previousSessions, day, generatedPlan, options = {}) {
  const completedSets = getPostWorkoutCompletedSets(session, day);
  const exerciseCount = new Set(completedSets.map((set) => set.exerciseKey).filter(Boolean)).size;
  const totalVolume = sumRecapTonnage(completedSets);
  const bestSet = getPostWorkoutBestSet(completedSets);
  const previousSession = getPreviousComparableSession(session, previousSessions);
  const previousSets = previousSession ? getPostWorkoutCompletedSets(previousSession, day) : [];
  const previousMetrics = previousSession
    ? getPostWorkoutSessionMetrics(previousSession, day)
    : null;
  const currentMetrics = {
    setCount: completedSets.length,
    totalReps: completedSets.reduce(
      (total, set) => total + (Number.isFinite(set.reps) ? set.reps : 0),
      0,
    ),
    totalVolume,
  };
  const comparability = previousSession ? checkRecapComparability(completedSets, previousSets) : null;
  const recordContext = buildRecapRecordContext(session, day, options);
  const priorSessions = (previousSessions ?? []).filter((entry) => entry?.id !== session.id);
  const previousRecords =
    options.previousRecords ?? computePersonalRecords({ ...recordContext, sessions: priorSessions });
  const records = detectNewRecords(previousRecords, session, recordContext);
  const ineligibleSets = listIneligibleSets(session, recordContext);
  const adherence = computeSessionAdherence({ session, exercises: day?.exercises ?? [] });
  const keptTargets = didPlanKeepTargets(session, generatedPlan);
  const coachStatus = getSessionCoachStatus(session, generatedPlan);
  const comparison = buildPostWorkoutComparison(session, previousSessions, day, {
    minComparableSessions: options.minComparableSessions ?? MIN_COMPARABLE_SESSIONS,
  });

  return {
    id: `recap-${session.id ?? Date.now()}`,
    savedAt: session.date,
    programName: session.programName ?? "Program",
    dayName: session.dayName ?? day?.name ?? "Workout",
    exerciseCount,
    setCount: completedSets.length,
    totalVolume,
    bestSetText: bestSet
      ? `${bestSet.exerciseName}: ${formatSetPerformance(bestSet)}`
      : "No complete working set found.",
    improvedText: buildPostWorkoutImprovementText(currentMetrics, previousMetrics, comparability),
    watchText: buildPostWorkoutWatchText(session, completedSets, day),
    nextText: buildPostWorkoutNextText(generatedPlan),
    adherence,
    adherenceText: describeSessionAdherence(adherence, { keptTargets }),
    records,
    recordsText: buildPostWorkoutRecordsText(records),
    ineligibleSets,
    coachStatus,
    coachStatusText: buildPostWorkoutCoachStatusText(coachStatus, day),
    comparison,
    comparisonText: comparison.text,
  };
}

function sumRecapTonnage(sets) {
  return sets.reduce(
    (total, set) => total + (Number.isFinite(set.tonnage) ? set.tonnage : 0),
    0,
  );
}

function buildRecapRecordContext(session, day, options) {
  const programExercises =
    options.programExercises ??
    (day?.exercises ?? []).map((exercise) => ({
      ...exercise,
      programId: exercise.programId ?? session?.programId ?? null,
    }));

  return {
    programs: options.programs ?? [],
    programExercises,
    exerciseLibrary: options.exerciseLibrary ?? [],
    activeProgram: options.activeProgram ?? (session?.programId ? { id: session.programId } : null),
  };
}

/**
 * The generated next plan kept the prescription the session was logged
 * against (sets, rep range and load equal for every planned exercise).
 * Without a plan nothing changed.
 */
export function didPlanKeepTargets(session, generatedPlan) {
  const planned = session?.plannedExercises ?? {};
  const exercises = generatedPlan?.exercises ?? [];

  return exercises.every((exercise) => {
    const snapshot = planned[exercise?.exerciseId ?? exercise?.programExerciseId];
    if (!snapshot) {
      return true;
    }

    const sameWeight =
      normalizeWeight(exercise.recommendedWeight) === normalizeWeight(snapshot.recommendedWeight);
    const sameSets = numberValue(exercise.sets, null) === numberValue(snapshot.sets, null);
    const sameReps =
      numberValue(exercise.repsMin, null) === numberValue(snapshot.repsMin, null) &&
      numberValue(exercise.repsMax, null) === numberValue(snapshot.repsMax, null);

    return sameWeight && sameSets && sameReps;
  });
}

/**
 * Current and previous completed sets are comparable when every exercise
 * logged in both was measured the same way (measurement + weight mode).
 */
export function checkRecapComparability(currentSets, previousSets) {
  const previousByKey = new Map();
  (previousSets ?? []).forEach((set) => {
    if (!previousByKey.has(set.exerciseKey)) {
      previousByKey.set(set.exerciseKey, set);
    }
  });

  for (const set of currentSets ?? []) {
    const previous = previousByKey.get(set.exerciseKey);
    if (!previous) {
      continue;
    }
    const result = checkTrendComparability(set, previous);
    if (!result.comparable) {
      return { comparable: false, reason: result.reason, exerciseName: set.exerciseName };
    }
  }

  return { comparable: true, reason: null, exerciseName: null };
}

export function buildPostWorkoutRecordsText(records) {
  // A "first" record of an exercise that already holds records (a new weight
  // key, a first timed set) reads as a new record; "first" stands only for the
  // first log of the exercise.
  // A first "reps at weight" of a known exercise is only a new weight key
  // (a lighter set, or the new top weight that best_weight already reports),
  // so it is never announced.
  const improved = (records ?? []).filter(
    (record) =>
      record.status === "new" ||
      (record.status === "first" && record.identityHadRecords && record.type !== "best_reps_at_weight"),
  );
  const tied = (records ?? []).filter((record) => record.status === "tied");
  const first = (records ?? []).filter((record) => record.status === "first" && !record.identityHadRecords);

  if (!improved.length && !tied.length) {
    return first.length
      ? "First records for this day logged - the next repeat can beat them."
      : "No new records today.";
  }

  const parts = [];
  if (improved.length) {
    parts.push(
      `New ${improved.length === 1 ? "record" : "records"}: ${improved
        .slice(0, 4)
        .map(
          (record) =>
            `${record.exerciseName} ${formatRecordLabel(record)}${record.previousValue !== null ? ` (was ${formatRecordLabel({ ...record, value: record.previousValue })})` : record.status === "first" ? " (first at this weight)" : ""}${record.acrossPrograms ? ", also across programs" : ""}`,
        )
        .join("; ")}${improved.length > 4 ? `; and ${improved.length - 4} more` : ""}.`,
    );
  }
  if (tied.length) {
    parts.push(
      `Tied: ${tied
        .slice(0, 3)
        .map((record) => `${record.exerciseName} ${formatRecordLabel(record)}`)
        .join("; ")}.`,
    );
  }

  return parts.join(" ");
}

export function buildPostWorkoutCoachStatusText(coachStatus, day) {
  if (!coachStatus) {
    return null;
  }

  const nameOf = (id) =>
    (day?.exercises ?? []).find((exercise) => (exercise.programExerciseId ?? exercise.id) === id)?.name ?? id;
  const parts = [];

  if (coachStatus.held.length) {
    parts.push(`Held by you: ${coachStatus.held.map(nameOf).join(", ")} stays at your held targets.`);
  }
  if (coachStatus.overridden.length) {
    parts.push(`Manual override: ${coachStatus.overridden.map(nameOf).join(", ")} uses your own numbers.`);
  }
  if (coachStatus.deload) {
    parts.push("Deload: targets are reduced on purpose; history stays as logged.");
  }

  return parts.length ? parts.join(" ") : null;
}

/**
 * buildPostWorkoutComparison(session, previousSessions, day, { minComparableSessions }) ->
 *   { comparable, metricId, metricLabel, unit, todayValue, bestValue, bestDate,
 *     isBest, rankedCount, needed, text }
 * Ranks this session among the saved sessions of the same program + day
 * within ONE metric (getBestComparablePerformance); says "Not comparable
 * yet: N more sessions needed" otherwise.
 */
const COMPARISON_METRIC_NOUNS = Object.freeze({
  e1rm: "e1RM",
  volume: "volume",
  time: "total time",
  distance: "total distance",
});

export function buildPostWorkoutComparison(session, previousSessions, day, { minComparableSessions = MIN_COMPARABLE_SESSIONS } = {}) {
  // H5 fix round 1 (decision H5-25): a session logged at minimal adherence
  // (a couple of sets of the day) is not a comparable session of the day.
  const isMinimal = (entry) =>
    computeSessionAdherence({ session: entry, exercises: day?.exercises ?? [] }).status === "minimal";
  const comparableSessions = (previousSessions ?? []).filter((previous) => {
    if (!previous || previous.id === session.id) {
      return false;
    }
    const sameDay = previous.dayId === session.dayId;
    const sameProgram = session.programId ? previous.programId === session.programId : true;
    return sameDay && sameProgram && !isMinimal(previous);
  });
  // e1RM is compared per exercise, never across the exercises of a day: the
  // anchor is the exercise with today's best e1RM, and every session is
  // ranked by its best e1RM of THAT exercise (H5-25). Volume, time and
  // distance stay day totals.
  const todaySets = getPostWorkoutCompletedSets(session, day);
  const anchor = findE1rmAnchor(todaySets);
  // Decision H5-51: a session whose sets were logged under another
  // measurement, weight mode, per-side flag or load type than today's (the
  // rule of the Improved line, checkRecapComparability) is not a comparable
  // session; and with no weighted set today there is no e1RM anchor, so
  // e1RM is not ranked at all (never the best lift of any exercise).
  const sameProfileSessions = comparableSessions.filter(
    (entry) => checkRecapComparability(todaySets, getPostWorkoutCompletedSets(entry, day)).comparable,
  );
  const anchorKey = anchor?.exerciseKey ?? NO_E1RM_ANCHOR;
  const summaries = [session, ...sameProfileSessions].map((entry) => summarizeRecapSession(entry, day, anchorKey));
  const requirement = getComparableSessionRequirement(summaries, { minSessions: minComparableSessions });
  const best = getBestComparablePerformance(summaries, { minSessions: minComparableSessions });

  if (!best.comparable) {
    const needed = requirement.needed;
    return {
      comparable: false,
      metricId: requirement.metricId,
      metricLabel: null,
      unit: null,
      exerciseName: null,
      todayValue: null,
      bestValue: null,
      bestDate: null,
      isBest: false,
      rankedCount: requirement.rankedCount,
      needed,
      text: `Not comparable yet: ${needed} more ${needed === 1 ? "session" : "sessions"} needed.`,
    };
  }

  const todaySummary = summaries[0];
  const metric = best.metricId;
  const todayValue =
    metric === "e1rm"
      ? todaySummary.bestEstimatedStrength
      : metric === "volume"
        ? todaySummary.totalVolume
        : metric === "time"
          ? todaySummary.totalSeconds
          : todaySummary.totalMeters;
  const isBest = best.session.id === session.id;
  const exerciseName = metric === "e1rm" ? anchor?.exerciseName ?? null : null;
  const noun = COMPARISON_METRIC_NOUNS[metric] ?? best.metricLabel.toLowerCase();
  const label = exerciseName ? `${exerciseName} ${noun}` : noun;
  const text = isBest
    ? `Today is your best ${label} for this day: ${formatMetricValue(metric, best.value)} across ${best.rankedCount} comparable sessions.`
    : `Best ${label} for this day stays ${formatMetricValue(metric, best.value)} (${formatProgressDate(best.session.date)}); today ${Number.isFinite(todayValue) && todayValue > 0 ? formatMetricValue(metric, todayValue) : "not ranked"}, across ${best.rankedCount} comparable sessions.`;

  return {
    comparable: true,
    metricId: metric,
    metricLabel: best.metricLabel,
    unit: best.unit,
    exerciseName,
    todayValue: Number.isFinite(todayValue) ? todayValue : null,
    bestValue: best.value,
    bestDate: best.session.date,
    isBest,
    rankedCount: best.rankedCount,
    needed: 0,
    text,
  };
}

// Matches no exercise key: summarizeRecapSession then reports no e1RM.
const NO_E1RM_ANCHOR = Symbol("no e1RM anchor");

/** The completed set with the highest e1RM of a session, or null. */
function findE1rmAnchor(sets) {
  return sets.reduce((best, set) => {
    const value = calculateEstimatedOneRepMax(set.weight, set.reps);
    if (!Number.isFinite(value) || !set.exerciseKey) {
      return best;
    }
    return !best || value > best.value ? { exerciseKey: set.exerciseKey, exerciseName: set.exerciseName, value } : best;
  }, null);
}

function summarizeRecapSession(session, day, anchorKey = null) {
  const sets = getPostWorkoutCompletedSets(session, day);
  const strengths = sets
    .filter((set) => anchorKey === null || set.exerciseKey === anchorKey)
    .map((set) => calculateEstimatedOneRepMax(set.weight, set.reps))
    .filter((value) => Number.isFinite(value));

  return {
    id: session.id,
    date: session.date,
    bestEstimatedStrength: strengths.length ? Math.max(...strengths) : null,
    totalVolume: sumRecapTonnage(sets),
    totalSeconds: sets.reduce((total, set) => total + (Number.isFinite(set.seconds) ? set.seconds : 0), 0),
    totalMeters: sets.reduce((total, set) => total + (Number.isFinite(set.meters) ? set.meters : 0), 0),
  };
}

// The recap keeps its pre-H5 parsing (NaN for a missing reps / RPE, the
// session-log weight normalisation) and adds the measurement fields of
// measurement.js: a set that only carries reps stays a reps set (H5-1).
function buildRecapSetFields(set, exercise, completedFlag) {
  const profile = resolveSetMeasurementProfile(set, exercise ? getMeasurementProfile(exercise) : undefined);
  const entry = normalizeSetEntry(set, profile);
  const value = entry.value === null ? NaN : entry.value;
  const reps = entry.measurement === "reps" ? value : NaN;
  const weight = normalizeWeight(set?.actualWeight ?? set?.weight ?? set?.kg);

  return {
    reps,
    weight,
    rpe: numberValue(set?.actualRPE ?? set?.rpe, NaN),
    completed: completedFlag && Number.isFinite(value) && weight !== null,
    measurement: entry.measurement,
    weightMode: profile.weightMode,
    loadType: profile.loadType,
    // H5-20: per side doubles the tonnage, so it is a comparability guard.
    perSide: profile.perSide === true,
    value,
    seconds: entry.measurement === "time" ? value : null,
    meters: entry.measurement === "distance" ? value : null,
    tonnage: getSetLoadForVolume(set, profile).tonnage,
  };
}

export function getPostWorkoutCompletedSets(session, day) {
  const exerciseByProgramExerciseId = new Map(
    (day?.exercises ?? []).map((exercise) => [exercise.programExerciseId ?? exercise.id, exercise]),
  );
  const exerciseByExerciseId = new Map(
    (day?.exercises ?? []).map((exercise) => [
      exercise.libraryExerciseId ?? exercise.legacyExerciseId ?? exercise.id,
      exercise,
    ]),
  );

  if (Array.isArray(session?.workoutSets) && session.workoutSets.length) {
    return session.workoutSets
      .map((set) => {
        const exercise =
          exerciseByProgramExerciseId.get(set.programExerciseId) ??
          exerciseByExerciseId.get(set.exerciseId);

        return {
          exerciseKey: set.programExerciseId ?? set.exerciseId ?? exercise?.id,
          exerciseName: exercise?.name ?? "Exercise",
          setNumber: set.setNumber,
          ...buildRecapSetFields(set, exercise, Boolean(set.completed)),
          targetRepsMin: exercise?.repsMin ?? null,
        };
      })
      .filter((set) => set.completed);
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
    const exercise =
      exerciseByProgramExerciseId.get(exerciseLog?.programExerciseId ?? exerciseKey) ??
      exerciseByExerciseId.get(exerciseLog?.exerciseId);

    return sets
      .map((set, index) => {
        const fields = buildRecapSetFields(
          {
            ...set,
            actualReps: set?.reps ?? set?.actualReps,
            actualWeight: set?.weight ?? set?.kg ?? set?.actualWeight,
            actualRPE: set?.rpe ?? set?.actualRPE ?? exerciseLog?.exerciseRPE,
          },
          exercise,
          true,
        );

        return {
          exerciseKey,
          exerciseName: exercise?.name ?? exerciseLog?.name ?? exerciseLog?.exerciseName ?? "Exercise",
          setNumber: index + 1,
          ...fields,
          targetRepsMin: exercise?.repsMin ?? null,
        };
      })
      .filter((set) => set.completed);
  });
}

// e1RM first, then set volume (kg x value) or the bare value: reps for
// rep-based sets, seconds / meters for timed / distance sets (H5-10).
function recapSetValue(set) {
  return Number.isFinite(set.value) ? set.value : set.reps;
}

export function getPostWorkoutBestSet(completedSets) {
  return [...completedSets].sort((left, right) => {
    const leftStrength = calculateEstimatedOneRepMax(left.weight, left.reps) ?? -1;
    const rightStrength = calculateEstimatedOneRepMax(right.weight, right.reps) ?? -1;

    if (leftStrength !== rightStrength) {
      return rightStrength - leftStrength;
    }

    const leftValue = recapSetValue(left);
    const rightValue = recapSetValue(right);
    const leftVolume = typeof left.weight === "number" ? left.weight * leftValue : leftValue;
    const rightVolume = typeof right.weight === "number" ? right.weight * rightValue : rightValue;
    return rightVolume - leftVolume;
  })[0] ?? null;
}

export function getPreviousComparableSession(session, previousSessions) {
  return (previousSessions ?? []).find((previousSession) => {
    if (previousSession.id === session.id) {
      return false;
    }

    const sameDay = previousSession.dayId === session.dayId;
    const sameProgram = session.programId
      ? previousSession.programId === session.programId
      : true;

    return sameDay && sameProgram;
  }) ?? null;
}

export function getPostWorkoutSessionMetrics(session, day) {
  const completedSets = getPostWorkoutCompletedSets(session, day);

  return {
    setCount: completedSets.length,
    totalReps: completedSets.reduce(
      (total, set) => total + (Number.isFinite(set.reps) ? set.reps : 0),
      0,
    ),
    // Measurement-aware tonnage (H5-10): identical to kg x reps for kg sets.
    totalVolume: sumRecapTonnage(completedSets),
  };
}

export function buildPostWorkoutImprovementText(currentMetrics, previousMetrics, comparability = null) {
  if (!previousMetrics) {
    return "First log for this day saved - that's your baseline to beat.";
  }

  if (comparability && comparability.comparable === false) {
    return `Not comparable: measurement changed since the last log of this day${comparability.exerciseName ? ` (${comparability.exerciseName})` : ""}. Today is the new baseline.`;
  }

  if (currentMetrics.totalVolume > 0 && previousMetrics.totalVolume > 0) {
    const difference = currentMetrics.totalVolume - previousMetrics.totalVolume;

    if (difference > Math.max(5, previousMetrics.totalVolume * 0.02)) {
      return `Volume improved from ${formatVolume(previousMetrics.totalVolume)} to ${formatVolume(currentMetrics.totalVolume)}.`;
    }
  }

  if (currentMetrics.totalReps > previousMetrics.totalReps) {
    return `Total reps improved from ${previousMetrics.totalReps} to ${currentMetrics.totalReps}.`;
  }

  if (currentMetrics.setCount > previousMetrics.setCount) {
    return `More working sets completed than last time: ${currentMetrics.setCount} vs ${previousMetrics.setCount}.`;
  }

  return "Logged and counted. The next repeat of this day will tell us more.";
}

export function buildPostWorkoutWatchText(session, completedSets, day) {
  const sessionRpe = numberValue(session.sessionRpe, NaN);
  const readiness = session.readiness ?? session.readinessSnapshot?.readiness ?? null;
  const painFlaggedNames = (day?.exercises ?? [])
    .filter((exercise) => getExerciseLog(session, exercise)?.painFlag)
    .map((exercise) => exercise.name);

  if (painFlaggedNames.length) {
    return `You flagged pain on ${painFlaggedNames.join(", ")}. Good call logging it - the coach holds back there until a pain-free session. If it keeps coming back, get it looked at.`;
  }
  const missedTargetSets = completedSets.filter(
    (set) =>
      Number.isFinite(set.targetRepsMin) &&
      Number.isFinite(set.reps) &&
      set.reps < set.targetRepsMin,
  ).length;
  const highSetRpeCount = completedSets.filter((set) => Number.isFinite(set.rpe) && set.rpe >= 9.5)
    .length;

  if (Number.isFinite(sessionRpe) && sessionRpe >= 9) {
    return "That one ran hot. If the fatigue carries into next session, take the conservative option.";
  }

  if (readiness?.status === "red" || readiness?.isPoor) {
    return "You trained on low readiness - judge today's numbers in that context before changing anything.";
  }

  if (missedTargetSets > 0) {
    return `${missedTargetSets} ${missedTargetSets === 1 ? "set landed" : "sets landed"} below the target range. Keep an eye on load selection next time.`;
  }

  if (highSetRpeCount > 0) {
    return "A few sets were near the limit. Progress only if the reps stay clean next time.";
  }

  if (day?.type === "recovery") {
    return "Recovery work saved. Let readiness pick the next training day.";
  }

  return "Nothing to worry about here - effort and readiness both look in range.";
}

export function buildPostWorkoutNextText(generatedPlan) {
  const exerciseNote = generatedPlan?.exercises
    ?.map((exercise) => {
      const reason =
        exercise.reasons?.find((entry) => String(entry ?? "").trim()) ??
        exercise.repFocus ??
        exercise.recommendationNote;

      return reason ? `${exercise.name}: ${reason}` : "";
    })
    .find(Boolean);

  if (exerciseNote) {
    return exerciseNote;
  }

  if (generatedPlan?.status || generatedPlan?.generatedAt) {
    return "Next session recommendation was generated from this log.";
  }

  return "Save more complete sets to sharpen the next recommendation.";
}

// Dashboard "last session" and "last 7 days" numbers (H4 fix round 3, decision
// H4-15). Moved from src/pages/DashboardPage.jsx; `now` is injectable for the
// fixture (default Date.now(), as before).
/**
 * The day view model a session was logged against, from the active program's
 * days (H5 fix round 1, decision H5-24): same day id, and the same program
 * when both sides name one. A session of another program (or of no program)
 * is read with its own persisted set fields only, as before.
 */
export function findSessionDay(session, days) {
  if (!session?.dayId || !Array.isArray(days)) {
    return null;
  }

  return (
    days.find(
      (day) =>
        day?.id === session.dayId &&
        (!session.programId || !day.programId || day.programId === session.programId),
    ) ?? null
  );
}

export function getDashboardSessionMetrics(session, { days = null } = {}) {
  // With the active program's days the Dashboard reads a set exactly as
  // Progress and the recap do (the set's own persisted profile first, then
  // the exercise profile), so the three never disagree on volume (H5-24).
  const completedSets = getPostWorkoutCompletedSets(session, findSessionDay(session, days));

  return {
    setCount: completedSets.length,
    volume: sumRecapTonnage(completedSets),
  };
}

export function buildDashboardWeekStats(sessions, now = Date.now(), { days = null } = {}) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const recentSessions = sessions.filter((session) => {
    const time = new Date(session.date).getTime();
    return Number.isFinite(time) && now - time <= weekMs;
  });

  let setCount = 0;
  let volume = 0;
  const sessionRpes = [];

  recentSessions.forEach((session) => {
    const metrics = getDashboardSessionMetrics(session, { days });
    setCount += metrics.setCount;
    volume += metrics.volume;

    // A session saved without a session RPE stores null; Number(null) is 0 and
    // used to pull the average down (fixed in H4 fix round 3, decision H4-15).
    const rpe = numberValue(session.sessionRpe, null);
    if (rpe !== null) {
      sessionRpes.push(rpe);
    }
  });

  return {
    workouts: recentSessions.length,
    setCount,
    volume,
    averageRpe: sessionRpes.length
      ? sessionRpes.reduce((total, rpe) => total + rpe, 0) / sessionRpes.length
      : null,
  };
}
