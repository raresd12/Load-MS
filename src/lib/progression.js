function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  const cleanValues = values.map(Number).filter(Number.isFinite);
  if (!cleanValues.length) {
    return null;
  }

  return cleanValues.reduce((sum, value) => sum + value, 0) / cleanValues.length;
}

function sum(values) {
  return values.map(Number).filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function roundTo(value, step) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (!step || step <= 0) {
    return Number(value.toFixed(1));
  }

  return Number((Math.round(value / step) * step).toFixed(2));
}

function floorTo(value, step) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (!step || step <= 0) {
    return Number(value.toFixed(1));
  }

  return Number((Math.floor(value / step) * step).toFixed(2));
}

function getNumericWeight(value, exercise) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string" && value.trim().toLowerCase() === "bw") {
    return exercise.loadType === "optionalExternal" ? 0 : null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSetLogs(exerciseLog) {
  return exerciseLog?.sets ?? [];
}

function getLoggedReps(setLogs) {
  return setLogs.map((set) => toNumber(set.reps, NaN)).filter(Number.isFinite);
}

function getWorkingWeight(setLogs, plannedWeight, exercise) {
  const loggedWeights = setLogs
    .map((set) => getNumericWeight(set.weight, exercise))
    .filter((value) => value !== null);

  if (loggedWeights.length) {
    return average(loggedWeights);
  }

  return getNumericWeight(plannedWeight, exercise);
}

function getLoadJump(exercise) {
  if (exercise.incrementKg) {
    return exercise.incrementKg;
  }

  if (exercise.equipment === "dumbbell") {
    return exercise.category === "compound" ? 2 : 1;
  }

  if (exercise.loadType === "optionalExternal") {
    return 2.5;
  }

  return exercise.category === "compound" ? 2.5 : 1.25;
}

function increaseLoad(currentWeight, exercise) {
  if (currentWeight === null || exercise.loadType === "bodyweight") {
    return currentWeight;
  }

  return roundTo(currentWeight + getLoadJump(exercise), exercise.roundToKg ?? 1);
}

function decreaseLoad(currentWeight, exercise, percentage) {
  if (currentWeight === null || exercise.loadType === "bodyweight") {
    return currentWeight;
  }

  const step = exercise.roundToKg ?? 1;
  const adjusted = currentWeight * (1 - percentage / 100);
  return Math.max(0, floorTo(adjusted, step));
}

function formatRpe(value) {
  return Number.isFinite(value) ? `RPE ${value.toFixed(1)}` : "unknown RPE";
}

function canProgressLoad(exercise) {
  return exercise.loadType !== "bodyweight";
}

function getExerciseIds(exerciseOrId) {
  if (typeof exerciseOrId === "string") {
    return [exerciseOrId];
  }

  return [
    exerciseOrId.id,
    exerciseOrId.programExerciseId,
    exerciseOrId.legacyExerciseId,
    exerciseOrId.libraryExerciseId,
  ].filter((id, index, ids) => id && ids.indexOf(id) === index);
}

function getExerciseLog(container, exerciseOrId) {
  const ids = getExerciseIds(exerciseOrId);
  const logs = container?.exercises ?? container ?? {};
  const matchedId = ids.find((id) => logs?.[id]);

  if (matchedId) {
    return logs[matchedId];
  }

  const workoutSets = container?.workoutSets?.filter(
    (set) => ids.includes(set.programExerciseId) || ids.includes(set.exerciseId),
  );

  if (!workoutSets?.length) {
    return null;
  }

  const setRpes = workoutSets
    .map((set) => Number(set.actualRPE))
    .filter(Number.isFinite);
  const exerciseRPE = setRpes.length
    ? Number((setRpes.reduce((total, rpe) => total + rpe, 0) / setRpes.length).toFixed(1))
    : null;

  return {
    exerciseRPE,
    sets: workoutSets
      .slice()
      .sort((left, right) => left.setNumber - right.setNumber)
      .map((set) => ({
        reps: set.actualReps,
        weight: set.actualWeight,
        rpe: set.actualRPE,
      })),
  };
}

