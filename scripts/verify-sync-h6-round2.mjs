import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Phase H6 fix round 2, client side: the real engine against the real
// createApi, in process, plus the scheduler and the App's two-tab refresh.
// - H6-34 / H6-45: a lost push request whose edit is then undone leaves no
//   stale in-flight hash, so a later identical edit from another device is
//   never taken for this device's own write and reverted;
// - H6-43: conflicts the server answers without a body are sent again until
//   each one has its server version; nothing is kept with a null body;
// - H6-45: a write whose timer fires while a sync runs is synced right after
//   that sync, not at the next focus or interval;
// - H6-46: two tabs with different logged sets for the same draft do not
//   rewrite the drafts key back and forth without end.

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
const { planSyncRefresh, storageEventKeys, SYNC_REFRESH_SOURCES, workoutDraftsAfterRefresh } = await import(
  "../src/lib/accountView.js"
);
const { createSyncScheduler, SYNC_WRITE_DELAY_MS } = await import("../src/components/account/syncScheduler.js");
const { recordKey } = await import("../src/lib/syncRecords.js");

const APP_ORIGIN = "http://127.0.0.1:5173";
const BASE_URL = "http://127.0.0.1:3100";
const RATE_LIMITS = {
  auth: [{ windowMs: 60_000, max: 1000 }],
  signup: [{ windowMs: 3_600_000, max: 100 }],
  sync: [{ windowMs: 60_000, max: 10_000 }],
};

function createServer(limits = {}) {
  const db = openDatabase(":memory:");
  const api = createApi({ db, config: { allowedOrigins: [APP_ORIGIN], maxAccounts: 20, rateLimits: RATE_LIMITS, limits } });
  const body = (userId, collection, recordId) => {
    const row = db
      .prepare("SELECT body, deleted FROM records WHERE user_id = ? AND collection = ? AND record_id = ?")
      .get(userId, collection, recordId);
    return row && !row.deleted ? JSON.parse(row.body) : null;
  };
  return { db, api, body, network: { drop: null, dropPath: null, pushes: [] } };
}

function createShimFetch(server, ip) {
  return async (url, init = {}) => {
    const { pathname } = new URL(url);
    const { network } = server;
    const drop = network.drop && (!network.dropPath || pathname === network.dropPath) ? network.drop : null;

    if (drop === "request") {
      // The request never reaches the server.
      network.drop = null;
      throw new TypeError("Failed to fetch");
    }

    if (pathname === "/v1/sync/push" && typeof init.body === "string") {
      network.pushes.push({ ip, ops: JSON.parse(init.body).ops.length });
    }

    const response = await server.api.fetch(
      new Request(url, { method: init.method, headers: { ...(init.headers ?? {}), origin: APP_ORIGIN }, body: init.body }),
      { ip },
    );

    if (drop === "response") {
      network.drop = null;
      await response.text();
      throw new TypeError("Failed to fetch");
    }

    return response;
  };
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
  const ip = `10.9.0.${index}`;
  const syncApi = createSyncApi({ baseUrl: BASE_URL, fetch: createShimFetch(server, ip), getToken: () => storage.readToken() });
  const device = { name, win, storage, ip };
  device.engine = createSyncEngine({ api: syncApi, storage, lock: createMemoryLock() });
  device.on = (fn) => {
    globalThis.window = win;
    return fn();
  };
  device.sessions = () => device.on(() => readStorage(STORAGE_KEYS.sessions, []));
  device.session = (id) => device.sessions().find((session) => session.id === id);
  device.write = (value) => device.on(() => writeStorage(STORAGE_KEYS.sessions, value));
  device.editSession = (id, patch) =>
    device.write(device.sessions().map((session) => (session.id === id ? { ...session, ...patch } : session)));
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

const credentials = () => ({ username: `r2${randomUUID().slice(0, 8)}`, password: `pw-${randomUUID()}` });

async function linkPair(server, sessions) {
  const user = credentials();
  const a = createDevice(server, `a-${user.username}`, 1);
  const b = createDevice(server, `b-${user.username}`, 2);
  a.write(sessions);
  assert.equal((await a.engine.signUp(user)).ok, true);
  assert.equal((await a.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
  assert.equal((await b.engine.signIn(user)).ok, true);
  assert.equal((await b.engine.applyLink("merge")).status, SYNC_STATUSES.synced);
  return { a, b };
}

let checks = 0;

// ---------------------------------------------------------------------------
// A lost push request, then an undo: no stale in-flight hash survives
// ---------------------------------------------------------------------------
{
  const server = createServer();
  const { a, b } = await linkPair(server, [sessionRecord("s-1", "v0")]);
  const key = recordKey("sessions", "s-1");

  a.editSession("s-1", { sessionNotes: "v1" });
  server.network.drop = "request";
  server.network.dropPath = "/v1/sync/push";
  assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.offline, "the push request is lost");
  assert.equal(server.body(a.userId(), "sessions", "s-1").sessionNotes, "v0", "the server never saw it");
  assert.ok(a.meta().inflight[key]?.length, "the op was recorded in flight");

  a.editSession("s-1", { sessionNotes: "v0" });
  assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.synced);
  assert.deepEqual(a.meta().inflight, {}, "a completed sync that sent nothing for the record drops its in-flight hashes");

  b.editSession("s-1", { sessionNotes: "v1" });
  assert.equal((await b.engine.syncNow()).status, SYNC_STATUSES.synced);
  const pulled = await a.engine.syncNow();
  assert.equal(pulled.status, SYNC_STATUSES.synced);
  assert.equal(a.session("s-1").sessionNotes, "v1", "B's later edit reaches A");
  assert.equal(server.body(a.userId(), "sessions", "s-1").sessionNotes, "v1", "and stays on the account");
  await b.engine.syncNow();
  assert.equal(b.session("s-1").sessionNotes, "v1", "B keeps its edit");
  checks += 1;

  // The lost-answer case of H6-34 still works: the server applied the op,
  // the device undoes it, and the undo wins in the same sync.
  a.editSession("s-1", { sessionNotes: "typo" });
  server.network.drop = "response";
  server.network.dropPath = "/v1/sync/push";
  assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.offline);
  a.editSession("s-1", { sessionNotes: "v1" });
  const undone = await a.engine.syncNow();
  assert.equal(undone.status, SYNC_STATUSES.synced);
  assert.equal(a.session("s-1").sessionNotes, "v1");
  assert.equal(server.body(a.userId(), "sessions", "s-1").sessionNotes, "v1");
  assert.deepEqual(a.meta().inflight, {});
  checks += 1;
}

