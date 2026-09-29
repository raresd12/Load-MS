// Post-workout coach recap (Phase H4, decision H4-1): the in-memory recap
// App.jsx shows after Save Workout. Moved verbatim from src/App.jsx.
// Fixture: scripts/verify-workout-recap.mjs.
import {
  calculateEstimatedOneRepMax,
  formatSetPerformance,
  formatVolume,
} from "./sessionAnalytics.js";
import { normalizeWeight } from "./sessionLog.js";
import { getExerciseLog, numberValue } from "./sessionNormalize.js";

export function buildPostWorkoutCoachRecap(session, previousSessions, day, generatedPlan) {
  const completedSets = getPostWorkoutCompletedSets(session, day);
  const exerciseCount = new Set(completedSets.map((set) => set.exerciseKey).filter(Boolean)).size;
  const totalVolume = completedSets.reduce(
    (total, set) =>
      typeof set.weight === "number" && Number.isFinite(set.reps)
        ? total + set.weight * set.reps
        : total,
    0,
  );
  const bestSet = getPostWorkoutBestSet(completedSets);
  const previousSession = getPreviousComparableSession(session, previousSessions);
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
    improvedText: buildPostWorkoutImprovementText(currentMetrics, previousMetrics),
    watchText: buildPostWorkoutWatchText(session, completedSets, day),
    nextText: buildPostWorkoutNextText(generatedPlan),
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
        const reps = numberValue(set.actualReps ?? set.reps, NaN);
        const weight = normalizeWeight(set.actualWeight ?? set.weight ?? set.kg);
        const rpe = numberValue(set.actualRPE ?? set.rpe, NaN);

        return {
          exerciseKey: set.programExerciseId ?? set.exerciseId ?? exercise?.id,
          exerciseName: exercise?.name ?? "Exercise",
          setNumber: set.setNumber,
          reps,
          weight,
          rpe,
          completed: Boolean(set.completed) && Number.isFinite(reps) && weight !== null,
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
        const reps = numberValue(set?.reps ?? set?.actualReps, NaN);
        const weight = normalizeWeight(set?.weight ?? set?.kg ?? set?.actualWeight);
        const rpe = numberValue(set?.rpe ?? set?.actualRPE ?? exerciseLog?.exerciseRPE, NaN);

        return {
          exerciseKey,
          exerciseName: exercise?.name ?? exerciseLog?.name ?? exerciseLog?.exerciseName ?? "Exercise",
          setNumber: index + 1,
          reps,
          weight,
          rpe,
          completed: Number.isFinite(reps) && weight !== null,
          targetRepsMin: exercise?.repsMin ?? null,
        };
      })
      .filter((set) => set.completed);
  });
}

export function getPostWorkoutBestSet(completedSets) {
  return [...completedSets].sort((left, right) => {
    const leftStrength = calculateEstimatedOneRepMax(left.weight, left.reps) ?? -1;
    const rightStrength = calculateEstimatedOneRepMax(right.weight, right.reps) ?? -1;

    if (leftStrength !== rightStrength) {
      return rightStrength - leftStrength;
    }

    const leftVolume = typeof left.weight === "number" ? left.weight * left.reps : left.reps;
    const rightVolume = typeof right.weight === "number" ? right.weight * right.reps : right.reps;
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
    totalVolume: completedSets.reduce(
      (total, set) =>
        typeof set.weight === "number" && Number.isFinite(set.reps)
          ? total + set.weight * set.reps
          : total,
      0,
    ),
  };
}

export function buildPostWorkoutImprovementText(currentMetrics, previousMetrics) {
  if (!previousMetrics) {
    return "First log for this day saved - that's your baseline to beat.";
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
export function getDashboardSessionMetrics(session) {
  const completedSets = getPostWorkoutCompletedSets(session, null);

  return {
    setCount: completedSets.length,
    volume: completedSets.reduce(
      (total, set) =>
        typeof set.weight === "number" && Number.isFinite(set.reps)
          ? total + set.weight * set.reps
          : total,
      0,
    ),
  };
}

export function buildDashboardWeekStats(sessions, now = Date.now()) {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const recentSessions = sessions.filter((session) => {
    const time = new Date(session.date).getTime();
    return Number.isFinite(time) && now - time <= weekMs;
  });

  let setCount = 0;
  let volume = 0;
  const sessionRpes = [];

  recentSessions.forEach((session) => {
    const metrics = getDashboardSessionMetrics(session);
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
