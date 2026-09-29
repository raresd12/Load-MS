// H4 fix round 3, decision H4-16: updating the app does not lose a saved
// workout draft. Ties the two halves together that were only covered apart
// (verify-pwa-update.mjs: the update flow; verify-workout-draft.mjs: the
// draft): a workout draft with two logged sets sits in storage while the
// WHOLE update flow runs (banner shown, Later, shown again, update checks,
// Reload through the service worker, failed activation, plain reload), and
// - the flow performs no storage call at all (no read, write or remove);
// - every stored key is byte-identical afterwards;
// - the page that comes back after the reload re-reads the same draft: the
//   mount write re-states the same bytes and the Workout Log opens with both
//   sets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.calls = [];
  }

  get length() {
    this.calls.push(["length"]);
    return this.store.size;
  }

  key(index) {
    this.calls.push(["key", index]);
    return [...this.store.keys()][index] ?? null;
  }

  getItem(key) {
    this.calls.push(["getItem", key]);
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.calls.push(["setItem", key]);
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.calls.push(["removeItem", key]);
    this.store.delete(key);
  }

  clear() {
    this.calls.push(["clear"]);
    this.store.clear();
  }
}

const storage = new MemoryLocalStorage();
globalThis.window = { localStorage: storage };
console.warn = () => {};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const {
  INITIAL_PWA_UPDATE_STATE,
  PWA_UPDATE_EVENTS,
  reducePwaUpdateState,
  requestPwaReload,
  startPwaUpdateChecks,
} = await import("../src/lib/pwaUpdate.js");
const { getActiveProgram, getProgramDayViewModels, seedDefaultProgramIfNeeded } = await import("../src/lib/programStorage.js");
const { getPlanForDay } = await import("../src/lib/progression.js");
const { buildResolvedPlan } = await import("../src/lib/sessionEdit.js");
const { createDraft, createDraftFromStorage } = await import("../src/lib/sessionNormalize.js");
const { readStorage, writeStorage, STORAGE_KEYS, subscribeStorageWrites } = await import("../src/lib/storage.js");
const { draftHasLoggedData, getWorkoutDraftKey, resolveWorkoutDraftKey } = await import("../src/lib/workoutDraft.js");

