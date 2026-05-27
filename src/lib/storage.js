import { useEffect, useState } from "react";

export const STORAGE_KEYS = {
  sessions: "rpe-tracker.sessions.v1",
  nextPlans: "rpe-tracker.next-plans.v1",
  setupCues: "rpe-tracker.setup-cues.v1",
  readinessByDate: "rpe-tracker.readiness-by-date.v1",
  workoutDrafts: "rpe-tracker.workout-drafts.v1",
  appUiState: "rpe-tracker.app-ui-state.v1",
  programStorageMeta: "rpe-tracker.program-storage-meta.v1",
  programs: "rpe-tracker.programs.v1",
  activeProgramId: "rpe-tracker.active-program-id.v1",
  programDays: "rpe-tracker.program-days.v1",
  programSections: "rpe-tracker.program-sections.v1",
  exerciseLibrary: "rpe-tracker.exercise-library.v1",
  programExercises: "rpe-tracker.program-exercises.v1",
  baselines: "rpe-tracker.baselines.v1",
  programStates: "rpe-tracker.program-states.v1",
  programProgressions: "rpe-tracker.program-progressions.v1",
};

export function readStorage(key, fallbackValue) {
  if (typeof window === "undefined") {
    return fallbackValue;
  }

  try {
    const stored = window.localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

export function writeStorage(key, value) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}

export function useLocalStorageState(key, fallbackValue) {
  const [value, setValue] = useState(() => readStorage(key, fallbackValue));

  useEffect(() => {
    writeStorage(key, value);
  }, [key, value]);

  return [value, setValue];
}
