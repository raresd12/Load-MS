# Exercise Library Spec — Load MS / RPE Tracker

## Purpose

Exercise Library is the technical knowledge base of the app.

It explains how each exercise is performed, what the user should feel, what mistakes to avoid, why the exercise exists in the program, and how to progress/regress it.

Exercise Library is separate from ProgramExercise.

- Exercise Library = technical information.
- ProgramExercise = sets, reps, kg, target RPE, rest time, order, notes inside a specific program.
- WorkoutSet = what the user actually did.
- Baseline = starting point for progression, not real history.

Do not put sets/reps/kg/rest/target RPE inside Exercise Library technical content.

## Required fields for every exercise

Each exercise should use this structure:

- exercise_name
- category
- main_muscles
- secondary_muscles
- equipment
- difficulty
- goal_tags
- setup
- main_cue
- how_to_do_it
- execution_tips
- common_mistakes
- what_you_should_feel
- why_its_there
- progression_regression
- safety_notes

## Display order in the app

Use this order in Library and Workouts More Info:

1. Main Cue
2. Setup
3. How To Do It
4. What You Should Feel
5. Execution Tips
6. Common Mistakes
7. Why It’s There
8. Progression / Regression
9. Safety Notes

## Mobile UX rules

On mobile, exercise details should be collapsed by default.

Default visible content should be short:
- exercise name
- main cue
- basic category/muscle/equipment tags

Detailed text should open only through:
- More Info
- View Details
- Setup / Notes / Info

Do not show long technical text directly inside Workouts cards by default.

## Writing style

Descriptions should be:
- practical;
- clear;
- gym-useful;
- short enough to read quickly;
- not overly scientific;
- not generic filler;
- written like a coach explaining what to do.

Use Romanian or English depending on the content, but keep field names consistent in English.

Main Cue should be one short sentence.

Examples:
- “Pull fast toward the upper chest.”
- “Control the descent and drive up hard.”
- “Keep ribs down and brace before each rep.”

## Field guidance

### exercise_name
Exact name used in the app.

### category
Movement/category tags, for example:
- Push
- Pull
- Legs
- Core
- Athletic
- Mobility
- Chest
- Back
- Shoulders
- Arms
- Vertical Jump
- Muscle-Up

### main_muscles
Main target muscles.

Example:
Lats, upper back, biceps

### secondary_muscles
Secondary muscles involved.

Example:
Core, grip, rear delts

### equipment
Equipment needed.

Example:
Pull-up bar, dumbbells, cable machine, bench, Smith machine

### difficulty
Beginner, Intermediate, Advanced.

### goal_tags
Why this exercise matters for the user/program.

Examples:
- V-Taper
- Muscle-Up
- Athletic Pull
- Upper Chest
- Strength
- Hypertrophy
- Vertical Jump
- Shoulder Health
- Core Stability

### setup
How to position the body before starting the exercise.

Should be simple and practical.

### main_cue
One short cue the user can remember during training.

### how_to_do_it
Step-by-step execution.

Keep it simple.

### execution_tips
Helpful tips to perform better.

Use short bullets or short sentences.

### common_mistakes
Frequent mistakes to avoid.

### what_you_should_feel
What muscles/sensations should be felt, and what pain should not be felt.

### why_its_there
Why this exercise is included in the program.

Connect it to goals like strength, hypertrophy, athleticism, basketball, V-taper, muscle-up, posture, or injury prevention.

### progression_regression
How to make the exercise easier or harder.

Include:
- easier options
- harder options
- alternative exercises if useful

### safety_notes
Only important safety warnings.
Keep this short.

## Example exercise

exercise_name: Explosive Pull-Ups

category: Pull / Back / Muscle-Up

main_muscles:
Lats, upper back, biceps

secondary_muscles:
Core, grip, rear delts

equipment:
Pull-up bar

difficulty:
Intermediate

goal_tags:
V-Taper, Muscle-Up, Athletic Pull

setup:
Prinde bara puțin mai lat decât umerii. Pornește din dead hang activ, cu omoplații trași ușor în jos, abdomenul încordat și corpul stabil.

main_cue:
Pull fast toward the upper chest.

how_to_do_it:
Pornește din dead hang activ. Trage exploziv în sus, încercând să duci pieptul cât mai aproape de bară. Coboară controlat și repetă doar cât timp poți menține viteză bună.

execution_tips:
- împinge coatele în jos și înapoi;
- ține abdomenul încordat;
- nu urmări doar să treci bărbia peste bară;
- oprește setul când viteza scade.

common_mistakes:
- balans prea mare;
- gât dus în față;
- coborâre necontrolată;
- repetări lente la un exercițiu care trebuie să fie exploziv.

what_you_should_feel:
Ar trebui să simți lats, upper back, biceps și abdomenul tensionat. Nu ar trebui să simți durere în umăr sau cot.

why_its_there:
Construiește forța explozivă de tragere pentru muscle-up și ajută la dezvoltarea spatelui lat pentru V-taper.

progression_regression:
Mai ușor: band-assisted explosive pull-up, assisted pull-up machine, explosive lat pulldown.
Mai greu: chest-to-bar pull-up, high pull-up, band muscle-up, muscle-up.

safety_notes:
Nu forța dacă simți durere în cot sau umăr. Nu face repetări explozive când ești prea obosit.

## Content workflow

Codex should not randomly invent final content without structure.

Recommended workflow:
1. Export current exercise list from the app.
2. Generate exercise descriptions in batches.
3. User reviews important exercises.
4. Import content into Exercise Library.
5. Use the same content in Library View Details and Workouts More Info.

## Import rules

Exercise Library content imports must be non-destructive.

- Preserve exercise IDs.
- Fill empty fields.
- Do not overwrite user-edited fields unless explicitly approved.
- Do not delete exercises.
- Do not move ProgramExercise prescription data into Library.
- Do not delete localStorage/history/programs.
