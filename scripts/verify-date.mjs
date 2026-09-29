// Phase H4 Track A: src/lib/date.js (moved from src/App.jsx) and the midnight
// rule made explicit (decision H4-2).
// - getLocalDateKey is the LOCAL calendar date, never the UTC date.
// - getDateRolloverAction encodes what the App effect does on a key change:
//   readiness draft / save message / recap reset, workout draft kept.
// - DATE_KEY_RESYNC_INTERVAL_MS is the 60 s cadence; App resyncs unconditionally
//   on the timer, focus and visibilitychange (no unused cadence helper).
// - A session logged at 23:59 is still the draft the log opens at 00:01
//   (resolveWorkoutDraftKey, decision new-S), while an empty draft rolls over.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A UTC+3 clock (Bucharest in September = EEST) so local and UTC dates differ
// around midnight. Node re-reads TZ when it is set before the first Date use.
process.env.TZ = "Europe/Bucharest";

const {
  DATE_KEY_RESYNC_INTERVAL_MS,
  createId,
  formatDateKey,
  getDateRolloverAction,
  getLocalDateKey,
} = await import("../src/lib/date.js");
const dateModule = await import("../src/lib/date.js");
const { getWorkoutDraftKey, resolveWorkoutDraftKey } = await import("../src/lib/workoutDraft.js");

assert.equal(new Date("2026-09-26T21:30:00Z").getTimezoneOffset(), -180, "fixture runs on a UTC+3 clock");

// ---------------------------------------------------------------------------
// Local vs UTC boundary
// ---------------------------------------------------------------------------
{
  // 23:30 local on the 26th is 20:30 UTC on the 26th: both agree.
  const lateEvening = new Date("2026-09-26T20:30:00Z");
  assert.equal(getLocalDateKey(lateEvening), "2026-09-26");
  assert.equal(lateEvening.toISOString().slice(0, 10), "2026-09-26");

  // 00:30 local on the 27th is still 21:30 UTC on the 26th: the key is LOCAL.
  const justAfterMidnight = new Date("2026-09-26T21:30:00Z");
  assert.equal(getLocalDateKey(justAfterMidnight), "2026-09-27", "local date, not UTC date");
  assert.equal(justAfterMidnight.toISOString().slice(0, 10), "2026-09-26", "UTC would still say the 26th");

  // 23:59:59 local on the 26th.
  assert.equal(getLocalDateKey(new Date(2026, 8, 26, 23, 59, 59)), "2026-09-26");
  assert.equal(getLocalDateKey(new Date(2026, 8, 27, 0, 0, 0)), "2026-09-27");

  // Leap day and zero padding.
  assert.equal(getLocalDateKey(new Date(2024, 1, 29, 12)), "2024-02-29");
  assert.equal(getLocalDateKey(new Date(2024, 1, 29, 23, 59)), "2024-02-29");
  assert.equal(getLocalDateKey(new Date(2024, 2, 1, 0, 0)), "2024-03-01");
  assert.equal(getLocalDateKey(new Date(2026, 0, 5)), "2026-01-05", "month and day are zero padded");

  // Default argument = now (only the shape is pinned).
  assert.match(getLocalDateKey(), /^\d{4}-\d{2}-\d{2}$/);
}

// formatDateKey reads the key as a local midnight (no UTC shift to the previous day).
{
  const text = formatDateKey("2026-09-27");
  assert.equal(typeof text, "string");
  assert.ok(text.includes("27"), `formatDateKey keeps the local day (${text})`);
  assert.ok(text.includes("2026"), `formatDateKey shows the year (${text})`);
}

// ---------------------------------------------------------------------------
// createId
// ---------------------------------------------------------------------------
{
  const id = createId();
  assert.equal(typeof id, "string");
  assert.match(id, /^[0-9a-f-]{36}$/, "Node has crypto.randomUUID");
  assert.notEqual(createId(), id);

  // Browser without randomUUID: legacy fallback prefix.
  globalThis.window = { crypto: {} };
  try {
    assert.match(createId(), /^session-\d+-[0-9a-f]+$/);
  } finally {
    delete globalThis.window;
  }
}

// ---------------------------------------------------------------------------
// Rollover action table (decision H4-2)
// ---------------------------------------------------------------------------
{
  const unchanged = getDateRolloverAction("2026-09-26", "2026-09-26");
  assert.deepEqual(unchanged, {
    changed: false,
    resetReadinessDraft: false,
    resetReadinessSaveMessage: false,
    resetRecap: false,
    keepWorkoutDraft: true,
  });

  const rolled = getDateRolloverAction("2026-09-26", "2026-09-27");
  assert.deepEqual(rolled, {
    changed: true,
    resetReadinessDraft: true,
    resetReadinessSaveMessage: true,
    resetRecap: true,
    keepWorkoutDraft: true,
  });

  // A clock that went backwards (device time fix) is a change too: readiness
  // follows whatever the clock says, the workout draft is still never touched.
  assert.equal(getDateRolloverAction("2026-09-27", "2026-09-26").changed, true);
  assert.equal(getDateRolloverAction("2026-09-27", "2026-09-26").keepWorkoutDraft, true);

  // Mount (no previous key) counts as a change; a missing next key never does.
  assert.equal(getDateRolloverAction(null, "2026-09-27").changed, true);
  assert.equal(getDateRolloverAction("2026-09-27", null).changed, false);
  assert.equal(getDateRolloverAction("2026-09-27", "").changed, false);
}

