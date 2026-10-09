import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Phase H6 fix round 3, client side (decisions H6-10, H6-49): the sync meta
// (rpe-tracker.sync-meta.v1) is lost while the sync token stays. Such a
// device is unlinked: a sync makes no request and asks to link; the link
// preview reads the account once to write a fresh unlinked meta and goes on,
// so Merge links the device again. Nothing is deleted on either side. A
// revoked token there signs the device out, as any 401 does.
// The real engine against the real createApi, in process.

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
const { openDatabase } = await import("../server/db.mjs");
const { readStorage, STORAGE_KEYS, writeStorage } = await import("../src/lib/storage.js");
const { createSyncApi } = await import("../src/lib/syncApi.js");
const { createLocalSyncStorage, createMemoryLock, createSyncEngine, SYNC_STATUSES } = await import("../src/lib/syncEngine.js");

const META_KEY = "rpe-tracker.sync-meta.v1";
const TOKEN_KEY = "rpe-tracker.sync-token.v1";
const APP_ORIGIN = "http://127.0.0.1:5173";
const BASE_URL = "http://127.0.0.1:3100";
const RATE_LIMITS = {
  auth: [{ windowMs: 60_000, max: 1000 }],
  signup: [{ windowMs: 3_600_000, max: 100 }],
  sync: [{ windowMs: 60_000, max: 10_000 }],
};

function createServer() {
  const db = openDatabase(":memory:");
  const api = createApi({ db, config: { allowedOrigins: [APP_ORIGIN], maxAccounts: 20, rateLimits: RATE_LIMITS } });
  const rows = (userId) =>
    db
      .prepare("SELECT collection, record_id, rev, deleted, body FROM records WHERE user_id = ? ORDER BY collection, record_id")
      .all(userId)
      .map((row) => ({ ...row }));
  return { db, api, rows, requests: [] };
}

function createDevice(server, name, index) {
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
  const ip = `10.13.0.${index}`;
  const fetch = async (url, init = {}) => {
    server.requests.push({ device: name, method: init.method ?? "GET", path: new URL(url).pathname });
    return server.api.fetch(
      new Request(url, { method: init.method, headers: { ...(init.headers ?? {}), origin: APP_ORIGIN }, body: init.body }),
      { ip },
    );
  };
  const syncApi = createSyncApi({ baseUrl: BASE_URL, fetch, getToken: () => storage.readToken() });
  const device = { name, win, storage };
  device.engine = createSyncEngine({ api: syncApi, storage, lock: createMemoryLock() });
  device.on = (fn) => {
    globalThis.window = win;
    return fn();
  };
  device.sessions = () => device.on(() => readStorage(STORAGE_KEYS.sessions, []));
  device.write = (value) => device.on(() => writeStorage(STORAGE_KEYS.sessions, value));
  device.meta = () => device.storage.readMeta();
  device.requests = () => server.requests.filter((request) => request.device === name);
  return device;
}

const sessionRecord = (id, notes = "") => ({
  id,
  schemaVersion: 6,
  programId: "program-h6",
  dayId: "day-a",
  date: "2026-10-08",
  savedAt: "2026-10-08T10:00:00.000Z",
  sessionNotes: notes,
  exercises: [],
});

const credentials = () => ({ username: `r3${randomUUID().slice(0, 8)}`, password: `pw-${randomUUID()}` });