function getPreviousExerciseSession(dayId, exercise, sessions = []) {
  return sessions.find(
    (session) => session.dayId === dayId && getExerciseLog(session, exercise),
  );
}

function isAccessoryReductionCandidate(exercise) {
  return (
    exercise.priority !== "high" &&
    (exercise.category === "isolation" || exercise.category === "core")
  );
}

export const wellnessMetrics = [
  { id: "soreness", label: "Soreness" },
  { id: "fatigue", label: "Fatigue" },
  { id: "mood", label: "Mood" },
  { id: "stress", label: "Stress" },
  { id: "sleep", label: "Sleep" },
];

export function interpretWellness(wellness = {}) {
  const wellnessInput = wellness && typeof wellness === "object" ? wellness : {};
  const scores = wellnessMetrics.map((metric) => ({
    ...metric,
    value: toNumber(wellnessInput[metric.id], 3),
  }));
  const lowMetrics = scores.filter((score) => score.value <= 2);
  const averageScore = average(scores.map((score) => score.value)) ?? 3;
  const status =
    averageScore >= 4 && lowMetrics.length === 0
      ? "green"
      : averageScore < 3 || lowMetrics.length >= 2
        ? "red"
        : "yellow";

  return {
    status,
    averageScore,
    isPoor: status === "red",
    isGood: status === "green",
    lowMetrics: lowMetrics.map((metric) => metric.label),
  };
}

export function formatRest(restSeconds) {
  if (Array.isArray(restSeconds)) {
    return `${formatRestValue(restSeconds[0])} - ${formatRestValue(restSeconds[1])}`;
  }

  return formatRestValue(restSeconds);
}

function formatRestValue(seconds) {
  const cleanSeconds = toNumber(seconds);
  const minutes = Math.floor(cleanSeconds / 60);
  const remainingSeconds = cleanSeconds % 60;

  if (!minutes) {
    return `${remainingSeconds} sec`;
  }

  if (!remainingSeconds) {
    return `${minutes} min`;
  }

  return `${minutes} min ${remainingSeconds} sec`;
}

export function formatSetsReps(planExercise) {
  return `${planExercise.sets}x ${planExercise.repsLabel}`;
}

export function formatWeight(weight, exercise) {
  if (exercise.loadType === "bodyweight") {
    return "Bodyweight";
  }

  if (weight === null || weight === undefined || weight === "") {
    return exercise.loadType === "optionalExternal" ? "BW / add kg" : "Enter kg";
  }

  if (typeof weight === "string" && weight.trim().toLowerCase() === "bw") {
    return "BW";
  }

  const numericWeight = Number(weight);
  if (!Number.isFinite(numericWeight)) {
    return "Enter kg";
  }

  const formattedWeight = Number.isInteger(numericWeight)
    ? numericWeight.toString()
    : numericWeight.toFixed(1);
  const suffix =
    exercise.weightMode && exercise.weightMode !== "kg" ? ` ${exercise.weightMode}` : "";

  return `${formattedWeight} kg${suffix}`;
}

export function isWeightEditable(exercise) {
  return exercise.loadType !== "bodyweight";
}

export function getBasePlan(day) {
  return {
    schemaVersion: 2,
    dayId: day.id,
    dayName: day.name,
    dayType: day.type,
    generatedAt: null,
    sourceSessionId: null,
    status: "base",
    lighterSession: false,
    wellnessSummary: interpretWellness(),
    readinessNotes: [],
    exercises: day.exercises.map((exercise) => ({
      exerciseId: exercise.id,
      name: exercise.name,
      sets: exercise.sets,
      repsMin: exercise.repsMin,
      repsMax: exercise.repsMax,
      repsLabel: exercise.repsLabel,
      restSeconds: exercise.restSeconds,
      targetRPE: exercise.targetRPE,
      recommendedWeight: exercise.recommendedWeight,
      previousWeight: exercise.recommendedWeight,
      repFocus: null,
      totalReps: null,
      previousTotalReps: null,
      exerciseRPE: null,
      reasons: ["Base program prescription."],
      conservative: false,
    })),
  };
}

