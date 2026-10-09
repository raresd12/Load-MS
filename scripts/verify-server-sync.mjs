import assert from "node:assert/strict";

import { createApi, DEFAULT_LIMITS } from "../server/app.mjs";
import { canonicalJson, contentHash, sha256Hex } from "../server/canonical.mjs";
import { SYNCABLE_COLLECTIONS } from "../server/collections.mjs";
import { openDatabase } from "../server/db.mjs";

// H6 Track A: the record store, idempotent push, conflicts, convergence,
// tombstones, pull paging, quotas and per-op rejection (decisions H6-4 to
// H6-6, H6-14 to H6-17). Real createApi on in-memory databases.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function setup(config = {}) {
  const state = { now: Date.UTC(2026, 9, 7, 10, 0, 0) };
  const db = openDatabase(":memory:");
  const api = createApi({ db, config, clock: () => state.now });
  let ipCounter = 0;

  async function call(method, path, { body, token, rawBody, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };

    if (body !== undefined || rawBody !== undefined) {
      init.headers["content-type"] ??= "application/json";
      init.body = rawBody ?? JSON.stringify(body);
    }

    if (token) {
      init.headers.authorization = `Bearer ${token}`;
    }

    ipCounter += 1;
    const response = await api.fetch(new Request(`http://api.test${path}`, init), { ip: `10.5.${ipCounter >> 8}.${ipCounter & 255}` });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function account(username) {
    const result = await call("POST", "/v1/auth/signup", { body: { username, password: `pw-${crypto.randomUUID()}` } });
    assert.equal(result.status, 201);
    return result.body;
  }

  // Bypasses the per-user request limit for bulk checks.
  state.push = (token, ops, deviceId = "device-1") => call("POST", "/v1/sync/push", { token, body: { deviceId, ops } });
  state.pull = (token, query = "since=0") => call("GET", `/v1/sync/pull?${query}`, { token });
  return { state, db, api, call, account };
}

const op = (opId, collection, recordId, baseRev, body) => ({
  opId,
  collection,
  recordId,
  baseRev,
  deleted: body === null,
  ...(body === null ? {} : { body }),
});

// ---- canonical JSON ---------------------------------------------------------------
assert.equal(canonicalJson({ b: 1, a: [3, { d: 1, c: 2 }] }), '{"a":[3,{"c":2,"d":1}],"b":1}');
assert.equal(canonicalJson({ 10: "x", 2: "y", b: 1, a: 2 }), '{"10":"x","2":"y","a":2,"b":1}', "numeric-looking keys sort as text");
assert.equal(canonicalJson({ a: undefined, b: () => 1, c: [undefined, NaN, Infinity, -0] }), '{"c":[null,null,null,0]}');
assert.equal(canonicalJson({ when: new Date(Date.UTC(2026, 0, 2)) }), '{"when":"2026-01-02T00:00:00.000Z"}');
assert.equal(canonicalJson("é "), JSON.stringify("é "));
assert.equal(canonicalJson(undefined), undefined);
assert.equal(canonicalJson(null), "null");
assert.equal(canonicalJson({ B: 1, a: 1, _: 1, Z: 1 }), '{"B":1,"Z":1,"_":1,"a":1}', "code-unit order");
const cyclic = { a: 1 };
cyclic.self = cyclic;
assert.throws(() => canonicalJson(cyclic), TypeError);
assert.throws(() => canonicalJson({ n: 1n }), TypeError);
for (const sample of [{ z: 1, y: { x: [1, "2", true, null] } }, [], {}, "text", 12.5, false]) {
  assert.deepEqual(JSON.parse(canonicalJson(sample)), sample, "canonical JSON parses back to the same value");
}
assert.equal(contentHash({ b: 2, a: 1 }, false), sha256Hex('{"a":1,"b":2}'));
assert.equal(contentHash({ any: 1 }, true), "deleted");
assert.match(sha256Hex("x"), /^[0-9a-f]{64}$/);

