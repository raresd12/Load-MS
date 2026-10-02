// Workout Log draft and session normalisation (Phase H4, decision H4-1).
// Every function here was moved verbatim from src/App.jsx: the draft shape
// the Workout Log edits, the blank / half-step / BW validation rules, the
// exercise log and WorkoutSet records the save path writes, and the
// programId + programExerciseId identity rule for reading a session back
// (decision new-J). Fixture: scripts/verify-session-normalize.mjs.
import { getMeasurementProfile } from "./measurement.js";
import { wellnessMetrics } from "./progression.js";
import { isBodyweightText, normalizeWeight } from "./sessionLog.js";

// Phase H5 (decisions H5-1 / H5-13): a draft set keeps ONE count field in
// the exercise's measurement: `reps`, `seconds` or `meters`. A reps-only set
// of a timed / distance exercise (logged before H5) stays a reps set.
const DRAFT_COUNT_FIELDS = Object.freeze({ reps: "reps", time: "seconds", distance: "meters" });
const DRAFT_COUNT_NOUNS = Object.freeze({ reps: "reps", seconds: "seconds", meters: "meters" });

export function getDraftSetCountField(exercise) {
  return DRAFT_COUNT_FIELDS[getMeasurementProfile(exercise ?? {}).measurement] ?? "reps";
}

/** { field, value, noun } of the count a draft set holds ("" when blank). */
export function getDraftSetCount(set, exercise) {
  const field = getDraftSetCountField(exercise);

  if (!isBlank(set?.[field])) {
    return { field, value: set[field], noun: DRAFT_COUNT_NOUNS[field] };
  }

  if (field !== "reps" && !isBlank(set?.reps)) {
    return { field: "reps", value: set.reps, noun: "reps" };
  }

  return { field, value: "", noun: DRAFT_COUNT_NOUNS[field] };
}

/** A draft set holds logged data when any of its count / load / RPE fields is filled. */
export function hasDraftSetData(set) {
  return ["reps", "seconds", "meters", "weight", "rpe"].some((field) => !isBlank(set?.[field]));
}

export function createNeutralReadiness() {
  return {
    status: "yellow",
    averageScore: 3,
    isPoor: false,
    isGood: false,
    lowMetrics: [],
    missing: true,
  };
}

export function createDefaultWellness() {
  return Object.fromEntries(wellnessMetrics.map((metric) => [metric.id, 3]));
}

export function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isBlank(value) {
  return value === "" || value === null || value === undefined;
}

export function isHalfStep(value) {
  return Math.abs(value * 2 - Math.round(value * 2)) < 0.0001;
}

export function isValidRpeValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 10 && isHalfStep(parsed);
}

export function isValidWeightEntry(value, exercise) {
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

export function normalizeManualWeight(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeWellness(wellness) {
  return Object.fromEntries(
    wellnessMetrics.map((metric) => [
      metric.id,
      Math.min(5, Math.max(1, numberValue(wellness[metric.id], 3))),
    ]),
  );
}

export function getSetRpe(set) {
  const rpe = numberValue(set?.rpe, NaN);
  return isValidRpeValue(rpe) ? rpe : null;
}

export function calculateAutoExerciseRpe(draftExercise) {
  const setRpes = (draftExercise?.sets ?? [])
    .map(getSetRpe)
    .filter((rpe) => rpe !== null);

  if (!setRpes.length) {
    return null;
  }

  const averageRpe = setRpes.reduce((total, rpe) => total + rpe, 0) / setRpes.length;
  return Number(averageRpe.toFixed(1));
}

export function getPlanExercise(plan, exerciseId) {
  return plan?.exercises?.find((entry) => entry.exerciseId === exerciseId);
}

export function getExerciseStorageIds(exerciseOrId) {
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

export function getExerciseLog(session, exerciseOrId) {
  const ids = getExerciseStorageIds(exerciseOrId);
  const matchedId = ids.find((id) => session?.exercises?.[id]);

  if (matchedId) {
    return session.exercises[matchedId];
  }

  // Identity is programId + programExerciseId (handoff 3.1 / review finding F1):
  // a set that carries a different programExerciseId is a conflict, never a
  // Library-id fallback. Library/legacy ids only match sets without a program id.
  const programExerciseId =
    typeof exerciseOrId === "string"
      ? exerciseOrId
      : (exerciseOrId?.programExerciseId ?? exerciseOrId?.id ?? null);
  const workoutSets = session?.workoutSets?.filter((set) => {
    if (set.programExerciseId) {
      return set.programExerciseId === programExerciseId;
    }

    return ids.includes(set.exerciseId);
  });

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
        // H5-13: timed / distance counts only when the set carries them.
        ...(Number.isFinite(set.actualSeconds) ? { seconds: set.actualSeconds } : {}),
        ...(Number.isFinite(set.actualMeters) ? { meters: set.actualMeters } : {}),
      })),
  };
}

export function getStoredSetupCue(setupCues, exercise) {
  const matchedId = getExerciseStorageIds(exercise).find((id) => setupCues[id]);

  return matchedId ? setupCues[matchedId] : "";
}

