// The collections a client may sync (decision H6-4). This is the server's own
// copy of the syncable names of getSyncableCollections() in
// src/lib/repository.js: server/ never imports src/, and
// scripts/verify-server-contract.mjs fails when the two lists differ.

export const SYNCABLE_COLLECTIONS = Object.freeze([
  "sessions",
  "nextPlans",
  "setupCues",
  "readinessByDate",
  "workoutDrafts",
  "programs",
  "programDays",
  "programSections",
  "exerciseLibrary",
  "programExercises",
  "baselines",
  "programStates",
  "programProgressions",
  "programDrafts",
  "programOverrides",
]);

const syncable = new Set(SYNCABLE_COLLECTIONS);

export function isSyncableCollection(name) {
  return typeof name === "string" && syncable.has(name);
}
