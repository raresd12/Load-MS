// Phase H5 UI track (decisions H5-12, H5-13): source-level wiring checks that
// cannot run without a browser. The behaviour behind them is covered by
// verify-ui-h5-set-entry.mjs and verify-ui-h5-coach-controls.mjs.
// - set entry controls follow the exercise profile (no hard-coded Reps / Kg)
// - coach profile disclosure, hold / override controls and the deload card
//   are rendered only where the right data is at hand, through App handlers
// - pages and components never write storage; App checks every writer result
//   before success UI / a re-read
// - the copy of the new surfaces makes no medical claim
// - optional days, week / cycle, records, adherence and recap lines are wired
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8").replace(/\r\n?/g, "\n");
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(js|jsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const app = read("src/App.jsx");
const setEntry = read("src/components/workout/UnifiedSetEntry.jsx");
const table = read("src/components/workout/CompletedWorkoutTable.jsx");
const overrideControls = read("src/components/workout/ExerciseOverrideControls.jsx");
const deloadCard = read("src/components/workout/DeloadCard.jsx");
const profileDisclosure = read("src/components/program/CoachProfileDisclosure.jsx");
const prescriptionEditor = read("src/components/program/ProgramPrescriptionEditor.jsx");
const programCard = read("src/components/program/ProgramCard.jsx");
const studio = read("src/components/ProgramStudio.jsx");
const programPage = read("src/pages/ProgramPage.jsx");
const workoutsPage = read("src/pages/WorkoutsPage.jsx");
const workoutLogPage = read("src/pages/WorkoutLogPage.jsx");
const dashboardPage = read("src/pages/DashboardPage.jsx");
const progressPage = read("src/pages/ProgressPage.jsx");
const historyPage = read("src/pages/HistoryPage.jsx");
const recap = read("src/components/workout/PostWorkoutCoachRecap.jsx");
const daySelect = read("src/components/nav/DaySelect.jsx");
const view = read("src/lib/coachControlsView.js");
const setEntryView = read("src/lib/setEntryView.js");

// ------------------------------------------------------------------
// 1. Set entry by measurement (H5-13)
// ------------------------------------------------------------------
{
  for (const [name, code] of [["UnifiedSetEntry", setEntry], ["CompletedWorkoutTable", table]]) {
    assert.ok(code.includes("getSetEntryProfile(exercise)") && code.includes("getSetEntryLabels(profile)"), `${name}: labels come from the profile`);
    assert.ok(code.includes("stepAmount={labels.valueStep}"), `${name}: the count stepper uses the measurement step (5 s / 10 m / 1 rep)`);
    assert.ok(code.includes("{labels.showWeightInput ? (") && code.includes("Load: BW"), `${name}: the kg field is replaced by a BW line for bodyweight exercises`);
    assert.ok(code.includes("toDraftSetPatch(values, profile)") && code.includes("validateSetEntryValues(values, exercise, profile)"), `${name}: save and validation go through setEntryView.js`);
    assert.ok(!/label="Reps"|label="Kg"/.test(code), `${name}: no hard-coded Reps / Kg label`);
  }
  assert.ok(table.includes("formatSetEntrySummary(set, index, profile)") && table.includes("formatSetEntryTotals(sets, profile)"), "saved sets are summarised per measurement (10/side, x2 for volume)");
  assert.ok(table.includes("{renderExerciseExtras?.(exercise, planExercise)}"), "the Workout Log exercise card has a slot for the coach controls");
  assert.ok(/PER_SIDE_NOTE = "[^"]*per side[^"]*"/i.test(setEntryView) && /x2 for volume/.test(setEntryView), "per side and per dumbbell notes");
}

// ------------------------------------------------------------------
// 2. Coach profile disclosure: Program editors only, through the checked writer
// ------------------------------------------------------------------
{
  assert.ok(profileDisclosure.includes("Advanced: coach profile"), "disclosure title");
  assert.ok(profileDisclosure.includes("{COACH_PROFILE_NOTE}") && view.includes('COACH_PROFILE_NOTE = "Profile changes affect future recommendations only.'), "future-only note");
  assert.ok(profileDisclosure.includes("describeCoachProfile(exercise, stored)") && view.includes('"(classified)"') && view.includes('"(override)"'), "every value shows (classified) / (override)");
  assert.ok(profileDisclosure.includes("buildCoachProfilePatch(form, exercise)") && view.includes("collectProgramExerciseProfileErrors(candidate)"), "validation through the program writer's rules");
  for (const field of ["measurement", "perSide", "progressionMode", "incrementKg", "roundToKg", "rpeMaxForLoadIncrease", "priority", "canIncreaseLoad"]) {
    assert.ok(profileDisclosure.includes(`updateField("${field}"`), `field ${field} is editable`);
  }
  assert.ok(/const written = onUpdateProgramExerciseProfile\(programId, programExerciseId, result\.patch\);\s*if \(!written\?\.ok\) \{/.test(profileDisclosure), "the save message appears only after the writer reported ok");
  assert.ok(prescriptionEditor.includes("{onUpdateProgramExerciseProfile && (") && prescriptionEditor.includes("<CoachProfileDisclosure"), "the target editor renders the disclosure when the handler is wired");
  assert.ok(prescriptionEditor.includes("storedExercise={storedById.get(exercise.programExerciseId ?? exercise.id) ?? null}"), "the raw record decides set vs inferred");
  // H5 fix round 1 (decision H5-19): the Studio disclosure edits the DRAFT
  // exercise (measurement / perSide / profileOverrides travel with the draft)
  // and writes nothing until Save program; no read-only note, no storage read.
  assert.ok(studio.includes("<CoachProfileDisclosure") && studio.includes("onPatchDraft={(patch) => onPatch(patch)}"), "the Studio disclosure patches the draft");
  assert.ok(!studio.includes("COACH_PROFILE_UNSAVED_NOTE") && !studio.includes("getProgramDayViewModels(draft.sourceProgramId)"), "no read-only note, no saved-record lookup from the Studio");
  assert.ok(/if \(draftMode\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*onPatchDraft\(result\.patch\);/.test(profileDisclosure) && profileDisclosure.includes("It is written with the program when you save it."), "draft mode patches the draft and says so");
  assert.ok(programPage.includes("onUpdateProgramExerciseProfile={onUpdateProgramExerciseProfile}") && programPage.includes("onUpdateProgramProfile={onUpdateProgramProfile}"), "ProgramPage threads both handlers");
  assert.ok(programCard.includes("Coach aggression") && programCard.includes('<option value="conservative">conservative</option>') && programCard.includes('label="Cycle length (weeks, optional)"'), "program-level fields in the metadata form");
  assert.ok(programCard.includes("buildProgramProfilePatch({ aggression, cycleWeeks })") && /const profileResult = onUpdateProgramProfile\(program\.id, profile\.patch\);\s*if \(profileResult && !profileResult\.ok\) \{/.test(programCard), "the editor closes only after the profile write reported ok");
  assert.ok(programCard.includes("formatProgramWeekLabel(programState, program)"), "Week N (and cycle) from ProgramState");
}

// ------------------------------------------------------------------
// 3. Hold / manual override and deload: App handlers, writer results checked
// ------------------------------------------------------------------
{
  assert.ok(overrideControls.includes("if (!programId || !programExerciseId || !onSetOverride || !onClearOverride) {"), "no controls without a program exercise and handlers");
  assert.ok(overrideControls.includes("formatOverrideBadge(active)") && view.includes("parts.push(`${record.remainingSessions} left`)") && view.includes('`${label} (${parts.join(", ")})`'), "badge On hold (N left) / Manual (N left)");
  assert.ok(overrideControls.includes(">\n            Clear\n          </button>") || overrideControls.includes("Clear\n"), "Clear action");
  assert.ok(overrideControls.includes("Set manually for next session") && overrideControls.includes("Hold for (sessions)"), "hold and manual forms");
  assert.ok(/const written = onSetOverride\(result\.record\);\s*if \(!written\?\.ok\) \{/.test(overrideControls), "the form closes only after the writer reported ok");
  assert.ok(workoutsPage.includes("<ExerciseOverrideControls") && workoutLogPage.includes("<ExerciseOverrideControls"), "controls on the Workouts card and the Workout Log card");
  assert.ok(workoutLogPage.includes("renderExerciseExtras={(exercise, planExercise) => ("), "the Workout Log uses the table slot");
  assert.ok(workoutsPage.includes("getOverrideSourceLine(getActiveExerciseOverride(exercise))") && view.includes('HOLD_SOURCE_LINE = "Held by you"'), "the coach summary states the source");
  assert.ok(workoutsPage.includes("getCoachDecisionLabelWithMeasurement(displayPlan.decision)") && !workoutsPage.includes("getCoachDecisionLabel("), "increase_time / increase_distance labels");

  assert.ok(deloadCard.includes('model.kind !== "suggest" && model.kind !== "active"'), "nothing is rendered unless suggested or active");
  assert.ok(deloadCard.includes("Apply for {count} sessions") && deloadCard.includes("Not now") && deloadCard.includes("End early"), "deload actions");
  assert.ok(view.includes('lighter_week: "Lighter week suggested"') && view.includes('deload: "Deload suggested"'), "titles per level");
  assert.ok(view.includes("sessionOptions: [2, 3]"), "2 or 3 sessions");
  assert.ok(dashboardPage.includes("<DeloadCard model={deloadModel}") && workoutsPage.includes("<DeloadCard model={deloadModel}"), "card on Dashboard and Workouts");
  assert.ok(progressPage.includes("formatDeloadSampleLine(deloadEvaluation)") && progressPage.includes('data-testid="deload-sample-line"'), "Progress shows the muted sample line when not eligible");

  // App: explicit now, result checked before the re-read.
  assert.ok(/evaluateDeloadNeed\(\{[\s\S]*?now: new Date\(\)\.toISOString\(\),[\s\S]*?state: activeProgramState,/.test(app), "the deload evaluation gets an explicit now");
  assert.ok(app.includes("buildDeloadCardModel(deloadEvaluation, activeProgramState?.deload ?? null)"));
  for (const name of ["handleUpdateProgramExerciseProfile", "handleUpdateProgramProfile", "handleSetExerciseOverride", "handleClearExerciseOverride", "handleApplyDeload", "handleDismissDeload", "handleEndDeload"]) {
    const start = app.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    const body = app.slice(start, app.indexOf("\n  }\n", start));
    assert.ok(/if \(result\.ok\) \{[\s\S]*?refreshProgramData\(\);/.test(body), `${name} re-reads program data only after the writer reported ok`);
    assert.ok(body.includes("return result;"), `${name} returns the writer result to the caller`);
  }
  assert.ok(app.includes("setExerciseOverrideChecked(record, { now: new Date().toISOString() })"), "override writes carry an explicit now");
  assert.ok(app.includes("onSetOverride={handleSetExerciseOverride}") && app.includes("onClearOverride={handleClearExerciseOverride}"), "handlers reach the pages");
  assert.ok(app.includes("onApplyDeload={handleApplyDeload}") && app.includes("onDismissDeload={handleDismissDeload}") && app.includes("onEndDeload={handleEndDeload}"));
  assert.ok(app.includes("deloadEvaluation={deloadEvaluation}"), "Progress gets the evaluation");
}

// ------------------------------------------------------------------
// 4. No direct storage writes outside App / lib; History untouched
// ------------------------------------------------------------------
{
  const writers = /\b(writeStorage|writeStorageBatch|writeCollection|setExerciseOverrideChecked|clearExerciseOverrideChecked|applyProgramDeload|endProgramDeload|dismissDeloadSuggestion|updateProgramStateChecked|updateProgramExerciseProfileChecked|updateProgramProfileChecked|persistWorkoutSave)\b/;
  const uiFiles = [...walk(path.join(root, "src/pages")), ...walk(path.join(root, "src/components"))];
  for (const file of uiFiles) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    const code = stripComments(readFileSync(file, "utf8"));
    assert.ok(!writers.test(code), `${relative}: no storage writer is called from a page or component`);
    assert.ok(!/\blocalStorage\b/.test(code), `${relative}: no localStorage`);
  }
  assert.ok(!/sessions\b.*\bmap\(|setSessions/.test(stripComments(overrideControls + deloadCard + profileDisclosure)), "the new controls never touch sessions (History untouched)");
  assert.ok(!/setSessions\(/.test(app.slice(app.indexOf("function handleUpdateProgramExerciseProfile("), app.indexOf("function handleSaveProgramStudioDraft("))), "the H5 handlers never rewrite sessions");
}

// ------------------------------------------------------------------
// 5. Records, adherence, recap, optional days
// ------------------------------------------------------------------
{
  assert.ok(progressPage.includes("computePersonalRecords({") && progressPage.includes("buildRecordsSections(personalRecords, { programs, activeProgramId: activeProgram?.id ?? null })"), "Records per program + occurrence");
  assert.ok(progressPage.includes('aria-label="How records are counted"') && progressPage.includes("{RECORD_ELIGIBILITY_RULE}"), "the ? quotes the eligibility rule");
  assert.ok(progressPage.includes("{entry.acrossPrograms && (") && view.includes('`Across programs: ${better.join(", ")}.`'), "the across-programs line is secondary");
  assert.ok(progressPage.includes("buildWeeklyReview(sessionSummaries, setRecords, Date.now(), { sessions, records, deloadEvaluation })"), "the weekly review gets the H5 observations and the deload evaluation (H5-23)");
  assert.ok(dashboardPage.includes("getDashboardSessionMetrics(lastSession, { days: activeProgramDays })") && app.includes("activeProgramDays={activeProgramDays}\n            deloadModel={deloadModel}"), "the Dashboard reads sets through the active program's days (H5-24)");
  assert.ok(overrideControls.includes("buildManualOverrideRecord({ programId, programExerciseId, form: manualForm, exercise })") && overrideControls.includes("label={rules.minLabel}") && overrideControls.includes("inputMode={rules.weightInputMode}"), "the manual form follows the exercise's measurement and load type");
  assert.ok(overrideControls.includes('data-testid="manual-override-base-note"') && /smallActionClassName =\s*"focus-ring min-h-11/.test(overrideControls), "base-load note under a deload; 44 px buttons");
  assert.ok(workoutsPage.includes("displayPlan.deload?.detail ??"), "the deload line also shows for a manual override (H5-18)");
  assert.ok(/const profile = onUpdateProgramProfile \? buildProgramProfilePatch\(\{ aggression, cycleWeeks \}\) : null;[\s\S]*const result = onUpdateProgramMetadata\(program\.id, metadata\);/.test(programCard), "the cycle length is validated before the metadata write");
  assert.ok(historyPage.includes("getAdherenceBadge(computeSessionAdherence({ session, exercises: editDay?.exercises ?? [] }))") && historyPage.includes('data-testid="adherence-badge"'), "History adherence badge");
  assert.ok(view.includes('`${label} ${adherence.countedSets} of ${adherence.plannedSets} sets`'), "Partial 7 of 12 sets");
  assert.ok(historyPage.includes("getHistorySetCountField(set, exercise)") && historyPage.includes("formatHistorySetCount(set)"), "History shows seconds / meters; old sessions keep reps");
  for (const line of ["recordsText", "adherenceText", "coachStatusText", "comparisonText"]) {
    assert.ok(recap.includes(`{recap.${line} && <RecapNote`), `recap shows ${line}`);
  }
  assert.ok(/buildPostWorkoutCoachRecap\(session, sessions, selectedDay, generatedPlan, \{\s*programs: allPrograms,\s*programExercises: activeProgramDays\.flatMap\(\(day\) => day\.exercises\),\s*exerciseLibrary,\s*activeProgram,\s*\}\)/.test(app), "App passes the program context to the recap");
  assert.ok(daySelect.includes("{day.isOptional ? `${day.name} (Optional)` : day.name}"), "the header day select marks optional days");
  assert.ok(workoutsPage.includes("{day.isOptional && (") && workoutsPage.includes("Optional"), "the day selector marks optional days");
}

// ------------------------------------------------------------------
// 6. No medical claims in the new copy
// ------------------------------------------------------------------
{
  const NO_MEDICAL = /injury|overtraining syndrome|diagnos/i;
  for (const [name, code] of [
    ["coachControlsView.js", view],
    ["setEntryView.js", setEntryView],
    ["ExerciseOverrideControls.jsx", overrideControls],
    ["DeloadCard.jsx", deloadCard],
    ["CoachProfileDisclosure.jsx", profileDisclosure],
    ["ProgramCard.jsx", programCard],
    ["ProgressPage.jsx", progressPage],
    ["HistoryPage.jsx", historyPage],
    ["PostWorkoutCoachRecap.jsx", recap],
  ]) {
    assert.ok(!NO_MEDICAL.test(code), `${name}: no medical claim`);
  }
}

// --- fix round 2 wiring (H5-47, H5-54) ----------------------------------------------
{
  const appCode = stripComments(app);
  assert.ok(
    /generateNextPlan\(day, latestSession, otherSessions, \{ regenerated: true \}\)/.test(appCode),
    "applyHistoryChange regenerates from the session's own snapshot (H5-47)",
  );
  assert.ok(
    !/generateNextPlan\(day, latestSession, otherSessions\)/.test(appCode),
    "no regeneration under the deload / hold active now",
  );
  const cardCode = stripComments(programCard);
  assert.ok(cardCode.includes("getProgramStateForDisplay(program.id)"), "the program card derives the week on read (H5-54)");
  assert.ok(!/getProgramState\(/.test(cardCode), "and never shows the stored week alone");
}

console.log("verify-ui-h5-wiring: ok");
