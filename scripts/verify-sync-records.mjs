import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Phase H6 / Track B: src/lib/syncRecords.js, decisions H6-5, H6-7, H6-10.
// Canonical JSON, the content hash, record ids for every syncable
// collection, enumerate / apply / diff and the mass-delete threshold.

globalThis.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };

const {
  applyPulledRecords,
  canonicalJson,
  computeOpId,
  contentHash,
  DELETED_HASH,
  diffForPush,
  enumerateLocalRecords,
  hashLocalRecords,
  hasCollectionShape,
  MASS_DELETE_LIMIT,
  MAX_PUSH_OPS,
  needsMassDeleteConfirmation,
  parseRecordKey,
  recordIdOf,
  recordKey,
  RECORD_KEY_SEPARATOR,
  sha256Hex,
} = await import("../src/lib/syncRecords.js");
const { getCollection, getSyncableCollections } = await import("../src/lib/repository.js");

const nodeSha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ------------------------------------------------------------------
// Canonical JSON (H6-5)
// ------------------------------------------------------------------
assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}', "keys sorted");
assert.equal(
  canonicalJson({ z: { y: [3, { d: 1, c: 2 }], x: null }, a: "t" }),
  '{"a":"t","z":{"x":null,"y":[3,{"c":2,"d":1}]}}',
  "sorted recursively, arrays keep order",
);
assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
assert.equal(canonicalJson({ a: undefined, b: () => 1, c: Symbol("s"), d: 1 }), '{"d":1}', "undefined / functions / symbols dropped");
assert.equal(canonicalJson([undefined, () => 1, Symbol("s"), 1]), "[null,null,null,1]", "become null in arrays");
assert.equal(canonicalJson(undefined), undefined, "top-level undefined like JSON.stringify");
assert.equal(canonicalJson(() => 1), undefined);
assert.equal(canonicalJson(null), "null");
assert.equal(canonicalJson("x"), '"x"');
assert.equal(canonicalJson(true), "true");
// Numbers exactly as JSON.stringify writes them.
for (const number of [0, -0, 1, -1, 0.1, 1e21, 1e-7, 123456789.123, Number.MAX_SAFE_INTEGER, 5e-324, 2.5]) {
  assert.equal(canonicalJson(number), JSON.stringify(number), `number ${number}`);
}
assert.equal(canonicalJson(-0), "0");
assert.equal(canonicalJson([NaN, Infinity, -Infinity]), "[null,null,null]");
// Unicode: escapes as JSON.stringify, keys in UTF-16 code-unit order.
assert.equal(canonicalJson({ name: "Fandări ș ț 💪", quote: '"\\\n' }), JSON.stringify({ name: "Fandări ș ț 💪", quote: '"\\\n' }));
assert.equal(canonicalJson("\ud800"), '"\\ud800"', "lone surrogate escaped");
assert.equal(canonicalJson({ é: 1, z: 2, Z: 3, a: 4 }), '{"Z":3,"a":4,"z":2,"é":1}', "code-unit order");
assert.equal(canonicalJson({ 10: "a", 9: "b", 1: "c" }), '{"1":"c","10":"a","9":"b"}', "integer-like keys sorted as strings");
assert.equal(canonicalJson({ "😀": 1, "￿": 2 }), '{"😀":1,"￿":2}', "surrogate pairs sort by code unit");
// toJSON, boxed primitives.
assert.equal(canonicalJson({ at: new Date("2026-10-07T10:00:00.000Z") }), '{"at":"2026-10-07T10:00:00.000Z"}');
assert.equal(canonicalJson([new Number(3), new String("s"), new Boolean(false)]), '[3,"s",false]');
assert.equal(canonicalJson({ toJSON: () => ({ b: 1, a: 2 }) }), '{"a":2,"b":1}');
// Equal to JSON.stringify whenever the keys are already sorted.
const sample = { a: [1, "two", { b: null, c: [true, false] }], d: { e: -3.5, f: "ü" } };
assert.equal(canonicalJson(sample), JSON.stringify(sample));
// Same content, different key order -> same text.
assert.equal(canonicalJson({ x: 1, y: { b: 2, a: 1 } }), canonicalJson({ y: { a: 1, b: 2 }, x: 1 }));
// Cycles and BigInt throw TypeError (JSON.stringify does too).
const cyclic = { a: 1 };
cyclic.self = cyclic;
assert.throws(() => canonicalJson(cyclic), TypeError);
assert.throws(() => canonicalJson({ n: 10n }), TypeError);
// A repeated (non-cyclic) reference is fine.
const shared = { k: 1 };
assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}');

