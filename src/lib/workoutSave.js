// Save Workout assembly (H4 fix round 3, decision H4-14). The pure part of
// App.jsx `saveWorkout`, moved as it was: the session record, the plan the
// engine generates from it, and the next values of sessions / nextPlans /
// workoutDrafts / program state. Nothing here reads or writes storage and
// nothing touches React state: App.jsx validates the draft first, passes the
// bundle's `persistArgs` to `persistWorkoutSave` (one checked batch) and only
// then updates state. Fixture: scripts/verify-session-h4-repeat.mjs.
import { workoutProgram } from "../config/workoutProgram.js";
import { createId } from "./date.js";
import { generateNextPlan, interpretWellness } from "./progression.js";
import { getSessionAnalytics } from "./sessionAnalytics.js";
import { buildPlannedExercisesSnapshot } from "./sessionEdit.js";
import {
  createNeutralReadiness,
  createWorkoutSetLogs,
  normalizeExerciseLogs,
  normalizeWellness,
  numberValue,
} from "./sessionNormalize.js";

export const WORKOUT_SESSION_SCHEMA_VERSION = 6;

/**
 * buildWorkoutSaveBundle({
 *   day,             // the selected program day view model
 *   draft,           // the validated Workout Log draft
 *   plan,            // the RESOLVED plan of the day (decision 19.4-2), what the log showed
 *   sessions,        // saved sessions before this save (newest first)
 *   nextPlans,       // stored nextPlans object before this save
 *   workoutDrafts,   // stored workoutDrafts object before this save
 *   draftKey,        // key of the draft being saved (removed from workoutDrafts)
 *   program,         // active program or null
 *   programDays,     // day view models of the active program (next recommended day)
 *   readinessEntry,  // today's readiness check-in or null
 *   todayDateKey,    // local date key (decision H4-2)
 *   setupCues,       // setup cues snapshot
 *   now,             // Date of the save (default: new Date())
 *   id,              // session id (default: createId())
 * })
 *
 * Repeat-session rule (H4-14): every save is a NEW session with its own id,
 * prepended to `sessions`; an earlier session of the same program + day (same
 * date or not) is never replaced, merged or modified. The engine receives the
 * earlier sessions as history, and the generated plan replaces
 * `nextPlans[day.id]`.
 */
export function buildWorkoutSaveBundle({
  day,
  draft,
  plan,
  sessions = [],
  nextPlans = {},
  workoutDrafts = {},
  draftKey,
  program = null,
  programDays = [],
  readinessEntry = null,
  todayDateKey,
  setupCues = {},
  now = new Date(),
  id = createId(),
}) {
  const programId = program?.id ?? null;
  const readinessSnapshot = readinessEntry
    ? {
        ...readinessEntry,
        wellness: normalizeWellness(readinessEntry.wellness),
        readiness: readinessEntry.readiness ?? interpretWellness(readinessEntry.wellness),
      }
    : null;
  const normalizedWellness = readinessSnapshot?.wellness ?? null;
  const readinessSummary = readinessSnapshot?.readiness ?? createNeutralReadiness();

  // The planned snapshot uses the same resolver as Workouts / Workout Log so
  // history compares against what was actually shown (decision 19.4-2).
  const plannedExercises = buildPlannedExercisesSnapshot(day, plan);
  const normalizedExerciseLogs = normalizeExerciseLogs(day, draft.exercises);
  const workoutSets = createWorkoutSetLogs({
    sessionId: id,
    programId,
    day,
    plan,
    draft,
  });

  const session = {
    id,
    schemaVersion: WORKOUT_SESSION_SCHEMA_VERSION,
    appVersion: workoutProgram.version,
    date: now.toISOString(),
    programId,
    programName: program?.name ?? workoutProgram.name,
    readinessDate: todayDateKey,
    readinessSnapshot,
    readinessMissing: !readinessSnapshot,
    dayId: day.id,
    dayName: day.name,
    dayType: day.type,
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
    analytics: getSessionAnalytics(day, draft),
  };

  const generatedPlan = generateNextPlan(day, session, sessions);
  const nextSessions = [session, ...sessions];
  const nextPlansValue = { ...nextPlans, [day.id]: generatedPlan };
  const nextWorkoutDrafts = { ...workoutDrafts };
  delete nextWorkoutDrafts[draftKey];

  let programStatePatch;
  if (programId) {
    const dayIndex = programDays.findIndex((candidate) => candidate.id === day.id);
    const nextRecommendedDay =
      dayIndex >= 0 ? programDays[(dayIndex + 1) % programDays.length] : programDays[0];

    programStatePatch = {
      lastCompletedDayId: day.id,
      nextRecommendedDayId: nextRecommendedDay?.id ?? day.id,
      lastWorkoutDate: session.date,
    };
  }

  return {
    session,
    generatedPlan,
    sessions: nextSessions,
    nextPlans: nextPlansValue,
    workoutDrafts: nextWorkoutDrafts,
    programStatePatch,
    persistArgs: {
      sessions: nextSessions,
      nextPlans: nextPlansValue,
      workoutDrafts: nextWorkoutDrafts,
      programId,
      plan: generatedPlan,
      programStatePatch,
    },
  };
}
