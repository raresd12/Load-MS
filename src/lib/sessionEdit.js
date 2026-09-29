// History session edit (Phase H4, decision H4-1; decisions new-E / new-H):
// the resolved plan and planned snapshot a session is saved against, the
// draft-shaped view of a saved session and the rebuild after an edit, all
// with the same day-driven normalisation as the save path. Moved verbatim
// from src/App.jsx. Fixture: scripts/verify-session-edit.mjs.
import { resolveDayPrescriptions } from "./prescriptionView.js";
import { getSessionAnalytics } from "./sessionAnalytics.js";
import {
  createDefaultWellness,
  createWorkoutSetLogs,
  getExerciseLog,
  getPlanExercise,
  isBlank,
  normalizeExerciseLogs,
  numberValue,
  validateDraft,
} from "./sessionNormalize.js";

/**
 * Plan for a day with every exercise replaced by its resolved prescription
 * (decision 19.4-2). Keeps the coach fields of the underlying plan entry.
 */
export function buildResolvedPlan(programId, day, plan) {
  const resolved = resolveDayPrescriptions(programId, day, plan);

  return {
    ...(plan ?? {}),
    exercises: (day?.exercises ?? []).map((exercise) => {
      const planExercise = getPlanExercise(plan, exercise.id) ?? {};
      const prescription = resolved[exercise.id];

      return {
        ...planExercise,
        exerciseId: exercise.id,
        name: exercise.name,
        sets: prescription.sets,
        repsMin: prescription.repsMin,
        repsMax: prescription.repsMax,
        repsLabel: prescription.repsLabel,
        targetRPE: prescription.targetRPE,
        restSeconds: prescription.restSeconds,
        recommendedWeight: prescription.recommendedWeight,
        prescriptionSource: prescription.source,
      };
    }),
  };
}

export function buildPlannedExercisesSnapshot(day, resolvedPlan) {
  return Object.fromEntries(
    (day?.exercises ?? []).map((exercise) => {
      const planExercise = getPlanExercise(resolvedPlan, exercise.id);

      return [
        exercise.id,
        {
          sets: planExercise?.sets ?? exercise.sets,
          repsMin: planExercise?.repsMin ?? exercise.repsMin,
          repsMax: planExercise?.repsMax ?? exercise.repsMax,
          repsLabel: planExercise?.repsLabel ?? exercise.repsLabel,
          targetRPE: planExercise?.targetRPE ?? exercise.targetRPE,
          recommendedWeight: planExercise?.recommendedWeight ?? exercise.recommendedWeight,
          restSeconds: planExercise?.restSeconds ?? exercise.restSeconds ?? null,
          prescriptionSource: planExercise?.prescriptionSource ?? null,
        },
      ];
    }),
  );
}

/**
 * The plan a saved session was logged against, rebuilt from its own
 * plannedExercises snapshot (falls back to the current targets only for
 * exercises the snapshot does not know).
 */
export function buildPlanFromSessionSnapshot(session, day) {
  const planned = session?.plannedExercises ?? {};

  return {
    status: "snapshot",
    exercises: (day?.exercises ?? []).map((exercise) => ({
      exerciseId: exercise.id,
      sets: exercise.sets,
      repsMin: exercise.repsMin,
      repsMax: exercise.repsMax,
      repsLabel: exercise.repsLabel,
      targetRPE: exercise.targetRPE,
      restSeconds: exercise.restSeconds,
      recommendedWeight: exercise.recommendedWeight,
      ...(planned[exercise.id] ?? {}),
    })),
  };
}

export function stringifyDraftValue(value) {
  return isBlank(value) ? "" : String(value);
}

/**
 * Draft-shaped view of a saved session (what the History editor edits).
 * Sets come from the session's own log so the edit never invents rows.
 */
export function buildDraftFromSession(session, day) {
  const exercises = Object.fromEntries(
    (day?.exercises ?? []).map((exercise) => {
      const log = getExerciseLog(session, exercise);
      const plannedSets = numberValue(session?.plannedExercises?.[exercise.id]?.sets, null);
      const loggedSets = Array.isArray(log?.sets) ? log.sets : [];
      const setCount = loggedSets.length || plannedSets || exercise.sets || 0;
      const sets = Array.from({ length: setCount }, (_, index) => ({
        reps: stringifyDraftValue(loggedSets[index]?.reps),
        weight: stringifyDraftValue(loggedSets[index]?.weight),
        rpe: stringifyDraftValue(loggedSets[index]?.rpe),
      }));

      return [
        exercise.id,
        {
          notes: log?.notes ?? "",
          painFlag: Boolean(log?.painFlag),
          sets,
        },
      ];
    }),
  );

  return {
    exercises,
    wellness: session?.wellness ?? createDefaultWellness(),
    recoveryActivities: session?.recoveryActivities ?? {},
    recoveryNotes: session?.recoveryNotes ?? "",
    sessionRpe: stringifyDraftValue(session?.sessionRpe),
    sessionNotes: session?.sessionNotes ?? "",
  };
}

/**
 * Decision new-E: rebuilds exercises / workoutSets / analytics of a saved
 * session from edited draft values with the same normalisation as the save
 * path. The id, date and program/day identity are kept; updatedAt is bumped.
 */
export function rebuildSessionFromEdits(session, day, edits) {
  const baseDraft = buildDraftFromSession(session, day);
  const draft = {
    ...baseDraft,
    sessionRpe: edits?.sessionRpe ?? baseDraft.sessionRpe,
    sessionNotes: edits?.sessionNotes ?? baseDraft.sessionNotes,
    exercises: Object.fromEntries(
      Object.entries(baseDraft.exercises).map(([exerciseId, baseExercise]) => {
        const edited = edits?.exercises?.[exerciseId];

        if (!edited) {
          return [exerciseId, baseExercise];
        }

        return [
          exerciseId,
          {
            ...baseExercise,
            notes: edited.notes ?? baseExercise.notes,
            painFlag: edited.painFlag ?? baseExercise.painFlag,
            sets: (edited.sets ?? baseExercise.sets).map((set) => ({
              reps: stringifyDraftValue(set?.reps),
              weight: stringifyDraftValue(set?.weight),
              rpe: stringifyDraftValue(set?.rpe),
            })),
          },
        ];
      }),
    ),
  };
  const errors = validateDraft(day, draft);

  if (errors.length) {
    return { ok: false, error: errors[0], errors };
  }

  const plan = buildPlanFromSessionSnapshot(session, day);
  const rebuiltSession = {
    ...session,
    exercises: normalizeExerciseLogs(day, draft.exercises),
    workoutSets: createWorkoutSetLogs({
      sessionId: session.id,
      programId: session.programId ?? null,
      day,
      plan,
      draft,
    }),
    sessionRpe: numberValue(draft.sessionRpe, null),
    sessionNotes: String(draft.sessionNotes ?? "").trim(),
    analytics: getSessionAnalytics(day, draft),
    updatedAt: new Date().toISOString(),
  };

  return { ok: true, session: rebuiltSession, errors: [] };
}