export function getPlanForDay(day, savedPlan) {
  const basePlan = getBasePlan(day);
  if (!savedPlan || savedPlan.dayId !== day.id) {
    return basePlan;
  }

  return {
    ...basePlan,
    ...savedPlan,
    dayType: day.type,
    exercises: day.exercises.map((exercise) => {
      const savedExercisePlan = savedPlan.exercises?.find(
        (entry) => entry.exerciseId === exercise.id,
      );
      const baseExercisePlan = basePlan.exercises.find(
        (entry) => entry.exerciseId === exercise.id,
      );

      return {
        ...baseExercisePlan,
        ...savedExercisePlan,
        name: exercise.name,
        repsMin: savedExercisePlan?.repsMin ?? exercise.repsMin,
        repsMax: savedExercisePlan?.repsMax ?? exercise.repsMax,
        repsLabel: savedExercisePlan?.repsLabel ?? exercise.repsLabel,
        restSeconds: savedExercisePlan?.restSeconds ?? exercise.restSeconds,
      };
    }),
  };
}

export function generateNextPlan(day, session, previousSessions = []) {
  const wellnessSummary = session.readiness ?? interpretWellness(session.wellness);
  const sessionRpe = toNumber(session.sessionRpe, 7);
  const highSessionRpe = sessionRpe >= 9;
  const readinessNotes = [];

  if (day.type === "recovery") {
    return {
      schemaVersion: 2,
      dayId: day.id,
      dayName: day.name,
      dayType: day.type,
      generatedAt: new Date().toISOString(),
      sourceSessionId: session.id,
      status: "generated",
      lighterSession: wellnessSummary.isPoor,
      wellnessSummary,
      readinessNotes: wellnessSummary.missing
        ? ["No readiness check-in was saved, so recovery guidance stayed neutral."]
        : wellnessSummary.isPoor
          ? ["Readiness was low today, so keep recovery work easy and crisp."]
          : ["Recovery day logged. Keep the next recovery slot flexible."],
      exercises: [],
    };
  }

  if (highSessionRpe) {
    readinessNotes.push("Session RPE was 9 or higher, so next-session jumps stay conservative.");
  }

  if (wellnessSummary.missing) {
    readinessNotes.push("No readiness check-in was saved, so recommendations used neutral readiness.");
  } else if (wellnessSummary.isPoor) {
    readinessNotes.push("Readiness was low today, so progression was kept conservative.");
  } else if (wellnessSummary.isGood) {
    readinessNotes.push("Readiness was strong today, so normal progression rules can work fully.");
  }

  return {
    schemaVersion: 2,
    dayId: day.id,
    dayName: day.name,
    dayType: day.type,
    generatedAt: new Date().toISOString(),
    sourceSessionId: session.id,
    status: "generated",
    lighterSession: wellnessSummary.isPoor,
    wellnessSummary,
    readinessNotes,
    exercises: day.exercises.map((exercise) => {
      const previousExerciseSession = getPreviousExerciseSession(
        day.id,
        exercise,
        previousSessions,
      );

      return calculateExerciseRecommendation(
        exercise,
        session,
        previousExerciseSession,
        wellnessSummary,
      );
    }),
  };
}

