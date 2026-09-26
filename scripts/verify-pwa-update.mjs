// PWA update prompt policy (decision H2-16), src/lib/pwaUpdate.js:
// - banner state: a waiting worker shows the banner, Later hides it until the
//   next update is found, Reload marks the page reloading (Later ignored),
//   a failed activation leaves the reloading state and keeps the banner;
// - update checks: registration.update() every hour and whenever the
//   document becomes visible (not when hidden), both removed by stop();
//   a rejected / throwing update() never surfaces; no registration -> no
//   timer, no listener;
// - Reload: updateServiceWorker(true) when available, plain page reload
//   otherwise; a rejected activation resolves ok:false instead of throwing.
// Nothing in the module touches localStorage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  INITIAL_PWA_UPDATE_STATE,
  PWA_UPDATE_EVENTS,
  reducePwaUpdateState,
  requestPwaReload,
  startPwaUpdateChecks,
  UPDATE_CHECK_INTERVAL_MS,
} = await import("../src/lib/pwaUpdate.js");

class FakeDocument {
  constructor() {
    this.visibilityState = "visible";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }

  emit(type) {
    (this.listeners.get(type) ?? []).forEach((listener) => listener({ type }));
  }

  count(type) {
    return (this.listeners.get(type) ?? []).length;
  }
}

class FakeTimers {
  constructor() {
    this.intervals = new Map();
    this.nextId = 1;
  }

  set(callback, ms) {
    const id = this.nextId;
    this.nextId += 1;
    this.intervals.set(id, { callback, ms });
    return id;
  }

  clear(id) {
    this.intervals.delete(id);
  }

  tick() {
    [...this.intervals.values()].forEach((entry) => entry.callback());
  }
}

