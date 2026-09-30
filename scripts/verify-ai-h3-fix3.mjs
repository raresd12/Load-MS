// H3 fix round 3, source privacy and fidelity (decisions H3-19, H3-20):
// - a PART of an image / PDF payload (base64) in a result string is removed,
//   whatever its share of the file and however it was wrapped
// - prose, names and numbers are never mistaken for a file payload
// - Romanian wording of unsupported constructs and of lb / kg is disclosed
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

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
  LB_UNIT_UNCERTAINTY,
  MIXED_UNIT_UNCERTAINTY,
  removeSourcePayloads,
  setGeminiApiKey,
  SOURCE_ECHO_UNCERTAINTY,
  UNSUPPORTED_CONSTRUCT_UNCERTAINTY,
} = await import("../src/lib/aiProgram.js");
const { exportProgramShare, saveDraftToStorage, saveProgramDraft, seedDefaultProgramIfNeeded } = await import(
  "../src/lib/programStorage.js"
);
const { draftFromShare } = await import("../src/lib/programDraft.js");
const { createLocalBackup } = await import("../src/lib/storage.js");

seedDefaultProgramIfNeeded();
assert.equal(setGeminiApiKey("h3-fix3-key-431").ok, true);

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

/** True when `haystack`, without its whitespace, holds 40 characters in a row of `payload`. */
function holdsPayloadRun(haystack, payload, length = 40) {
  const packed = haystack.replace(/\s+/g, "").replace(/\\n|\\r/g, "");

  for (let offset = 0; offset + length <= payload.length; offset += 7) {
    if (packed.includes(payload.slice(offset, offset + length))) {
      return true;
    }
  }

  return false;
}

// A fixed "file": 3000 bytes -> 4000 base64 characters.
const bytes = Buffer.alloc(3000);
for (let index = 0; index < bytes.length; index += 1) {
  bytes[index] = (index * 131 + ((index * index) % 251) * 17 + 7) % 256;
}
const payload = bytes.toString("base64");
assert.equal(payload.length, 4000);
const imageSource = { kind: "image", mimeType: "image/png", files: [{ mimeType: "image/png", dataBase64: payload }] };
const wrap = (text, width) => text.match(new RegExp(`.{1,${width}}`, "g")).join("\n");

// ---------------------------------------------------------------------------
// 1. A part of a file payload is removed, whatever its share
// ---------------------------------------------------------------------------
{
  const cases = {
    "first 500 characters (12% of the file)": `Image data ${payload.slice(0, 500)} end`,
    "500 characters from the middle": `${payload.slice(1777, 2277)}`,
    "wrapped every 76 characters": `Bytes:\n${wrap(payload.slice(0, 570), 76)}`,
    "wrapped every 64 characters with CRLF": wrap(payload.slice(900, 1400), 64).replace(/\n/g, "\r\n"),
    "as a data URL": `data:image/png;base64,${payload.slice(0, 300)}`,
    "URL-safe alphabet": payload.slice(200, 600).replace(/\+/g, "-").replace(/\//g, "_"),
    "42 characters": `see ${payload.slice(3000, 3042)}.`,
    "two parts in one note": `${payload.slice(0, 120)} and later ${payload.slice(2000, 2120)}`,
  };

  for (const [label, note] of Object.entries(cases)) {
    const cleaned = removeSourcePayloads({ note, keep: "Keep the bar close." }, imageSource);
    assert.equal(cleaned.removed, 1, `${label}: one string changed`);
    assert.ok(!holdsPayloadRun(cleaned.value.note, payload), `${label}: no run of the payload is left ("${cleaned.value.note}")`);
    assert.equal(cleaned.value.keep, "Keep the bar close.");
  }

  // What stood around the echo is kept.
  assert.equal(removeSourcePayloads({ note: `Image data ${payload.slice(0, 500)} end` }, imageSource).value.note, "Image data end");
  assert.equal(
    removeSourcePayloads({ note: `data:image/png;base64,${payload.slice(0, 300)}` }, imageSource).value.note,
    "data:image/png;base64,",
  );

  // Every file of a bundle, and the H2 shape with dataBase64 on the source.
  const second = Buffer.from(bytes).reverse().toString("base64");
  const bundle = { kind: "images", files: [{ dataBase64: payload }, { dataBase64: second }] };
  const fromBundle = removeSourcePayloads({ a: payload.slice(100, 400), b: second.slice(100, 400) }, bundle);
  assert.equal(fromBundle.removed, 2);
  assert.deepEqual(fromBundle.value, { a: "", b: "" });
  assert.equal(
    removeSourcePayloads({ a: `x ${payload.slice(10, 310)}` }, { kind: "pdf", mimeType: "application/pdf", dataBase64: payload }).value.a,
    "x",
  );
}

// ---------------------------------------------------------------------------
// 2. What is not the payload stays
// ---------------------------------------------------------------------------
{
  const other = randomBytes(600).toString("base64");
  const kept = {
    short: payload.slice(0, 39),
    otherBase64: other,
    prose: "Keep the bar close and brace before every rep then stand tall and squeeze the glutes at the top",
    packed: "SnatchGripRomanianDeadliftWithPauseBelowTheKneeAndSlowLowering",
    numbers: "1234567890123456789012345678901234567890123456789012345678901234567890",
    list: ["Day 1", "A1", "5x5 @ 75% 1RM"],
  };
  const cleaned = removeSourcePayloads(kept, imageSource);
  assert.equal(cleaned.removed, 0);
  assert.deepEqual(cleaned.value, kept);

  // A text source is not looked up as base64: its own rule (H3-15) decides.
  const textSource = { kind: "text", text: "Day 1\nBench Press 3x5\nRow 3x8" };
  const note = "BenchPress3x5Row3x8BenchPress3x5Row3x8BenchPress3x5Row3x8";
  assert.deepEqual(removeSourcePayloads({ note }, textSource), { value: { note }, removed: 0 });

  // The payload of megabytes is scanned once, not once per string.
  const bigBytes = Buffer.alloc(6 * 1024 * 1024);
  for (let index = 0; index < bigBytes.length; index += 1) {
    bigBytes[index] = (index * 2654435761) >>> 24;
  }
  const big = bigBytes.toString("base64");
  const many = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`n${index}`, `${kept.prose} ${index} ${other.slice(0, 200)}`]),
  );
  many.echo = `note ${big.slice(5_000_000, 5_000_300)}`;
  const started = Date.now();
  const bigCleaned = removeSourcePayloads(many, { kind: "image", files: [{ dataBase64: big }] });
  assert.equal(bigCleaned.removed, 1);
  assert.equal(bigCleaned.value.echo, "note");
  assert.ok(Date.now() - started < 15000, `a 6 MiB file is checked in bounded time (${Date.now() - started} ms)`);
}

