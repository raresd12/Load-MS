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
