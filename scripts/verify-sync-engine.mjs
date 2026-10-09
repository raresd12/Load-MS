import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

// Phase H6 / Track B: src/lib/syncEngine.js + src/lib/syncApi.js against an
// in-memory fake server that follows decisions H6-5 (idempotent push by
// opId, apply on baseRev, converge on the same hash, else conflict) and H6-6
// (pull in seq order, tombstones), with Track A's H6-14 (an absent record
// reads as a tombstone at rev 0) and H6-16 (a pull page also stops at a byte
// budget). Several devices run in one process: each device has its own
// localStorage and its storage adapter points `window` at it on every
// (synchronous) call. Credentials are random per run and never printed.

class MemoryLocalStorage {
  constructor() {
    this.store = new Map();
    this.failNextWriteForKey = null;
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    if (this.failNextWriteForKey === key) {
      this.failNextWriteForKey = null;
      throw new DOMException("Simulated quota failure", "QuotaExceededError");
    }

    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

globalThis.window = { localStorage: new MemoryLocalStorage(), __name: "none" };

const originalWarn = console.warn;
console.warn = () => {};

const { readStorage, STORAGE_KEYS, subscribeStorageWrites, writeStorage } = await import("../src/lib/storage.js");
const { getCollection } = await import("../src/lib/repository.js");
const { canonicalJson, recordKey } = await import("../src/lib/syncRecords.js");
const { createSyncApi, SYNC_API_ROUTES } = await import("../src/lib/syncApi.js");
const {
  createDefaultSyncLock,
  createDeviceLeaseStore,
  createLeaseLock,
  createLocalSyncStorage,
  createMemoryLock,
  createNavigatorLock,
  createSyncEngine,
  MAX_SYNC_CONFLICTS,
  nextRetryDelay,
  normalizeSyncMeta,
  SYNC_CONFLICT_SOURCES,
  SYNC_LOCK_NAME,
  SYNC_STATUSES,
} = await import("../src/lib/syncEngine.js");

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const BASE_URL = "http://fake-sync.test";

// ---------------------------------------------------------------------------
// Fake server (H6-5, H6-6, H6-14, H6-16)
// ---------------------------------------------------------------------------
function createFakeServer() {
  const users = new Map();
  const tokens = new Map();
  const server = {
    log: [],
    faults: [],
    hooks: {},
    down: false,
    pullBytes: Infinity,
    rejectNext: null,
  };

  const userData = (userId) => users.get(userId).data;
  const reply = (status, body, headers = {}) => ({ status, body, headers });
  const fail = (status, code) => reply(status, { error: { code, message: code } });

  function issueToken(userId) {
    const token = `tok-${randomUUID()}`;
    tokens.set(token, userId);
    return token;
  }

  function authenticate(init) {
    const header = init.headers?.authorization ?? "";
    return header.startsWith("Bearer ") ? tokens.get(header.slice(7)) ?? null : null;
  }

  function push(userId, body) {
    const data = userData(userId);
    const results = [];

    for (const op of body.ops) {
      if (
        typeof op.opId !== "string" || op.opId.length < 8 || op.opId.length > 200 ||
        !getCollection(op.collection)?.syncable ||
        typeof op.recordId !== "string" || op.recordId.length < 1 || op.recordId.length > 300 ||
        !Number.isInteger(op.baseRev) || op.baseRev < 0 || typeof op.deleted !== "boolean" ||
        (!op.deleted && op.body === undefined)
      ) {
        results.push({ opId: op.opId ?? null, status: "rejected", code: "invalid_op" });
        continue;
      }

      if (server.rejectNext) {
        results.push({ opId: op.opId, status: "rejected", code: server.rejectNext });
        server.rejectNext = null;
        continue;
      }

      const stored = data.applied.get(op.opId);

      if (stored) {
        results.push({ opId: op.opId, ...stored });
        continue;
      }

      const text = op.deleted ? null : canonicalJson(op.body);
      const hash = op.deleted ? "deleted" : sha(text);
      const key = recordKey(op.collection, op.recordId);
      const current = data.records.get(key);
      const currentRev = current?.rev ?? 0;
      const currentHash = current?.hash ?? "deleted";
      let result;

      if (op.baseRev === currentRev) {
        data.seq += 1;
        result = { status: "applied", rev: currentRev + 1, seq: data.seq };
        data.records.set(key, {
          collection: op.collection,
          recordId: op.recordId,
          rev: result.rev,
          seq: data.seq,
          deleted: op.deleted,
          text,
          hash,
        });
      } else if (currentHash === hash) {
        result = { status: "applied", rev: currentRev, seq: current?.seq ?? 0 };
      } else {
        results.push({
          opId: op.opId,
          status: "conflict",
          rev: currentRev,
          deleted: current ? current.deleted : true,
          body: current && !current.deleted ? JSON.parse(current.text) : null,
        });
        continue;
      }

      data.applied.set(op.opId, result);
      results.push({ opId: op.opId, ...result });
    }

    return reply(200, { results });
  }

  function pull(userId, params) {
    const since = Number(params.get("since") ?? 0);
    const limit = Number(params.get("limit") ?? 500);
    const rows = [...userData(userId).records.values()].filter((row) => row.seq > since).sort((a, b) => a.seq - b.seq);
    const records = [];
    let bytes = 0;
    let nextSince = since;
    let more = rows.length > limit;

    for (const row of rows.slice(0, limit)) {
      const size = row.text ? row.text.length : 0;

      if (records.length && bytes + size > server.pullBytes) {
        more = true;
        break;
      }

      bytes += size;
      nextSince = row.seq;
      records.push({
        collection: row.collection,
        recordId: row.recordId,
        rev: row.rev,
        seq: row.seq,
        deleted: row.deleted,
        body: row.deleted ? null : JSON.parse(row.text),
      });
    }

    return reply(200, { records, nextSince, more });
  }

  function handle(route, init, params) {
    const body = init.body ? JSON.parse(init.body) : {};

    if (route === SYNC_API_ROUTES.signUp) {
      if ([...users.values()].some((user) => user.username === body.username)) {
        return fail(409, "username_taken");
      }

      const id = `user-${users.size + 1}`;
      users.set(id, {
        id,
        username: body.username,
        password: body.password,
        data: { records: new Map(), seq: 0, applied: new Map() },
      });
      return reply(201, { token: issueToken(id), user: { id, username: body.username }, recoveryCode: `rc-${randomUUID()}` });
    }

    if (route === SYNC_API_ROUTES.signIn) {
      const user = [...users.values()].find((entry) => entry.username === body.username && entry.password === body.password);
      return user ? reply(200, { token: issueToken(user.id), user: { id: user.id, username: user.username } }) : fail(401, "invalid_credentials");
    }

    const userId = authenticate(init);

    if (!userId) {
      return fail(401, "unauthorized");
    }

    switch (route) {
      case SYNC_API_ROUTES.signOut:
        tokens.delete(init.headers.authorization.slice(7));
        return reply(200, { ok: true });
      case SYNC_API_ROUTES.signOutAll:
        server.revokeAll(userId);
        return reply(200, { ok: true, revoked: 1 });
      case SYNC_API_ROUTES.deleteAccount:
        if (body.password !== users.get(userId).password) {
          return fail(403, "wrong_password");
        }

        server.revokeAll(userId);
        users.delete(userId);
        return reply(200, { ok: true });
      case SYNC_API_ROUTES.push:
        return push(userId, body);
      case SYNC_API_ROUTES.pull.split("?")[0]:
        return pull(userId, params);
      default:
        return fail(404, "not_found");
    }
  }

  server.revokeAll = (userId) => {
    for (const [token, owner] of tokens) {
      if (owner === userId) {
        tokens.delete(token);
      }
    }
  };
  server.records = (userId) => userData(userId).records;
  server.seq = (userId) => userData(userId).seq;
  server.count = (route) => server.log.filter((entry) => entry === route).length;

  server.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const route = `${init.method} ${pathname}`;
    server.log.push(route);

    if (server.down) {
      throw new TypeError("fetch failed");
    }

    const faultIndex = server.faults.findIndex((fault) => fault.route === route);
    const fault = faultIndex >= 0 ? server.faults.splice(faultIndex, 1)[0] : null;

    if (fault?.mode === "lost-request") {
      throw new TypeError("fetch failed");
    }

    await server.hooks[route]?.();
    const { status, body, headers } = handle(route, init, searchParams);

    if (fault?.mode === "lost-response") {
      throw new TypeError("fetch failed");
    }

    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => text,
    };
  };

