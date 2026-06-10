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

function getStorageErrorMessage(error, fallbackMessage) {
  if (error?.name === "QuotaExceededError") {
    return "Browser storage is full. Export a backup, then free browser storage before saving more data.";
  }

  return error?.message ? `${fallbackMessage} ${error.message}` : fallbackMessage;
}

function warnStorageError(message, error) {
  console.warn(`[RPE Tracker storage] ${message}`, error);
}

function serializeStorageValue(value) {
  try {
    return { ok: true, serialized: JSON.stringify(value) };
  } catch (error) {
    const message = getStorageErrorMessage(error, "Could not prepare app data for local storage.");
    warnStorageError(message, error);
    return { ok: false, error: message };
  }
}

export function writeStorage(key, value) {
  if (typeof window === "undefined") {
    return { ok: false, error: "Local storage is not available." };
  }

  const serialized = serializeStorageValue(value);

  if (!serialized.ok) {
    return serialized;
  }

  try {
    window.localStorage.setItem(key, serialized.serialized);
    return { ok: true };
  } catch (error) {
    const message = getStorageErrorMessage(error, `Could not save ${key} to local storage.`);
    warnStorageError(message, error);
    return { ok: false, error: message };
  }
}

function readRawStorageValue(key) {
  if (typeof window === "undefined") {
    return undefined;
  }

  let stored;

  try {
    stored = window.localStorage.getItem(key);
  } catch (error) {
    warnStorageError(`Could not read ${key} from local storage.`, error);
    return undefined;
  }

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

function snapshotTrackedStorageValues(keys) {
  return keys.map((key) => {
    try {
      return [key, window.localStorage.getItem(key)];
    } catch (error) {
      warnStorageError(`Could not snapshot ${key} before restore.`, error);
      return [key, null];
    }
  });
}

function rollbackTrackedStorageValues(snapshot) {
  try {
    getTrackedStorageKeys().forEach((key) => {
      window.localStorage.removeItem(key);
    });

    snapshot.forEach(([key, value]) => {
      if (value !== null) {
        window.localStorage.setItem(key, value);
      }
    });

    return true;
  } catch (error) {
    warnStorageError("Could not fully roll back local storage after failed backup restore.", error);
    return false;
  }
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
  const serializedEntries = [];

  for (const key of validation.recognizedKeys) {
    const serialized = serializeStorageValue(backup.data[key]);

    if (!serialized.ok) {
      return {
        valid: false,
        error: `Backup data for ${key} could not be prepared. Existing data was not changed.`,
      };
    }

    serializedEntries.push([key, serialized.serialized]);
  }

  const previousSnapshot = snapshotTrackedStorageValues(trackedKeys);

  try {
    trackedKeys.forEach((key) => {
      window.localStorage.removeItem(key);
    });

    serializedEntries.forEach(([key, serialized]) => {
      window.localStorage.setItem(key, serialized);
    });
  } catch (error) {
    const rolledBack = rollbackTrackedStorageValues(previousSnapshot);
    const message = getStorageErrorMessage(
      error,
      rolledBack
        ? "Backup restore failed. Your previous local data was restored."
        : "Backup restore failed and rollback could not fully complete. Use your latest export if anything looks wrong.",
    );
    warnStorageError(message, error);

    return {
      valid: false,
      error: message,
      rolledBack,
    };
  }

  return {
    ...validation,
    restoredKeys: validation.recognizedKeys,
  };
}

export function resetLocalAppData() {
  if (typeof window === "undefined") {
    return { ok: false, error: "Local storage is not available." };
  }

  try {
    getTrackedStorageKeys().forEach((key) => {
      window.localStorage.removeItem(key);
    });

    return { ok: true };
  } catch (error) {
    const message = getStorageErrorMessage(error, "Could not reset local app data.");
    warnStorageError(message, error);
    return { ok: false, error: message };
  }
}

export function useLocalStorageState(key, fallbackValue) {
  const [value, setValue] = useState(() => readStorage(key, fallbackValue));

  useEffect(() => {
    writeStorage(key, value);
  }, [key, value]);

  return [value, setValue];
}
