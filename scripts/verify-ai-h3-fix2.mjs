// H3 fix round 2, import fidelity and source privacy (decisions H3-14, H3-15):
// - a shortened program description / goal is disclosed like shortened notes
// - a copy of the source that lost a line in the middle, or changed every
//   line a little, is removed whatever the length of the source, and the
//   model's uncertainty lines cannot carry the source in pieces
// - ONE transcribed note that is most of a short source stays in the draft
// - a time, distance or AMRAP label never keeps a model-filled rep range
import assert from "node:assert/strict";

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

const {
  convertAiProgramToShare,
  extractProgramDraftWithAi,
  getLibraryCatalog,
  NON_COUNT_REPS_UNCERTAINTY,
  removeSourcePayloads,
  setGeminiApiKey,
  SOURCE_ECHO_UNCERTAINTY,
} = await import("../src/lib/aiProgram.js");
const { exportProgramShare, saveDraftToStorage, saveProgramDraft, seedDefaultProgramIfNeeded, validateProgramShareStrict } =
  await import("../src/lib/programStorage.js");
const { draftFromShare } = await import("../src/lib/programDraft.js");
const { createLocalBackup } = await import("../src/lib/storage.js");
const { buildTextSource } = await import("../src/lib/sourceFiles.js");

seedDefaultProgramIfNeeded();
assert.equal(setGeminiApiKey("h3-fix2-key-778").ok, true);

let responses = [];
globalThis.fetch = async () => {
  const next = responses.shift();
  if (!next) throw new Error("unexpected fetch");
  return next;
};
const geminiOk = (document) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(document) }] } }] }),
});

async function extract(source, response) {
  responses = [geminiOk(response)];
  const result = await extractProgramDraftWithAi(source);
  assert.equal(responses.length, 0, "one request");
  return result;
}

const catalog = getLibraryCatalog();
const NOW = "2026-09-29T00:00:00.000Z";
const ex = (overrides = {}) => ({
  exerciseId: "",
  name: "Probe Lift",
  isNew: true,
  sets: 3,
  repsMin: 5,
  repsMax: 5,
  targetRPE: 8,
  restSeconds: 180,
  progressionType: "strength",
  ...overrides,
});
const count = (haystack, needle) => haystack.split(needle).length - 1;

