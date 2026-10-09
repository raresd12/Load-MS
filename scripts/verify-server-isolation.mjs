import assert from "node:assert/strict";

import { createApi } from "../server/app.mjs";
import { SYNCABLE_COLLECTIONS } from "../server/collections.mjs";
import { openDatabase } from "../server/db.mjs";

// H6 Track A: tenant isolation (decisions H6-4, H6-13, handoff 16 H6 gate
// "two accounts cannot read/write each other's private records"). Two
// accounts on one in-memory database; every endpoint is driven with the
// other account's ids, op ids, collection names and forged user ids.

let now = Date.UTC(2026, 9, 7, 9, 0, 0);
const db = openDatabase(":memory:");
const api = createApi({ db, clock: () => now });
let ipCounter = 0;

async function call(method, path, { body, token } = {}) {
  const headers = {};

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  ipCounter += 1;
  const response = await api.fetch(
    new Request(`http://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ip: `10.7.${ipCounter >> 8}.${ipCounter & 255}` },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const password = `pw-${crypto.randomUUID()}`;
const alice = (await call("POST", "/v1/auth/signup", { body: { username: "iso-alice", password } })).body;
const bob = (await call("POST", "/v1/auth/signup", { body: { username: "iso-bob", password } })).body;
assert.ok(alice.token && bob.token);
assert.notEqual(alice.user.id, bob.user.id);

const op = (opId, collection, recordId, baseRev, body, extra = {}) => ({
  opId,
  collection,
  recordId,
  baseRev,
  deleted: body === null,
  body: body === null ? undefined : body,
  ...extra,
});

// Alice writes one record in every collection.
const aliceOps = SYNCABLE_COLLECTIONS.map((collection, index) =>
  op(`alice-op-${index}`, collection, `rec-${index}`, 0, { owner: "alice", collection, index }),
);
const alicePush = await call("POST", "/v1/sync/push", { token: alice.token, body: { deviceId: "alice-phone", ops: aliceOps } });
assert.equal(alicePush.status, 200);
assert.ok(alicePush.body.results.every((result) => result.status === "applied"));

async function snapshot(token) {
  const pulled = await call("GET", "/v1/sync/pull?since=0&limit=500", { token });
  assert.equal(pulled.status, 200);
  return pulled.body.records;
}

const aliceBefore = await snapshot(alice.token);
assert.equal(aliceBefore.length, SYNCABLE_COLLECTIONS.length);

// ---- reads -----------------------------------------------------------------------
assert.deepEqual(await snapshot(bob.token), [], "Bob's pull sees none of Alice's records");
for (const query of ["since=0&userId=" + alice.user.id, "since=0&user=" + alice.user.id, "since=0&user_id=" + alice.user.id]) {
  const forged = await call("GET", `/v1/sync/pull?${query}`, { token: bob.token });
  assert.deepEqual(forged.body.records, [], `a forged ${query.split("&")[1].split("=")[0]} parameter is ignored`);
}
const bobAccount = await call("GET", "/v1/account", { token: bob.token });
assert.equal(bobAccount.body.user.id, bob.user.id);
assert.equal(bobAccount.body.stats.records, 0, "Bob's stats never count Alice's records");
assert.equal(bobAccount.body.stats.bytes, 0);
assert.ok(Object.values(bobAccount.body.stats.collections).every((count) => count === 0));
const aliceAccount = await call("GET", "/v1/account", { token: alice.token });
assert.equal(aliceAccount.body.stats.records, SYNCABLE_COLLECTIONS.length);

// ---- writes with Alice's record ids, op ids and a forged user id --------------------
const bobOps = [
  // Alice's op id: must not return Alice's stored result.
  op("alice-op-0", "sessions", "rec-0", 0, { owner: "bob" }),
  // Alice's record id with Alice's current rev: Bob has no such record.
  op("bob-op-1", "programs", "rec-5", 1, { owner: "bob" }),
  // A delete of Alice's record id at Alice's rev.
  op("bob-op-2", "setupCues", "rec-2", 1, null),
  // Forged owner fields inside the op.
  op("bob-op-3", "nextPlans", "rec-1", 0, { owner: "bob" }, { userId: alice.user.id, user_id: alice.user.id }),
  // SQL-looking ids stay plain data.
  op("bob-op-4", "sessions", "rec-0' OR '1'='1", 0, { owner: "bob" }),
];
const bobPush = await call("POST", "/v1/sync/push", {
  token: bob.token,
  body: { deviceId: "bob-phone", userId: alice.user.id, ops: bobOps },
});
assert.equal(bobPush.status, 200);
assert.deepEqual(bobPush.body.results[0], { opId: "alice-op-0", status: "applied", rev: 1, seq: 1 }, "Bob's op id space is his own");
assert.equal(bobPush.body.results[1].status, "conflict", "Bob's baseRev 1 meets Bob's absent record, not Alice's");
assert.deepEqual(bobPush.body.results[1], { opId: "bob-op-1", status: "conflict", rev: 0, deleted: true, body: null });
assert.deepEqual(bobPush.body.results[2], { opId: "bob-op-2", status: "applied", rev: 0, seq: 0 }, "nothing of Alice's to delete");
assert.equal(bobPush.body.results[3].status, "applied");
assert.equal(bobPush.body.results[4].status, "applied");
assert.deepEqual(await snapshot(alice.token), aliceBefore, "Alice's records are untouched by every Bob write");
const bobRecords = await snapshot(bob.token);
assert.deepEqual(
  bobRecords.map((record) => [record.collection, record.recordId, record.body.owner]),
  [
    ["sessions", "rec-0", "bob"],
    ["nextPlans", "rec-1", "bob"],
    ["sessions", "rec-0' OR '1'='1", "bob"],
  ],
);
assert.ok(
  db.prepare("SELECT user_id FROM records WHERE device_id = 'bob-phone'").all().every((row) => row.user_id === bob.user.id),
  "every row Bob wrote is owned by Bob",
);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE user_id = ?").get(alice.user.id).n, SYNCABLE_COLLECTIONS.length);

// Alice's seq is hers: Bob's writes did not advance it.
const aliceNext = await call("POST", "/v1/sync/push", {
  token: alice.token,
  body: { deviceId: "alice-phone", ops: [op("alice-op-next", "sessions", "rec-new", 0, { owner: "alice" })] },
});
assert.equal(aliceNext.body.results[0].seq, SYNCABLE_COLLECTIONS.length + 1);

// ---- forged collection names --------------------------------------------------------
const forgedCollections = ["__proto__", "constructor", "users", "records", "tokens", "appUiState", "activeProgramId", "programStorageMeta", "sessions; DROP TABLE records", "Sessions", ""];
const forgedPush = await call("POST", "/v1/sync/push", {
  token: bob.token,
  body: { deviceId: "bob-phone", ops: forgedCollections.map((collection, index) => op(`bob-forged-${index}`, collection, "rec-0", 0, { x: 1 })) },
});
assert.ok(forgedPush.body.results.every((result) => result.status === "rejected" && result.code === "invalid_collection"));
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records").get().n, SYNCABLE_COLLECTIONS.length + 1 + 3);

// ---- tokens --------------------------------------------------------------------------
const aliceSecond = (await call("POST", "/v1/auth/signin", { body: { username: "iso-alice", password } })).body.token;
assert.equal((await call("POST", "/v1/auth/signout-all", { token: bob.token })).status, 200);
assert.equal((await call("GET", "/v1/account", { token: alice.token })).status, 200, "Bob's sign out everywhere leaves Alice signed in");
assert.equal((await call("GET", "/v1/account", { token: aliceSecond })).status, 200);
const bobAgain = (await call("POST", "/v1/auth/signin", { body: { username: "iso-bob", password } })).body.token;
const bobPassword = `pw-${crypto.randomUUID()}`;
assert.equal(
  (await call("POST", "/v1/auth/password", { token: bobAgain, body: { currentPassword: password, newPassword: bobPassword } })).status,
  200,
);
assert.equal((await call("GET", "/v1/account", { token: aliceSecond })).status, 200, "Bob's password change revokes none of Alice's tokens");
// Signing out with Alice's token as Bob is impossible: the token itself names the user.
assert.equal((await call("POST", "/v1/auth/signout", { token: aliceSecond })).status, 200);
assert.equal((await call("GET", "/v1/account", { token: alice.token })).status, 200, "only the presented token goes");

// ---- account deletion ----------------------------------------------------------------
const bobDelete = await call("POST", "/v1/account/delete", { token: bobAgain, body: { password: bobPassword, userId: alice.user.id } });
assert.equal(bobDelete.status, 200);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ?").get(bob.user.id).n, 0);
const aliceAfter = await snapshot(alice.token);
assert.equal(aliceAfter.length, SYNCABLE_COLLECTIONS.length + 1, "deleting Bob removes none of Alice's records");
assert.deepEqual(aliceAfter.slice(0, SYNCABLE_COLLECTIONS.length), aliceBefore);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE user_id = ?").get(alice.user.id).n, SYNCABLE_COLLECTIONS.length + 1);
assert.equal((await call("GET", "/v1/account", { token: alice.token })).status, 200);

// Alice's password cannot delete through a stale Bob token.
assert.equal((await call("POST", "/v1/account/delete", { token: bobAgain, body: { password } })).status, 401);
assert.equal((await call("GET", "/v1/account", { token: alice.token })).body.stats.records, SYNCABLE_COLLECTIONS.length + 1);

api.close();
now += 1;
console.log("verify-server-isolation: ok");