// The server keeps a byte-identical copy (H6-5); cross-check when present.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverCanonical = path.join(root, "server", "canonical.mjs");
if (existsSync(serverCanonical)) {
  const server = await import(pathToFileURL(serverCanonical).href);
  const corpus = [
    sample,
    { b: 1, a: [undefined, NaN, -0, 1e21, "ș💪\ud800"], c: { 10: 1, 9: 2, é: 3, Z: 4 } },
    [new Date(0), { toJSON: () => "x" }, null, true],
    { nested: { deeper: { deepest: [{ z: 1, a: 2 }] } } },
  ];
  for (const value of corpus) {
    assert.equal(canonicalJson(value), server.canonicalJson(value), "client and server canonical forms agree");
    assert.equal(await contentHash(value), server.contentHash(value, false), "client and server hashes agree");
  }
  assert.equal(server.DELETED_HASH, DELETED_HASH);
}

// ------------------------------------------------------------------
// Content hash
// ------------------------------------------------------------------
assert.equal(await sha256Hex(""), nodeSha(""));
assert.equal(await contentHash({}), nodeSha("{}"));
assert.equal(await contentHash({ b: 1, a: "ș" }), nodeSha('{"a":"ș","b":1}'), "UTF-8 bytes of the canonical text");
assert.match(await contentHash([1, 2]), /^[0-9a-f]{64}$/);
assert.equal(await contentHash({ x: 1, y: 2 }), await contentHash({ y: 2, x: 1 }));
assert.notEqual(await contentHash({ x: 1 }), await contentHash({ x: "1" }));
assert.equal(DELETED_HASH, "deleted");

// ------------------------------------------------------------------
// Record ids for every syncable collection (H6-7)
// ------------------------------------------------------------------
const syncable = getSyncableCollections();
assert.equal(syncable.length, 15);
const expectedIds = {
  sessions: [{ id: "s1" }, "s1"],
  nextPlans: ["day-1", "day-1"],
  setupCues: ["ex-1", "ex-1"],
  readinessByDate: ["2026-10-07", "2026-10-07"],
  workoutDrafts: ["p1|d1|2026-10-07", "p1|d1|2026-10-07"],
  programs: [{ id: "p1" }, "p1"],
  programDays: [{ id: "d1", programId: "p1" }, "d1"],
  programSections: [{ id: "sec1" }, "sec1"],
  exerciseLibrary: [{ id: "lib-squat" }, "lib-squat"],
  programExercises: [{ id: "pe1" }, "pe1"],
  baselines: [{ programId: "p1", programExerciseId: "pe1", weight: 60 }, '["p1","pe1"]'],
  programStates: [{ programId: "p1", currentDayId: "d1" }, "p1"],
  programProgressions: [{ programExerciseId: "pe1", programId: "p1" }, '["p1","pe1"]'],
  programDrafts: [{ draftId: "draft-1" }, "draft-1"],
  programOverrides: [{ id: "ov-1" }, "ov-1"],
};
assert.deepEqual(Object.keys(expectedIds).sort(), syncable.map((c) => c.name).sort(), "every syncable collection covered");
for (const [name, [input, id]] of Object.entries(expectedIds)) {
  assert.equal(recordIdOf(name, input), id, `${name} record id`);
  assert.equal(recordIdOf(getCollection(name), input), id, `${name} by descriptor`);
}
assert.equal(recordIdOf("baselines", { programId: "p1" }), null, "composite with a missing part");
assert.equal(recordIdOf("baselines", { programId: "p1", programExerciseId: "" }), null);
assert.equal(recordIdOf("baselines", { programId: 'a"b', programExerciseId: "c,d" }), JSON.stringify(['a"b', "c,d"]), "JSON-quoted parts");
assert.equal(recordIdOf("programProgressions", { programId: 7, programExerciseId: "pe" }), '[7,"pe"]', "values as they are");
assert.equal(recordIdOf("sessions", { id: 12 }), "12", "a numeric id is its string");
assert.equal(recordIdOf("sessions", { id: "" }), null);
assert.equal(recordIdOf("sessions", { id: null }), null);
assert.equal(recordIdOf("sessions", { name: "no id" }), null);
assert.equal(recordIdOf("sessions", { id: { nested: 1 } }), null);
assert.equal(recordIdOf("sessions", null), null);
assert.equal(recordIdOf("sessions", [1]), null);
assert.equal(recordIdOf("sessions", { id: "x".repeat(300) }), "x".repeat(300), "300 characters is allowed");
assert.equal(recordIdOf("sessions", { id: "x".repeat(301) }), null, "over 300 characters is not");
assert.equal(recordIdOf("nextPlans", ""), null);
assert.equal(recordIdOf("nextPlans", 5), null);
assert.equal(recordIdOf("activeProgramId", "p1"), null, "value collections have no record id");
assert.equal(recordIdOf("nope", { id: "x" }), null);