// ---- limits match H6-4 / H6-5 / H6-6 ---------------------------------------------------
assert.equal(DEFAULT_LIMITS.bodyBytes, 512 * 1024);
assert.equal(DEFAULT_LIMITS.userBytes, 25 * 1024 * 1024);
assert.equal(DEFAULT_LIMITS.userRecords, 50_000);
assert.equal(DEFAULT_LIMITS.requestBytes, 4 * 1024 * 1024);
assert.equal(DEFAULT_LIMITS.opsPerPush, 200);
assert.equal(DEFAULT_LIMITS.pullLimit, 500);
assert.equal(DEFAULT_LIMITS.appliedOpsTtlMs, 90 * DAY);

const main = setup();
const { db, state, call } = main;
const me = await main.account("sync-user");
const token = me.token;
const userSeq = () => db.prepare("SELECT seq FROM users WHERE id = ?").get(me.user.id).seq;
const countRecords = () => db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ?").get(me.user.id).n;

// ---- apply ------------------------------------------------------------------------------
const first = await state.push(token, [
  { ...op("op-create-s1", "sessions", "s1", 0, { id: "s1", sets: [1, 2], date: "2026-10-07" }), hash: "client-hash-is-ignored" },
]);
assert.equal(first.status, 200);
assert.match(first.body.epoch, /^[0-9a-f]{32}$/, "every push answer names the database epoch (decision H6-31)");
assert.deepEqual(first.body, { results: [{ opId: "op-create-s1", status: "applied", rev: 1, seq: 1 }], epoch: first.body.epoch });
const storedRow = db.prepare("SELECT * FROM records WHERE record_id = 's1'").get();
assert.equal(storedRow.hash, contentHash({ id: "s1", sets: [1, 2], date: "2026-10-07" }, false), "the server computes the hash itself");
assert.equal(storedRow.device_id, "device-1");
assert.equal(storedRow.body, '{"date":"2026-10-07","id":"s1","sets":[1,2]}');
assert.equal(storedRow.updated_at, state.now);

const update = await state.push(token, [op("op-update-s1", "sessions", "s1", 1, { id: "s1", sets: [1, 2, 3] })]);
assert.deepEqual(update.body.results[0], { opId: "op-update-s1", status: "applied", rev: 2, seq: 2 });

// ---- idempotent replay: whole request, single ops, duplicates ------------------------------
const batch = [
  op("op-batch-a", "readinessByDate", "2026-10-07", 0, { score: 7 }),
  op("op-batch-b", "programs", "p1", 0, { id: "p1", name: "Mine" }),
];
const firstSend = await state.push(token, batch);
const seqAfterFirst = userSeq();
const recordsAfterFirst = countRecords();
const replay = await state.push(token, batch);
assert.deepEqual(replay.body, firstSend.body, "a replayed request gets the same answers");
assert.equal(userSeq(), seqAfterFirst, "a replay never advances seq");
assert.equal(countRecords(), recordsAfterFirst, "a replay never adds a record");
const mixed = await state.push(token, [
  op("op-batch-b", "programs", "p1", 0, { id: "p1", name: "Mine" }),
  op("op-new-c", "programDays", "d1", 0, { id: "d1" }),
  op("op-new-c", "programDays", "d1", 0, { id: "d1" }),
]);
assert.deepEqual(mixed.body.results[0], firstSend.body.results[1], "a single replayed op returns its stored result");
assert.equal(mixed.body.results[1].status, "applied");
assert.deepEqual(mixed.body.results[2], mixed.body.results[1], "a duplicate op id in one request applies once");
assert.equal(userSeq(), seqAfterFirst + 1);
// The same session pushed again under its op id after a lost response: still one session.
await state.push(token, [op("op-update-s1", "sessions", "s1", 1, { id: "s1", sets: [1, 2, 3] })]);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection = 'sessions'").get().n, 1);
assert.equal(db.prepare("SELECT rev FROM records WHERE record_id = 's1'").get().rev, 2);

