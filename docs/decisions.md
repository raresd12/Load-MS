# Product decisions after the handoff

Numbers refer to `LOAD_MS_CLAUDE_HANDOFF.md` section 19.4 where applicable.
Taken 2026-09-18 by the owner's delegation ("go with the recommended defaults; we adjust after").

| # | Decision | Rule |
|---|---|---|
| 19.4-1 | Program duplication | Fresh copy. Targets, warm-up and metadata are copied; progression records are re-initialised from targets with no recommendation note, no `sourceSessionId`, no `sourcePlanGeneratedAt`. Sessions are never copied. |
| 19.4-2 | Prescription precedence | One shared resolver used by Workouts and Workout Log: (1) stored progression earned from a saved session of this program, (2) generated plan for the day, (3) program target, (4) baseline. Each resolved value carries a `source` label. Editing a program target deletes the stored progression and the pending plan entry for that programExerciseId, so the next session starts from the new target. |
| 19.4-3 | Rest ranges in the timer | A range `[min, max]` starts the timer at `max`. The timer offers a one-tap "min" shortcut (e.g. 2:30) when a range exists. Stored ranges are never rewritten. The program editor shows and preserves the range as `min-max`. |
| new-A | Working weight | The heaviest logged set weight (top set), not the mean. Comparison with previous sessions uses top set as well. |
| new-B | History recency | Sessions older than 42 days do not count as fresh history. If the most recent qualifying session is older than 42 days the engine returns `hold` with a "long break" reason and `conservative: true`; confidence is at most `medium`. |
| new-C | Skipped exercise | An exercise with zero sets that have numeric reps is `insufficient_data` for that session and is excluded from history samples. |
| new-D | First bad session | With no usable history, a below-target/high-RPE session yields `hold`, never `reduce_load`. Reduction needs two consecutive qualifying bad sessions. Pain handling stays independent. |
| new-E | Session edit/delete | History allows editing set reps/kg/RPE, session RPE and notes, and deleting a session (with confirmation). After either, the next plan and progression for that day are regenerated from the most recent remaining session of that program+day (or cleared if none). |
| new-F | Program archive | Programs can be archived/unarchived. Active and default programs cannot be archived. Archived programs are hidden by default and keep their data. |
| new-G | Corrupt storage | A key whose JSON fails to parse is copied to `<key>.corrupt-<n>` before any fallback is used, the fallback is not written back automatically, and the UI shows a persistent warning with the key name. |

## Clarifications recorded during H1 implementation (2026-09-19)

| # | Decision | Rule |
|---|---|---|
| new-H | Session edit normalisation | The History editor rebuilds a session with the same day-driven normalisation as the save path, so an exercise that is no longer in the program day is dropped from the edited session. Delete never drops anything. |
| new-I | Next-plan keys | `nextPlans` stays keyed by day id (handoff 6.3). History edit/delete touches `nextPlans[dayId]` only when the session belongs to the active program; progressions are always regenerated per program. Re-keying by program+day is a later phase. |
| new-J | "Last time" helpers | UI helpers (`getExerciseLog`, `getLastExerciseSession`) apply the same programId + programExerciseId conflict rule as the engine. |
| new-K | Share validation | Inside a share, duplicate library ids are tolerated (first wins); duplicate day/section/exercise ids are rejected. |
| new-L | Library seeding | Seeding no longer stores library exercises shared by both default programs twice. Existing duplicates in a user's storage are left untouched (no silent rewrite). |

## Clarifications recorded during the H1 fix round (2026-09-19)