  return server;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
const server = createFakeServer();
let now = Date.parse("2026-10-07T10:00:00.000Z");
const clock = () => now;
const events = [];
subscribeStorageWrites((event) => events.push({ device: globalThis.window.__name, reason: event.reason, keys: [...event.keys] }));

function onDevice(device, fn) {
  globalThis.window = device.win;
  return fn();
}

function createDevice(name, { lock = createMemoryLock() } = {}) {
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
  let counter = 0;
  const random = () => `${name}-id-${(counter += 1)}`;
  const api = createSyncApi({ baseUrl: BASE_URL, fetch: server.fetch, getToken: () => storage.readToken() });
  const device = { name, win, storage, lock, random, api };
  device.engine = createSyncEngine({ api, storage, clock, lock, random });
  device.read = (key, fallback = []) => onDevice(device, () => readStorage(key, fallback));
  device.write = (key, value) => onDevice(device, () => writeStorage(key, value));
  device.meta = () => storage.readMeta();
  device.metaText = () => win.localStorage.getItem("rpe-tracker.sync-meta.v1");
  device.sessions = () => device.read(STORAGE_KEYS.sessions);
  device.session = (id) => device.sessions().find((session) => session.id === id);
  device.editSession = (id, patch) =>
    device.write(
      STORAGE_KEYS.sessions,
      device.sessions().map((session) => (session.id === id ? { ...session, ...patch } : session)),
    );
  return device;
}

const credentials = { username: `u${randomUUID().slice(0, 8)}`, password: randomUUID() };
const userOf = (device) => device.meta().userId;

try {
  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 50].map(nextRetryDelay),
    [0, 30000, 60000, 120000, 240000, 480000, 600000, 600000, 600000],
    "retry delay: 30 s doubling to 10 min (H6-11)",
  );
  assert.equal(nextRetryDelay(-1), 0);
  assert.equal(normalizeSyncMeta(null), null);
  assert.equal(normalizeSyncMeta({ records: {} }), null, "no device id: unlinked");
  assert.equal(normalizeSyncMeta({ deviceId: "d", linked: true }).linked, false, "linked needs a records map");
  assert.equal(normalizeSyncMeta({ deviceId: "d", linked: "yes", records: {} }).linked, false);
  assert.equal(normalizeSyncMeta({ deviceId: "d", linked: true, records: {}, since: -3 }).since, 0);

  // -------------------------------------------------------------------------
  // Locks (H6-11)
  // -------------------------------------------------------------------------
  {
    const memory = createMemoryLock();
    let inner;
    const outer = await memory.run(async () => {
      inner = await memory.run(async () => "never");
      return "outer";
    });
    assert.deepEqual(outer, { acquired: true, value: "outer" });
    assert.deepEqual(inner, { acquired: false }, "a held lock is never waited for");
    assert.deepEqual(await memory.run(async () => 1), { acquired: true, value: 1 }, "released after use");

    // The lease is a storage.js device value (H6-18): only storage.js talks
    // to localStorage (H4-6), and it is never tracked or notified.
    const leaseStore = new MemoryLocalStorage();
    globalThis.window = { localStorage: leaseStore, __name: "lease" };
    const leaseEvents = events.length;
    const first = createLeaseLock({ clock, random: () => "owner-1" });
    const second = createLeaseLock({ clock, random: () => "owner-2" });
    let seen;
    const held = await first.run(async () => {
      seen = await second.run(async () => "never");
      return JSON.parse(leaseStore.getItem("rpe-tracker.sync-lease.v1"));
    });
    assert.equal(held.acquired, true);
    assert.deepEqual(held.value, { owner: "owner-1", expiresAt: now + 120000 });
    assert.deepEqual(seen, { acquired: false }, "another tab's live lease means busy");
    assert.equal(leaseStore.getItem("rpe-tracker.sync-lease.v1"), null, "the lease is released");
    assert.equal(events.length, leaseEvents, "a lease write is not a data write");
    leaseStore.setItem("rpe-tracker.sync-lease.v1", JSON.stringify({ owner: "crashed-tab", expiresAt: now - 1 }));
    assert.deepEqual(await second.run(async () => "took over"), { acquired: true, value: "took over" }, "an expired lease is taken over");
    leaseStore.failNextWriteForKey = "rpe-tracker.sync-lease.v1";
    assert.deepEqual(await first.run(async () => "ran"), { acquired: true, value: "ran" }, "an unwritable lease still syncs");

    const requests = [];
    let lockHeld = false;
    const fakeLocks = {
      async request(name, options, callback) {
        requests.push({ name, options });
        if (lockHeld) {
          return callback(null);
        }
        lockHeld = true;
        try {
          return await callback({ name });
        } finally {
          lockHeld = false;
        }
      },
    };
    const navigatorLock = createNavigatorLock(fakeLocks);
    let nested;
    assert.deepEqual(
      await navigatorLock.run(async () => {
        nested = await navigatorLock.run(async () => "never");
        return "ok";
      }),
      { acquired: true, value: "ok" },
    );
    assert.deepEqual(nested, { acquired: false });
    assert.deepEqual(requests[0], { name: SYNC_LOCK_NAME, options: { ifAvailable: true } });
    assert.equal(SYNC_LOCK_NAME, "loadms-sync");
    const chosen = createDefaultSyncLock({ navigatorLike: { locks: fakeLocks }, leaseStore: createDeviceLeaseStore() });
    await chosen.run(async () => null);
    assert.equal(requests.length, 3, "navigator.locks is preferred");
    // createDefaultSyncLock uses the real clock: the live lease must be live in
    // real time, whatever day the fixture runs on.
    leaseStore.setItem("rpe-tracker.sync-lease.v1", JSON.stringify({ owner: "x", expiresAt: Date.now() + 600000 }));
    assert.deepEqual(await createDefaultSyncLock({ navigatorLike: {} }).run(async () => 1), { acquired: false }, "else the lease");
    assert.deepEqual(await createDefaultSyncLock({ navigatorLike: {}, leaseStore: null }).run(async () => 1), { acquired: true, value: 1 }, "else memory");
  }

  // -------------------------------------------------------------------------
  // Device A signs up; nothing syncs before the link (H6-9).
  // -------------------------------------------------------------------------
  const lockA = createMemoryLock();
  const A = createDevice("A", { lock: lockA });
  A.write(STORAGE_KEYS.sessions, [{ id: "s1", v: 1 }, { id: "s2", v: 2 }]);
  A.write(STORAGE_KEYS.nextPlans, { "day-1": { sets: 3 } });
  A.write(STORAGE_KEYS.baselines, [{ programId: "p1", programExerciseId: "pe1", w: 50 }]);
  A.write(STORAGE_KEYS.activeProgramId, "p1");

  assert.equal((await A.engine.syncNow()).status, SYNC_STATUSES.signedOut, "signed out: nothing to do");
  assert.equal(server.log.length, 0);

  const signedUp = await A.engine.signUp(credentials);
  assert.equal(signedUp.ok, true);
  assert.equal(signedUp.status, SYNC_STATUSES.needsLink);
  assert.match(signedUp.recoveryCode, /^rc-/);
  assert.equal(signedUp.username, credentials.username);
  assert.deepEqual(A.meta(), {
    userId: "user-1",
    username: credentials.username,
    deviceId: "A-id-1",
    since: 0,
    records: {},
    lastSyncAt: null,
    lastError: null,
    linked: false,
    epoch: null,
    inflight: {},
    refetchKeys: [],
  });
  assert.ok(A.storage.readToken().startsWith("tok-"));
  assert.equal(A.engine.status().linked, false);
  assert.equal((await A.engine.syncNow()).status, SYNC_STATUSES.needsLink, "no sync before the link");
  assert.equal(server.count(SYNC_API_ROUTES.push), 0);

  const previewA = await A.engine.buildLinkPreview();
  assert.equal(previewA.ok, true);
  assert.deepEqual(previewA.totals, { deviceOnly: 4, accountOnly: 0, identical: 0, different: 0 });
  assert.deepEqual(previewA.collections.sessions, { deviceOnly: 2, accountOnly: 0, identical: 0, different: 0 });
  assert.equal(Object.keys(previewA.collections).length, 15);

  const linkA = await A.engine.applyLink("merge");
  assert.equal(linkA.status, SYNC_STATUSES.synced);
  assert.equal(linkA.linked, true);
  assert.equal(linkA.choice, "merge");
  assert.equal(linkA.pushed, 4);
  assert.equal(linkA.conflicts, 0);
  assert.equal(linkA.waiting, 0);
  const user = userOf(A);
  assert.equal(server.records(user).size, 4);
  assert.ok(!server.records(user).has(recordKey("activeProgramId", "p1")), "per-device values never sync");
  assert.equal(A.meta().linked, true);
  assert.equal(A.meta().since, 4);
  assert.equal(A.meta().lastSyncAt, "2026-10-07T10:00:00.000Z");
  assert.deepEqual(A.meta().records[recordKey("sessions", "s1")], { rev: 1, hash: sha('{"id":"s1","v":1}') });
  assert.deepEqual(
    { ...A.engine.status(), conflicts: undefined },
    {
      signedIn: true,
      linked: true,
      username: credentials.username,
      userId: user,
      deviceId: "A-id-1",
      lastSyncAt: "2026-10-07T10:00:00.000Z",
      lastError: null,
      lastStatus: "synced",
      running: false,
      waiting: 0,
      failures: 0,
      retryDelayMs: 0,
      conflicts: undefined,
    },
  );
  assert.equal(server.log.filter((route) => route.startsWith("GET /v1/sync/pull")).length >= 1, true);

  // -------------------------------------------------------------------------
  // Device B: preview (writes nothing), then Merge (H6-9).
  // -------------------------------------------------------------------------
  const B = createDevice("B");
  B.write(STORAGE_KEYS.sessions, [{ id: "s1", v: "B" }, { id: "s3", v: 3 }]);
  B.write(STORAGE_KEYS.baselines, [{ w: 50, programExerciseId: "pe1", programId: "p1" }]);
  assert.equal((await B.engine.signIn(credentials)).status, SYNC_STATUSES.needsLink);
  assert.equal(B.meta().deviceId, "B-id-1");
  const beforePreview = [...B.win.localStorage.store.entries()];
  events.length = 0;
  const previewB = await B.engine.buildLinkPreview();
  assert.deepEqual(previewB.collections.sessions, { deviceOnly: 1, accountOnly: 1, identical: 0, different: 1 });
  assert.deepEqual(previewB.collections.baselines, { deviceOnly: 0, accountOnly: 0, identical: 1, different: 0 }, "same content in another key order is identical");
  assert.deepEqual(previewB.collections.nextPlans, { deviceOnly: 0, accountOnly: 1, identical: 0, different: 0 });
  assert.deepEqual(previewB.totals, { deviceOnly: 1, accountOnly: 2, identical: 1, different: 1 });
  assert.equal(previewB.skipped, 0);
  assert.deepEqual([...B.win.localStorage.store.entries()], beforePreview, "the preview writes nothing");
  assert.equal(events.length, 0);

  const linkB = await B.engine.applyLink("merge");
  assert.equal(linkB.status, SYNC_STATUSES.synced);
  assert.equal(linkB.linkWritten, 3, "s1 replaced, s2 and day-1 added");
  assert.equal(linkB.pushed, 1, "the device-only s3 uploads");
  assert.equal(linkB.conflicts, 1);
  assert.deepEqual(B.sessions(), [{ id: "s1", v: 1 }, { id: "s3", v: 3 }, { id: "s2", v: 2 }], "the account version wins the live slot");
  assert.deepEqual(B.read(STORAGE_KEYS.nextPlans, {}), { "day-1": { sets: 3 } });
  assert.deepEqual(B.read(STORAGE_KEYS.baselines), [{ w: 50, programExerciseId: "pe1", programId: "p1" }], "identical records are not rewritten");
  const keptB = B.engine.listConflicts();
  assert.equal(keptB.length, 1);
  assert.deepEqual(keptB[0], {
    id: keptB[0].id,
    collection: "sessions",
    recordId: "s1",
    body: { id: "s1", v: "B" },
    deleted: false,
    serverRev: 1,
    at: "2026-10-07T10:00:00.000Z",
    source: SYNC_CONFLICT_SOURCES.linkMerge,
  });
  const linkEvents = events.filter((event) => event.device === "B");
  assert.equal(linkEvents.length, 1, "the link is one batch");
  assert.equal(linkEvents[0].reason, "sync");
  assert.deepEqual(linkEvents[0].keys, [STORAGE_KEYS.syncConflicts, STORAGE_KEYS.sessions, STORAGE_KEYS.nextPlans], "kept versions first");
  assert.equal(B.engine.status().conflicts, 1);
  assert.equal(server.records(user).get(recordKey("sessions", "s3")).rev, 1);

  const pulledA = await A.engine.syncNow();
  assert.equal(pulledA.status, SYNC_STATUSES.synced);
  assert.equal(pulledA.pulled, 1);
  assert.deepEqual(A.sessions(), [{ id: "s1", v: 1 }, { id: "s2", v: 2 }, { id: "s3", v: 3 }]);

  // -------------------------------------------------------------------------
  // Device C: "Use the account's data" removes device-only records and keeps
  // them, never uploading them.
  // -------------------------------------------------------------------------
  const C = createDevice("C");
  C.write(STORAGE_KEYS.sessions, [{ id: "s1", v: "C" }, { id: "s9", v: 9 }]);
  await C.engine.signIn(credentials);
  const previewC = await C.engine.buildLinkPreview();
  assert.deepEqual(previewC.collections.sessions, { deviceOnly: 1, accountOnly: 2, identical: 0, different: 1 });
  const linkC = await C.engine.applyLink("useAccount");
  assert.equal(linkC.status, SYNC_STATUSES.synced);
  assert.equal(linkC.pushed, 0, "nothing of this device uploads");
  assert.equal(linkC.conflicts, 2);
  assert.deepEqual(C.sessions(), [{ id: "s1", v: 1 }, { id: "s2", v: 2 }, { id: "s3", v: 3 }]);
  assert.deepEqual(C.read(STORAGE_KEYS.baselines), [{ programId: "p1", programExerciseId: "pe1", w: 50 }]);
  assert.deepEqual(
    C.engine.listConflicts().map(({ recordId, body, source }) => ({ recordId, body, source })),
    [
      { recordId: "s1", body: { id: "s1", v: "C" }, source: "link-use-account" },
      { recordId: "s9", body: { id: "s9", v: 9 }, source: "link-use-account" },
    ],
  );
  assert.ok(!server.records(user).has(recordKey("sessions", "s9")));
  assert.equal((await C.engine.syncNow()).pushed, 0, "nothing waits after the link");

  // Cancel signs out and changes nothing.
  const D = createDevice("D");
  D.write(STORAGE_KEYS.sessions, [{ id: "d1" }]);
  await D.engine.signIn(credentials);
  const cancelled = await D.engine.applyLink("cancel");
  assert.equal(cancelled.status, SYNC_STATUSES.signedOut);
  assert.equal(D.storage.readToken(), "");
  assert.equal(D.meta(), null);
  assert.deepEqual(D.sessions(), [{ id: "d1" }]);
  assert.equal((await D.engine.applyLink("bogus")).status, SYNC_STATUSES.error);

  // -------------------------------------------------------------------------
  // A sync conflict: the server's version stays live, the local one is kept
  // (H6-8); Keep re-applies it on top of the server rev; Discard drops it.
  // -------------------------------------------------------------------------
  now += 60000;
  A.editSession("s2", { v: "A2" });
  assert.equal((await A.engine.syncNow()).pushed, 1);
  B.editSession("s2", { v: "B2" });
  const conflictSync = await B.engine.syncNow();
  assert.equal(conflictSync.status, SYNC_STATUSES.synced);
  assert.equal(conflictSync.conflicts, 1);
  assert.equal(conflictSync.pushed, 0);
  assert.equal(conflictSync.waiting, 0);
  assert.deepEqual(B.session("s2"), { id: "s2", v: "A2" }, "the version the server holds wins");
  const s2Conflict = B.engine.listConflicts()[0];
  assert.deepEqual(
    { recordId: s2Conflict.recordId, body: s2Conflict.body, serverRev: s2Conflict.serverRev, source: s2Conflict.source, at: s2Conflict.at },
    { recordId: "s2", body: { id: "s2", v: "B2" }, serverRev: 2, source: "sync", at: "2026-10-07T10:01:00.000Z" },
    "newest first, the losing local version",
  );
  assert.equal(B.engine.listConflicts().length, 2);
  assert.equal(await B.engine.refreshWaiting(), 0);

  events.length = 0;
  assert.deepEqual(B.engine.keepConflictVersion(s2Conflict.id), { ok: true });
  assert.deepEqual(B.session("s2"), { id: "s2", v: "B2" });
  assert.equal(B.engine.listConflicts().length, 1);
  assert.deepEqual(events.map((event) => event.reason), ["write"], "Keep is a user change, not a sync write");
  assert.equal(await B.engine.refreshWaiting(), 1);
  const kept = await B.engine.syncNow();
  assert.equal(kept.pushed, 1);
  assert.equal(server.records(user).get(recordKey("sessions", "s2")).rev, 3, "pushed on top of the server rev");
  await A.engine.syncNow();
  assert.deepEqual(A.session("s2"), { id: "s2", v: "B2" });

  const mergeEntry = B.engine.listConflicts()[0];
  assert.deepEqual(B.engine.discardConflict(mergeEntry.id), { ok: true });
  assert.deepEqual(B.engine.listConflicts(), []);
  assert.deepEqual(B.session("s1"), { id: "s1", v: 1 }, "Discard leaves the live record");
  assert.equal(B.engine.discardConflict("missing").error.code, "not_found");

  // -------------------------------------------------------------------------
  // Deletes travel as tombstones; a tombstoned record can come back.
  // -------------------------------------------------------------------------
  A.write(STORAGE_KEYS.sessions, A.sessions().filter((session) => session.id !== "s3"));
  const deleted = await A.engine.syncNow();
  assert.equal(deleted.pushed, 1);
  const tombstone = server.records(user).get(recordKey("sessions", "s3"));
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.rev, 2);
  await B.engine.syncNow();
  assert.equal(B.session("s3"), undefined, "the delete reaches B");
  assert.deepEqual(B.meta().records[recordKey("sessions", "s3")], { rev: 2, hash: "deleted" }, "tombstones stay in the meta");
  await C.engine.syncNow();
  assert.equal(C.session("s3"), undefined);

  const E = createDevice("E");
  E.write(STORAGE_KEYS.sessions, [{ id: "s3", v: "E3" }]);
  await E.engine.signIn(credentials);
  assert.equal((await E.engine.buildLinkPreview()).collections.sessions.deviceOnly, 1, "a tombstoned id counts as device-only");
  const linkE = await E.engine.applyLink("merge");
  assert.equal(linkE.status, SYNC_STATUSES.synced);
  assert.equal(linkE.conflicts, 0);
  assert.equal(server.records(user).get(recordKey("sessions", "s3")).rev, 3, "uploaded on top of the tombstone");
  await A.engine.syncNow();
  assert.deepEqual(A.session("s3"), { id: "s3", v: "E3" });

  // -------------------------------------------------------------------------
  // Lost response, then retry: the same opIds, no duplicate (H6-5, H6-7).
  // -------------------------------------------------------------------------
  A.editSession("s1", { v: "A-lost" });
  A.write(STORAGE_KEYS.sessions, [...A.sessions(), { id: "s4", v: 4 }]);
  const metaBefore = A.metaText();
  const revBefore = server.records(user).get(recordKey("sessions", "s1")).rev;
  server.faults.push({ route: SYNC_API_ROUTES.push, mode: "lost-response" });
  const lost = await A.engine.syncNow();
  assert.equal(lost.status, SYNC_STATUSES.offline);
  assert.equal(lost.error.kind, "offline");
  assert.equal(lost.error.code, "network");
  assert.equal(lost.waiting, 2);
  const metaAfterLost = JSON.parse(A.metaText());
  assert.deepEqual(
    { ...metaAfterLost, inflight: {} },
    { ...JSON.parse(metaBefore), inflight: {} },
    "only the in-flight hashes are recorded (H6-34)",
  );
  assert.equal(Object.keys(metaAfterLost.inflight).length, 2, "both ops are in flight");
  assert.equal(server.records(user).get(recordKey("sessions", "s1")).rev, revBefore + 1, "the server did apply it");
  assert.equal(A.engine.status().failures, 1);
  assert.equal(A.engine.status().retryDelayMs, 30000);
  const seqBefore = server.seq(user);
  const retried = await A.engine.syncNow();
  assert.equal(retried.status, SYNC_STATUSES.synced);
  assert.equal(retried.pushed, 2);
  assert.equal(retried.conflicts, 0, "the retry is not a conflict");
  assert.equal(server.seq(user), seqBefore, "the retry changed nothing on the server");
  assert.equal(server.records(user).get(recordKey("sessions", "s1")).rev, revBefore + 1, "no second revision");
  assert.equal(A.sessions().filter((session) => session.id === "s4").length, 1, "one s4 on the device");
  assert.equal(A.engine.status().failures, 0);
  assert.equal(A.engine.status().retryDelayMs, 0);

  // Lost request, then success.
  A.editSession("s4", { v: "4b" });
  const seqLost = server.seq(user);
  server.faults.push({ route: SYNC_API_ROUTES.push, mode: "lost-request" });
  assert.equal((await A.engine.syncNow()).status, SYNC_STATUSES.offline);
  assert.equal(server.seq(user), seqLost, "nothing reached the server");
  assert.equal((await A.engine.syncNow()).pushed, 1);
  assert.equal(server.seq(user), seqLost + 1);

  // Pull pages (H6-6 / H6-16): B pulls the three changes one page at a time.
  server.pullBytes = 1;
  const pullsBefore = server.count("GET /v1/sync/pull");
  const paged = await B.engine.syncNow();
  assert.equal(paged.status, SYNC_STATUSES.synced);
  assert.equal(paged.pulled, 3, "s3 back, s1 and s4");
  assert.equal(server.count("GET /v1/sync/pull") - pullsBefore, 3, "one record per page");
  assert.deepEqual(B.session("s4"), { id: "s4", v: "4b" });
  assert.deepEqual(B.session("s1"), { id: "s1", v: "A-lost" });
  server.pullBytes = Infinity;

  // -------------------------------------------------------------------------
  // Offline: data stays, the changes wait, the retry delay grows (H6-11).
  // -------------------------------------------------------------------------
  A.editSession("s2", { v: "offline" });
  server.down = true;
  const offline1 = await A.engine.syncNow();
  assert.equal(offline1.status, SYNC_STATUSES.offline);
  assert.equal(offline1.waiting, 1);
  assert.deepEqual(A.session("s2"), { id: "s2", v: "offline" }, "local data untouched");
  assert.equal(A.engine.status().waiting, 1);
  assert.equal(A.engine.status().retryDelayMs, 30000);
  await A.engine.syncNow();
  assert.equal(A.engine.status().failures, 2);
  assert.equal(A.engine.status().retryDelayMs, 60000);
  const logLength = server.log.length;
  assert.equal(await A.engine.refreshWaiting(), 1);
  assert.equal(server.log.length, logLength, "counting waiting changes needs no network");
  server.down = false;
  const online = await A.engine.syncNow();
  assert.equal(online.status, SYNC_STATUSES.synced);
  assert.equal(online.pushed, 1);
  assert.equal(A.engine.status().waiting, 0);
  assert.equal(A.engine.status().lastError, null);

  // -------------------------------------------------------------------------
  // A failed local write leaves the meta as it was; the next sync redoes
  // the same work without a second server revision.
  // -------------------------------------------------------------------------
  B.editSession("s4", { v: "B4" });
  const metaB = B.metaText();
  const sessionsB = B.sessions();
  B.win.localStorage.failNextWriteForKey = STORAGE_KEYS.sessions;
  const failedWrite = await B.engine.syncNow();
  assert.equal(failedWrite.status, SYNC_STATUSES.error);
  assert.equal(failedWrite.error.kind, "local");
  assert.equal(failedWrite.error.code, "local_quota");
  // Only the rev the push earned is kept (H6-34); the pull cursor stays.
  const metaBFailed = JSON.parse(B.metaText());
  const metaBBefore = JSON.parse(metaB);
  const s4Key = recordKey("sessions", "s4");
  assert.equal(metaBFailed.since, metaBBefore.since, "the pull cursor is not moved");
  assert.equal(metaBFailed.records[s4Key].rev, server.records(user).get(s4Key).rev, "the earned rev is kept");
  assert.deepEqual(
    { ...metaBFailed.records, [s4Key]: null },
    { ...metaBBefore.records, [s4Key]: null },
    "no other record meta changed",
  );
  assert.deepEqual(B.sessions(), sessionsB, "data unchanged (A's s2 not taken)");
  const s4Rev = server.records(user).get(recordKey("sessions", "s4")).rev;
  const recovered = await B.engine.syncNow();
  assert.equal(recovered.status, SYNC_STATUSES.synced);
  assert.equal(recovered.pulled, 1);
  assert.equal(server.records(user).get(recordKey("sessions", "s4")).rev, s4Rev, "the same opId: no second revision");
  assert.deepEqual(B.session("s2"), { id: "s2", v: "offline" });
  assert.deepEqual(B.session("s4"), { id: "s4", v: "B4" });

  // -------------------------------------------------------------------------
  // A local edit made while the sync is on the network is never overwritten.
  // -------------------------------------------------------------------------
  B.editSession("s1", { v: "from B" });
  await B.engine.syncNow();
  server.hooks["GET /v1/sync/pull"] = () => {
    server.hooks["GET /v1/sync/pull"] = null;
    A.editSession("s1", { v: "typed during sync" });
  };
  const racing = await A.engine.syncNow();
  assert.equal(racing.status, SYNC_STATUSES.synced);
  assert.equal(racing.waiting, 1, "the edit is left for the next sync");
  assert.deepEqual(A.session("s1"), { id: "s1", v: "typed during sync" });
  assert.deepEqual(A.session("s4"), { id: "s4", v: "B4" }, "other records still pulled");
  const afterRace = await A.engine.syncNow();
  assert.equal(afterRace.conflicts, 1);
  assert.deepEqual(A.session("s1"), { id: "s1", v: "from B" });
  assert.deepEqual(A.engine.listConflicts()[0].body, { id: "s1", v: "typed during sync" }, "the edit is kept");

  // -------------------------------------------------------------------------
  // Rejected ops: the rest applies, the status is error, the change waits.
  // -------------------------------------------------------------------------
  A.editSession("s2", { v: "r1" });
  A.editSession("s4", { v: "r2" });
  server.rejectNext = "quota";
  const rejected = await A.engine.syncNow();
  assert.equal(rejected.status, SYNC_STATUSES.error);
  assert.equal(rejected.error.kind, "rejected");
  assert.equal(rejected.error.code, "quota");
  assert.equal(rejected.pushed, 1);
  assert.equal(rejected.waiting, 1);
  assert.equal((await A.engine.syncNow()).status, SYNC_STATUSES.synced);
  assert.equal(await A.engine.refreshWaiting(), 0);

  // -------------------------------------------------------------------------
  // Corrupt or wrong-shaped local data is never read as deletes.
  // -------------------------------------------------------------------------
  const validSessions = A.sessions();
  const pushesBefore = server.count(SYNC_API_ROUTES.push);
  A.win.localStorage.setItem(STORAGE_KEYS.sessions, "{broken");
  const corrupt = await A.engine.syncNow();
  assert.equal(corrupt.status, SYNC_STATUSES.error);
  assert.equal(corrupt.error.code, "local_read");
  A.win.localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify({ not: "a list" }));
  const wrongShape = await A.engine.syncNow();
  assert.equal(wrongShape.error.code, "local_shape");
  assert.equal(server.count(SYNC_API_ROUTES.push), pushesBefore, "nothing was sent");
  A.write(STORAGE_KEYS.sessions, validSessions);
  assert.equal((await A.engine.syncNow()).status, SYNC_STATUSES.synced);

  // -------------------------------------------------------------------------
  // Mass delete needs a confirmation (H6-10).
  // -------------------------------------------------------------------------
  A.write(STORAGE_KEYS.sessions, [...A.sessions(), ...Array.from({ length: 30 }, (_, index) => ({ id: `m${index}` }))]);
  assert.equal((await A.engine.syncNow()).pushed, 30);
  const live = Object.values(A.meta().records).filter((entry) => entry.hash !== "deleted").length;
  A.write(STORAGE_KEYS.sessions, A.sessions().filter((session) => !session.id.startsWith("m")));
  const pushesMass = server.count(SYNC_API_ROUTES.push);
  const ask = await A.engine.syncNow();
  assert.equal(ask.status, SYNC_STATUSES.needsConfirmation);
  assert.equal(ask.deletes, 30);
  assert.equal(ask.live, live);
  assert.equal(ask.waiting, 30);
  assert.equal(server.count(SYNC_API_ROUTES.push), pushesMass, "nothing sent before the confirmation");
  assert.equal(A.engine.status().lastStatus, "needs-confirmation");
  assert.equal(A.engine.status().failures, 0, "not a failure");
  const confirmed = await A.engine.syncNow({ confirmMassDelete: true });
  assert.equal(confirmed.status, SYNC_STATUSES.synced);
  assert.equal(confirmed.pushed, 30);
  await B.engine.syncNow();
  assert.ok(!B.sessions().some((session) => session.id.startsWith("m")));

  // -------------------------------------------------------------------------
  // One sync at a time: coalesced in a tab, busy across tabs (H6-11).
  // -------------------------------------------------------------------------
  {
    A.editSession("s2", { v: "lock" });
    const tab2 = createSyncEngine({ api: A.api, storage: A.storage, clock, lock: lockA, random: A.random });
    const pushes = server.count(SYNC_API_ROUTES.push);
    const first = A.engine.syncNow();
    const second = A.engine.syncNow();
    assert.equal(first, second, "a second call in the same tab joins the running sync");
    assert.equal(A.engine.status().running, true);
    const other = await tab2.syncNow();
    assert.equal(other.status, SYNC_STATUSES.busy, "another tab is told the lock is held");
    assert.equal(tab2.status().failures, 0, "busy is not a failure");
    const done = await first;
    assert.equal(done.status, SYNC_STATUSES.synced);
    assert.equal(done.pushed, 1);
    assert.equal(server.count(SYNC_API_ROUTES.push) - pushes, 1, "one push for the three calls");
    assert.equal(A.engine.status().running, false);
    assert.equal((await tab2.syncNow()).status, SYNC_STATUSES.synced, "free again afterwards");
    const busyLink = A.engine.syncNow();
    assert.equal((await A.engine.applyLink("merge")).status, SYNC_STATUSES.busy, "no link while a sync runs");
    await busyLink;
  }

  // -------------------------------------------------------------------------
  // At most 200 kept versions; never one this operation just added (H6-8).
  // -------------------------------------------------------------------------
  {
    assert.equal(MAX_SYNC_CONFLICTS, 200);
    const old = Array.from({ length: 200 }, (_, index) => ({ id: `old-${index}`, collection: "sessions", recordId: `x${index}`, body: {}, deleted: false, serverRev: 1, at: "2026-01-01T00:00:00.000Z", source: "sync" }));
    B.write(STORAGE_KEYS.syncConflicts, old);
    A.editSession("s2", { v: "cap-A" });
    await A.engine.syncNow();
    B.editSession("s2", { v: "cap-B" });
    assert.equal((await B.engine.syncNow()).conflicts, 1);
    const capped = B.engine.listConflicts();
    assert.equal(capped.length, 200);
    assert.deepEqual(capped[0].body, { id: "s2", v: "cap-B" });
    assert.equal(capped[1].id, "old-0");
    assert.equal(capped[199].id, "old-198", "the oldest entry is dropped");

    const G = createDevice("G");
    G.write(STORAGE_KEYS.sessions, Array.from({ length: 205 }, (_, index) => ({ id: `g${index}` })));
    G.write(STORAGE_KEYS.syncConflicts, [{ id: "g-old" }]);
    await G.engine.signIn(credentials);
    const linkG = await G.engine.applyLink("useAccount");
    assert.equal(linkG.status, SYNC_STATUSES.synced);
    assert.equal(linkG.conflicts, 205);
    assert.equal(G.engine.listConflicts().length, 205, "every removed record is kept (decision H6-19)");
    assert.ok(!G.engine.listConflicts().some((entry) => entry.id === "g-old"), "older entries make room");
    assert.ok(!G.sessions().some((session) => session.id.startsWith("g")));
  }

  // -------------------------------------------------------------------------
  // 401: signed out, unlinked, data untouched; signing in links again (H6-11).
  // -------------------------------------------------------------------------
  {
    const sessionsBefore = B.sessions();
    server.revokeAll(user);
    const unauthorized = await B.engine.syncNow();
    assert.equal(unauthorized.status, SYNC_STATUSES.signedOut);
    assert.equal(unauthorized.error.kind, "unauthorized");
    assert.equal(B.storage.readToken(), "", "the token is gone");
    assert.equal(B.meta().linked, false);
    assert.equal(B.meta().lastError.kind, "unauthorized");
    assert.equal(B.meta().deviceId, "B-id-1", "the meta stays (for the message)");
    assert.deepEqual(B.sessions(), sessionsBefore, "user data untouched");
    assert.deepEqual({ signedIn: B.engine.status().signedIn, linked: B.engine.status().linked }, { signedIn: false, linked: false });
    assert.equal(B.engine.status().lastError.kind, "unauthorized");
    const logged = server.log.length;
    assert.equal((await B.engine.syncNow()).status, SYNC_STATUSES.signedOut);
    assert.equal(server.log.length, logged, "no request without a token");

    assert.equal((await B.engine.signIn(credentials)).status, SYNC_STATUSES.needsLink);
    assert.notEqual(B.meta().deviceId, "B-id-1", "a new session is a new device id");
    const relink = await B.engine.applyLink("merge");
    assert.equal(relink.status, SYNC_STATUSES.synced);
    assert.equal(relink.conflicts, 0, "same data: nothing to keep");
    assert.equal(relink.pushed, 0);
    assert.deepEqual(B.sessions(), sessionsBefore);

    // A 401 on another authed call signs out too; a wrong password does not.
    await A.engine.signIn(credentials);
    await A.engine.applyLink("merge");
    const tokenA = A.storage.readToken();
    assert.equal((await A.engine.deleteAccount({ password: "wrong" })).error.code, "wrong_password");
    assert.equal(A.storage.readToken(), tokenA, "a wrong password keeps the session");
  }

  // -------------------------------------------------------------------------
  // Sign out (H6-3): revokes, clears token and meta, keeps data, works offline.
  // -------------------------------------------------------------------------
  {
    const sessionsA = A.sessions();
    const signOutCalls = server.count(SYNC_API_ROUTES.signOut);
    const out = await A.engine.signOut();
    assert.deepEqual(out, { ok: true, status: "signed-out", remoteOk: true, error: null });
    assert.equal(server.count(SYNC_API_ROUTES.signOut), signOutCalls + 1);
    assert.equal(A.storage.readToken(), "");
    assert.equal(A.meta(), null);
    assert.deepEqual(A.sessions(), sessionsA);

    server.down = true;
    const offlineOut = await C.engine.signOut({ everywhere: true });
    assert.equal(offlineOut.ok, true);
    assert.equal(offlineOut.remoteOk, false);
    assert.equal(offlineOut.error.kind, "offline");
    assert.equal(C.storage.readToken(), "");
    assert.equal(C.meta(), null);
    server.down = false;
    assert.equal(server.log.at(-1), SYNC_API_ROUTES.signOutAll);

    const wrongSignIn = await A.engine.signIn({ username: credentials.username, password: "nope" });
    assert.equal(wrongSignIn.ok, false);
    assert.equal(wrongSignIn.error.code, "invalid_credentials");
    assert.equal(A.meta(), null, "a failed sign-in stores nothing");

    // A token that cannot be saved leaves no half session.
    A.win.localStorage.failNextWriteForKey = "rpe-tracker.sync-token.v1";
    const unsaved = await A.engine.signIn(credentials);
    assert.equal(unsaved.ok, false);
    assert.equal(unsaved.error.code, "token_write");
    assert.equal(A.meta(), null);

    // Deleting the account signs out and keeps local data.
    assert.equal((await E.engine.syncNow()).status, SYNC_STATUSES.signedOut, "E's token was revoked above too");
    await E.engine.signIn(credentials);
    assert.equal((await E.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
    const sessionsE = E.sessions();
    assert.deepEqual(await E.engine.deleteAccount({ password: credentials.password }), { ok: true, status: "signed-out" });
    assert.equal(E.storage.readToken(), "");
    assert.equal(E.meta(), null);
    assert.deepEqual(E.sessions(), sessionsE);
  }

  // -------------------------------------------------------------------------
  // The API client: errors are values, the token never shows in a result.
  // -------------------------------------------------------------------------
  {
    const seen = [];
    const fakeFetch = async (url, init) => {
      seen.push({ url, init });
      const status = Number(new URL(url).searchParams.get("status") ?? 200);
      return {
        ok: status < 300,
        status,
        headers: { get: (name) => (name === "retry-after" ? "7" : null) },
        text: async () => (status === 299 ? "not json" : JSON.stringify(status < 300 ? { fine: true } : { error: { code: `c${status}` } })),
      };
    };
    const api = createSyncApi({ baseUrl: `${BASE_URL}/`, fetch: fakeFetch, getToken: () => "secret-token" });
    const okHealth = await api.health();
    assert.deepEqual(okHealth, { ok: true, data: { fine: true } });
    assert.equal(seen[0].url, `${BASE_URL}/v1/health`, "trailing slash trimmed");
    assert.equal(seen[0].init.headers.authorization, undefined, "health sends no token");
    assert.equal(seen[0].init.credentials, "omit");
    assert.equal(seen[0].init.cache, "no-store");
    await api.pull({ since: 12, limit: 3 });
    assert.equal(seen[1].url, `${BASE_URL}/v1/sync/pull?since=12&limit=3`);
    assert.equal(seen[1].init.headers.authorization, "Bearer secret-token");
    await api.push({ deviceId: "d", ops: [{ opId: "x".repeat(8), collection: "sessions", recordId: "s", baseRev: 0, deleted: true, body: { a: 1 }, hash: "h" }] });
    assert.deepEqual(JSON.parse(seen[2].init.body), {
      deviceId: "d",
      ops: [{ opId: "xxxxxxxx", collection: "sessions", recordId: "s", baseRev: 0, deleted: true, body: null }],
    }, "the client hash is never sent; a delete has no body");

    const statusApi = (status) =>
      createSyncApi({
        baseUrl: BASE_URL,
        fetch: (url, init) => fakeFetch(`${url.split("?")[0]}?status=${status}`, init),
        getToken: () => "secret-token",
      });
    const kinds = {};
    for (const status of [299, 400, 401, 403, 429, 500, 503]) {
      const result = await statusApi(status).getAccount();
      assert.equal(result.ok, false);
      kinds[status] = [result.error.kind, result.error.code, result.error.retryAfterMs];
      assert.ok(!JSON.stringify(result).includes("secret-token"));
    }
    assert.deepEqual(kinds, {
      299: ["server", "bad_response", null],
      400: ["rejected", "c400", null],
      401: ["unauthorized", "c401", null],
      403: ["rejected", "c403", null],
      429: ["rate_limited", "c429", 7000],
      500: ["server", "c500", null],
      503: ["server", "c503", null],
    });
    const thrown = await createSyncApi({ baseUrl: BASE_URL, fetch: async () => { throw new TypeError("down"); }, getToken: () => "t" }).getAccount();
    assert.deepEqual([thrown.error.kind, thrown.error.code], ["offline", "network"]);
    const noToken = await createSyncApi({ baseUrl: BASE_URL, fetch: fakeFetch, getToken: () => "" }).getAccount();
    assert.deepEqual([noToken.error.kind, noToken.error.code], ["unauthorized", "no_token"]);
    const notConfigured = await createSyncApi({ baseUrl: "", fetch: fakeFetch }).health();
    assert.deepEqual([notConfigured.error.kind, notConfigured.error.code], ["offline", "not_configured"]);

    // Timeout: the injected timer fires, the request is aborted.
    let fire;
    const slow = createSyncApi({
      baseUrl: BASE_URL,
      getToken: () => "t",
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
      fetch: (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    });
    const pending = slow.getAccount();
    fire();
    const timedOut = await pending;
    assert.deepEqual([timedOut.error.kind, timedOut.error.code], ["offline", "timeout"]);
  }

  console.log("Sync engine (H6-5 to H6-11) against the in-memory server verification passed.");
} finally {
  console.warn = originalWarn;
}
