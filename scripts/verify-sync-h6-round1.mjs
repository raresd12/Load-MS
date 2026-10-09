import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Phase H6 fix round 1, client side (decisions H6-31, H6-34 to H6-36,
// H6-38 to H6-40): the real engine against the real createApi, in process.
// - H6-34: a lost push answer or a lost pull, then a newer local edit, never
//   reverts the device's own newest edit;
// - H6-36: a discarded or missing collection is fetched back from the account,
//   never sent as deletes;
// - H6-38: untouched built-in defaults that differ only in seed time are not
//   "different", and Merge keeps a device's edit of a default;
// - H6-39: the mass-delete question can be declined by bringing the records
//   back from the account;
// - H6-31: a server database with a new epoch unlinks the device;
// - H6-40: pushes are split by bytes as well as by count;
// - H6-35: a write by another tab is re-read (storage event).

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }

  key(index) {
    return [...this.store.keys()][index] ?? null;
  }

  get length() {
    return this.store.size;
  }
}

globalThis.window = { localStorage: new MemoryLocalStorage() };
const quiet = () => {};
console.warn = quiet;
console.info = quiet;

const { createApi } = await import("../server/app.mjs");
const { openDatabase, rotateEpoch } = await import("../server/db.mjs");
const { discardCorruptStorageValue, isLocalStorageEvent, readStorage, STORAGE_KEYS, writeStorage, DEVICE_STORAGE_KEYS } = await import(
  "../src/lib/storage.js"
);
const { seedDefaultProgramIfNeeded } = await import("../src/lib/programStorage.js");
const { createSyncApi } = await import("../src/lib/syncApi.js");
const { chunkPushOps, createLocalSyncStorage, createMemoryLock, createSyncEngine, MAX_PUSH_BYTES, SYNC_STATUSES } =
  await import("../src/lib/syncEngine.js");
const { classifySeedPair, getDefaultSeedIndex } = await import("../src/lib/syncSeeds.js");
const { buildLinkPreviewModel, describeAccountError, describeMassDelete, storageEventKeys } = await import(
  "../src/lib/accountView.js"
);
const { createSyncScheduler } = await import("../src/components/account/syncScheduler.js");
const { recordKey } = await import("../src/lib/syncRecords.js");

const APP_ORIGIN = "http://127.0.0.1:5173";
const BASE_URL = "http://127.0.0.1:3100";

const db = openDatabase(":memory:");
const api = createApi({
  db,
  config: {
    allowedOrigins: [APP_ORIGIN],
    maxAccounts: 20,
    rateLimits: {
      auth: [{ windowMs: 60_000, max: 1000 }],
      signup: [{ windowMs: 3_600_000, max: 100 }],
      sync: [{ windowMs: 60_000, max: 10_000 }],
    },
  },
});

const network = { dropNext: null, dropPath: null, pushBodies: [] };

function createShimFetch(ip) {
  return async (url, init = {}) => {
    const { pathname } = new URL(url);
    const drop = network.dropNext && (!network.dropPath || pathname === network.dropPath) ? network.dropNext : null;

    if (pathname === "/v1/sync/push" && typeof init.body === "string") {
      network.pushBodies.push(init.body.length);
    }

    const request = new Request(url, {
      method: init.method,
      headers: { ...(init.headers ?? {}), origin: APP_ORIGIN },
      body: init.body,
    });
    const response = await api.fetch(request, { ip });

    if (drop === "response") {
      network.dropNext = null;
      await response.text();
      throw new TypeError("Failed to fetch");
    }

    return response;
  };
}

