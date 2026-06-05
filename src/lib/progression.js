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
  return Array.isArray(exerciseLog?.sets) ? exerciseLog.sets : [];
}

function getLoggedReps(setLogs) {
  return setLogs
    .map((set) => toNumber(set.reps ?? set.actualReps, NaN))
    .filter(Number.isFinite);
}

function getWorkingWeight(setLogs, plannedWeight, exercise) {
  const loggedWeights = setLogs
    .map((set) => getNumericWeight(set.weight ?? set.actualWeight ?? set.kg, exercise))
    .filter((value) => value !== null);

  if (loggedWeights.length) {
    return average(loggedWeights);
  }

  return getNumericWeight(plannedWeight, exercise);
}

function getLoadJump(exercise) {
  const classification = classifyExerciseType(exercise);

  if (exercise.incrementKg) {
    return exercise.incrementKg;
  }

  if (exercise.equipment === "dumbbell") {
    return classification.type === "compound" ? 2 : 1;
  }

  if (exercise.loadType === "optionalExternal") {
    return 2.5;
  }

  return classification.type === "compound" ? 2.5 : 1.25;
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

  if (Array.isArray(logs)) {
    const matchedExercise = logs.find((log) =>
      ids.some((id) =>
        [
          log?.id,
          log?.exerciseId,
          log?.programExerciseId,
          log?.legacyExerciseId,
          log?.libraryExerciseId,
        ].includes(id),
      ),
    );

    if (matchedExercise) {
      return matchedExercise;
    }
  }

  const analyticsSummary = container?.analytics?.exerciseSummaries?.find((summary) =>
    ids.includes(summary.exerciseId) || ids.includes(summary.programExerciseId),
  );

  if (analyticsSummary) {
    return {
      exerciseRPE: analyticsSummary.exerciseRPE,
      totalReps: analyticsSummary.totalReps,
      setCount: analyticsSummary.setCount,
      averageWeight: analyticsSummary.averageWeight,
      sets: [],
    };
  }

  const workoutSets = container?.workoutSets?.filter(
    (set) => ids.includes(set.programExerciseId) || ids.includes(set.exerciseId),
  );

  if (!workoutSets?.length) {
    return null;
  }

  const setRpes = workoutSets
    .map((set) => Number(set.actualRPE ?? set.rpe))
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
        reps: set.actualReps ?? set.reps,
        weight: set.actualWeight ?? set.weight ?? set.kg,
        rpe: set.actualRPE ?? set.rpe,
      })),
  };
}

function getPreviousExerciseSession(dayId, exercise, sessions = []) {
  return getPreviousExerciseSessions(dayId, exercise, null, sessions)[0] ?? null;
}

function getSessionTime(session) {
  const date = new Date(session?.date ?? session?.completedAt ?? session?.createdAt ?? 0);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function getPreviousExerciseSessions(dayId, exercise, currentSession, sessions = []) {
  return [...(sessions ?? [])]
    .filter((session) => {
      if (!session || session.id === currentSession?.id) {
        return false;
      }

      const sameDay =
        !dayId ||
        !session.dayId ||
        session.dayId === dayId ||
        session.dayName === currentSession?.dayName;

      return sameDay && Boolean(getExerciseLog(session, exercise));
    })
    .sort((left, right) => getSessionTime(right) - getSessionTime(left))
    .slice(0, 5);
}

function isAccessoryReductionCandidate(exercise) {
  return classifyExerciseType(exercise).isLowPriorityAccessory;
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
      decision: "hold",
      confidence: "low",
      warnings: [],
      historyTrend: "insufficient_history",
      historySampleSize: 0,
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
      const previousExerciseSessions = getPreviousExerciseSessions(
        day.id,
        exercise,
        session,
        previousSessions,
      );

      return calculateExerciseRecommendationV2(
        exercise,
        session,
        previousExerciseSessions,
        wellnessSummary,
        day.id,
      );
    }),
  };
}

function textIncludesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function getFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getExerciseRpeFromLog(exerciseLog, setLogs) {
  const directRpe = getFiniteNumber(exerciseLog?.exerciseRPE ?? exerciseLog?.exerciseRpe);

  if (directRpe !== null) {
    return directRpe;
  }

  const setRpes = setLogs
    .map((set) => getFiniteNumber(set.rpe ?? set.actualRPE))
    .filter((value) => value !== null);

  return average(setRpes);
}

function getAggregateTotalReps(exerciseLog, loggedReps) {
  if (loggedReps.length) {
    return sum(loggedReps);
  }

  return getFiniteNumber(
    exerciseLog?.totalReps ??
      exerciseLog?.completedReps ??
      exerciseLog?.repsCompleted ??
      exerciseLog?.actualReps,
  );
}

function getLoggedSetCount(exerciseLog, loggedReps) {
  if (loggedReps.length) {
    return loggedReps.length;
  }

  return getFiniteNumber(
    exerciseLog?.setCount ?? exerciseLog?.loggedSetCount ?? exerciseLog?.completedSetCount,
  );
}

