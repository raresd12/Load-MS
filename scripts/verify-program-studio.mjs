// Phase H2 UI track: Program Studio helpers (src/lib/programStudio.js).
// Form <-> draft conversion, per-item validation error grouping, Library
// search, provenance labels, studio mode resolution and diff description.
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
console.warn = () => {};

const {
  getExerciseLibrary,
  seedDefaultProgramIfNeeded,
  duplicateProgram,
  DEFAULT_PROGRAM_ID,
  deleteStoredDraft,
  listStoredDrafts,
  loadStoredDraft,
  saveDraftToStorage,
} = await import("../src/lib/programStorage.js");
const {
  addExercise,
  createBlankProgramDraft,
  diffDraftAgainstProgram,
  draftFromProgram,
  removeExercise,
  updateExercise,
  updateProgramMeta,
  validateProgramDraft,
} = await import("../src/lib/programDraft.js");
const {
  buildExercisePatch,
  cancelStudioSession,
  countDayExercises,
  countDraftProvenance,
  createExerciseForm,
  describeDraftDiff,
  describeDraftStoreResult,
  flushPendingDraftStore,
  formatDraftPrescription,
  getProvenanceLabel,
  groupDraftValidationErrors,
  isDraftDirty,
  openStudioSession,
  planDraftStore,
  resolveStudioModeForDraft,
  searchLibraryEntries,
  STUDIO_MODES,
  updateStudioSessionDraft,
} = await import("../src/lib/programStudio.js");