// ---- conflict ---------------------------------------------------------------------------
const seqBeforeConflict = userSeq();
const conflict = await state.push(token, [op("op-stale-s1", "sessions", "s1", 1, { id: "s1", sets: ["other device"] })]);
assert.deepEqual(conflict.body.results[0], {
  opId: "op-stale-s1",
  status: "conflict",
  rev: 2,
  deleted: false,
  body: { id: "s1", sets: [1, 2, 3] },
});
assert.equal(userSeq(), seqBeforeConflict, "a conflict changes nothing");
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = 'op-stale-s1'").get().n, 0, "a conflict is not stored");
assert.equal(db.prepare("SELECT rev FROM records WHERE record_id = 's1'").get().rev, 2, "the server keeps its version");
// "Keep this version": the same body on top of the server rev, as a new op.
const keep = await state.push(token, [op("op-keep-s1", "sessions", "s1", 2, { id: "s1", sets: ["other device"] })]);
assert.deepEqual(keep.body.results[0], { opId: "op-keep-s1", status: "applied", rev: 3, seq: seqBeforeConflict + 1 });
// The conflicted op retried now finds equal content: it converges.
const retried = await state.push(token, [op("op-stale-s1", "sessions", "s1", 1, { sets: ["other device"], id: "s1" })]);
assert.deepEqual(retried.body.results[0], { opId: "op-stale-s1", status: "applied", rev: 3, seq: seqBeforeConflict + 1 });

// ---- converge on equal hash ---------------------------------------------------------------
const seqBeforeConverge = userSeq();
const converge = await state.push(token, [op("op-converge-p1", "programs", "p1", 0, { name: "Mine", id: "p1" })]);
assert.deepEqual(converge.body.results[0], { opId: "op-converge-p1", status: "applied", rev: 1, seq: firstSend.body.results[1].seq });
assert.equal(userSeq(), seqBeforeConverge, "converging writes nothing new");
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = 'op-converge-p1'").get().n, 1);

// ---- tombstones ----------------------------------------------------------------------------
const del = await state.push(token, [op("op-delete-p1", "programs", "p1", 1, null)]);
assert.equal(del.body.results[0].status, "applied");
assert.equal(del.body.results[0].rev, 2);
const tomb = db.prepare("SELECT deleted, body, hash, size FROM records WHERE record_id = 'p1'").get();
assert.deepEqual({ ...tomb }, { deleted: 1, body: null, hash: "deleted", size: 0 });
const staleEdit = await state.push(token, [op("op-stale-p1", "programs", "p1", 1, { id: "p1", name: "Edited offline" })]);
assert.deepEqual(staleEdit.body.results[0], { opId: "op-stale-p1", status: "conflict", rev: 2, deleted: true, body: null });
const staleDelete = await state.push(token, [op("op-stale-del-p1", "programs", "p1", 1, null)]);
assert.equal(staleDelete.body.results[0].status, "applied", "a stale delete of a deleted record converges");
assert.equal(staleDelete.body.results[0].rev, 2);
const recreate = await state.push(token, [op("op-recreate-p1", "programs", "p1", 2, { id: "p1", name: "Back" })]);
assert.deepEqual(recreate.body.results[0].rev, 3);
const absentDelete = await state.push(token, [
  op("op-absent-del-0", "setupCues", "never-there", 0, null),
  op("op-absent-del-5", "setupCues", "gone-after-restore", 5, null),
]);
assert.equal(absentDelete.body.results[0].rev, 1, "a delete at baseRev 0 of an absent record writes a tombstone (H6-5)");
assert.deepEqual(absentDelete.body.results[1], { opId: "op-absent-del-5", status: "applied", rev: 0, seq: 0 }, "an absent record already reads as deleted (H6-14)");
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records WHERE record_id = 'gone-after-restore'").get().n, 0);
const absentEdit = await state.push(token, [op("op-absent-edit", "setupCues", "gone-after-restore", 5, { cue: "x" })]);
assert.deepEqual(absentEdit.body.results[0], { opId: "op-absent-edit", status: "conflict", rev: 0, deleted: true, body: null });

