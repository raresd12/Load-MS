// ---------------------------------------------------------------------------
// When the private sync runs (decisions H6-11, H6-24, H6-25). Pure: the
// engine, the write subscription, the window / document / navigator stand-ins
// and the timers are injected, so scripts/verify-ui-h6-account.mjs drives it
// with fakes. The browser wiring is in syncController.js.
//
// Triggers: "launch", "write" (4 s after the last user write), "focus",
// "visible", "online", "interval" (5 min, only while visible), "retry"
// (the back-off timer) and "manual" (Sync now). No request is ever made
// without a token and a linked device, or while the browser says it is
// offline.
// ---------------------------------------------------------------------------

export const SYNC_WRITE_DELAY_MS = 4000;
export const SYNC_INTERVAL_MS = 300000;
// Focus, visibility and the interval do not sync again sooner than this
// after the last attempt (H6-25): switching apps mid-workout is not a sync.
export const SYNC_PASSIVE_GAP_MS = 10000;
// Another tab held the sync lock: look again shortly, so "Syncing in another
// tab" does not stay on screen after that tab has finished.
export const SYNC_BUSY_RECHECK_MS = 15000;

const PASSIVE_REASONS = new Set(["focus", "visible", "interval"]);

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  };
}

/**
 * createSyncScheduler({ engine, subscribeWrites, windowLike, documentLike,
 *   navigatorLike, timers, clock })
 * -> { start(), stop(), run(reason, { confirmMassDelete, restoreDeletes }), subscribe(listener),
 *      getSnapshot() }
 * getSnapshot() -> { status: engine.status(), lastResult, online }
 */
export function createSyncScheduler({
  engine,
  subscribeWrites,
  windowLike = null,
  documentLike = null,
  navigatorLike = null,
  timers = defaultTimers(),
  clock = () => Date.now(),
} = {}) {
  const listeners = new Set();
  const cleanups = [];
  let started = false;
  let writeTimer = null;
  let retryTimer = null;
  let intervalId = null;
  let lastAttemptAt = null;
  let lastResult = null;
  let inFlight = null;
  // A write timer fired while a sync was running: that sync may not carry the
  // write (the engine skips records edited mid-sync), so one more "write"
  // attempt follows it (decision H6-45).
  let writeAfterRun = false;

  const isOnline = () => navigatorLike?.onLine !== false;
  const isVisible = () => !documentLike || documentLike.visibilityState !== "hidden";

  function getSnapshot() {
    return { status: engine.status(), lastResult, online: isOnline() };
  }

  function notify() {
    const snapshot = getSnapshot();

    [...listeners].forEach((listener) => {
      try {
        listener(snapshot);
      } catch {
        // A listener that throws never stops the sync or the other listeners.
      }
    });
  }

  function clearRetry() {
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(delayMs) {
    clearRetry();

    if (!started || !(delayMs > 0)) {
      return;
    }

    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      run("retry");
    }, delayMs);
  }

  function skip(status) {
    return { status, skipped: true };
  }

  async function attempt(reason, options) {
    const before = engine.status();

    if (!before.signedIn || !before.linked) {
      notify();
      return skip(before.signedIn ? "needs-link" : "signed-out");
    }

    if (!isOnline()) {
      lastResult = { status: "offline", skipped: true, waiting: before.waiting };
      notify();
      return lastResult;
    }

    const manual = reason === "manual";
    const since = lastAttemptAt === null ? Infinity : clock() - lastAttemptAt;

    if (!manual && reason !== "online" && before.failures > 0 && since < before.retryDelayMs) {
      // Back-off (decision H6-11): wait for the retry timer.
      scheduleRetry(before.retryDelayMs - since);
      return skip("deferred");
    }

    if (PASSIVE_REASONS.has(reason) && since < SYNC_PASSIVE_GAP_MS) {
      return skip("deferred");
    }

    if (reason === "write") {
      // A write that changed nothing to send (the App mirroring a pull, a
      // device-only key) is not a sync (H6-25).
      const waiting = await engine.refreshWaiting();

      if (waiting === 0) {
        notify();
        return skip("idle");
      }
    }

    lastAttemptAt = clock();
    clearRetry();
    const running = engine.syncNow({
      confirmMassDelete: Boolean(options?.confirmMassDelete),
      restoreDeletes: Boolean(options?.restoreDeletes),
    });
    notify();
    const result = await running;

    if (result?.status !== "busy") {
      lastResult = result;
    }

    if (result?.status === "offline" || result?.status === "error") {
      scheduleRetry(engine.status().retryDelayMs);
    } else if (result?.status === "busy") {
      scheduleRetry(SYNC_BUSY_RECHECK_MS);
    }

    notify();
    return result;
  }

  /**
   * One sync attempt. Calls made while one runs share its promise; a "write"
   * among them also runs once more after it (it asks refreshWaiting first, so
   * nothing is sent when the running sync already carried the write).
   */
  function run(reason = "manual", options = {}) {
    if (inFlight) {
      if (reason === "write") {
        writeAfterRun = true;
      }

      return inFlight;
    }

    inFlight = attempt(reason, options).finally(() => {
      inFlight = null;

      if (writeAfterRun) {
        writeAfterRun = false;

        if (started) {
          run("write");
        }
      }
    });

    return inFlight;
  }

  function onWrite(event) {
    if (event?.reason === "sync") {
      return;
    }

    if (event?.reason === "reset" || event?.reason === "restore") {
      // A reset signs out and a restore unlinks (decision H6-10).
      lastResult = null;
      clearRetry();
      notify();
      return;
    }

    if (writeTimer !== null) {
      timers.clearTimeout(writeTimer);
    }

    writeTimer = timers.setTimeout(() => {
      writeTimer = null;
      run("write");
    }, SYNC_WRITE_DELAY_MS);
  }

  function listen(target, type, handler) {
    if (target && typeof target.addEventListener === "function") {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    }
  }

  function start() {
    if (started) {
      return;
    }

    started = true;

    if (typeof subscribeWrites === "function") {
      cleanups.push(subscribeWrites(onWrite));
    }

    listen(windowLike, "online", () => run("online"));
    listen(windowLike, "offline", () => notify());
    listen(windowLike, "focus", () => run("focus"));
    listen(documentLike, "visibilitychange", () => {
      if (isVisible()) {
        run("visible");
      }
    });
    intervalId = timers.setInterval(() => {
      if (isVisible()) {
        run("interval");
      }
    }, SYNC_INTERVAL_MS);
  }

  function stop() {
    started = false;
    writeAfterRun = false;
    cleanups.splice(0).forEach((cleanup) => {
      try {
        cleanup?.();
      } catch {
        // Nothing to undo.
      }
    });

    if (writeTimer !== null) {
      timers.clearTimeout(writeTimer);
      writeTimer = null;
    }

    if (intervalId !== null) {
      timers.clearInterval(intervalId);
      intervalId = null;
    }

    clearRetry();
  }

  function subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    listeners.add(listener);

    // The current snapshot at once: a run that ended between the caller
    // reading getSnapshot() and subscribing would otherwise leave it showing
    // "Syncing..." until the next notify (decision H6-48).
    try {
      listener(getSnapshot());
    } catch {
      // A listener that throws never stops the subscription.
    }

    return () => listeners.delete(listener);
  }

  /** Clears the remembered result (after sign-out, link or delete). */
  function reset() {
    lastResult = null;
    lastAttemptAt = null;
    clearRetry();
    notify();
  }

  return { start, stop, run, subscribe, getSnapshot, notify, reset };
}
