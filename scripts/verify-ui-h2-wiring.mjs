// Phase H2 UI track: wiring assertions that cannot run through the draft
// model alone. Source-level checks (deterministic, no browser) for:
// - H1 follow-up (a): readiness save shows success only after writeStorage ok
// - H1 follow-up (b): readiness trend list keys carry the session id
// - PWA update prompt: registerType "prompt", no skipWaiting/clientsClaim,
//   registration via virtual:pwa-register with onNeedRefresh/onRegisteredSW,
//   update check on visibilitychange + hourly, banner copy, and neither the
//   banner nor main.jsx touches localStorage (workout drafts survive Reload)
// - AI import assistant and Program page go through the shared draft model
//   (draftFromShare / validateProgramDraft / saveProgramDraft) and defaults
//   keep "Duplicate to edit" (Edit Program / Edit with AI only on custom)
// Plus a behavioural check that the H2 studio save path (applyProgramDraft
// result -> removeExerciseFromNextPlans for removed + changed ids) clears the
// pending plan entries the way App.jsx applies it. The stored-copy, unmount
// flush, Cancel ordering and tab-switch restore behaviours themselves are
// fixtures in verify-program-studio.mjs (planDraftStore, flushPendingDraftStore,
// cancelStudioSession, openStudioSession / updateStudioSessionDraft); here
// only the wiring of those helpers is checked.
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
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const { applyProgramDraft, duplicateProgram, DEFAULT_PROGRAM_ID, removeExerciseFromNextPlans, seedDefaultProgramIfNeeded } =
  await import("../src/lib/programStorage.js");
const { draftFromProgram, removeExercise, updateExercise } = await import("../src/lib/programDraft.js");