try {
  seedDefaultProgramIfNeeded();
  assert.deepEqual([...STUDIO_MODES], ["create", "edit", "review"]);

  // ------------------------------------------------------------------
  // Form <-> draft: one field at a time, provenance only on that field
  // ------------------------------------------------------------------
  let draft = updateProgramMeta(createBlankProgramDraft(), { name: "Studio" });
  const dayId = draft.days[0].id;
  const sectionId = draft.days[0].sections[0].id;
  draft = addExercise(draft, dayId, sectionId, { exerciseId: "bench-press", restTime: [150, 180], sourceWeight: "80 kg" });
  let bench = draft.days[0].sections[0].exercises[0];
  const form = createExerciseForm(bench);
  assert.equal(form.targetSets, "3");
  assert.equal(form.repsMin, "8");
  assert.equal(form.repsMax, "12");
  assert.equal(form.repsLabel, "");
  assert.equal(form.restTime, "150-180", "a rest range is edited as min-max (19.4-3)");
  assert.equal(form.targetWeight, "");
  assert.equal(form.loadType, "external");
  assert.equal(form.weightMode, "kg");
  assert.equal(form.isOptional, false);
  assert.equal(formatDraftPrescription(bench), "3x 8-12 | coach sets kg | RPE 8 | 150-180 s");
  assert.equal(getProvenanceLabel(bench, "targetSets"), "default");
  assert.equal(getProvenanceLabel(bench, "restTime"), "edited");
  assert.equal(getProvenanceLabel(bench, "nope"), "");

  let result = buildExercisePatch("targetSets", "5", form);
  assert.deepEqual(result.patch, { targetSets: 5 });
  draft = updateExercise(draft, dayId, bench.id, result.patch);
  bench = draft.days[0].sections[0].exercises[0];
  assert.equal(bench.targetSets, 5);
  assert.equal(bench.provenance.targetSets, "edited");
  assert.equal(bench.provenance.targetReps, "default", "untouched fields keep their provenance");

  result = buildExercisePatch("repsMax", "", { ...form, repsMin: "6" });
  assert.deepEqual(result.patch, { targetReps: { min: 6, max: null, label: null } });
  result = buildExercisePatch("repsLabel", " 30 s ", { ...form, repsMin: "", repsMax: "" });
  assert.deepEqual(result.patch, { targetReps: { min: null, max: null, label: "30 s" } });

  result = buildExercisePatch("targetSets", "abc", form);
  draft = updateExercise(draft, dayId, bench.id, result.patch);
  bench = draft.days[0].sections[0].exercises[0];
  assert.equal(bench.targetSets, null, "unusable text clears the value so validation reports it");
  const invalid = validateProgramDraft(draft);
  assert.equal(invalid.valid, false);

  assert.deepEqual(buildExercisePatch("targetWeight", "", form).patch, { targetWeight: null });
  assert.deepEqual(buildExercisePatch("targetWeight", "bw", form).patch, { targetWeight: "BW" });
  assert.deepEqual(buildExercisePatch("targetWeight", "62.5", form).patch, { targetWeight: 62.5 });
  assert.deepEqual(buildExercisePatch("targetWeight", "heavy", form).patch, { targetWeight: "heavy" }, "unusable weight text reaches the draft");
  assert.match(buildExercisePatch("targetWeight", "heavy", form).error, /Weight/);
  assert.deepEqual(buildExercisePatch("restTime", "90", form).patch, { restTime: 90 });
  assert.deepEqual(buildExercisePatch("restTime", "150-180", form).patch, { restTime: [150, 180] });
  assert.deepEqual(buildExercisePatch("restTime", "", form).patch, { restTime: null });
  assert.deepEqual(buildExercisePatch("restTime", "180-150", form).patch, { restTime: "180-150" }, "unusable rest text reaches the draft");
  assert.match(buildExercisePatch("restTime", "180-150", form).error, /min-max/);
  assert.equal(buildExercisePatch("restTime", "90", form).error, undefined);

  // Unusable rest / weight text makes the draft invalid (Save blocked) and is
  // still shown when the exercise screen is reopened, instead of the previous
  // value silently surviving behind the field.
  let stale = updateExercise(draft, dayId, bench.id, { targetSets: 4, restTime: 90, targetWeight: 40 });
  assert.equal(validateProgramDraft(stale).valid, true);
  stale = updateExercise(stale, dayId, bench.id, buildExercisePatch("restTime", "150-", form).patch);
  stale = updateExercise(stale, dayId, bench.id, buildExercisePatch("targetWeight", "abc", form).patch);
  const staleBench = stale.days[0].sections[0].exercises[0];
  assert.equal(staleBench.restTime, "150-");
  assert.equal(staleBench.targetWeight, "abc");
  const stalePaths = validateProgramDraft(stale).errors.map((entry) => entry.path);
  assert.ok(stalePaths.includes("days[0].sections[0].exercises[0].restTime"), "the draft is invalid while the rest text is unusable");
  assert.ok(stalePaths.includes("days[0].sections[0].exercises[0].targetWeight"), "the draft is invalid while the weight text is unusable");
  const staleForm = createExerciseForm(staleBench);
  assert.equal(staleForm.restTime, "150-", "the typed rest text is what the reopened screen shows");
  assert.equal(staleForm.targetWeight, "abc");
  const repaired = updateExercise(stale, dayId, bench.id, { ...buildExercisePatch("restTime", "150-180", form).patch, ...buildExercisePatch("targetWeight", "", form).patch });
  assert.equal(validateProgramDraft(repaired).valid, true, "usable text makes the draft valid again");
  assert.deepEqual(buildExercisePatch("isOptional", true, form).patch, { isOptional: true });
  assert.deepEqual(buildExercisePatch("sourceWeight", "70% 1RM", form).patch, { sourceWeight: "70% 1RM" });
  assert.equal(buildExercisePatch("bogus", "x", form).patch, null);

  // ------------------------------------------------------------------
  // Validation errors are grouped per day / section / exercise
  // ------------------------------------------------------------------
  const grouped = groupDraftValidationErrors(draft, invalid.errors);
  assert.ok(grouped.byExerciseId[bench.id]?.some((message) => /sets/i.test(message)));
  assert.ok(grouped.byDayId[dayId]?.length >= 1, "the day lists its exercises' errors");
  assert.ok(grouped.all.some((entry) => entry.label === "Day 1 > Bench Press"));
  const noName = groupDraftValidationErrors(draft, [{ path: "program.name", message: "Program name is required." }]);
  assert.deepEqual(noName.program, ["Program name is required."]);
  assert.equal(noName.all[0].label, "Program");
  const sectionErr = groupDraftValidationErrors(draft, [{ path: "days[0].sections[0].name", message: "Section name is required." }]);
  assert.deepEqual(sectionErr.bySectionId[sectionId], ["Section name is required."]);
  assert.deepEqual(sectionErr.byExerciseId, {});
  const emptyGroup = groupDraftValidationErrors(draft, []);
  assert.deepEqual(emptyGroup.all, []);

  // ------------------------------------------------------------------
  // Library search: name / category / equipment / muscles, name first
  // ------------------------------------------------------------------
  const library = getExerciseLibrary();
  assert.ok(library.length > 10);
  const all = searchLibraryEntries(library, "", 0);
  assert.equal(all.length, library.length, "empty query lists every entry");
  const normalizedNames = all.map((entry) => entry.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  assert.deepEqual(normalizedNames, [...normalizedNames].sort((a, b) => a.localeCompare(b)), "empty query is name order");
  const benchHits = searchLibraryEntries(library, "bench");
  assert.ok(benchHits.length >= 1);
  assert.match(benchHits[0].name.toLowerCase(), /^bench/, "prefix name matches come first");
  const byEquipment = searchLibraryEntries(library, "dumbbell", 0);
  assert.ok(byEquipment.length >= 1);
  assert.ok(
    byEquipment.every((entry) => `${entry.name} ${entry.equipment} ${entry.id}`.toLowerCase().includes("dumbbell")),
  );
  const byMuscle = searchLibraryEntries(library, "chest", 0);
  assert.ok(byMuscle.some((entry) => (entry.mainMuscles ?? []).some((muscle) => /chest/i.test(muscle))));
  assert.deepEqual(searchLibraryEntries(library, "zzzz-no-such-exercise"), []);
  assert.equal(searchLibraryEntries(library, "", 5).length, 5, "limit caps the list");
  assert.deepEqual(searchLibraryEntries(null, "x"), []);

  // ------------------------------------------------------------------
  // Dirty check, mode resolution, counts
  // ------------------------------------------------------------------
  const opened = updateProgramMeta(createBlankProgramDraft(), { name: "Opened" });
  assert.equal(isDraftDirty(opened, opened), false);
  assert.equal(isDraftDirty(opened, { ...opened, updatedAt: "2030-01-01T00:00:00.000Z" }), false, "timestamps do not count");
  assert.equal(isDraftDirty(opened, updateProgramMeta(opened, { name: "Changed" })), true);
  assert.equal(resolveStudioModeForDraft({ origin: "blank", sourceProgramId: null }), "create");
  assert.equal(resolveStudioModeForDraft({ origin: "ai-import", sourceProgramId: null }), "review");
  assert.equal(resolveStudioModeForDraft({ origin: "file-import", sourceProgramId: null }), "review");
  assert.equal(resolveStudioModeForDraft({ origin: "program", sourceProgramId: "p1" }), "edit");
  assert.equal(resolveStudioModeForDraft({ origin: "ai-edit", sourceProgramId: "p1" }), "review");
  assert.equal(countDayExercises(draft.days[0]), 1);
  const counts = countDraftProvenance(draft);
  assert.ok(counts.edited >= 2 && counts.default >= 1);
  assert.equal(counts.source, 0);

  // ------------------------------------------------------------------
  // Diff description of an edited custom program
  // ------------------------------------------------------------------
  const copy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.ok(copy.ok);
  let edit = draftFromProgram(copy.programId).draft;
  assert.equal(describeDraftDiff(diffDraftAgainstProgram(edit)).isEmpty, true, "an untouched program has an empty diff");
  const firstDay = edit.days[0];
  const firstExercise = firstDay.sections[0].exercises[0];
  const secondExercise = firstDay.sections[0].exercises[1];
  edit = updateExercise(edit, firstDay.id, firstExercise.id, { targetSets: 6 });
  edit = removeExercise(edit, firstDay.id, secondExercise.id);
  edit = addExercise(edit, firstDay.id, firstDay.sections[0].id, { exerciseId: "bench-press" });
  edit = updateProgramMeta(edit, { goal: "New goal" });
  const described = describeDraftDiff(diffDraftAgainstProgram(edit));
  assert.equal(described.isEmpty, false);
  assert.deepEqual(described.removed, [secondExercise.name]);
  assert.equal(described.added.length, 1);
  assert.match(described.added[0], /Bench Press/);
  assert.equal(described.changed.length, 1);
  assert.match(described.changed[0].title, /progression restarts/);
  assert.ok(described.changed[0].fields.some((line) => /targetSets: \d+ -> 6/.test(line)));
  assert.ok(described.program.some((line) => /goal/.test(line) && /New goal/.test(line)));
  assert.equal(describeDraftDiff({ ok: false, error: "x" }).isEmpty, true);
  assert.equal(describeDraftDiff(null).isEmpty, true);

  // Day-level changes and Library replacements are readable in the review panel.
  const dayChanged = describeDraftDiff({
    ok: true,
    program: [],
    days: {
      added: [],
      removed: [],
      renamed: [],
      changed: [
        {
          id: "d",
          name: "Push",
          fields: [
            { field: "warmup", from: null, to: { title: "Warm-up", items: [{ name: "Jumping jacks", prescription: "5 min", notes: "" }] } },
            { field: "isOptional", from: false, to: true },
            { field: "notes", from: "", to: "Injected note" },
          ],
        },
      ],
    },
    exercises: {
      added: [{ id: "e", name: "Lat Pulldown", dayId: "d", replaces: { id: "e", name: "Bench Press" } }],
      removed: [],
      moved: [],
      changed: [],
    },
  });
  assert.equal(dayChanged.isEmpty, false);
  assert.ok(dayChanged.days.some((line) => /Day "Push" warm-up: no warm-up -> 1 item \(Jumping jacks\)/.test(line)), dayChanged.days.join(" | "));
  assert.ok(dayChanged.days.some((line) => /isOptional: required -> optional/.test(line)));
  assert.ok(dayChanged.days.some((line) => /notes: empty -> Injected note/.test(line)));
  assert.match(dayChanged.added[0], /Lat Pulldown - replaces Bench Press/);

  // ------------------------------------------------------------------
  // Fix round 2: the Studio session helpers (stored copy, unmount flush,
  // Cancel ordering, App-state restore) against real draft storage.
  // ------------------------------------------------------------------
  // planDraftStore: review at once, edits after the pause, a reverted edit
  // removes the stored copy, a resumed draft's copy follows the working copy.
  assert.deepEqual(planDraftStore({ dirty: true, mode: "edit", delay: 800 }), { action: "save", delay: 800 });
  assert.deepEqual(planDraftStore({ dirty: true, mode: "create", isResumed: true, delay: 800 }), { action: "save", delay: 800 });
  assert.deepEqual(planDraftStore({ dirty: false, mode: "review" }), { action: "save", delay: 0 }, "a review draft is kept from the moment it opens");
  assert.deepEqual(planDraftStore({ dirty: false, mode: "edit" }), { action: "delete", delay: 0 }, "back at the original: no stale copy to resume");
  assert.deepEqual(planDraftStore({ dirty: false, mode: "create" }), { action: "delete", delay: 0 });
  assert.deepEqual(planDraftStore({ dirty: false, mode: "edit", isResumed: true, storedCopyDiffers: false }), { action: "none", delay: 0 });
  assert.deepEqual(
    planDraftStore({ dirty: false, mode: "edit", isResumed: true, storedCopyDiffers: true }),
    { action: "save", delay: 0 },
    "a resumed draft put back the way it was resumed rewrites the stored copy at once",
  );

  // The stale-copy scenario end to end: edit (stored) -> revert -> nothing to resume.
  const staleCopy = duplicateProgram(DEFAULT_PROGRAM_ID);
  assert.ok(staleCopy.ok);
  const staleOriginal = draftFromProgram(staleCopy.programId).draft;
  const staleEdited = updateProgramMeta(staleOriginal, { name: "Review probe X" });
  const runPlan = (working, initial, options) => {
    const plan = planDraftStore({ dirty: isDraftDirty(initial, working), ...options });
    if (plan.action === "save") {
      return saveDraftToStorage(working);
    }
    if (plan.action === "delete") {
      return deleteStoredDraft(working.draftId);
    }
    return null;
  };
  assert.equal(runPlan(staleEdited, staleOriginal, { mode: "edit" }).ok, true);
  assert.equal(loadStoredDraft(staleOriginal.draftId).program.name, "Review probe X", "the edit is stored");
  const revertedResult = runPlan(updateProgramMeta(staleEdited, { name: staleOriginal.program.name }), staleOriginal, { mode: "edit" });
  assert.deepEqual(revertedResult, { ok: true, removed: true }, "reverting the edit removes the stored copy");
  assert.equal(loadStoredDraft(staleOriginal.draftId), null, "a reload has nothing stale to resume");
  // Resumed: the stored copy follows the working copy instead of going away.
  assert.equal(saveDraftToStorage(staleEdited).ok, true);
  const resumed = loadStoredDraft(staleEdited.draftId);
  const resumedEdited = updateProgramMeta(resumed, { name: "Review probe Y" });
  assert.equal(runPlan(resumedEdited, resumed, { mode: "edit", isResumed: true }).ok, true);
  assert.equal(loadStoredDraft(resumed.draftId).program.name, "Review probe Y");
  const resumedBack = updateProgramMeta(resumedEdited, { name: resumed.program.name });
  const backResult = runPlan(resumedBack, resumed, {
    mode: "edit",
    isResumed: true,
    storedCopyDiffers: isDraftDirty(loadStoredDraft(resumedBack.draftId), resumedBack),
  });
  assert.equal(backResult.ok, true, "the stored copy is rewritten");
  assert.equal(loadStoredDraft(resumed.draftId).program.name, "Review probe X", "the resumed draft is still there to resume, as resumed");
  assert.equal(
    runPlan(resumedBack, resumed, { mode: "edit", isResumed: true, storedCopyDiffers: isDraftDirty(loadStoredDraft(resumedBack.draftId), resumedBack) }),
    null,
    "nothing to do once the stored copy matches",
  );
  assert.equal(deleteStoredDraft(resumed.draftId).ok, true);

  // describeDraftStoreResult: an eviction never reads like a plain success.
  assert.equal(describeDraftStoreResult({ ok: true, droppedDrafts: [] }), "Unsaved draft kept on this device.");
  assert.equal(describeDraftStoreResult({ ok: true }), "Unsaved draft kept on this device.");
  assert.equal(describeDraftStoreResult({ ok: false, error: "Storage is full." }), "Draft not kept: Storage is full.");
  const evicted = describeDraftStoreResult({
    ok: true,
    droppedDraftIds: ["a"],
    droppedDrafts: [{ draftId: "a", origin: "ai-import", programName: "Photo import" }],
  });
  assert.match(evicted, /^Unsaved draft kept on this device\. Draft slots are full: the oldest unsaved draft \("Photo import"\) was removed to make room and cannot be resumed\.$/);
  assert.match(
    describeDraftStoreResult({ ok: true, droppedDrafts: [{ draftId: "a", origin: "blank", programName: "" }, { draftId: "b", origin: "ai-edit", programName: "Old" }] }),
    /the oldest unsaved drafts \(an unnamed draft, "Old"\) were removed/,
  );
  // ...and the storage layer reports what the message needs (the cap, H2-3).
  const capIds = [];
  for (let index = 0; index < 6; index += 1) {
    const capDraft = updateProgramMeta(createBlankProgramDraft(), { name: `Cap ${index}` });
    const capResult = saveDraftToStorage({ ...capDraft, updatedAt: `2026-09-1${index}T00:00:00.000Z` });
    assert.equal(capResult.ok, true);
    capIds.push(capDraft.draftId);
    if (index === 5) {
      assert.deepEqual(capResult.droppedDrafts, [{ draftId: capIds[0], origin: "blank", programName: "Cap 0" }]);
      assert.match(describeDraftStoreResult(capResult), /"Cap 0"/);
    }
  }
  listStoredDrafts().forEach((entry) => deleteStoredDraft(entry.draftId));

  // flushPendingDraftStore: only a pending, not-closed session writes.
  const flushed = [];
  const flushSave = (draft) => {
    flushed.push(draft.draftId);
    return { ok: true };
  };
  assert.deepEqual(flushPendingDraftStore({ pending: true, closed: false, draft: staleEdited, save: flushSave }), { ok: true });
  assert.equal(flushPendingDraftStore({ pending: true, closed: true, draft: staleEdited, save: flushSave }), null, "a closed Studio flushes nothing");
  assert.equal(flushPendingDraftStore({ pending: false, closed: false, draft: staleEdited, save: flushSave }), null, "nothing pending, nothing written");
  assert.deepEqual(flushed, [staleEdited.draftId]);

  // cancelStudioSession: the answer comes before the discard, never after.
  const cancelLog = [];
  const cancelWith = (answer, options) =>
    cancelStudioSession({
      ...options,
      draftId: "d1",
      confirm: (message) => {
        cancelLog.push(["confirm", message]);
        return answer;
      },
      discard: (draftId) => cancelLog.push(["discard", draftId]),
    });
  assert.deepEqual(cancelWith(false, { dirty: true, mode: "edit" }), { cancelled: false, asked: true });
  assert.deepEqual(cancelLog.map(([step]) => step), ["confirm"], "a declined Cancel discards nothing");
  cancelLog.length = 0;
  assert.deepEqual(cancelWith(true, { dirty: true, mode: "edit" }), { cancelled: true, asked: true });
  assert.deepEqual(cancelLog.map(([step]) => step), ["confirm", "discard"], "a confirmed Cancel discards after the answer");
  assert.equal(cancelLog[1][1], "d1");
  cancelLog.length = 0;
  assert.deepEqual(cancelWith(false, { dirty: false, mode: "create" }), { cancelled: true, asked: false });
  assert.deepEqual(cancelLog.map(([step]) => step), ["discard"], "an untouched create / edit draft closes without asking");
  cancelLog.length = 0;
  assert.deepEqual(cancelWith(false, { dirty: false, mode: "review" }), { cancelled: false, asked: true }, "an untouched review draft asks");
  assert.match(cancelLog[0][1], /imported result is not kept anywhere else/);
  cancelLog.length = 0;
  assert.deepEqual(cancelWith(false, { dirty: false, mode: "edit", isResumed: true }), { cancelled: false, asked: true }, "a resumed draft asks");
  assert.match(cancelLog[0][1], /^Discard this draft\? Your saved programs are not affected\.$/);

  // App state: a remount starts from the working copy with the original as
  // the dirty / diff baseline; another session's draft is ignored.
  assert.equal(openStudioSession(null), null);
  const session = openStudioSession({ draft: staleOriginal, mode: "edit" });
  assert.equal(session.initialDraft, staleOriginal);
  const updatedSession = updateStudioSessionDraft(session, staleEdited);
  assert.equal(updatedSession.draft, staleEdited);
  assert.equal(updatedSession.initialDraft, staleOriginal, "the baseline is the draft the session opened with");
  assert.equal(isDraftDirty(updatedSession.initialDraft, updatedSession.draft), true, "the restored Studio is dirty (and diffs) after a tab switch");
  assert.equal(openStudioSession(updatedSession).initialDraft, staleOriginal, "reopening keeps the baseline");
  assert.equal(updateStudioSessionDraft(updatedSession, createBlankProgramDraft()), updatedSession, "a draft of another session is ignored");
  assert.equal(updateStudioSessionDraft(null, staleEdited), null);
  assert.equal(updateStudioSessionDraft(updatedSession, null), updatedSession);

  console.log("verify-program-studio: ok");
} catch (error) {
  console.error(error);
  process.exit(1);
}