// ---------------------------------------------------------------------------
// 3. End to end: result, stored draft, backup and share file
// ---------------------------------------------------------------------------
{
  const result = await extract(imageSource, {
    name: "Photo Program",
    description: `From the photo. ${payload.slice(0, 500)}`,
    days: [
      {
        name: "Day 1",
        notes: wrap(payload.slice(600, 1170), 76),
        exercises: [ex({ name: "Echo Probe Lift", notes: `Keep tight. ${payload.slice(2500, 2900)}` })],
      },
    ],
    uncertainty: [`page 1 was blurry ${payload.slice(3100, 3200)}`],
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(result.share.draftMeta.uncertainty[0], SOURCE_ECHO_UNCERTAINTY, "the notice is the first line");
  assert.equal(result.share.program.description, "From the photo.");
  assert.equal(result.share.programExercises[0].notes, "Keep tight.");
  assert.ok(result.share.draftMeta.uncertainty.includes("page 1 was blurry"));
  assert.ok(!holdsPayloadRun(everywhere(result), payload), "no part of the file in the result, storage, backup or share file");
}

// ---------------------------------------------------------------------------
// 4. Romanian wording of unsupported constructs and units
// ---------------------------------------------------------------------------
{
  const converted = convertAiProgramToShare(
    {
      name: "Program RO",
      days: [
        {
          name: "Ziua 1",
          notes: "Circuit contra timp la final.",
          exercises: [
            ex({ name: "Probe A", notes: "Ultimul set: 2 seturi descendente." }),
            ex({ name: "Probe B", notes: "Dacă faci toate repetările, adaugă 2,5 kg." }),
            ex({ name: "Probe C", notes: "Daca iese usor creste greutatea data viitoare." }),
            ex({ name: "Probe D", notes: "10 minute, câte 3 repetări la fiecare minut." }),
            ex({ name: "Probe E", notes: "Repaus-pauză pe ultimul set." }),
            ex({ name: "Probe F", notes: "Drop-seturi la ultimul set, tempo 3-1-1-0." }),
            ex({ name: "Probe G", notes: "Coboară controlat și ține pieptul sus." }),
          ],
        },
      ],
    },
    catalog,
    NOW,
  );
  assert.equal(converted.valid, true, converted.error);
  const lines = converted.share.draftMeta.uncertainty;
  const lineOf = (name) => lines.filter((line) => line.includes(`"${name}"`));
  const expectLabel = (name, label) => {
    assert.ok(
      lineOf(name).some((line) => line.includes(`${UNSUPPORTED_CONSTRUCT_UNCERTAINTY}: ${label}`)),
      `${name}: "${label}" is disclosed (got ${JSON.stringify(lineOf(name))})`,
    );
  };
  expectLabel("Probe A", "drop sets");
  expectLabel("Probe B", "conditional load");
  expectLabel("Probe C", "conditional load");
  expectLabel("Probe D", "EMOM format");
  expectLabel("Probe E", "rest-pause");
  expectLabel("Probe F", "tempo prescription, drop sets");
  assert.deepEqual(lineOf("Probe G"), [], "a plain Romanian cue is not a construct");
  assert.ok(
    lines.some((line) => line.includes(`${UNSUPPORTED_CONSTRUCT_UNCERTAINTY}: for-time format`)),
    `the day note "contra timp" is disclosed (got ${JSON.stringify(lines)})`,
  );
  // The wording itself stays in the notes.
  assert.equal(converted.share.programExercises[1].notes, "Dacă faci toate repetările, adaugă 2,5 kg.");

  const units = (weights) =>
    convertAiProgramToShare(
      {
        name: "Units RO",
        days: [{ name: "Ziua 1", exercises: weights.map((sourceWeight, index) => ex({ name: `Unit Probe ${index}`, sourceWeight })) }],
      },
      catalog,
      NOW,
    );
  const livre = units(["175 livre", "80 de livre"]);
  assert.equal(livre.valid, true, livre.error);
  assert.ok(livre.share.draftMeta.uncertainty.includes(`${LB_UNIT_UNCERTAINTY}.`), JSON.stringify(livre.share.draftMeta.uncertainty));
  const mixed = units(["175 livre", "80 kilograme"]);
  assert.ok(mixed.share.draftMeta.uncertainty.includes(`${MIXED_UNIT_UNCERTAINTY}.`), JSON.stringify(mixed.share.draftMeta.uncertainty));
  const kilograms = units(["80 kilograme", "60 de kile"]);
  assert.ok(!kilograms.share.draftMeta.uncertainty.some((line) => line.includes("lb")), "kg written in Romanian is kg");
}

assert.equal(setGeminiApiKey("").ok, true);
console.log("AI H3 fix round 3 verification passed.");
