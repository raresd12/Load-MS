// H4 fix round 3, decision H4-15: src/lib/programTargetForm.js (moved verbatim
// from src/components/program/ProgramPrescriptionEditor.jsx).
// - the form shows a ProgramExercise target as text (rest range as "min-max",
//   decision 19.4-3; a custom reps label only when it differs from min-max);
// - validation turns the form into the patch the checked writer stores, and
//   refuses invalid sets / reps / weight / RPE / rest with the editor's copy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}

globalThis.window = { localStorage: new MemoryLocalStorage() };
console.warn = () => {};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  createProgramExerciseTargetForm,
  getCustomRepsLabelForEditor,
  parseProgramTargetWeight,
  parseRpeValue,
  validateProgramExerciseTargetForm,
} = await import("../src/lib/programTargetForm.js");
const { MAX_TARGET_SETS } = await import("../src/lib/programStorage.js");

const bench = {
  loadType: "external",
  sets: 4,
  repsMin: 5,
  repsMax: 7,
  repsLabel: "5-7",
  recommendedWeight: 80,
  targetRPE: 8,
  restSeconds: [150, 180],
  notes: "pause",
};
const pullUps = { loadType: "bodyweight", sets: 3, repsMin: null, repsMax: null, repsLabel: "AMRAP", recommendedWeight: null, targetRPE: 8.5, restSeconds: 120 };
const dips = { ...pullUps, loadType: "optionalExternal" };

const validForm = (overrides = {}) => ({ ...createProgramExerciseTargetForm(bench), ...overrides });

