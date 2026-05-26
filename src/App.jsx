import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Info,
  BarChart3,
  BatteryMedium,
  BookOpen,
  CheckSquare,
  ClipboardList,
  Dumbbell,
  Flame,
  Home,
  History,
  Moon,
  Save,
  Settings,
  Smile,
  Zap,
} from "lucide-react";
import { getProgramDay, workoutProgram } from "./config/workoutProgram.js";
import {
  formatRest,
  formatSetsReps,
  formatWeight,
  generateNextPlan,
  getPlanForDay,
  interpretWellness,
  isWeightEditable,
  wellnessMetrics,
} from "./lib/progression.js";
import {
  duplicateProgram,
  getActiveProgram,
  getActiveProgramId,
  getProgramBaseline,
  getProgramDayViewModels,
  getProgramExercises,
  getProgramDays,
  getProgramProgression,
  getProgramState,
  getPrograms,
  seedDefaultProgramIfNeeded,
  setActiveProgram,
  updateProgramState,
  upsertProgramProgressionsFromPlan,
} from "./lib/programStorage.js";
import { STORAGE_KEYS, useLocalStorageState } from "./lib/storage.js";

const tabs = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "readiness", label: "Readiness", icon: Activity },
  { id: "program", label: "Program", icon: ClipboardList },
  { id: "workouts", label: "Workouts", icon: Dumbbell },
  { id: "workout-log", label: "Workout Log", icon: CheckSquare },
  { id: "library", label: "Library", icon: BookOpen },
  { id: "progress", label: "Progress", icon: BarChart3 },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings },
];

const dayScopedTabs = new Set(["workout-log", "progress"]);

const wellnessIcons = {
  soreness: Flame,
  fatigue: BatteryMedium,
  mood: Smile,
  stress: Zap,
  sleep: Moon,
};

const wellnessScaleLabels = {
  1: "Very poor",
  2: "Below avg",
  3: "Okay",
  4: "Good",
  5: "Excellent",
};

const readinessStyles = {
  red: "border-red-300/40 bg-red-300/10 text-red-100",
  yellow: "border-amber-300/40 bg-amber-300/10 text-amber-100",
  green: "border-lime-300/40 bg-lime-300/10 text-lime-100",
};

const baseRecommendationNote = "Base program prescription.";

const readinessCopy = {
  green: {
    label: "Green",
    title: "Green Readiness - Push performance",
    body: "Recovery signals look good. Follow the plan and progress normally if performance is there.",
    guidance:
      "Readiness is strong. Follow the planned loads and push progression where performance supports it.",
    summary:
      "Recovery signals look good. Follow the plan and progress normally if performance is there.",
  },
  yellow: {
    label: "Yellow",
    title: "Yellow Readiness - Train normally, stay controlled",
    body: "You can train productively today, but avoid forcing progression if performance feels off.",
    guidance:
      "Train normally, but stay controlled. Beat last session if it feels earned, not forced.",
    summary:
      "Train productively, but avoid forcing progression if performance feels off.",
  },
  red: {
    label: "Red",
    title: "Red Readiness - Protect quality",
    body: "Readiness is low. Keep technique sharp and use conservative progression today.",
    guidance:
      "Keep quality high today. Consider using the lower end of the rep ranges, avoid forced PR attempts, and reduce accessory effort if fatigue is obvious.",
    summary: "Readiness is low. Keep technique sharp and use conservative progression today.",
  },
};

function getReadinessCopy(readiness) {
  return readinessCopy[readiness?.status] ?? readinessCopy.yellow;
}