assert.equal(RECORD_KEY_SEPARATOR, "\u001f");
assert.equal(recordKey("baselines", '["p1","pe1"]'), 'baselines\u001f["p1","pe1"]');
assert.deepEqual(parseRecordKey(recordKey("nextPlans", "a\u001fb")), { collection: "nextPlans", recordId: "a\u001fb" });
assert.equal(parseRecordKey("no-separator"), null);

assert.equal(hasCollectionShape("sessions", []), true);
assert.equal(hasCollectionShape("sessions", null), true);
assert.equal(hasCollectionShape("sessions", {}), false);
assert.equal(hasCollectionShape("nextPlans", []), false);
assert.equal(hasCollectionShape("nextPlans", {}), true);

// ------------------------------------------------------------------
// enumerateLocalRecords
// ------------------------------------------------------------------
{
  const stored = {
    sessions: [{ id: "s1", v: 1 }, { v: "no id" }, { id: "s1", v: "dup" }, { id: "s2" }],
    nextPlans: { "day-1": { a: 1 }, "day-2": null },
    baselines: [{ programId: "p1", programExerciseId: "pe1" }],
  };
  const { records, skipped, invalid } = enumerateLocalRecords((name) => stored[name]);
  assert.deepEqual(invalid, []);
  assert.deepEqual(records, [
    { collection: "sessions", recordId: "s1", body: { id: "s1", v: 1 } },
    { collection: "sessions", recordId: "s2", body: { id: "s2" } },
    { collection: "nextPlans", recordId: "day-1", body: { a: 1 } },
    { collection: "nextPlans", recordId: "day-2", body: null },
    { collection: "baselines", recordId: '["p1","pe1"]', body: { programId: "p1", programExerciseId: "pe1" } },
  ]);
  assert.deepEqual(skipped, [
    { collection: "sessions", index: 1, reason: "missing-id" },
    { collection: "sessions", index: 2, recordId: "s1", reason: "duplicate-id" },
  ]);
  const wrong = enumerateLocalRecords((name) => (name === "programs" ? { not: "a list" } : name === "setupCues" ? [1] : undefined));
  assert.deepEqual(wrong.invalid, ["setupCues", "programs"].sort((a, b) => syncable.findIndex((c) => c.name === a) - syncable.findIndex((c) => c.name === b)));
  assert.deepEqual(wrong.records, []);

  const hashed = await hashLocalRecords(records.slice(0, 1));
  assert.equal(hashed[0].hash, nodeSha('{"id":"s1","v":1}'));
  assert.equal(records[0].hash, undefined, "inputs are not mutated");
}