// ---- account stats count live records ------------------------------------------------------
const stats = await call("GET", "/v1/account", { token });
const live = db.prepare("SELECT COUNT(*) AS n, SUM(size) AS bytes FROM records WHERE user_id = ? AND deleted = 0").get(me.user.id);
assert.equal(stats.body.stats.records, live.n);
assert.equal(stats.body.stats.bytes, live.bytes);
assert.deepEqual(Object.keys(stats.body.stats.collections), [...SYNCABLE_COLLECTIONS]);
assert.equal(stats.body.stats.collections.setupCues, 0, "tombstones are not live records");
assert.equal(stats.body.stats.collections.sessions, 1);

// ---- pull ------------------------------------------------------------------------------------
const all = await state.pull(token, "since=0&limit=500");
assert.equal(all.status, 200);
assert.deepEqual(Object.keys(all.body), ["records", "nextSince", "more", "epoch"]);
assert.equal(all.body.epoch, first.body.epoch);
const seqs = all.body.records.map((record) => record.seq);
assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "records come in seq order");
assert.equal(all.body.nextSince, seqs.at(-1));
assert.equal(all.body.more, false);
assert.equal(new Set(all.body.records.map((record) => `${record.collection}/${record.recordId}`)).size, all.body.records.length, "one entry per record");
const s1 = all.body.records.find((record) => record.recordId === "s1");
assert.deepEqual(s1, { collection: "sessions", recordId: "s1", rev: 3, seq: seqBeforeConflict + 1, deleted: false, body: { id: "s1", sets: ["other device"] } });
const tombstone = all.body.records.find((record) => record.recordId === "never-there");
assert.deepEqual(tombstone, { collection: "setupCues", recordId: "never-there", rev: 1, seq: tombstone.seq, deleted: true, body: null });

const pages = [];
let since = 0;
for (;;) {
  const page = await state.pull(token, `since=${since}&limit=3`);
  assert.ok(page.body.records.length <= 3);
  pages.push(page.body);
  since = page.body.nextSince;
  if (!page.body.more) {
    break;
  }
}
assert.deepEqual(pages.flatMap((page) => page.records), all.body.records, "paging with since / limit returns the same records");
assert.ok(pages.slice(0, -1).every((page) => page.more === true && page.records.length === 3));
const empty = await state.pull(token, `since=${since}&limit=3`);
assert.deepEqual(empty.body, { records: [], nextSince: since, more: false, epoch: first.body.epoch });
const far = await state.pull(token, "since=999999");
assert.deepEqual(far.body, { records: [], nextSince: 999999, more: false, epoch: first.body.epoch });
const defaults = await state.pull(token, "");
assert.equal(defaults.body.records.length, all.body.records.length, "since defaults to 0, limit to 500");

for (const query of ["since=-1", "since=abc", "since=1.5", "limit=0", "limit=501", "limit=x", "since=0&limit=-3"]) {
  const bad = await state.pull(token, query);
  assert.equal(bad.status, 400, `pull ${query} is refused`);
  assert.equal(bad.body.error.code, "invalid_request");
}

// An updated record moves to the end of the feed.
await state.push(token, [op("op-update-d1", "programDays", "d1", 1, { id: "d1", name: "moved" })]);
const tail = await state.pull(token, `since=${since}`);
assert.deepEqual(tail.body.records.map((record) => record.recordId), ["d1"]);