export function createDraft(day, plan, sessions = []) {
  const exercises = Object.fromEntries(
    day.exercises.map((exercise) => {
      const planExercise = getPlanExercise(plan, exercise.id);
      const setCount = planExercise?.sets ?? exercise.sets;

      return [
        exercise.id,
        {
          notes: "",
          painFlag: false,
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

export function mergeSavedDraft(baseDraft, savedDraft) {
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
            painFlag: savedExercise.painFlag ?? baseExercise.painFlag ?? false,
            // The plan's slot count wins for blank rows, but a saved row the
            // athlete already logged beyond it is kept (H5 fix round 1,
            // decision H5-21): a hold / manual override / deload that lowers
            // the set count mid-session never drops logged sets.
            sets: [
              ...baseExercise.sets.map((baseSet, index) => ({
                ...baseSet,
                ...(savedExercise.sets?.[index] ?? {}),
              })),
              ...(Array.isArray(savedExercise.sets) ? savedExercise.sets : [])
                .slice(baseExercise.sets.length)
                .filter((savedSet) => hasDraftSetData(savedSet))
                .map((savedSet) => ({ reps: "", weight: "", rpe: "", ...savedSet })),
            ],
          },
        ];
      }),
    ),
  };
}

export function getStoredWorkoutDraft(workoutDrafts, draftKey) {
  const draftEntry = workoutDrafts[draftKey];

  if (!draftEntry || draftEntry.status === "completed") {
    return null;
  }

  return draftEntry.draft ?? null;
}

export function createDraftFromStorage(day, plan, sessions, workoutDrafts, draftKey) {
  return mergeSavedDraft(
    createDraft(day, plan, sessions),
    getStoredWorkoutDraft(workoutDrafts, draftKey),
  );
}

export function normalizeExerciseLogs(day, draftExercises) {
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
          painFlag: Boolean(draftExercise.painFlag),
          exerciseRPE,
          sets: draftExercise.sets.map((set) => {
            const count = getDraftSetCount(set, exercise);

            return {
              reps: isBlank(set.reps) ? null : numberValue(set.reps, 0),
              weight: normalizeWeight(set.weight),
              rpe: getSetRpe(set),
              // H5-13: the count of a timed / distance set lives in its own field.
              ...(count.field !== "reps" && !isBlank(count.value)
                ? { [count.field]: numberValue(count.value, 0) }
                : {}),
            };
          }),
        },
      ];
    }),
  );
}

export function validateDraft(day, draft) {
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
      // H5-13: the count is reps, seconds or meters by the exercise's measurement.
      const count = getDraftSetCount(set, exercise);
      const hasReps = !isBlank(count.value);
      const hasWeight = !isBlank(set.weight);
      const hasRpe = !isBlank(set.rpe);

      if (!hasReps && !hasWeight && !hasRpe) {
        return;
      }

      if (hasReps) {
        const reps = numberValue(count.value, NaN);
        if (!Number.isFinite(reps) || reps < 0) {
          errors.push(`${exercise.name} set ${index + 1}: ${count.noun} must be 0 or higher.`);
        }

        if (!isValidWeightEntry(set.weight, exercise)) {
          errors.push(`${exercise.name} set ${index + 1}: enter kg or BW.`);
        }

        if (!hasRpe) {
          errors.push(`${exercise.name} set ${index + 1}: enter set RPE.`);
        }
      } else if (hasWeight) {
        errors.push(`${exercise.name} set ${index + 1}: kg/BW was entered without ${count.noun}.`);
      } else if (hasRpe) {
        errors.push(`${exercise.name} set ${index + 1}: set RPE was entered without ${count.noun}.`);
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

export function createWorkoutSetLogs({ sessionId, programId, day, plan, draft }) {
  return day.exercises.flatMap((exercise) => {
    const planExercise = getPlanExercise(plan, exercise.id);
    const draftExercise = draft.exercises[exercise.id];
    const programExerciseId = exercise.programExerciseId ?? exercise.id;
    const exerciseId = exercise.libraryExerciseId ?? exercise.legacyExerciseId ?? exercise.id;
    // H5-13 / H5 fix round 1 (decision H5-20): every set records the profile
    // it was logged under (measurement, per side, weight mode, load type), a
    // plain reps + kg set included, so a later kg -> per dumbbell or per side
    // change of the exercise never rewrites the volume of what was logged and
    // the trend comparability guard sees both sides.
    const profile = getMeasurementProfile(exercise);
    const profileFields = {
      measurement: profile.measurement,
      perSide: profile.perSide,
      weightMode: profile.weightMode,
      loadType: profile.loadType,
    };

    return draftExercise.sets.map((set, index) => {
      const count = getDraftSetCount(set, exercise);
      const actualReps = isBlank(set.reps) ? null : numberValue(set.reps, null);
      const actualCount = isBlank(count.value) ? null : numberValue(count.value, null);
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
        ...(profile.measurement === "time" ? { actualSeconds: count.field === "seconds" ? actualCount : null } : {}),
        ...(profile.measurement === "distance" ? { actualMeters: count.field === "meters" ? actualCount : null } : {}),
        ...profileFields,
        completed: actualCount !== null && actualWeight !== null && actualRPE !== null,
      };
    });
  });
}

// Set entry (Save Set) defaults, stepper arithmetic and validation (H4 fix
// round 3, decision H4-15). Moved verbatim from
// src/components/workout/UnifiedSetEntry.jsx.
export function getRecommendedSetEntryDefaults(exercise, planExercise) {
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

export function getSetEntryValues(set, defaults) {
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

export function adjustInputValue(value, delta, { min = 0, max = Infinity } = {}) {
  if (!isBlank(value) && !Number.isFinite(Number(value))) {
    return value;
  }

  const currentValue = isBlank(value) ? 0 : Number(value);
  const adjustedValue = Math.min(max, Math.max(min, currentValue + delta));
  return Number.isInteger(adjustedValue)
    ? String(adjustedValue)
    : adjustedValue.toFixed(1);
}

export function validateSetEntry({ reps, weight, rpe }, exercise) {
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