// ------------------------------------------------------------------
// applyPulledRecords
// ------------------------------------------------------------------
{
  const current = {
    sessions: [{ id: "s1", v: 1 }, { v: "no id" }, { id: "s2", v: 2 }, { id: "s3", v: 3 }],
    nextPlans: { a: 1, b: 2 },
    baselines: [{ programId: "p1", programExerciseId: "pe1", w: 50 }],
  };
  const snapshot = JSON.stringify(current);
  const { values, changed } = applyPulledRecords(
    [
      { collection: "sessions", recordId: "s2", deleted: false, body: { id: "s2", v: 22 } },
      { collection: "sessions", recordId: "s4", deleted: false, body: { id: "s4" } },
      { collection: "sessions", recordId: "s1", deleted: true, body: null },
      { collection: "sessions", recordId: "s5", deleted: false, body: { id: "s5" } },
      { collection: "sessions", recordId: "missing", deleted: true, body: null },
      { collection: "nextPlans", recordId: "c", deleted: false, body: 3 },
      { collection: "nextPlans", recordId: "a", deleted: true, body: null },
      { collection: "nextPlans", recordId: "b", deleted: false, body: 2 },
      { collection: "baselines", recordId: '["p1","pe1"]', deleted: false, body: { programId: "p1", programExerciseId: "pe1", w: 55 } },
      { collection: "appUiState", recordId: "x", deleted: false, body: {} },
      { collection: "ghost", recordId: "x", deleted: false, body: {} },
      { collection: "programs", recordId: "p1", deleted: true, body: null },
    ],
    current,
  );
  assert.equal(JSON.stringify(current), snapshot, "inputs are not mutated");
  assert.deepEqual(values.sessions, [{ v: "no id" }, { id: "s2", v: 22 }, { id: "s3", v: 3 }, { id: "s4" }, { id: "s5" }], "in place, appended in order, id-less kept");
  assert.deepEqual(values.nextPlans, { b: 2, c: 3 });
  assert.deepEqual(Object.keys(values.nextPlans), ["b", "c"], "map order stable, new keys appended");
  assert.deepEqual(values.baselines, [{ programId: "p1", programExerciseId: "pe1", w: 55 }]);
  assert.deepEqual(values.programs, [], "an absent list reads as empty");
  assert.ok(!("appUiState" in values) && !("ghost" in values), "non-syncable and unknown collections ignored");
  assert.deepEqual(changed.sort(), ["baselines", "nextPlans", "sessions"]);

  // Same content in another key order is not a change.
  const same = applyPulledRecords([{ collection: "nextPlans", recordId: "k", deleted: false, body: { y: 1, x: 2 } }], { nextPlans: { k: { x: 2, y: 1 } } });
  assert.deepEqual(same.changed, []);
  // Later entries win.
  const later = applyPulledRecords(
    [
      { collection: "programs", recordId: "p1", deleted: false, body: { id: "p1", n: 1 } },
      { collection: "programs", recordId: "p1", deleted: false, body: { id: "p1", n: 2 } },
    ],
    {},
  );
  assert.deepEqual(later.values.programs, [{ id: "p1", n: 2 }]);
  // Duplicates: only the first match is replaced or deleted.
  const dups = applyPulledRecords([{ collection: "programs", recordId: "p1", deleted: true }], { programs: [{ id: "p1", n: 1 }, { id: "p1", n: 2 }] });
  assert.deepEqual(dups.values.programs, [{ id: "p1", n: 2 }]);
}

