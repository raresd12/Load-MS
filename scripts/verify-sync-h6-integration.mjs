import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Phase H6 gate (handoff Phase H6; decisions H6-2 to H6-11, H6-24 to H6-27):
// the real client (src/lib/syncApi.js + src/lib/syncEngine.js + the UI
// track's scheduler and view helpers) against the real server
// (server/app.mjs createApi on an in-memory node:sqlite database), in one
// process through a fetch shim. Every device has its own in-memory
// localStorage; the storage adapter points `window` at it on each call.
// Credentials are random per run and never printed.
//
// Scenarios: sign up, link with Merge, edit on A -> B sees it, a lost
// response is retried without a duplicate session on the server, an offline
// save syncs later, a conflict is kept, two accounts are isolated, a reset
// or a restore never deletes server records, the mass-delete guard, the
// scheduler's write trigger, and no token or password in any non-secret key
// or any console output.

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

globalThis.window = { localStorage: new MemoryLocalStorage(), __name: "none" };

// Everything the client and the server print is captured and scanned for
// secrets at the end; nothing reaches the terminal.
const captured = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
for (const level of ["warn", "error", "info"]) {
  console[level] = (...args) => captured.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
}

const { createApi } = await import("../server/app.mjs");
const { openDatabase } = await import("../server/db.mjs");
const {
  readStorage,
  resetLocalAppData,
  restoreLocalBackup,
  createLocalBackup,
  SECRET_STORAGE_KEYS,
  STORAGE_KEYS,
  STORAGE_WRITE_REASONS,
  subscribeStorageWrites,
  writeStorage,
} = await import("../src/lib/storage.js");
const { createSyncApi } = await import("../src/lib/syncApi.js");
const { createLocalSyncStorage, createMemoryLock, createSyncEngine, SYNC_STATUSES } = await import("../src/lib/syncEngine.js");
const { buildLinkPreviewModel, describeAccountError, describeSyncStatus } = await import("../src/lib/accountView.js");
const { createSyncScheduler, SYNC_WRITE_DELAY_MS } = await import("../src/components/account/syncScheduler.js");

const APP_ORIGIN = "http://127.0.0.1:5173";
const BASE_URL = "http://127.0.0.1:3100";

// ---------------------------------------------------------------------------
// The real server, in process
// ---------------------------------------------------------------------------
const db = openDatabase(":memory:");
const api = createApi({
  db,
  config: {
    allowedOrigins: [APP_ORIGIN],
    maxAccounts: 10,
    // Many sign-ins from the fixture's few addresses; the limiter itself is
    // pinned by scripts/verify-server-auth.mjs.
    rateLimits: {
      auth: [{ windowMs: 60_000, max: 1000 }],
      signup: [{ windowMs: 3_600_000, max: 100 }],
      sync: [{ windowMs: 60_000, max: 10_000 }],
    },
    onError: (error) => captured.push(`server error: ${error?.message}`),
  },
});

const network = {
  offline: false,
  // "request": the request never reaches the server; "response": the server
  // handles it and the answer is lost on the way back.
  dropNext: null,
  dropPath: null,
  calls: 0,
};

