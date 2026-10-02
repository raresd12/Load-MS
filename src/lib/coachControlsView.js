// Coach controls view helpers (Phase H5, UI track; decision H5-12).
//
// Pure glue between the H5 engine modules (overrides.js, deload.js,
// personalRecords.js, adherence.js, the profile of progression.js) and the
// surfaces that show them: the hold / manual override forms and badges, the
// deload card model, the coach profile form of the Program editors, the
// Records section of Progress and the History adherence badge. Nothing here
// reads or writes storage and nothing reads the clock: every writer stays in
// its module and App.jsx passes `now`. Fixture: scripts/verify-ui-h5-coach-controls.mjs.
import { getLocalDateKey } from "./date.js";
import { getMeasurementProfile, MEASUREMENTS } from "./measurement.js";
import {
  describeOverride,
  isOverrideActive,
  MAX_OVERRIDE_SESSIONS,
  MIN_OVERRIDE_SESSIONS,
  validateExerciseOverride,
} from "./overrides.js";
import { getRecordRollupKey } from "./personalRecords.js";
import { getCoachDecisionLabel } from "./prescriptionView.js";
import { buildExerciseProfile, PROFILE_PRIORITIES, PROGRESSION_MODES, isDeloadActive } from "./progression.js";
import { collectProgramExerciseProfileErrors, PROFILE_OVERRIDE_RANGES } from "./programStorage.js";
import { formatRecordLabel } from "./sessionAnalytics.js";
import { getDraftSetCount, isBlank } from "./sessionNormalize.js";

// H5-2 decisions the H4 label map does not know; everything else falls
// through to prescriptionView.getCoachDecisionLabel.
const MEASUREMENT_DECISION_LABELS = Object.freeze({
  increase_time: "Extend time",
  increase_distance: "Extend distance",
});

export function getCoachDecisionLabelWithMeasurement(decision) {
  return MEASUREMENT_DECISION_LABELS[decision] ?? getCoachDecisionLabel(decision);
}

function text(value) {
  return isBlank(value) ? "" : String(value);
}