// ---- per-op rejection -------------------------------------------------------------------------
const mixedOps = [
  null,
  op("short", "sessions", "x", 0, {}),
  op("x".repeat(201), "sessions", "x", 0, {}),
  op("op-reject-coll", "appUiState", "x", 0, {}),
  op("op-reject-rid0", "sessions", "", 0, {}),
  op("op-reject-rid1", "sessions", "r".repeat(301), 0, {}),
  op("op-ok-rid300", "sessions", "r".repeat(300), 0, { id: "long" }),
  op("op-reject-base1", "sessions", "x", -1, {}),
  op("op-reject-base2", "sessions", "x", 1.5, {}),
  op("op-reject-base3", "sessions", "x", "1", {}),
  { ...op("op-reject-del", "sessions", "x", 0, {}), deleted: "false" },
  { opId: "op-reject-body", collection: "sessions", recordId: "x", baseRev: 0, deleted: false },
  op("op-reject-big", "sessions", "big", 0, { blob: "b".repeat(512 * 1024) }),
  op("op-ok-after", "sessions", "after", 0, { id: "after" }),
];
const rejected = await state.push(token, mixedOps);
assert.equal(rejected.status, 200, "bad ops never fail the request");
assert.deepEqual(
  rejected.body.results.map((result) => (result.status === "rejected" ? result.code : result.status)),
  [
    "invalid_op",
    "invalid_op_id",
    "invalid_op_id",
    "invalid_collection",
    "invalid_record_id",
    "invalid_record_id",
    "applied",
    "invalid_base_rev",
    "invalid_base_rev",
    "invalid_base_rev",
    "invalid_deleted",
    "invalid_body",
    "body_too_large",
    "applied",
  ],
);
assert.equal(rejected.body.results[0].opId, null);
assert.equal(rejected.body.results[3].opId, "op-reject-coll");
const bodyAtLimit = { blob: "b".repeat(512 * 1024 - '{"blob":""}'.length) };
assert.equal(Buffer.byteLength(canonicalJson(bodyAtLimit)), 512 * 1024);
assert.equal((await state.push(token, [op("op-ok-512k", "sessions", "at-limit", 0, bodyAtLimit)])).body.results[0].status, "applied", "exactly 512 kB is allowed");
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE op_id LIKE 'op-reject-%'").get().n, 0, "a rejection is never stored");
for (const collection of SYNCABLE_COLLECTIONS) {
  const result = await state.push(token, [op(`op-all-${collection}`, collection, "all-collections", 0, { collection })]);
  assert.equal(result.body.results[0].status, "applied", `${collection} is syncable`);
}

// Whole-request shape errors.
for (const [body, code] of [
  [{ ops: [] }, "invalid_request"],
  [{ deviceId: "", ops: [] }, "invalid_request"],
  [{ deviceId: "d", ops: {} }, "invalid_request"],
  [{ deviceId: "d", ops: Array.from({ length: 201 }, (_, index) => op(`op-many-${index}`, "sessions", `m${index}`, 0, {})) }, "too_many_ops"],
]) {
  const result = await call("POST", "/v1/sync/push", { token, body });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, code);
}
const maxOps = await state.push(token, Array.from({ length: 200 }, (_, index) => op(`op-max-${index}`, "workoutDrafts", `w${index}`, 0, { index })));
assert.equal(maxOps.body.results.length, 200, "200 ops in one request are allowed");
assert.ok(maxOps.body.results.every((result) => result.status === "applied"));
assert.equal((await call("POST", "/v1/sync/push", { token, rawBody: "{not json" })).body.error.code, "invalid_json");
assert.equal((await call("POST", "/v1/sync/push", { token, rawBody: "[]" })).body.error.code, "invalid_request");
const wrongType = await call("POST", "/v1/sync/push", { token, rawBody: "{}", headers: { "content-type": "text/plain" } });
assert.equal(wrongType.status, 415);
const huge = await call("POST", "/v1/sync/push", { token, rawBody: JSON.stringify({ deviceId: "d", ops: [], pad: "p".repeat(4 * 1024 * 1024) }) });
assert.equal(huge.status, 413, "a request over 4 MB is refused");
assert.equal(huge.body.error.code, "payload_too_large");
const unauth = await call("POST", "/v1/sync/push", { body: { deviceId: "d", ops: [] } });
assert.equal(unauth.status, 401);
assert.equal((await call("GET", "/v1/sync/pull?since=0")).status, 401);

