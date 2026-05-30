import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Info,
  BarChart3,
  BatteryMedium,
  BookOpen,
  ChevronDown,
  CheckSquare,
  ClipboardList,
  Download,
  Dumbbell,
  Flame,
  Home,
  History,
  MoreHorizontal,
  Moon,
  Save,
  Settings,
  Trash2,
  Upload,
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
  getExerciseLibrary,
  getProgramBaseline,
  getProgramDayViewModels,
  getProgramProgression,
  getProgramState,
  getPrograms,
  seedDefaultProgramIfNeeded,
  setActiveProgram,
  updateProgramExerciseTarget,
  updateProgramMetadata,
  updateProgramState,
  upsertProgramProgressionsFromPlan,
} from "./lib/programStorage.js";
import {
  createLocalBackup,
  getTrackedStorageKeys,
  resetLocalAppData,
  restoreLocalBackup,
  STORAGE_KEYS,
  useLocalStorageState,
  validateLocalBackup,
} from "./lib/storage.js";

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

const mobilePrimaryTabs = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "readiness", label: "Readiness", icon: Activity },
  { id: "workouts", label: "Workouts", icon: Dumbbell },
  { id: "workout-log", label: "Log", icon: CheckSquare },
  { id: "more", label: "More", icon: MoreHorizontal },
];

const moreTabs = [
  { id: "program", label: "Program", icon: ClipboardList },
  { id: "library", label: "Library", icon: BookOpen },
  { id: "progress", label: "Progress", icon: BarChart3 },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings },
];