function createDevice(name, index) {
  const win = { localStorage: new MemoryLocalStorage() };
  const real = createLocalSyncStorage();
  const storage = Object.fromEntries(
    Object.entries(real).map(([method, fn]) => [
      method,
      (...args) => {
        globalThis.window = win;
        return fn(...args);
      },
    ]),
  );
  const syncApi = createSyncApi({ baseUrl: BASE_URL, fetch: createShimFetch(`10.8.0.${index}`), getToken: () => storage.readToken() });
  const device = { name, win, storage };
  device.engine = createSyncEngine({ api: syncApi, storage, lock: createMemoryLock() });
  device.on = (fn) => {
    globalThis.window = win;
    return fn();
  };
  device.read = (key, fallback = []) => device.on(() => readStorage(key, fallback));
  device.write = (key, value) => device.on(() => writeStorage(key, value));
  device.sessions = () => device.read(STORAGE_KEYS.sessions);
  device.session = (id) => device.sessions().find((session) => session.id === id);
  device.editSession = (id, patch) =>
    device.write(
      STORAGE_KEYS.sessions,
      device.sessions().map((session) => (session.id === id ? { ...session, ...patch } : session)),
    );
  device.meta = () => device.storage.readMeta();
  device.userId = () => device.meta()?.userId ?? null;
  return device;
}

const sessionRecord = (id, notes = "") => ({
  id,
  schemaVersion: 6,
  programId: "program-h6",
  dayId: "day-a",
  date: "2026-10-07",
  savedAt: "2026-10-07T10:00:00.000Z",
  sessionNotes: notes,
  exercises: [],
});

const serverLive = (userId, collection) =>
  db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND collection = ? AND deleted = 0").get(userId, collection).n;
const serverBody = (userId, collection, recordId) => {
  const row = db
    .prepare("SELECT body, deleted FROM records WHERE user_id = ? AND collection = ? AND record_id = ?")
    .get(userId, collection, recordId);
  return row && !row.deleted ? JSON.parse(row.body) : null;
};

const credentials = () => ({ username: `r1${randomUUID().slice(0, 8)}`, password: `pw-${randomUUID()}` });

async function linkPair(sessions) {
  const user = credentials();
  const a = createDevice(`a-${user.username}`, 1);
  const b = createDevice(`b-${user.username}`, 2);
  a.write(STORAGE_KEYS.sessions, sessions);
  assert.equal((await a.engine.signUp(user)).ok, true);
  assert.equal((await a.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
  assert.equal((await b.engine.signIn(user)).ok, true);
  assert.equal((await b.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
  return { a, b, user };
}

/** Runs seedDefaultProgramIfNeeded on a device as if the clock read `offsetMs` later. */
function seedAt(device, offsetMs) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) {
        super(...args);
      } else {
        super(RealDate.now() + offsetMs);
      }
    }

    static now() {
      return RealDate.now() + offsetMs;
    }
  };

  try {
    return device.on(() => seedDefaultProgramIfNeeded());
  } finally {
    globalThis.Date = RealDate;
  }
}

let checks = 0;