try {
  // ------------------------------------------------------------------
  // A workout in progress: two sets saved, the draft stored as App.jsx stores it
  // ------------------------------------------------------------------
  seedDefaultProgramIfNeeded();
  const program = getActiveProgram();
  const day = getProgramDayViewModels(program.id).find((candidate) => candidate.exercises.length > 0);
  const plan = buildResolvedPlan(program.id, day, getPlanForDay(day, undefined));
  const todayDateKey = "2026-09-29";
  const draftKey = getWorkoutDraftKey(program.id, day.id, todayDateKey);
  const exercise = day.exercises[0];
  const draft = createDraft(day, plan, []);
  draft.exercises[exercise.id].sets[0] = { reps: "7", weight: "60", rpe: "8" };
  draft.exercises[exercise.id].sets[1] = { reps: "6", weight: "60", rpe: "8.5" };
  draft.exercises[exercise.id].notes = "left elbow – ok";
  assert.equal(draftHasLoggedData(draft), true);

  const written = writeStorage(STORAGE_KEYS.workoutDrafts, {
    [draftKey]: {
      schemaVersion: 1,
      key: draftKey,
      status: "in_progress",
      programId: program.id,
      dayId: day.id,
      date: todayDateKey,
      updatedAt: "2026-09-29T17:05:00.000Z",
      draft,
    },
  });
  assert.equal(written.ok, true, "the draft is stored");
  assert.equal(writeStorage(STORAGE_KEYS.sessions, [{ id: "earlier", date: "2026-09-27T10:00:00.000Z", dayId: day.id, programId: program.id, exercises: {} }]).ok, true);

  const before = new Map(storage.store);
  assert.ok(before.get(STORAGE_KEYS.workoutDrafts).includes('"reps":"7"'), "the raw stored text holds the logged set");
  assert.ok(before.size >= 10, `a seeded device (${before.size} keys)`);

  // ------------------------------------------------------------------
  // The update flow, every path, with the draft in storage
  // ------------------------------------------------------------------
  const events = [];
  const unsubscribe = subscribeStorageWrites((event) => events.push(event));
  storage.calls.length = 0;

  const E = PWA_UPDATE_EVENTS;
  let state = INITIAL_PWA_UPDATE_STATE;
  state = reducePwaUpdateState(state, E.needRefresh); // a new version is waiting
  state = reducePwaUpdateState(state, E.later); // "Later": keep training
  state = reducePwaUpdateState(state, E.needRefresh); // found again by an update check
  assert.deepEqual(state, { needRefresh: true, isReloading: false });

  const listeners = [];
  const timers = [];
  let updateCalls = 0;
  const checks = startPwaUpdateChecks({
    registration: { update: () => { updateCalls += 1; return Promise.resolve(); } },
    doc: {
      visibilityState: "visible",
      addEventListener: (_type, listener) => listeners.push(listener),
      removeEventListener: () => {},
    },
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  timers.forEach((tick) => tick());
  listeners.forEach((listener) => listener({ type: "visibilitychange" }));
  checks.check();
  checks.stop();
  assert.equal(updateCalls, 3, "the update checks ran");

  // Reload that fails to activate: back to the banner.
  state = reducePwaUpdateState(state, E.reload);
  const failed = await requestPwaReload({
    updateServiceWorker: () => Promise.reject(new Error("no waiting worker")),
    reloadPage: () => {},
  });
  assert.equal(failed.ok, false);
  state = reducePwaUpdateState(state, E.reloadFailed);

  // Reload through the waiting worker, then the plain reload fallback.
  state = reducePwaUpdateState(state, E.reload);
  let activated = 0;
  let reloaded = 0;
  const viaWorker = await requestPwaReload({
    updateServiceWorker: (reloadPage) => { activated += reloadPage === true ? 1 : 0; return Promise.resolve(); },
    reloadPage: () => { reloaded += 1; },
  });
  assert.deepEqual(viaWorker, { ok: true, viaServiceWorker: true, error: null });
  const plain = await requestPwaReload({ updateServiceWorker: null, reloadPage: () => { reloaded += 1; } });
  assert.deepEqual(plain, { ok: true, viaServiceWorker: false, error: null });
  assert.equal(activated, 1);
  assert.equal(reloaded, 1);
  assert.deepEqual(state, { needRefresh: true, isReloading: true });

  assert.deepEqual(storage.calls, [], "the update flow makes no storage call (no read, write, remove or clear)");
  assert.deepEqual(events, [], "the update flow emits no storage write event");
  assert.deepEqual([...storage.store.entries()], [...before.entries()], "every stored key is byte-identical after the update flow");
  assert.equal(storage.store.get(STORAGE_KEYS.workoutDrafts), before.get(STORAGE_KEYS.workoutDrafts), "the stored draft text is byte-identical");

  // ------------------------------------------------------------------
  // The reloaded page (new version) reads the same draft back
  // ------------------------------------------------------------------
  const storedDrafts = readStorage(STORAGE_KEYS.workoutDrafts, {});
  // useLocalStorageState re-states what it read when it mounts (decision H4-9).
  assert.equal(writeStorage(STORAGE_KEYS.workoutDrafts, storedDrafts, { notify: false }).ok, true);
  assert.equal(
    storage.store.get(STORAGE_KEYS.workoutDrafts),
    before.get(STORAGE_KEYS.workoutDrafts),
    "the mount write of the reloaded page stores the same bytes",
  );
  assert.deepEqual(events, [], "the mount write is silent");
  unsubscribe();

  const resolved = resolveWorkoutDraftKey({
    workoutDrafts: storedDrafts,
    programId: program.id,
    dayId: day.id,
    todayDateKey,
    now: Date.parse("2026-09-29T17:20:00.000Z"),
  });
  assert.equal(resolved.key, draftKey, "the Workout Log opens the same draft");
  const reopened = createDraftFromStorage(day, plan, readStorage(STORAGE_KEYS.sessions, []), storedDrafts, resolved.key);
  assert.deepEqual(reopened.exercises[exercise.id].sets.slice(0, 2), [
    { reps: "7", weight: "60", rpe: "8" },
    { reps: "6", weight: "60", rpe: "8.5" },
  ], "both logged sets are on screen after the update");
  assert.equal(reopened.exercises[exercise.id].notes, "left elbow – ok");
  assert.deepEqual(reopened, draft, "the reopened draft equals the draft before the update");

  // The update that arrives after midnight resumes the same draft (H4-2, new-S).
  const nextDay = resolveWorkoutDraftKey({
    workoutDrafts: storedDrafts,
    programId: program.id,
    dayId: day.id,
    todayDateKey: "2026-09-30",
    now: Date.parse("2026-09-30T00:10:00.000Z"),
  });
  assert.equal(nextDay.key, draftKey, "a reload after midnight still resumes the draft");

  // ------------------------------------------------------------------
  // Wiring: nothing on the update path can reach storage, the worker waits
  // ------------------------------------------------------------------
  const touchesStorage = /localStorage|sessionStorage|indexedDB|writeStorage|removeStorage|resetLocalAppData|restoreLocalBackup|clearSecret|caches\.delete|\.clear\(\)/;
  for (const file of ["src/lib/pwaUpdate.js", "src/components/PwaUpdateBanner.jsx"]) {
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    assert.ok(!touchesStorage.test(source), `${file} never touches stored data`);
  }
  const main = read("src/main.jsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  assert.ok(!touchesStorage.test(main), "src/main.jsx never touches stored data");
  assert.ok(/reloadPage:\s*\(\)\s*=>\s*window\.location\.reload\(\)/.test(main), "the fallback is a plain page reload");
  assert.ok(main.includes("requestPwaReload({"), "Reload goes through requestPwaReload");

  const viteConfig = read("vite.config.js");
  assert.ok(/registerType:\s*"prompt"/.test(viteConfig), "the new worker waits for the user (prompt flow)");
  assert.ok(!/skipWaiting:\s*true|clientsClaim:\s*true/.test(viteConfig), "the worker never takes over an open page by itself");
  assert.ok(/cleanupOutdatedCaches:\s*true/.test(viteConfig), "only outdated precaches are cleaned up (Cache Storage, not localStorage)");

  console.log(`verify-pwa-h4-draft: ok (${before.size} keys byte-identical, draft with 2 sets reopened)`);
} catch (error) {
  console.error("verify-pwa-h4-draft: FAIL");
  console.error(error);
  process.exit(1);
}