function calculateExerciseRecommendation(exercise, session, previousExerciseSession, wellnessSummary) {
  const exerciseLog = getExerciseLog(session, exercise);
  const planned = getExerciseLog(session.plannedExercises, exercise) ?? {};
  const setLogs = getSetLogs(exerciseLog);
  const loggedReps = getLoggedReps(setLogs);
  const previousSetLogs = getSetLogs(getExerciseLog(previousExerciseSession, exercise));
  const previousLoggedReps = getLoggedReps(previousSetLogs);
  const previousTotalReps = previousLoggedReps.length ? sum(previousLoggedReps) : null;
  const exerciseRPE = toNumber(exerciseLog?.exerciseRPE, NaN);
  const sessionRpe = toNumber(session.sessionRpe, 7);
  const highSessionRpe = sessionRpe >= 9;
  const targetSets = toNumber(planned.sets, exercise.sets);
  const repsMin = planned.repsMin ?? exercise.repsMin;
  const repsMax = planned.repsMax ?? exercise.repsMax;
  const plannedWeight = planned.recommendedWeight ?? exercise.recommendedWeight;
  const workingWeight = getWorkingWeight(setLogs, plannedWeight, exercise);
  const previousWeight = plannedWeight;
  const allSetsLogged = loggedReps.length >= targetSets;
  const totalReps = allSetsLogged ? sum(loggedReps) : null;
  const allAtMin = repsMin === null ? allSetsLogged : allSetsLogged && loggedReps.every((rep) => rep >= repsMin);
  const allAtTop = repsMax === null ? false : allSetsLogged && loggedReps.every((rep) => rep >= repsMax);
  const belowMin = repsMin === null ? false : loggedReps.some((rep) => rep < repsMin);
  const regressed =
    totalReps !== null &&
    previousTotalReps !== null &&
    totalReps < previousTotalReps &&
    workingWeight !== null &&
    getWorkingWeight(previousSetLogs, previousWeight, exercise) !== null;
  const reasons = [];

  let nextWeight = workingWeight;
  let nextSets = targetSets;
  let repFocus = null;
  let conservative = false;

  if (!exerciseLog || !loggedReps.length) {
    return {
      exerciseId: exercise.id,
      name: exercise.name,
      sets: nextSets,
      repsMin,
      repsMax,
      repsLabel: exercise.repsLabel,
      restSeconds: exercise.restSeconds,
      targetRPE: planned.targetRPE ?? exercise.targetRPE,
      recommendedWeight: plannedWeight,
      previousWeight,
      repFocus: "Log this next time to establish a baseline.",
      totalReps: null,
      previousTotalReps,
      exerciseRPE: null,
      reasons: ["No completed log was found, so the plan stays unchanged."],
      conservative: false,
    };
  }

  if (totalReps !== null && previousTotalReps !== null && totalReps > previousTotalReps) {
    reasons.push(
      `Total reps improved from ${previousTotalReps} to ${totalReps}. Keep building this pattern.`,
    );
  }

  if (exercise.progressionType === "athletic") {
    const athleticResult = progressAthleticExercise({
      exercise,
      exerciseRPE,
      allAtTop,
      highSessionRpe,
      wellnessSummary,
      workingWeight,
      reasons,
    });
    nextWeight = athleticResult.nextWeight;
    repFocus = athleticResult.repFocus;
    conservative = athleticResult.conservative;
  } else if (exercise.progressionType === "core") {
    const coreResult = progressCoreExercise({
      exercise,
      exerciseRPE,
      allAtTop,
      belowMin,
      highSessionRpe,
      wellnessSummary,
      workingWeight,
      reasons,
    });
    nextWeight = coreResult.nextWeight;
    repFocus = coreResult.repFocus;
    conservative = coreResult.conservative;
  } else if (exercise.category === "isolation" || exercise.progressionType === "pump") {
    const isolationResult = progressIsolationExercise({
      exercise,
      exerciseRPE,
      allAtTop,
      allAtMin,
      belowMin,
      wellnessSummary,
      highSessionRpe,
      workingWeight,
      reasons,
    });
    nextWeight = isolationResult.nextWeight;
    repFocus = isolationResult.repFocus;
    conservative = isolationResult.conservative;
  } else {
    const compoundResult = progressCompoundExercise({
      exercise,
      exerciseRPE,
      allAtTop,
      allAtMin,
      belowMin,
      regressed,
      wellnessSummary,
      highSessionRpe,
      workingWeight,
      totalReps,
      previousTotalReps,
      reasons,
    });
    nextWeight = compoundResult.nextWeight;
    repFocus = compoundResult.repFocus;
    conservative = compoundResult.conservative;
  }

  if (highSessionRpe && wellnessSummary.isPoor && isAccessoryReductionCandidate(exercise)) {
    nextSets = Math.max(1, nextSets - 1);
    conservative = true;
    reasons.push("Accessory volume reduced because overall fatigue was high.");
  }

  if (!reasons.length) {
    reasons.push("Load kept stable while you build cleaner reps inside the target range.");
  }

  return {
    exerciseId: exercise.id,
    name: exercise.name,
    sets: nextSets,
    repsMin,
    repsMax,
    repsLabel: exercise.repsLabel,
    restSeconds: exercise.restSeconds,
    targetRPE: planned.targetRPE ?? exercise.targetRPE,
    recommendedWeight: nextWeight,
    previousWeight,
    repFocus,
    totalReps: totalReps ?? 0,
    previousTotalReps,
    exerciseRPE,
    reasons,
    conservative,
  };
}