// ---------------------------------------------------------------------------
// Conflicts answered without a body are sent again (H6-43)
// ---------------------------------------------------------------------------
{
  const server = createServer({ pushConflictBytes: 1500 });
  const notes = (who, id) => `${who}-${id}-`.repeat(120);
  const ids = ["c-1", "c-2", "c-3"];
  const { a, b } = await linkPair(server, ids.map((id) => sessionRecord(id, "base")));

  ids.forEach((id) => a.editSession(id, { sessionNotes: notes("A", id) }));
  assert.equal((await a.engine.syncNow()).status, SYNC_STATUSES.synced);
  ids.forEach((id) => b.editSession(id, { sessionNotes: notes("B", id) }));
  server.network.pushes.length = 0;
  const result = await b.engine.syncNow();
  assert.equal(result.status, SYNC_STATUSES.synced);
  assert.equal(result.conflicts, 3, "every conflict is kept");
  assert.equal(result.waiting, 0);
  const pushes = server.network.pushes.filter((push) => push.ip === b.ip).map((push) => push.ops);
  assert.deepEqual(pushes, [3, 2, 1], "the ops without a body are sent again until each has one");
  for (const id of ids) {
    assert.equal(b.session(id).sessionNotes, notes("A", id), "the account's version is live");
    assert.equal(server.body(b.userId(), "sessions", id).sessionNotes, notes("A", id));
  }
  const kept = b.engine.listConflicts();
  assert.deepEqual(kept.map((entry) => entry.recordId).sort(), ids);
  assert.ok(kept.every((entry) => entry.body?.sessionNotes?.startsWith("B-")), "B's versions are kept aside");
  checks += 1;
}

// ---------------------------------------------------------------------------
// The scheduler: a write timer that fires during a sync (H6-45)
// ---------------------------------------------------------------------------
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();

  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const id = nextId++;
        tasks.set(id, { fn, at: now + ms, every: null });
        return id;
      },
      clearTimeout(id) {
        tasks.delete(id);
      },
      setInterval(fn, ms) {
        const id = nextId++;
        tasks.set(id, { fn, at: now + ms, every: ms });
        return id;
      },
      clearInterval(id) {
        tasks.delete(id);
      },
    },
    async advance(ms) {
      const end = now + ms;

      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= end).sort((x, y) => x[1].at - y[1].at)[0];

        if (!due) {
          break;
        }

        const [id, task] = due;
        now = task.at;

        if (task.every) {
          task.at += task.every;
        } else {
          tasks.delete(id);
        }

        task.fn();
        await flush();
      }

      now = end;
      await flush();
    },
  };
}

async function flush() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function writeDuringSync({ waitingAfter }) {
  const clock = createFakeTimers();
  const calls = [];
  let onWrite = null;
  const engine = {
    status: () => ({ signedIn: true, linked: true, failures: 0, retryDelayMs: 0, waiting: 0 }),
    refreshWaiting: async () => waitingAfter,
    syncNow() {
      calls.push(clock.now());
      return new Promise((resolve) => clock.timers.setTimeout(() => resolve({ status: "synced", waiting: waitingAfter }), 6000));
    },
  };
  const scheduler = createSyncScheduler({
    engine,
    subscribeWrites: (fn) => {
      onWrite = fn;
      return () => {
        onWrite = null;
      };
    },
    timers: clock.timers,
    clock: clock.now,
  });
  scheduler.start();
  scheduler.run("launch");
  await clock.advance(1000);
  onWrite({ reason: "write", keys: [STORAGE_KEYS.sessions] });
  await clock.advance(SYNC_WRITE_DELAY_MS);
  assert.equal(calls.length, 1, "the write timer fired while the launch sync was running");
  await clock.advance(1000);
  await clock.advance(6000);
  scheduler.stop();
  return calls;
}