try {
  // ------------------------------------------------------------------
  // Banner state machine
  // ------------------------------------------------------------------
  const E = PWA_UPDATE_EVENTS;
  assert.deepEqual(INITIAL_PWA_UPDATE_STATE, { needRefresh: false, isReloading: false });
  const shown = reducePwaUpdateState(INITIAL_PWA_UPDATE_STATE, E.needRefresh);
  assert.deepEqual(shown, { needRefresh: true, isReloading: false }, "a waiting worker shows the banner");
  assert.equal(reducePwaUpdateState(shown, E.needRefresh), shown, "same state object when nothing changes");
  const later = reducePwaUpdateState(shown, E.later);
  assert.deepEqual(later, { needRefresh: false, isReloading: false }, "Later hides the banner");
  assert.deepEqual(reducePwaUpdateState(later, E.needRefresh), shown, "the next update found shows it again");
  assert.equal(reducePwaUpdateState(INITIAL_PWA_UPDATE_STATE, E.later), INITIAL_PWA_UPDATE_STATE, "Later without a banner is a no-op");
  const reloading = reducePwaUpdateState(shown, E.reload);
  assert.deepEqual(reloading, { needRefresh: true, isReloading: true }, "Reload keeps the banner (spinner) while activating");
  assert.equal(reducePwaUpdateState(reloading, E.later), reloading, "Later is ignored while reloading");
  assert.equal(reducePwaUpdateState(reloading, E.reload), reloading);
  assert.deepEqual(reducePwaUpdateState(reloading, E.reloadFailed), shown, "a failed activation returns to the banner, not to a stuck spinner");
  assert.equal(reducePwaUpdateState(shown, E.reloadFailed), shown, "reload-failed without a reload is a no-op");
  assert.equal(reducePwaUpdateState(shown, "unknown-event"), shown, "unknown events change nothing");
  assert.deepEqual(reducePwaUpdateState(undefined, E.needRefresh), shown, "missing state starts from the initial state");

  // ------------------------------------------------------------------
  // Update checks: hourly + visibilitychange (visible only), stop() removes both
  // ------------------------------------------------------------------
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 60 * 60 * 1000, "hourly");
  const doc = new FakeDocument();
  const timers = new FakeTimers();
  let updateCalls = 0;
  let rejectNext = false;
  let throwNext = false;
  const registration = {
    update() {
      updateCalls += 1;

      if (throwNext) {
        throwNext = false;
        throw new Error("update threw");
      }

      if (rejectNext) {
        rejectNext = false;
        return Promise.reject(new Error("update rejected"));
      }

      return Promise.resolve();
    },
  };
  const checks = startPwaUpdateChecks({
    registration,
    doc,
    setTimer: (callback, ms) => timers.set(callback, ms),
    clearTimer: (id) => timers.clear(id),
  });
  assert.equal(checks.active, true);
  assert.equal(updateCalls, 0, "starting the checks does not check at once (registerSW immediate does the first one)");
  assert.equal(timers.intervals.size, 1, "one interval");
  assert.equal([...timers.intervals.values()][0].ms, UPDATE_CHECK_INTERVAL_MS, "scheduled hourly");
  assert.equal(doc.count("visibilitychange"), 1, "one visibility listener");

  timers.tick();
  assert.equal(updateCalls, 1, "the interval asks for an update");
  doc.visibilityState = "hidden";
  doc.emit("visibilitychange");
  assert.equal(updateCalls, 1, "going hidden does not check");
  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  assert.equal(updateCalls, 2, "coming back to the foreground checks");
  rejectNext = true;
  assert.equal(checks.check(), true, "a manual check runs");
  assert.equal(updateCalls, 3);
  await new Promise((resolve) => setTimeout(resolve, 0));
  throwNext = true;
  assert.doesNotThrow(() => timers.tick(), "a throwing update() is swallowed");
  assert.equal(updateCalls, 4);

  checks.stop();
  assert.equal(timers.intervals.size, 0, "stop clears the interval");
  assert.equal(doc.count("visibilitychange"), 0, "stop removes the listener");
  timers.tick();
  doc.emit("visibilitychange");
  assert.equal(updateCalls, 4, "nothing runs after stop");
  assert.doesNotThrow(() => checks.stop(), "stop is idempotent");

  // Default document: a hidden document (from the effect's point of view a
  // missing doc) still allows the interval; visibility gating needs a doc.
  const noDoc = startPwaUpdateChecks({ registration, doc: null, setTimer: (cb, ms) => timers.set(cb, ms), clearTimer: (id) => timers.clear(id) });
  assert.equal(noDoc.active, true);
  assert.equal(timers.intervals.size, 1);
  noDoc.stop();
  assert.equal(timers.intervals.size, 0);

  // No usable registration -> inert handle, no timer, no listener.
  [null, undefined, {}, { update: "nope" }].forEach((value) => {
    const inert = startPwaUpdateChecks({ registration: value, doc, setTimer: (cb, ms) => timers.set(cb, ms), clearTimer: (id) => timers.clear(id) });
    assert.equal(inert.active, false);
    assert.equal(inert.check(), false);
    assert.equal(timers.intervals.size, 0, "no interval without a registration");
    assert.equal(doc.count("visibilitychange"), 0, "no listener without a registration");
    assert.doesNotThrow(() => inert.stop());
  });

  // ------------------------------------------------------------------
  // Reload: updateServiceWorker(true), plain reload fallback, failure resolves
  // ------------------------------------------------------------------
  const calls = [];
  const viaSw = await requestPwaReload({
    updateServiceWorker: (reload) => {
      calls.push(["sw", reload]);
      return Promise.resolve();
    },
    reloadPage: () => calls.push(["page"]),
  });
  assert.deepEqual(viaSw, { ok: true, viaServiceWorker: true, error: null });
  assert.deepEqual(calls, [["sw", true]], "Reload activates the waiting worker (true) and never reloads the page itself");

  calls.length = 0;
  const failed = await requestPwaReload({
    updateServiceWorker: () => Promise.reject(new Error("no waiting worker")),
    reloadPage: () => calls.push(["page"]),
  });
  assert.deepEqual(failed, { ok: false, viaServiceWorker: true, error: "no waiting worker" });
  assert.deepEqual(calls, [], "a failed activation does not force a reload behind the user's back");
  const threw = await requestPwaReload({
    updateServiceWorker: () => {
      throw new Error("sync failure");
    },
  });
  assert.equal(threw.ok, false);
  assert.equal(threw.error, "sync failure");

  calls.length = 0;
  const plain = await requestPwaReload({ updateServiceWorker: null, reloadPage: () => calls.push(["page"]) });
  assert.deepEqual(plain, { ok: true, viaServiceWorker: false, error: null });
  assert.deepEqual(calls, [["page"]], "without an updater the page is reloaded directly");
  assert.deepEqual(await requestPwaReload({}), { ok: true, viaServiceWorker: false, error: null });

  // The failed-reload path composes with the reducer: banner back, no spinner.
  const afterFailure = reducePwaUpdateState(reducePwaUpdateState(shown, E.reload), failed.ok ? "none" : E.reloadFailed);
  assert.deepEqual(afterFailure, shown);

  // ------------------------------------------------------------------
  // The update flow never touches stored data (workout drafts survive)
  // ------------------------------------------------------------------
  const source = readFileSync(path.join(root, "src/lib/pwaUpdate.js"), "utf8");
  assert.ok(!/localStorage\s*[.[]|removeItem\(|resetLocalAppData|\.clear\(/.test(source), "pwaUpdate.js never touches storage");

  console.log("verify-pwa-update: ok");
} catch (error) {
  console.error("verify-pwa-update: FAIL");
  console.error(error);
  process.exit(1);
}