function progressCompoundExercise({
  exercise,
  exerciseRPE,
  allAtTop,
  allAtMin,
  belowMin,
  regressed,
  wellnessSummary,
  highSessionRpe,
  workingWeight,
  totalReps,
  previousTotalReps,
  reasons,
}) {
  if (allAtTop && exerciseRPE <= 8.5) {
    if (canProgressLoad(exercise) && workingWeight === null) {
      reasons.push("Reps were strong; enter the working kg so this lift has a progression baseline.");
      return {
        nextWeight: workingWeight,
        repFocus: "Set the real working load next time.",
        conservative: false,
      };
    }

    if (wellnessSummary.isPoor) {
      if (highSessionRpe || exerciseRPE > 8) {
        reasons.push(
          "Performance was strong, but readiness was low today. Load was held so the next session can confirm it under better recovery.",
        );
        return {
          nextWeight: workingWeight,
          repFocus: "Repeat this load and confirm it moves well again.",
          conservative: true,
        };
      }

      reasons.push(
        "Performance was strong despite low readiness. A small progression is allowed, but the recommendation remains conservative.",
      );
      return {
        nextWeight: increaseLoad(workingWeight, exercise),
        repFocus: "Own the same rep range with the small jump.",
        conservative: true,
      };
    }

    if (highSessionRpe) {
      reasons.push("Load kept stable because performance was strong but session RPE was very high.");
      return {
        nextWeight: workingWeight,
        repFocus: "Repeat this load and confirm it moves well again.",
        conservative: true,
      };
    }

    if (wellnessSummary.isGood) {
      reasons.push("Readiness and performance were both strong. Progression applied normally.");
    }
    reasons.push("Load increased because all sets reached the top of the rep range at manageable RPE.");
    return {
      nextWeight: increaseLoad(workingWeight, exercise),
      repFocus: "Own the same rep range with the heavier load.",
      conservative: false,
    };
  }

  if ((belowMin && exerciseRPE >= 9) || (regressed && exerciseRPE >= 9)) {
    if (wellnessSummary.isPoor) {
      reasons.push(
        "Performance was below target, but readiness was low today. Load was held rather than reduced aggressively. Reassess next time under better recovery.",
      );
      return {
        nextWeight: workingWeight,
        repFocus: "Repeat the load and judge it again with better recovery.",
        conservative: true,
      };
    }

    const reduction = exerciseRPE >= 9.5 || belowMin ? 5 : 2.5;
    reasons.push(
      wellnessSummary.isGood
        ? "Readiness was good, but performance and RPE suggest this load should be held or slightly reduced next time."
        : "Load slightly reduced because reps fell below target with high RPE.",
    );
    return {
      nextWeight: decreaseLoad(workingWeight, exercise, reduction),
      repFocus: "Rebuild the bottom of the range with cleaner reps.",
      conservative: true,
    };
  }

  if (allAtMin || exerciseRPE >= 8.5) {
    const previousText =
      totalReps !== null && previousTotalReps !== null && totalReps > previousTotalReps
        ? " Total reps improved, so keep the load and beat that number again."
        : "";
    reasons.push(`Load kept stable because performance was solid but RPE was high or reps are still building.${previousText}`);
    return {
      nextWeight: workingWeight,
      repFocus:
        previousTotalReps !== null && totalReps !== null
          ? `Beat ${totalReps} total reps next time.`
          : "Baseline logged. Beat this total next time.",
      conservative: false,
    };
  }

  return {
    nextWeight: workingWeight,
    repFocus: "Keep load and build total reps before adding weight.",
    conservative: wellnessSummary.isPoor,
  };
}

