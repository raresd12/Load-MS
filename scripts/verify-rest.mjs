// H1 Track C: rest normalization (review finding F6, decision 19.4-3).
// A [min, max] range resolves to max so the timer starts; the editor shows
// and preserves ranges as "min-max"; stored ranges are never rewritten.
import assert from "node:assert/strict";

const {
  formatRestClock,
  formatRestEditorValue,
  parseRestEditorValue,
  resolveRestSeconds,
} = await import("../src/lib/rest.js");

// --- scalar ---------------------------------------------------------------
assert.deepEqual(resolveRestSeconds(180), {
  seconds: 180,
  min: 180,
  max: 180,
  isRange: false,
  label: "3:00",
});
assert.equal(resolveRestSeconds("90").seconds, 90, "numeric string resolves");
assert.equal(resolveRestSeconds(0).seconds, 0, "zero never starts a timer");
assert.equal(resolveRestSeconds(-30).seconds, 0, "negative never starts a timer");
assert.equal(resolveRestSeconds(null).seconds, 0);
assert.equal(resolveRestSeconds(undefined).seconds, 0);
assert.equal(resolveRestSeconds("").seconds, 0);
assert.equal(resolveRestSeconds("soon").seconds, 0);
assert.equal(resolveRestSeconds(Number.NaN).seconds, 0);
assert.equal(resolveRestSeconds({}).seconds, 0);

// --- range (the F6 reproduction: Number([150, 180]) was NaN -> no timer) ---
const range = resolveRestSeconds([150, 180]);
assert.equal(range.seconds, 180, "range starts the timer at max (decision 19.4-3)");
assert.equal(range.min, 150);
assert.equal(range.max, 180);
assert.equal(range.isRange, true);
assert.equal(range.label, "2:30-3:00");
assert.ok(range.seconds > 0, "the timer must start for [150, 180]");

const stored = [150, 180];
resolveRestSeconds(stored);
assert.deepEqual(stored, [150, 180], "stored range is not mutated");

assert.equal(resolveRestSeconds([180, 150]).seconds, 180, "inverted range still uses the larger bound");
assert.equal(resolveRestSeconds([180, 150]).min, 150);
assert.equal(resolveRestSeconds([120, 120]).isRange, false, "equal bounds are not a range");
assert.equal(resolveRestSeconds([120]).seconds, 120, "single-element array behaves like a scalar");
assert.equal(resolveRestSeconds(["150", "180"]).seconds, 180, "string members are parsed");
assert.equal(resolveRestSeconds([]).seconds, 0);
assert.equal(resolveRestSeconds([null, "x"]).seconds, 0);
assert.equal(resolveRestSeconds("150-180").seconds, 180, "range text resolves");
assert.equal(resolveRestSeconds("150 - 180").isRange, true);

// --- clock label ------------------------------------------------------------
assert.equal(formatRestClock(150), "2:30");
assert.equal(formatRestClock(5), "0:05");
assert.equal(formatRestClock(-3), "0:00");
assert.equal(formatRestClock("x"), "0:00");

// --- editor round trip ------------------------------------------------------
assert.equal(formatRestEditorValue([150, 180]), "150-180", "editor shows the range as min-max");
assert.equal(formatRestEditorValue(90), "90");
assert.equal(formatRestEditorValue(null), "");
assert.equal(formatRestEditorValue([]), "");

assert.deepEqual(parseRestEditorValue("150-180"), { valid: true, value: [150, 180], error: null });
assert.deepEqual(parseRestEditorValue(" 150 - 180 "), { valid: true, value: [150, 180], error: null });
assert.deepEqual(parseRestEditorValue("90"), { valid: true, value: 90, error: null });
assert.deepEqual(parseRestEditorValue("120-120"), { valid: true, value: 120, error: null });
assert.equal(parseRestEditorValue("").valid, false);
assert.equal(parseRestEditorValue("0").valid, false);
assert.equal(parseRestEditorValue("-5").valid, false);
assert.equal(parseRestEditorValue("180-150").valid, false, "inverted range is rejected");
assert.equal(parseRestEditorValue("abc").valid, false);
assert.equal(parseRestEditorValue("90s").valid, false);
assert.ok(parseRestEditorValue("abc").error.length > 0, "invalid input carries a message");

// Full round trip: stored range -> editor text -> parsed value equals stored range.
assert.deepEqual(parseRestEditorValue(formatRestEditorValue([150, 180])).value, [150, 180]);
assert.equal(parseRestEditorValue(formatRestEditorValue(75)).value, 75);

console.log("verify-rest: all assertions passed");
