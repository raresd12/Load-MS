// Local date keys, ids and the midnight rule (Phase H4, decision H4-2).
// Moved verbatim from src/App.jsx so the date behaviour has a Node fixture
// (scripts/verify-date.mjs). App.jsx keeps the React state and the timers;
// the decisions are here.

// The App resyncs `todayDateKey` on this cadence while it stays mounted, and
// on every window focus / visibilitychange. Every resync reads the clock
// unconditionally (getLocalDateKey is cheap and React ignores an unchanged
// key), so there is no "should I resync" helper.
export const DATE_KEY_RESYNC_INTERVAL_MS = 60000;

export function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function formatDateKey(dateKey) {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function createId() {
  // Same lookup as before H4 (window.crypto); the global fallback only
  // matters outside a browser (Node fixtures).
  const cryptoApi = typeof window !== "undefined" ? window.crypto : globalThis.crypto;

  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Decision H4-2: what a change of the local date key does to App state. This
 * is exactly what the `previousDateKeyRef` effect in App() did before H4:
 * when the key changes, the readiness draft is re-read for the new date, the
 * readiness save message and the post-workout recap are cleared, and the
 * workout draft is NEVER touched (resolveWorkoutDraftKey's 36 h window,
 * decision new-S, decides whether yesterday's draft is resumed).
 */
export function getDateRolloverAction(previousKey, nextKey) {
  const changed = Boolean(nextKey) && previousKey !== nextKey;

  return {
    changed,
    resetReadinessDraft: changed,
    resetReadinessSaveMessage: changed,
    resetRecap: changed,
    keepWorkoutDraft: true,
  };
}