const secondaryTabIds = new Set(moreTabs.map((tab) => tab.id));
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

  if (matchedId) {
    return session.exercises[matchedId];
  }

  const workoutSets = session?.workoutSets?.filter(
    (set) => ids.includes(set.programExerciseId) || ids.includes(set.exerciseId),
  );

  if (!workoutSets?.length) {
    return null;
  }

  const setRpes = workoutSets
    .map((set) => set.actualRPE)
    .filter((rpe) => typeof rpe === "number");
  const exerciseRPE = setRpes.length
    ? Number((setRpes.reduce((total, rpe) => total + rpe, 0) / setRpes.length).toFixed(1))
    : null;

  return {
    notes: "",
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

function getStoredSetupCue(setupCues, exercise) {
  const matchedId = getExerciseStorageIds(exercise).find((id) => setupCues[id]);

  return matchedId ? setupCues[matchedId] : "";
}

function createDraft(day, plan, sessions = []) {
  const exercises = Object.fromEntries(
    day.exercises.map((exercise) => {
      const planExercise = getPlanExercise(plan, exercise.id);
      const setCount = planExercise?.sets ?? exercise.sets;

      return [
        exercise.id,
        {
          notes: "",
          sets: Array.from({ length: setCount }, () => ({
            reps: "",
            weight: "",
            rpe: "",
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

function getWorkoutDraftKey(programId, dayId, dateKey) {
  return [programId ?? "no-program", dayId ?? "no-day", dateKey].join("::");
}

function mergeSavedDraft(baseDraft, savedDraft) {
  if (!savedDraft) {
    return baseDraft;
  }

  return {
    ...baseDraft,
    recoveryActivities: {
      ...baseDraft.recoveryActivities,
      ...(savedDraft.recoveryActivities ?? {}),
    },
    recoveryNotes: savedDraft.recoveryNotes ?? baseDraft.recoveryNotes,
    sessionRpe: savedDraft.sessionRpe ?? baseDraft.sessionRpe,
    sessionNotes: savedDraft.sessionNotes ?? baseDraft.sessionNotes,
    exercises: Object.fromEntries(
      Object.entries(baseDraft.exercises).map(([exerciseId, baseExercise]) => {
        const savedExercise = savedDraft.exercises?.[exerciseId] ?? {};

        return [
          exerciseId,
          {
            ...baseExercise,
            notes: savedExercise.notes ?? baseExercise.notes,
            sets: baseExercise.sets.map((baseSet, index) => ({
              ...baseSet,
              ...(savedExercise.sets?.[index] ?? {}),
            })),
          },
        ];
      }),
    ),
  };
}

function getStoredWorkoutDraft(workoutDrafts, draftKey) {
  const draftEntry = workoutDrafts[draftKey];

  if (!draftEntry || draftEntry.status === "completed") {
    return null;
  }

  return draftEntry.draft ?? null;
}

function createDraftFromStorage(day, plan, sessions, workoutDrafts, draftKey) {
  return mergeSavedDraft(
    createDraft(day, plan, sessions),
    getStoredWorkoutDraft(workoutDrafts, draftKey),
  );
}

function isValidTab(tabId) {
  return tabs.some((tab) => tab.id === tabId);
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

    if (isBodyweightText(cleanValue)) {
      return "BW";
    }
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSetRpe(set) {
  const rpe = numberValue(set?.rpe, NaN);
  return isValidRpeValue(rpe) ? rpe : null;
}

function calculateAutoExerciseRpe(draftExercise) {
  const setRpes = (draftExercise?.sets ?? [])
    .map(getSetRpe)
    .filter((rpe) => rpe !== null);

  if (!setRpes.length) {
    return null;
  }

  const averageRpe = setRpes.reduce((total, rpe) => total + rpe, 0) / setRpes.length;
  return Number(averageRpe.toFixed(1));
}

function normalizeExerciseLogs(day, draftExercises) {
  return Object.fromEntries(
    day.exercises.map((exercise) => {
      const draftExercise = draftExercises[exercise.id];
      const exerciseRPE = calculateAutoExerciseRpe(draftExercise);

      return [
        exercise.id,
        {
          programExerciseId: exercise.programExerciseId ?? exercise.id,
          exerciseId: exercise.libraryExerciseId ?? exercise.legacyExerciseId ?? exercise.id,
          notes: draftExercise.notes.trim(),
          exerciseRPE,
          sets: draftExercise.sets.map((set) => ({
            reps: set.reps === "" ? null : numberValue(set.reps, 0),
            weight: normalizeWeight(set.weight),
            rpe: getSetRpe(set),
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

function isBodyweightText(value) {
  const cleanValue = String(value ?? "").trim().toLowerCase();
  return cleanValue === "bw" || cleanValue === "bodyweight" || cleanValue === "body weight";
}

function isHalfStep(value) {
  return Math.abs(value * 2 - Math.round(value * 2)) < 0.0001;
}

function isValidRpeValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 10 && isHalfStep(parsed);
}

function isValidWeightEntry(value, exercise) {
  if (exercise.loadType === "bodyweight") {
    return isBodyweightText(value);
  }

  if (exercise.loadType === "optionalExternal") {
    if (isBodyweightText(value)) {
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

    draftExercise.sets.forEach((set, index) => {
      const hasReps = !isBlank(set.reps);
      const hasWeight = !isBlank(set.weight);
      const hasRpe = !isBlank(set.rpe);

      if (!hasReps && !hasWeight && !hasRpe) {
        return;
      }

      if (hasReps) {
        const reps = numberValue(set.reps, NaN);
        if (!Number.isFinite(reps) || reps < 0) {
          errors.push(`${exercise.name} set ${index + 1}: reps must be 0 or higher.`);
        }

        if (!isValidWeightEntry(set.weight, exercise)) {
          errors.push(`${exercise.name} set ${index + 1}: enter kg or BW.`);
        }

        if (!hasRpe) {
          errors.push(`${exercise.name} set ${index + 1}: enter set RPE.`);
        }
      } else if (hasWeight) {
        errors.push(`${exercise.name} set ${index + 1}: kg/BW was entered without reps.`);
      } else if (hasRpe) {
        errors.push(`${exercise.name} set ${index + 1}: set RPE was entered without reps.`);
      }

      if (hasWeight && !isValidWeightEntry(set.weight, exercise)) {
        errors.push(`${exercise.name} set ${index + 1}: enter a valid kg value or BW.`);
      }

      if (hasRpe) {
        const setRpe = numberValue(set.rpe, NaN);
        if (!isValidRpeValue(setRpe)) {
          errors.push(`${exercise.name} set ${index + 1}: set RPE must be 1-10 in .5 steps.`);
        }
      }

      if (hasReps && hasWeight && hasRpe) {
        hasLoggedExerciseData = true;
      }
    });
  });

  if (!hasLoggedExerciseData) {
    errors.push("Log at least one complete set before generating recommendations.");
  }

  return errors;
}

function getSessionAnalytics(day, draft) {
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

function createWorkoutSetLogs({ sessionId, programId, day, plan, draft }) {
  return day.exercises.flatMap((exercise) => {
    const planExercise = getPlanExercise(plan, exercise.id);
    const draftExercise = draft.exercises[exercise.id];
    const programExerciseId = exercise.programExerciseId ?? exercise.id;
    const exerciseId = exercise.libraryExerciseId ?? exercise.legacyExerciseId ?? exercise.id;

    return draftExercise.sets.map((set, index) => {
      const actualReps = isBlank(set.reps) ? null : numberValue(set.reps, null);
      const actualWeight = normalizeWeight(set.weight);
      const actualRPE = getSetRpe(set);

      return {
        sessionId,
        programId,
        dayId: day.id,
        programExerciseId,
        exerciseId,
        setNumber: index + 1,
        plannedWeight: planExercise?.recommendedWeight ?? exercise.recommendedWeight ?? null,
        plannedReps: planExercise?.repsLabel ?? exercise.repsLabel ?? null,
        actualWeight,
        actualReps,
        actualRPE,
        completed: actualReps !== null && actualWeight !== null && actualRPE !== null,
      };
    });
  });
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
  const source = hasStoredProgression ? "progression" : hasGeneratedPlan ? "next-plan" : "program";
  const storedReps = hasStoredProgression ? progression.lastRecommendedReps : null;
  const baselineReps = baseline?.startingReps;

  return {
    source,
    sets:
      (hasStoredProgression ? progression.lastRecommendedSets : null) ??
      planExercise?.sets ??
      exercise.sets ??
      baseline?.startingSets,
    repsMin:
      storedReps?.min ??
      planExercise?.repsMin ??
      exercise.repsMin ??
      baselineReps?.min,
    repsMax:
      storedReps?.max ??
      planExercise?.repsMax ??
      exercise.repsMax ??
      baselineReps?.max,
    repsLabel:
      repsLabelFromRange(storedReps, null) !== "custom"
        ? repsLabelFromRange(storedReps, null)
        : planExercise?.repsLabel ??
          exercise.repsLabel ??
          (repsLabelFromRange(baselineReps, null) !== "custom"
            ? repsLabelFromRange(baselineReps, null)
            : "custom"),
    recommendedWeight:
      (hasStoredProgression ? progression.lastRecommendedWeight : null) ??
      planExercise?.recommendedWeight ??
      exercise.recommendedWeight ??
      baseline?.startingWeight,
    targetRPE:
      (hasStoredProgression ? progression.lastTargetRPE : null) ??
      planExercise?.targetRPE ??
      exercise.targetRPE ??
      baseline?.startingRPE,
    restSeconds: planExercise?.restSeconds ?? exercise.restSeconds ?? baseline?.restTime,
    recommendationNote: hasStoredProgression
      ? progression.recommendationNote
      : hasGeneratedPlan
        ? planExercise.reasons[0]
        : "Starting recommendation based on current program target.",
    repFocus:
      (hasStoredProgression ? progression.repFocus : null) ??
      planExercise?.repFocus ??
      null,
    conservative:
      Boolean(hasStoredProgression ? progression.conservative : planExercise?.conservative),
  };
}

function getProgramNickname(program) {
  if (!program) {
    return "Athletic Program";
  }

  if (program.nickname) {
    return program.nickname;
  }

  if (program.isDefault || program.name === workoutProgram.name || program.name.includes("Athletic Bodybuilding")) {
    return "Athletic Program";
  }

  return program.name;
}

function formatPrescriptionStrip(displayPlan, exercise) {
  return `${displayPlan.sets}x ${displayPlan.repsLabel} | ${formatWeight(displayPlan.recommendedWeight, exercise)} | RPE ${displayPlan.targetRPE} | Rest ${formatRest(displayPlan.restSeconds)}`;
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
  const [workoutDrafts, setWorkoutDrafts] = useLocalStorageState(STORAGE_KEYS.workoutDrafts, {});
  const [appUiState, setAppUiState] = useLocalStorageState(STORAGE_KEYS.appUiState, {});
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
  const exerciseLibrary = useMemo(() => getExerciseLibrary(), [programRevision]);
  const nextRecommendedDay = useMemo(
    () =>
      activeProgramDays.find((day) => day.id === activeProgramState?.nextRecommendedDayId) ??
      null,
    [activeProgramDays, activeProgramState],
  );
  const [selectedDayId, setSelectedDayId] = useState(
    () => appUiState.selectedDayId ?? activeProgramDays[0]?.id ?? workoutProgram.cycleOrder[0],
  );
  const [activeTab, setActiveTab] = useState(
    () => (isValidTab(appUiState.activeTab) ? appUiState.activeTab : "dashboard"),
  );
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
  const draftKey = useMemo(
    () => getWorkoutDraftKey(activeProgramId, selectedDayId, todayDateKey),
    [activeProgramId, selectedDayId, todayDateKey],
  );
  const [draft, setDraft] = useState(() =>
    createDraftFromStorage(selectedDay, activePlan, sessions, workoutDrafts, draftKey),
  );
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
    setDraft(createDraftFromStorage(selectedDay, activePlan, sessions, workoutDrafts, draftKey));
    setValidationErrors([]);
  }, [selectedDayId, activePlan.generatedAt, draftKey]);

  useEffect(() => {
    setAppUiState((currentState) => {
      if (
        currentState.activeTab === activeTab &&
        currentState.selectedDayId === selectedDayId &&
        currentState.activeProgramId === activeProgramId
      ) {
        return currentState;
      }

      return {
        ...currentState,
        activeTab,
        selectedDayId,
        activeProgramId,
        updatedAt: new Date().toISOString(),
      };
    });
  }, [activeTab, activeProgramId, selectedDayId, setAppUiState]);

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
    const nextDraftKey = getWorkoutDraftKey(activeProgramId, dayId, todayDateKey);

    setSelectedDayId(dayId);
    setDraft(createDraftFromStorage(nextDay, nextPlan, sessions, workoutDrafts, nextDraftKey));
    setValidationErrors([]);
  }

  function persistWorkoutDraft(nextDraft, status = "in_progress") {
    setWorkoutDrafts((currentDrafts) => ({
      ...currentDrafts,
      [draftKey]: {
        schemaVersion: 1,
        key: draftKey,
        status,
        programId: activeProgramId,
        dayId: selectedDayId,
        date: todayDateKey,
        updatedAt: new Date().toISOString(),
        draft: nextDraft,
      },
    }));
  }

  function clearWorkoutDraft() {
    setWorkoutDrafts((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      delete nextDrafts[draftKey];
      return nextDrafts;
    });
  }

  function commitDraft(nextDraft) {
    setDraft(nextDraft);
    persistWorkoutDraft(nextDraft);
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

  function handleUpdateProgramMetadata(programId, patch) {
    updateProgramMetadata(programId, patch);
    refreshProgramData();
  }

  function handleUpdateProgramExerciseTarget(programId, programExerciseId, patch) {
    const updatedExercise = updateProgramExerciseTarget(programId, programExerciseId, patch);

    if (updatedExercise) {
      refreshProgramData();
    }

    return updatedExercise;
  }

  function updateSessionField(field, value) {
    commitDraft({ ...draft, [field]: value });
  }

  function updateRecoveryActivity(activity, checked) {
    commitDraft({
      ...draft,
      recoveryActivities: {
        ...draft.recoveryActivities,
        [activity]: checked,
      },
    });
  }

  function updateSetEntry(exerciseId, setIndex, values) {
    commitDraft({
      ...draft,
      exercises: {
        ...draft.exercises,
        [exerciseId]: {
          ...draft.exercises[exerciseId],
          sets: draft.exercises[exerciseId].sets.map((set, index) =>
            index === setIndex ? { ...set, ...values } : set,
          ),
        },
      },
    });
  }

  function updateExerciseNotes(exerciseId, notes) {
    commitDraft({
      ...draft,
      exercises: {
        ...draft.exercises,
        [exerciseId]: {
          ...draft.exercises[exerciseId],
          notes,
        },
      },
    });
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
    event?.preventDefault?.();
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

    const sessionId = createId();
    const normalizedExerciseLogs = normalizeExerciseLogs(selectedDay, draft.exercises);
    const workoutSets = createWorkoutSetLogs({
      sessionId,
      programId: activeProgram?.id ?? null,
      day: selectedDay,
      plan: activePlan,
      draft,
    });

    const session = {
      id: sessionId,
      schemaVersion: 6,
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
      exercises: normalizedExerciseLogs,
      workoutSets,
      wellness: normalizedWellness,
      readiness: readinessSummary,
      recoveryActivities: draft.recoveryActivities,
      recoveryNotes: draft.recoveryNotes.trim(),
      sessionRpe: numberValue(draft.sessionRpe, null),
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
    clearWorkoutDraft();
    setDraft(createDraft(selectedDay, generatedPlan, [session, ...sessions]));
    setActiveTab("progress");
  }

  return (
    <div className="min-h-screen overflow-x-hidden">
      <header className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 pb-4 pt-4 min-[390px]:px-4 sm:gap-5 sm:px-6 sm:pb-5 sm:pt-5 lg:px-8">
        <div className="flex min-w-0 items-start justify-between gap-3 sm:gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-lime-300 min-[430px]:text-sm min-[430px]:tracking-[0.18em]">
              Athletic Bodybuilding Coach
            </p>
            <h1 className="mt-2 text-2xl font-black text-white min-[430px]:text-3xl sm:text-4xl">
              Train, log, progress
            </h1>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-zinc-700 bg-zinc-900 text-lime-300 sm:h-11 sm:w-11">
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

      <main className="mx-auto w-full max-w-6xl overflow-x-hidden px-3 pb-44 min-[390px]:px-4 sm:px-6 sm:pb-36 lg:px-8">
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
            onBeginEdit={() => {
              if (todayReadinessEntry) {
                setReadinessDraft(normalizeWellness(todayReadinessEntry.wellness));
                setReadinessSaveMessage("");
              }
            }}
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
            activeProgram={activeProgram}
            plan={activePlan}
            draft={draft}
            todayReadinessEntry={todayReadinessEntry}
            todayReadinessSummary={todayReadinessSummary}
            setupCues={setupCues}
            validationErrors={validationErrors}
            beatLastCues={beatLastCues}
            scrollTarget={workoutLogTarget}
            onUpdateExerciseNotes={updateExerciseNotes}
            onUpdateRecoveryActivity={updateRecoveryActivity}
            onUpdateSessionField={updateSessionField}
            onUpdateSetupCue={updateSetupCue}
            onSaveSet={updateSetEntry}
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
            onUpdateProgramMetadata={handleUpdateProgramMetadata}
            onUpdateProgramExerciseTarget={handleUpdateProgramExerciseTarget}
          />
        )}

        {activeTab === "library" && (
          <LibraryPage exercises={exerciseLibrary} setupCues={setupCues} />
        )}

        {activeTab === "history" && <HistoryPage sessions={sessions} />}

        {activeTab === "settings" && (
          <SettingsPage />
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-[#121212]/95 px-2 py-2 backdrop-blur sm:px-3 sm:py-3">
        <div className="mx-auto flex max-w-4xl gap-2 overflow-x-auto pb-2 [scrollbar-width:none]">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`focus-ring flex min-h-12 min-w-[76px] flex-col items-center justify-center rounded-[8px] px-2 text-[11px] font-bold transition min-[430px]:min-w-20 min-[430px]:text-xs ${
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
  onBeginEdit,
}) {
  const [isEditing, setIsEditing] = useState(() => !savedEntry);
  const copy = getReadinessCopy(savedEntry?.readiness ?? readiness);
  const savedReadiness = savedEntry?.readiness ?? readiness;

  useEffect(() => {
    setIsEditing(!savedEntry);
  }, [savedEntry?.updatedAt, savedEntry?.date]);

  function handleSave() {
    onSave();
  }

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
              ? "Readiness loaded for today."
              : "No readiness check-in saved for today yet.")}
        </p>
      </section>

      {savedEntry && !isEditing ? (
        <section
          className={`rounded-[8px] border p-4 ${
            readinessStyles[savedReadiness.status] ?? readinessStyles.yellow
          }`}
        >
          <p className="text-xs font-black uppercase tracking-[0.14em] opacity-80">
            Readiness loaded for today
          </p>
          <h2 className="mt-2 text-xl font-black">{copy.label}</h2>
          <p className="mt-1 text-sm font-semibold opacity-90">
            Score: {savedReadiness.averageScore.toFixed(1)} / 5
          </p>
          <p className="mt-2 text-sm font-semibold opacity-90">{copy.guidance}</p>
          <ReadinessValuesSummary wellness={savedEntry.wellness} />
          <button
            type="button"
            onClick={() => {
              onBeginEdit?.();
              setIsEditing(true);
            }}
            className="focus-ring mt-4 min-h-11 rounded-[8px] border border-current px-4 text-sm font-black"
          >
            Edit Readiness
          </button>
        </section>
      ) : (
        <>
          <WellnessCheckIn
            wellness={wellness}
            readiness={readiness}
            onUpdateWellness={onUpdateWellness}
          />

          <button
            type="button"
            onClick={handleSave}
            className="focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-5 text-base font-black text-zinc-950 shadow-lg shadow-lime-950/30 transition hover:bg-lime-200"
          >
            <Save aria-hidden="true" size={20} />
            Save today's readiness
          </button>
        </>
      )}
    </div>
  );
}

function ReadinessValuesSummary({ wellness }) {
  const normalizedWellness = normalizeWellness(wellness);

  return (
    <div className="mt-4 grid grid-cols-2 gap-2 min-[430px]:grid-cols-5">
      {wellnessMetrics.map((metric) => (
        <div key={metric.id} className="rounded-[8px] bg-black/15 px-2 py-2">
          <p className="text-[10px] font-black uppercase tracking-[0.12em] opacity-70">
            {metric.label}
          </p>
          <p className="mt-1 text-sm font-black">{normalizedWellness[metric.id]}</p>
        </div>
      ))}
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
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Workouts
        </p>
        <h2 className="mt-1 text-xl font-black text-white sm:hidden">
          {getProgramNickname(activeProgram)}
        </h2>
        <h2 className="mt-1 hidden text-2xl font-black text-white sm:block">
          {activeProgram?.name ?? workoutProgram.name}
        </h2>
        <div className="mt-3 space-y-1 text-sm font-bold text-zinc-300 sm:hidden">
          <p>Selected: <span className="text-white">{day.name}</span></p>
          <p>Readiness: <span className="text-white">{todayReadinessEntry ? readinessCopy.label : "Not saved"}</span></p>
          <p>Next: <span className="text-white">{nextRecommendedDay?.name ?? "Not set yet"}</span></p>
        </div>
        <div className="mt-4 hidden gap-3 sm:grid sm:grid-cols-4">
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
          <p className="mt-3 hidden text-xs font-semibold text-zinc-500 sm:block">
            Last program workout: {new Date(programState.lastWorkoutDate).toLocaleString()}
          </p>
        )}
        {todayReadinessEntry && (
          <p className="mt-3 hidden text-sm font-semibold text-zinc-300 sm:block">
            {readinessCopy.summary}
          </p>
        )}
        <button
          type="button"
          onClick={() => onOpenWorkoutLog(day.id)}
          className="focus-ring mt-4 min-h-11 w-full rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 sm:w-auto"
        >
          Open in Workout Log
        </button>
      </section>

      {!todayReadinessEntry && (
        <div className="hidden sm:block">
        <TodayReadinessSummary
          savedEntry={todayReadinessEntry}
          readiness={todayReadinessSummary}
          onGoToReadiness={onGoToReadiness}
        />
        </div>
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
          <div className="hidden sm:block">
            <TrainingGuidance savedEntry={todayReadinessEntry} readiness={todayReadinessSummary} />
          </div>
          <section className="space-y-4">
            <div className="hidden sm:block">
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
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const planExercise = getPlanExercise(plan, exercise.id);
  const displayPlan = getWorkoutExerciseRecommendation(
    activeProgramId,
    exercise,
    planExercise,
    plan.status,
  );
  const setupCue = getStoredSetupCue(setupCues, exercise);
  const primaryCue = formatTechnicalValue(exercise.mainCue || setupCue || exercise.notes);
  const prescriptionText = formatPrescriptionStrip(displayPlan, exercise);

  return (
    <article className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
      <div className="min-w-0">
        <div className="hidden flex-wrap gap-2 sm:flex">
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
        <h3 className="text-base font-black text-white sm:mt-2 sm:text-lg">{exercise.name}</h3>
        <p className="mt-1 hidden text-sm font-semibold text-zinc-400 sm:block">
          {exercise.muscleGroup || exercise.equipment}
        </p>
      </div>

      <p className="mt-3 rounded-[8px] border border-lime-300 bg-lime-950/70 px-3 py-2 text-sm font-black text-white shadow-sm shadow-lime-950/40">
        {prescriptionText}
      </p>

      <div className="mt-3 hidden grid-cols-2 gap-2 sm:grid sm:grid-cols-5">
        <Metric label="Sets" value={displayPlan.sets} />
        <Metric label="Reps" value={displayPlan.repsLabel} />
        <Metric label="Kg" value={formatWeight(displayPlan.recommendedWeight, exercise)} />
        <Metric label="Target RPE" value={displayPlan.targetRPE} />
        <Metric label="Rest" value={formatRest(displayPlan.restSeconds)} />
      </div>

      <div className="mt-3 rounded-[8px] bg-[#171717] px-3 py-2">
        <p className="text-xs font-semibold leading-5 text-zinc-300">
          <span className="font-black text-zinc-100">Reason:</span>{" "}
          {displayPlan.recommendationNote}
        </p>
        {displayPlan.repFocus && (
          <p className="mt-1 text-xs font-bold text-lime-100">{displayPlan.repFocus}</p>
        )}
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
          {displayPlan.source === "progression"
            ? "Program recommendation"
            : displayPlan.source === "next-plan"
              ? "Next-session plan"
              : displayPlan.source === "baseline"
                ? "Baseline"
                : "Program target"}
        </p>
      </div>

      {primaryCue && (
        <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-semibold text-lime-100">
          Main cue: {primaryCue}
        </p>
      )}

      {beatLastCue && (
        <div className="mt-3 hidden rounded-[8px] bg-lime-300/10 px-3 py-2 text-xs font-semibold text-lime-100 sm:block">
          <p>{beatLastCue.summary}</p>
          <p className="mt-1">{beatLastCue.target}</p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setIsInfoOpen((current) => !current)}
          className="focus-ring flex min-h-11 items-center justify-center gap-2 rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-100 hover:bg-zinc-800"
        >
          <Info aria-hidden="true" size={16} className="text-lime-300" />
          More Info
        </button>
        <button
          type="button"
          onClick={onOpenWorkoutLog}
          className="focus-ring min-h-11 rounded-[8px] border border-lime-300/60 px-3 text-sm font-black text-lime-100 hover:bg-lime-300/10"
        >
          <span className="sm:hidden">Log</span>
          <span className="hidden sm:inline">Open Log</span>
        </button>
      </div>

      {isInfoOpen && (
        <ExerciseInfoPanel exercise={exercise} setupCue={setupCue} className="mt-3" />
      )}
    </article>
  );
}

function ExerciseMoreInfo({ exercise, setupCue }) {
  return (
    <details className="mt-3 rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-black text-zinc-100">
        <Info aria-hidden="true" size={16} className="text-lime-300" />
        More Info
      </summary>
      <ExerciseInfoPanel exercise={exercise} setupCue={setupCue} className="mt-3" />
    </details>
  );
}

function ExerciseInfoPanel({ exercise, setupCue, className = "" }) {
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
      <div className={`${className} grid gap-2 sm:grid-cols-2`}>
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
  );
}

function WorkoutLogSummary({
  day,
  activeProgram,
  plan,
  savedReadinessEntry,
  readiness,
  onGoToReadiness,
}) {
  const readinessCopy = getReadinessCopy(readiness);
  const plannedSetCount = plan.exercises.reduce(
    (total, exercisePlan) => total + numberValue(exercisePlan.sets, 0),
    0,
  );

  return (
    <section className="hidden rounded-[8px] border border-zinc-800 bg-zinc-900 p-4 sm:block">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
        Workout Log
      </p>
      <h2 className="mt-1 text-2xl font-black text-white">{day.name}</h2>
      <p className="mt-2 text-sm font-semibold text-zinc-400">
        {activeProgram?.name ?? workoutProgram.name} | {day.focus}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Metric label="Exercises" value={day.exercises.length} />
        <Metric label="Planned sets" value={plannedSetCount} />
        <Metric label="Focus" value={day.focus} />
        <Metric
          label="Readiness"
          value={
            savedReadinessEntry
              ? `${readinessCopy.label} (${readiness.averageScore.toFixed(1)}/5)`
              : "Not saved"
          }
        />
      </div>
      {savedReadinessEntry && (
        <p className="mt-3 text-sm font-semibold text-zinc-300">
          {readinessCopy.summary}
        </p>
      )}
      <p className="mt-3 text-xs font-semibold text-zinc-500">
        Change the day from the Training day selector above. Log only what you actually completed.
      </p>
      {!savedReadinessEntry && (
        <button
          type="button"
          onClick={onGoToReadiness}
          className="focus-ring mt-3 min-h-10 rounded-[8px] border border-amber-300/60 px-3 text-sm font-black text-amber-100 hover:bg-amber-300/10"
        >
          Go to Readiness
        </button>
      )}
    </section>
  );
}

function WorkoutLogPage({
  day,
  activeProgram,
  plan,
  draft,
  todayReadinessEntry,
  todayReadinessSummary,
  setupCues,
  validationErrors,
  beatLastCues,
  scrollTarget,
  onUpdateExerciseNotes,
  onUpdateRecoveryActivity,
  onUpdateSessionField,
  onUpdateSetupCue,
  onSaveSet,
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
    <form onSubmit={(event) => event.preventDefault()} noValidate className="space-y-5">
      <WorkoutLogSummary
        day={day}
        activeProgram={activeProgram}
        plan={plan}
        savedReadinessEntry={todayReadinessEntry}
        readiness={todayReadinessSummary}
        onGoToReadiness={onGoToReadiness}
      />

      {!todayReadinessEntry && (
        <div className="hidden sm:block">
        <TodayReadinessSummary
          savedEntry={todayReadinessEntry}
          readiness={todayReadinessSummary}
          onGoToReadiness={onGoToReadiness}
        />
        </div>
      )}

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
            onUpdateExerciseNotes={onUpdateExerciseNotes}
            onUpdateSetupCue={onUpdateSetupCue}
            onSaveSet={onSaveSet}
          />
        </>
      )}

      <SessionFeedback draft={draft} onUpdateSessionField={onUpdateSessionField} />

      <button
        type="button"
        onClick={onSave}
        className="focus-ring flex min-h-14 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-5 text-base font-black text-zinc-950 shadow-lg shadow-lime-950/30 transition hover:bg-lime-200"
      >
        <Save aria-hidden="true" size={20} />
        Save workout / Generate next recommendation
      </button>
    </form>
  );
}

function SettingsPage() {
  const fileInputRef = useRef(null);
  const [exportMessage, setExportMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [pendingImport, setPendingImport] = useState(null);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");
  const [resetMessage, setResetMessage] = useState("");
  const trackedKeys = getTrackedStorageKeys();

  function handleExportData() {
    const backup = createLocalBackup();
    const fileName = `rpe-tracker-backup-${getLocalDateKey()}.json`;
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    setExportMessage(`Exported ${Object.keys(backup.data).length} data groups.`);
  }

  async function handleImportFile(event) {
    const file = event.target.files?.[0];

    setImportError("");
    setImportMessage("");
    setPendingImport(null);

    if (!file) {
      return;
    }

    try {
      const backup = JSON.parse(await file.text());
      const validation = validateLocalBackup(backup);

      if (!validation.valid) {
        setImportError(validation.error);
        return;
      }

      setPendingImport({
        backup,
        fileName: file.name,
        validation,
      });
    } catch {
      setImportError("Could not read that file. Choose a valid JSON backup.");
    } finally {
      event.target.value = "";
    }
  }

  function handleConfirmImport() {
    if (!pendingImport) {
      return;
    }

    const result = restoreLocalBackup(pendingImport.backup);

    if (!result.valid) {
      setImportError(result.error);
      return;
    }

    setImportMessage("Backup imported. Reloading app data...");
    setPendingImport(null);
    window.setTimeout(() => window.location.reload(), 700);
  }

  function handleResetLocalData() {
    if (resetText !== "RESET") {
      setResetMessage("Type RESET to confirm local data reset.");
      return;
    }

    resetLocalAppData();
    setResetMessage("Local app data reset. Reloading default program...");
    window.setTimeout(() => window.location.reload(), 700);
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          App Settings
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Settings</h2>
        <div className="mt-4 rounded-[8px] border border-lime-300/40 bg-lime-300/10 px-3 py-3">
          <p className="text-sm font-black text-lime-100">Guest Mode</p>
          <p className="mt-1 text-sm font-semibold leading-6 text-lime-100/90">
            Your data is saved only on this device/browser.
          </p>
        </div>
      </section>

      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-sm font-black text-white">Backup</p>
        <p className="mt-1 text-sm font-semibold leading-6 text-zinc-400">
          Export a JSON backup before switching phones, clearing browser data, or testing risky changes.
        </p>
        <button
          type="button"
          onClick={handleExportData}
          className="focus-ring mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
        >
          <Download aria-hidden="true" size={18} />
          Export Data
        </button>
        {exportMessage && (
          <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-bold text-lime-100">
            {exportMessage}
          </p>
        )}
      </section>

      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-sm font-black text-white">Import</p>
        <p className="mt-1 text-sm font-semibold leading-6 text-zinc-400">
          Choose a backup exported from this app. You will confirm before anything is restored.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportFile}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="focus-ring mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-100 hover:bg-zinc-800"
        >
          <Upload aria-hidden="true" size={18} />
          Import Data
        </button>

        {importError && (
          <p className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100">
            {importError}
          </p>
        )}

        {importMessage && (
          <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-bold text-lime-100">
            {importMessage}
          </p>
        )}

        {pendingImport && (
          <div className="mt-4 rounded-[8px] border border-amber-300/50 bg-amber-300/10 p-3">
            <p className="text-sm font-black text-amber-100">Confirm import</p>
            <p className="mt-1 text-sm font-semibold leading-6 text-amber-100/90">
              Import `{pendingImport.fileName}` and replace local RPE Tracker data on this device?
            </p>
            <p className="mt-2 text-xs font-bold text-amber-100/80">
              Recognized data groups: {pendingImport.validation.recognizedKeys.length}
              {pendingImport.validation.ignoredKeys.length
                ? ` | Ignored unknown groups: ${pendingImport.validation.ignoredKeys.length}`
                : ""}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleConfirmImport}
                className="focus-ring min-h-11 rounded-[8px] bg-amber-300 px-3 text-sm font-black text-zinc-950"
              >
                Import Backup
              </button>
              <button
                type="button"
                onClick={() => setPendingImport(null)}
                className="focus-ring min-h-11 rounded-[8px] border border-amber-300/60 px-3 text-sm font-black text-amber-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-[8px] border border-red-400/40 bg-red-400/10 p-3 min-[430px]:p-4">
        <div className="flex items-start gap-3">
          <Trash2 aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-red-200" />
          <div>
            <p className="text-sm font-black text-red-100">Reset Local Data</p>
            <p className="mt-1 text-sm font-semibold leading-6 text-red-100/90">
              This deletes local app data from this device/browser. After reload, the default program is seeded again.
            </p>
          </div>
        </div>
        {!isResetOpen ? (
          <button
            type="button"
            onClick={() => {
              setIsResetOpen(true);
              setResetMessage("");
            }}
            className="focus-ring mt-4 min-h-12 w-full rounded-[8px] border border-red-300/70 px-4 text-sm font-black text-red-100 hover:bg-red-300/10"
          >
            Reset Local Data
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-red-100/80">
                Type RESET to confirm
              </span>
              <input
                type="text"
                value={resetText}
                onChange={(event) => setResetText(event.target.value)}
                className="focus-ring min-h-12 w-full rounded-[8px] border border-red-300/60 bg-[#111111] px-3 text-base font-black text-white"
                placeholder="RESET"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={resetText !== "RESET"}
                onClick={handleResetLocalData}
                className={`focus-ring min-h-12 rounded-[8px] px-4 text-sm font-black ${
                  resetText === "RESET"
                    ? "bg-red-300 text-zinc-950"
                    : "cursor-not-allowed bg-red-300/20 text-red-100/50"
                }`}
              >
                Confirm Reset
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsResetOpen(false);
                  setResetText("");
                  setResetMessage("");
                }}
                className="focus-ring min-h-12 rounded-[8px] border border-red-300/60 px-4 text-sm font-black text-red-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {resetMessage && (
          <p className="mt-3 rounded-[8px] bg-red-300/10 px-3 py-2 text-sm font-bold text-red-100">
            {resetMessage}
          </p>
        )}
      </section>

      <details className="rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm font-black text-zinc-100">
          Local data groups included in backups
        </summary>
        <div className="mt-2 grid gap-1">
          {trackedKeys.map((key) => (
            <code
              key={key}
              className="break-all rounded-[8px] bg-[#111111] px-2 py-1 text-xs font-bold text-zinc-300"
            >
              {key}
            </code>
          ))}
        </div>
      </details>
    </div>
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
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
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
            className="focus-ring min-h-16 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3 text-sm text-white placeholder:text-zinc-600 sm:min-h-24"
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
  onUpdateExerciseNotes,
  onUpdateSetupCue,
  onSaveSet,
}) {
  const [expandedInfoIds, setExpandedInfoIds] = useState(() => new Set());

  function toggleExerciseInfo(exerciseId) {
    setExpandedInfoIds((currentIds) => {
      const nextIds = new Set(currentIds);

      if (nextIds.has(exerciseId)) {
        nextIds.delete(exerciseId);
      } else {
        nextIds.add(exerciseId);
      }

      return nextIds;
    });
  }

  return (
    <SectionShell title="Log Completed Workout">
      <div className="hidden sm:block">
        <RpeHelper
          showAthleticNote={day.exercises.some(
            (exercise) => exercise.progressionType === "athletic",
          )}
        />
      </div>
      <div className="space-y-3">
        {day.exercises.map((exercise) => {
          const planExercise = getPlanExercise(plan, exercise.id);
          const draftExercise = draft.exercises[exercise.id];
          const setupCue = getStoredSetupCue(setupCues, exercise);
          const programExerciseId = exercise.programExerciseId ?? exercise.id;
          const isHighlighted = highlightedExerciseId === programExerciseId;
          const isInfoExpanded = expandedInfoIds.has(programExerciseId);
          const autoExerciseRpe = calculateAutoExerciseRpe(draftExercise);
          const cueText = exercise.mainCue || setupCue || exercise.notes;
          const hasTechnicalInfo = hasExerciseTechnicalInfo(exercise, setupCue);

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
                  <p className="mt-1 text-xs font-semibold text-zinc-500 sm:hidden">
                    {formatMobilePlanSummary(planExercise)}
                  </p>
                  <p className="hidden text-xs font-semibold text-zinc-500 sm:block">
                    {formatSetsReps(planExercise)} | {formatWeight(planExercise.recommendedWeight, exercise)} | Target RPE {planExercise.targetRPE} | {formatRest(planExercise.restSeconds)}
                  </p>
                </div>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]">
                <div className="space-y-3">
                  <SavedSetsSummary exercise={exercise} sets={draftExercise.sets} />
                  <UnifiedSetEntry
                    exercise={exercise}
                    planExercise={planExercise}
                    sets={draftExercise.sets}
                    onSave={(index, values) => onSaveSet(exercise.id, index, values)}
                  />
                  <button
                    type="button"
                    onClick={() => toggleExerciseInfo(programExerciseId)}
                    className="focus-ring flex min-h-10 w-full items-center justify-center gap-2 rounded-[8px] border border-zinc-700 bg-zinc-900 px-3 text-xs font-black text-zinc-200 lg:hidden"
                  >
                    <Info aria-hidden="true" size={15} className="text-lime-300" />
                    Setup / Notes / Info
                    <ChevronDown
                      aria-hidden="true"
                      size={14}
                      className={`transition ${isInfoExpanded ? "rotate-180" : ""}`}
                    />
                  </button>
                </div>

                <aside className={`${isInfoExpanded ? "block" : "hidden"} space-y-3 lg:block`}>
                  <div className="rounded-[8px] border border-lime-300/20 bg-lime-300/10 px-3 py-2">
                    <span className="block text-[11px] font-black uppercase tracking-[0.12em] text-lime-200/80">
                      Auto Exercise RPE
                    </span>
                    <span className="text-xl font-black text-lime-100">
                      {autoExerciseRpe === null ? "--" : autoExerciseRpe.toFixed(1)}
                    </span>
                  </div>

                  <div className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
                    <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.12em] text-zinc-500">
                      Planned target
                    </span>
                    <p className="text-sm font-black text-white">{formatSetsReps(planExercise)}</p>
                    <p className="mt-1 text-xs font-bold text-zinc-400">
                      {formatWeight(planExercise.recommendedWeight, exercise)} | RPE {planExercise.targetRPE} | {formatRest(planExercise.restSeconds)}
                    </p>
                  </div>

                  <p className="rounded-[8px] bg-zinc-900 px-3 py-2 text-xs font-bold text-lime-100">
                    {beatLastCues[exercise.id].target}
                  </p>

                  {cueText && (
                    <p className="rounded-[8px] bg-zinc-900 px-3 py-2 text-xs font-bold text-zinc-300">
                      Cue: {cueText}
                    </p>
                  )}

                  <label className="block">
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
                    rows={3}
                    className="focus-ring min-h-20 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2 text-sm text-white placeholder:text-zinc-600"
                    placeholder="Quick note: form, pain, setup, machine pin"
                  />

                  {hasTechnicalInfo && (
                    <ExerciseMoreInfo exercise={exercise} setupCue={setupCue} />
                  )}
                </aside>
              </div>
            </article>
          );
        })}
      </div>
    </SectionShell>
  );
}

function SavedSetsSummary({ exercise, sets }) {
  return (
    <div>
      <p className="rounded-[8px] bg-zinc-900 px-2 py-1 text-[11px] font-bold leading-relaxed text-zinc-400 sm:hidden">
        {sets.map((set, index) => formatMobileSetSummary(set, index, exercise)).join(" | ")}
      </p>
      <div className="hidden gap-1.5 sm:grid sm:grid-cols-2">
        {sets.map((set, index) => {
          const isEmpty = isBlank(set.reps) && isBlank(set.weight) && isBlank(set.rpe);

          return (
            <p
              key={index}
              className={`rounded-[8px] px-2 py-1 text-xs font-bold ${
                isEmpty ? "bg-zinc-900 text-zinc-500" : "bg-lime-300/10 text-lime-100"
              }`}
            >
              Set {index + 1}:{" "}
              {isEmpty
                ? "empty"
                : `${formatSetWeightSummary(set.weight, exercise)} x ${isBlank(set.reps) ? "reps?" : set.reps} @ RPE ${isBlank(set.rpe) ? "?" : set.rpe}`}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function formatMobilePlanSummary(planExercise) {
  return `${formatSetsReps(planExercise).replace("x ", "x")} | RPE ${planExercise.targetRPE} | Rest ${formatRest(planExercise.restSeconds)}`;
}

function formatMobileSetSummary(set, index, exercise) {
  const prefix = `S${index + 1}`;
  const isEmpty = isBlank(set.reps) && isBlank(set.weight) && isBlank(set.rpe);

  if (isEmpty) {
    return `${prefix} empty`;
  }

  return `${prefix} ${formatSetWeightSummary(set.weight, exercise)} x ${isBlank(set.reps) ? "?" : set.reps} @${isBlank(set.rpe) ? "?" : set.rpe}`;
}

function hasExerciseTechnicalInfo(exercise, setupCue) {
  return [
    exercise.mainCue,
    exercise.setup || setupCue,
    exercise.howToDoIt,
    exercise.whatYouShouldFeel,
    exercise.executionTips,
    exercise.commonMistakes,
    exercise.whyItsThere,
    exercise.progressionRegression,
    exercise.safetyNotes,
  ].some((value) => Boolean(formatTechnicalValue(value)));
}

function formatSetWeightSummary(weight, exercise) {
  if (isBlank(weight)) {
    return exercise.loadType === "bodyweight" ? "BW?" : "kg?";
  }

  if (isBodyweightText(weight)) {
    return "BW";
  }

  const numericWeight = Number(weight);
  if (!Number.isFinite(numericWeight)) {
    return String(weight);
  }

  const formattedWeight = Number.isInteger(numericWeight)
    ? numericWeight.toString()
    : numericWeight.toFixed(1);

  return `${formattedWeight}kg`;
}

function getRecommendedSetEntryDefaults(exercise, planExercise) {
  const defaultReps =
    Number.isFinite(Number(planExercise?.repsMin)) && planExercise.repsMin !== null
      ? String(planExercise.repsMin)
      : Number.isFinite(Number(exercise.repsMin)) && exercise.repsMin !== null
        ? String(exercise.repsMin)
        : "";
  const recommendedWeight =
    planExercise?.recommendedWeight ?? exercise.recommendedWeight ?? null;
  const defaultWeight =
    recommendedWeight !== null && recommendedWeight !== undefined
      ? String(recommendedWeight)
      : exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal"
        ? "BW"
        : "";
  const defaultRpe = planExercise?.targetRPE ?? exercise.targetRPE ?? "";

  return {
    reps: defaultReps,
    weight: defaultWeight,
    rpe: defaultRpe === "" ? "" : String(defaultRpe),
  };
}

function getSetEntryValues(set, defaults) {
  const hasDraftData = !isBlank(set.reps) || !isBlank(set.weight) || !isBlank(set.rpe);

  if (!hasDraftData) {
    return defaults;
  }

  return {
    reps: isBlank(set.reps) ? "" : String(set.reps),
    weight: isBlank(set.weight) ? "" : String(set.weight),
    rpe: isBlank(set.rpe) ? "" : String(set.rpe),
  };
}

function adjustInputValue(value, delta, { min = 0, max = Infinity } = {}) {
  if (!isBlank(value) && !Number.isFinite(Number(value))) {
    return value;
  }

  const currentValue = isBlank(value) ? 0 : Number(value);
  const adjustedValue = Math.min(max, Math.max(min, currentValue + delta));
  return Number.isInteger(adjustedValue)
    ? String(adjustedValue)
    : adjustedValue.toFixed(1);
}

function validateSetEntry({ reps, weight, rpe }, exercise) {
  const errors = [];

  if (!isBlank(reps)) {
    const parsedReps = Number(reps);
    if (!Number.isFinite(parsedReps) || parsedReps < 0) {
      errors.push("Reps must be 0 or higher.");
    }
  }

  if (!isBlank(weight) && !isValidWeightEntry(weight, exercise)) {
    errors.push("Kg must be a valid number or BW.");
  }

  if (!isBlank(rpe) && !isValidRpeValue(rpe)) {
    errors.push("Set RPE must be 1-10 in .5 steps.");
  }

  return errors;
}

function UnifiedSetEntry({
  exercise,
  planExercise,
  sets,
  onSave,
}) {
  const [selectedSetIndex, setSelectedSetIndex] = useState(0);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [values, setValues] = useState(() =>
    getSetEntryValues(sets[0] ?? {}, getRecommendedSetEntryDefaults(exercise, planExercise)),
  );
  const [errors, setErrors] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    setValues(
      getSetEntryValues(
        sets[selectedSetIndex] ?? {},
        getRecommendedSetEntryDefaults(exercise, planExercise),
      ),
    );
    setErrors([]);
    setSaveMessage("");
  }, [exercise, planExercise, selectedSetIndex, sets]);

  function updateValue(field, value) {
    setValues((currentValues) => ({ ...currentValues, [field]: value }));
    setErrors([]);
    setSaveMessage("");
  }

  function saveSelectedSet() {
    const nextErrors = validateSetEntry(values, exercise);

    if (nextErrors.length) {
      setErrors(nextErrors);
      setSaveMessage("");
      return;
    }

    onSave(selectedSetIndex, values);
    setErrors([]);
    setSaveMessage(`Set ${selectedSetIndex + 1} saved.`);
  }

  function handleInputKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveSelectedSet();
    }
  }

  return (
    <div className="max-w-[360px] rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <span className="block text-xs font-black uppercase tracking-[0.12em] text-zinc-500">
          Set Entry
        </span>
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsSelectorOpen((current) => !current)}
            aria-expanded={isSelectorOpen}
            aria-label={`Selected Set: Set ${selectedSetIndex + 1}`}
            className="focus-ring flex min-h-11 items-center gap-2 rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-xs font-black text-white sm:min-h-9"
          >
            <span className="hidden text-zinc-500 sm:inline">Selected Set:</span>
            <span>Set {selectedSetIndex + 1}</span>
            <ChevronDown
              aria-hidden="true"
              size={14}
              className={`transition ${isSelectorOpen ? "rotate-180" : ""}`}
            />
          </button>
          {isSelectorOpen && (
            <div className="absolute right-0 z-20 mt-2 w-40 overflow-hidden rounded-[8px] border border-zinc-700 bg-[#111111] p-1 shadow-xl shadow-black/40">
              {sets.map((set, index) => {
                const isSelected = selectedSetIndex === index;
                const hasValue = !isBlank(set.reps) || !isBlank(set.weight) || !isBlank(set.rpe);

                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => {
                      setSelectedSetIndex(index);
                      setIsSelectorOpen(false);
                    }}
                    className={`focus-ring flex min-h-9 w-full items-center justify-between rounded-[6px] px-3 text-left text-xs font-black ${
                      isSelected
                        ? "bg-lime-300 text-zinc-950"
                        : hasValue
                          ? "text-lime-100 hover:bg-lime-300/10"
                          : "text-zinc-400 hover:bg-zinc-900"
                    }`}
                  >
                    Set {index + 1}
                    {hasValue && !isSelected && (
                      <span className="text-[10px] uppercase tracking-[0.12em]">saved</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="grid gap-2">
        <StepperInput
          label="Reps"
          value={values.reps}
          onChange={(value) => updateValue("reps", value)}
          onKeyDown={handleInputKeyDown}
          onStep={(delta) => updateValue("reps", adjustInputValue(values.reps, delta, { min: 0 }))}
          stepAmount={1}
          type="number"
          inputMode="numeric"
          placeholder="reps"
        />
        <StepperInput
          label="Kg"
          value={values.weight}
          onChange={(value) => updateValue("weight", value)}
          onKeyDown={handleInputKeyDown}
          onStep={(delta) =>
            updateValue("weight", adjustInputValue(values.weight, delta, { min: 0 }))
          }
          stepAmount={1}
          type={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "text" : "number"}
          inputMode={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "text" : "decimal"}
          placeholder={exercise.loadType === "bodyweight" || exercise.loadType === "optionalExternal" ? "BW" : "kg"}
        />
        <StepperInput
          label="RPE"
          value={values.rpe}
          onChange={(value) => updateValue("rpe", value)}
          onKeyDown={handleInputKeyDown}
          onStep={(delta) => updateValue("rpe", adjustInputValue(values.rpe, delta, { min: 1, max: 10 }))}
          stepAmount={0.5}
          type="number"
          inputMode="decimal"
          min="1"
          max="10"
          step="0.5"
          placeholder="8"
        />
      </div>
      {errors.length > 0 && (
        <div className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-100">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      {saveMessage && (
        <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-xs font-black text-lime-100">
          {saveMessage}
        </p>
      )}
      <button
        type="button"
        onClick={saveSelectedSet}
        className="focus-ring mt-3 min-h-11 w-full rounded-[8px] bg-lime-300 px-3 text-sm font-black text-zinc-950 hover:bg-lime-200"
      >
        Save Set
      </button>
    </div>
  );
}

function StepperInput({
  label,
  value,
  onChange,
  onKeyDown,
  onStep,
  stepAmount,
  type,
  inputMode,
  min,
  max,
  step,
  placeholder,
}) {
  return (
    <label className="grid grid-cols-[44px_36px_minmax(72px,1fr)_36px] items-center gap-1.5 sm:grid-cols-[44px_minmax(80px,130px)_32px] sm:gap-2">
      <span className="text-[11px] font-black uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </span>
      <button
        type="button"
        onClick={() => onStep(-stepAmount)}
        className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 bg-[#111111] text-sm font-black text-zinc-200 sm:hidden"
      >
        -
      </button>
      <input
        aria-label={label}
        type={type}
        inputMode={inputMode}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 bg-[#111111] px-2 text-center text-sm font-black text-white sm:min-h-10"
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={() => onStep(stepAmount)}
        className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 bg-[#111111] text-sm font-black text-zinc-200 sm:hidden"
      >
        +
      </button>
      <div className="hidden gap-1 sm:grid">
        <button
          type="button"
          onClick={() => onStep(stepAmount)}
          className="focus-ring min-h-5 rounded-[6px] border border-zinc-700 bg-[#111111] text-xs font-black leading-none text-zinc-200"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => onStep(-stepAmount)}
          className="focus-ring min-h-5 rounded-[6px] border border-zinc-700 bg-[#111111] text-xs font-black leading-none text-zinc-200"
        >
          -
        </button>
      </div>
    </label>
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
            className="focus-ring min-h-16 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3 text-sm text-white placeholder:text-zinc-600 sm:min-h-24"
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

function LibraryPage({ exercises, setupCues }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState({
    category: "",
    muscle: "",
    equipment: "",
    difficulty: "",
    goalTag: "",
  });
  const [openExerciseId, setOpenExerciseId] = useState(null);

  const filterOptions = useMemo(() => buildLibraryFilterOptions(exercises), [exercises]);
  const filteredExercises = useMemo(
    () => filterLibraryExercises(exercises, searchQuery, filters),
    [exercises, searchQuery, filters],
  );

  function updateFilter(filterId, value) {
    setFilters((currentFilters) => ({ ...currentFilters, [filterId]: value }));
  }

  function clearFilters() {
    setSearchQuery("");
    setFilters({
      category: "",
      muscle: "",
      equipment: "",
      difficulty: "",
      goalTag: "",
    });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Exercise Library
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Library</h2>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-400">
          Technique reference only. Program sets, reps, kg, RPE and rest stay in ProgramExercise records.
        </p>

        <label className="mt-4 block">
          <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-zinc-500">
            Search exercises
          </span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="focus-ring min-h-12 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-base font-bold text-white placeholder:text-zinc-600"
            placeholder="Search by name, muscle, equipment, cue"
          />
        </label>

        <div className="-mx-3 mt-3 overflow-x-auto px-3 pb-1 min-[430px]:-mx-4 min-[430px]:px-4">
          <div className="flex min-w-max gap-2">
            <LibraryFilterSelect
              label="Category"
              value={filters.category}
              options={filterOptions.categories}
              onChange={(value) => updateFilter("category", value)}
            />
            <LibraryFilterSelect
              label="Muscle"
              value={filters.muscle}
              options={filterOptions.muscles}
              onChange={(value) => updateFilter("muscle", value)}
            />
            <LibraryFilterSelect
              label="Equipment"
              value={filters.equipment}
              options={filterOptions.equipment}
              onChange={(value) => updateFilter("equipment", value)}
            />
            <LibraryFilterSelect
              label="Difficulty"
              value={filters.difficulty}
              options={filterOptions.difficulties}
              onChange={(value) => updateFilter("difficulty", value)}
            />
            <LibraryFilterSelect
              label="Goal"
              value={filters.goalTag}
              options={filterOptions.goalTags}
              onChange={(value) => updateFilter("goalTag", value)}
            />
            <button
              type="button"
              onClick={clearFilters}
              className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-200 hover:bg-zinc-800"
            >
              Clear
            </button>
          </div>
        </div>
      </section>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">
          {filteredExercises.length} exercises
        </p>
      </div>

      {filteredExercises.length ? (
        <section className="grid gap-3 md:grid-cols-2">
          {filteredExercises.map((exercise) => {
            const setupCue = getStoredSetupCue(setupCues, exercise);
            const isOpen = openExerciseId === exercise.id;

            return (
              <article
                key={exercise.id}
                className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="text-lg font-black text-white">{exercise.name}</h3>
                    <p className="mt-1 text-sm font-semibold text-zinc-400">
                      {formatLibraryList(exercise.mainMuscles, "No main muscle")}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
                      {exercise.category || "category"}
                    </span>
                    <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
                      {exercise.equipment || "equipment"}
                    </span>
                    <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
                      {exercise.difficulty || "difficulty"}
                    </span>
                  </div>
                </div>

                {formatTechnicalValue(exercise.mainCue) && (
                  <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-semibold text-lime-100">
                    Main cue: {exercise.mainCue}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => setOpenExerciseId(isOpen ? null : exercise.id)}
                  className="focus-ring mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-[8px] border border-lime-300/60 px-3 text-sm font-black text-lime-100 hover:bg-lime-300/10"
                >
                  <Info aria-hidden="true" size={16} />
                  {isOpen ? "Close Details" : "View Details"}
                </button>

                {isOpen && (
                  <ExerciseInfoPanel
                    exercise={exercise}
                    setupCue={setupCue}
                    className="mt-3"
                  />
                )}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
          <p className="font-black text-white">No exercises match those filters.</p>
          <p className="mt-1 text-sm font-semibold text-zinc-400">
            Clear filters or search a broader term.
          </p>
        </section>
      )}
    </div>
  );
}

function LibraryFilterSelect({ label, value, options, onChange }) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring min-h-11 min-w-[150px] rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-black text-white"
      >
        <option value="">{label}: All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function buildLibraryFilterOptions(exercises) {
  return {
    categories: uniqueSorted(exercises.map((exercise) => exercise.category)),
    muscles: uniqueSorted(
      exercises.flatMap((exercise) => [
        ...(exercise.mainMuscles ?? []),
        ...(exercise.secondaryMuscles ?? []),
      ]),
    ),
    equipment: uniqueSorted(exercises.map((exercise) => exercise.equipment)),
    difficulties: uniqueSorted(exercises.map((exercise) => exercise.difficulty)),
    goalTags: uniqueSorted(exercises.flatMap((exercise) => exercise.goalTags ?? [])),
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => formatTechnicalValue(value)).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function formatLibraryList(value, fallback = "Not added yet.") {
  const text = formatTechnicalValue(value);
  return text || fallback;
}

function filterLibraryExercises(exercises, searchQuery, filters) {
  const cleanQuery = searchQuery.trim().toLowerCase();

  return exercises.filter((exercise) => {
    const searchableText = [
      exercise.name,
      exercise.category,
      exercise.equipment,
      exercise.difficulty,
      exercise.mainCue,
      exercise.setup,
      exercise.howToDoIt,
      exercise.whatYouShouldFeel,
      ...(exercise.mainMuscles ?? []),
      ...(exercise.secondaryMuscles ?? []),
      ...(exercise.goalTags ?? []),
    ]
      .map((value) => formatTechnicalValue(value).toLowerCase())
      .join(" ");

    if (cleanQuery && !searchableText.includes(cleanQuery)) {
      return false;
    }

    if (filters.category && exercise.category !== filters.category) {
      return false;
    }

    const muscles = [...(exercise.mainMuscles ?? []), ...(exercise.secondaryMuscles ?? [])];
    if (filters.muscle && !muscles.includes(filters.muscle)) {
      return false;
    }

    if (filters.equipment && exercise.equipment !== filters.equipment) {
      return false;
    }

    if (filters.difficulty && exercise.difficulty !== filters.difficulty) {
      return false;
    }

    if (filters.goalTag && !(exercise.goalTags ?? []).includes(filters.goalTag)) {
      return false;
    }

    return true;
  });
}

function ProgramPage({
  programs,
  activeProgramId,
  onDuplicateProgram,
  onSetActiveProgram,
  onUpdateProgramMetadata,
  onUpdateProgramExerciseTarget,
}) {
  const visiblePrograms = programs.filter((program) => !program.isArchived);
  const activeProgram = visiblePrograms.find((program) => program.id === activeProgramId);

  return (
    <div className="space-y-5">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Program administration
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Local programs</h2>
        <div className="mt-4 rounded-[8px] border border-lime-300/30 bg-lime-300/10 px-3 py-3">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-200/80">
            Active Program
          </p>
          <p className="mt-1 text-lg font-black text-white">
            {activeProgram?.name ?? "No active program"}
          </p>
          {activeProgram?.nickname && (
            <p className="mt-1 text-sm font-bold text-lime-100">
              Nickname: {activeProgram.nickname}
            </p>
          )}
        </div>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Manage local guest-mode programs. Full exercise editing and drag-and-drop ordering come later.
        </p>
        <div className="mt-4 space-y-3">
          {visiblePrograms.map((program) => {
            const isActive = program.id === activeProgramId;
            return (
              <ProgramCard
                key={program.id}
                program={program}
                isActive={isActive}
                onDuplicateProgram={onDuplicateProgram}
                onSetActiveProgram={onSetActiveProgram}
                onUpdateProgramMetadata={onUpdateProgramMetadata}
                onUpdateProgramExerciseTarget={onUpdateProgramExerciseTarget}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ProgramCard({
  program,
  isActive,
  onDuplicateProgram,
  onSetActiveProgram,
  onUpdateProgramMetadata,
  onUpdateProgramExerciseTarget,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [form, setForm] = useState(() => createProgramMetadataForm(program));
  const days = getProgramDayViewModels(program.id);
  const exerciseCount = days.reduce((total, day) => total + day.exercises.length, 0);
  const programState = getProgramState(program.id);
  const isDefaultProgram = Boolean(program.isDefault);

  useEffect(() => {
    if (!isEditing) {
      setForm(createProgramMetadataForm(program));
    }
  }, [program, isEditing]);

  function updateField(field, value) {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  }

  function saveMetadata() {
    onUpdateProgramMetadata(program.id, form);
    setIsEditing(false);
  }

  return (
    <article
      className={`rounded-[8px] border p-3 min-[430px]:p-4 ${
        isActive
          ? "border-lime-300/60 bg-lime-300/10"
          : "border-zinc-800 bg-[#171717]"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            {isActive && <ProgramBadge tone="active">Active</ProgramBadge>}
            {program.isDefault && <ProgramBadge tone="default">Default</ProgramBadge>}
          </div>
          <h3 className="mt-3 text-lg font-black text-white">{program.name}</h3>
          {program.nickname && (
            <p className="mt-1 text-sm font-bold text-lime-100">{program.nickname}</p>
          )}
          <p className="mt-1 text-sm font-semibold text-zinc-400">
            {program.goal || "Local guest-mode program"}
          </p>
          {program.description && (
            <p className="mt-2 text-sm leading-6 text-zinc-400">{program.description}</p>
          )}
          <p className="mt-2 text-xs font-semibold text-zinc-500">
            Created {formatProgramDate(program.createdAt)} | Updated {formatProgramDate(program.updatedAt)}
          </p>
        </div>
        <div className="grid gap-2 sm:min-w-44">
          <button
            type="button"
            disabled={isActive}
            onClick={() => onSetActiveProgram(program.id)}
            className={`focus-ring min-h-11 w-full rounded-[8px] px-3 text-sm font-black ${
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
            className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-100 hover:bg-zinc-800"
          >
            Duplicate Program
          </button>
          <button
            type="button"
            onClick={() => setIsEditing((current) => !current)}
            className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-100 hover:bg-zinc-800"
          >
            {isEditing ? "Close Edit" : "Edit Details"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Metric label="Days" value={days.length} />
        <Metric label="Exercises" value={exerciseCount} />
        <Metric label="Week" value={programState.currentWeek} />
        <Metric label="Cycle" value={programState.currentCycle} />
      </div>

      {isEditing && (
        <ProgramMetadataForm
          isDefaultProgram={isDefaultProgram}
          form={form}
          onChange={updateField}
          onCancel={() => {
            setForm(createProgramMetadataForm(program));
            setIsEditing(false);
          }}
          onSave={saveMetadata}
        />
      )}

      <details
        open={isEditorOpen}
        onToggle={(event) => setIsEditorOpen(event.currentTarget.open)}
        className="mt-4 rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-2"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-black text-zinc-100">
          Prescription editor
          <ChevronDown
            aria-hidden="true"
            size={16}
            className={`transition ${isEditorOpen ? "rotate-180" : ""}`}
          />
        </summary>
        {isDefaultProgram ? (
          <DefaultProgramEditorLock onDuplicate={() => onDuplicateProgram(program.id)} />
        ) : (
          <ProgramPrescriptionEditor
            program={program}
            days={days}
            onUpdateProgramExerciseTarget={onUpdateProgramExerciseTarget}
          />
        )}
      </details>

      <details
        open={isPreviewOpen}
        onToggle={(event) => setIsPreviewOpen(event.currentTarget.open)}
        className="mt-4 rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-2"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-black text-zinc-100">
          Read-only program preview
          <ChevronDown
            aria-hidden="true"
            size={16}
            className={`transition ${isPreviewOpen ? "rotate-180" : ""}`}
          />
        </summary>
        <ProgramPreview days={days} />
      </details>
    </article>
  );
}

function ProgramBadge({ tone, children }) {
  const className =
    tone === "active"
      ? "bg-lime-300 text-zinc-950"
      : "bg-amber-300/20 text-amber-100";

  return (
    <span className={`rounded-[8px] px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] ${className}`}>
      {children}
    </span>
  );
}

function createProgramMetadataForm(program) {
  return {
    name: program.name ?? "",
    nickname: program.nickname ?? "",
    description: program.description ?? "",
    goal: program.goal ?? "",
  };
}

function ProgramMetadataForm({ isDefaultProgram, form, onChange, onCancel, onSave }) {
  return (
    <div className="mt-4 rounded-[8px] border border-zinc-800 bg-zinc-900 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {isDefaultProgram ? (
          <div className="rounded-[8px] border border-amber-300/30 bg-amber-300/10 px-3 py-3">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-100/80">
              Program name locked
            </p>
            <p className="mt-1 text-sm font-black text-white">{form.name}</p>
            <p className="mt-2 text-xs font-semibold leading-5 text-amber-100/80">
              The default program's core name is protected. Edit the nickname for mobile display.
            </p>
          </div>
        ) : (
          <ProgramTextField label="Program name" value={form.name} onChange={(value) => onChange("name", value)} />
        )}
        <ProgramTextField label="Nickname" value={form.nickname} onChange={(value) => onChange("nickname", value)} />
        <ProgramTextArea label="Description" value={form.description} onChange={(value) => onChange("description", value)} />
        <ProgramTextArea label="Goal" value={form.goal} onChange={(value) => onChange("goal", value)} />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={onSave}
          className="focus-ring min-h-11 rounded-[8px] bg-lime-300 px-3 text-sm font-black text-zinc-950"
        >
          Save Program Details
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ProgramTextField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white placeholder:text-zinc-600"
      />
    </label>
  );
}

function ProgramTextArea({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="focus-ring min-h-20 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2 text-sm font-bold text-white placeholder:text-zinc-600"
      />
    </label>
  );
}

function DefaultProgramEditorLock({ onDuplicate }) {
  return (
    <div className="mt-3 rounded-[8px] border border-amber-300/30 bg-amber-300/10 p-3">
      <p className="text-sm font-black text-amber-100">Duplicate to edit prescriptions.</p>
      <p className="mt-2 text-sm leading-6 text-amber-100/80">
        The default program is protected so the preloaded template stays available. Make a copy,
        then edit sets, reps, kg, RPE, rest, and notes on the duplicate.
      </p>
      <button
        type="button"
        onClick={onDuplicate}
        className="focus-ring mt-3 min-h-11 w-full rounded-[8px] bg-amber-300 px-3 text-sm font-black text-zinc-950 sm:w-auto"
      >
        Duplicate to Edit
      </button>
    </div>
  );
}

function ProgramPrescriptionEditor({ program, days, onUpdateProgramExerciseTarget }) {
  if (!days.length) {
    return (
      <p className="mt-3 rounded-[8px] bg-[#111111] px-3 py-3 text-sm font-semibold text-zinc-400">
        No training days found for this program yet.
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm leading-6 text-zinc-400">
        Edit planned targets only. This does not change exercise library info or completed workout
        history.
      </p>
      {days.map((day) => {
        const sections = day.sections?.length
          ? day.sections
          : [{ id: "main", name: "Main Work" }];

        return (
          <details key={day.id} className="rounded-[8px] border border-zinc-800 bg-[#111111]">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-black text-white">{day.name}</span>
                <span className="block text-xs font-semibold text-zinc-500">
                  {day.focus} | {day.exercises.length} exercises
                </span>
              </span>
              <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-zinc-500" />
            </summary>
            <div className="space-y-3 border-t border-zinc-800 p-3">
              {sections.map((section) => {
                const exercises = day.exercises.filter((exercise) =>
                  exercise.sectionId ? exercise.sectionId === section.id : section.id === "main",
                );

                if (!exercises.length) {
                  return null;
                }

                return (
                  <div key={section.id} className="space-y-2">
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">
                      {section.name}
                    </p>
                    {exercises.map((exercise) => (
                      <ProgramExerciseTargetEditor
                        key={exercise.programExerciseId ?? exercise.id}
                        program={program}
                        exercise={exercise}
                        onUpdateProgramExerciseTarget={onUpdateProgramExerciseTarget}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ProgramExerciseTargetEditor({ program, exercise, onUpdateProgramExerciseTarget }) {
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState(() => createProgramExerciseTargetForm(exercise));
  const [errors, setErrors] = useState([]);
  const [saveMessage, setSaveMessage] = useState("");
  const prescriptionText = `${exercise.sets}x ${exercise.repsLabel} | ${formatWeight(exercise.recommendedWeight, exercise)} | RPE ${exercise.targetRPE} | ${formatRest(exercise.restSeconds)}`;

  useEffect(() => {
    setForm(createProgramExerciseTargetForm(exercise));
    setErrors([]);
    setSaveMessage("");
  }, [
    exercise.programExerciseId,
    exercise.sets,
    exercise.repsMin,
    exercise.repsMax,
    exercise.repsLabel,
    exercise.recommendedWeight,
    exercise.targetRPE,
    exercise.restSeconds,
    exercise.notes,
  ]);

  function updateField(field, value) {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    setErrors([]);
    setSaveMessage("");
  }

  function saveTarget() {
    const result = validateProgramExerciseTargetForm(form, exercise);

    if (!result.valid) {
      setErrors(result.errors);
      setSaveMessage("");
      return;
    }

    const updatedExercise = onUpdateProgramExerciseTarget(
      program.id,
      exercise.programExerciseId ?? exercise.id,
      result.patch,
    );

    if (!updatedExercise) {
      setErrors(["This program target could not be saved. Duplicate the default program first."]);
      setSaveMessage("");
      return;
    }

    setErrors([]);
    setSaveMessage("Saved target.");
  }

  return (
    <details
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      className="rounded-[8px] border border-zinc-800 bg-zinc-900"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
        <span className="min-w-0">
          <span className="block break-words text-sm font-black text-white">{exercise.name}</span>
          <span className="mt-1 block text-xs font-semibold leading-5 text-zinc-400">
            {prescriptionText}
          </span>
        </span>
        <span className="shrink-0 rounded-[8px] border border-zinc-700 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
          Edit
        </span>
      </summary>
      <div className="space-y-3 border-t border-zinc-800 p-3">
        <div className="grid gap-3 min-[430px]:grid-cols-2 lg:grid-cols-4">
          <ProgramEditorField
            label="Sets"
            value={form.targetSets}
            onChange={(value) => updateField("targetSets", value)}
            inputMode="numeric"
          />
          <ProgramEditorField
            label="Reps Min"
            value={form.repsMin}
            onChange={(value) => updateField("repsMin", value)}
            inputMode="numeric"
          />
          <ProgramEditorField
            label="Reps Max"
            value={form.repsMax}
            onChange={(value) => updateField("repsMax", value)}
            inputMode="numeric"
          />
          <ProgramEditorField
            label="Reps Label"
            value={form.repsLabel}
            onChange={(value) => updateField("repsLabel", value)}
            placeholder="Optional"
          />
          <ProgramEditorField
            label="Kg / Weight"
            value={form.targetWeight}
            onChange={(value) => updateField("targetWeight", value)}
            placeholder={exercise.loadType === "bodyweight" ? "BW" : "Enter kg"}
            inputMode="decimal"
          />
          <ProgramEditorField
            label="Target RPE"
            value={form.targetRPE}
            onChange={(value) => updateField("targetRPE", value)}
            inputMode="decimal"
          />
          <ProgramEditorField
            label="Rest Seconds"
            value={form.restTime}
            onChange={(value) => updateField("restTime", value)}
            inputMode="numeric"
          />
        </div>
        <ProgramTextArea
          label="Program Exercise Notes"
          value={form.notes}
          onChange={(value) => updateField("notes", value)}
        />
        {errors.length > 0 && (
          <div className="rounded-[8px] border border-red-400/30 bg-red-500/10 px-3 py-2">
            {errors.map((error) => (
              <p key={error} className="text-sm font-semibold text-red-100">
                {error}
              </p>
            ))}
          </div>
        )}
        {saveMessage && (
          <p className="rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-black text-lime-100">
            {saveMessage}
          </p>
        )}
        <button
          type="button"
          onClick={saveTarget}
          className="focus-ring min-h-11 w-full rounded-[8px] bg-lime-300 px-3 text-sm font-black text-zinc-950 sm:w-auto"
        >
          Save Exercise Target
        </button>
      </div>
    </details>
  );
}

function ProgramEditorField({ label, value, onChange, placeholder = "", inputMode = "text" }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </span>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white placeholder:text-zinc-600"
      />
    </label>
  );
}

function createProgramExerciseTargetForm(exercise) {
  return {
    targetSets: stringifyProgramEditorValue(exercise.sets),
    repsMin: stringifyProgramEditorValue(exercise.repsMin),
    repsMax: stringifyProgramEditorValue(exercise.repsMax),
    repsLabel: getCustomRepsLabelForEditor(exercise),
    targetWeight: stringifyProgramWeightForEditor(exercise.recommendedWeight, exercise),
    targetRPE: stringifyProgramEditorValue(exercise.targetRPE),
    restTime: stringifyProgramEditorValue(getRestSecondsForEditor(exercise.restSeconds)),
    notes: exercise.notes ?? "",
  };
}

function stringifyProgramEditorValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function stringifyProgramWeightForEditor(value, exercise) {
  if (value === null || value === undefined || value === "") {
    return exercise.loadType === "bodyweight" ? "BW" : "";
  }

  return String(value);
}

function getRestSecondsForEditor(restSeconds) {
  if (Array.isArray(restSeconds)) {
    return restSeconds[1] ?? restSeconds[0] ?? "";
  }

  return restSeconds;
}

function getCustomRepsLabelForEditor(exercise) {
  const label = String(exercise.repsLabel ?? "").trim();
  const derived = getDerivedRepsLabel(exercise.repsMin, exercise.repsMax);

  if (!label || normalizeRepsLabel(label) === normalizeRepsLabel(derived)) {
    return "";
  }

  return label;
}

function getDerivedRepsLabel(repsMin, repsMax) {
  if (repsMin === null || repsMin === undefined || repsMax === null || repsMax === undefined) {
    return "";
  }

  return Number(repsMin) === Number(repsMax) ? String(repsMin) : `${repsMin}-${repsMax}`;
}

function normalizeRepsLabel(value) {
  return String(value ?? "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function validateProgramExerciseTargetForm(form, exercise) {
  const errors = [];
  const targetSets = parsePositiveInteger(form.targetSets);
  const repsMin = parseOptionalPositiveNumber(form.repsMin);
  const repsMax = parseOptionalPositiveNumber(form.repsMax);
  const repsLabel = form.repsLabel.trim();
  const targetWeight = parseProgramTargetWeight(form.targetWeight, exercise);
  const targetRPE = parseRpeValue(form.targetRPE);
  const restTime = parsePositiveNumber(form.restTime);

  if (targetSets === null) {
    errors.push("Sets must be a positive whole number.");
  }

  if (form.repsMin.trim() && repsMin === null) {
    errors.push("Reps min must be a positive number.");
  }

  if (form.repsMax.trim() && repsMax === null) {
    errors.push("Reps max must be a positive number.");
  }

  if (repsMin !== null && repsMax !== null && repsMax < repsMin) {
    errors.push("Reps max should be equal to or above reps min.");
  }

  if (repsMin === null && repsMax === null && !repsLabel) {
    errors.push("Add reps min/max or a reps label.");
  }

  if (targetWeight.invalid) {
    errors.push("Weight must be blank, BW, or a valid kg number.");
  }

  if (targetRPE === null) {
    errors.push("Target RPE must be 1-10 and can use .5 steps.");
  }

  if (restTime === null) {
    errors.push("Rest seconds must be a positive number.");
  }

  if (errors.length) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    patch: {
      targetSets,
      targetReps: {
        min: repsMin,
        max: repsMax,
        label: repsLabel || null,
      },
      targetWeight: targetWeight.value,
      targetRPE,
      restTime,
      notes: form.notes,
    },
  };
}

function parsePositiveInteger(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parsePositiveNumber(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parseOptionalPositiveNumber(value) {
  if (!value.trim()) {
    return null;
  }

  return parsePositiveNumber(value);
}

function parseRpeValue(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10 || !Number.isInteger(parsed * 2)) {
    return null;
  }

  return parsed;
}

function parseProgramTargetWeight(value, exercise) {
  const cleanValue = value.trim();

  if (!cleanValue) {
    return { invalid: false, value: null };
  }

  if (cleanValue.toLowerCase() === "bw") {
    return { invalid: false, value: exercise.loadType === "optionalExternal" ? null : "BW" };
  }

  const parsed = Number(cleanValue);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return { invalid: true, value: null };
  }

  return { invalid: false, value: parsed };
}

function ProgramPreview({ days }) {
  return (
    <div className="mt-3 space-y-3">
      {days.map((day) => {
        const sections = day.sections?.length
          ? day.sections
          : [{ id: "main", name: "Main Work" }];

        return (
          <div key={day.id} className="rounded-[8px] bg-[#111111] p-3">
            <h4 className="font-black text-white">{day.name}</h4>
            <p className="mt-1 text-xs font-semibold text-zinc-500">{day.focus}</p>
            {sections.map((section) => {
              const exercises = day.exercises.filter((exercise) =>
                exercise.sectionId ? exercise.sectionId === section.id : section.id === "main",
              );

              if (!exercises.length) {
                return null;
              }

              return (
                <div key={section.id} className="mt-3">
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">
                    {section.name}
                  </p>
                  <div className="mt-2 space-y-2">
                    {exercises.map((exercise) => (
                      <div
                        key={exercise.id}
                        className="rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 py-2"
                      >
                        <p className="font-black text-white">{exercise.name}</p>
                        <p className="mt-1 text-xs font-semibold leading-5 text-zinc-400">
                          {exercise.sets}x {exercise.repsLabel} | {formatWeight(exercise.recommendedWeight, exercise)} | RPE {exercise.targetRPE} | {formatRest(exercise.restSeconds)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function formatProgramDate(value) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleDateString();
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
