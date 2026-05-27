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

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_APP_ID = "rpe-workout-tracker";

export function getTrackedStorageKeys() {
  return Object.values(STORAGE_KEYS);
}

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

function readRawStorageValue(key) {
  if (typeof window === "undefined") {
    return undefined;
  }

  const stored = window.localStorage.getItem(key);

  if (stored === null) {
    return undefined;
  }

  try {
    return JSON.parse(stored);
  } catch {
    return stored;
  }
}

export function createLocalBackup() {
  const storageKeys = getTrackedStorageKeys();
  const data = {};

  storageKeys.forEach((key) => {
    const value = readRawStorageValue(key);

    if (value !== undefined) {
      data[key] = value;
    }
  });

  return {
    app: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    storageKeys,
    data,
  };
}

export function validateLocalBackup(backup) {
  if (!backup || typeof backup !== "object") {
    return { valid: false, error: "Backup file is not a valid JSON object." };
  }

  if (backup.app !== BACKUP_APP_ID) {
    return { valid: false, error: "This file is not an RPE Tracker backup." };
  }

  if (!backup.data || typeof backup.data !== "object" || Array.isArray(backup.data)) {
    return { valid: false, error: "Backup file does not contain app data." };
  }

  const trackedKeys = new Set(getTrackedStorageKeys());
  const backupKeys = Object.keys(backup.data);
  const recognizedKeys = backupKeys.filter((key) => trackedKeys.has(key));

  if (!recognizedKeys.length) {
    return { valid: false, error: "Backup file does not contain recognized RPE Tracker data." };
  }

  return {
    valid: true,
    recognizedKeys,
    ignoredKeys: backupKeys.filter((key) => !trackedKeys.has(key)),
  };
}

export function restoreLocalBackup(backup) {
  if (typeof window === "undefined") {
    return { valid: false, error: "Local storage is not available." };
  }

  const validation = validateLocalBackup(backup);

  if (!validation.valid) {
    return validation;
  }

  const trackedKeys = getTrackedStorageKeys();

  trackedKeys.forEach((key) => {
    window.localStorage.removeItem(key);
  });

  validation.recognizedKeys.forEach((key) => {
    window.localStorage.setItem(key, JSON.stringify(backup.data[key]));
  });

  return validation;
}

export function resetLocalAppData() {
  if (typeof window === "undefined") {
    return;
  }

  getTrackedStorageKeys().forEach((key) => {
    window.localStorage.removeItem(key);
  });
}

export function useLocalStorageState(key, fallbackValue) {
  const [value, setValue] = useState(() => readStorage(key, fallbackValue));

  useEffect(() => {
    writeStorage(key, value);
  }, [key, value]);

  return [value, setValue];
}
