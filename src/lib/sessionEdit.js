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
      // The freeze flags of a stored plan entry (`held` / `overrideMode` /
      // `deloadSession`, H5-6 / H5-7) say what the LAST session was logged
      // under; they are replaced by the override / deload active NOW (H5 fix
      // round 1, decision H5-26). A hold that ran out or was cleared is
      // otherwise copied into the next session's snapshot, read as "Held by
      // you" in its recap and, through H5-15, frozen again by the engine.
      const {
        held: staleHeld,
        overrideMode: staleOverrideMode,
        overrideRemainingSessions: staleRemaining,
        deloadSession: staleDeloadSession,
        deloadLevel: staleDeloadLevel,
        ...planExercise
      } = getPlanExercise(plan, exercise.id) ?? {};
      const prescription = resolved[exercise.id];
      const override = prescription.override && typeof prescription.override === "object" ? prescription.override : null;

      return {
        ...planExercise,
        ...(override
          ? {
              overrideMode: override.mode ?? null,
              overrideRemainingSessions: override.remainingSessions ?? null,
              ...(override.mode === "hold" ? { held: true } : {}),
            }
          : {}),
        ...(prescription.deload ? { deloadSession: true, deloadLevel: prescription.deload.level ?? null } : {}),
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
        // H5 fix round 1: the deload of the resolution (base load / sets) so
        // the Workout Log's manual-override form prefills the base values.
        ...(prescription.deload ? { deload: prescription.deload } : {}),
      };
    }),
  };
}

export function buildPlannedExercisesSnapshot(day, resolvedPlan) {
  return Object.fromEntries(
    (day?.exercises ?? []).map((exercise) => {
      const planExercise = getPlanExercise(resolvedPlan, exercise.id);
      // The resolved plan entry keeps the H4 key set, so the active override /
      // deload of the day view model (H5-6 / H5-7) supplies the flags.
      const overrideMode = planExercise?.overrideMode ?? exercise.override?.mode ?? null;
      const held = planExercise?.held === true || overrideMode === "hold";
      const deloadSession = planExercise?.deloadSession === true || Boolean(exercise.deload);
      // The level travels with the flag so a regeneration after the deload
      // ended still names it (decision H5-15).
      const deloadLevel = deloadSession ? planExercise?.deloadLevel ?? exercise.deload?.level ?? null : null;

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
          // H5-12: hold / manual override / deload flags of the plan entry are
          // part of the snapshot only when set, so History and adherence can
          // tell "held by you" from an engine hold.
          ...(held ? { held: true } : {}),
          ...(overrideMode ? { overrideMode } : {}),
          ...(deloadSession ? { deloadSession: true } : {}),
          ...(deloadLevel ? { deloadLevel } : {}),
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
        // H5-13: timed / distance counts travel with the set only when logged.
        ...(isBlank(loggedSets[index]?.seconds) ? {} : { seconds: stringifyDraftValue(loggedSets[index].seconds) }),
        ...(isBlank(loggedSets[index]?.meters) ? {} : { meters: stringifyDraftValue(loggedSets[index].meters) }),
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
              ...(isBlank(set?.seconds) ? {} : { seconds: stringifyDraftValue(set.seconds) }),
              ...(isBlank(set?.meters) ? {} : { meters: stringifyDraftValue(set.meters) }),
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