async function linkedDevice(server, sessions, index = 1) {
  const user = credentials();
  const device = createDevice(server, `d-${user.username}`, index);
  device.write(sessions);
  assert.equal((await device.engine.signUp(user)).ok, true);
  assert.equal((await device.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
  return { device, user };
}

let checks = 0;

// ---------------------------------------------------------------------------
// Lost meta, token kept: no request, then preview and Merge link again
// ---------------------------------------------------------------------------
{
  const server = createServer();
  const sessions = [sessionRecord("s-1", "one"), sessionRecord("s-2", "two")];
  const { device } = await linkedDevice(server, sessions);
  const userId = device.meta().userId;
  const oldDeviceId = device.meta().deviceId;
  const accountBefore = server.rows(userId);
  assert.ok(accountBefore.some((row) => row.collection === "sessions" && row.record_id === "s-1"));

  device.win.localStorage.removeItem(META_KEY);
  assert.ok(device.win.localStorage.getItem(TOKEN_KEY), "the token stays");
  server.requests.length = 0;

  const synced = await device.engine.syncNow();
  assert.equal(synced.status, SYNC_STATUSES.needsLink, "a device without meta is unlinked");
  assert.deepEqual(device.requests(), [], "a sync without meta makes no request");
  const status = device.engine.status();
  assert.equal(status.signedIn, true);
  assert.equal(status.linked, false, "the card shows the link view, not the signed-in panel");
  checks += 1;

  const preview = await device.engine.buildLinkPreview();
  assert.equal(preview.ok, true, `the preview works without meta: ${JSON.stringify(preview.error ?? null)}`);
  assert.equal(preview.status, SYNC_STATUSES.needsLink);
  assert.equal(preview.collections.sessions.identical, 2, "the device and the account hold the same sessions");
  assert.equal(preview.totals.deviceOnly, 0);
  assert.equal(preview.totals.accountOnly, 0);
  assert.deepEqual(
    device.requests().map((request) => `${request.method} ${request.path}`),
    ["GET /v1/account", "GET /v1/sync/pull"],
    "the preview reads the account once, then pulls; nothing is pushed",
  );
  const rebuilt = device.meta();
  assert.equal(rebuilt.userId, userId, "the rebuilt meta names the token's user");
  assert.equal(rebuilt.username, device.engine.status().username);
  assert.ok(rebuilt.username, "the username comes back with it");
  assert.equal(rebuilt.linked, false, "the rebuilt meta is unlinked");
  assert.deepEqual(rebuilt.records, {}, "with no known record, so nothing can be sent as a delete");
  assert.notEqual(rebuilt.deviceId, oldDeviceId, "a fresh device id, as after a sign-in");
  assert.deepEqual(server.rows(userId), accountBefore, "the preview wrote nothing on the account");
  checks += 1;

  const linked = await device.engine.applyLink("merge");
  assert.equal(linked.status, SYNC_STATUSES.synced, "Merge links the device again");
  assert.equal(device.engine.status().linked, true);
  assert.deepEqual(device.sessions(), sessions, "the device keeps every session");
  const accountAfter = server.rows(userId);
  assert.equal(accountAfter.filter((row) => row.deleted).length, 0, "nothing was deleted on the account");
  assert.deepEqual(
    accountAfter.map((row) => [row.collection, row.record_id, row.rev]),
    accountBefore.map((row) => [row.collection, row.record_id, row.rev]),
    "identical records are not uploaded again",
  );

  device.write([...sessions, sessionRecord("s-3", "three")]);
  assert.equal((await device.engine.syncNow()).status, SYNC_STATUSES.synced, "sync works again after the relink");
  assert.ok(server.rows(userId).some((row) => row.record_id === "s-3" && !row.deleted));
  checks += 1;
}

// ---------------------------------------------------------------------------
// Lost meta, Merge chosen straight away (no preview first)
// ---------------------------------------------------------------------------
{
  const server = createServer();
  const { device } = await linkedDevice(server, [sessionRecord("m-1", "one")], 2);
  const userId = device.meta().userId;
  device.win.localStorage.removeItem(META_KEY);
  device.write([sessionRecord("m-1", "one"), sessionRecord("m-2", "two")]);

  const linked = await device.engine.applyLink("merge");
  assert.equal(linked.status, SYNC_STATUSES.synced, `applyLink rebuilds the meta too: ${JSON.stringify(linked.error ?? null)}`);
  assert.equal(device.meta().userId, userId);
  assert.equal(device.meta().linked, true);
  const live = server.rows(userId).filter((row) => row.collection === "sessions" && !row.deleted).map((row) => row.record_id);
  assert.deepEqual(live, ["m-1", "m-2"], "the device-only session uploads; nothing is deleted");
  checks += 1;
}

// ---------------------------------------------------------------------------
// Lost meta and a revoked token: the preview signs the device out
// ---------------------------------------------------------------------------
{
  const server = createServer();
  const { device, user } = await linkedDevice(server, [sessionRecord("r-1")], 3);
  const other = createDevice(server, `other-${user.username}`, 4);
  assert.equal((await other.engine.signIn(user)).ok, true);
  assert.equal((await other.engine.signOut({ everywhere: true })).ok, true, "every token of the account is revoked");

  device.win.localStorage.removeItem(META_KEY);
  const preview = await device.engine.buildLinkPreview();
  assert.equal(preview.ok, false);
  assert.equal(preview.status, SYNC_STATUSES.signedOut, "a 401 while rebuilding the meta signs out");
  assert.equal(preview.error?.kind, "unauthorized");
  assert.equal(device.win.localStorage.getItem(TOKEN_KEY), null, "the token is removed, so the card shows the sign-in form");
  assert.equal(device.win.localStorage.getItem(META_KEY), null, "no meta is written for a revoked token");
  assert.equal(device.engine.status().signedIn, false);
  assert.deepEqual(device.sessions(), [sessionRecord("r-1")], "local data stays");
  checks += 1;
}

console.log(`Sync H6 round 3 verification passed (${checks} checks).`);