// ---------------------------------------------------------------------------
// Resync cadence
// ---------------------------------------------------------------------------
{
  assert.equal(DATE_KEY_RESYNC_INTERVAL_MS, 60000, "App resyncs every 60 s");
  // H4 fix round 1: the cadence helper nothing called is gone; the App effect
  // is the only place that decides when to read the clock, and it does so on
  // every tick / focus / visibilitychange.
  assert.equal("shouldResyncDateKey" in dateModule, false, "no unused cadence helper is exported");
  const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.ok(
    appSource.includes("window.setInterval(syncTodayDateKey, DATE_KEY_RESYNC_INTERVAL_MS)"),
    "the App timer uses the cadence constant",
  );
  assert.ok(appSource.includes('window.addEventListener("focus", syncTodayDateKey)'));
  assert.ok(appSource.includes('document.addEventListener("visibilitychange", syncTodayDateKey)'));
}

// ---------------------------------------------------------------------------
// 23:59 session, 00:01 draft: the logged draft survives the rollover
// ---------------------------------------------------------------------------
{
  const programId = "program-a";
  const dayId = "day-1";
  const beforeMidnight = new Date("2026-09-26T23:59:00+03:00");
  const afterMidnight = new Date("2026-09-27T00:01:00+03:00");
  const keyBefore = getLocalDateKey(beforeMidnight);
  const keyAfter = getLocalDateKey(afterMidnight);
  assert.equal(keyBefore, "2026-09-26");
  assert.equal(keyAfter, "2026-09-27");
  assert.equal(getDateRolloverAction(keyBefore, keyAfter).changed, true);

  const loggedDraft = {
    exercises: {
      "pe-bench": {
        notes: "",
        painFlag: false,
        sets: [
          { reps: 5, weight: 80, rpe: 8 },
          { reps: "", weight: "", rpe: "" },
        ],
      },
    },
    wellness: { sleep: 3 },
    recoveryActivities: {},
    recoveryNotes: "",
    sessionRpe: "",
    sessionNotes: "",
  };
  const draftKeyBefore = getWorkoutDraftKey(programId, dayId, keyBefore);
  const workoutDrafts = {
    [draftKeyBefore]: {
      programId,
      dayId,
      date: keyBefore,
      status: "in-progress",
      updatedAt: beforeMidnight.toISOString(),
      draft: loggedDraft,
    },
  };

  const resumed = resolveWorkoutDraftKey({
    workoutDrafts,
    programId,
    dayId,
    todayDateKey: keyAfter,
    now: afterMidnight.getTime(),
  });
  assert.equal(resumed.key, draftKeyBefore, "the logged draft of the 26th is the one the log opens at 00:01");
  assert.equal(resumed.dateKey, keyBefore);
  assert.equal(resumed.resumedFromDateKey, keyBefore);
  assert.deepEqual(workoutDrafts[resumed.key].draft, loggedDraft, "nothing about the draft changed");

  // An EMPTY draft from the 26th rolls over: the log opens today's key.
  const emptyDrafts = {
    [draftKeyBefore]: {
      ...workoutDrafts[draftKeyBefore],
      draft: { ...loggedDraft, exercises: { "pe-bench": { notes: "", painFlag: false, sets: [{ reps: "", weight: "", rpe: "" }] } } },
    },
  };
  const rolledOver = resolveWorkoutDraftKey({
    workoutDrafts: emptyDrafts,
    programId,
    dayId,
    todayDateKey: keyAfter,
    now: afterMidnight.getTime(),
  });
  assert.equal(rolledOver.key, getWorkoutDraftKey(programId, dayId, keyAfter));
  assert.equal(rolledOver.resumedFromDateKey, null);

  // Outside the 36 h window the old logged draft is left alone under its key.
  const twoDaysLater = new Date("2026-09-28T13:00:00+03:00");
  const stale = resolveWorkoutDraftKey({
    workoutDrafts,
    programId,
    dayId,
    todayDateKey: getLocalDateKey(twoDaysLater),
    now: twoDaysLater.getTime(),
  });
  assert.equal(stale.key, getWorkoutDraftKey(programId, dayId, "2026-09-28"));
  assert.ok(workoutDrafts[draftKeyBefore], "the stale draft is not removed by the resolver");
}

console.log("Date / midnight verification passed.");
