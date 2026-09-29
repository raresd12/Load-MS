// Phase H4 Track A: buildSaveErrorMessage / buildStorageWarnings moved
// verbatim from src/App.jsx into src/lib/storage.js. Pins the user-facing
// copy for a quota failure, an unreadable key (new-U) and a plain refused
// write, and the storage warning list (new-G / F2) including the hook
// statuses that are already covered by a read-corrupt warning.
import assert from "node:assert/strict";

const { STORAGE_ISSUE_KINDS, STORAGE_KEYS, buildSaveErrorMessage, buildStorageWarnings } =
  await import("../src/lib/storage.js");

// ---------------------------------------------------------------------------
// Save error message
// ---------------------------------------------------------------------------
assert.deepEqual(buildSaveErrorMessage({ ok: false, code: "quota", error: "QuotaExceededError" }), {
  code: "quota",
  title: "Workout not saved - storage is full.",
  message: "Your draft is kept. Export a backup in Settings, delete old data, then press Save Workout again.",
  detail: "QuotaExceededError",
});
assert.deepEqual(buildSaveErrorMessage({ ok: false, code: "corrupt", error: " unreadable ", failedKey: STORAGE_KEYS.sessions }), {
  code: "corrupt",
  title: "Workout not saved - stored data could not be read.",
  message: `Your draft is kept. Saving would overwrite the unreadable data under "${STORAGE_KEYS.sessions}". Use the storage warning at the top to restore a backup or discard that data, then press Save Workout again.`,
  detail: "unreadable",
});
assert.equal(
  buildSaveErrorMessage({ code: "corrupt" }).message.includes('under "a storage key"'),
  true,
  "a missing failedKey still reads as a sentence",
);
assert.deepEqual(buildSaveErrorMessage({ ok: false, code: "write", error: "SecurityError" }), {
  code: "write",
  title: "Workout not saved.",
  message: "The browser refused the write (SecurityError). Your draft is kept - try again, and export a backup in Settings if this repeats.",
  detail: "SecurityError",
});
assert.deepEqual(buildSaveErrorMessage({ ok: false }), {
  code: "write",
  title: "Workout not saved.",
  message: "The browser refused the write. Your draft is kept - try again, and export a backup in Settings if this repeats.",
  detail: "",
});
assert.equal(buildSaveErrorMessage(null).code, "write");
assert.equal(buildSaveErrorMessage({ code: "serialize", error: "cycle" }).code, "serialize");

// ---------------------------------------------------------------------------
// Storage warnings
// ---------------------------------------------------------------------------
{
  const issues = [
    { key: STORAGE_KEYS.sessions, kind: STORAGE_ISSUE_KINDS.readCorrupt, message: "Unexpected token", at: "2026-09-26T10:00:00.000Z", corruptCopyKey: `${STORAGE_KEYS.sessions}.corrupt-1` },
    { key: STORAGE_KEYS.nextPlans, kind: STORAGE_ISSUE_KINDS.quota, message: "full", at: "2026-09-26T10:01:00.000Z" },
    { key: STORAGE_KEYS.readinessByDate, kind: STORAGE_ISSUE_KINDS.writeFailed, message: "SecurityError", at: "2026-09-26T10:02:00.000Z" },
    { key: STORAGE_KEYS.setupCues, kind: STORAGE_ISSUE_KINDS.writeFailed, message: "", at: "2026-09-26T10:03:00.000Z" },
  ];
  const hookStatuses = [
    { key: STORAGE_KEYS.sessions, status: { lastWriteOk: false, lastWriteError: "refused" } },
    { key: STORAGE_KEYS.nextPlans, status: { lastWriteOk: true } },
    { key: STORAGE_KEYS.workoutDrafts, status: { lastWriteOk: false, lastWriteError: "QuotaExceededError" } },
    { key: STORAGE_KEYS.appUiState, status: { lastWriteOk: false } },
    { key: STORAGE_KEYS.programs, status: null },
  ];
  const warnings = buildStorageWarnings({ storageIssues: issues, hookStatuses });

  assert.deepEqual(warnings.map((warning) => warning.id), [
    `issue|${STORAGE_KEYS.sessions}|read-corrupt|2026-09-26T10:00:00.000Z`,
    `issue|${STORAGE_KEYS.nextPlans}|quota|2026-09-26T10:01:00.000Z`,
    `issue|${STORAGE_KEYS.readinessByDate}|write-failed|2026-09-26T10:02:00.000Z`,
    `issue|${STORAGE_KEYS.setupCues}|write-failed|2026-09-26T10:03:00.000Z`,
    `hook|${STORAGE_KEYS.workoutDrafts}|QuotaExceededError`,
    `hook|${STORAGE_KEYS.appUiState}|`,
  ], "issues first, then hook failures not already covered by an issue of that key; ok hooks and null statuses skipped");

  assert.deepEqual(warnings[0], {
    id: `issue|${STORAGE_KEYS.sessions}|read-corrupt|2026-09-26T10:00:00.000Z`,
    key: STORAGE_KEYS.sessions,
    kind: "read-corrupt",
    fromIssue: true,
    corruptCopyKey: `${STORAGE_KEYS.sessions}.corrupt-1`,
    title: "Stored data could not be read",
    canDiscard: true,
    message: `The data under "${STORAGE_KEYS.sessions}" is not valid JSON, so the app is using defaults for it. The original was kept as "${STORAGE_KEYS.sessions}.corrupt-1". Nothing was overwritten, and nothing will be saved over it until you restore a backup or discard it.`,
  });
  assert.equal(warnings[1].title, "Browser storage is full");
  assert.equal(warnings[1].canDiscard, false);
  assert.equal(warnings[1].corruptCopyKey, null);
  assert.equal(warnings[1].message, `Saving "${STORAGE_KEYS.nextPlans}" failed because storage is full. Export a backup in Settings and delete old data before logging more.`);
  assert.equal(warnings[2].title, "A save failed");
  assert.equal(warnings[2].message, `Saving "${STORAGE_KEYS.readinessByDate}" failed: SecurityError Recent changes may not be on disk - export a backup in Settings.`);
  assert.equal(warnings[3].message, `Saving "${STORAGE_KEYS.setupCues}" failed. Recent changes may not be on disk - export a backup in Settings.`);
  assert.deepEqual(warnings[4], {
    id: `hook|${STORAGE_KEYS.workoutDrafts}|QuotaExceededError`,
    key: STORAGE_KEYS.workoutDrafts,
    kind: "write-failed",
    fromIssue: false,
    corruptCopyKey: null,
    title: "A save failed",
    message: `The latest change to "${STORAGE_KEYS.workoutDrafts}" was not written: QuotaExceededError Export a backup in Settings before continuing.`,
  });
  assert.equal(warnings[5].message, `The latest change to "${STORAGE_KEYS.appUiState}" was not written. Export a backup in Settings before continuing.`);

  // A read-corrupt issue without a copy key has a shorter message.
  const noCopy = buildStorageWarnings({ storageIssues: [{ key: "k", kind: STORAGE_ISSUE_KINDS.readCorrupt, at: "t" }], hookStatuses: [] });
  assert.equal(noCopy[0].corruptCopyKey, null);
  assert.equal(noCopy[0].message, 'The data under "k" is not valid JSON, so the app is using defaults for it. Nothing was overwritten, and nothing will be saved over it until you restore a backup or discard it.');

  assert.deepEqual(buildStorageWarnings({ storageIssues: [], hookStatuses: [] }), []);
  assert.deepEqual(buildStorageWarnings({}), []);
}

console.log("Storage H4 messages verification passed.");