/** Everything a result can reach: the result, storage, a backup, a share file. */
function everywhere(result) {
  const converted = draftFromShare(result.share, { origin: "ai-import" });
  assert.equal(converted.ok, true, converted.error);
  assert.equal(saveDraftToStorage(converted.draft).ok, true);
  const saved = saveProgramDraft(converted.draft);
  assert.equal(saved.ok, true, saved.error);

  return [
    JSON.stringify(result),
    [...window.localStorage.store.values()].join("\n"),
    JSON.stringify(createLocalBackup()),
    JSON.stringify(exportProgramShare(saved.program.id)),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 1. Description and goal: the cut is disclosed
// ---------------------------------------------------------------------------
{
  const long = (word) => `${word} `.repeat(400).trim();
  const converted = convertAiProgramToShare(
    { name: "Long", description: long("overview"), goal: long("strength"), days: [{ name: "Day 1", exercises: [ex()] }] },
    catalog,
    NOW,
  );
  assert.equal(converted.valid, true, converted.error);
  assert.ok(converted.share.program.description.length <= 1000);
  assert.ok(converted.share.program.goal.length <= 1000);
  assert.deepEqual(converted.share.draftMeta.uncertainty, [
    "Program description was longer than 1000 characters and was shortened.",
    "Program goal was longer than 1000 characters and was shortened.",
  ]);

  // Exactly at the cap, and under it: nothing is said.
  const exact = convertAiProgramToShare(
    { name: "Exact", description: "d".repeat(1000), goal: "short goal", days: [{ name: "Day 1", exercises: [ex()] }] },
    catalog,
    NOW,
  );
  assert.equal(exact.share.program.description.length, 1000);
  assert.deepEqual(exact.share.draftMeta.uncertainty, []);

  // Through an extraction, with a description that is not the source.
  const source = buildTextSource("Day 1\nProbe Lift 3x5 @ RPE 8, rest 3 min\n");
  const result = await extract(source, {
    name: "Through",
    description: long("overview"),
    days: [{ name: "Day 1", exercises: [ex()] }],
    uncertainty: [],
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(result.share.program.description.length <= 1000, true);
  assert.deepEqual(result.share.draftMeta.uncertainty, [
    "Program description was longer than 1000 characters and was shortened.",
  ]);
  assert.deepEqual(result.preview.uncertainty, result.share.draftMeta.uncertainty);
  assert.equal(result.summary.uncertaintyCount, 1);

  // An edit keeps the user's stored text at any length and says nothing.
  const base = convertAiProgramToShare(
    { name: "Base", description: "kept", days: [{ name: "Day 1", exercises: [ex()] }] },
    catalog,
    NOW,
  ).share;
  base.program.description = long("stored");
  const edited = convertAiProgramToShare(
    {
      name: "Base",
      description: long("stored"),
      days: [{ name: "Day 1", exercises: [ex({ refId: base.programExercises[0].id })] }],
    },
    catalog,
    NOW,
    { baseShare: base },
  );
  assert.equal(edited.valid, true, edited.error);
  assert.equal(edited.share.program.description, long("stored"));
  assert.equal(
    edited.share.draftMeta.uncertainty.some((line) => line.includes("was shortened")),
    false,
  );
}

// ---------------------------------------------------------------------------
// 2. A copy of a long source that lost ONE line in the middle
// ---------------------------------------------------------------------------
{
  const SENTINEL = "coach private";
  const lines = Array.from({ length: 120 }, (_, index) => `Line ${index} ${SENTINEL} SNT${index}X bench 3x8 squat 5x5 at 80 kg`);
  const source = buildTextSource(lines.join("\n"));
  assert.equal(source.ok, true);
  assert.ok(source.text.length > 4000, "longer than the part-copy window of H3-8");
  const dropped = lines.filter((_, index) => index !== 60).join("\n");

  const scrubbed = removeSourcePayloads({ field: dropped, keep: "Bench 3x8" }, source);
  assert.equal(scrubbed.removed, 1);
  assert.deepEqual(scrubbed.value, { field: "", keep: "Bench 3x8" });

  const result = await extract(source, {
    name: "Dropped line",
    description: dropped,
    goal: dropped,
    days: [{ name: "Day 1", notes: dropped, exercises: [ex({ notes: dropped })] }],
    // The source again, cut into 40 lines of three source lines each.
    uncertainty: Array.from({ length: 40 }, (_, index) => lines.slice(index * 3, index * 3 + 3).join(" ")),
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(validateProgramShareStrict(result.share).valid, true);
  assert.equal(result.share.program.description, "");
  assert.equal(result.share.programExercises[0].notes, "");
  assert.deepEqual(result.share.draftMeta.uncertainty, [SOURCE_ECHO_UNCERTAINTY]);
  assert.equal(count(everywhere(result), SENTINEL), 0, "nothing of the source in the result, storage, a backup or a share file");
}

// The same with short lines (under 40 characters each): the LIST is the copy.
{
  const lines = Array.from({ length: 60 }, (_, index) => `Row ${index} hidden QX${index}Z 3x8`);
  const source = buildTextSource(lines.join("\n"));
  const result = await extract(source, {
    name: "Pieces",
    days: [{ name: "Day 1", exercises: [ex()] }],
    uncertainty: Array.from({ length: 30 }, (_, index) => `${lines[index * 2]} / ${lines[index * 2 + 1]}`),
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(count(everywhere(result), "hidden QX"), 0);
  assert.equal(result.share.draftMeta.uncertainty[0], SOURCE_ECHO_UNCERTAINTY);
}

// A shorter source (under 4,000 characters) with a line dropped in the middle.
{
  const lines = Array.from({ length: 60 }, (_, index) => `Line ${index} coach hidden SML${index}X bench 3x8 squat 5x5 at 80 kg`);
  const source = buildTextSource(lines.join("\n"));
  assert.ok(source.text.length < 4000);
  const dropped = lines.filter((_, index) => index !== 30).join("\n");
  const result = await extract(source, {
    name: "Small",
    description: dropped,
    days: [{ name: "Day 1", exercises: [ex()] }],
    uncertainty: [],
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(result.share.program.description, "");
  assert.equal(count(everywhere(result), "coach hidden"), 0);
  assert.deepEqual(result.share.draftMeta.uncertainty, [SOURCE_ECHO_UNCERTAINTY]);
}

// Every line changed a little: other bullets, numbering, indentation.
{
  const lines = Array.from({ length: 20 }, (_, index) => `- item ${index}: secret CHK${index} row 3x8`);
  const source = buildTextSource(lines.join("\n"));

  for (const [label, copy] of [
    ["star bullets", lines.map((line) => line.replace(/^- /, "* ")).join("\n")],
    ["numbered", lines.map((line, index) => line.replace(/^- /, `${index + 1}. `)).join("\n")],
    ["indented, no bullets", lines.map((line) => line.replace(/^- /, "    ")).join("\n")],
    ["reordered", [...lines].reverse().join("\n")],
    ["prefix kept", `Program text:\n${lines.map((line) => line.replace(/^- /, "* ")).join("\n")}`],
  ]) {
    const scrubbed = removeSourcePayloads({ field: copy }, source);
    assert.equal(scrubbed.removed, 1, label);
    assert.equal(count(scrubbed.value.field, "secret CHK"), 0, label);
  }

  assert.equal(
    removeSourcePayloads({ field: `Program text:\n${lines.join("\n").replace(/^- /gm, "* ")}` }, source).value.field,
    "Program text:",
    "only the copy is removed",
  );

  const result = await extract(source, {
    name: "Bullets",
    description: lines.map((line) => line.replace(/^- /, "* ")).join("\n"),
    days: [{ name: "Day 1", exercises: [ex()] }],
    uncertainty: [],
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(count(everywhere(result), "secret CHK"), 0);
  assert.deepEqual(result.share.draftMeta.uncertainty, [SOURCE_ECHO_UNCERTAINTY]);
}

// A long uncertainty line that quotes one whole source line loses the quote, not its own words.
{
  const lines = [
    "Day 1 - Lower",
    "Back Squat 5x5 @ 75% 1RM, rest 2-3 min, keep the brace (coach QUOTE-77 remark)",
    "Leg Press 3x10-12",
    "Plank 3 x 30 s",
    "Calf Raise 4x12, slow lowering on every rep",
  ];
  const source = buildTextSource(lines.join("\n"));
  const result = await extract(source, {
    name: "Quote",
    days: [{ name: "Day 1", exercises: [ex({ name: "Back Squat" }), ex({ name: "Leg Press", repsMin: 10, repsMax: 12 })] }],
    uncertainty: [`Day 1: could not tell the load of this row: ${lines[1]}`, "Day 1: Leg Press rest time is missing."],
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(count(JSON.stringify(result), "QUOTE-77"), 0);
  assert.equal(result.share.draftMeta.uncertainty[0], SOURCE_ECHO_UNCERTAINTY);
  assert.ok(result.share.draftMeta.uncertainty.includes("Day 1: could not tell the load of this row:"));
  assert.ok(result.share.draftMeta.uncertainty.includes("Day 1: Leg Press rest time is missing."));
}

// ---------------------------------------------------------------------------
// 3. ONE transcribed note that is most of a short source stays
// ---------------------------------------------------------------------------
{
  const text = "Squat 3x5 - keep the bar over midfoot and brace hard before each rep";
  const note = "keep the bar over midfoot and brace hard before each rep";
  const result = await extract(
    { kind: "text", text },
    { name: "Squat day", days: [{ name: "Day 1", exercises: [ex({ name: "Squat", targetRPE: null, restSeconds: null, notes: note })] }], uncertainty: [] },
  );
  assert.equal(result.valid, true, result.error);
  assert.equal(result.share.programExercises[0].notes, note);
  assert.equal(result.share.draftMeta.uncertainty.includes(SOURCE_ECHO_UNCERTAINTY), false);

  // The whole source is still removed, however short (H3-3).
  assert.deepEqual(removeSourcePayloads({ field: `Notes: ${text}` }, { kind: "text", text }), {
    value: { field: "Notes:" },
    removed: 1,
  });
}

{
  const note =
    "Keep the bar close to the body on every rep, brace before each descent, and stop the set when the bar speed drops clearly or the lower back rounds at all.";
  assert.equal(note.length, 154);
  const text = `Day 1\nBack Squat 3x5\n${note}`;
  assert.deepEqual(removeSourcePayloads({ notes: note }, { kind: "text", text }), { value: { notes: note }, removed: 0 });

  const result = await extract(
    { kind: "text", text },
    { name: "Notes", days: [{ name: "Day 1", exercises: [ex({ name: "Back Squat", notes: note })] }], uncertainty: [] },
  );
  assert.equal(result.valid, true, result.error);
  assert.equal(result.share.programExercises[0].notes, note);
  assert.equal(result.share.draftMeta.uncertainty.includes(SOURCE_ECHO_UNCERTAINTY), false);

  // A copy that runs over the lines of the same short source is the source (H3-8).
  const copy = removeSourcePayloads({ field: text.replace(/\n/g, " ").slice(0, -8) }, { kind: "text", text });
  assert.deepEqual(copy, { value: { field: "" }, removed: 1 });
  // ... and so is a part of 400 characters or more of a source that is one line.
  const oneLine = `Coach letter: ${"remember to breathe and brace on every single rep ".repeat(12)}end`;
  assert.ok(oneLine.length > 500 && oneLine.length < 4000);
  assert.deepEqual(removeSourcePayloads({ field: oneLine.slice(0, -20) }, { kind: "text", text: oneLine }), {
    value: { field: "" },
    removed: 1,
  });
}

// ---------------------------------------------------------------------------
// 4. Time, distance and AMRAP labels never keep a model-filled rep range
// ---------------------------------------------------------------------------
{
  const converted = convertAiProgramToShare(
    {
      name: "Labels",
      days: [
        {
          name: "D1",
          exercises: [
            ex({ name: "Plank Probe", repsMin: 30, repsMax: 30, repsLabel: "30 s", targetRPE: null, restSeconds: null, progressionType: "core" }),
            ex({ name: "Push-Up Probe", repsMin: 10, repsMax: 10, repsLabel: "AMRAP" }),
            ex({ name: "Carry Probe", repsMin: 20, repsMax: 20, repsLabel: "20 m" }),
            ex({ name: "Hold Probe", repsMin: 2, repsMax: 2, repsLabel: "2 min" }),
            ex({ name: "Row Probe", repsMin: 8, repsMax: 12, repsLabel: "8-12 per side" }),
            ex({ name: "Pause Probe", repsMin: 5, repsMax: 5, repsLabel: "5 reps, 3 s pause" }),
            ex({ name: "Plain Probe", repsMin: 8, repsMax: 10 }),
            ex({ name: "Timed Only Probe", repsMin: null, repsMax: null, repsLabel: "45 s" }),
          ],
        },
      ],
    },
    catalog,
    NOW,
    { sourceKind: "text" },
  );
  assert.equal(converted.valid, true, converted.error);
  const reps = Object.fromEntries(
    converted.share.programExercises.map((exercise, index) => [
      ["plank", "pushup", "carry", "hold", "row", "pause", "plain", "timed"][index],
      exercise.targetReps,
    ]),
  );
  assert.deepEqual(reps.plank, { min: null, max: null, label: "30 s" });
  assert.deepEqual(reps.pushup, { min: null, max: null, label: "AMRAP" });
  assert.deepEqual(reps.carry, { min: null, max: null, label: "20 m" });
  assert.deepEqual(reps.hold, { min: null, max: null, label: "2 min" });
  assert.deepEqual(reps.row, { min: 8, max: 12, label: "8-12 per side" });
  assert.deepEqual(reps.pause, { min: 5, max: 5, label: "5 reps, 3 s pause" });
  assert.deepEqual(reps.plain, { min: 8, max: 10, label: "8-10" });
  assert.deepEqual(reps.timed, { min: null, max: null, label: "45 s" });
  assert.deepEqual(converted.share.draftMeta.uncertainty, [
    `D1: "Plank Probe": "30 s" ${NON_COUNT_REPS_UNCERTAINTY} (30).`,
    `D1: "Push-Up Probe": "AMRAP" ${NON_COUNT_REPS_UNCERTAINTY} (10).`,
    `D1: "Carry Probe": "20 m" ${NON_COUNT_REPS_UNCERTAINTY} (20).`,
    `D1: "Hold Probe": "2 min" ${NON_COUNT_REPS_UNCERTAINTY} (2).`,
  ]);
  assert.equal(validateProgramShareStrict(converted.share).valid, true);
  converted.share.programExercises.slice(0, 4).forEach((exercise) => {
    assert.equal(converted.share.draftMeta.provenance[exercise.id]?.targetReps ?? "source", "source");
  });
}

assert.equal(setGeminiApiKey("").ok, true);
console.log("AI H3 fix round 2 verification passed.");