// ---------------------------------------------------------------------------
// H6-34: lost push answer, then a newer edit
// ---------------------------------------------------------------------------
{
  const { a, b, user } = await linkPair([sessionRecord("s-1", "base")]);

  a.editSession("s-1", { sessionNotes: "edit 1" });
  network.dropNext = "response";
  network.dropPath = "/v1/sync/push";
  assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.offline, "the push answer is lost");
  assert.equal(serverBody(a.userId(), "sessions", "s-1").sessionNotes, "edit 1", "the server applied it");
  assert.ok(a.meta().inflight[recordKey("sessions", "s-1")]?.length, "the op was recorded in flight before it was sent");

  a.editSession("s-1", { sessionNotes: "edit 2 (newest)" });
  const next = await a.engine.syncNow();
  assert.equal(next.status, SYNC_STATUSES.synced);
  assert.equal(next.conflicts, 0, "the device's own earlier write is not a conflict");
  assert.equal(a.session("s-1").sessionNotes, "edit 2 (newest)", "the newest edit stays live");
  assert.equal(a.engine.listConflicts().length, 0, "nothing kept aside");
  assert.equal(serverBody(a.userId(), "sessions", "s-1").sessionNotes, "edit 2 (newest)", "the account has the newest edit");
  assert.deepEqual(a.meta().inflight, {}, "nothing left in flight");
  await b.engine.syncNow();
  assert.equal(b.session("s-1").sessionNotes, "edit 2 (newest)", "the other device gets the newest edit");
  checks += 1;

  // Lost pull after an applied push, then a newer edit: the earned rev is kept.
  a.editSession("s-1", { sessionNotes: "edit 3" });
  network.dropNext = "response";
  network.dropPath = "/v1/sync/pull";
  assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.offline, "the pull answer is lost");
  a.editSession("s-1", { sessionNotes: "edit 4 (newest)" });
  const after = await a.engine.syncNow();
  assert.equal(after.status, SYNC_STATUSES.synced);
  assert.equal(after.conflicts, 0);
  assert.equal(a.session("s-1").sessionNotes, "edit 4 (newest)");
  assert.equal(serverBody(a.userId(), "sessions", "s-1").sessionNotes, "edit 4 (newest)");
  checks += 1;

  // Lost push answer, then the edit is undone: the undo is not overwritten
  // by the device's own earlier write coming back in the pull.
  a.editSession("s-1", { sessionNotes: "typo" });
  network.dropNext = "response";
  network.dropPath = "/v1/sync/push";
  assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.offline);
  a.editSession("s-1", { sessionNotes: "edit 4 (newest)" });
  const undone = await a.engine.syncNow();
  assert.equal(undone.status, SYNC_STATUSES.synced);
  assert.equal(undone.conflicts, 0);
  assert.equal(a.session("s-1").sessionNotes, "edit 4 (newest)", "the undo stays");
  assert.equal(serverBody(a.userId(), "sessions", "s-1").sessionNotes, "edit 4 (newest)", "and reaches the account");
  assert.equal(user.username.length > 0, true);
  checks += 1;
}

// ---------------------------------------------------------------------------
// H6-36: discarding an unreadable collection fetches it back
// ---------------------------------------------------------------------------
{
  const fifteen = Array.from({ length: 15 }, (_, index) => sessionRecord(`d-${index}`, `n${index}`));
  const { a, b } = await linkPair(fifteen);
  assert.equal(b.sessions().length, 15);

  a.win.localStorage.setItem(STORAGE_KEYS.sessions, "{not json");
  assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.error, "an unreadable collection stops the sync");
  assert.equal(a.on(() => discardCorruptStorageValue(STORAGE_KEYS.sessions)).discarded, true);
  assert.deepEqual(a.meta().refetchKeys, [STORAGE_KEYS.sessions], "the discard marks the key for a refetch");

  const refetched = await a.engine.syncNow();
  assert.equal(refetched.status, SYNC_STATUSES.synced);
  assert.equal(refetched.pushed, 0, "no deletes are sent");
  assert.equal(a.sessions().length, 15, "the sessions come back from the account");
  assert.deepEqual(a.meta().refetchKeys, []);
  assert.equal(serverLive(a.userId(), "sessions"), 15, "the account keeps them");
  await b.engine.syncNow();
  assert.equal(b.sessions().length, 15, "the other device keeps them");
  checks += 1;

  // Discard, then a new workout is saved before the next sync.
  a.win.localStorage.setItem(STORAGE_KEYS.sessions, "{not json");
  assert.equal(a.on(() => discardCorruptStorageValue(STORAGE_KEYS.sessions)).discarded, true);
  a.write(STORAGE_KEYS.sessions, [sessionRecord("d-new", "after the discard")]);
  const mixed = await a.engine.syncNow();
  assert.equal(mixed.status, SYNC_STATUSES.synced);
  assert.equal(a.sessions().length, 16, "the old sessions come back next to the new one");
  assert.equal(serverLive(a.userId(), "sessions"), 16, "the new one is uploaded, nothing deleted");
  checks += 1;

  // A collection key that is simply gone (no discard mark) is fetched back too.
  a.win.localStorage.removeItem(STORAGE_KEYS.sessions);
  const missing = await a.engine.syncNow();
  assert.equal(missing.status, SYNC_STATUSES.synced);
  assert.equal(a.sessions().length, 16);
  assert.equal(serverLive(a.userId(), "sessions"), 16);
  checks += 1;

  // A record changed in both places while the key was unreadable: the
  // device's version stays live and is sent; the account's is kept aside.
  b.editSession("d-1", { sessionNotes: "changed on B" });
  await b.engine.syncNow();
  const raw = a.win.localStorage.getItem(STORAGE_KEYS.sessions);
  a.win.localStorage.setItem(STORAGE_KEYS.sessions, "{not json");
  a.on(() => discardCorruptStorageValue(STORAGE_KEYS.sessions));
  a.write(
    STORAGE_KEYS.sessions,
    JSON.parse(raw)
      .filter((session) => session.id === "d-1")
      .map((session) => ({ ...session, sessionNotes: "changed on A" })),
  );
  const both = await a.engine.syncNow();
  assert.equal(both.status, SYNC_STATUSES.synced);
  assert.equal(a.session("d-1").sessionNotes, "changed on A", "the device's version stays live");
  assert.equal(serverBody(a.userId(), "sessions", "d-1").sessionNotes, "changed on A", "and is sent");
  assert.equal(a.sessions().length, 16);
  const keptB = a.engine.listConflicts().find((entry) => entry.recordId === "d-1");
  assert.equal(keptB?.body?.sessionNotes, "changed on B", "the account's version is kept aside");
  checks += 1;
}