try {
  // ------------------------------------------------------------------
  // Form values
  // ------------------------------------------------------------------
  assert.deepEqual(createProgramExerciseTargetForm(bench), {
    targetSets: "4",
    repsMin: "5",
    repsMax: "7",
    repsLabel: "",
    targetWeight: "80",
    targetRPE: "8",
    restTime: "150-180",
    notes: "pause",
  });
  assert.deepEqual(createProgramExerciseTargetForm(pullUps), {
    targetSets: "3",
    repsMin: "",
    repsMax: "",
    repsLabel: "AMRAP",
    targetWeight: "BW",
    targetRPE: "8.5",
    restTime: "120",
    notes: "",
  });
  assert.equal(createProgramExerciseTargetForm(dips).targetWeight, "", "optional external load without a weight shows blank");
  assert.equal(getCustomRepsLabelForEditor({ repsMin: 8, repsMax: 10, repsLabel: "8 – 10" }), "", "a label that only restates min-max is not custom");
  assert.equal(getCustomRepsLabelForEditor({ repsMin: 8, repsMax: 8, repsLabel: "8" }), "");
  assert.equal(getCustomRepsLabelForEditor({ repsMin: 8, repsMax: 10, repsLabel: "8-10 each side" }), "8-10 each side");

  // ------------------------------------------------------------------
  // Round trip: an untouched form validates to the stored target
  // ------------------------------------------------------------------
  assert.deepEqual(validateProgramExerciseTargetForm(validForm(), bench), {
    valid: true,
    errors: [],
    patch: {
      targetSets: 4,
      targetReps: { min: 5, max: 7, label: null },
      targetWeight: 80,
      targetRPE: 8,
      restTime: [150, 180],
      notes: "pause",
    },
  });
  assert.deepEqual(validateProgramExerciseTargetForm(createProgramExerciseTargetForm(pullUps), pullUps).patch, {
    targetSets: 3,
    targetReps: { min: null, max: null, label: "AMRAP" },
    targetWeight: "BW",
    targetRPE: 8.5,
    restTime: 120,
    notes: "",
  });

  // ------------------------------------------------------------------
  // Refusals
  // ------------------------------------------------------------------
  const errorsOf = (overrides, exercise = bench) => {
    const result = validateProgramExerciseTargetForm(validForm(overrides), exercise);
    assert.equal(result.valid, false);
    assert.equal(result.patch, undefined, "no patch for an invalid form");
    return result.errors;
  };
  const setsError = `Sets must be a whole number from 1 to ${MAX_TARGET_SETS}.`;
  assert.deepEqual(errorsOf({ targetSets: "0" }), [setsError]);
  assert.deepEqual(errorsOf({ targetSets: "" }), [setsError]);
  assert.deepEqual(errorsOf({ targetSets: "2.5" }), [setsError]);
  assert.deepEqual(errorsOf({ targetSets: String(MAX_TARGET_SETS + 1) }), [setsError]);
  assert.equal(validateProgramExerciseTargetForm(validForm({ targetSets: String(MAX_TARGET_SETS) }), bench).valid, true);
  assert.deepEqual(errorsOf({ repsMin: "x" }), ["Reps min must be a positive number."]);
  assert.deepEqual(errorsOf({ repsMax: "0" }), ["Reps max must be a positive number."]);
  assert.deepEqual(errorsOf({ repsMin: "8", repsMax: "6" }), ["Reps max should be equal to or above reps min."]);
  assert.deepEqual(errorsOf({ repsMin: "", repsMax: "", repsLabel: "  " }), ["Add reps min/max or a reps label."]);
  assert.deepEqual(errorsOf({ targetWeight: "heavy" }), ["Weight must be blank, BW, or a valid kg number."]);
  assert.deepEqual(errorsOf({ targetWeight: "-5" }), ["Weight must be blank, BW, or a valid kg number."]);
  for (const rpe of ["", "0", "10.5", "8.3", "x"]) {
    assert.deepEqual(errorsOf({ targetRPE: rpe }), ["Target RPE must be 1-10 and can use .5 steps."], `target RPE "${rpe}"`);
  }
  assert.deepEqual(errorsOf({ restTime: "" }), ["Rest must be seconds (e.g. 90) or a range like 150-180."]);
  assert.deepEqual(errorsOf({ restTime: "180-150" }), ["Rest range must be written as min-max (e.g. 150-180)."]);
  assert.equal(errorsOf({ targetSets: "0", targetRPE: "11", restTime: "soon" }).length, 3, "every problem is listed");

  // ------------------------------------------------------------------
  // Accepted edits
  // ------------------------------------------------------------------
  const edited = validateProgramExerciseTargetForm(
    validForm({ targetSets: "5", repsMin: "8", repsMax: "8", repsLabel: " 8 strict ", targetWeight: " 82.5 ", targetRPE: "8.5", restTime: "90", notes: " keep " }),
    bench,
  );
  assert.deepEqual(edited.patch, {
    targetSets: 5,
    targetReps: { min: 8, max: 8, label: "8 strict" },
    targetWeight: 82.5,
    targetRPE: 8.5,
    restTime: 90,
    notes: " keep ",
  });
  assert.equal(validateProgramExerciseTargetForm(validForm({ targetWeight: "" }), bench).patch.targetWeight, null, "a blank weight clears the target weight");
  assert.equal(validateProgramExerciseTargetForm(validForm({ targetWeight: "0" }), bench).patch.targetWeight, 0);
  assert.equal(validateProgramExerciseTargetForm(validForm({ restTime: "120-120" }), bench).patch.restTime, 120, "a min = max range is one number");

  assert.deepEqual(parseProgramTargetWeight("bw", pullUps), { invalid: false, value: "BW" });
  assert.deepEqual(parseProgramTargetWeight("BW", dips), { invalid: false, value: null }, "optional external: BW means no added load");
  assert.deepEqual(parseProgramTargetWeight("12.5", dips), { invalid: false, value: 12.5 });
  assert.equal(parseRpeValue("7.5"), 7.5);
  assert.equal(parseRpeValue("7.25"), null);

  // ------------------------------------------------------------------
  // The editor uses the module
  // ------------------------------------------------------------------
  const editor = readFileSync(path.join(root, "src/components/program/ProgramPrescriptionEditor.jsx"), "utf8");
  assert.ok(editor.includes('from "../../lib/programTargetForm.js";'), "the editor imports the form helpers");
  assert.ok(!/^function (validate|parse|create|stringify|normalize|get)[A-Za-z]*\(/m.test(editor), "the editor defines no pure helper itself");

  console.log("verify-program-target-form: ok");
} catch (error) {
  console.error("verify-program-target-form: FAIL");
  console.error(error);
  process.exit(1);
}
