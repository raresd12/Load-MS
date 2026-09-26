/**
 * PWA update prompt policy (decision H2-16), kept out of main.jsx so the
 * behaviour has a Node fixture (scripts/verify-pwa-update.mjs):
 * - the banner state machine (`reducePwaUpdateState`): a waiting worker shows
 *   the banner, "Later" hides it until the next update is found, Reload marks
 *   the page as reloading and a failed activation clears that again;
 * - the update checks (`startPwaUpdateChecks`): `registration.update()` every
 *   UPDATE_CHECK_INTERVAL_MS and whenever the document becomes visible, both
 *   removed by `stop()`; a rejected update never throws;
 * - Reload (`requestPwaReload`): `updateServiceWorker(true)` when the
 *   registration handed one out, a plain page reload otherwise.
 * Nothing here touches localStorage: an in-progress workout draft survives
 * Reload and Later alike.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export const PWA_UPDATE_EVENTS = Object.freeze({
  needRefresh: "need-refresh",
  later: "later",
  reload: "reload",
  reloadFailed: "reload-failed",
});

export const INITIAL_PWA_UPDATE_STATE = Object.freeze({ needRefresh: false, isReloading: false });

export function reducePwaUpdateState(state = INITIAL_PWA_UPDATE_STATE, event) {
  const current = state ?? INITIAL_PWA_UPDATE_STATE;

  switch (event) {
    case PWA_UPDATE_EVENTS.needRefresh:
      return current.needRefresh ? current : { ...current, needRefresh: true };
    case PWA_UPDATE_EVENTS.later:
      // The banner disables Later while reloading; a late click changes nothing.
      return current.isReloading || !current.needRefresh ? current : { ...current, needRefresh: false };
    case PWA_UPDATE_EVENTS.reload:
      return current.isReloading ? current : { ...current, isReloading: true };
    case PWA_UPDATE_EVENTS.reloadFailed:
      return current.isReloading ? { ...current, isReloading: false } : current;
    default:
      return current;
  }
}

/**
 * Ask the browser for a new service worker on a schedule. Returns
 * `{ active, check, stop }`: `active` is false (and nothing is scheduled)
 * when the registration cannot be updated; `check()` runs one update check
 * now; `stop()` clears the interval and the visibility listener (idempotent).
 * `doc`, `setTimer` and `clearTimer` are injectable for fixtures.
 */
export function startPwaUpdateChecks({
  registration,
  doc = typeof document === "undefined" ? null : document,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  setTimer = (callback, ms) => setInterval(callback, ms),
  clearTimer = (id) => clearInterval(id),
} = {}) {
  if (!registration || typeof registration.update !== "function") {
    return { active: false, check: () => false, stop: () => {} };
  }

  const check = () => {
    try {
      const pending = registration.update();

      if (pending && typeof pending.catch === "function") {
        pending.catch(() => {});
      }
    } catch {
      // A failed check is retried on the next tick / visibility change.
    }

    return true;
  };

  const handleVisibilityChange = () => {
    if (!doc || doc.visibilityState === "visible") {
      check();
    }
  };

  const intervalId = setTimer(check, intervalMs);

  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("visibilitychange", handleVisibilityChange);
  }

  let stopped = false;

  return {
    active: true,
    check,
    stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      clearTimer(intervalId);

      if (doc && typeof doc.removeEventListener === "function") {
        doc.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    },
  };
}

/**
 * The banner's Reload. Resolves to `{ ok, viaServiceWorker, error }`:
 * `updateServiceWorker(true)` activates the waiting worker and reloads once it
 * takes control; when the registration gave no updater the page is reloaded
 * directly. A rejected activation resolves `ok: false` (never throws) so the
 * caller can leave the reloading state.
 */
export function requestPwaReload({ updateServiceWorker, reloadPage }) {
  if (typeof updateServiceWorker !== "function") {
    if (typeof reloadPage === "function") {
      reloadPage();
    }

    return Promise.resolve({ ok: true, viaServiceWorker: false, error: null });
  }

  return Promise.resolve()
    .then(() => updateServiceWorker(true))
    .then(
      () => ({ ok: true, viaServiceWorker: true, error: null }),
      (error) => ({ ok: false, viaServiceWorker: true, error: error?.message || "Update failed." }),
    );
}