try {
  const app = read("src/App.jsx");
  const main = read("src/main.jsx");
  const banner = read("src/components/PwaUpdateBanner.jsx");
  const viteConfig = read("vite.config.js");
  const assistant = read("src/components/AiProgramImportAssistant.jsx");
  const studio = read("src/components/ProgramStudio.jsx");

  // ------------------------------------------------------------------
  // H1 follow-up (a): readiness success only after a durable write
  // ------------------------------------------------------------------
  // The decision itself (ok -> saved message + new map, else error + input
  // map) is the pure helper saveReadinessCheckIn, fixture
  // verify-readiness-save.mjs; here only App's wiring of it is checked.
  const readinessFn = app.slice(app.indexOf("function saveTodayReadiness()"), app.indexOf("function handleSelectDay("));
  assert.ok(app.includes('import { saveReadinessCheckIn } from "./lib/readinessSave.js"'), "App uses the readiness save helper");
  assert.ok(readinessFn.includes("saveReadinessCheckIn({"), "readiness is saved through the helper");
  assert.ok(readinessFn.includes("write: (value) => writeStorage(STORAGE_KEYS.readinessByDate, value)"), "the helper writes through the checked writeStorage");
  const successIndex = readinessFn.indexOf("if (result.ok)");
  const mirrorIndex = readinessFn.indexOf("setReadinessByDate(result.readinessByDate)");
  assert.ok(successIndex !== -1 && mirrorIndex > successIndex, "the hook state is mirrored only on a successful write");
  assert.ok(readinessFn.includes("setReadinessSaveMessage(result.message)"), "the message comes from the helper's decision");
  assert.ok(!readinessFn.includes("Today's readiness saved."), "no success copy is hard-coded next to an unchecked write");
  assert.ok(!/setReadinessByDate\(\(currentReadiness\)/.test(readinessFn), "no optimistic functional update before the write");
  assert.ok(!/setReadinessByDate\(next/.test(readinessFn), "no unconditional state update");

  // ------------------------------------------------------------------
  // H1 follow-up (b): readiness trend keys are unique per session
  // ------------------------------------------------------------------
  assert.ok(!app.includes("key={entry.date}"), "the readiness trend no longer keys on the date alone");
  assert.ok(app.includes("key={entry.sessionId ? `${entry.date}:${entry.sessionId}` : entry.date}"));
  assert.ok(app.includes("sessionId: session.id ?? null"), "session-derived entries carry the session id");

  // ------------------------------------------------------------------
  // PWA update prompt
  // ------------------------------------------------------------------
  assert.ok(/registerType:\s*"prompt"/.test(viteConfig), "VitePWA uses registerType prompt");
  assert.ok(/cleanupOutdatedCaches:\s*true/.test(viteConfig), "cleanupOutdatedCaches kept");
  assert.ok(!/skipWaiting:\s*true/.test(viteConfig), "skipWaiting removed (prompt flow)");
  assert.ok(!/clientsClaim:\s*true/.test(viteConfig), "clientsClaim removed (prompt flow)");
  // The banner state machine, the hourly / visibilitychange checks and the
  // Reload call are src/lib/pwaUpdate.js (fixture verify-pwa-update.mjs);
  // here only main.jsx's wiring of them is checked.
  assert.ok(main.includes('from "virtual:pwa-register"'), "main.jsx registers through virtual:pwa-register");
  assert.ok(main.includes('from "./lib/pwaUpdate.js"'), "main.jsx uses the pwaUpdate helpers");
  assert.ok(main.includes("onNeedRefresh()"), "onNeedRefresh handled");
  assert.ok(main.includes("dispatch(PWA_UPDATE_EVENTS.needRefresh)"), "a waiting worker shows the banner");
  assert.ok(main.includes("onRegisteredSW("), "onRegisteredSW handled");
  assert.ok(main.includes("startPwaUpdateChecks({ registration: swRegistration ?? null })"), "hourly + visibility checks start from the registration");
  assert.ok(main.includes("checks?.stop()"), "the checks are stopped on unmount");
  assert.ok(main.includes("useReducer(reducePwaUpdateState, INITIAL_PWA_UPDATE_STATE)"), "banner state through the reducer");
  assert.ok(main.includes("requestPwaReload({") && main.includes("updateServiceWorker: updateServiceWorkerRef.current"), "Reload goes through requestPwaReload (updateServiceWorker(true))");
  assert.ok(main.includes("dispatch(PWA_UPDATE_EVENTS.reloadFailed)"), "a failed activation leaves the reloading state");
  assert.ok(main.includes("onLater={() => dispatch(PWA_UPDATE_EVENTS.later)}"), "Later hides the banner through the reducer");
  assert.ok(main.includes("<PwaUpdateBanner"), "the banner is rendered from main.jsx");
  assert.ok(banner.includes("A new version is available"), "banner copy");
  assert.ok(banner.includes(">Reload<") || banner.includes('"Reload"'), "Reload action");
  assert.ok(banner.includes("Later"), "Later action");
  [main, banner, read("src/lib/pwaUpdate.js")].forEach((source) => {
    assert.ok(!/localStorage\s*[.[]/.test(source), "the update flow never touches localStorage (drafts survive)");
    assert.ok(!/resetLocalAppData|removeItem|\.clear\(/.test(source), "the update flow never clears data");
  });

  // ------------------------------------------------------------------
  // Shared draft model on every entry point; defaults protected
  // ------------------------------------------------------------------
  assert.ok(assistant.includes('draftFromShare(draft.share, { origin: "ai-import" })'), "AI import converts through draftFromShare");
  assert.ok(assistant.includes("validateProgramDraft(programDraft)"), "AI import validates the draft before saving");
  assert.ok(assistant.includes("onSaveProgramDraft(programDraft)"), "AI import saves through the draft writer");
  assert.ok(!assistant.includes("onImportProgramShare"), "the AI assistant no longer bypasses the draft model");
  assert.ok(assistant.includes("Edit draft in Studio"), "Studio entry from the AI preview");
  assert.ok(assistant.includes("exercise.restLabel"), "rest ranges use the preview's restLabel");
  assert.ok(assistant.includes("Source load:"), "source loads are shown as info only");
  assert.ok(assistant.includes("draft.preview.uncertainty"), "uncertainty list is shown");
  assert.ok(app.includes('draftFromShare(pendingImport.share, { origin: "file-import" })'), "file import can open the Studio");
  assert.ok(app.includes("Review in Studio") && app.includes("Import as is"), "file import offers both paths");
  assert.ok(app.includes("validateProgramShareStrict(share)"), "file import validates before offering the choice");
  assert.ok(app.includes("saveProgramDraft(draft)") && app.includes("applyProgramDraft(draft)"), "studio save uses the H2 writers");
  assert.ok(app.includes("!isDefaultProgram && onEditProgram"), "Edit Program only on custom programs");
  assert.ok(app.includes("!isDefaultProgram && onOpenStudio"), "Edit with AI only on custom programs");
  assert.ok(app.includes("Duplicate to Edit"), "defaults keep Duplicate to edit");
  assert.ok(app.includes('origin: "ai-edit"') && app.includes("extractProgramEditWithAi({ share, instruction: cleanInstruction })"));
  assert.ok(app.includes("...result.removedProgramExerciseIds, ...result.changedProgramExerciseIds"), "nextPlans cleared for removed + changed exercises");
  assert.ok(studio.includes("saveDraftToStorage(working)"), "the working copy is autosaved");
  assert.ok(studio.includes("deleteStoredDraft(working.draftId)"), "the stored copy is removed on save / cancel");
  assert.ok(studio.includes("disabled={!validation.valid || isSaving}"), "Save is disabled while invalid");
  assert.ok(studio.includes("Warm-up - informational only"), "warm-up editor is labelled informational");
  assert.ok(studio.includes("New exercise (no technique content yet)"), "new exercise option");
  assert.ok(studio.includes("Source listed"), "sourceWeight shown read-only");

  // ------------------------------------------------------------------
  // Behaviour: apply result -> nextPlans cleared the way App.jsx does it
  // ------------------------------------------------------------------
  seedDefaultProgramIfNeeded();
  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.ok(copy.ok);
  let draft = draftFromProgram(copy.programId).draft;
  const day = draft.days[0];
  const changedId = day.sections[0].exercises[0].id;
  const removedId = day.sections[0].exercises[1].id;
  const keptId = day.sections[0].exercises[2].id;
  draft = updateExercise(draft, day.id, changedId, { targetSets: 6 });
  draft = removeExercise(draft, day.id, removedId);
  const nextPlans = {
    [day.id]: {
      generatedAt: "2026-09-26T00:00:00.000Z",
      // Plan entries reference the program exercise through `exerciseId`
      // (the same field removeExerciseFromNextPlans filters on).
      exercises: [
        { exerciseId: changedId, sets: 4 },
        { exerciseId: removedId, sets: 3 },
        { exerciseId: keptId, sets: 3 },
      ],
    },
  };
  const applied = applyProgramDraft(draft);
  assert.ok(applied.ok, applied.error);
  assert.deepEqual([...applied.removedProgramExerciseIds].sort(), [removedId]);
  assert.deepEqual([...applied.changedProgramExerciseIds].sort(), [changedId]);
  const affected = [...applied.removedProgramExerciseIds, ...applied.changedProgramExerciseIds];
  const cleared = affected.reduce((plans, id) => removeExerciseFromNextPlans(plans, id), nextPlans);
  const remaining = (cleared[day.id]?.exercises ?? []).map((exercise) => exercise.exerciseId);
  assert.deepEqual(remaining, [keptId], "only the untouched exercise keeps its pending plan entry");
  assert.deepEqual(
    (nextPlans[day.id].exercises ?? []).map((exercise) => exercise.exerciseId),
    [changedId, removedId, keptId],
    "the input plans object is not mutated",
  );

  // ------------------------------------------------------------------
  // Fix round 1: the Studio survives a tab switch, review drafts are kept
  // from the start, Discard / Cancel ask first, help text stays honest
  // ------------------------------------------------------------------
  assert.ok(app.includes("onStudioDraftChange={handleProgramStudioDraftChange}"), "App keeps the Studio's working copy");
  assert.ok(app.includes("onDraftChange={onStudioDraftChange}"), "the Studio reports every edit to App");
  assert.ok(app.includes("initialDraft={studio.initialDraft ?? studio.draft}"), "a remount starts from the working copy with the original as baseline");
  assert.ok(studio.includes("onDraftChange?.(nextDraft)"), "every edit is reported to the parent");
  assert.ok(studio.includes("const initialRef = useRef(initialDraft ?? draft)"), "dirty / diff compare against the draft the session opened with");
  assert.ok(studio.includes("planDraftStore({"), "the stored copy follows planDraftStore (review at once, edits after a pause, reverted edits removed)");
  assert.ok(studio.includes("storedCopyDiffers:") && studio.includes("loadStoredDraft(working.draftId)"), "a resumed draft compares against its stored copy");
  assert.ok(studio.includes('plan.action === "delete"') && studio.includes("deleteStoredDraft(working.draftId)"), "a reverted edit removes the stored copy");
  assert.ok(studio.includes("setAutosaveState(describeDraftStoreResult(result))"), "an eviction by the draft cap is told to the user");
  assert.ok(studio.includes("flushPendingDraftStore({") && studio.includes("save: saveDraftToStorage"), "a pending autosave is flushed on unmount through the helper");
  assert.ok(studio.includes("cancelStudioSession({") && studio.includes("discard: closeStudio"), "Cancel asks (cancelStudioSession) before closeStudio removes the stored copy");
  assert.ok(app.includes("setProgramStudio(openStudioSession(session))"), "App opens sessions through the helper");
  assert.ok(app.includes("updateStudioSessionDraft(current, draft)"), "App records the working copy through the helper");
  const discardStart = app.indexOf("function discardStoredDraft(");
  const discardFn = app.slice(discardStart, app.indexOf("deleteStoredDraft(draftId)", discardStart));
  assert.ok(discardFn.includes("window.confirm("), "Discard asks for confirmation before deleting a stored draft");
  assert.ok(!/make Day 3\s+optional/.test(app), "the AI edit help text does not suggest an edit the schema cannot express");
  assert.ok(app.includes("draft.reviewNotes"), "a resumed review draft shows the AI notes again");

  console.log("verify-ui-h2-wiring: ok");
} catch (error) {
  console.error(error);
  process.exit(1);
}