function toNumber(value) {
  if (isBlank(value)) {
    return null;
  }

  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Hold and manual override (H5-6)
// ---------------------------------------------------------------------------

export const OVERRIDE_SESSION_OPTIONS = Object.freeze(
  Array.from({ length: MAX_OVERRIDE_SESSIONS - MIN_OVERRIDE_SESSIONS + 1 }, (_, index) => MIN_OVERRIDE_SESSIONS + index),
);
export const DEFAULT_OVERRIDE_SESSIONS = 2;
export const HOLD_SOURCE_LINE = "Held by you";
export const MANUAL_SOURCE_LINE = "Set manually by you";

/** The active override of a day view model exercise, or null. */
export function getActiveExerciseOverride(exercise, now = null) {
  const record = exercise?.override ?? null;
  return isOverrideActive(record, now) ? record : null;
}

/** "On hold (2 left)" | "On hold (2 left, until 2026-10-14)" | "Manual (1 left)" | "On hold" | "Manual" | "". */
export function formatOverrideBadge(record) {
  if (!record || !["hold", "manual"].includes(record.mode)) {
    return "";
  }

  const label = record.mode === "hold" ? "On hold" : "Manual";
  const parts = [];

  if (Number.isFinite(record.remainingSessions)) {
    parts.push(`${record.remainingSessions} left`);
  }

  // Decision H5-31: a record with an until date says so in the badge.
  if (record.untilDate) {
    parts.push(`until ${String(record.untilDate).slice(0, 10)}`);
  }

  return parts.length ? `${label} (${parts.join(", ")})` : label;
}

/** The source line the coach summary states for an active override. */
export function getOverrideSourceLine(record) {
  if (!record || !["hold", "manual"].includes(record.mode)) {
    return "";
  }

  const base = record.mode === "hold" ? HOLD_SOURCE_LINE : MANUAL_SOURCE_LINE;
  return `${base}: ${describeOverride(record).toLowerCase()}.`;
}

/**
 * Form values for "Set manually for next session", prefilled with the
 * prescription the athlete currently sees so only the changed number is
 * typed. Under a deload the form starts from the coach's BASE load and set
 * count (decision H5-18): a manual override is never scaled by the deload,
 * so prefilling the scaled value would silently make the override lighter.
 */
export function createManualOverrideForm(prescription = {}) {
  const deload = prescription?.deload && typeof prescription.deload === "object" ? prescription.deload : null;

  return {
    sessions: String(DEFAULT_OVERRIDE_SESSIONS),
    weight: text(deload?.baseWeight ?? prescription.recommendedWeight),
    sets: text(deload?.baseSets ?? prescription.sets),
    repsMin: text(prescription.repsMin),
    repsMax: text(prescription.repsMax),
    rpe: text(prescription.targetRPE),
  };
}

const MANUAL_COUNT_NOUNS = Object.freeze({ reps: "Reps", time: "Seconds", distance: "Meters" });

/**
 * Labels and rules of the manual form for one exercise (H5 fix round 1):
 * the count fields are named by the measurement ("Seconds min" for a timed
 * exercise), BW is accepted only for bodyweight / optional-load exercises,
 * and the weight keyboard follows that.
 */
export function getManualOverrideFieldRules(exercise = null) {
  const profile = getMeasurementProfile(exercise ?? {});
  const noun = MANUAL_COUNT_NOUNS[profile.measurement] ?? "Reps";
  const allowsBodyweight = !exercise || profile.loadType === "bodyweight" || profile.loadType === "optionalExternal";

  return {
    measurement: profile.measurement,
    countNoun: noun.toLowerCase(),
    minLabel: `${noun} min`,
    maxLabel: `${noun} max`,
    allowsBodyweight,
    weightInputMode: allowsBodyweight ? "text" : "decimal",
    weightPlaceholder: allowsBodyweight ? "kg or BW" : "kg",
    // Reps and seconds are whole numbers; meters may carry a decimal.
    wholeCount: profile.measurement !== "distance",
  };
}

/** "Lighter week: the coach shows 54 kg, this form starts from the base 60 kg." | "" */
export function describeManualOverrideBase(prescription = {}) {
  const deload = prescription?.deload && typeof prescription.deload === "object" ? prescription.deload : null;

  if (!deload || deload.baseWeight === null || deload.baseWeight === undefined || deload.baseWeight === prescription.recommendedWeight) {
    return "";
  }

  const label = deload.level === "deload" ? "Deload" : "Lighter week";
  const shown = typeof prescription.recommendedWeight === "number" ? `${prescription.recommendedWeight} kg` : text(prescription.recommendedWeight);
  const base = typeof deload.baseWeight === "number" ? `${deload.baseWeight} kg` : text(deload.baseWeight);
  return `${label}: the coach shows ${shown}, this form starts from the base ${base}. A manual weight is used as typed, not scaled.`;
}

export function createHoldForm() {
  return { sessions: String(DEFAULT_OVERRIDE_SESSIONS), untilDate: "" };
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The optional "until" date of a hold (decision H5-31): blank = no date, the
 * session count alone ends the hold. Otherwise a real calendar date as
 * YYYY-MM-DD, not before `today` (the caller's local date key; the helper
 * reads no clock). -> { ok, value: "YYYY-MM-DD" | null, error }
 */
export function parseHoldUntilDate(value, today = null) {
  const textValue = text(value).trim();

  if (!textValue) {
    return { ok: true, value: null, error: null };
  }

  const match = DATE_KEY_PATTERN.exec(textValue);
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;

  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== textValue) {
    return { ok: false, value: null, error: "Until date must be a valid date (YYYY-MM-DD) or blank." };
  }

  if (typeof today === "string" && DATE_KEY_PATTERN.test(today) && textValue < today) {
    return { ok: false, value: null, error: "Until date cannot be in the past." };
  }

  return { ok: true, value: textValue, error: null };
}

function parseSessions(value) {
  const parsed = toNumber(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * The hold record for the checked writer, or { ok: false, errors }. The hold
 * ends after `sessions` logged sessions or, with an optional `untilDate`
 * (YYYY-MM-DD, decision H5-31), after that day, whichever comes first.
 */
export function buildHoldRecord({ programId, programExerciseId, sessions, untilDate = "", today = null }) {
  const until = parseHoldUntilDate(untilDate, today);
  const record = {
    programId: programId ?? null,
    programExerciseId: programExerciseId ?? null,
    mode: "hold",
    prescription: null,
    remainingSessions: parseSessions(sessions),
    untilDate: until.value,
    note: "",
  };
  const errors = [];

  if (record.remainingSessions === null) {
    errors.push(`Sessions must be a whole number from ${MIN_OVERRIDE_SESSIONS} to ${MAX_OVERRIDE_SESSIONS}.`);
  }

  if (!until.ok) {
    errors.push(until.error);
  }

  if (errors.length) {
    return { ok: false, errors, record: null };
  }

  const validation = validateExerciseOverride(record);
  return validation.valid ? { ok: true, record, errors: [] } : { ok: false, record: null, errors: validation.errors };
}

/**
 * The manual override record from the form: only the fields that differ from
 * blank are set (a blank field lets the next source fill it). Weight accepts
 * a kg number, or BW when the exercise allows it (`exercise` optional, H5
 * fix round 1); the count range needs both bounds or none, whole numbers for
 * reps / seconds, min not above max.
 */
export function buildManualOverrideRecord({ programId, programExerciseId, form, exercise = null }) {
  const errors = [];
  const prescription = {};
  const rules = getManualOverrideFieldRules(exercise);
  const weightText = text(form?.weight).trim();

  if (weightText) {
    if (weightText.toLowerCase() === "bw") {
      if (rules.allowsBodyweight) {
        prescription.targetWeight = "BW";
      } else {
        errors.push("This exercise takes a kg load; BW is not accepted here.");
      }
    } else {
      const weight = toNumber(weightText);

      if (weight === null || weight < 0) {
        errors.push("Weight must be blank, BW, or a kg number.");
      } else {
        prescription.targetWeight = weight;
      }
    }
  }

  const setsText = text(form?.sets).trim();

  if (setsText) {
    const sets = toNumber(setsText);

    if (!Number.isInteger(sets) || sets < 1) {
      errors.push("Sets must be a whole number of 1 or more.");
    } else {
      prescription.targetSets = sets;
    }
  }

  const minText = text(form?.repsMin).trim();
  const maxText = text(form?.repsMax).trim();

  if (minText || maxText) {
    const min = minText ? toNumber(minText) : null;
    const max = maxText ? toNumber(maxText) : null;
    const noun = rules.countNoun;

    if (!minText || !maxText) {
      errors.push(`Enter both ${noun} min and ${noun} max, or leave both blank.`);
    } else if (min === null || min <= 0 || max === null || max <= 0) {
      errors.push(`${rules.minLabel.split(" ")[0]} must be positive numbers.`);
    } else if (rules.wholeCount && (!Number.isInteger(min) || !Number.isInteger(max))) {
      errors.push(`${rules.minLabel.split(" ")[0]} must be whole numbers.`);
    } else if (min > max) {
      errors.push(`${rules.minLabel} cannot exceed ${rules.maxLabel.toLowerCase()}.`);
    } else {
      prescription.targetReps = { min, max, label: null };
    }
  }

  const rpeText = text(form?.rpe).trim();

  if (rpeText) {
    const rpe = toNumber(rpeText);

    if (rpe === null || rpe < 1 || rpe > 10 || !Number.isInteger(rpe * 2)) {
      errors.push("RPE must be 1-10 in .5 steps.");
    } else {
      prescription.targetRPE = rpe;
    }
  }

  const remainingSessions = parseSessions(form?.sessions);

  if (remainingSessions === null) {
    errors.push(`Sessions must be a whole number from ${MIN_OVERRIDE_SESSIONS} to ${MAX_OVERRIDE_SESSIONS}.`);
  }

  if (errors.length) {
    return { ok: false, record: null, errors };
  }

  const record = {
    programId: programId ?? null,
    programExerciseId: programExerciseId ?? null,
    mode: "manual",
    prescription,
    remainingSessions,
    untilDate: null,
    note: "",
  };
  const validation = validateExerciseOverride(record);

  return validation.valid ? { ok: true, record, errors: [] } : { ok: false, record: null, errors: validation.errors };
}

// ---------------------------------------------------------------------------
// Deload card (H5-7)
// ---------------------------------------------------------------------------

export const DELOAD_LEVEL_TITLES = Object.freeze({
  lighter_week: "Lighter week suggested",
  deload: "Deload suggested",
});

export function formatDeloadSampleLine(evaluation) {
  if (!evaluation) {
    return "";
  }

  const have = evaluation.sampleSize ?? { sessions: 0, checkIns: 0 };
  const need = evaluation.requiredSampleSize ?? { sessions: 0, checkIns: 0 };
  return `Deload check needs ${need.sessions} sessions and ${need.checkIns} readiness check-ins in ${evaluation.windowDays} days; you have ${have.sessions} ${have.sessions === 1 ? "session" : "sessions"} and ${have.checkIns} ${have.checkIns === 1 ? "check-in" : "check-ins"}.`;
}

/** "2 lighter sessions left" | "1 deload session left" | "". */
export function formatActiveDeloadLine(deload) {
  if (!isDeloadActive(deload)) {
    return "";
  }

  const remaining = deload.remainingSessions;
  const noun = deload.level === "deload" ? "deload" : "lighter";

  if (!Number.isFinite(remaining)) {
    return deload.level === "deload" ? "Deload in progress" : "Lighter week in progress";
  }

  return `${remaining} ${noun} ${remaining === 1 ? "session" : "sessions"} left`;
}

/**
 * buildDeloadCardModel(evaluation, deload) ->
 *   { kind: "active" | "suggest" | "ineligible" | "quiet", title, line, signals, level, sessionOptions }
 * `signals` lists every observation with its sample count; met ones first.
 */
export function buildDeloadCardModel(evaluation, deload = null) {
  if (isDeloadActive(deload)) {
    return {
      kind: "active",
      title: deload.level === "deload" ? "Deload in progress" : "Lighter week in progress",
      line: formatActiveDeloadLine(deload),
      signals: [],
      level: deload.level,
      sessionOptions: [],
    };
  }

  if (!evaluation) {
    return { kind: "quiet", title: "", line: "", signals: [], level: null, sessionOptions: [] };
  }

  const signals = [...(evaluation.signals ?? [])].sort((left, right) => Number(right.met) - Number(left.met));

  if (evaluation.suggest) {
    return {
      kind: "suggest",
      title: DELOAD_LEVEL_TITLES[evaluation.level] ?? "Lighter week suggested",
      line: `${signals.filter((signal) => signal.met).length} of ${signals.length} fatigue observations are present over the last ${evaluation.windowDays} days. These are observations from your logs, nothing more.`,
      signals,
      level: evaluation.level,
      sessionOptions: [2, 3],
    };
  }

  if (!evaluation.eligible) {
    return { kind: "ineligible", title: "", line: formatDeloadSampleLine(evaluation), signals, level: null, sessionOptions: [] };
  }

  return {
    kind: "quiet",
    title: "",
    line: (evaluation.reasons ?? []).join(" ") || "No deload suggestion right now.",
    signals,
    level: null,
    sessionOptions: [],
  };
}

// ---------------------------------------------------------------------------
// Coach profile (H5-3 / H5-1) in the Program editors
// ---------------------------------------------------------------------------

export const COACH_PROFILE_FIELDS = Object.freeze([
  "measurement",
  "perSide",
  "progressionMode",
  "incrementKg",
  "roundToKg",
  "rpeMaxForLoadIncrease",
  "priority",
  "canIncreaseLoad",
]);
export const COACH_PROFILE_NOTE = "Profile changes affect future recommendations only. Logged sessions stay as they are. Changing the measurement changes the unit: it needs a target in that unit, resets the earned progression and ends a hold or manual override of the exercise.";
export const MEASUREMENT_OPTIONS = MEASUREMENTS;
export const PROGRESSION_MODE_OPTIONS = PROGRESSION_MODES;
export const PRIORITY_OPTIONS = PROFILE_PRIORITIES;

function triState(value) {
  return value === true ? "yes" : value === false ? "no" : "";
}

/**
 * Editor strings for the stored profile of a day view model exercise. A day
 * view model always carries the resolved measurement / perSide, so the raw
 * ProgramExercise record (`stored`, from getProgramExercises(dayId)) says
 * whether they were set or inferred from the label; without it the view
 * model's values are taken as set.
 */
export function createCoachProfileForm(exercise, stored = null) {
  const overrides = exercise?.profileOverrides && typeof exercise.profileOverrides === "object" ? exercise.profileOverrides : {};
  const measurement = getMeasurementProfile(stored ?? exercise ?? {});

  return {
    measurement: measurement.inferred.measurement ? "" : measurement.measurement,
    perSide: measurement.inferred.perSide ? "" : triState(measurement.perSide),
    progressionMode: text(overrides.progressionMode),
    incrementKg: text(overrides.incrementKg),
    roundToKg: text(overrides.roundToKg),
    rpeMaxForLoadIncrease: text(overrides.rpeMaxForLoadIncrease),
    priority: text(overrides.priority),
    canIncreaseLoad: triState(overrides.canIncreaseLoad),
  };
}

function parseRangeNumber(value, field, errors) {
  const clean = text(value).trim();

  if (!clean) {
    return undefined;
  }

  const parsed = toNumber(clean);
  const range = PROFILE_OVERRIDE_RANGES[field];

  if (parsed === null || (range && (parsed < range.min || parsed > range.max))) {
    errors.push(`${COACH_PROFILE_LABELS[field]} must be a number${range ? ` from ${range.min} to ${range.max}` : ""}.`);
    return undefined;
  }

  return parsed;
}

export const COACH_PROFILE_LABELS = Object.freeze({
  measurement: "Measurement",
  perSide: "Per side",
  progressionMode: "Progression mode",
  incrementKg: "Increment kg",
  roundToKg: "Rounding kg",
  rpeMaxForLoadIncrease: "Max RPE for load increase",
  priority: "Priority",
  canIncreaseLoad: "Allow load increase",
});

/**
 * The patch for updateProgramExerciseProfileChecked from the form:
 * { measurement, perSide, profileOverrides } with null for "classified"
 * (the stored field is removed). Validated with the same rules as the writer.
 */
export function buildCoachProfilePatch(form, exercise = {}) {
  const errors = [];
  const overrides = {};

  if (text(form?.progressionMode).trim()) {
    overrides.progressionMode = form.progressionMode.trim();
  }

  const incrementKg = parseRangeNumber(form?.incrementKg, "incrementKg", errors);
  const roundToKg = parseRangeNumber(form?.roundToKg, "roundToKg", errors);
  const rpeMax = parseRangeNumber(form?.rpeMaxForLoadIncrease, "rpeMaxForLoadIncrease", errors);

  if (incrementKg !== undefined) overrides.incrementKg = incrementKg;
  if (roundToKg !== undefined) overrides.roundToKg = roundToKg;
  if (rpeMax !== undefined) overrides.rpeMaxForLoadIncrease = rpeMax;

  if (text(form?.priority).trim()) {
    overrides.priority = form.priority.trim();
  }

  if (form?.canIncreaseLoad === "yes" || form?.canIncreaseLoad === "no") {
    overrides.canIncreaseLoad = form.canIncreaseLoad === "yes";
  }

  const patch = {
    measurement: text(form?.measurement).trim() || null,
    perSide: form?.perSide === "yes" ? true : form?.perSide === "no" ? false : null,
    profileOverrides: Object.keys(overrides).length ? overrides : null,
  };

  if (errors.length) {
    return { ok: false, patch: null, errors };
  }

  const candidate = { ...exercise };
  Object.entries(patch).forEach(([field, value]) => {
    if (value === null) {
      delete candidate[field];
    } else {
      candidate[field] = value;
    }
  });
  const profileErrors = collectProgramExerciseProfileErrors(candidate).map(
    (message) => message.charAt(0).toUpperCase() + message.slice(1),
  );

  return profileErrors.length ? { ok: false, patch: null, errors: profileErrors } : { ok: true, patch, errors: [] };
}

function formatSourceTag(source) {
  return source === "override" ? "(override)" : source === "config" ? "(program config)" : "(classified)";
}

/**
 * The effective value of every profile field with its source tag, so the
 * disclosure reads "2.5 kg (classified)" or "5 kg (override)".
 */
export function describeCoachProfile(exercise = {}, stored = null) {
  const profile = buildExerciseProfile(exercise);
  const measurement = getMeasurementProfile(stored ?? exercise);
  const sources = profile.fieldSources ?? {};

  return {
    measurement: `${measurement.measurement} ${measurement.inferred.measurement ? "(inferred)" : "(set)"}`,
    perSide: `${measurement.perSide ? "yes" : "no"} ${measurement.inferred.perSide ? "(inferred)" : "(set)"}`,
    progressionMode: `${profile.progressionMode ?? "-"} ${formatSourceTag(sources.progressionMode)}`,
    incrementKg: `${profile.loadIncrementKg ?? "-"}${profile.loadIncrementKg ? " kg" : ""} ${formatSourceTag(sources.incrementKg)}`,
    roundToKg: `${profile.roundToKg ?? "-"}${profile.roundToKg ? " kg" : ""} ${formatSourceTag(sources.roundToKg)}`,
    rpeMaxForLoadIncrease: `${profile.rpePolicy?.maxForLoadIncrease ?? "-"} ${formatSourceTag(sources.rpeMaxForLoadIncrease)}`,
    priority: `${profile.role ?? "-"} ${formatSourceTag(sources.priority)}`,
    canIncreaseLoad: `${profile.progressionCaps?.canIncreaseLoad === false ? "no" : "yes"} ${formatSourceTag(sources.canIncreaseLoad)}`,
  };
}

// ---------------------------------------------------------------------------
// Program-level profile (aggression, cycle length)
// ---------------------------------------------------------------------------

export function createProgramProfileForm(program) {
  return {
    aggression: program?.programProfile?.aggression === "conservative" ? "conservative" : "standard",
    cycleWeeks: Number.isInteger(program?.cycleWeeks) ? String(program.cycleWeeks) : "",
  };
}

/** { ok, patch: { programProfile, cycleWeeks }, errors } for updateProgramProfileChecked. */
export function buildProgramProfilePatch(form) {
  const errors = [];
  const aggression = form?.aggression === "conservative" ? "conservative" : "standard";
  const cycleText = text(form?.cycleWeeks).trim();
  let cycleWeeks = null;

  if (cycleText) {
    const parsed = toNumber(cycleText);

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 52) {
      errors.push("Cycle length must be a whole number of weeks from 1 to 52, or empty.");
    } else {
      cycleWeeks = parsed;
    }
  }

  if (errors.length) {
    return { ok: false, patch: null, errors };
  }

  return { ok: true, patch: { programProfile: { aggression, unit: "kg" }, cycleWeeks }, errors: [] };
}

/** "Week 2" | "Week 2 of 4, cycle 1" from ProgramState and the program. */
export function formatProgramWeekLabel(programState, program = null) {
  const week = Number.isInteger(programState?.currentWeek) ? programState.currentWeek : 1;
  const cycleWeeks = Number.isInteger(program?.cycleWeeks) ? program.cycleWeeks : null;

  if (!cycleWeeks) {
    return `Week ${week}`;
  }

  const cycle = Number.isInteger(programState?.currentCycle) ? programState.currentCycle : 1;
  return `Week ${week} of ${cycleWeeks}, cycle ${cycle}`;
}

// ---------------------------------------------------------------------------
// Records section (H5-8) and adherence badge (H5-9)
// ---------------------------------------------------------------------------

export const RECORD_ELIGIBILITY_RULE =
  "e1RM counts a set with a numeric load, 1-10 reps and RPE 6 or higher (or no RPE). Top weight and reps at a weight count completed reps sets; session volume is tonnage with per dumbbell and per side doubled; time and distance records are the longest completed set at the top load. Bodyweight, timed and distance sets never make an e1RM. Records belong to this program's exercise; the 'across programs' line adds the same Library exercise logged elsewhere and is never merged.";

const RECORD_LINE_ORDER = Object.freeze([
  ["best_e1rm", "Best e1RM"],
  ["best_weight", "Top weight"],
  ["best_reps_at_weight", "Reps at weight"],
  ["best_session_volume", "Session volume"],
  ["best_time", "Best time"],
  ["best_distance", "Best distance"],
]);

const RECORD_TYPE_PREFIX = /^(e1RM|top weight|session volume|time|distance)\s+/i;

/** The record's value without the type word the line label already carries. */
function formatRecordValue(record) {
  return formatRecordLabel(record).replace(RECORD_TYPE_PREFIX, "");
}

// The LOCAL calendar date, as History and Progress show a session: a record
// set at 01:30 local time is not dated the day before (decision H5-56).
function formatRecordDate(value) {
  const date = new Date(value ?? "");
  return Number.isNaN(date.getTime()) ? "" : getLocalDateKey(date);
}

function bestRepsAtWeightEntries(map) {
  return Object.values(map ?? {})
    .filter((record) => record && Number.isFinite(record.value))
    .sort((left, right) => {
      const leftWeight = typeof left.weight === "number" ? left.weight : -1;
      const rightWeight = typeof right.weight === "number" ? right.weight : -1;
      return rightWeight - leftWeight;
    })
    .slice(0, 2);
}

function recordLines(identity) {
  const lines = [];

  RECORD_LINE_ORDER.forEach(([type, label]) => {
    const record = identity?.records?.[type];

    if (!record) {
      return;
    }

    if (type === "best_reps_at_weight") {
      bestRepsAtWeightEntries(record).forEach((entry) => {
        lines.push({ type, label, value: formatRecordValue(entry), date: formatRecordDate(entry.date) });
      });
      return;
    }

    if (Number.isFinite(record.value)) {
      lines.push({ type, label, value: formatRecordValue(record), date: formatRecordDate(record.date) });
    }
  });

  return lines;
}

/**
 * buildRecordsSections(personalRecords, { programs, activeProgramId }) ->
 *   [{ programId, programName, isActive, entries: [{ key, name, lines, acrossPrograms }] }]
 * Primary identities grouped by program (active first); `acrossPrograms`
 * is the secondary line for the same Library exercise when its roll-up
 * holds a better value than the primary, else "".
 */
export function buildRecordsSections(personalRecords, { programs = [], activeProgramId = null } = {}) {
  const primary = Object.values(personalRecords?.primary ?? {});
  const rollups = personalRecords?.acrossPrograms ?? {};
  const programName = new Map((programs ?? []).map((program) => [program.id, program.nickname || program.name]));
  const byProgram = new Map();

  primary.forEach((identity) => {
    const lines = recordLines(identity);

    if (!lines.length) {
      return;
    }

    const rollup = rollups[
      getRecordRollupKey(identity.exerciseId, identity.measurement ?? "reps", identity.weightMode ?? "kg", {
        perSide: Boolean(identity.perSide),
        loadType: identity.loadType ?? "external",
      })
    ];
    const better = [];

    if (rollup) {
      RECORD_LINE_ORDER.forEach(([type, label]) => {
        if (type === "best_reps_at_weight") {
          return;
        }

        const own = identity.records?.[type];
        const theirs = rollup.records?.[type];

        if (theirs && Number.isFinite(theirs.value) && (!own || theirs.value > own.value)) {
          better.push(`${label.toLowerCase()} ${formatRecordValue(theirs)}`);
        }
      });
    }

    const group = byProgram.get(identity.programId) ?? {
      programId: identity.programId,
      programName: programName.get(identity.programId) ?? "Other program",
      isActive: identity.programId === activeProgramId,
      entries: [],
    };
    group.entries.push({
      key: identity.identityKey,
      name: identity.name,
      measurement: identity.measurement ?? "reps",
      lines,
      ineligibleCount: Array.isArray(identity.ineligibleSets) ? identity.ineligibleSets.length : 0,
      acrossPrograms: better.length ? `Across programs: ${better.join(", ")}.` : "",
    });
    byProgram.set(identity.programId, group);
  });

  return [...byProgram.values()].sort((left, right) => Number(right.isActive) - Number(left.isActive) || left.programName.localeCompare(right.programName));
}

// ---------------------------------------------------------------------------
// History set rows (H5-13)
// ---------------------------------------------------------------------------

const HISTORY_COUNT_LABELS = Object.freeze({ reps: "Reps", seconds: "Seconds", meters: "Meters" });
const HISTORY_COUNT_STEPS = Object.freeze({ reps: 1, seconds: 5, meters: 10 });

/**
 * The count field the History editor edits for a draft set: seconds / meters
 * for a timed / distance exercise, reps for a legacy reps-only set of one.
 */
export function getHistorySetCountField(set, exercise) {
  const count = getDraftSetCount(set, exercise);

  return {
    field: count.field,
    label: HISTORY_COUNT_LABELS[count.field] ?? "Reps",
    step: HISTORY_COUNT_STEPS[count.field] ?? 1,
    noun: count.noun,
  };
}

/** "30 s/side" | "400 m" | "10/side" | "8" | "-" for a set record of sessionAnalytics. */
export function formatHistorySetCount(set) {
  if (Number.isFinite(set?.seconds)) {
    return `${set.seconds} s${set.perSide ? "/side" : ""}`;
  }

  if (Number.isFinite(set?.meters)) {
    return `${set.meters} m`;
  }

  return Number.isFinite(set?.reps) ? `${set.reps}${set.perSide ? "/side" : ""}` : "-";
}

/** { label, tone } for the History card, or null for an unplanned session. */
export function getAdherenceBadge(adherence) {
  if (!adherence || adherence.status === "unplanned") {
    return null;
  }

  if (adherence.status === "complete") {
    return { label: "Complete", tone: "complete" };
  }

  const label = adherence.status === "partial" ? "Partial" : "Minimal";
  return { label: `${label} ${adherence.countedSets} of ${adherence.plannedSets} sets`, tone: adherence.status };
}
