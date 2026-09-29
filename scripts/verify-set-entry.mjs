// H4 fix round 3, decision H4-15: the Save Set helpers moved from
// src/components/workout/UnifiedSetEntry.jsx to src/lib/sessionNormalize.js.
// - defaults: plan entry first, then the program exercise; BW for bodyweight /
//   optional-external exercises without a weight; blank otherwise;
// - a set with any logged value shows its own values, never the defaults;
// - stepper arithmetic: clamped, blank counts as 0, non-numeric text is kept;
// - validation: reps >= 0, kg a number or BW where BW is allowed, RPE 1-10 in
//   half steps; blank fields are allowed (a partial set can be saved).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  adjustInputValue,
  getRecommendedSetEntryDefaults,
  getSetEntryValues,
  validateSetEntry,
} = await import("../src/lib/sessionNormalize.js");

const external = { loadType: "external", repsMin: 6, repsMax: 8, recommendedWeight: 60, targetRPE: 8 };
const bodyweight = { loadType: "bodyweight", repsMin: 12, repsMax: 15, recommendedWeight: null, targetRPE: 8 };
const optional = { loadType: "optionalExternal", repsMin: null, repsMax: null, recommendedWeight: null, targetRPE: 8 };

try {
  // ------------------------------------------------------------------
  // Defaults
  // ------------------------------------------------------------------
  assert.deepEqual(getRecommendedSetEntryDefaults(external, null), { reps: "6", weight: "60", rpe: "8" });
  assert.deepEqual(
    getRecommendedSetEntryDefaults(external, { repsMin: 5, recommendedWeight: 62.5, targetRPE: 8.5 }),
    { reps: "5", weight: "62.5", rpe: "8.5" },
    "the plan entry wins over the program exercise",
  );
  assert.deepEqual(
    getRecommendedSetEntryDefaults(external, { repsMin: null, recommendedWeight: null, targetRPE: null }),
    { reps: "6", weight: "60", rpe: "8" },
    "missing plan values fall back to the exercise",
  );
  assert.deepEqual(getRecommendedSetEntryDefaults(bodyweight, undefined), { reps: "12", weight: "BW", rpe: "8" });
  assert.deepEqual(getRecommendedSetEntryDefaults(optional, {}), { reps: "", weight: "BW", rpe: "8" });
  assert.deepEqual(
    getRecommendedSetEntryDefaults(optional, { recommendedWeight: 10 }),
    { reps: "", weight: "10", rpe: "8" },
    "an optional-external exercise with added load shows the load",
  );
  assert.deepEqual(
    getRecommendedSetEntryDefaults({ loadType: "external", repsMin: null, recommendedWeight: null }, null),
    { reps: "", weight: "", rpe: "" },
    "nothing known: blank fields",
  );
  assert.deepEqual(getRecommendedSetEntryDefaults({ ...external, recommendedWeight: 0 }, null).weight, "0", "0 kg is a weight");

  // ------------------------------------------------------------------
  // Entry values
  // ------------------------------------------------------------------
  const defaults = { reps: "6", weight: "60", rpe: "8" };
  assert.equal(getSetEntryValues({ reps: "", weight: "", rpe: "" }, defaults), defaults, "an empty set shows the defaults");
  assert.equal(getSetEntryValues({}, defaults), defaults);
  assert.equal(getSetEntryValues({ reps: null, weight: undefined, rpe: "" }, defaults), defaults);
  assert.deepEqual(
    getSetEntryValues({ reps: 7, weight: "", rpe: "" }, defaults),
    { reps: "7", weight: "", rpe: "" },
    "a partly logged set shows what was logged, not the defaults",
  );
  assert.deepEqual(getSetEntryValues({ reps: 0, weight: "BW", rpe: 9.5 }, defaults), { reps: "0", weight: "BW", rpe: "9.5" });

  // ------------------------------------------------------------------
  // Stepper arithmetic
  // ------------------------------------------------------------------
  assert.equal(adjustInputValue("8", 1), "9");
  assert.equal(adjustInputValue("", 1), "1", "blank counts as 0");
  assert.equal(adjustInputValue(null, 2.5), "2.5");
  assert.equal(adjustInputValue("0", -1), "0", "default minimum 0");
  assert.equal(adjustInputValue("60", 2.5), "62.5");
  assert.equal(adjustInputValue("62.5", 2.5), "65", "whole results have no decimals");
  assert.equal(adjustInputValue("9.5", 0.5, { min: 1, max: 10 }), "10");
  assert.equal(adjustInputValue("10", 0.5, { min: 1, max: 10 }), "10", "clamped at the maximum");
  assert.equal(adjustInputValue("1", -0.5, { min: 1, max: 10 }), "1", "clamped at the minimum");
  assert.equal(adjustInputValue("", -0.5, { min: 1, max: 10 }), "1");
  assert.equal(adjustInputValue("BW", 2.5), "BW", "non-numeric text is left alone");
  assert.equal(adjustInputValue("0.1", 0.2), "0.3", "no floating point tail");

  // ------------------------------------------------------------------
  // Validation
  // ------------------------------------------------------------------
  assert.deepEqual(validateSetEntry({ reps: "8", weight: "60", rpe: "8" }, external), []);
  assert.deepEqual(validateSetEntry({ reps: "", weight: "", rpe: "" }, external), [], "blank fields are allowed");
  assert.deepEqual(validateSetEntry({ reps: "0", weight: "0", rpe: "1" }, external), []);
  assert.deepEqual(validateSetEntry({ reps: "-1", weight: "60", rpe: "8" }, external), ["Reps must be 0 or higher."]);
  assert.deepEqual(validateSetEntry({ reps: "abc", weight: "60", rpe: "8" }, external), ["Reps must be 0 or higher."]);
  assert.deepEqual(validateSetEntry({ reps: "8", weight: "BW", rpe: "8" }, external), ["Kg must be a valid number or BW."], "BW is refused for an external load");
  assert.deepEqual(validateSetEntry({ reps: "8", weight: "-5", rpe: "8" }, external), ["Kg must be a valid number or BW."]);
  assert.deepEqual(validateSetEntry({ reps: "8", weight: "BW", rpe: "8" }, bodyweight), []);
  assert.deepEqual(validateSetEntry({ reps: "8", weight: "20", rpe: "8" }, bodyweight), ["Kg must be a valid number or BW."], "a bodyweight exercise takes BW only");
  assert.deepEqual(validateSetEntry({ reps: "8", weight: "BW", rpe: "8" }, optional), []);
  assert.deepEqual(validateSetEntry({ reps: "8", weight: "10", rpe: "8" }, optional), []);
  for (const rpe of ["0", "0.5", "10.5", "11", "8.2", "x"]) {
    assert.deepEqual(validateSetEntry({ reps: "8", weight: "60", rpe }, external), ["Set RPE must be 1-10 in .5 steps."], `RPE ${rpe} is refused`);
  }
  for (const rpe of ["1", "7.5", "10", 8]) {
    assert.deepEqual(validateSetEntry({ reps: "8", weight: "60", rpe }, external), [], `RPE ${rpe} is accepted`);
  }
  assert.deepEqual(validateSetEntry({ reps: "-1", weight: "x", rpe: "11" }, external), [
    "Reps must be 0 or higher.",
    "Kg must be a valid number or BW.",
    "Set RPE must be 1-10 in .5 steps.",
  ]);

  // ------------------------------------------------------------------
  // The components import the helpers; no second definition
  // ------------------------------------------------------------------
  const entry = readFileSync(path.join(root, "src/components/workout/UnifiedSetEntry.jsx"), "utf8");
  const table = readFileSync(path.join(root, "src/components/workout/CompletedWorkoutTable.jsx"), "utf8");
  const history = readFileSync(path.join(root, "src/pages/HistoryPage.jsx"), "utf8");
  for (const name of ["getRecommendedSetEntryDefaults", "getSetEntryValues", "adjustInputValue", "validateSetEntry"]) {
    for (const [file, source] of [["UnifiedSetEntry.jsx", entry], ["CompletedWorkoutTable.jsx", table], ["HistoryPage.jsx", history]]) {
      assert.ok(!new RegExp(`function ${name}\\(`).test(source), `${name} is not defined in ${file}`);
    }
  }
  assert.ok(/validateSetEntry,\s*\} from "\.\.\/\.\.\/lib\/sessionNormalize\.js";/.test(table), "the set editor validates through the lib helper");
  assert.ok(history.includes('import { adjustInputValue } from "../lib/sessionNormalize.js";'), "the History editor steps through the lib helper");

  console.log("verify-set-entry: ok");
} catch (error) {
  console.error("verify-set-entry: FAIL");
  console.error(error);
  process.exit(1);
}
