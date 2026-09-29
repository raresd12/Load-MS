// Session, "last time", Dashboard-free Progress analytics (Phase H4,
// decision H4-1). Moved verbatim from src/App.jsx: the per-session analytics
// stored on a saved session, the "Last time" / beat-last cue, and every pure
// Progress-page builder (weekly review, insight cards, exercise trends, PR /
// best-set ranking, readiness/performance analytics) plus their formatters.
// JSX components stay in App.jsx. Fixture: scripts/verify-session-analytics.mjs.
import { getLocalDateKey } from "./date.js";
import { formatRest, formatWeight, interpretWellness } from "./progression.js";
import { getProgramDayViewModels } from "./programStorage.js";
import { getBestComparablePerformance } from "./readinessPerformance.js";
import { getAverageNumericWeight, getLoggedReps, normalizeWeight } from "./sessionLog.js";
import {
  calculateAutoExerciseRpe,
  getExerciseLog,
  isBlank,
  numberValue,
} from "./sessionNormalize.js";

// Window of the Progress page's "recent" counters (30 days).
export const recentWorkoutWindowDays = 30;

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

export function getSessionAnalytics(day, draft) {
  const exerciseSummaries = day.exercises.map((exercise) => {
    const draftExercise = draft.exercises[exercise.id];
    const completedSets = draftExercise.sets.filter(
      (set) => !isBlank(set.reps) && !isBlank(set.weight) && !isBlank(set.rpe),
    );
    const reps = draftExercise.sets
      .map((set) => numberValue(set.reps, NaN))
      .filter(Number.isFinite);
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
    };
  });

  return {
    exerciseCount: day.exercises.length,
    loggedSetCount: exerciseSummaries.reduce((total, exercise) => total + exercise.setCount, 0),
    totalReps: exerciseSummaries.reduce((total, exercise) => total + exercise.totalReps, 0),
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

export function buildWeeklyReviewNotes(current, previous, bestSet) {
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

  return notes;
}

export function buildWeeklyReview(sessionSummaries, setRecords, now = Date.now()) {
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

  return {
    current,
    previous,
    bestSet,
    notes: buildWeeklyReviewNotes(current, previous, bestSet),
  };
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
    totalVolume: weightedSets.reduce((total, set) => total + set.weight * set.reps, 0),
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
      totalVolume: weightedRecords.reduce((total, record) => total + record.weight * record.reps, 0),
      bestEstimatedStrength: estimatedRecords.length
        ? Math.max(...estimatedRecords.map((record) => record.estimatedOneRepMax))
        : null,
      weightedSetCount: weightedRecords.length,
    };
  });
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
    good: "border border-lime-300/30 bg-lime-300/10 text-lime-100",
    steady: "border border-sky-300/30 bg-sky-300/10 text-sky-100",
    caution: "border border-amber-300/30 bg-amber-300/10 text-amber-100",
    neutral: "border border-zinc-700 bg-zinc-800 text-zinc-300",
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
  const byProgramExercise = new Map();
  const byLooseProgramExercise = new Map();
  const byExerciseId = new Map();
  const byExerciseName = new Map();
  const libraryById = new Map((exerciseLibrary ?? []).map((exercise) => [exercise.id, exercise]));
  const programEntries = new Map();

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
    };

    if (entry.programId && entry.programExerciseId) {
      byProgramExercise.set(`${entry.programId}::${entry.programExerciseId}`, entry);
    }

    if (entry.programExerciseId) {
      byLooseProgramExercise.set(entry.programExerciseId, entry);
    }

    if (entry.exerciseId) {
      const current = byExerciseId.get(entry.exerciseId);
      if (!current || entry.activeProgram) {
        byExerciseId.set(entry.exerciseId, entry);
      }
    }

    if (entry.name) {
      byExerciseName.set(normalizeProgressName(entry.name), entry);
    }

    programEntries.set(entry.key, entry);
  }

  (programs ?? []).forEach((program) => {
    getProgramDayViewModels(program.id).forEach((day) => {
      day.exercises.forEach((exercise) => addProgramExercise(program, day, exercise));
    });
  });

  if (activeProgram && !programEntries.size) {
    activeProgramDays.forEach((day) => {
      day.exercises.forEach((exercise) => addProgramExercise(activeProgram, day, exercise));
    });
  }

  return {
    byProgramExercise,
    byLooseProgramExercise,
    byExerciseId,
    byExerciseName,
    libraryById,
    programEntries,
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

export function normalizeWorkoutSetRecord(session, set, exerciseLookup) {
  const lookupEntry = resolveProgressExerciseEntry(
    {
      programId: set.programId ?? session.programId,
      programExerciseId: set.programExerciseId,
      exerciseId: set.exerciseId,
      exerciseName: set.exerciseName,
    },
    exerciseLookup,
  );
  const reps = parseAnalyticsNumber(set.actualReps ?? set.reps);
  const weight = normalizeWeight(set.actualWeight ?? set.weight ?? set.kg);
  const rpe = parseAnalyticsRpe(set.actualRPE ?? set.rpe);

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
    completed: Boolean(set.completed) || isCompletedAnalyticsSet(reps, weight, rpe),
    estimatedOneRepMax: calculateEstimatedOneRepMax(weight, reps),
  };
}