function createNeutralReadiness() {
  return {
    status: "yellow",
    averageScore: 3,
    isPoor: false,
    isGood: false,
    lowMetrics: [],
    missing: true,
  };
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatDateKey(dateKey) {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function createId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createDefaultWellness() {
  return Object.fromEntries(wellnessMetrics.map((metric) => [metric.id, 3]));
}

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getPlanExercise(plan, exerciseId) {
  return plan.exercises.find((entry) => entry.exerciseId === exerciseId);
}

function getExerciseStorageIds(exerciseOrId) {
  if (typeof exerciseOrId === "string") {
    return [exerciseOrId];
  }

  return [
    exerciseOrId.id,
    exerciseOrId.legacyExerciseId,
    exerciseOrId.libraryExerciseId,
    exerciseOrId.programExerciseId,
  ].filter((id, index, ids) => id && ids.indexOf(id) === index);
}

function getExerciseLog(session, exerciseOrId) {
  const ids = getExerciseStorageIds(exerciseOrId);
  const matchedId = ids.find((id) => session?.exercises?.[id]);

  return matchedId ? session.exercises[matchedId] : null;
}

function getStoredSetupCue(setupCues, exercise) {
  const matchedId = getExerciseStorageIds(exercise).find((id) => setupCues[id]);

  return matchedId ? setupCues[matchedId] : "";
}

function getDefaultWeight(exercise, planExercise, previousExerciseLog) {
  if (exercise.loadType === "bodyweight") {
    return "BW";
  }

  if (planExercise.recommendedWeight !== null && planExercise.recommendedWeight !== undefined) {
    return planExercise.recommendedWeight;
  }

  const previousSets = previousExerciseLog?.sets ?? [];
  const previousWeight = previousSets
    .map((set) => set.weight)
    .find((weight) => !isBlank(weight));

  if (previousWeight !== undefined) {
    return previousWeight;
  }

  return exercise.loadType === "optionalExternal" ? "BW" : "";
}

function createDraft(day, plan, sessions = []) {
  const exercises = Object.fromEntries(
    day.exercises.map((exercise) => {
      const planExercise = getPlanExercise(plan, exercise.id);
      const setCount = planExercise?.sets ?? exercise.sets;
      const previousExerciseLog = getLastExerciseLog(day.id, exercise, sessions);

      return [
        exercise.id,
        {
          notes: "",
          exerciseRPE: "",
          sets: Array.from({ length: setCount }, () => ({
            reps: "",
            weight: getDefaultWeight(exercise, planExercise, previousExerciseLog),
          })),
        },
      ];
    }),
  );

  const recoveryActivities = Object.fromEntries(
    (day.activities ?? []).map((activity) => [activity, false]),
  );

  return {
    exercises,
    wellness: createDefaultWellness(),
    recoveryActivities,
    recoveryNotes: "",
    sessionRpe: "",
    sessionNotes: "",
  };
}

function normalizeWellness(wellness) {
  return Object.fromEntries(
    wellnessMetrics.map((metric) => [
      metric.id,
      Math.min(5, Math.max(1, numberValue(wellness[metric.id], 3))),
    ]),
  );
}

function normalizeWeight(value) {
  if (typeof value === "string") {
    const cleanValue = value.trim();
    if (!cleanValue) {
      return null;
    }

    if (cleanValue.toLowerCase() === "bw") {
      return "BW";
    }
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeExerciseLogs(day, draftExercises) {
  return Object.fromEntries(
    day.exercises.map((exercise) => {
      const draftExercise = draftExercises[exercise.id];
      return [
        exercise.id,
        {
          notes: draftExercise.notes.trim(),
          exerciseRPE:
            draftExercise.exerciseRPE === ""
              ? null
              : numberValue(draftExercise.exerciseRPE, exercise.targetRPE),
          sets: draftExercise.sets.map((set) => ({
            reps: set.reps === "" ? null : numberValue(set.reps, 0),
            weight: normalizeWeight(set.weight),
          })),
        },
      ];
    }),
  );
}

function normalizeManualWeight(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isBlank(value) {
  return value === "" || value === null || value === undefined;
}

function isValidWeightEntry(value, exercise) {
  if (exercise.loadType === "bodyweight") {
    return typeof value === "string" && value.trim().toLowerCase() === "bw";
  }

  if (exercise.loadType === "optionalExternal") {
    if (typeof value === "string" && value.trim().toLowerCase() === "bw") {
      return true;
    }
  }

  if (isBlank(value)) {
    return false;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function validateDraft(day, draft) {
  const errors = [];
  const sessionRpe = numberValue(draft.sessionRpe, NaN);

  if (!Number.isFinite(sessionRpe) || sessionRpe < 1 || sessionRpe > 10) {
    errors.push("Session RPE needs a 1-10 score.");
  }

  if (day.type === "recovery") {
    return errors;
  }

  let hasLoggedExerciseData = false;

  day.exercises.forEach((exercise) => {
    const draftExercise = draft.exercises[exercise.id];
    const exerciseRPE = numberValue(draftExercise.exerciseRPE, NaN);
    const hasLoggedReps = draftExercise.sets.some((set) => !isBlank(set.reps));

    if (hasLoggedReps) {
      hasLoggedExerciseData = true;

      if (!Number.isFinite(exerciseRPE) || exerciseRPE < 1 || exerciseRPE > 10) {
        errors.push(`${exercise.name}: enter one exercise RPE from 1-10.`);
      }
    } else if (!isBlank(draftExercise.exerciseRPE)) {
      errors.push(`${exercise.name}: add reps if you enter an exercise RPE.`);
    }

    draftExercise.sets.forEach((set, index) => {
      if (!isBlank(set.reps)) {
        const reps = numberValue(set.reps, NaN);
        if (!Number.isFinite(reps) || reps < 0) {
          errors.push(`${exercise.name} set ${index + 1}: reps must be 0 or higher.`);
        }

        if (!isValidWeightEntry(set.weight, exercise)) {
          errors.push(`${exercise.name} set ${index + 1}: enter kg or BW.`);
        }
      } else if (!isBlank(set.weight) && !isValidWeightEntry(set.weight, exercise)) {
        errors.push(`${exercise.name} set ${index + 1}: enter kg or BW.`);
      }
    });
  });

  if (!hasLoggedExerciseData) {
    errors.push("Log reps for at least one exercise before generating recommendations.");
  }

  return errors;
}

function getSessionAnalytics(day, draft) {
  const exerciseSummaries = day.exercises.map((exercise) => {
    const draftExercise = draft.exercises[exercise.id];
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
      setCount: draftExercise.sets.length,
    };
  });

  return {
    exerciseCount: day.exercises.length,
    loggedSetCount: exerciseSummaries.reduce((total, exercise) => total + exercise.setCount, 0),
    totalReps: exerciseSummaries.reduce((total, exercise) => total + exercise.totalReps, 0),
    exerciseSummaries,
  };
}

function getLastExerciseSession(dayId, exerciseOrId, sessions) {
  return sessions.find(
    (session) => session.dayId === dayId && getExerciseLog(session, exerciseOrId),
  );
}

function getLastExerciseLog(dayId, exerciseOrId, sessions) {
  const session = getLastExerciseSession(dayId, exerciseOrId, sessions);
  return getExerciseLog(session, exerciseOrId);
}

function getExerciseTotalReps(session, exerciseOrId) {
  const sets = getExerciseLog(session, exerciseOrId)?.sets ?? [];
  return sets.reduce((total, set) => total + numberValue(set.reps, 0), 0);
}

function formatLoggedWeight(session, exercise, exerciseOrId) {
  const sets = getExerciseLog(session, exerciseOrId)?.sets ?? [];
  const numericWeights = sets
    .map((set) => normalizeWeight(set.weight))
    .filter((weight) => typeof weight === "number");

  if (!numericWeights.length) {
    return exercise.loadType === "bodyweight" ? "BW" : "BW / untracked load";
  }

  const averageWeight =
    numericWeights.reduce((total, weight) => total + weight, 0) / numericWeights.length;
  return formatWeight(averageWeight, exercise);
}

function getAverageLoggedWeight(session, exerciseOrId) {
  const sets = getExerciseLog(session, exerciseOrId)?.sets ?? [];
  const numericWeights = sets
    .map((set) => normalizeWeight(set.weight))
    .filter((weight) => typeof weight === "number");

  if (!numericWeights.length) {
    return null;
  }

  return numericWeights.reduce((total, weight) => total + weight, 0) / numericWeights.length;
}

function getBeatLastCue(dayId, exercise, sessions, planExercise) {
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
  const previousReps = previousSets.map((set) => numberValue(set.reps, 0));
  const previousTotalReps = getExerciseTotalReps(previousSession, exercise);
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

function isRealProgramProgression(progression) {
  return Boolean(
    progression?.recommendationNote &&
      progression.recommendationNote !== baseRecommendationNote &&
      progression.sourcePlanGeneratedAt,
  );
}

function repsLabelFromRange(reps, fallbackLabel) {
  if (reps?.label) {
    return reps.label;
  }

  if (reps?.min !== null && reps?.min !== undefined && reps?.max !== null && reps?.max !== undefined) {
    return reps.min === reps.max ? String(reps.min) : `${reps.min}-${reps.max}`;
  }

  return fallbackLabel ?? "custom";
}

function getWorkoutExerciseRecommendation(programId, exercise, planExercise, planStatus) {
  const programExerciseId = exercise.programExerciseId ?? exercise.id;
  const progression = programId
    ? getProgramProgression(programId, programExerciseId)
    : null;
  const baseline = programId ? getProgramBaseline(programId, programExerciseId) : null;
  const hasStoredProgression = isRealProgramProgression(progression);
  const hasGeneratedPlan = planStatus === "generated" && planExercise?.reasons?.length;
  const source = hasStoredProgression ? "progression" : hasGeneratedPlan ? "next-plan" : "baseline";
  const storedReps = hasStoredProgression ? progression.lastRecommendedReps : null;
  const baselineReps = baseline?.startingReps;

  return {
    source,
    sets:
      (hasStoredProgression ? progression.lastRecommendedSets : null) ??
      planExercise?.sets ??
      baseline?.startingSets ??
      exercise.sets,
    repsMin:
      storedReps?.min ??
      planExercise?.repsMin ??
      baselineReps?.min ??
      exercise.repsMin,
    repsMax:
      storedReps?.max ??
      planExercise?.repsMax ??
      baselineReps?.max ??
      exercise.repsMax,
    repsLabel:
      repsLabelFromRange(storedReps, null) !== "custom"
        ? repsLabelFromRange(storedReps, null)
        : planExercise?.repsLabel ??
          repsLabelFromRange(baselineReps, exercise.repsLabel),
    recommendedWeight:
      (hasStoredProgression ? progression.lastRecommendedWeight : null) ??
      planExercise?.recommendedWeight ??
      baseline?.startingWeight ??
      exercise.recommendedWeight,
    targetRPE:
      (hasStoredProgression ? progression.lastTargetRPE : null) ??
      planExercise?.targetRPE ??
      baseline?.startingRPE ??
      exercise.targetRPE,
    restSeconds: planExercise?.restSeconds ?? baseline?.restTime ?? exercise.restSeconds,
    recommendationNote: hasStoredProgression
      ? progression.recommendationNote
      : hasGeneratedPlan
        ? planExercise.reasons[0]
        : "Starting recommendation based on baseline.",
    repFocus:
      (hasStoredProgression ? progression.repFocus : null) ??
      planExercise?.repFocus ??
      null,
    conservative:
      Boolean(hasStoredProgression ? progression.conservative : planExercise?.conservative),
  };
}

function formatTechnicalValue(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(", ");
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

export default function App() {
  const [sessions, setSessions] = useLocalStorageState(STORAGE_KEYS.sessions, []);
  const [nextPlans, setNextPlans] = useLocalStorageState(STORAGE_KEYS.nextPlans, {});
  const [setupCues, setSetupCues] = useLocalStorageState(STORAGE_KEYS.setupCues, {});
  const [readinessByDate, setReadinessByDate] = useLocalStorageState(
    STORAGE_KEYS.readinessByDate,
    {},
  );
  const [programRevision, setProgramRevision] = useState(() => {
    seedDefaultProgramIfNeeded();
    return 0;
  });
  const programs = useMemo(() => getPrograms(), [programRevision]);
  const activeProgramId = useMemo(() => getActiveProgramId(), [programRevision]);
  const activeProgram = useMemo(
    () => getActiveProgram() ?? programs.find((program) => !program.isArchived) ?? null,
    [programs, programRevision],
  );
  const activeProgramDays = useMemo(
    () => (activeProgram ? getProgramDayViewModels(activeProgram.id) : workoutProgram.days),
    [activeProgram, programRevision],
  );
  const activeProgramState = useMemo(
    () => (activeProgram ? getProgramState(activeProgram.id) : null),
    [activeProgram, programRevision],
  );
  const nextRecommendedDay = useMemo(
    () =>
      activeProgramDays.find((day) => day.id === activeProgramState?.nextRecommendedDayId) ??
      null,
    [activeProgramDays, activeProgramState],
  );
  const [selectedDayId, setSelectedDayId] = useState(
    () => activeProgramDays[0]?.id ?? workoutProgram.cycleOrder[0],
  );
  const [activeTab, setActiveTab] = useState("dashboard");
  const [lastGeneratedPlan, setLastGeneratedPlan] = useState(null);
  const [validationErrors, setValidationErrors] = useState([]);
  const [workoutLogTarget, setWorkoutLogTarget] = useState(null);
  const [todayDateKey] = useState(() => getLocalDateKey());
  const [readinessDraft, setReadinessDraft] = useState(() =>
    normalizeWellness(readinessByDate[getLocalDateKey()]?.wellness ?? createDefaultWellness()),
  );
  const [readinessSaveMessage, setReadinessSaveMessage] = useState("");

  const selectedDay = useMemo(
    () =>
      activeProgramDays.find((day) => day.id === selectedDayId) ??
      activeProgramDays[0] ??
      getProgramDay(selectedDayId),
    [activeProgramDays, selectedDayId],
  );
  const activePlan = useMemo(
    () => getPlanForDay(selectedDay, nextPlans[selectedDayId]),
    [selectedDay, nextPlans, selectedDayId],
  );
  const [draft, setDraft] = useState(() => createDraft(selectedDay, activePlan, sessions));
  const readinessDraftSummary = useMemo(
    () => interpretWellness(readinessDraft),
    [readinessDraft],
  );
  const todayReadinessEntry = readinessByDate[todayDateKey] ?? null;
  const todayReadinessSummary = todayReadinessEntry
    ? todayReadinessEntry.readiness ?? interpretWellness(todayReadinessEntry.wellness)
    : createNeutralReadiness();
  const beatLastCues = useMemo(
    () =>
      Object.fromEntries(
        selectedDay.exercises.map((exercise) => [
          exercise.id,
          getBeatLastCue(selectedDay.id, exercise, sessions, getPlanExercise(activePlan, exercise.id)),
        ]),
      ),
    [selectedDay, sessions, activePlan],
  );

  useEffect(() => {
    setDraft(createDraft(selectedDay, activePlan, sessions));
    setValidationErrors([]);
  }, [selectedDayId, activePlan.generatedAt]);

  useEffect(() => {
    if (activeProgramDays.length && !activeProgramDays.some((day) => day.id === selectedDayId)) {
      setSelectedDayId(activeProgramDays[0].id);
    }
  }, [activeProgramDays, selectedDayId]);

  function updateWellness(metricId, value) {
    setReadinessSaveMessage("");
    setReadinessDraft((currentWellness) => ({
      ...currentWellness,
      [metricId]: value,
    }));
  }

  function saveTodayReadiness() {
    const wellness = normalizeWellness(readinessDraft);
    const readiness = interpretWellness(wellness);
    const now = new Date().toISOString();

    setReadinessByDate((currentReadiness) => ({
      ...currentReadiness,
      [todayDateKey]: {
        schemaVersion: 1,
        date: todayDateKey,
        savedAt: currentReadiness[todayDateKey]?.savedAt ?? now,
        updatedAt: now,
        wellness,
        readiness,
      },
    }));
    setReadinessSaveMessage("Today's readiness saved.");
  }

  function handleSelectDay(dayId) {
    const nextDay =
      activeProgramDays.find((day) => day.id === dayId) ??
      activeProgramDays[0] ??
      getProgramDay(dayId);
    const nextPlan = getPlanForDay(nextDay, nextPlans[dayId]);

    setSelectedDayId(dayId);
    setDraft(createDraft(nextDay, nextPlan, sessions));
    setValidationErrors([]);
  }

  function handleOpenWorkoutLog(dayId = selectedDayId, targetProgramExerciseId = null) {
    if (dayId && dayId !== selectedDayId) {
      handleSelectDay(dayId);
    }

    setWorkoutLogTarget(
      targetProgramExerciseId
        ? {
            programExerciseId: targetProgramExerciseId,
            requestedAt: Date.now(),
          }
        : null,
    );
    setActiveTab("workout-log");
  }

  function refreshProgramData() {
    setProgramRevision((currentRevision) => currentRevision + 1);
  }

  function handleSetActiveProgram(programId) {
    const nextActiveProgramId = setActiveProgram(programId);
    if (!nextActiveProgramId) {
      return;
    }

    const nextDays = getProgramDayViewModels(nextActiveProgramId);
    setSelectedDayId(nextDays[0]?.id ?? workoutProgram.cycleOrder[0]);
    setLastGeneratedPlan(null);
    setValidationErrors([]);
    refreshProgramData();
  }

  function handleDuplicateProgram(programId) {
    duplicateProgram(programId);
    refreshProgramData();
  }

  function updateSessionField(field, value) {
    setDraft((currentDraft) => ({ ...currentDraft, [field]: value }));
  }

  function updateRecoveryActivity(activity, checked) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      recoveryActivities: {
        ...currentDraft.recoveryActivities,
        [activity]: checked,
      },
    }));
  }

  function updateSet(exerciseId, setIndex, field, value) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      exercises: {
        ...currentDraft.exercises,
        [exerciseId]: {
          ...currentDraft.exercises[exerciseId],
          sets: currentDraft.exercises[exerciseId].sets.map((set, index) =>
            index === setIndex ? { ...set, [field]: value } : set,
          ),
        },
      },
    }));
  }

  function fillAllSets(exerciseId, field, value) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      exercises: {
        ...currentDraft.exercises,
        [exerciseId]: {
          ...currentDraft.exercises[exerciseId],
          sets: currentDraft.exercises[exerciseId].sets.map((set) => ({
            ...set,
            [field]: value,
          })),
        },
      },
    }));
  }

  function updateExerciseRPE(exerciseId, value) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      exercises: {
        ...currentDraft.exercises,
        [exerciseId]: {
          ...currentDraft.exercises[exerciseId],
          exerciseRPE: value,
        },
      },
    }));
  }

  function updateExerciseNotes(exerciseId, notes) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      exercises: {
        ...currentDraft.exercises,
        [exerciseId]: {
          ...currentDraft.exercises[exerciseId],
          notes,
        },
      },
    }));
  }

  function updateSetupCue(exerciseId, cue) {
    setSetupCues((currentCues) => ({
      ...currentCues,
      [exerciseId]: cue,
    }));
  }

  function updatePlanWeight(exerciseId, value) {
    const updatedPlan = getPlanForDay(selectedDay, nextPlans[selectedDayId]);
    const nextWeight = normalizeManualWeight(value);

    setNextPlans((currentPlans) => ({
      ...currentPlans,
      [selectedDay.id]: {
        ...updatedPlan,
        status: updatedPlan.status === "base" ? "manual" : updatedPlan.status,
        exercises: updatedPlan.exercises.map((exercisePlan) =>
          exercisePlan.exerciseId === exerciseId
            ? {
                ...exercisePlan,
                recommendedWeight: nextWeight,
              }
            : exercisePlan,
        ),
      },
    }));
  }

  function saveWorkout(event) {
    event.preventDefault();
    const errors = validateDraft(selectedDay, draft);

    if (errors.length) {
      setValidationErrors(errors);
      return;
    }

    setValidationErrors([]);
    const readinessSnapshot = todayReadinessEntry
      ? {
          ...todayReadinessEntry,
          wellness: normalizeWellness(todayReadinessEntry.wellness),
          readiness: todayReadinessEntry.readiness ?? interpretWellness(todayReadinessEntry.wellness),
        }
      : null;
    const normalizedWellness = readinessSnapshot?.wellness ?? null;
    const readinessSummary = readinessSnapshot?.readiness ?? createNeutralReadiness();

    const plannedExercises = Object.fromEntries(
      selectedDay.exercises.map((exercise) => {
        const planExercise = getPlanExercise(activePlan, exercise.id);
        return [
          exercise.id,
          {
            sets: planExercise?.sets ?? exercise.sets,
            repsMin: planExercise?.repsMin ?? exercise.repsMin,
            repsMax: planExercise?.repsMax ?? exercise.repsMax,
            repsLabel: planExercise?.repsLabel ?? exercise.repsLabel,
            targetRPE: planExercise?.targetRPE ?? exercise.targetRPE,
            recommendedWeight:
              planExercise?.recommendedWeight ?? exercise.recommendedWeight,
          },
        ];
      }),
    );

    const session = {
      id: createId(),
      schemaVersion: 5,
      appVersion: workoutProgram.version,
      date: new Date().toISOString(),
      programId: activeProgram?.id ?? null,
      programName: activeProgram?.name ?? workoutProgram.name,
      readinessDate: todayDateKey,
      readinessSnapshot,
      readinessMissing: !readinessSnapshot,
      dayId: selectedDay.id,
      dayName: selectedDay.name,
      dayType: selectedDay.type,
      plannedExercises,
      exercises: normalizeExerciseLogs(selectedDay, draft.exercises),
      wellness: normalizedWellness,
      readiness: readinessSummary,
      recoveryActivities: draft.recoveryActivities,
      recoveryNotes: draft.recoveryNotes.trim(),
      sessionRpe: numberValue(draft.sessionRpe, 7),
      sessionNotes: draft.sessionNotes.trim(),
      setupCuesSnapshot: setupCues,
      analytics: getSessionAnalytics(selectedDay, draft),
    };

    const generatedPlan = generateNextPlan(selectedDay, session, sessions);
    if (activeProgram?.id) {
      upsertProgramProgressionsFromPlan(activeProgram.id, generatedPlan);

      const dayIndex = activeProgramDays.findIndex((day) => day.id === selectedDay.id);
      const nextRecommendedDay =
        dayIndex >= 0
          ? activeProgramDays[(dayIndex + 1) % activeProgramDays.length]
          : activeProgramDays[0];

      updateProgramState(activeProgram.id, {
        lastCompletedDayId: selectedDay.id,
        nextRecommendedDayId: nextRecommendedDay?.id ?? selectedDay.id,
        lastWorkoutDate: session.date,
      });
      refreshProgramData();
    }
    setSessions((currentSessions) => [session, ...currentSessions]);
    setNextPlans((currentPlans) => ({
      ...currentPlans,
      [selectedDay.id]: generatedPlan,
    }));
    setLastGeneratedPlan(generatedPlan);
    setActiveTab("progress");
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pb-5 pt-5 sm:px-6 lg:px-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-lime-300">
              Athletic Bodybuilding Coach
            </p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
              Train, log, progress
            </h1>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-[8px] border border-zinc-700 bg-zinc-900 text-lime-300">
            <Dumbbell aria-hidden="true" size={23} />
          </div>
        </div>

        {dayScopedTabs.has(activeTab) && (
          <DaySelect
            days={activeProgramDays}
            selectedDayId={selectedDayId}
            onSelectDay={handleSelectDay}
          />
        )}
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-28 sm:px-6 lg:px-8">
        {activeTab === "dashboard" && (
          <DashboardPage
            selectedDay={selectedDay}
            activeProgram={activeProgram}
            todayReadinessEntry={todayReadinessEntry}
            todayReadinessSummary={todayReadinessSummary}
            sessions={sessions}
            onGoToReadiness={() => setActiveTab("readiness")}
            onGoToWorkouts={() => setActiveTab("workouts")}
            onGoToWorkoutLog={() => handleOpenWorkoutLog()}
          />
        )}

        {activeTab === "readiness" && (
          <ReadinessPage
            todayDateKey={todayDateKey}
            savedEntry={todayReadinessEntry}
            wellness={readinessDraft}
            readiness={readinessDraftSummary}
            saveMessage={readinessSaveMessage}
            onSave={saveTodayReadiness}
            onUpdateWellness={updateWellness}
          />
        )}

        {activeTab === "workouts" && (
          <WorkoutsPage
            day={selectedDay}
            days={activeProgramDays}
            selectedDayId={selectedDayId}
            activeProgram={activeProgram}
            programState={activeProgramState}
            nextRecommendedDay={nextRecommendedDay}
            plan={activePlan}
            todayReadinessEntry={todayReadinessEntry}
            todayReadinessSummary={todayReadinessSummary}
            setupCues={setupCues}
            beatLastCues={beatLastCues}
            onSelectDay={handleSelectDay}
            onGoToReadiness={() => setActiveTab("readiness")}
            onOpenWorkoutLog={handleOpenWorkoutLog}
          />
        )}

        {activeTab === "workout-log" && (
          <WorkoutLogPage
            day={selectedDay}
            plan={activePlan}
            draft={draft}
            todayReadinessEntry={todayReadinessEntry}
            todayReadinessSummary={todayReadinessSummary}
            setupCues={setupCues}
            validationErrors={validationErrors}
            beatLastCues={beatLastCues}
            scrollTarget={workoutLogTarget}
            onFillAllSets={fillAllSets}
            onUpdateExerciseNotes={updateExerciseNotes}
            onUpdateExerciseRPE={updateExerciseRPE}
            onUpdateRecoveryActivity={updateRecoveryActivity}
            onUpdateSessionField={updateSessionField}
            onUpdateSetupCue={updateSetupCue}
            onUpdateSet={updateSet}
            onGoToReadiness={() => setActiveTab("readiness")}
            onScrollTargetHandled={() => setWorkoutLogTarget(null)}
            onSave={saveWorkout}
          />
        )}

        {activeTab === "progress" && (
          <NextPlanPage
            selectedDay={selectedDay}
            selectedDayId={selectedDayId}
            nextPlans={nextPlans}
            lastGeneratedPlan={lastGeneratedPlan}
          />
        )}

        {activeTab === "program" && (
          <ProgramPage
            programs={programs}
            activeProgramId={activeProgramId}
            onDuplicateProgram={handleDuplicateProgram}
            onSetActiveProgram={handleSetActiveProgram}
          />
        )}

        {activeTab === "library" && (
          <PlaceholderPage
            eyebrow="Exercise Library"
            title="Library"
            body="Exercise technique details will live here next. For now, setup cues and exercise metadata remain attached to the current program."
          />
        )}

        {activeTab === "history" && <HistoryPage sessions={sessions} />}

        {activeTab === "settings" && (
          <PlaceholderPage
            eyebrow="App Settings"
            title="Settings"
            body="Guest-mode local settings will live here later. No account, cloud sync, or localStorage migration is included in this step."
          />
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 border-t border-zinc-800 bg-[#121212]/95 px-3 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-4xl gap-2 overflow-x-auto pb-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`focus-ring flex min-h-12 min-w-20 flex-col items-center justify-center rounded-[8px] px-2 text-xs font-bold transition ${
                  isActive
                    ? "bg-lime-300 text-zinc-950"
                    : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <Icon aria-hidden="true" size={18} />
                <span className="mt-1">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

function DaySelect({ days, selectedDayId, onSelectDay }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
        Training day
      </span>
      <select
        value={selectedDayId}
        onChange={(event) => onSelectDay(event.target.value)}
        className="focus-ring min-h-12 w-full rounded-[8px] border border-zinc-700 bg-zinc-900 px-3 text-base font-black text-white"
      >
        {days.map((day) => (
          <option key={day.id} value={day.id}>
            {day.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReadinessPage({
  todayDateKey,
  savedEntry,
  wellness,
  readiness,
  saveMessage,
  onSave,
  onUpdateWellness,
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Morning check-in
        </p>
        <h2 className="mt-1 text-xl font-black text-white">
          Check-in for: {formatDateKey(todayDateKey)}
        </h2>
        <p
          data-testid="readiness-save-state"
          className="mt-2 text-sm font-semibold text-zinc-300"
        >
          {saveMessage ||
            (savedEntry
              ? "Today's readiness is saved. You can update it if the day changes."
              : "No readiness check-in saved for today yet.")}
        </p>
      </section>

      <WellnessCheckIn
        wellness={wellness}
        readiness={readiness}
        onUpdateWellness={onUpdateWellness}
      />

      <button
        type="button"
        onClick={onSave}
        className="focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-5 text-base font-black text-zinc-950 shadow-lg shadow-lime-950/30 transition hover:bg-lime-200"
      >
        <Save aria-hidden="true" size={20} />
        Save today's readiness
      </button>
    </div>
  );
}

function DashboardPage({
  selectedDay,
  activeProgram,
  todayReadinessEntry,
  todayReadinessSummary,
  sessions,
  onGoToReadiness,
  onGoToWorkouts,
  onGoToWorkoutLog,
}) {
  const copy = getReadinessCopy(todayReadinessSummary);
  const lastSession = sessions[0];

  return (
    <div className="space-y-5">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Dashboard
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Today at a glance</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Metric label="Active program" value={activeProgram?.name ?? workoutProgram.name} />
          <Metric label="Selected day" value={selectedDay.shortName ?? selectedDay.name} />
          <Metric
            label="Readiness"
            value={todayReadinessEntry ? copy.label : "Not saved"}
          />
        </div>
        <p className="mt-4 text-sm font-semibold text-zinc-300">
          {todayReadinessEntry
            ? copy.guidance
            : "Save readiness first for better same-day coaching, then open Workouts or Workout Log."}
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring min-h-14 rounded-[8px] bg-zinc-900 px-4 text-left font-black text-white hover:bg-zinc-800"
        >
          Readiness
          <span className="block text-xs font-semibold text-zinc-400">Morning check-in</span>
        </button>
        <button
          type="button"
          onClick={onGoToWorkouts}
          className="focus-ring min-h-14 rounded-[8px] bg-lime-300 px-4 text-left font-black text-zinc-950 hover:bg-lime-200"
        >
          Workouts
          <span className="block text-xs font-semibold text-zinc-800">See today's plan</span>
        </button>
        <button
          type="button"
          onClick={onGoToWorkoutLog}
          className="focus-ring min-h-14 rounded-[8px] bg-zinc-900 px-4 text-left font-black text-white hover:bg-zinc-800"
        >
          Workout Log
          <span className="block text-xs font-semibold text-zinc-400">Log completed work</span>
        </button>
      </section>

      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-sm font-black text-white">Latest session</p>
        <p className="mt-2 text-sm font-semibold text-zinc-400">
          {lastSession
            ? `${lastSession.dayName} - ${new Date(lastSession.date).toLocaleString()}`
            : "No sessions logged yet."}
        </p>
      </section>
    </div>
  );
}

function WorkoutsPage({
  day,
  days,
  selectedDayId,
  activeProgram,
  programState,
  nextRecommendedDay,
  plan,
  todayReadinessEntry,
  todayReadinessSummary,
  setupCues,
  beatLastCues,
  onSelectDay,
  onGoToReadiness,
  onOpenWorkoutLog,
}) {
  const readinessCopy = getReadinessCopy(todayReadinessSummary);
  const sections =
    day.sections?.length
      ? day.sections
      : [{ id: "main", name: day.type === "recovery" ? "Recovery" : "Main Work" }];

  return (
    <div className="space-y-5">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Workouts
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">
          {activeProgram?.name ?? workoutProgram.name}
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Metric label="Selected day" value={day.shortName ?? day.name} />
          <Metric label="Focus" value={day.focus} />
          <Metric label="Next recommended" value={nextRecommendedDay?.name ?? "Not set yet"} />
          <Metric
            label="Readiness"
            value={
              todayReadinessEntry
                ? `${readinessCopy.label} (${todayReadinessSummary.averageScore.toFixed(1)}/5)`
                : "Not saved"
            }
          />
        </div>
        {programState?.lastWorkoutDate && (
          <p className="mt-3 text-xs font-semibold text-zinc-500">
            Last program workout: {new Date(programState.lastWorkoutDate).toLocaleString()}
          </p>
        )}
        {todayReadinessEntry && (
          <p className="mt-3 text-sm font-semibold text-zinc-300">
            {readinessCopy.summary}
          </p>
        )}
        <button
          type="button"
          onClick={() => onOpenWorkoutLog(day.id)}
          className="focus-ring mt-4 min-h-11 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
        >
          Open in Workout Log
        </button>
      </section>

      {!todayReadinessEntry && (
        <TodayReadinessSummary
          savedEntry={todayReadinessEntry}
          readiness={todayReadinessSummary}
          onGoToReadiness={onGoToReadiness}
        />
      )}

      <WorkoutDaySelector
        days={days}
        selectedDayId={selectedDayId}
        nextRecommendedDayId={programState?.nextRecommendedDayId}
        onSelectDay={onSelectDay}
      />

      {day.type === "recovery" ? (
        <WorkoutRecoveryView day={day} onOpenWorkoutLog={() => onOpenWorkoutLog(day.id)} />
      ) : (
        <>
          <TrainingGuidance savedEntry={todayReadinessEntry} readiness={todayReadinessSummary} />
          <section className="space-y-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
                Selected workout
              </p>
              <h2 className="mt-1 text-2xl font-black text-white">{day.name}</h2>
              <p className="mt-1 text-sm font-semibold text-zinc-400">{day.focus}</p>
            </div>

            {sections.map((section) => {
              const sectionExercises = day.exercises.filter((exercise) =>
                exercise.sectionId ? exercise.sectionId === section.id : section.id === "main",
              );

              if (!sectionExercises.length) {
                return null;
              }

              return (
                <div key={section.id} className="space-y-3">
                  <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2">
                    <h3 className="text-sm font-black uppercase tracking-[0.14em] text-lime-300">
                      {section.name}
                    </h3>
                    <span className="text-xs font-bold text-zinc-500">
                      {sectionExercises.length} exercises
                    </span>
                  </div>
                  {sectionExercises.map((exercise) => (
                    <WorkoutExerciseCard
                      key={exercise.id}
                      activeProgramId={activeProgram?.id}
                      exercise={exercise}
                      plan={plan}
                      setupCues={setupCues}
                      beatLastCue={beatLastCues[exercise.id]}
                      onOpenWorkoutLog={() =>
                        onOpenWorkoutLog(day.id, exercise.programExerciseId ?? exercise.id)
                      }
                    />
                  ))}
                </div>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}

function WorkoutDaySelector({ days, selectedDayId, nextRecommendedDayId, onSelectDay }) {
  return (
    <section className="space-y-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Select day
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {days.map((day) => {
          const isSelected = day.id === selectedDayId;
          const isNextRecommended = day.id === nextRecommendedDayId;

          return (
            <button
              key={day.id}
              type="button"
              onClick={() => onSelectDay(day.id)}
              className={`focus-ring min-h-20 rounded-[8px] border p-3 text-left transition ${
                isSelected
                  ? "border-lime-300 bg-lime-300/10"
                  : "border-zinc-800 bg-zinc-900 hover:bg-zinc-800"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-black text-white">{day.name}</p>
                  <p className="mt-1 text-xs font-semibold text-zinc-400">{day.focus}</p>
                </div>
                {isSelected && (
                  <span className="rounded-[8px] bg-lime-300 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-zinc-950">
                    Selected
                  </span>
                )}
              </div>
              {isNextRecommended && (
                <p className="mt-2 text-xs font-black uppercase tracking-[0.08em] text-amber-200">
                  Next recommended
                </p>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function WorkoutRecoveryView({ day, onOpenWorkoutLog }) {
  return (
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
        Recovery day
      </p>
      <h2 className="mt-1 text-2xl font-black text-white">{day.name}</h2>
      <p className="mt-1 text-sm font-semibold text-zinc-400">{day.focus}</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {(day.activities ?? []).map((activity) => (
          <div
            key={activity}
            className="rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-3 text-sm font-bold text-zinc-200"
          >
            {activity}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onOpenWorkoutLog}
        className="focus-ring mt-4 min-h-11 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
      >
        Open in Workout Log
      </button>
    </section>
  );
}

function WorkoutExerciseCard({
  activeProgramId,
  exercise,
  plan,
  setupCues,
  beatLastCue,
  onOpenWorkoutLog,
}) {
  const planExercise = getPlanExercise(plan, exercise.id);
  const displayPlan = getWorkoutExerciseRecommendation(
    activeProgramId,
    exercise,
    planExercise,
    plan.status,
  );
  const setupCue = getStoredSetupCue(setupCues, exercise);
  const hasMainCue = Boolean(formatTechnicalValue(exercise.mainCue));
  const hasNotes = Boolean(formatTechnicalValue(exercise.notes));

  return (
    <article className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
              {exercise.category}
            </span>
            <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
              {exercise.progressionType}
            </span>
            {displayPlan.conservative && (
              <span className="rounded-[8px] bg-amber-300/15 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-amber-100">
                Conservative
              </span>
            )}
          </div>
          <h3 className="mt-2 text-lg font-black text-white">{exercise.name}</h3>
          <p className="mt-1 text-sm font-semibold text-zinc-400">
            {exercise.muscleGroup || exercise.equipment}
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenWorkoutLog}
          className="focus-ring min-h-10 rounded-[8px] border border-lime-300/60 px-3 text-sm font-black text-lime-100 hover:bg-lime-300/10"
        >
          Open in Workout Log
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Metric label="Sets" value={displayPlan.sets} />
        <Metric label="Reps" value={displayPlan.repsLabel} />
        <Metric label="Kg" value={formatWeight(displayPlan.recommendedWeight, exercise)} />
        <Metric label="Target RPE" value={displayPlan.targetRPE} />
        <Metric label="Rest" value={formatRest(displayPlan.restSeconds)} />
      </div>

      <div className="mt-4 rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-3">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-lime-300">
          Recommendation
        </p>
        <p className="mt-1 text-sm font-semibold text-zinc-200">
          {displayPlan.recommendationNote}
        </p>
        {displayPlan.repFocus && (
          <p className="mt-2 text-sm font-bold text-lime-100">{displayPlan.repFocus}</p>
        )}
        <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-zinc-500">
          {displayPlan.source === "progression"
            ? "Program recommendation"
            : displayPlan.source === "next-plan"
              ? "Next-session plan"
              : "Baseline"}
        </p>
      </div>

      {(hasMainCue || setupCue || hasNotes) && (
        <div className="mt-3 space-y-2">
          {hasMainCue && (
            <p className="rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-semibold text-lime-100">
              Main cue: {exercise.mainCue}
            </p>
          )}
          {setupCue && (
            <p className="rounded-[8px] bg-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-200">
              Setup cue: {setupCue}
            </p>
          )}
          {hasNotes && (
            <p className="rounded-[8px] bg-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-200">
              Notes: {exercise.notes}
            </p>
          )}
        </div>
      )}

      {beatLastCue && (
        <div className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-xs font-semibold text-lime-100">
          <p>{beatLastCue.summary}</p>
          <p className="mt-1">{beatLastCue.target}</p>
        </div>
      )}

      <ExerciseMoreInfo exercise={exercise} setupCue={setupCue} />
    </article>
  );
}

function ExerciseMoreInfo({ exercise, setupCue }) {
  const leftInfoFields = [
    ["Main Cue", exercise.mainCue],
    ["Setup", exercise.setup || setupCue],
    ["How To Do It", exercise.howToDoIt],
    ["What You Should Feel", exercise.whatYouShouldFeel],
    ["Execution Tips", exercise.executionTips],
  ];
  const rightInfoFields = [
    ["Common Mistakes", exercise.commonMistakes],
    ["Why It's There", exercise.whyItsThere],
    ["Progression / Regression", exercise.progressionRegression],
    ["Safety Notes", exercise.safetyNotes],
  ];

  return (
    <details className="mt-3 rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-black text-zinc-100">
        <Info aria-hidden="true" size={16} className="text-lime-300" />
        More Info
      </summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {[leftInfoFields, rightInfoFields].map((columnFields, columnIndex) => (
          <div key={columnIndex} className="space-y-2">
            {columnFields.map(([label, value]) => {
              const text = formatTechnicalValue(value);

              return (
                <div key={label} className="rounded-[8px] bg-zinc-900 px-3 py-2">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-zinc-500">
                    {label}
                  </p>
                  <p className="mt-1 text-sm font-semibold leading-6 text-zinc-200">
                    {text || "Not added yet."}
                  </p>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </details>
  );
}

function WorkoutLogPage({
  day,
  plan,
  draft,
  todayReadinessEntry,
  todayReadinessSummary,
  setupCues,
  validationErrors,
  beatLastCues,
  scrollTarget,
  onFillAllSets,
  onUpdateExerciseNotes,
  onUpdateExerciseRPE,
  onUpdateRecoveryActivity,
  onUpdateSessionField,
  onUpdateSetupCue,
  onUpdateSet,
  onGoToReadiness,
  onScrollTargetHandled,
  onSave,
}) {
  const exerciseRefs = useRef({});
  const [highlightedExerciseId, setHighlightedExerciseId] = useState(null);

  useEffect(() => {
    const targetExerciseId = scrollTarget?.programExerciseId;

    if (!targetExerciseId || day.type === "recovery") {
      return undefined;
    }

    let timeoutId;
    const frameId = window.requestAnimationFrame(() => {
      const targetElement = exerciseRefs.current[targetExerciseId];

      if (!targetElement) {
        return;
      }

      targetElement.scrollIntoView({ behavior: "auto", block: "center" });
      setHighlightedExerciseId(targetExerciseId);
      timeoutId = window.setTimeout(() => {
        setHighlightedExerciseId((currentExerciseId) =>
          currentExerciseId === targetExerciseId ? null : currentExerciseId,
        );
        onScrollTargetHandled?.();
      }, 2600);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    day.id,
    day.type,
    scrollTarget?.programExerciseId,
    scrollTarget?.requestedAt,
    onScrollTargetHandled,
  ]);

  return (
    <form onSubmit={onSave} noValidate className="space-y-5">
      <TodayReadinessSummary
        savedEntry={todayReadinessEntry}
        readiness={todayReadinessSummary}
        onGoToReadiness={onGoToReadiness}
      />

      <ValidationSummary errors={validationErrors} />

      {day.type === "recovery" ? (
        <RecoveryDay
          day={day}
          draft={draft}
          onUpdateRecoveryActivity={onUpdateRecoveryActivity}
          onUpdateSessionField={onUpdateSessionField}
        />
      ) : (
        <>
          <CompletedWorkoutTable
            day={day}
            plan={plan}
            draft={draft}
            setupCues={setupCues}
            beatLastCues={beatLastCues}
            exerciseRefs={exerciseRefs}
            highlightedExerciseId={highlightedExerciseId}
            onFillAllSets={onFillAllSets}
            onUpdateExerciseNotes={onUpdateExerciseNotes}
            onUpdateExerciseRPE={onUpdateExerciseRPE}
            onUpdateSetupCue={onUpdateSetupCue}
            onUpdateSet={onUpdateSet}
          />
        </>
      )}

      <SessionFeedback draft={draft} onUpdateSessionField={onUpdateSessionField} />

      <button
        type="submit"
        className="focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-5 text-base font-black text-zinc-950 shadow-lg shadow-lime-950/30 transition hover:bg-lime-200"
      >
        <Save aria-hidden="true" size={20} />
        Save workout / Generate next recommendation
      </button>
    </form>
  );
}

function PlaceholderPage({ eyebrow, title, body }) {
  return (
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
        {eyebrow}
      </p>
      <h2 className="mt-1 text-2xl font-black text-white">{title}</h2>
      <p className="mt-3 text-sm font-semibold leading-6 text-zinc-300">{body}</p>
    </section>
  );
}

function TodayReadinessSummary({ savedEntry, readiness, onGoToReadiness }) {
  if (!savedEntry) {
    return (
      <section className="rounded-[8px] border border-amber-300/40 bg-amber-300/10 p-4">
        <p className="text-sm font-black text-amber-100">
          No readiness check-in saved for today.
        </p>
        <p className="mt-1 text-sm font-semibold text-amber-100/90">
          Complete it before training for better same-day guidance and smarter progression
          recommendations.
        </p>
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring mt-3 min-h-10 rounded-[8px] bg-amber-300 px-3 text-sm font-black text-zinc-950"
        >
          Go to Readiness
        </button>
      </section>
    );
  }

  const copy = getReadinessCopy(readiness);

  return (
    <section
      data-testid="today-readiness-summary"
      className={`rounded-[8px] border p-4 ${
        readinessStyles[readiness.status] ?? readinessStyles.yellow
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-black">Today's Readiness: {copy.label}</p>
          <p className="mt-1 text-sm font-semibold opacity-90">
            Average wellness: {readiness.averageScore.toFixed(1)} / 5
          </p>
          <p className="mt-1 text-sm font-semibold opacity-90">{copy.summary}</p>
        </div>
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring min-h-10 rounded-[8px] border border-current px-3 text-sm font-black"
        >
          Edit Today's Readiness
        </button>
      </div>
    </section>
  );
}

function TrainingGuidance({ savedEntry, readiness }) {
  const copy = getReadinessCopy(readiness);

  return (
    <section
      data-testid="training-guidance"
      className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4"
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
        Today's Training Guidance
      </p>
      <p className="mt-2 text-sm font-bold text-zinc-100">
        {savedEntry
          ? copy.guidance
          : "No saved readiness yet. Use the planned work, let RPE guide the session, and add a check-in when you can for sharper coaching."}
      </p>
    </section>
  );
}

function SectionShell({ eyebrow, title, children }) {
  return (
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
      {eyebrow && (
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          {eyebrow}
        </p>
      )}
      <h2 className={eyebrow ? "mt-1 text-xl font-black text-white" : "text-xl font-black text-white"}>
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ValidationSummary({ errors }) {
  if (!errors.length) {
    return null;
  }

  return (
    <section className="rounded-[8px] border border-red-400/50 bg-red-400/10 p-4">
      <p className="font-black text-red-100">Finish the required log fields before saving.</p>
      <ul className="mt-2 space-y-1 text-sm font-semibold text-red-100">
        {errors.slice(0, 6).map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
      {errors.length > 6 && (
        <p className="mt-2 text-sm font-semibold text-red-100">
          {errors.length - 6} more fields need attention.
        </p>
      )}
    </section>
  );
}

function RpeHelper({ showAthleticNote = false }) {
  const entries = [
    ["5", "Very easy, 5+ reps in reserve"],
    ["5.5", "Easy, around 4-5 reps in reserve"],
    ["6", "Comfortable, around 4 reps in reserve"],
    ["6.5", "Moderate-light, around 3-4 reps in reserve"],
    ["7", "Productive and controlled, around 3 reps in reserve"],
    ["7.5", "Fairly hard, around 2-3 reps in reserve"],
    ["8", "Hard but clean, around 2 reps in reserve"],
    ["8.5", "Very hard, around 1-2 reps in reserve"],
    ["9", "Near limit, about 1 rep in reserve"],
    ["9.5", "Extremely hard, 0-1 reps in reserve"],
    ["10", "Maximal, no clean reps left"],
  ];

  return (
    <details className="mb-3 rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-2 text-sm text-zinc-300">
      <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.12em] text-lime-300">
        RPE guide
      </summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {entries.map(([score, description]) => (
          <p key={score} className="rounded-[8px] bg-zinc-900 px-2 py-1 text-xs font-semibold">
            <span className="font-black text-white">RPE {score}</span> - {description}
          </p>
        ))}
      </div>
      {showAthleticNote && (
        <p className="mt-3 text-xs font-semibold text-amber-100">
          For explosive work, high RPE can also mean speed or quality dropped too much.
        </p>
      )}
    </details>
  );
}

function WellnessCheckIn({ wellness, readiness, onUpdateWellness }) {
  const copy = getReadinessCopy(readiness);

  return (
    <SectionShell eyebrow="Before training" title="Daily Wellness Check-In">
      <div
        data-testid="training-readiness"
        className={`mb-4 rounded-[8px] border px-3 py-3 ${
          readinessStyles[readiness.status] ?? readinessStyles.yellow
        }`}
      >
        <p className="text-sm font-black">{copy.title}</p>
        <p className="mt-1 text-xs font-semibold opacity-90">
          {copy.body} Average {readiness.averageScore.toFixed(1)} / 5
          {readiness.lowMetrics.length ? ` | Low: ${readiness.lowMetrics.join(", ")}` : ""}
        </p>
      </div>
      <div className="space-y-3">
        {wellnessMetrics.map((metric) => {
          const Icon = wellnessIcons[metric.id] ?? Activity;
          const value = numberValue(wellness[metric.id], 3);

          return (
            <div
              key={metric.id}
              className="grid gap-2 rounded-[8px] border border-zinc-800 bg-[#171717] p-3 sm:grid-cols-[150px_1fr]"
            >
              <div className="flex items-center gap-2">
                <Icon aria-hidden="true" size={17} className="text-lime-300" />
                <div>
                  <p className="text-sm font-black text-white">{metric.label}</p>
                  <p className="text-xs font-semibold text-zinc-500">
                    {wellnessScaleLabels[value]}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {[1, 2, 3, 4, 5].map((score) => {
                  const isSelected = score === value;

                  return (
                    <button
                      key={score}
                      type="button"
                      onClick={() => onUpdateWellness(metric.id, score)}
                      aria-label={`${metric.label} ${score}: ${wellnessScaleLabels[score]}`}
                      className={`focus-ring min-h-11 rounded-[8px] border text-sm font-black transition ${
                        isSelected
                          ? "border-lime-300 bg-lime-300 text-zinc-950"
                          : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
                      }`}
                    >
                      {score}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}

function RecoveryDay({ day, draft, onUpdateRecoveryActivity, onUpdateSessionField }) {
  return (
    <SectionShell title={day.name}>
      <div className="grid gap-2 sm:grid-cols-2">
        {day.activities.map((activity) => (
          <label
            key={activity}
            className="flex min-h-12 items-center gap-3 rounded-[8px] border border-zinc-800 bg-[#171717] px-3"
          >
            <input
              type="checkbox"
              checked={Boolean(draft.recoveryActivities[activity])}
              onChange={(event) => onUpdateRecoveryActivity(activity, event.target.checked)}
              className="h-5 w-5 accent-lime-300"
            />
            <span className="font-bold text-white">{activity}</span>
          </label>
        ))}
      </div>
      <label className="mt-4 block">
        <span className="mb-2 block text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
          Recovery notes
        </span>
        <textarea
          value={draft.recoveryNotes}
          onChange={(event) => onUpdateSessionField("recoveryNotes", event.target.value)}
          rows={3}
          className="focus-ring min-h-24 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3 text-sm text-white placeholder:text-zinc-600"
          placeholder="Light hoops, mobility quality, aches, what helped"
        />
      </label>
    </SectionShell>
  );
}

function WorkoutPlanTable({ day, plan, setupCues, beatLastCues, onUpdatePlanWeight }) {
  const sections =
    day.sections?.length
      ? day.sections
      : [{ id: "main", name: "Main Work", orderIndex: 0 }];

  return (
    <SectionShell title="Workout Plan Table">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0 text-left">
          <thead>
            <tr className="text-xs font-black uppercase tracking-[0.12em] text-zinc-500">
              <th className="border-b border-zinc-800 px-3 py-2">Exercise</th>
              <th className="border-b border-zinc-800 px-3 py-2">Sets x Reps</th>
              <th className="border-b border-zinc-800 px-3 py-2">Kg</th>
              <th className="border-b border-zinc-800 px-3 py-2">Rest</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => {
              const sectionExercises = day.exercises.filter((exercise) =>
                exercise.sectionId ? exercise.sectionId === section.id : section.id === "main",
              );

              if (!sectionExercises.length) {
                return null;
              }

              return [
                <tr key={`${section.id}-heading`}>
                  <td
                    colSpan={4}
                    className="border-b border-zinc-800 bg-[#171717] px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-lime-300"
                  >
                    {section.name}
                  </td>
                </tr>,
                ...sectionExercises.map((exercise) => {
                  const planExercise = getPlanExercise(plan, exercise.id);
                  const setupCue = getStoredSetupCue(setupCues, exercise);

                  return (
                    <tr key={exercise.id} className="align-top">
                      <td className="border-b border-zinc-800 px-3 py-3">
                        <p className="font-black text-white">{exercise.name}</p>
                        <p className="mt-1 text-xs font-semibold text-zinc-500">
                          {exercise.muscleGroup} | {exercise.progressionType} | Target RPE {planExercise.targetRPE}
                        </p>
                        {(setupCue || exercise.mainCue || exercise.notes) && (
                          <div className="mt-2 space-y-1">
                            {setupCue && (
                              <p className="rounded-[8px] bg-zinc-800 px-2 py-1 text-xs font-semibold text-zinc-200">
                                Setup: {setupCue}
                              </p>
                            )}
                            {exercise.mainCue && (
                              <p className="rounded-[8px] bg-zinc-800 px-2 py-1 text-xs font-semibold text-zinc-200">
                                Cue: {exercise.mainCue}
                              </p>
                            )}
                            {exercise.notes && (
                              <p className="rounded-[8px] bg-zinc-800 px-2 py-1 text-xs font-semibold text-zinc-200">
                                Notes: {exercise.notes}
                              </p>
                            )}
                          </div>
                        )}
                        <div className="mt-2 rounded-[8px] bg-lime-300/10 px-2 py-2 text-xs font-semibold text-lime-100">
                          <p>{beatLastCues[exercise.id].summary}</p>
                          <p className="mt-1">{beatLastCues[exercise.id].target}</p>
                        </div>
                      </td>
                      <td className="border-b border-zinc-800 px-3 py-3 text-sm font-bold text-zinc-200">
                        {formatSetsReps(planExercise)}
                      </td>
                      <td className="border-b border-zinc-800 px-3 py-3">
                        {isWeightEditable(exercise) ? (
                          <input
                            type="number"
                            min="0"
                            step={exercise.roundToKg ?? 0.5}
                            value={planExercise.recommendedWeight ?? ""}
                            onChange={(event) =>
                              onUpdatePlanWeight(exercise.id, event.target.value)
                            }
                            className="focus-ring min-h-10 w-24 rounded-[8px] border border-zinc-700 bg-[#111111] px-2 text-sm font-black text-white"
                            placeholder={exercise.loadType === "optionalExternal" ? "BW" : "kg"}
                            aria-label={`${exercise.name} recommended kg`}
                          />
                        ) : (
                          <span className="text-sm font-bold text-lime-100">
                            {formatWeight(planExercise.recommendedWeight, exercise)}
                          </span>
                        )}
                      </td>
                      <td className="border-b border-zinc-800 px-3 py-3 text-sm font-bold text-zinc-200">
                        {formatRest(planExercise.restSeconds)}
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function CompletedWorkoutTable({
  day,
  plan,
  draft,
  setupCues,
  beatLastCues,
  exerciseRefs,
  highlightedExerciseId,
  onFillAllSets,
  onUpdateExerciseNotes,
  onUpdateExerciseRPE,
  onUpdateSetupCue,
  onUpdateSet,
}) {
  return (
    <SectionShell title="Log Completed Workout">
      <RpeHelper
        showAthleticNote={day.exercises.some(
          (exercise) => exercise.progressionType === "athletic",
        )}
      />
      <div className="space-y-3">
        {day.exercises.map((exercise) => {
          const planExercise = getPlanExercise(plan, exercise.id);
          const draftExercise = draft.exercises[exercise.id];
          const setupCue = getStoredSetupCue(setupCues, exercise);
          const programExerciseId = exercise.programExerciseId ?? exercise.id;
          const isHighlighted = highlightedExerciseId === programExerciseId;

          return (
            <article
              key={exercise.id}
              ref={(node) => {
                if (node) {
                  exerciseRefs.current[programExerciseId] = node;
                } else {
                  delete exerciseRefs.current[programExerciseId];
                }
              }}
              className={`scroll-mt-28 rounded-[8px] border p-3 transition duration-500 ${
                isHighlighted
                  ? "border-lime-300 bg-lime-300/10 shadow-lg shadow-lime-950/40"
                  : "border-zinc-800 bg-[#171717]"
              }`}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="font-black text-white">{exercise.name}</h3>
                  <p className="text-xs font-semibold text-zinc-500">
                    {formatSetsReps(planExercise)} | {formatRest(planExercise.restSeconds)}
                  </p>
                  <p className="mt-2 rounded-[8px] bg-zinc-900 px-2 py-1 text-xs font-bold text-lime-100">
                    {beatLastCues[exercise.id].target}
                  </p>
                </div>
                <span className="text-sm font-black text-lime-100">
                  {formatWeight(planExercise.recommendedWeight, exercise)}
                </span>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1fr_150px]">
                <SetEntry
                  title="Reps Completed"
                  shortcutLabel="All sets same reps"
                  type="number"
                  inputMode="numeric"
                  values={draftExercise.sets.map((set) => set.reps)}
                  onFill={(value) => onFillAllSets(exercise.id, "reps", value)}
                  onChange={(index, value) => onUpdateSet(exercise.id, index, "reps", value)}
                />
                <SetEntry
                  title="Kg Used"
                  shortcutLabel="All sets same weight"
                  type={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "text" : "number"}
                  inputMode={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "text" : "decimal"}
                  values={draftExercise.sets.map((set) => set.weight)}
                  placeholder={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "BW" : "kg"}
                  onFill={(value) => onFillAllSets(exercise.id, "weight", value)}
                  onChange={(index, value) => onUpdateSet(exercise.id, index, "weight", value)}
                />
                <label>
                  <span className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-zinc-500">
                    Exercise RPE
                  </span>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    step="0.5"
                    value={draftExercise.exerciseRPE}
                    onChange={(event) => onUpdateExerciseRPE(exercise.id, event.target.value)}
                    className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-center text-base font-black text-white"
                  />
                </label>
              </div>

              <label className="mt-3 block">
                <span className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-zinc-500">
                  <CheckSquare aria-hidden="true" size={14} />
                  Setup cue
                </span>
                <input
                  type="text"
                  value={setupCue}
                  onChange={(event) => onUpdateSetupCue(exercise.id, event.target.value)}
                  className="focus-ring min-h-10 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white placeholder:text-zinc-600"
                  placeholder="Bench grip, seat height, machine pin, stance"
                />
              </label>

              <textarea
                value={draftExercise.notes}
                onChange={(event) => onUpdateExerciseNotes(exercise.id, event.target.value)}
                rows={2}
                className="focus-ring mt-3 min-h-16 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2 text-sm text-white placeholder:text-zinc-600"
                placeholder="Quick note: form, pain, setup, machine pin"
              />
            </article>
          );
        })}
      </div>
    </SectionShell>
  );
}

function SetEntry({
  title,
  shortcutLabel,
  type,
  inputMode,
  values,
  placeholder,
  onFill,
  onChange,
}) {
  const [shortcutValue, setShortcutValue] = useState("");

  function applyShortcut(value) {
    setShortcutValue(value);
    onFill(value);
  }

  return (
    <div>
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-zinc-500">
        {title}
      </span>
      <label className="mb-2 grid grid-cols-[1fr_auto] gap-2">
        <input
          type={type}
          inputMode={inputMode}
          value={shortcutValue}
          onChange={(event) => applyShortcut(event.target.value)}
          className="focus-ring min-h-10 rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-black text-white"
          placeholder={shortcutLabel}
        />
        <span className="flex min-h-10 items-center rounded-[8px] bg-zinc-900 px-2 text-xs font-black text-zinc-500">
          All
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {values.map((value, index) => (
          <label key={index}>
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.1em] text-zinc-600">
              Set {index + 1}
            </span>
            <input
              type={type}
              inputMode={inputMode}
              value={value}
              onChange={(event) => onChange(index, event.target.value)}
              className="focus-ring min-h-10 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-2 text-center text-sm font-black text-white"
              placeholder={placeholder}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function SessionFeedback({ draft, onUpdateSessionField }) {
  return (
    <SectionShell title="Session RPE">
      <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
        <label className="rounded-[8px] border border-zinc-800 bg-[#171717] p-3">
          <span className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
            <Activity aria-hidden="true" size={15} />
            1-10 score
          </span>
          <input
            required
            type="number"
            min="1"
            max="10"
            step="0.5"
            value={draft.sessionRpe}
            onChange={(event) => onUpdateSessionField("sessionRpe", event.target.value)}
            className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-lg font-black text-white"
          />
        </label>
        <label className="rounded-[8px] border border-zinc-800 bg-[#171717] p-3">
          <span className="mb-2 block text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
            Optional session notes
          </span>
          <textarea
            value={draft.sessionNotes}
            onChange={(event) => onUpdateSessionField("sessionNotes", event.target.value)}
            rows={3}
            className="focus-ring min-h-24 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3 text-sm text-white placeholder:text-zinc-600"
            placeholder="Anything that affected the session"
          />
        </label>
      </div>
    </SectionShell>
  );
}

function NextPlanPage({ selectedDay, selectedDayId, nextPlans, lastGeneratedPlan }) {
  const day = selectedDay ?? getProgramDay(selectedDayId);
  const plan = getPlanForDay(day, nextPlans[selectedDayId]);
  const generatedDate = plan.generatedAt ? new Date(plan.generatedAt) : null;
  const wellnessSummary = plan.wellnessSummary ?? interpretWellness();
  const readinessNotes = plan.readinessNotes ?? [];

  return (
    <div className="space-y-5">
      {lastGeneratedPlan && lastGeneratedPlan.dayId === selectedDayId && (
        <section className="rounded-[8px] border border-lime-300/50 bg-lime-300/10 p-4">
          <p className="text-sm font-black text-lime-100">Next {day.name} plan generated.</p>
        </section>
      )}

      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-300">
              Next Session Plan
            </p>
            <h2 className="mt-1 text-2xl font-black text-white">{day.name}</h2>
          </div>
          <p className="text-sm font-semibold text-zinc-400">
            {generatedDate ? generatedDate.toLocaleString() : "Base plan"}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <span className="rounded-[8px] bg-zinc-800 px-2.5 py-1 text-xs font-black uppercase tracking-[0.08em] text-zinc-300">
            Readiness: {wellnessSummary.status}
          </span>
          <span className="rounded-[8px] bg-zinc-800 px-2.5 py-1 text-xs font-black uppercase tracking-[0.08em] text-zinc-300">
            Avg {wellnessSummary.averageScore.toFixed(1)} / 5
          </span>
        </div>

        {readinessNotes.length > 0 && (
          <div className="mt-4 space-y-2">
            {readinessNotes.map((note) => (
              <p
                key={note}
                className="rounded-[8px] border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-sm font-semibold text-amber-100"
              >
                {note}
              </p>
            ))}
          </div>
        )}
      </section>

      {day.type === "recovery" ? (
        <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
          <p className="font-black text-white">Recovery slot stays flexible.</p>
          <p className="mt-2 text-sm text-zinc-400">
            Use basketball, mobility, stretching, recovery work, or optional abs based on the check-in.
          </p>
        </section>
      ) : (
        <section className="space-y-4">
          {day.exercises.map((exercise) => {
            const planExercise = getPlanExercise(plan, exercise.id);
            return (
              <PlanExerciseCard
                key={exercise.id}
                exercise={exercise}
                planExercise={planExercise}
              />
            );
          })}
        </section>
      )}
    </div>
  );
}

function PlanExerciseCard({ exercise, planExercise }) {
  const changedWeight = planExercise.recommendedWeight !== planExercise.previousWeight;

  return (
    <article className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-black text-white">{exercise.name}</h3>
          <p className="mt-1 text-sm text-zinc-400">
            {exercise.muscleGroup} | {exercise.progressionType} | {formatRest(planExercise.restSeconds)} rest
          </p>
          {planExercise.repFocus && (
            <p className="mt-2 text-sm font-bold text-lime-100">{planExercise.repFocus}</p>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center sm:min-w-80">
          <Metric label="Load" value={formatWeight(planExercise.recommendedWeight, exercise)} />
          <Metric label="Plan" value={formatSetsReps(planExercise)} />
          <Metric label="RPE" value={planExercise.targetRPE} />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <span
          className={`rounded-[8px] px-2.5 py-1 text-xs font-black ${
            changedWeight
              ? "bg-lime-300 text-zinc-950"
              : "bg-zinc-800 text-zinc-300"
          }`}
        >
          {changedWeight ? "Load adjusted" : "Load held"}
        </span>
        {planExercise.conservative && (
          <span className="rounded-[8px] bg-amber-300/15 px-2.5 py-1 text-xs font-black text-amber-100">
            Conservative
          </span>
        )}
        {exercise.equipment === "dumbbell" && (
          <span className="rounded-[8px] bg-sky-300/15 px-2.5 py-1 text-xs font-black text-sky-100">
            Per dumbbell
          </span>
        )}
        {exercise.progressionType === "athletic" && (
          <span className="rounded-[8px] bg-fuchsia-300/15 px-2.5 py-1 text-xs font-black text-fuchsia-100">
            Quality first
          </span>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {planExercise.reasons.map((reason) => (
          <p key={reason} className="text-sm leading-6 text-zinc-300">
            {reason}
          </p>
        ))}
      </div>
    </article>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-[8px] border border-zinc-800 bg-[#171717] px-2 py-2">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </p>
      <p className="mt-1 break-words text-sm font-black text-white">{value}</p>
    </div>
  );
}

function ProgramPage({ programs, activeProgramId, onDuplicateProgram, onSetActiveProgram }) {
  const visiblePrograms = programs.filter((program) => !program.isArchived);

  return (
    <div className="space-y-5">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Program administration
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Local programs</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          Program editing, archiving, sections, and full exercise editing come later. This phase
          only wires active program selection and safe duplication.
        </p>
        <div className="mt-4 space-y-3">
          {visiblePrograms.map((program) => {
            const isActive = program.id === activeProgramId;
            const days = getProgramDays(program.id);
            const exerciseCount = days.reduce(
              (total, day) => total + getProgramExercises(day.id).length,
              0,
            );
            const programState = getProgramState(program.id);

            return (
              <article
                key={program.id}
                className={`rounded-[8px] border p-4 ${
                  isActive
                    ? "border-lime-300/60 bg-lime-300/10"
                    : "border-zinc-800 bg-[#171717]"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap gap-2">
                      {isActive && (
                        <span className="rounded-[8px] bg-lime-300 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-950">
                          Active
                        </span>
                      )}
                      {program.isDefault && (
                        <span className="rounded-[8px] bg-amber-300/20 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-amber-100">
                          Default
                        </span>
                      )}
                    </div>
                    <h3 className="mt-3 text-lg font-black text-white">{program.name}</h3>
                    <p className="mt-1 text-sm font-semibold text-zinc-400">
                      {program.goal || "Local guest-mode program"}
                    </p>
                    {program.description && (
                      <p className="mt-2 text-sm leading-6 text-zinc-400">
                        {program.description}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={isActive}
                      onClick={() => onSetActiveProgram(program.id)}
                      className={`focus-ring min-h-10 rounded-[8px] px-3 text-sm font-black ${
                        isActive
                          ? "cursor-not-allowed bg-zinc-800 text-zinc-500"
                          : "bg-lime-300 text-zinc-950 hover:bg-lime-200"
                      }`}
                    >
                      {isActive ? "Active Program" : "Set Active"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDuplicateProgram(program.id)}
                      className="focus-ring min-h-10 rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-100 hover:bg-zinc-800"
                    >
                      Duplicate Program
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  <Metric label="Days" value={days.length} />
                  <Metric label="Exercises" value={exerciseCount} />
                  <Metric label="Week" value={programState.currentWeek} />
                  <Metric label="Cycle" value={programState.currentCycle} />
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function HistoryPage({ sessions }) {
  if (!sessions.length) {
    return (
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-6 text-center">
        <h2 className="text-xl font-black text-white">No sessions logged yet.</h2>
      </section>
    );
  }

  return (
    <div className="space-y-3">
      {sessions.map((session) => {
        const wellnessSummary = session.readiness ?? interpretWellness(session.wellness);

        return (
          <article key={session.id} className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-black text-white">{session.dayName}</h2>
                <p className="text-sm text-zinc-400">{new Date(session.date).toLocaleString()}</p>
                {session.sessionNotes && (
                  <p className="mt-2 text-sm text-zinc-300">{session.sessionNotes}</p>
                )}
                {session.recoveryNotes && (
                  <p className="mt-2 text-sm text-zinc-300">{session.recoveryNotes}</p>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Metric label="RPE" value={session.sessionRpe} />
                <Metric label="Readiness" value={wellnessSummary.status} />
                <Metric label="Avg" value={wellnessSummary.averageScore.toFixed(1)} />
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
