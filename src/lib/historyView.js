// History page view model (H4 fix round 3, decision H4-15). Moved from
// src/pages/HistoryPage.jsx: the per-session summary the History card shows,
// built from whatever shape the saved session has (workoutSets, keyed
// exercises, legacy arrays, legacy note fields), so old sessions stay readable.
// The only non-verbatim edit: the readiness label comes from
// sessionAnalytics.js (same "Green" / "Yellow" / "Red" strings as the UI copy)
// so this module does not import a component file.
// Fixture: scripts/verify-history-view.mjs.
import { getPrograms } from "./programStorage.js";
import { interpretWellness } from "./progression.js";
import {
  average,
  formatKg,
  getReadinessStatusLabel,
  getSessionSetRecords,
} from "./sessionAnalytics.js";
import { numberValue } from "./sessionNormalize.js";

export function buildHistorySessionSummary(session, exerciseLookup) {
  const setRecords = getSessionSetRecords(session, exerciseLookup);
  const loggedSets = setRecords.filter(isHistoryLoggedSet);
  const exerciseGroups = buildHistoryExerciseGroups(loggedSets);
  const readiness = getHistoryReadiness(session);
  const sessionRpe = numberValue(session.sessionRpe, null);
  const totalVolume = sumHistoryVolume(loggedSets);

  return {
    dayName: session.dayName ?? loggedSets[0]?.dayName ?? "Workout",
    dayFocus: session.dayFocus ?? session.focus ?? loggedSets[0]?.dayFocus ?? "",
    programName: session.programName ?? resolveHistoryProgramName(session, loggedSets) ?? "No program saved",
    readinessLabel: readiness ? formatHistoryReadiness(readiness) : "No data",
    sessionRpe,
    exerciseCount: exerciseGroups.length || getLegacyExerciseCount(session),
    setCount: loggedSets.length || numberValue(session.analytics?.loggedSetCount, 0),
    totalVolume,
    exerciseGroups,
    notes: getHistorySessionNotes(session),
    schemaLabel: session.schemaVersion ? `v${session.schemaVersion}` : "legacy",
  };
}

// H5 fix round 1 (decision H5-10 applied to History): the card's volume is
// the measurement-aware tonnage of the set record (per dumbbell x2, per
// side x2; BW, timed and distance sets add nothing), the same number as
// Progress, the recap, the Dashboard and the records. A record without the
// H5 `tonnage` field falls back to the as-logged kg x reps.
function getHistorySetVolume(set) {
  if (Object.prototype.hasOwnProperty.call(set, "tonnage")) {
    return Number.isFinite(set.tonnage) ? set.tonnage : 0;
  }

  return typeof set.weight === "number" && Number.isFinite(set.reps) ? set.weight * set.reps : 0;
}

function sumHistoryVolume(sets) {
  return sets.reduce((total, set) => total + getHistorySetVolume(set), 0);
}

export function buildHistoryExerciseGroups(setRecords) {
  const groups = new Map();

  setRecords.forEach((set) => {
    const key = set.exerciseKey ?? set.programExerciseId ?? set.exerciseId ?? set.exerciseName;
    const group = groups.get(key) ?? {
      key,
      name: set.exerciseName ?? "Exercise",
      programExerciseId: set.programExerciseId ?? null,
      exerciseId: set.exerciseId ?? null,
      sets: [],
      totalVolume: 0,
      averageRpe: null,
    };

    group.sets.push(set);
    groups.set(key, group);
  });

  return [...groups.values()].map((group) => {
    const rpes = group.sets.map((set) => set.rpe).filter(Number.isFinite);

    return {
      ...group,
      sets: group.sets.sort((left, right) => (left.setNumber ?? 0) - (right.setNumber ?? 0)),
      totalVolume: sumHistoryVolume(group.sets),
      averageRpe: average(rpes),
    };
  });
}

export function isHistoryLoggedSet(set) {
  return (
    set.completed ||
    Number.isFinite(set.reps) ||
    set.weight !== null ||
    Number.isFinite(set.rpe)
  );
}

export function getHistoryReadiness(session) {
  if (session.readiness) {
    return session.readiness;
  }

  if (session.readinessSnapshot?.readiness) {
    return session.readinessSnapshot.readiness;
  }

  if (session.wellness) {
    return interpretWellness(session.wellness);
  }

  return null;
}

export function getHistorySessionNotes(session) {
  const legacyExerciseNotes = Array.isArray(session.exercises)
    ? session.exercises.map((exercise) => exercise?.notes)
    : Object.values(session.exercises ?? {}).map((exercise) => exercise?.notes);
  const notes = [
    session.sessionNotes,
    session.sessionNote,
    session.workoutNotes,
    session.workoutNote,
    session.notes,
    session.note,
    session.recoveryNotes,
    session.recoveryNote,
    ...legacyExerciseNotes,
  ]
    .flat()
    .map((note) => String(note ?? "").trim())
    .filter(Boolean);

  return [...new Set(notes)];
}

export function formatHistoryReadiness(readiness) {
  const averageText = Number.isFinite(readiness.averageScore)
    ? ` ${readiness.averageScore.toFixed(1)}`
    : "";

  return `${getReadinessStatusLabel(readiness)}${averageText}`;
}

export function resolveHistoryProgramName(session, setRecords) {
  const programSet = setRecords.find((set) => set.programId);
  const programId = session.programId ?? programSet?.programId;

  if (!programId) {
    return null;
  }

  // Archived programs keep their name in history (decision new-F).
  const program = getPrograms({ includeArchived: true }).find(
    (candidate) => candidate.id === programId,
  );
  return program?.nickname || program?.name || null;
}

export function getLegacyExerciseCount(session) {
  if (Number.isFinite(session.analytics?.exerciseCount)) {
    return session.analytics.exerciseCount;
  }

  if (Array.isArray(session.exercises)) {
    return session.exercises.length;
  }

  return Object.keys(session.exercises ?? {}).length;
}

export function formatHistoryDateTime(value) {
  if (!value) {
    return "No date";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "No date";
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatHistoryWeight(weight) {
  if (typeof weight === "number") {
    return formatKg(weight).replace(" kg", "kg");
  }

  if (weight === "BW") {
    return "BW";
  }

  return "-";
}
