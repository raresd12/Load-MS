// H3 fix round 1, import fidelity and source privacy (decisions H3-8, H3-10):
// - a whole-source echo is found with its whitespace changed, in every field,
//   and never reaches a program draft, a backup or a share file
// - every model-written text of an extraction is capped
// - the "field repeated the whole source" notice survives a full list, and
//   converter disclosures are never pushed out by model lines
// - repeated weeks fold only when EVERYTHING is equal, never inside one block
// - a warm-up the text source does not contain is left out and disclosed
// - percent loads in the reps label or as "% of training max" are disclosed
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
  PERCENT_LOAD_UNCERTAINTY,
  removeSourcePayloads,
  setGeminiApiKey,
  SOURCE_ECHO_UNCERTAINTY,
  UNSUPPORTED_CONSTRUCT_UNCERTAINTY,
  WARMUP_NOT_IN_SOURCE_UNCERTAINTY,
  WARMUP_PARTLY_IN_SOURCE_UNCERTAINTY,
  WARMUP_UNCHECKED_UNCERTAINTY,
} = await import("../src/lib/aiProgram.js");
const { exportProgramShare, saveDraftToStorage, saveProgramDraft, seedDefaultProgramIfNeeded, validateProgramShareStrict } =
  await import("../src/lib/programStorage.js");
const { draftFromShare } = await import("../src/lib/programDraft.js");
const { createLocalBackup } = await import("../src/lib/storage.js");
const { buildTextSource } = await import("../src/lib/sourceFiles.js");

seedDefaultProgramIfNeeded();
assert.equal(setGeminiApiKey("h3-fix1-key-777").ok, true);

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
  name: "Back Squat Variation",
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