function createShimFetch(ip) {
  return async (url, init = {}) => {
    network.calls += 1;
    const { pathname } = new URL(url);

    if (network.offline) {
      throw new TypeError("Failed to fetch");
    }

    const drop = network.dropNext && (!network.dropPath || pathname === network.dropPath) ? network.dropNext : null;

    if (drop === "request") {
      network.dropNext = null;
      throw new TypeError("Failed to fetch");
    }

    assert.equal(init.credentials, "omit", "the client never sends cookies");
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

    assert.equal(response.headers.get("access-control-allow-origin"), APP_ORIGIN, "CORS answers the app origin");
    return response;
  };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
const devices = [];

function onDevice(device, fn) {
  globalThis.window = device.win;
  return fn();
}

function createDevice(name, index) {
  const win = { localStorage: new MemoryLocalStorage(), __name: name };
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
  const syncApi = createSyncApi({ baseUrl: BASE_URL, fetch: createShimFetch(`10.9.0.${index}`), getToken: () => storage.readToken() });
  const device = { name, win, storage, api: syncApi };
  device.engine = createSyncEngine({ api: syncApi, storage, lock: createMemoryLock() });
  device.read = (key, fallback = []) => onDevice(device, () => readStorage(key, fallback));
  device.write = (key, value) => onDevice(device, () => writeStorage(key, value));
  device.sessions = () => device.read(STORAGE_KEYS.sessions);
  device.session = (id) => device.sessions().find((session) => session.id === id);
  device.addSession = (session) => device.write(STORAGE_KEYS.sessions, [...device.sessions(), session]);
  device.editSession = (id, patch) =>
    device.write(
      STORAGE_KEYS.sessions,
      device.sessions().map((session) => (session.id === id ? { ...session, ...patch } : session)),
    );
  device.userId = () => device.storage.readMeta()?.userId ?? null;
  devices.push(device);
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

const serverCount = (userId, collection, recordId) =>
  db
    .prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND collection = ? AND record_id = ? AND deleted = 0")
    .get(userId, collection, recordId).n;
const serverLive = (userId, collection) =>
  db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND collection = ? AND deleted = 0").get(userId, collection).n;

const firstUser = { username: `h6a${randomUUID().slice(0, 8)}`, password: `pw-${randomUUID()}` };
const secondUser = { username: `h6b${randomUUID().slice(0, 8)}`, password: `pw-${randomUUID()}` };
const issuedSecrets = new Set([firstUser.password, secondUser.password]);
let scenarios = 0;

try {
  // -------------------------------------------------------------------------
  // 1. Sign up on device A (with local history), preview, Merge
  // -------------------------------------------------------------------------
  const a = createDevice("device-a", 1);
  a.write(STORAGE_KEYS.sessions, [sessionRecord("s-1"), sessionRecord("s-2"), sessionRecord("s-3")]);

  {
    const callsBefore = network.calls;
    assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.signedOut, "a guest does not sync");
    assert.equal(network.calls, callsBefore, "a guest makes no request");

    const signUp = await a.engine.signUp(firstUser);
    assert.equal(signUp.ok, true, describeAccountError(signUp.error));
    assert.equal(signUp.status, SYNC_STATUSES.needsLink);
    assert.match(signUp.recoveryCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/, "the recovery code is shown once after sign-up");
    issuedSecrets.add(signUp.recoveryCode);
    issuedSecrets.add(a.storage.readToken());
    assert.ok(a.storage.readToken(), "the token is stored as a secret");

    const taken = await createDevice("device-x", 9).engine.signUp(firstUser);
    assert.equal(taken.ok, false);
    assert.equal(describeAccountError(taken.error), "That username is taken. Choose another one.");

    const preview = await a.engine.buildLinkPreview();
    assert.equal(preview.ok, true);
    const model = buildLinkPreviewModel(preview);
    assert.equal(model.accountEmpty, true, "a new account is empty");
    assert.deepEqual(model.rows.find((row) => row.name === "sessions").parts, ["3 only on this device"]);

    const linked = await a.engine.applyLink("merge");
    assert.equal(linked.status, SYNC_STATUSES.synced);
    assert.equal(linked.linked, true);
    assert.equal(serverLive(a.userId(), "sessions"), 3, "Merge uploads the device's sessions");
    const status = a.engine.status();
    assert.equal(describeSyncStatus({ status, now: Date.parse(status.lastSyncAt) + 1000 }).text, "Synced just now.");
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 2. Device B signs in, previews, merges its own session
  // -------------------------------------------------------------------------
  const b = createDevice("device-b", 2);
  b.write(STORAGE_KEYS.sessions, [sessionRecord("s-b1")]);

  {
    const wrong = await b.engine.signIn({ username: firstUser.username, password: `${firstUser.password}x` });
    assert.equal(wrong.ok, false);
    assert.equal(describeAccountError(wrong.error), "Wrong username or password.");

    const signIn = await b.engine.signIn(firstUser);
    assert.equal(signIn.ok, true);
    issuedSecrets.add(b.storage.readToken());
    const model = buildLinkPreviewModel(await b.engine.buildLinkPreview());
    assert.deepEqual(model.rows.find((row) => row.name === "sessions").parts, ["1 only on this device", "3 only in the account"]);
    assert.equal(b.sessions().length, 1, "the preview writes nothing");

    const linked = await b.engine.applyLink("merge");
    assert.equal(linked.status, SYNC_STATUSES.synced);
    assert.deepEqual(b.sessions().map((session) => session.id).sort(), ["s-1", "s-2", "s-3", "s-b1"]);
    assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.synced);
    assert.ok(a.session("s-b1"), "A gets B's session");
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 3. Edit on A, sync, B sees it
  // -------------------------------------------------------------------------
  {
    a.editSession("s-2", { sessionNotes: "edited on A" });
    assert.equal((await a.engine.refreshWaiting()), 1);
    assert.equal(describeSyncStatus({ status: a.engine.status() }).text, "1 change waiting.");
    assert.equal((await a.engine.syncNow()).pushed, 1);
    assert.equal((await b.engine.syncNow()).status, SYNC_STATUSES.synced);
    assert.equal(b.session("s-2").sessionNotes, "edited on A");
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 4. A lost push response: the retry does not duplicate the session
  // -------------------------------------------------------------------------
  {
    a.addSession(sessionRecord("s-4", "saved during a flaky connection"));
    network.dropNext = "response";
    network.dropPath = "/v1/sync/push";
    const lost = await a.engine.syncNow();
    assert.equal(lost.status, SYNC_STATUSES.offline, "a lost answer reads as offline");
    assert.equal(serverCount(a.userId(), "sessions", "s-4"), 1, "the server applied the push");
    assert.equal(lost.waiting, 1, "the change still waits on the device");
    assert.ok(a.session("s-4"), "the saved workout stays on the device");

    const retried = await a.engine.syncNow();
    assert.equal(retried.status, SYNC_STATUSES.synced, "the retry with the same opId succeeds");
    assert.equal(serverCount(a.userId(), "sessions", "s-4"), 1, "no duplicate on the server");
    assert.equal(a.sessions().filter((session) => session.id === "s-4").length, 1, "no duplicate on the device");
    await b.engine.syncNow();
    assert.equal(b.sessions().filter((session) => session.id === "s-4").length, 1, "no duplicate on the other device");

    network.dropNext = "request";
    network.dropPath = "/v1/sync/pull";
    a.editSession("s-4", { sessionNotes: "second try" });
    assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.offline);
    assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.synced);
    assert.equal(serverCount(a.userId(), "sessions", "s-4"), 1);
    network.dropPath = null;
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 5. Offline save, then sync
  // -------------------------------------------------------------------------
  {
    network.offline = true;
    a.addSession(sessionRecord("s-5", "logged in the basement"));
    const offline = await a.engine.syncNow();
    assert.equal(offline.status, SYNC_STATUSES.offline);
    assert.ok(a.session("s-5"), "network loss does not lose the saved workout");
    assert.equal(
      describeSyncStatus({ status: a.engine.status(), lastResult: offline }).text,
      "Offline: saved on this device, will sync later.",
    );
    assert.ok(a.engine.status().retryDelayMs >= 30_000, "back-off after a failure");
    network.offline = false;
    assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.synced);
    await b.engine.syncNow();
    assert.equal(b.session("s-5").sessionNotes, "logged in the basement");
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 6. Conflict kept, then "Keep this version"
  // -------------------------------------------------------------------------
  {
    a.editSession("s-1", { sessionNotes: "A's notes" });
    b.editSession("s-1", { sessionNotes: "B's notes" });
    assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.synced);
    const result = await b.engine.syncNow();
    assert.equal(result.status, SYNC_STATUSES.synced);
    assert.equal(result.conflicts, 1, "the concurrent edit is a conflict");
    assert.equal(b.session("s-1").sessionNotes, "A's notes", "the account's version is live");
    const kept = b.engine.listConflicts();
    assert.equal(kept.length, 1);
    assert.equal(kept[0].body.sessionNotes, "B's notes", "B's version is kept, not lost");

    assert.equal(b.engine.keepConflictVersion(kept[0].id).ok, true);
    assert.equal(b.session("s-1").sessionNotes, "B's notes");
    assert.equal(b.engine.listConflicts().length, 0);
    assert.equal((await b.engine.syncNow()).status, SYNC_STATUSES.synced);
    await a.engine.syncNow();
    assert.equal(a.session("s-1").sessionNotes, "B's notes", "the kept version reaches A");
    assert.equal(serverCount(a.userId(), "sessions", "s-1"), 1);
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 7. Two accounts are isolated
  // -------------------------------------------------------------------------
  const c = createDevice("device-c", 3);
  let d = null;

  {
    c.write(STORAGE_KEYS.sessions, [sessionRecord("s-1", "second user's s-1")]);
    const signUp = await c.engine.signUp(secondUser);
    assert.equal(signUp.ok, true);
    issuedSecrets.add(signUp.recoveryCode);
    issuedSecrets.add(c.storage.readToken());
    const model = buildLinkPreviewModel(await c.engine.buildLinkPreview());
    assert.equal(model.accountEmpty, true, "the second account sees none of the first account's records");
    assert.equal((await c.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
    assert.notEqual(c.userId(), a.userId());

    assert.equal((await a.engine.syncNow()).pulled, 0, "the first account pulls nothing of the second");
    assert.equal(a.session("s-1").sessionNotes, "B's notes", "the same record id in another account changes nothing");
    assert.equal(c.sessions().length, 1);
    assert.equal(c.session("s-1").sessionNotes, "second user's s-1");

    const foreign = await c.api.pull({ since: 0, limit: 500 });
    assert.ok(foreign.ok);
    assert.ok(foreign.data.records.every((record) => record.body?.sessionNotes !== "B's notes"));
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 8. Mass-delete guard (H6-10): asks before any request
  // -------------------------------------------------------------------------
  {
    const live = serverLive(b.userId(), "sessions");
    assert.ok(live >= 6);
    b.write(STORAGE_KEYS.sessions, b.sessions().slice(0, 2));
    const callsBefore = network.calls;
    const paused = await b.engine.syncNow();
    assert.equal(paused.status, SYNC_STATUSES.needsConfirmation);
    assert.equal(network.calls, callsBefore, "the question comes before any request");
    assert.equal(serverLive(b.userId(), "sessions"), live, "nothing deleted without a yes");

    // B restores its sessions from A's copy instead of confirming.
    b.write(STORAGE_KEYS.sessions, a.sessions());
    assert.equal((await b.engine.syncNow()).status, SYNC_STATUSES.synced);
    assert.equal(serverLive(b.userId(), "sessions"), live);
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 9. A reset or a restore never deletes server records
  // -------------------------------------------------------------------------
  {
    const live = serverLive(a.userId(), "sessions");
    const userId = a.userId();
    const backup = onDevice(a, () => createLocalBackup());
    assert.ok(!JSON.stringify(backup).includes(a.storage.readToken()), "a backup holds no token");
    assert.equal(JSON.stringify(backup).includes("sync-meta"), false, "a backup holds no sync meta");

    onDevice(b, () => restoreLocalBackup(backup));
    assert.equal(b.engine.status().linked, false, "a restore unlinks the device");
    assert.equal((await b.engine.syncNow()).status, SYNC_STATUSES.needsLink, "an unlinked device does not push the restored data");
    assert.equal(serverLive(userId, "sessions"), live);

    const reset = onDevice(a, () => resetLocalAppData());
    assert.equal(reset.ok, true);
    assert.equal(a.engine.status().signedIn, false, "a reset signs the device out");
    assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.signedOut);
    assert.equal(serverLive(userId, "sessions"), live, "the reset deleted nothing on the server");

    d = createDevice("device-d", 4);
    assert.equal((await d.engine.signIn(firstUser)).ok, true);
    issuedSecrets.add(d.storage.readToken());
    const model = buildLinkPreviewModel(await d.engine.buildLinkPreview());
    assert.equal(model.rows.find((row) => row.name === "sessions").accountOnly, live, "a new device still finds every session");
    assert.equal((await d.engine.applyLink("useAccount")).status, SYNC_STATUSES.synced);
    assert.equal(d.sessions().length, live);
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 10. The scheduler on the real engine: a write syncs 4 s later; the App
  //     mirroring a pull (an identical write) is not a sync
  // -------------------------------------------------------------------------
  {
    let now = 0;
    const timers = new Map();
    let nextId = 1;
    const fakeTimers = {
      setTimeout: (fn, ms) => {
        timers.set(nextId, { fn, at: now + ms });
        return nextId++;
      },
      clearTimeout: (id) => timers.delete(id),
      setInterval: () => 0,
      clearInterval: () => {},
    };
    const advance = async (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          globalThis.window = c.win;
          await timer.fn();
        }
      }
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const scheduler = createSyncScheduler({
      engine: c.engine,
      subscribeWrites: subscribeStorageWrites,
      navigatorLike: { onLine: true },
      timers: fakeTimers,
      clock: () => now,
    });
    let pushes = 0;
    const counting = c.engine;
    const originalSync = counting.syncNow;
    counting.syncNow = (options) => {
      pushes += 1;
      return originalSync(options);
    };
    // The App shell's refresh: on a sync write, write the same values back
    // through the checked writer (reason "write"), as the hook setters do.
    const mirror = subscribeStorageWrites((event) => {
      if (event.reason === STORAGE_WRITE_REASONS.sync) {
        for (const key of event.keys) {
          if (key === STORAGE_KEYS.sessions) {
            c.write(key, c.read(key));
          }
        }
      }
    });
    scheduler.start();

    c.addSession(sessionRecord("s-c2", "saved on C"));
    await advance(SYNC_WRITE_DELAY_MS - 1);
    assert.equal(pushes, 0, "no sync before 4 s");
    await advance(1);
    assert.equal(pushes, 1, "the write syncs 4 s later");
    assert.equal(serverCount(c.userId(), "sessions", "s-c2"), 1);

    // Another device of the second user pushes; C pulls it; the mirror write
    // that follows must not start another sync.
    const e = createDevice("device-e", 5);
    assert.equal((await e.engine.signIn(secondUser)).ok, true);
    issuedSecrets.add(e.storage.readToken());
    assert.equal((await e.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
    e.addSession(sessionRecord("s-e1", "from E"));
    assert.equal((await e.engine.syncNow()).status, SYNC_STATUSES.synced);
    globalThis.window = c.win;
    await scheduler.run("manual");
    assert.equal(pushes, 2);
    assert.ok(c.session("s-e1"), "C pulled E's session");
    await advance(SYNC_WRITE_DELAY_MS * 2);
    assert.equal(pushes, 2, "the mirror write after a pull is not a second sync");
    scheduler.stop();
    mirror();
    counting.syncNow = originalSync;
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 11. Sign out, delete account: local data stays
  // -------------------------------------------------------------------------
  {
    const before = c.sessions().length;
    const deleted = await c.engine.deleteAccount({ password: `${secondUser.password}x` });
    assert.equal(deleted.ok, false, "a wrong password does not delete the account");
    assert.equal(describeAccountError(deleted.error), "That password is not right.");
    assert.equal((await c.engine.deleteAccount({ password: secondUser.password })).ok, true);
    assert.equal(c.engine.status().signedIn, false);
    assert.equal(c.sessions().length, before, "deleting the account keeps the device's data");
    const userIds = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    assert.equal(userIds, 1, "only the first account is left");

    const signedOut = await b.engine.signOut({ everywhere: true });
    assert.equal(signedOut.remoteOk, true);
    assert.equal(b.engine.status().signedIn, false);
    assert.ok(b.sessions().length > 0, "signing out keeps the device's data");
    assert.equal((await d.engine.syncNow()).status, SYNC_STATUSES.signedOut, "everywhere revoked the other device's token");
    assert.equal(d.engine.status().signedIn, false, "a revoked token is removed from the device");
    scenarios += 1;
  }

  // -------------------------------------------------------------------------
  // 12. No token or password outside the secret key, nothing secret logged
  // -------------------------------------------------------------------------
  {
    const secrets = [...issuedSecrets].filter(Boolean);
    assert.ok(secrets.length >= 8, `secrets tracked: ${secrets.length}`);

    for (const device of devices) {
      for (const [key, value] of device.win.localStorage.store) {
        for (const secret of secrets) {
          if (value.includes(secret)) {
            assert.equal(key, SECRET_STORAGE_KEYS.syncToken, `${device.name}: a secret appears only under the sync token key (found under ${key})`);
            assert.ok(!value.includes(firstUser.password) && !value.includes(secondUser.password), "the token key never holds a password");
          }
        }
      }
    }

    for (const line of captured) {
      for (const secret of secrets) {
        assert.ok(!line.includes(secret), "no token, password or recovery code is logged");
      }
    }
    scenarios += 1;
  }
} finally {
  Object.assign(console, originalConsole);
  api.close?.();
  try {
    db.close();
  } catch {
    // createApi.close() already closed it.
  }
}

console.log(`Sync H6 integration verification passed (${scenarios} scenarios, ${network.calls} requests, real createApi in process).`);