// ------------------------------------------------------------------
// diffForPush (H6-7) and the mass-delete threshold (H6-10)
// ------------------------------------------------------------------
{
  const local = await hashLocalRecords([
    { collection: "sessions", recordId: "same", body: { id: "same" } },
    { collection: "sessions", recordId: "changed", body: { id: "changed", v: 2 } },
    { collection: "sessions", recordId: "new", body: { id: "new" } },
    { collection: "sessions", recordId: "reborn", body: { id: "reborn" } },
  ]);
  const meta = {
    deviceId: "dev-1",
    records: {
      [recordKey("sessions", "same")]: { rev: 3, hash: await contentHash({ id: "same" }) },
      [recordKey("sessions", "changed")]: { rev: 4, hash: await contentHash({ id: "changed", v: 1 }) },
      [recordKey("sessions", "reborn")]: { rev: 6, hash: DELETED_HASH },
      [recordKey("sessions", "gone")]: { rev: 2, hash: await contentHash({ id: "gone" }) },
      [recordKey("sessions", "tomb")]: { rev: 9, hash: DELETED_HASH },
      [recordKey("appUiState", "x")]: { rev: 1, hash: "abc" },
    },
  };
  const diff = await diffForPush(local, meta);
  assert.deepEqual(
    diff.ops.map(({ collection, recordId, baseRev, deleted, body }) => ({ collection, recordId, baseRev, deleted, body })),
    [
      { collection: "sessions", recordId: "changed", baseRev: 4, deleted: false, body: { id: "changed", v: 2 } },
      { collection: "sessions", recordId: "new", baseRev: 0, deleted: false, body: { id: "new" } },
      { collection: "sessions", recordId: "reborn", baseRev: 6, deleted: false, body: { id: "reborn" } },
      { collection: "sessions", recordId: "gone", baseRev: 2, deleted: true, body: null },
    ],
  );
  assert.equal(diff.ops.at(-1).hash, DELETED_HASH);
  assert.equal(diff.ops[0].hash, local[1].hash);
  assert.equal(diff.deleteCount, 1);
  assert.equal(diff.liveCount, 4, "live = known non-tombstones (incl. a stray non-syncable entry)");
  assert.equal(diff.needsConfirmation, false, "1 of 4: not more than a quarter");
  for (const op of diff.ops) {
    assert.match(op.opId, /^[0-9a-f]{64}$/);
    assert.equal(op.opId, await computeOpId({ deviceId: "dev-1", ...op }));
  }
  const again = await diffForPush(local, meta);
  assert.deepEqual(again.ops.map((op) => op.opId), diff.ops.map((op) => op.opId), "a retry sends the same opIds");
  const otherDevice = await diffForPush(local, { ...meta, deviceId: "dev-2" });
  assert.notEqual(otherDevice.ops[0].opId, diff.ops[0].opId, "deviceId is part of the opId");
  assert.notEqual(
    await computeOpId({ deviceId: "d", collection: "c", recordId: "r", baseRev: 1, deleted: false, hash: "h" }),
    await computeOpId({ deviceId: "d", collection: "c", recordId: "r", baseRev: 2, deleted: false, hash: "h" }),
    "baseRev is part of the opId",
  );
  assert.equal(
    await computeOpId({ deviceId: "d", collection: "c", recordId: "r", baseRev: 1, deleted: false, hash: "h" }),
    nodeSha('["d","c","r",1,false,"h"]'),
  );

  // Lost meta records: no deletes at all.
  const fresh = await diffForPush(local, { deviceId: "dev-1" });
  assert.equal(fresh.deleteCount, 0);
  assert.equal(fresh.ops.length, 4);
  assert.equal(fresh.needsConfirmation, false);

  // Threshold edges.
  assert.equal(MASS_DELETE_LIMIT, 20);
  assert.equal(MAX_PUSH_OPS, 200);
  assert.equal(needsMassDeleteConfirmation(20, 1000), false, "20 deletes of 1000: fine");
  assert.equal(needsMassDeleteConfirmation(21, 1000), true, "21 deletes: ask");
  assert.equal(needsMassDeleteConfirmation(25, 100), true, "over 20, even at exactly a quarter: ask");
  assert.equal(needsMassDeleteConfirmation(20, 80), false, "20 deletes, exactly a quarter: fine");
  assert.equal(needsMassDeleteConfirmation(20, 79), true, "20 deletes, more than a quarter: ask");
  assert.equal(needsMassDeleteConfirmation(10, 40), false, "a quarter of 40");
  assert.equal(needsMassDeleteConfirmation(11, 40), true, "more than a quarter of 40");
  assert.equal(needsMassDeleteConfirmation(1, 4), false);
  assert.equal(needsMassDeleteConfirmation(1, 3), true);
  assert.equal(needsMassDeleteConfirmation(0, 0), false);

  // Through diffForPush: 21 deletes out of 1000 live records.
  const many = { deviceId: "d", records: {} };
  for (let index = 0; index < 1000; index += 1) {
    many.records[recordKey("sessions", `s${index}`)] = { rev: 1, hash: `h${index}` };
  }
  const keep = (count) =>
    Array.from({ length: count }, (_, index) => ({ collection: "sessions", recordId: `s${index}`, body: {}, hash: `h${index}` }));
  assert.equal((await diffForPush(keep(980), many)).needsConfirmation, false, "20 deletes");
  const over = await diffForPush(keep(979), many);
  assert.equal(over.deleteCount, 21);
  assert.equal(over.liveCount, 1000);
  assert.equal(over.needsConfirmation, true, "21 deletes");
}

console.log("Sync records (H6-5, H6-7, H6-10) verification passed.");