| # | Decision | Rule |
|---|---|---|
| new-M | Top set and failed attempts | Only sets with at least one completed rep are top-set candidates (new-A). A logged `130 kg x 0` never becomes the working weight or the load the next session is compared against; when no set has reps the planned weight is used. |
| new-N | Pain after a long break | Pain keeps the single context sentence next to the primary reason (new-D); the new-B "long break" explanation is then returned as a warning so it is never lost. |
| new-O | Corrupt keys and seeding | `seedDefaultProgramIfNeeded` writes nothing while any program storage key (programs, active id, meta, days, sections, library, exercises, baselines, progressions, states) is unreadable (new-G). It returns `blocked: true` with the corrupt keys; `getActiveProgramId` resolves a fallback in memory without overwriting a corrupt stored id. |
| new-P | Corrupt keys, backup and reset | A backup carries a corrupt key's raw text and lists it under `corruptKeys`; restore writes that text back verbatim so the key is flagged again. Reset (the explicit "wipe everything" action) also removes the `<key>.corrupt-<n>` copies and clears their in-memory issues. Re-reading an identical corrupt key never re-notifies the UI. |
| new-Q | History delete atomicity | When the last session of a program + day is deleted, the day's progressions are removed in the same `persistWorkoutSave` batch as the sessions (`deleteProgressionsForDayId`); nothing is committed on failure. |
| new-R | Target set cap | One shared cap `MAX_TARGET_SETS = 30` applies to the target editor, `updateProgramExerciseTargetChecked` and the strict share validator, so every share the app exports imports again. Share ids are compared as strings by validator and importer alike. |
| new-S | Draft across midnight | The Workout Log resumes an in-progress draft of the same program + day from an earlier date while it has logged data and was updated within 36 hours; only an empty draft rolls over to the new date. The draft is also rebuilt when a plan's set slots change (target edit) even if `generatedAt` did not. |
| new-T | Refilled plan entries | A base-plan entry inside a "generated" day plan (refilled after a target edit removed it) resolves as `target`, not `plan`; a `manual` plan and entries flagged `manuallyAdjusted` still count as plan values. |

## Clarifications recorded during the H1 fix round 2 (2026-09-23)

| # | Decision | Rule |
|---|---|---|
| new-U | Corrupt keys and writers | new-G also protects the write path: `writeStorage` / `writeStorageBatch` refuse (code `corrupt`, nothing written, no partial batch) any key whose stored text is not valid JSON, unless the caller passes `overwriteCorrupt` for an explicit user action. Every program-storage writer, `persistWorkoutSave` and the `useLocalStorageState` write therefore fail instead of writing a value computed from the empty fallback over the user's data, and the read-corrupt warning stays truthful ("nothing was overwritten"). The warning offers "Discard unreadable data" (`discardCorruptStorageValue`): the raw text must already sit in a `<key>.corrupt-<n>` copy, then the key is removed, the issue cleared and the defaults re-seeded. A knowing overwrite clears the read-corrupt issue. |
| new-V | Share library references | `validateProgramShareStrict` rejects a program exercise whose `exerciseId` resolves to no Library entry in the share, the local Library or the built-in config, instead of importing a placeholder "Exercise" with no technique content. App-exported shares always carry their referenced entries, so they still round-trip; H2's match/remap editor builds on this rule. |
| new-R (extended) | Target edit validation | `updateProgramExerciseTargetChecked` applies the strict share rules to every field a patch touches (RPE 1-10 in .5 steps, positive reps with min <= max or a label, weight empty / >= 0 / "BW", sets 1-30) and returns `{ ok:false, errors }`; an unusable rest input still keeps the current value (19.4-2). |
| new-W | Seeding | `seedDefaultProgramIfNeeded` computes every seed collection in memory and writes the changed keys in one `writeStorageBatch`: a failed fresh install leaves nothing behind and seeds fully on the next run; a default program that exists but lost days / sections / exercises / baselines / state gets the missing records back (add-only by id, progressions of an existing program untouched); a healthy mount writes nothing. |
| new-E (completed) | Program state after history changes | After a session delete or edit, `ProgramState` (`lastCompletedDayId`, `nextRecommendedDayId`, `lastWorkoutDate`) is derived from the most recent remaining session of that program (`deriveProgramStatePatchFromSessions`) in the same `persistWorkoutSave` batch, or reset to "nothing completed, first day next" when none remains. Legacy sessions without a `programId` never drive it. |
| new-X | Checked program writers | `setActiveProgramChecked` / `updateProgramMetadataChecked` return `{ ok, error, code }`; the legacy wrappers return `null` on a failed write. The Program card only switches the day selection / closes the details editor after the write succeeded and shows the error otherwise. |