function progressIsolationExercise({
  exercise,
  exerciseRPE,
  allAtTop,
  allAtMin,
  belowMin,
  wellnessSummary,
  highSessionRpe,
  workingWeight,
  reasons,
}) {
  if (allAtTop && exerciseRPE <= 8.5) {
    if (canProgressLoad(exercise) && workingWeight === null) {
      reasons.push("Top-range reps were hit; enter the working kg before the app starts load jumps.");
      return {
        nextWeight: workingWeight,
        repFocus: "Use this as the baseline session for load.",
        conservative: false,
      };
    }

    if (wellnessSummary.isPoor) {
      if (highSessionRpe || exerciseRPE > 8) {
        reasons.push(
          "Top-range reps were there, but readiness was low today. Load stayed stable and reps-first progression stays conservative.",
        );
        return {
          nextWeight: workingWeight,
          repFocus: "Repeat the load and keep form strict.",
          conservative: true,
        };
      }

      reasons.push(
        "Performance was strong despite low readiness. A small isolation progression is allowed, but the recommendation remains conservative.",
      );
      return {
        nextWeight: increaseLoad(workingWeight, exercise),
        repFocus: "Reset to the lower end and keep the reps clean.",
        conservative: true,
      };
    }

    if (highSessionRpe) {
      reasons.push("Load kept stable because the session RPE was very high.");
      return {
        nextWeight: workingWeight,
        repFocus: "Repeat the load and keep form strict.",
        conservative: true,
      };
    }

    if (wellnessSummary.isGood) {
      reasons.push("Readiness and performance were both strong. Progression applied normally.");
    }
    reasons.push("Load increased because every set hit the top of the range with controlled RPE.");
    return {
      nextWeight: increaseLoad(workingWeight, exercise),
      repFocus: "Reset to the lower end and keep the reps clean.",
      conservative: false,
    };
  }

  if (belowMin && exerciseRPE >= 9) {
    if (wellnessSummary.isPoor) {
      reasons.push(
        "Performance was below target, but readiness was low today. Load was held rather than reduced aggressively. Reassess next time under better recovery.",
      );
      return {
        nextWeight: workingWeight,
        repFocus: "Repeat the load and rebuild strict reps.",
        conservative: true,
      };
    }

    reasons.push(
      wellnessSummary.isGood
        ? "Readiness was good, but performance and RPE suggest this load should be held or slightly reduced next time."
        : "Load slightly reduced because isolation reps fell below target with high RPE.",
    );
    return {
      nextWeight: decreaseLoad(workingWeight, exercise, wellnessSummary.isPoor ? 5 : 2.5),
      repFocus: "Reclaim the rep range before loading again.",
      conservative: true,
    };
  }

  if (allAtMin) {
    reasons.push("Load kept stable; reps-first progression says to add reps before load.");
    return {
      nextWeight: workingWeight,
      repFocus: "Add 1 rep where you can while form stays sharp.",
      conservative: wellnessSummary.isPoor || highSessionRpe,
    };
  }

  reasons.push("Load kept stable while you restore the target rep range.");
  return {
    nextWeight: workingWeight,
    repFocus: "Get every set back into range.",
    conservative: wellnessSummary.isPoor,
  };
}