// ---------------------------------------------------------------------------
// H6-38: built-in defaults and the link
// ---------------------------------------------------------------------------
{
  const index = getDefaultSeedIndex();
  assert.ok(index.size > 300, "the seed index holds the default program records");

  const user = credentials();
  const oldPhone = createDevice("old-phone", 11);
  const newPhone = createDevice("new-phone", 12);
  seedAt(oldPhone, 0);
  seedAt(newPhone, 86_400_000);

  const progressions = oldPhone.read(STORAGE_KEYS.programProgressions);
  const earned = { ...progressions[0], lastRecommendedWeight: 80, notes: "earned" };
  oldPhone.write(STORAGE_KEYS.programProgressions, [earned, ...progressions.slice(1)]);
  const progressionKey = recordKey("programProgressions", JSON.stringify([earned.programId, earned.programExerciseId]));
  assert.equal(classifySeedPair(progressionKey, earned, progressions[0]), "accountDefault");
  assert.equal(classifySeedPair(progressionKey, progressions[0], earned), "deviceDefault");

  // The new phone signs up first and merges its fresh defaults.
  assert.equal((await newPhone.engine.signUp(user)).ok, true);
  assert.equal((await newPhone.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
  assert.equal(newPhone.engine.listConflicts().length, 0);

  // The old phone signs in: only its edited progression differs.
  assert.equal((await oldPhone.engine.signIn(user)).ok, true);
  const preview = await oldPhone.engine.buildLinkPreview();
  assert.equal(preview.ok, true);
  assert.equal(preview.totals.different, 1, "seed-time differences are not differences");
  assert.deepEqual(preview.defaults, { inAccount: 1, onDevice: 0 });
  const model = buildLinkPreviewModel(preview);
  assert.equal(model.keptOnMerge, 0, "Merge keeps nothing aside");
  assert.match(model.mergeText, /1 built-in default you changed on this device keeps this device's version\./);

  const merged = await oldPhone.engine.applyLink("merge");
  assert.equal(merged.status, SYNC_STATUSES.synced);
  assert.equal(merged.conflicts, 0, "no kept versions");
  assert.equal(oldPhone.engine.listConflicts().length, 0);
  const live = oldPhone.read(STORAGE_KEYS.programProgressions).find((item) => item.programExerciseId === earned.programExerciseId && item.programId === earned.programId);
  assert.equal(live.lastRecommendedWeight, 80, "the earned progression stays live");
  await newPhone.engine.syncNow();
  const onNew = newPhone.read(STORAGE_KEYS.programProgressions).find((item) => item.programExerciseId === earned.programExerciseId && item.programId === earned.programId);
  assert.equal(onNew.lastRecommendedWeight, 80, "and reaches the other device");
  checks += 1;

  // A third, untouched device: its defaults take the account's versions.
  const tablet = createDevice("tablet", 13);
  seedAt(tablet, 2 * 86_400_000);
  assert.equal((await tablet.engine.signIn(user)).ok, true);
  const tabletPreview = await tablet.engine.buildLinkPreview();
  assert.deepEqual(tabletPreview.defaults, { inAccount: 0, onDevice: 1 });
  assert.match(buildLinkPreviewModel(tabletPreview).mergeText, /1 untouched built-in default here takes the account's version; no copy is kept\./);
  const tabletLinked = await tablet.engine.applyLink("merge");
  assert.equal(tabletLinked.conflicts, 0);
  const onTablet = tablet.read(STORAGE_KEYS.programProgressions).find((item) => item.programExerciseId === earned.programExerciseId && item.programId === earned.programId);
  assert.equal(onTablet.lastRecommendedWeight, 80);
  checks += 1;

  // ---------------------------------------------------------------------------
  // H6-39: decline a mass delete by bringing the records back
  // ---------------------------------------------------------------------------
  const baselines = oldPhone.read(STORAGE_KEYS.baselines);
  const liveBaselines = serverLive(oldPhone.userId(), "baselines");
  oldPhone.write(STORAGE_KEYS.baselines, baselines.slice(25));
  const asked = await oldPhone.engine.syncNow();
  assert.equal(asked.status, SYNC_STATUSES.needsConfirmation);
  assert.equal(asked.deletes, 25);
  assert.match(describeMassDelete(asked), /bring them back from the account/);
  const restored = await oldPhone.engine.syncNow({ restoreDeletes: true });
  assert.equal(restored.status, SYNC_STATUSES.synced);
  assert.equal(oldPhone.read(STORAGE_KEYS.baselines).length, baselines.length, "the baselines are back");
  assert.equal(serverLive(oldPhone.userId(), "baselines"), liveBaselines, "nothing was deleted in the account");
  checks += 1;

  let seen = null;
  const scheduler = createSyncScheduler({
    engine: {
      status: () => ({ signedIn: true, linked: true, failures: 0, retryDelayMs: 0, waiting: 0 }),
      syncNow: async (options) => {
        seen = options;
        return { status: SYNC_STATUSES.synced };
      },
      refreshWaiting: async () => 1,
    },
    subscribeWrites: () => () => {},
  });
  await scheduler.run("manual", { restoreDeletes: true });
  assert.deepEqual(seen, { confirmMassDelete: false, restoreDeletes: true }, "the scheduler passes the choice on");
  checks += 1;
}

// ---------------------------------------------------------------------------
// H6-31: a restored database (new epoch) unlinks the device
// ---------------------------------------------------------------------------
{
  const { a, user } = await linkPair([sessionRecord("e-1", "x")]);
  const epoch = a.meta().epoch;
  assert.match(epoch, /^[0-9a-f]{32}$/, "the link stores the epoch");

  rotateEpoch(db);
  a.editSession("e-1", { sessionNotes: "after the restore" });
  const result = await a.engine.syncNow();
  assert.equal(result.status, SYNC_STATUSES.needsLink, "a new epoch asks to link again");
  assert.equal(result.error.code, "epoch_changed");
  assert.match(describeAccountError(result.error), /restored from a backup/);
  assert.equal(a.meta().linked, false);
  assert.equal(a.session("e-1").sessionNotes, "after the restore", "the device's data stays");
  assert.equal(serverBody(a.userId(), "sessions", "e-1").sessionNotes, "x", "nothing was applied");
  assert.equal(a.engine.status().linked, false);

  const relinked = await a.engine.applyLink("merge");
  assert.equal(relinked.status, SYNC_STATUSES.synced);
  assert.notEqual(a.meta().epoch, epoch, "the new epoch is stored");
  assert.equal(serverBody(a.userId(), "sessions", "e-1").sessionNotes, "x", "Merge takes the account's version");
  assert.equal(a.engine.listConflicts()[0]?.body?.sessionNotes, "after the restore", "and keeps the device's");
  assert.ok(user.username);
  checks += 1;
}

// ---------------------------------------------------------------------------
// H6-40: pushes are split by bytes
// ---------------------------------------------------------------------------
{
  const small = Array.from({ length: 450 }, (_, i) => ({ opId: `op-${i}`, collection: "sessions", recordId: `r${i}`, baseRev: 0, deleted: false, body: { id: `r${i}` } }));
  assert.deepEqual(chunkPushOps(small).map((chunk) => chunk.length), [200, 200, 50], "at most 200 ops per push");
  const big = Array.from({ length: 3 }, (_, i) => ({ opId: `op-${i}`, collection: "sessions", recordId: `b${i}`, baseRev: 0, deleted: false, body: { id: `b${i}`, pad: "x".repeat(1_600_000) } }));
  assert.deepEqual(chunkPushOps(big).map((chunk) => chunk.length), [1, 1, 1], "about 3 MiB per push");
  assert.equal(MAX_PUSH_BYTES, 3 * 1024 * 1024);

  const heavy = Array.from({ length: 10 }, (_, i) => sessionRecord(`h-${i}`, "n".repeat(450_000)));
  const user = credentials();
  const device = createDevice("heavy", 21);
  device.write(STORAGE_KEYS.sessions, heavy);
  assert.equal((await device.engine.signUp(user)).ok, true);
  network.pushBodies.length = 0;
  const linked = await device.engine.applyLink("merge");
  assert.equal(linked.status, SYNC_STATUSES.synced, describeAccountError(linked.error));
  assert.equal(serverLive(device.userId(), "sessions"), 10, "4.5 MB of sessions reach the account");
  assert.ok(network.pushBodies.length >= 2, "in more than one request");
  assert.ok(network.pushBodies.every((size) => size < 4 * 1024 * 1024), "each under the server's cap");
  checks += 1;
}

// ---------------------------------------------------------------------------
// H6-35: another tab's write is re-read
// ---------------------------------------------------------------------------
{
  const area = { name: "local" };
  assert.deepEqual(storageEventKeys({ key: STORAGE_KEYS.sessions, storageArea: area }, area), [STORAGE_KEYS.sessions]);
  assert.deepEqual(storageEventKeys({ key: STORAGE_KEYS.programProgressions, storageArea: area }, area), [STORAGE_KEYS.programProgressions]);
  assert.deepEqual(storageEventKeys({ key: DEVICE_STORAGE_KEYS.syncMeta, storageArea: area }, area), [], "device values are not mirrored");
  assert.deepEqual(storageEventKeys({ key: STORAGE_KEYS.sessions, storageArea: { name: "session" } }, area), [], "another storage area is ignored");
  assert.ok(storageEventKeys({ key: null, storageArea: area }, area).includes(STORAGE_KEYS.sessions), "a clear re-reads everything");

  assert.equal(isLocalStorageEvent({ key: "x", storageArea: globalThis.window.localStorage }), true);
  assert.equal(isLocalStorageEvent({ key: "x", storageArea: { name: "session" } }), false, "sessionStorage events are ignored");
  assert.equal(isLocalStorageEvent(null), false);

  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /window\.addEventListener\("storage", handleStorage\)/, "App listens for other tabs' writes");
  assert.match(app, /window\.removeEventListener\("storage", handleStorage\)/);
  assert.match(app, /if \(!isLocalStorageEvent\(event\)\)[\s\S]{0,80}const keys = storageEventKeys\(event\);[\s\S]{0,240}applySyncedKeysRef\.current\?\.\(keys, SYNC_REFRESH_SOURCES\.tab\)/, "through the sync refresh path, as another tab's write (H6-46)");
  checks += 1;
}

console.log(`Sync H6 round 1 (H6-31, H6-34 to H6-36, H6-38 to H6-40) verification passed (${checks} checks).`);