// ---------------------------------------------------------------------------
// 1. Source privacy: echoes with changed whitespace, in fields without a cap
// ---------------------------------------------------------------------------
{
  const SENTINEL = "SRCSENTINEL-9";
  const lines = Array.from({ length: 400 }, (_, index) => `Line ${index + 1} private note ${SENTINEL} squat 3x5 bench 3x8`);
  const source = buildTextSource(lines.join("\n"));
  assert.equal(source.ok, true);
  assert.ok(source.text.length > 20000);

  const collapsed = source.text.replace(/\n/g, " ");
  const crlf = source.text.replace(/\n/g, "\r\n");

  // The guard itself: a byte-exact copy, a collapsed copy, a CRLF copy, an
  // upper-case copy and a copy with invisible characters are all found.
  for (const [label, echo] of [
    ["exact", source.text],
    ["collapsed", collapsed],
    ["crlf", crlf],
    ["tabs and double spaces", source.text.replace(/ /g, "  ").replace(/\n/g, "\t\n")],
    ["upper case", source.text.toUpperCase()],
    ["zero-width", source.text.replace(/private/g, "pri​vate")],
    ["with a prefix and a trailing character", `Notes: ${collapsed}!`],
  ]) {
    const scrubbed = removeSourcePayloads({ field: echo, list: [echo], keep: "Bench 3x8" }, source);
    assert.equal(scrubbed.removed, 2, `${label}: both strings are changed`);
    assert.ok(!JSON.stringify(scrubbed.value).toLowerCase().includes(SENTINEL.toLowerCase()), `${label}: nothing of the source is left`);
    assert.equal(scrubbed.value.keep, "Bench 3x8");
  }
  assert.equal(
    removeSourcePayloads({ field: `Notes: ${collapsed}!` }, source).value.field,
    "Notes: !",
    "only the echo is removed",
  );

  // Through the whole extraction, as the probe of the finding did.
  const result = await extract(source, {
    name: "Echo program",
    nickname: collapsed,
    description: crlf,
    goal: collapsed,
    structureNotes: collapsed,
    days: [
      {
        name: "Day 1",
        focus: collapsed,
        notes: crlf,
        warmup: {
          title: collapsed,
          items: [
            { name: "Line 1 private note", prescription: collapsed, notes: crlf, videoUrl: collapsed },
            { name: collapsed, prescription: "2 min" },
          ],
        },
        exercises: [ex({ name: "Squat", notes: collapsed, section: collapsed, repsLabel: collapsed, sourceWeight: collapsed, unsupported: [collapsed], mainMuscles: [collapsed] })],
      },
    ],
    uncertainty: [collapsed],
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(validateProgramShareStrict(result.share).valid, true);
  const resultJson = JSON.stringify(result);
  assert.equal(count(resultJson, SENTINEL), 0, "the result carries nothing of the source");
  assert.equal(result.share.draftMeta.uncertainty[0], SOURCE_ECHO_UNCERTAINTY, "the removal is disclosed first");
  assert.deepEqual(result.preview.uncertainty, result.share.draftMeta.uncertainty);
  assert.equal(result.summary.uncertaintyCount, result.share.draftMeta.uncertainty.length);

  // ... and nothing of it reaches a stored draft, a backup or a share file.
  const converted = draftFromShare(result.share, { origin: "ai-import" });
  assert.equal(converted.ok, true, converted.error);
  assert.equal(saveDraftToStorage(converted.draft).ok, true);
  const saved = saveProgramDraft(converted.draft);
  assert.equal(saved.ok, true, saved.error);
  const stored = [...window.localStorage.store.values()].join("\n");
  assert.equal(count(stored, SENTINEL), 0, "localStorage holds nothing of the source");
  assert.equal(count(JSON.stringify(createLocalBackup()), SENTINEL), 0, "a backup holds nothing of the source");
  assert.equal(count(JSON.stringify(exportProgramShare(saved.program.id)), SENTINEL), 0, "a share file holds nothing of the source");
}

// A short source (the second probe of the finding): the collapsed copy in
// nickname, focus, warm-up and uncertainty.
{
  const source = buildTextSource("Day 1: Back Squat 3x5, Bench 3x8,\nprivate SENT-55 coach notes here\nWarm-up: Bike 5 min");
  const collapsed = source.text.replace(/\n/g, "  ");
  const result = await extract(source, {
    name: "Short",
    nickname: collapsed,
    days: [
      {
        name: "Day 1",
        focus: collapsed,
        warmup: { title: "Warm-up", items: [{ name: "Bike", prescription: collapsed, notes: collapsed }] },
        exercises: [ex({ name: "Back Squat" }), ex({ name: "Bench", repsMin: 8, repsMax: 8 })],
      },
    ],
    uncertainty: [collapsed],
  });
  assert.equal(result.valid, true, result.error);
  assert.ok(!JSON.stringify(result).includes("SENT-55"));
  assert.equal(result.share.program.nickname, "Short", "an emptied nickname falls back to the name");
  assert.equal(result.share.days[0].focus, "");
  assert.deepEqual(
    result.share.days[0].warmup.items.map((item) => [item.name, item.prescription, item.notes]),
    [["Bike", "", ""]],
  );
  assert.deepEqual(result.share.draftMeta.uncertainty, [SOURCE_ECHO_UNCERTAINTY]);

  // A copy that lost its last words is still the source ...
  const partial = removeSourcePayloads({ field: source.text.slice(0, -6) }, source);
  assert.equal(partial.removed, 1);
  assert.equal(partial.value.field, "");
  // ... a transcribed part of it is not.
  assert.deepEqual(removeSourcePayloads({ field: "Back Squat 3x5, Bench 3x8" }, source), {
    value: { field: "Back Squat 3x5, Bench 3x8" },
    removed: 0,
  });
  assert.deepEqual(removeSourcePayloads({ field: "private SENT-55 coach notes here Warm-up: Bike" }, source).removed, 0);
}

// ---------------------------------------------------------------------------
// 2. Every model-written text of an extraction is capped
// ---------------------------------------------------------------------------
{
  const long = (label, length) => `${label} ${"lorem ipsum dolor ".repeat(Math.ceil(length / 18))}`.slice(0, length);
  const converted = convertAiProgramToShare(
    {
      name: long("Name", 5000),
      nickname: long("Nick", 5000),
      description: long("Description", 5000),
      goal: long("Goal", 5000),
      days: [
        {
          name: long("Day", 5000),
          focus: long("Focus", 5000),
          notes: long("Notes", 5000),
          warmup: {
            title: long("Title", 5000),
            items: Array.from({ length: 40 }, (_, index) => ({
              name: long(`Item ${index}`, 5000),
              prescription: long("Prescription", 5000),
              notes: long("Notes", 5000),
              videoUrl: `https://example.com/${"v".repeat(5000)}`,
            })),
          },
          exercises: [
            ex({
              name: long("Exercise", 5000),
              notes: long("Notes", 5000),
              section: long("Section", 5000),
              repsLabel: long("Label", 5000),
              sourceWeight: long("80 kg", 5000),
              groupLabel: long("A1", 5000),
              mainMuscles: Array.from({ length: 30 }, (_, index) => long(`Muscle ${index}`, 5000)),
              unsupported: [long("tempo", 5000)],
            }),
          ],
        },
      ],
      structureNotes: long("Structure", 5000),
      uncertainty: Array.from({ length: 80 }, (_, index) => long(`Line ${index}`, 5000)),
    },
    catalog,
    NOW,
  );
  assert.equal(converted.valid, true, converted.error);

  const longest = (value, path = "") => {
    if (typeof value === "string") return [[value.length, path]];
    if (Array.isArray(value)) return value.flatMap((entry, index) => longest(entry, `${path}[${index}]`));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => longest(entry, `${path}.${key}`));
    return [];
  };
  const [maxLength, maxPath] = longest({ share: converted.share, preview: converted.preview }).sort((a, b) => b[0] - a[0])[0];
  // description = 1000 + " Source structure: " + 300 is the longest text there is.
  assert.ok(maxLength <= 1400, `no string of an extraction is longer than 1,400 characters (${maxPath}: ${maxLength})`);

  const { share } = converted;
  assert.equal(share.program.name.length, 120);
  assert.equal(share.program.nickname.length, 120);
  assert.equal(share.days[0].name.length, 120);
  assert.equal(share.days[0].focus.length, 120);
  assert.equal(share.days[0].warmup.title.length, 80);
  assert.equal(share.days[0].warmup.items.length, 20);
  assert.ok(share.days[0].warmup.items.every((item) => item.name.length <= 120 && item.prescription.length <= 120 && item.notes.length <= 300 && item.videoUrl.length <= 300));
  assert.equal(share.libraryExercises[0].mainMuscles.length, 8);
  assert.ok(share.libraryExercises[0].mainMuscles.every((muscle) => muscle.length <= 40));
  assert.ok(share.libraryExercises[0].whatYouShouldFeel.length <= 8 * 42);
  assert.ok(JSON.stringify(share).length < 40000, "the whole draft stays small");

  // An edit keeps the user's own stored text at any length.
  const base = convertAiProgramToShare({ name: "Base", days: [{ name: "Day 1", exercises: [ex({ name: "Squat" })] }] }, catalog, NOW).share;
  const ownFocus = "my own focus text ".repeat(40).trim();
  const edited = convertAiProgramToShare(
    {
      name: "Base",
      nickname: "n".repeat(300),
      changes: [],
      days: [
        {
          refId: base.days[0].id,
          name: "Day 1",
          focus: ownFocus,
          exercises: [{ ...ex({ name: "Squat" }), refId: base.programExercises[0].id, exerciseId: base.programExercises[0].exerciseId }],
        },
      ],
    },
    catalog,
    NOW,
    { baseShare: base },
  );
  assert.equal(edited.valid, true, edited.error);
  assert.equal(edited.share.days[0].focus, ownFocus);
  assert.equal(edited.share.program.nickname.length, 300);
}

// ---------------------------------------------------------------------------
// 3. The notice and the converter disclosures survive a full uncertainty list
// ---------------------------------------------------------------------------
{
  const source = buildTextSource("Day 1: Back Squat 3x5, Bench 3x8, private SENT-55 coach notes here");
  const result = await extract(source, {
    name: "Full list",
    description: source.text,
    days: [{ name: "Day 1", exercises: [ex({ name: "Back Squat", notes: "tempo 3-1-1-0", sourceWeight: "75% 1RM" })] }],
    uncertainty: Array.from({ length: 45 }, (_, index) => `Model line ${index + 1}`),
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(result.share.program.description, "", "the echoed description is cleared");
  const lines = result.share.draftMeta.uncertainty;
  assert.equal(lines[0], SOURCE_ECHO_UNCERTAINTY, "the notice is the first line");
  assert.equal(lines.filter((line) => line === SOURCE_ECHO_UNCERTAINTY).length, 1);
  assert.equal(lines.filter((line) => line.startsWith("Model line")).length, 40, "the model keeps its 40 lines");
  assert.equal(lines.filter((line) => line.includes(PERCENT_LOAD_UNCERTAINTY)).length, 1, "converter disclosures are kept");
  assert.equal(lines.filter((line) => line.includes(UNSUPPORTED_CONSTRUCT_UNCERTAINTY)).length, 1);
  assert.equal(result.summary.uncertaintyCount, lines.length);

  // More converter lines than the list holds: model lines give way, never the converter's.
  const many = convertAiProgramToShare(
    {
      name: "Many",
      days: [
        {
          name: "Day 1",
          exercises: Array.from({ length: 58 }, (_, index) => ex({ name: `Lift ${index + 1}`, sourceWeight: "70% 1RM" })),
        },
      ],
      uncertainty: Array.from({ length: 40 }, (_, index) => `Model line ${index + 1}`),
    },
    catalog,
    NOW,
    { leadingUncertainty: [SOURCE_ECHO_UNCERTAINTY] },
  );
  assert.equal(many.valid, true);
  const manyLines = many.share.draftMeta.uncertainty;
  assert.equal(manyLines.length, 60, "the list is as long as the review notes a draft keeps");
  assert.equal(manyLines[0], SOURCE_ECHO_UNCERTAINTY);
  assert.equal(manyLines.filter((line) => line.includes(PERCENT_LOAD_UNCERTAINTY)).length, 58);
  assert.deepEqual(manyLines.filter((line) => line.startsWith("Model line")), ["Model line 1"]);
  const draft = draftFromShare(many.share, { origin: "ai-import" });
  assert.equal(draft.ok, true);
  assert.deepEqual(draft.draft.reviewNotes.uncertainty, manyLines, "the draft keeps every line");
}

// ---------------------------------------------------------------------------
// 4. Repeated weeks: folded only when everything is equal
// ---------------------------------------------------------------------------
{
  const weekly = convertAiProgramToShare(
    {
      name: "P",
      days: [
        { name: "Day 1", block: "Week 1", exercises: [ex({ notes: "@ 70%" })] },
        { name: "Day 1", block: "Week 2", exercises: [ex({ notes: "@ 75%" })] },
        {
          name: "Day 1",
          block: "Week 3",
          notes: "deload week, keep it light",
          exercises: [ex({ notes: "@ 80%, tempo 3-1-1-0", unsupported: ["tempo 3-1-1-0"] })],
        },
      ],
    },
    catalog,
    NOW,
  );
  assert.equal(weekly.valid, true);
  assert.deepEqual(
    weekly.share.days.map((day) => day.notes),
    ["[Week 1]", "[Week 2]", "[Week 3] deload week, keep it light"],
    "weeks that differ in notes are all kept",
  );
  assert.deepEqual(
    weekly.share.programExercises.map((exercise) => [exercise.notes, exercise.sourceWeight]),
    [
      ["@ 70%", "@ 70%"],
      ["@ 75%", "@ 75%"],
      ["@ 80%, tempo 3-1-1-0", "@ 80%"],
    ],
    "no percentage and no construct is lost",
  );
  const weeklyLines = weekly.share.draftMeta.uncertainty;
  assert.equal(weeklyLines.filter((line) => line.includes(PERCENT_LOAD_UNCERTAINTY)).length, 3);
  assert.equal(weeklyLines.filter((line) => line.includes(`${UNSUPPORTED_CONSTRUCT_UNCERTAINTY}: tempo prescription`)).length, 1);
  assert.equal(weeklyLines.filter((line) => line.includes("with the same prescription")).length, 0, "nothing is called the same");
  assert.equal(
    weeklyLines.filter((line) => line.includes("the source lists this day 3 times with different prescriptions, notes or warm-up (Week 1 / Week 2 / Week 3)")).length,
    1,
  );

  // One difference at a time, each of them keeps both copies.
  const differences = {
    "exercise notes": [{}, { exercises: [ex({ notes: "slow eccentric" })] }],
    "unsupported list": [{}, { exercises: [ex({ unsupported: ["drop set on the last set"] })] }],
    "group label": [{}, { exercises: [ex({ groupLabel: "A1" })] }],
    section: [{}, { exercises: [ex({ section: "Main lifts" })] }],
    "day notes": [{}, { notes: "deload" }],
    focus: [{}, { focus: "Speed" }],
    "warm-up added": [{}, { warmup: { title: "Warm-up", items: [{ name: "Bike", prescription: "5 min" }] } }],
    "warm-up changed": [
      { warmup: { title: "Warm-up", items: [{ name: "Bike", prescription: "5 min" }] } },
      { warmup: { title: "Warm-up", items: [{ name: "Bike", prescription: "10 min" }] } },
    ],
  };

  for (const [label, [first, second]] of Object.entries(differences)) {
    const result = convertAiProgramToShare(
      {
        name: "P",
        days: [
          { name: "Day 1", block: "Week 1", exercises: [ex()], ...first },
          { name: "Day 1", block: "Week 2", exercises: [ex()], ...second },
        ],
      },
      catalog,
      NOW,
    );
    assert.equal(result.valid, true);
    assert.equal(result.share.days.length, 2, `${label}: both weeks are kept`);
    assert.equal(result.share.draftMeta.uncertainty.filter((line) => line.includes("kept once")).length, 0, label);
    assert.equal(result.share.draftMeta.uncertainty.filter((line) => line.includes("2 times with different prescriptions, notes or warm-up")).length, 1, label);
  }

  const warmupKept = convertAiProgramToShare(
    {
      name: "P",
      days: [
        { name: "Day 1", block: "Week 1", exercises: [ex()] },
        { name: "Day 1", block: "Week 2", exercises: [ex()], warmup: { title: "Warm-up", items: [{ name: "Bike", prescription: "5 min" }] } },
      ],
    },
    catalog,
    NOW,
  );
  assert.deepEqual(
    warmupKept.share.days.map((day) => day.warmup?.items.length ?? 0),
    [0, 1],
    "the warm-up of week 2 is not lost",
  );

  // Identical copies still fold, the week label inside the notes does not count.
  const identical = convertAiProgramToShare(
    {
      name: "P",
      days: ["Week 1", "Week 2", "Week 3"].map((block) => ({
        name: `${block} - Day A`,
        block,
        notes: `${block}`,
        focus: "Legs",
        warmup: { title: "Warm-up", items: [{ name: "Bike", prescription: "5 min" }] },
        exercises: [ex({ notes: "brace hard", groupLabel: "A1", section: "Main", unsupported: [] })],
      })),
    },
    catalog,
    NOW,
  );
  assert.equal(identical.share.days.length, 1);
  assert.equal(identical.preview.days[0].block, "Week 1, Week 2, Week 3");
  assert.equal(identical.share.draftMeta.uncertainty.filter((line) => line.includes("for Week 1, Week 2, Week 3 with the same prescription; it is kept once")).length, 1);
}

// ---------------------------------------------------------------------------
// 5. The same day twice inside ONE block is two training days
// ---------------------------------------------------------------------------
{
  const fullBody = convertAiProgramToShare(
    { name: "P", days: [1, 2, 3].map(() => ({ name: "Full Body", block: "Week 1-4", exercises: [ex()] })) },
    catalog,
    NOW,
  );
  assert.equal(fullBody.share.days.length, 3, "three Full Body sessions stay three days");
  assert.equal(fullBody.summary.exerciseCount, 3);
  assert.equal(fullBody.share.draftMeta.uncertainty.filter((line) => /kept once|different prescriptions/.test(line)).length, 0, "nothing was folded, nothing differs");

  const aba = convertAiProgramToShare(
    {
      name: "P",
      days: ["Workout A", "Workout B", "Workout A"].map((name) => ({
        name,
        block: "Weeks 1-6",
        exercises: [ex({ name: name === "Workout A" ? "Squat" : "Bench" })],
      })),
    },
    catalog,
    NOW,
  );
  assert.deepEqual(aba.share.days.map((day) => day.name), ["Workout A", "Workout B", "Workout A"]);

  // Three sessions a week, written out for two weeks: each session folds
  // into its own counterpart of the other week.
  const twoWeeks = convertAiProgramToShare(
    {
      name: "P",
      days: ["Week 1", "Week 2"].flatMap((block) => [1, 2, 3].map(() => ({ name: "Full Body", block, exercises: [ex()] }))),
    },
    catalog,
    NOW,
  );
  assert.equal(twoWeeks.share.days.length, 3);
  assert.deepEqual(twoWeeks.preview.days.map((day) => day.block), ["Week 1, Week 2", "Week 1, Week 2", "Week 1, Week 2"]);
  assert.equal(twoWeeks.share.draftMeta.uncertainty.filter((line) => line.includes("kept once")).length, 1); // three equal lines are said once
}

// ---------------------------------------------------------------------------
// 6. No invented warm-up
// ---------------------------------------------------------------------------
{
  const response = {
    name: "P",
    days: [
      {
        name: "Day 1",
        warmup: { title: "Warm-up", items: [{ name: "Jumping jacks", prescription: "2 min" }] },
        exercises: [ex({ name: "Squat" })],
      },
    ],
  };

  // The converter alone knows no source: it keeps what it is given (H2 shape).
  const direct = convertAiProgramToShare(response, catalog, NOW);
  assert.equal(direct.share.days[0].warmup.items.length, 1);
  assert.deepEqual(direct.share.draftMeta.uncertainty, []);

  // A text source that has no such warm-up.
  const invented = await extract({ kind: "text", text: "Day 1\nSquat 3x5" }, response);
  assert.equal(invented.valid, true, invented.error);
  assert.ok(!("warmup" in invented.share.days[0]), "the invented warm-up is not in the draft");
  assert.equal(invented.preview.days[0].warmup, null);
  assert.equal(invented.summary.warmupItemCount, 0);
  assert.equal(invented.summary.warmupDayCount, 0);
  assert.deepEqual(invented.share.draftMeta.uncertainty, [
    `Day 1: warm-up item "Jumping jacks" ${WARMUP_NOT_IN_SOURCE_UNCERTAINTY}.`,
  ]);

  // A source that lists it, in another case, with diacritics and punctuation.
  const listed = await extract(
    { kind: "text", text: "Day 1\nÎncălzire: JUMPING-JACKS 2 min, genuflexiuni fără greutate x10\nSquat 3x5" },
    {
      ...response,
      days: [
        {
          ...response.days[0],
          warmup: {
            title: "Încălzire",
            items: [
              { name: "Jumping jacks", prescription: "2 min" },
              { name: "Genuflexiuni fara greutate", prescription: "x10" },
              { name: "Band pull-aparts", prescription: "2 x 15" },
              { name: "Jumping rope", prescription: "1 min" },
            ],
          },
        },
      ],
    },
  );
  assert.equal(listed.valid, true, listed.error);
  assert.deepEqual(
    listed.share.days[0].warmup.items.map((item) => item.name),
    ["Jumping jacks", "Genuflexiuni fara greutate", "Jumping rope"],
    "listed items stay, an invented one goes",
  );
  assert.deepEqual(listed.share.draftMeta.uncertainty, [
    `Day 1: warm-up item "Band pull-aparts" ${WARMUP_NOT_IN_SOURCE_UNCERTAINTY}.`,
    `Day 1: warm-up item "Jumping rope" ${WARMUP_PARTLY_IN_SOURCE_UNCERTAINTY}.`,
  ]);
  assert.equal(listed.summary.warmupItemCount, 3);

  // A warm-up-only day whose warm-up was invented stays as a day.
  const recovery = await extract(
    { kind: "text", text: "Day 1\nSquat 3x5\nDay 2 - rest" },
    {
      name: "P",
      days: [
        { name: "Day 1", exercises: [ex({ name: "Squat" })] },
        { name: "Day 2", warmup: { title: "Mobility", items: [{ name: "Hip circles", prescription: "2 x 10" }] }, exercises: [] },
      ],
    },
  );
  assert.equal(recovery.share.days.length, 2);
  assert.ok(!("warmup" in recovery.share.days[1]));

  // A photo or a PDF cannot be checked in code: said once, items kept.
  const pdfBase64 = Buffer.from("%PDF-1.4 minimal test document for the warm-up check, long enough").toString("base64");
  const pdf = await extract({ kind: "pdf", mimeType: "application/pdf", files: [{ mimeType: "application/pdf", dataBase64: pdfBase64 }] }, response);
  assert.equal(pdf.valid, true, pdf.error);
  assert.equal(pdf.share.days[0].warmup.items.length, 1);
  assert.deepEqual(pdf.share.draftMeta.uncertainty, [WARMUP_UNCHECKED_UNCERTAINTY]);

  const noWarmup = await extract(
    { kind: "pdf", mimeType: "application/pdf", files: [{ mimeType: "application/pdf", dataBase64: pdfBase64 }] },
    { name: "P", days: [{ name: "Day 1", exercises: [ex({ name: "Squat" })] }] },
  );
  assert.deepEqual(noWarmup.share.draftMeta.uncertainty, [], "nothing is said when there is no warm-up");
}

// ---------------------------------------------------------------------------
// 7. Percent loads outside sourceWeight / notes
// ---------------------------------------------------------------------------
{
  const result = convertAiProgramToShare(
    {
      name: "P",
      days: [
        {
          name: "Day 1",
          exercises: [
            ex({ name: "Squat", repsLabel: "5 @ 75%" }),
            ex({ name: "Bench", notes: "work up to 85% of training max" }),
            ex({ name: "Deadlift", notes: "90% of your one-rep max for a single" }),
            ex({ name: "Row", notes: "82.5% e1RM" }),
            ex({ name: "Press", notes: "reduce the load 10% when tired" }),
            ex({ name: "Curl", repsMin: null, repsMax: null, repsLabel: "AMRAP" }),
          ],
        },
      ],
    },
    catalog,
    NOW,
  );
  assert.equal(result.valid, true);
  assert.deepEqual(
    result.share.programExercises.map((exercise) => exercise.sourceWeight ?? null),
    ["@ 75%", "85% of training max", "90% of your one-rep max", "82.5% e1RM", null, null],
  );
  assert.ok(result.share.programExercises.every((exercise) => exercise.targetWeight === null), "never a target weight");
  assert.equal(result.share.programExercises[0].targetReps.label, "5 @ 75%", "the label keeps its wording");
  assert.deepEqual(result.share.draftMeta.uncertainty, [
    `Day 1: "Squat": ${PERCENT_LOAD_UNCERTAINTY} ("@ 75%").`,
    `Day 1: "Bench": ${PERCENT_LOAD_UNCERTAINTY} ("85% of training max").`,
    `Day 1: "Deadlift": ${PERCENT_LOAD_UNCERTAINTY} ("90% of your one-rep max").`,
    `Day 1: "Row": ${PERCENT_LOAD_UNCERTAINTY} ("82.5% e1RM").`,
  ]);
}

assert.equal(setGeminiApiKey("").ok, true);
console.log("AI H3 fix round 1 verification passed.");