export function normalizeLegacySetRecord(session, exerciseKey, exerciseLog, set, index, exerciseLookup) {
  const lookupEntry = resolveProgressExerciseEntry(
    {
      programId: session.programId,
      programExerciseId: exerciseLog?.programExerciseId ?? exerciseKey,
      exerciseId: exerciseLog?.exerciseId,
      exerciseName: exerciseLog?.name ?? exerciseLog?.exerciseName,
    },
    exerciseLookup,
  );
  const reps = parseAnalyticsNumber(set?.reps ?? set?.actualReps);
  const weight = normalizeWeight(set?.weight ?? set?.kg ?? set?.actualWeight);
  const setRpe = parseAnalyticsRpe(set?.rpe ?? set?.actualRPE);
  const exerciseRpe = parseAnalyticsRpe(exerciseLog?.exerciseRPE);
  const rpe = setRpe ?? exerciseRpe;

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
    completed: isCompletedAnalyticsSet(reps, weight, rpe),
    estimatedOneRepMax: calculateEstimatedOneRepMax(weight, reps),
  };
}

export function resolveProgressExerciseEntry(identity, exerciseLookup) {
  if (identity.programId && identity.programExerciseId) {
    const strictMatch = exerciseLookup.byProgramExercise.get(
      `${identity.programId}::${identity.programExerciseId}`,
    );

    if (strictMatch) {
      return strictMatch;
    }
  }

  if (identity.programExerciseId) {
    const looseMatch = exerciseLookup.byLooseProgramExercise.get(identity.programExerciseId);

    if (looseMatch) {
      return looseMatch;
    }
  }

  if (identity.exerciseId) {
    const exerciseMatch = exerciseLookup.byExerciseId.get(identity.exerciseId);

    if (exerciseMatch) {
      return exerciseMatch;
    }
  }

  if (identity.exerciseName) {
    return exerciseLookup.byExerciseName.get(normalizeProgressName(identity.exerciseName)) ?? null;
  }

  return null;
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
  const bestSet = [...completedSets].sort(compareBestSet)[0] ?? null;
  const recentSessions = buildExerciseSessionSummaries(completedSets);
  const trendValues = recentSessions.map(
    (entry) => entry.bestEstimatedStrength ?? entry.totalVolume ?? entry.totalReps,
  );
  const repsTrend = buildExerciseMetricTrend(recentSessions, "totalReps", formatPlainNumber, "reps");
  const volumeTrend = buildExerciseMetricTrend(recentSessions, "totalVolume", formatVolume);
  const strengthTrend = buildExerciseMetricTrend(recentSessions, "bestEstimatedStrength", formatKg);
  const trendInfo = buildExerciseProgressTrend(recentSessions);

  return {
    completedSets,
    weightedSets,
    latestSession: recentSessions[0] ?? null,
    bestSet,
    bestEstimatedStrength: estimatedSets.length
      ? Math.max(...estimatedSets.map((set) => set.estimatedOneRepMax))
      : null,
    totalVolume: weightedSets.reduce((total, set) => total + set.weight * set.reps, 0),
    averageSetRpe: average(completedSets.map((set) => set.rpe).filter(Number.isFinite)),
    recentSessions,
    repsTrend,
    volumeTrend,
    strengthTrend,
    trendInfo,
    trendMaxValue: Math.max(0, ...trendValues),
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
      toneClass: "border border-zinc-700 bg-zinc-800 text-zinc-300",
    };
  }

  const latest = usefulSessions[0];
  const previous = usefulSessions[1];
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
      toneClass: "border border-lime-300/30 bg-lime-300/10 text-lime-100",
    };
  }

  if (change < -threshold && rpeIsHigh) {
    return {
      label: "Regressing",
      body: "Performance dipped while RPE was high. Treat this as a fatigue warning, not a panic signal.",
      status: "regressing",
      toneClass: "border border-amber-300/30 bg-amber-300/10 text-amber-100",
    };
  }

  return {
    label: "Stable",
    body:
      change < -threshold
        ? "Performance dipped, but RPE was not clearly high. Watch the next session before reacting."
        : "Recent sessions look similar. Keep chasing clean reps or better control.",
    status: "stable",
    toneClass: "border border-sky-300/30 bg-sky-300/10 text-sky-100",
  };
}

export function getExerciseTrendMetric(entry) {
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

  const previous = validEntries[1][field];
  const difference = latest - previous;
  const formattedLatest = suffix ? `${formatter(latest)} ${suffix}` : formatter(latest);

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
      const totalVolume = weightedSets.reduce((total, set) => total + set.weight * set.reps, 0);
      const bestEstimatedStrength = weightedSets.length
        ? Math.max(...weightedSets.map((set) => set.estimatedOneRepMax ?? 0))
        : null;
      const bestSet = [...sets].sort(compareBestSet)[0] ?? null;

      return {
        ...entry,
        sets,
        bestSet,
        totalReps,
        totalVolume,
        bestEstimatedStrength,
        averageRpe: average(rpes),
        setSummary: sets.map(formatSetPerformance).join(" | "),
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

export function compareBestSet(left, right) {
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
  const repsText = Number.isFinite(set.reps) ? `${set.reps} reps` : "No reps";
  const rpeText = Number.isFinite(set.rpe) ? ` @ RPE ${set.rpe}` : "";

  return `${weightText} x ${repsText}${rpeText}`;
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