function progressAthleticExercise({
  exercise,
  exerciseRPE,
  allAtTop,
  highSessionRpe,
  wellnessSummary,
  workingWeight,
  reasons,
}) {
  if (
    (exercise.id === "hang-cleans" || exercise.legacyExerciseId === "hang-cleans") &&
    allAtTop &&
    exerciseRPE <= 7.5 &&
    !wellnessSummary.isPoor &&
    !highSessionRpe
  ) {
    if (workingWeight === null) {
      reasons.push("Hang clean reps were crisp; enter the working kg before progressing the load.");
      return {
        nextWeight: workingWeight,
        repFocus: "Establish a crisp baseline load.",
        conservative: false,
      };
    }

    reasons.push("Load increased slowly because hang clean execution stayed explosive at low RPE.");
    return {
      nextWeight: increaseLoad(workingWeight, exercise),
      repFocus: "Keep every rep fast and crisp.",
      conservative: false,
    };
  }

  if (wellnessSummary.isPoor && allAtTop && exerciseRPE <= 8) {
    reasons.push(
      "Performance was strong despite low readiness, but explosive work stays conservative so speed and quality remain the priority.",
    );
    return {
      nextWeight: workingWeight,
      repFocus: "Repeat the same work and keep every rep fast.",
      conservative: true,
    };
  }

  reasons.push("Athletic work held steady so quality, speed, and crisp execution stay the priority.");
  return {
    nextWeight: workingWeight,
    repFocus: "Keep reps powerful; stop chasing fatigue.",
    conservative: wellnessSummary.isPoor || highSessionRpe,
  };
}

function progressCoreExercise({
  exercise,
  exerciseRPE,
  allAtTop,
  belowMin,
  highSessionRpe,
  wellnessSummary,
  workingWeight,
  reasons,
}) {
  if (allAtTop && exerciseRPE <= 8.5 && wellnessSummary.isPoor) {
    reasons.push(
      "Performance was strong despite low readiness. Core progression stayed conservative so control does not turn into fatigue chasing.",
    );
    return {
      nextWeight: workingWeight,
      repFocus: "Repeat this quality before making the variation harder.",
      conservative: true,
    };
  }

  if (allAtTop && exerciseRPE <= 8.5 && !wellnessSummary.isPoor && !highSessionRpe) {
    if (canProgressLoad(exercise) && workingWeight !== null) {
      if (wellnessSummary.isGood) {
        reasons.push("Readiness and performance were both strong. Progression applied normally.");
      }
      reasons.push("Core difficulty progressed with a small load increase after controlled top-range reps.");
      return {
        nextWeight: increaseLoad(workingWeight, exercise),
        repFocus: "Keep control strict with the small jump.",
        conservative: false,
      };
    }

    reasons.push("Core work progressed by control or difficulty, not random extra volume.");
    return {
      nextWeight: workingWeight,
      repFocus: "Use slower control or a slightly harder variation.",
      conservative: false,
    };
  }

  if (belowMin && exerciseRPE >= 9) {
    reasons.push("Core target held steady because fatigue pushed reps below the goal.");
    return {
      nextWeight: workingWeight,
      repFocus: "Rebuild controlled reps before making it harder.",
      conservative: true,
    };
  }

  reasons.push("Core plan held steady; keep reps controlled and repeatable.");
  return {
    nextWeight: workingWeight,
    repFocus: "Add quality before load or volume.",
    conservative: wellnessSummary.isPoor || highSessionRpe,
  };
}