{
  const calls = await writeDuringSync({ waitingAfter: 1 });
  assert.deepEqual(calls, [0, 6000], "the write is synced as soon as the running sync ends");
  const idle = await writeDuringSync({ waitingAfter: 0 });
  assert.deepEqual(idle, [0], "nothing waiting: no second request");
  checks += 1;
}

// ---------------------------------------------------------------------------
// Two tabs, the same open draft, different logged sets (H6-46)
// ---------------------------------------------------------------------------
function runTwoTabs(source) {
  const area = { name: "local" };
  const stored = new Map();
  const queue = [];
  const tabs = [];
  let writes = 0;
  const key = STORAGE_KEYS.workoutDrafts;

  function createTab(name, drafts) {
    const tab = { name, drafts };
    // useLocalStorageState writes every new value; the browser fires a
    // storage event in the other tabs only when the stored text changed.
    tab.setDrafts = (value) => {
      tab.drafts = value;
      const text = JSON.stringify(value);

      if (stored.get(key) !== text) {
        stored.set(key, text);
        writes += 1;
        tabs.filter((other) => other !== tab).forEach((other) => queue.push({ tab: other, event: { key, storageArea: area } }));
      }
    };
    tab.onStorage = (event) => {
      const keys = storageEventKeys(event, area);
      const plan = planSyncRefresh({ keys, hasUnsavedDraft: true, source });

      if (plan.workoutDrafts) {
        tab.setDrafts(workoutDraftsAfterRefresh(JSON.parse(stored.get(key)), tab.drafts, "day-1", plan));
      }
    };
    tabs.push(tab);
    return tab;
  }

  const first = createTab("tab-3", { "day-1": { sets: [1] } });
  const second = createTab("tab-4", { "day-1": { sets: [1] } });
  stored.set(key, JSON.stringify(first.drafts));
  second.setDrafts({ "day-1": { sets: [1, 2] } });

  let steps = 0;

  while (queue.length && steps < 500) {
    const { tab, event } = queue.shift();
    tab.onStorage(event);
    steps += 1;
  }

  return { writes, steps, settled: queue.length === 0, tabs: [first.drafts, second.drafts], stored: JSON.parse(stored.get(key)) };
}

{
  const pullStyle = runTwoTabs(SYNC_REFRESH_SOURCES.sync);
  assert.equal(pullStyle.settled, false, "harness check: keeping the own entry on both tabs never settles");

  const tabStyle = runTwoTabs(SYNC_REFRESH_SOURCES.tab);
  assert.equal(tabStyle.settled, true, "another tab's write settles");
  assert.ok(tabStyle.writes <= 2, `a bounded number of writes (${tabStyle.writes})`);
  assert.deepEqual(tabStyle.stored, { "day-1": { sets: [1, 2] } }, "the newest write stays");
  assert.deepEqual(tabStyle.tabs, [tabStyle.stored, tabStyle.stored], "both tabs show it");

  const tabPlan = planSyncRefresh({ keys: [STORAGE_KEYS.workoutDrafts, STORAGE_KEYS.nextPlans], hasUnsavedDraft: true, source: SYNC_REFRESH_SOURCES.tab });
  assert.equal(tabPlan.keepDraftEntry, false, "another tab's draft is taken");
  assert.equal(tabPlan.holdPlan, true, "the open day's plan is still held");
  const pullPlan = planSyncRefresh({ keys: [STORAGE_KEYS.workoutDrafts], hasUnsavedDraft: true });
  assert.equal(pullPlan.keepDraftEntry, true, "a pull still keeps the open draft's entry (H6-26)");
  const pulled = { "day-1": { v: 1 } };
  assert.equal(workoutDraftsAfterRefresh(pulled, { "day-1": { v: 2 } }, "day-1", tabPlan), pulled);
  assert.deepEqual(workoutDraftsAfterRefresh(pulled, { "day-1": { v: 2 } }, "day-1", pullPlan), { "day-1": { v: 2 } });

  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(app, /applySyncedKeysRef\.current = \(keys, source = SYNC_REFRESH_SOURCES\.sync\) =>/);
  assert.match(app, /planSyncRefresh\(\{ keys, hasUnsavedDraft, source \}\)/);
  assert.match(app, /applySyncedKeysRef\.current\?\.\(keys, SYNC_REFRESH_SOURCES\.tab\)/, "the storage event is another tab's write");
  assert.match(app, /event\.reason === STORAGE_WRITE_REASONS\.sync\)[\s\S]{0,40}applySyncedKeysRef\.current\?\.\(event\.keys\)/, "a pull keeps the pull rules");
  checks += 1;
}

console.log(`Sync H6 round 2 (H6-34, H6-43, H6-45, H6-46) verification passed (${checks} checks).`);