function getExerciseAverageWeight(exerciseLog, setLogs, plannedWeight, exercise) {
  const aggregateWeight = getFiniteNumber(exerciseLog?.averageWeight ?? exerciseLog?.actualWeight);

  if (aggregateWeight !== null) {
    return aggregateWeight;
  }

  return getWorkingWeight(setLogs, plannedWeight, exercise);
}

export function classifyExerciseType(exercise = {}) {
  const text = [
    exercise.id,
    exercise.name,
    exercise.category,
    exercise.progressionType,
    exercise.muscleGroup,
    exercise.equipment,
    exercise.type,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const progressionType = String(exercise.progressionType ?? exercise.type ?? "").toLowerCase();
  const priority = String(exercise.priority ?? "").toLowerCase();
  const equipment = String(exercise.equipment ?? "").toLowerCase();
  const athleticPattern = [
    /\bathletic\b/,
    /\bjump\b/,
    /\bjumps\b/,
    /\bclean\b/,
    /\bexplosive\b/,
    /\bpogo\b/,
    /\bplyo/,
    /\bbasketball\b/,
  ];
  const mobilityPattern = [/\bmobility\b/, /\bstretch/];
  const corePattern = [
    /\bcore\b/,
    /\babs?\b/,
    /\bplank\b/,
    /\bcrunch\b/,
    /\bleg raise\b/,
    /\bsit-?up\b/,
    /\bcopenhagen\b/,
  ];
  const isolationPattern = [
    /\bisolation\b/,
    /\bpump\b/,
    /\bcurl\b/,
    /\bextension\b/,
    /\braise\b/,
    /\bfly\b/,
    /\bcalf\b/,
    /\bhamstring curl\b/,
    /\btibialis\b/,
    /\bpec deck\b/,
    /\bskull\b/,
  ];
  const compoundPattern = [
    /\bbench\b/,
    /\bpress\b/,
    /\bpull-?ups?\b/,
    /\bchin-?ups?\b/,
    /\bdips?\b/,
    /\brow\b/,
    /\bpulldown\b/,
    /\bsquat\b/,
    /\bdeadlift\b/,
    /\brdl\b/,
    /\blunge\b/,
    /\bsplit squat\b/,
  ];

  let type = "compound";

  if (progressionType === "mobility" || textIncludesAny(text, mobilityPattern)) {
    type = "mobility";
  } else if (progressionType === "athletic" || textIncludesAny(text, athleticPattern)) {
    type = "athletic";
  } else if (progressionType === "core" || textIncludesAny(text, corePattern)) {
    type = "core";
  } else if (textIncludesAny(text, isolationPattern)) {
    type = "isolation";
  } else if (
    progressionType === "strength" ||
    progressionType === "hypertrophy" ||
    textIncludesAny(text, compoundPattern)
  ) {
    type = "compound";
  } else if (progressionType === "pump") {
    type = "isolation";
  }

  const isHighPriority = priority === "high";
  const isMainCompound = type === "compound" && (isHighPriority || progressionType === "strength");
  const isWeightedBodyweight = exercise.loadType === "optionalExternal";
  const isLoadable = exercise.loadType !== "bodyweight";
  const isLowPriorityAccessory =
    !isMainCompound &&
    priority !== "high" &&
    (type === "isolation" || type === "core");

  return {
    type,
    isMainCompound,
    isAccessory: !isMainCompound && type !== "athletic" && type !== "mobility",
    isLowPriorityAccessory,
    isHighPriority,
    isLoadable,
    isDumbbell: equipment === "dumbbell",
    isWeightedBodyweight,
  };
}

export function determineProgressionMode(exercise, classification = classifyExerciseType(exercise)) {
  if (classification.type === "athletic" || classification.type === "mobility") {
    return "quality_first";
  }

  if (classification.type === "core") {
    return "core_control";
  }

  if (classification.type === "isolation") {
    return "reps_first";
  }

  return "double_progression";
}

export function evaluateReadinessModifier(readiness = {}) {
  const summary = readiness?.status ? readiness : interpretWellness(readiness);
  const status = summary.status ?? "yellow";

  return {
    ...summary,
    status,
    isRed: status === "red" || Boolean(summary.isPoor),
    isYellow: status === "yellow",
    isGreen: status === "green" || Boolean(summary.isGood),
    isMissing: Boolean(summary.missing),
    capsAggression: status === "red",
  };
}

export function evaluateSessionFatigue(sessionRpe) {
  const value = getFiniteNumber(sessionRpe);

  return {
    value,
    isMissing: value === null,
    isManageable: value !== null && value <= 7,
    isProductiveHard: value !== null && value >= 8 && value < 9,
    isVeryHigh: value !== null && value >= 9,
    capsAggression: value !== null && value >= 9,
  };
}

export function evaluateExercisePerformance({
  exercise,
  session,
  previousExerciseSession,
  planned = {},
}) {
  const exerciseLog = getExerciseLog(session, exercise);
  const setLogs = getSetLogs(exerciseLog);
  const loggedReps = getLoggedReps(setLogs);
  const previousExerciseLog = getExerciseLog(previousExerciseSession, exercise);
  const previousSetLogs = getSetLogs(previousExerciseLog);
  const previousLoggedReps = getLoggedReps(previousSetLogs);
  const targetSets = toNumber(planned.sets, exercise.sets);
  const repsMin = planned.repsMin ?? exercise.repsMin;
  const repsMax = planned.repsMax ?? exercise.repsMax;
  const targetRPE = planned.targetRPE ?? exercise.targetRPE;
  const plannedWeight = planned.recommendedWeight ?? exercise.recommendedWeight;
  const workingWeight = getExerciseAverageWeight(exerciseLog, setLogs, plannedWeight, exercise);
  const previousWorkingWeight = getExerciseAverageWeight(
    previousExerciseLog,
    previousSetLogs,
    plannedWeight,
    exercise,
  );
  const exerciseRPE = getExerciseRpeFromLog(exerciseLog, setLogs);
  const totalReps = getAggregateTotalReps(exerciseLog, loggedReps);
  const previousTotalReps = getAggregateTotalReps(previousExerciseLog, previousLoggedReps);
  const loggedSetCount = getLoggedSetCount(exerciseLog, loggedReps) ?? 0;
  const hasSetLevelData = loggedReps.length > 0;
  const hasAggregateData = !hasSetLevelData && totalReps !== null;
  const allSetsLogged = targetSets > 0 && loggedSetCount >= targetSets;
  const targetMinTotal =
    repsMin === null || repsMin === undefined ? null : targetSets * Number(repsMin);
  const targetTopTotal =
    repsMax === null || repsMax === undefined ? null : targetSets * Number(repsMax);
  const allAtMin =
    repsMin === null || repsMin === undefined
      ? allSetsLogged
      : hasSetLevelData
        ? allSetsLogged && loggedReps.every((rep) => rep >= repsMin)
        : allSetsLogged && totalReps !== null && targetMinTotal !== null && totalReps >= targetMinTotal;
  const allAtTop =
    repsMax === null || repsMax === undefined
      ? false
      : hasSetLevelData
        ? allSetsLogged && loggedReps.every((rep) => rep >= repsMax)
        : allSetsLogged && totalReps !== null && targetTopTotal !== null && totalReps >= targetTopTotal;
  const belowMin =
    repsMin === null || repsMin === undefined
      ? false
      : hasSetLevelData
        ? loggedReps.some((rep) => rep < repsMin)
        : totalReps !== null && targetMinTotal !== null && totalReps < targetMinTotal;
  const missedSets = Math.max(0, targetSets - loggedSetCount);
  const belowMinCount =
    repsMin === null || repsMin === undefined
      ? 0
      : hasSetLevelData
        ? loggedReps.filter((rep) => rep < repsMin).length
        : belowMin
          ? 1
          : 0;
  const comparableLoad =
    workingWeight === null ||
    previousWorkingWeight === null ||
    Math.abs(workingWeight - previousWorkingWeight) <= getLoadJump(exercise);
  const regressed =
    totalReps !== null &&
    previousTotalReps !== null &&
    totalReps < previousTotalReps &&
    comparableLoad;
  const hasMeaningfulData =
    Boolean(exerciseLog) &&
    (hasSetLevelData || hasAggregateData || exerciseRPE !== null || workingWeight !== null);
  const dataQuality = hasSetLevelData ? "set_level" : hasAggregateData ? "aggregate" : "missing";
  const warnings = [];

  if (hasAggregateData) {
    warnings.push("Set-level data was unavailable, so progression used aggregate reps.");
  }

  if (exerciseRPE === null) {
    warnings.push("Exercise RPE was unavailable, so load progression stayed conservative.");
  }

  return {
    exerciseLog,
    planned,
    targetSets,
    repsMin,
    repsMax,
    repsLabel: planned.repsLabel ?? exercise.repsLabel,
    targetRPE,
    plannedWeight,
    previousWeight: plannedWeight,
    workingWeight,
    previousWorkingWeight,
    exerciseRPE,
    hasExerciseRpe: exerciseRPE !== null,
    totalReps,
    previousTotalReps,
    totalRepsImproved:
      totalReps !== null && previousTotalReps !== null && totalReps > previousTotalReps,
    loggedSetCount,
    allSetsLogged,
    allAtMin,
    allAtTop,
    belowMin,
    belowMinCount,
    missedSets,
    regressed,
    hasMeaningfulData,
    dataQuality,
    warnings,
  };
}

function getSessionReadinessSummary(session) {
  if (session?.readiness?.status) {
    return session.readiness;
  }

  if (session?.readinessSnapshot?.readiness?.status) {
    return session.readinessSnapshot.readiness;
  }

  if (session?.wellness) {
    return interpretWellness(session.wellness);
  }

  return { ...interpretWellness(), missing: true };
}

function isStrongHistoryPerformance(sample) {
  return (
    sample.performance.allAtTop &&
    sample.performance.hasExerciseRpe &&
    sample.performance.exerciseRPE <= 8.5 &&
    !sample.sessionFatigue.isVeryHigh
  );
}

function isGoodHistoryPerformance(sample) {
  return (
    sample.performance.allAtMin &&
    (!sample.performance.hasExerciseRpe || sample.performance.exerciseRPE <= 8.5) &&
    !sample.sessionFatigue.isVeryHigh
  );
}

function isMissedHighRpePerformance(sample) {
  return sample.performance.belowMin && isHighExerciseRpe(sample.performance);
}

function compareHistorySamples(newer, older, exercise) {
  const newerWeight = newer.performance.workingWeight;
  const olderWeight = older.performance.workingWeight;
  const comparableLoad =
    newerWeight === null ||
    olderWeight === null ||
    Math.abs(newerWeight - olderWeight) <= getLoadJump(exercise);
  const newerTotal = newer.performance.totalReps;
  const olderTotal = older.performance.totalReps;

  if (newerTotal === null || olderTotal === null || !comparableLoad) {
    return "unknown";
  }

  if (newerTotal > olderTotal) {
    return "improved";
  }

  if (newerTotal < olderTotal) {
    return "regressed";
  }

  return "stable";
}

export function evaluateExerciseHistory({
  exercise,
  dayId,
  session,
  previousSessions = [],
  planned = {},
}) {
  const historySessions = getPreviousExerciseSessions(dayId, exercise, session, previousSessions);
  const samples = historySessions
    .map((historySession) => {
      const readinessModifier = evaluateReadinessModifier(getSessionReadinessSummary(historySession));
      const sessionFatigue = evaluateSessionFatigue(historySession.sessionRpe);
      const performance = evaluateExercisePerformance({
        exercise,
        session: historySession,
        previousExerciseSession: null,
        planned,
      });

      return {
        session: historySession,
        performance,
        readinessModifier,
        sessionFatigue,
        isStrong: false,
        isGood: false,
        isMissedHighRpe: false,
      };
    })
    .filter((sample) => sample.performance.hasMeaningfulData)
    .slice(0, 5)
    .map((sample) => ({
      ...sample,
      isStrong: isStrongHistoryPerformance(sample),
      isGood: isGoodHistoryPerformance(sample),
      isMissedHighRpe: isMissedHighRpePerformance(sample),
    }));

  const comparisons = samples
    .slice(0, -1)
    .map((sample, index) => compareHistorySamples(sample, samples[index + 1], exercise));
  const strongCount = samples.filter((sample) => sample.isStrong).length;
  const goodCount = samples.filter((sample) => sample.isGood).length;
  const missedHighRpeCount = samples.filter((sample) => sample.isMissedHighRpe).length;
  const highExerciseRpeCount = samples.filter((sample) => isHighExerciseRpe(sample.performance)).length;
  const highSessionRpeCount = samples.filter((sample) => sample.sessionFatigue.isVeryHigh).length;
  const redReadinessCount = samples.filter((sample) => sample.readinessModifier.isRed).length;
  const improvingPairs = comparisons.filter((comparison) => comparison === "improved").length;
  const regressingPairs = comparisons.filter((comparison) => comparison === "regressed").length;
  const consecutiveStrongSessions = samples.findIndex((sample) => !sample.isStrong);
  const consecutiveMissedHighRpe = samples.findIndex((sample) => !sample.isMissedHighRpe);
  const warnings = [];
  let trend = "insufficient_history";

  if (samples.length >= 2) {
    if (missedHighRpeCount >= 2 || regressingPairs >= 2) {
      trend = "regressing";
    } else if (highExerciseRpeCount >= 2 || highSessionRpeCount >= 2) {
      trend = "repeated_high_rpe";
    } else if (improvingPairs >= 2 || strongCount >= 2) {
      trend = "improving";
    } else {
      trend = "stable";
    }
  }

  if (missedHighRpeCount >= 2) {
    warnings.push("Repeated missed targets with high RPE showed up in recent history.");
  }

  if (highSessionRpeCount >= 2) {
    warnings.push("Recent sessions repeatedly hit session RPE 9+, so progression stays conservative.");
  }

  if (highExerciseRpeCount >= 2) {
    warnings.push("Recent exercise RPE has repeatedly been high.");
  }

  if (redReadinessCount >= 2) {
    warnings.push("Recent readiness was repeatedly low, so history is interpreted conservatively.");
  }

  return {
    trend,
    sampleSize: samples.length,
    samples,
    strongCount,
    goodCount,
    missedHighRpeCount,
    highExerciseRpeCount,
    highSessionRpeCount,
    redReadinessCount,
    improvingPairs,
    regressingPairs,
    consecutiveStrongSessions:
      consecutiveStrongSessions === -1 ? samples.length : consecutiveStrongSessions,
    consecutiveMissedHighRpe:
      consecutiveMissedHighRpe === -1 ? samples.length : consecutiveMissedHighRpe,
    warnings,
  };
}

function getBaseCoachRecommendation(performance) {
  return {
    decision: "hold",
    confidence: "medium",
    nextWeight: performance.workingWeight,
    nextSets: performance.targetSets,
    repFocus: null,
    conservative: false,
    reasons: [],
    warnings: [...performance.warnings],
    historyTrend: "insufficient_history",
    historySampleSize: 0,
  };
}

function isManageableExerciseRpe(performance, maxRpe = 8.5) {
  return performance.hasExerciseRpe && performance.exerciseRPE <= maxRpe;
}

function isHighExerciseRpe(performance, minRpe = 9) {
  return performance.hasExerciseRpe && performance.exerciseRPE >= minRpe;
}

function canIncreaseLoadNow({ exercise, performance, readinessModifier, sessionFatigue, maxRpe = 8.5 }) {
  return (
    canProgressLoad(exercise) &&
    performance.workingWeight !== null &&
    performance.allAtTop &&
    isManageableExerciseRpe(performance, maxRpe) &&
    !readinessModifier.isRed &&
    !sessionFatigue.isVeryHigh
  );
}

function getConfidence({ performance, decision, mode }) {
  if (decision === "insufficient_data") {
    return "low";
  }

  if (performance.dataQuality === "set_level" && performance.hasExerciseRpe) {
    return mode === "quality_first" ? "medium" : "high";
  }

  if (performance.dataQuality === "aggregate") {
    return "medium";
  }

  return "low";
}

export function generateCoachReason(decision, { mode, performance, readinessModifier, sessionFatigue }) {
  if (readinessModifier.isRed && decision === "hold" && performance.belowMin) {
    return "Performance was below target, but readiness was low today. Load was held rather than reduced aggressively.";
  }

  if (readinessModifier.isRed && decision === "hold" && performance.allAtTop) {
    return "Performance was strong despite low readiness, so progression stayed conservative.";
  }

  if (sessionFatigue.isVeryHigh && decision === "hold") {
    return "Load held because session RPE was very high.";
  }

  switch (decision) {
    case "increase_load":
      if (mode === "reps_first") {
        return "Load increased because every set reached the top of the range with controlled RPE.";
      }
      if (mode === "quality_first") {
        return "Load increased slowly because available RPE and completion data support crisp athletic work.";
      }
      if (mode === "core_control") {
        return "Core difficulty progressed carefully after controlled top-range work.";
      }
      return "Load increased because all programmed sets reached the top of the rep range at manageable RPE.";
    case "increase_reps":
      return "Load kept stable; beat the last total reps before adding weight.";
    case "reduce_load":
      return "Load slightly reduced because reps fell below target with high RPE.";
    case "reduce_volume":
      return "Accessory volume reduced by 1 set because readiness was red and session RPE was very high.";
    case "recovery_suggestion":
      return "Recovery signals were low, so next time should stay conservative.";
    case "deload_suggestion":
      return "Fatigue signals were high enough to suggest a lighter session rather than forcing progression.";
    case "insufficient_data":
      return "Not enough completed workout data was available, so the plan stays conservative.";
    case "hold":
    default:
      if (mode === "quality_first") {
        return "Athletic work held steady so speed, quality, and crisp execution stay the priority.";
      }
      if (mode === "core_control") {
        return "Core plan held steady; add control before load or volume.";
      }
      return "Load held while reps and RPE build inside the target range.";
  }
}

function addUniqueReason(recommendation, reason, position = "end") {
  if (!reason || recommendation.reasons.includes(reason)) {
    return;
  }

  if (position === "start") {
    recommendation.reasons.unshift(reason);
  } else {
    recommendation.reasons.push(reason);
  }
}

function removeReasonsContaining(recommendation, fragments) {
  recommendation.reasons = recommendation.reasons.filter(
    (reason) => !fragments.some((fragment) => reason.includes(fragment)),
  );
}

function applyHistoryContext({
  classification,
  mode,
  performance,
  recommendation,
  historySummary,
  sessionFatigue,
}) {
  recommendation.historyTrend = historySummary.trend;
  recommendation.historySampleSize = historySummary.sampleSize;
  recommendation.warnings.push(...historySummary.warnings);

  if (!historySummary.sampleSize) {
    if (recommendation.decision === "increase_load") {
      recommendation.confidence = "medium";
      recommendation.conservative = true;
      addUniqueReason(
        recommendation,
        "This was the first strong logged pattern for this exercise, so the progression stays small and conservative.",
      );
    }

    return recommendation;
  }

  const currentMissedHighRpe = performance.belowMin && isHighExerciseRpe(performance);
  const repeatedMissedHighRpe =
    currentMissedHighRpe &&
    (historySummary.consecutiveMissedHighRpe >= 1 || historySummary.missedHighRpeCount >= 2);
  const repeatedHighSessionRpe =
    historySummary.highSessionRpeCount >= 2 ||
    (sessionFatigue.isVeryHigh && historySummary.highSessionRpeCount >= 1);
  const repeatedHighExerciseRpe =
    historySummary.highExerciseRpeCount >= 2 ||
    (isHighExerciseRpe(performance) && historySummary.highExerciseRpeCount >= 1);
  const twoStrongSessions =
    performance.allAtTop &&
    isManageableExerciseRpe(performance) &&
    historySummary.consecutiveStrongSessions >= 1;

  if (historySummary.trend === "improving") {
    addUniqueReason(
      recommendation,
      "Recent history is improving, so this recommendation has more confidence.",
    );
  }

  if (repeatedMissedHighRpe) {
    recommendation.warnings.push("Repeated missed targets with high RPE showed up across recent sessions.");
  }

  if (repeatedHighSessionRpe) {
    recommendation.warnings.push("Repeated high session RPE showed up across recent sessions.");
  }

  if (repeatedHighExerciseRpe) {
    recommendation.warnings.push("Repeated high exercise RPE showed up across recent sessions.");
  }

  if (historySummary.trend === "regressing") {
    recommendation.conservative = true;
    addUniqueReason(
      recommendation,
      "Recent history is regressing, so the next session is kept conservative.",
    );
  }

  if (repeatedHighSessionRpe || repeatedHighExerciseRpe || historySummary.trend === "repeated_high_rpe") {
    recommendation.conservative = true;
    recommendation.confidence = recommendation.confidence === "high" ? "medium" : recommendation.confidence;
  }

  if (recommendation.decision === "increase_load") {
    if (mode === "quality_first") {
      recommendation.conservative = true;
      recommendation.confidence = twoStrongSessions ? "medium" : "low";
      addUniqueReason(
        recommendation,
        "Athletic progression stays quality-first; do not chase load unless reps stay crisp.",
      );
      return recommendation;
    }

    if (historySummary.trend === "regressing" || repeatedHighSessionRpe || repeatedHighExerciseRpe) {
      removeReasonsContaining(recommendation, ["Load increased", "progressed"]);
      recommendation.decision = mode === "reps_first" ? "increase_reps" : "hold";
      recommendation.nextWeight = performance.workingWeight;
      recommendation.repFocus =
        mode === "reps_first"
          ? "Confirm clean top-range reps again before adding load."
          : "Confirm this load again before increasing.";
      recommendation.conservative = true;
      recommendation.confidence = "medium";
      addUniqueReason(
        recommendation,
        "Recent history showed fatigue or regression, so load was not increased off one good session.",
        "start",
      );
      return recommendation;
    }

    if (twoStrongSessions) {
      recommendation.confidence = "high";
      addUniqueReason(
        recommendation,
        "Two strong sessions in a row support this load increase.",
        "start",
      );
    } else {
      recommendation.confidence = recommendation.confidence === "high" ? "medium" : recommendation.confidence;
      recommendation.conservative = true;
      addUniqueReason(
        recommendation,
        "One strong session supports only a small progression; repeatability still matters.",
      );
    }
  }

  if (recommendation.decision === "reduce_load") {
    if (!repeatedMissedHighRpe) {
      removeReasonsContaining(recommendation, ["Load slightly reduced", "reduced because"]);
      recommendation.decision = "hold";
      recommendation.nextWeight = performance.workingWeight;
      recommendation.repFocus = "Repeat the load once before reducing unless the same issue repeats.";
      recommendation.conservative = true;
      recommendation.confidence = "medium";
      addUniqueReason(
        recommendation,
        "One difficult session usually earns a hold, not an automatic reduction.",
        "start",
      );
    } else if (classification.isMainCompound && historySummary.consecutiveMissedHighRpe < 2) {
      removeReasonsContaining(recommendation, ["Load slightly reduced", "reduced because"]);
      recommendation.decision = "hold";
      recommendation.nextWeight = performance.workingWeight;
      recommendation.repFocus = "Protect the main lift and reassess before reducing load.";
      recommendation.conservative = true;
      recommendation.confidence = "medium";
      recommendation.warnings.push("Main compound load was protected from an aggressive reduction.");
    } else {
      recommendation.confidence = historySummary.consecutiveMissedHighRpe >= 2 ? "high" : "medium";
      addUniqueReason(
        recommendation,
        "Repeated missed targets with high RPE support a small load reduction.",
        "start",
      );
    }
  }

  if (
    recommendation.decision === "hold" &&
    mode === "reps_first" &&
    historySummary.trend === "improving" &&
    !isHighExerciseRpe(performance, 8.5)
  ) {
    recommendation.decision = "increase_reps";
    recommendation.repFocus = "Keep load and build reps before increasing weight.";
    recommendation.confidence = "medium";
    addUniqueReason(
      recommendation,
      "Isolation history is improving, so reps-first progression stays the target.",
      "start",
    );
  }

  return recommendation;
}

export function calculateNextRecommendation({
  exercise,
  classification,
  mode,
  performance,
  readinessModifier,
  sessionFatigue,
  historySummary = { trend: "insufficient_history", sampleSize: 0, warnings: [] },
}) {
  const recommendation = getBaseCoachRecommendation(performance);

  if (!performance.hasMeaningfulData) {
    recommendation.decision = "insufficient_data";
    recommendation.confidence = "low";
    recommendation.repFocus = "Log this next time to establish a baseline.";
    recommendation.nextWeight = performance.plannedWeight;
    recommendation.conservative = true;
    recommendation.reasons.push(
      generateCoachReason(recommendation.decision, {
        mode,
        performance,
        readinessModifier,
        sessionFatigue,
      }),
    );
    return recommendation;
  }

  if (performance.totalRepsImproved) {
    recommendation.reasons.push(
      `Total reps improved from ${performance.previousTotalReps} to ${performance.totalReps}.`,
    );
  }

  if (mode === "quality_first") {
    recommendation.warnings.push(
      "No speed or quality metric is logged, so athletic decisions use RPE, readiness, and completion as proxies.",
    );

    const isHangClean =
      exercise.id === "hang-cleans" ||
      exercise.legacyExerciseId === "hang-cleans" ||
      /hang cleans?/i.test(exercise.name ?? "");

    if (
      isHangClean &&
      canIncreaseLoadNow({
        exercise,
        performance,
        readinessModifier,
        sessionFatigue,
        maxRpe: 7.5,
      })
    ) {
      recommendation.decision = "increase_load";
      recommendation.nextWeight = increaseLoad(performance.workingWeight, exercise);
      recommendation.repFocus = "Keep every rep fast and crisp.";
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus = "Prioritize speed and crisp execution over more volume.";
      recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
    }
  } else if (mode === "core_control") {
    if (canIncreaseLoadNow({ exercise, performance, readinessModifier, sessionFatigue })) {
      recommendation.decision = "increase_load";
      recommendation.nextWeight = increaseLoad(performance.workingWeight, exercise);
      recommendation.repFocus = "Keep control strict with the small jump.";
    } else if (
      performance.allAtTop &&
      isManageableExerciseRpe(performance) &&
      !readinessModifier.isRed &&
      !sessionFatigue.isVeryHigh
    ) {
      recommendation.decision = "increase_reps";
      recommendation.repFocus = "Use slower control or a slightly harder variation.";
    } else if (performance.belowMin && isHighExerciseRpe(performance)) {
      recommendation.decision = "hold";
      recommendation.repFocus = "Rebuild controlled reps before making it harder.";
      recommendation.conservative = true;
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus = "Add quality before load or volume.";
      recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
    }
  } else if (mode === "reps_first") {
    if (canIncreaseLoadNow({ exercise, performance, readinessModifier, sessionFatigue })) {
      recommendation.decision = "increase_load";
      recommendation.nextWeight = increaseLoad(performance.workingWeight, exercise);
      recommendation.repFocus = "Reset to the lower end and keep reps clean.";
    } else if (performance.belowMin && isHighExerciseRpe(performance)) {
      if (readinessModifier.isRed) {
        recommendation.decision = "hold";
        recommendation.repFocus = "Repeat the load under better recovery.";
      } else {
        recommendation.decision = "reduce_load";
        recommendation.nextWeight = decreaseLoad(performance.workingWeight, exercise, 2.5);
        recommendation.repFocus = "Reclaim the rep range before loading again.";
      }
      recommendation.conservative = true;
    } else if (performance.allAtMin || performance.totalRepsImproved) {
      recommendation.decision = "increase_reps";
      recommendation.repFocus = "Add 1 rep where form stays sharp.";
      recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus = "Get every set back into the target range.";
      recommendation.conservative = readinessModifier.isRed;
    }
  } else {
    if (canIncreaseLoadNow({ exercise, performance, readinessModifier, sessionFatigue })) {
      recommendation.decision = "increase_load";
      recommendation.nextWeight = increaseLoad(performance.workingWeight, exercise);
      recommendation.repFocus = "Own the same rep range with the heavier load.";
    } else if ((performance.belowMin || performance.regressed) && isHighExerciseRpe(performance)) {
      if (readinessModifier.isRed) {
        recommendation.decision = "hold";
        recommendation.repFocus = "Repeat the load and reassess under better recovery.";
      } else if (performance.belowMinCount > 1 || performance.exerciseRPE >= 9.5) {
        recommendation.decision = "reduce_load";
        recommendation.nextWeight = decreaseLoad(performance.workingWeight, exercise, 5);
        recommendation.repFocus = "Rebuild the bottom of the range with cleaner reps.";
      } else {
        recommendation.decision = "hold";
        recommendation.repFocus = "Repeat the load and rebuild clean reps.";
      }
      recommendation.conservative = true;
    } else if (performance.allAtMin || performance.totalRepsImproved) {
      if (
        isHighExerciseRpe(performance, 8.5) ||
        (classification.isMainCompound && (readinessModifier.isRed || sessionFatigue.isVeryHigh))
      ) {
        recommendation.decision = "hold";
        recommendation.repFocus =
          performance.totalReps !== null
            ? `Repeat ${performance.totalReps} total reps with cleaner fatigue.`
            : "Repeat this load before pushing progression.";
        recommendation.conservative = readinessModifier.isRed || sessionFatigue.isVeryHigh;
      } else {
        recommendation.decision = "increase_reps";
        recommendation.repFocus =
          performance.totalReps !== null
            ? `Beat ${performance.totalReps} total reps next time.`
            : "Beat last session's total reps.";
        recommendation.conservative = false;
      }
    } else {
      recommendation.decision = "hold";
      recommendation.repFocus = "Keep load and build total reps before adding weight.";
      recommendation.conservative = readinessModifier.isRed;
    }
  }

  if (
    sessionFatigue.isVeryHigh &&
    readinessModifier.isRed &&
    classification.isLowPriorityAccessory &&
    recommendation.nextSets > 1
  ) {
    recommendation.decision = "reduce_volume";
    recommendation.nextSets = Math.max(1, recommendation.nextSets - 1);
    recommendation.nextWeight = performance.workingWeight;
    recommendation.repFocus = "Keep quality high with 1 less accessory set.";
    recommendation.conservative = true;
  }

  if (
    (readinessModifier.isRed || sessionFatigue.isVeryHigh) &&
    recommendation.decision === "increase_load"
  ) {
    recommendation.decision = "hold";
    recommendation.nextWeight = performance.workingWeight;
    recommendation.repFocus = "Confirm this performance again before increasing load.";
    recommendation.conservative = true;
  }

  const primaryReason = generateCoachReason(recommendation.decision, {
    mode,
    performance,
    readinessModifier,
    sessionFatigue,
  });

  recommendation.reasons = [
    primaryReason,
    ...recommendation.reasons.filter((reason) => reason !== primaryReason),
  ];
  recommendation.confidence = getConfidence({
    performance,
    decision: recommendation.decision,
    mode,
  });

  if (readinessModifier.isMissing) {
    recommendation.warnings.push("No readiness snapshot was available, so readiness was treated as neutral.");
  }

  applyHistoryContext({
    classification,
    mode,
    performance,
    recommendation,
    historySummary,
    sessionFatigue,
  });

  const finalPrimaryReason = generateCoachReason(recommendation.decision, {
    mode,
    performance,
    readinessModifier,
    sessionFatigue,
  });

  recommendation.reasons = [
    finalPrimaryReason,
    ...recommendation.reasons.filter((reason) => reason && reason !== finalPrimaryReason),
  ];
  recommendation.warnings = [...new Set(recommendation.warnings.filter(Boolean))];

  return recommendation;
}

function calculateExerciseRecommendationV2(
  exercise,
  session,
  previousExerciseSessions,
  wellnessSummary,
  dayId,
) {
  const planned = getExerciseLog(session.plannedExercises, exercise) ?? {};
  const historySessions = Array.isArray(previousExerciseSessions)
    ? previousExerciseSessions
    : previousExerciseSessions
      ? [previousExerciseSessions]
      : [];
  const classification = classifyExerciseType(exercise);
  const mode = determineProgressionMode(exercise, classification);
  const readinessModifier = evaluateReadinessModifier(wellnessSummary);
  const sessionFatigue = evaluateSessionFatigue(session.sessionRpe);
  const performance = evaluateExercisePerformance({
    exercise,
    session,
    previousExerciseSession: historySessions[0] ?? null,
    planned,
  });
  const historySummary = evaluateExerciseHistory({
    exercise,
    dayId,
    session,
    previousSessions: historySessions,
    planned,
  });
  const recommendation = calculateNextRecommendation({
    exercise,
    classification,
    mode,
    performance,
    readinessModifier,
    sessionFatigue,
    historySummary,
  });

  return {
    exerciseId: exercise.id,
    name: exercise.name,
    sets: recommendation.nextSets,
    repsMin: performance.repsMin,
    repsMax: performance.repsMax,
    repsLabel: performance.repsLabel,
    restSeconds: planned.restSeconds ?? exercise.restSeconds,
    targetRPE: performance.targetRPE,
    recommendedWeight: recommendation.nextWeight,
    previousWeight: performance.previousWeight,
    repFocus: recommendation.repFocus,
    totalReps: performance.totalReps,
    previousTotalReps: performance.previousTotalReps,
    exerciseRPE: performance.exerciseRPE,
    reasons: recommendation.reasons.length
      ? recommendation.reasons
      : [
          generateCoachReason(recommendation.decision, {
            mode,
            performance,
            readinessModifier,
            sessionFatigue,
          }),
        ],
    conservative: recommendation.conservative,
    decision: recommendation.decision,
    confidence: recommendation.confidence,
    warnings: [...new Set(recommendation.warnings.filter(Boolean))],
    historyTrend: recommendation.historyTrend,
    historySampleSize: recommendation.historySampleSize,
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