// ---- applied_ops are kept 90 days --------------------------------------------------------------
const opsBefore = db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE user_id = ?").get(me.user.id).n;
assert.ok(opsBefore > 0);
state.now += 89 * DAY;
await state.push(token, []);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE user_id = ?").get(me.user.id).n, opsBefore, "kept for 90 days");
state.now += 2 * DAY;
await state.push(token, []);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE user_id = ?").get(me.user.id).n, 0, "pruned after 90 days");
// A very late retry of a pruned op still never duplicates: it converges.
const seqLate = userSeq();
const late = await state.push(token, [op("op-update-s1", "sessions", "s1", 1, { id: "s1", sets: ["other device"] })]);
assert.equal(late.body.results[0].status, "applied");
assert.equal(userSeq(), seqLate);
main.api.close();

// ---- pull pages also stop at a byte budget (H6-16) -----------------------------------------------
{
  const small = setup({ limits: { pullBytes: 100 } });
  const user = await small.account("byte-pages");
  await small.state.push(user.token, [
    op("op-bytes-1", "sessions", "a", 0, { pad: "x".repeat(60) }),
    op("op-bytes-2", "sessions", "b", 0, { pad: "y".repeat(60) }),
    op("op-bytes-3", "sessions", "c", 0, { pad: "z".repeat(200) }),
  ]);
  const page1 = await small.state.pull(user.token, "since=0&limit=10");
  assert.deepEqual(page1.body.records.map((record) => record.recordId), ["a"]);
  assert.equal(page1.body.more, true);
  const page2 = await small.state.pull(user.token, `since=${page1.body.nextSince}&limit=10`);
  assert.deepEqual(page2.body.records.map((record) => record.recordId), ["b"]);
  const page3 = await small.state.pull(user.token, `since=${page2.body.nextSince}&limit=10`);
  assert.deepEqual(page3.body.records.map((record) => record.recordId), ["c"], "a record larger than the budget still comes alone");
  assert.equal(page3.body.more, false);
  small.api.close();
}

// ---- quotas ---------------------------------------------------------------------------------------
{
  const quota = setup({ limits: { userRecords: 3, userBytes: 100 } });
  const user = await quota.account("quota-user");
  const other = await quota.account("quota-other");
  const fill = await quota.state.push(user.token, [
    op("op-quota-1", "sessions", "q1", 0, { v: 1 }),
    op("op-quota-2", "sessions", "q2", 0, { v: 2 }),
    op("op-quota-3", "sessions", "q3", 0, null),
    op("op-quota-4", "sessions", "q4", 0, { v: 4 }),
  ]);
  assert.deepEqual(
    fill.body.results.map((result) => result.status),
    ["applied", "applied", "applied", "rejected"],
    "the 4th record (tombstones count) is over the record quota",
  );
  assert.deepEqual(fill.body.results[3], { opId: "op-quota-4", status: "rejected", code: "quota" });
  assert.equal((await quota.state.push(other.token, [op("op-quota-4", "sessions", "q4", 0, { v: 4 })])).body.results[0].status, "applied", "quotas are per user");
  const grow = await quota.state.push(user.token, [op("op-quota-grow", "sessions", "q1", 1, { v: "g".repeat(120) })]);
  assert.equal(grow.body.results[0].code, "quota", "a body that grows the account past its byte quota is refused");
  const sameSize = await quota.state.push(user.token, [op("op-quota-same", "sessions", "q1", 1, { v: 9 })]);
  assert.equal(sameSize.body.results[0].status, "applied", "an edit that does not grow is fine at the cap");
  const shrink = await quota.state.push(user.token, [op("op-quota-del", "sessions", "q2", 1, null)]);
  assert.equal(shrink.body.results[0].status, "applied", "a delete is always allowed");
  const retry = await quota.state.push(user.token, [op("op-quota-4", "sessions", "q4", 0, { v: 4 })]);
  assert.equal(retry.body.results[0].code, "quota", "a quota rejection was not stored; the retry is evaluated again");
  quota.api.close();
}

console.log("verify-server-sync: ok");
